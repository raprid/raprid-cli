import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, singleLine } from "../lib/args.ts";
import { CliError, UsageError } from "../lib/errors.ts";
import { Frontmatter, yamlScalar } from "../lib/frontmatter.ts";
import { localDate, writeFileAtomic } from "../lib/fsutil.ts";
import { assertNameFree, assertStatusDirs, createItem, listItems, moveItem, sectionSummary } from "../lib/items.ts";
import { Job, validateItemName } from "../lib/jobs.ts";
import { appendToSection, headings, splitLines } from "../lib/markdown.ts";
import { projectRoot } from "../lib/root.ts";
import { blockedByLines, renderTemplate } from "../lib/template.ts";

export const usage = `使い方:
  raprid task add <案件名> <タスク名> <状態> <タイトル> [blockedBy]
  raprid task list [<案件名>]
  raprid task move <案件名> <タスクIDまたは名前> <状態> [blockedBy]
  raprid task note <案件名> <タスクIDまたは名前> <詳細名> [<見出し>]

状態: add は todo | progress | pending、move は todo | pending | progress | done
pending には blockedBy (qa/Q-001、task/T-001、other: <待っているもの>) が必要

例:
  raprid task add PROJ-123 check-prod-data todo "本番データを確認する"
  raprid task move PROJ-123 T-001 pending qa/Q-001
  raprid task note PROJ-123 T-001 investigation "原因の調査"`;

function blockedByFor(status: string, blockedBy: string | undefined, verb: string): string | undefined {
  const value = singleLine(blockedBy, "blockedBy", false);
  if (status === "pending" && !value) throw new UsageError("pendingにはblockedByが必要です");
  if (status !== "pending" && value) throw new UsageError(`blockedByを指定できるのはpendingへの${verb}時だけです`);
  return value;
}

function add(argv: string[]): void {
  const { positionals } = parse(argv, {}, usage);
  if (positionals.length < 4 || positionals.length > 5) throw new UsageError(usage);
  const [jobName, rawName, status, rawTitle, rawBlockedBy] = positionals;
  const name = validateItemName("task", rawName);
  if (!["todo", "progress", "pending"].includes(status)) throw new UsageError(`初期状態はtodo、progress、pendingのいずれかです: ${status}`);
  const title = singleLine(rawTitle, "タイトル", true)!;
  const blockedBy = blockedByFor(status, rawBlockedBy, "作成");
  const job = Job.existing(projectRoot(), jobName);
  assertStatusDirs(job, "task");
  job.lock(() => {
    assertNameFree(job, "task", name);
    const id = job.nextId("task");
    const content = renderTemplate("task/index.md", { id, status, date: localDate(), title, blockedBy: blockedByLines(blockedBy) });
    const item = createItem(job, "task", name, content, status);
    console.log(`作成: ${id} / ${job.display(item.index)}`);
    console.log(`索引: jobs/${job.name}/status/${status}/${name} -> ${job.linkTarget("task", name)}`);
    console.log("内容・完了条件・testは必要に応じて index.md を編集し、作業の記録は raprid task note で追加してください。");
  });
}

function list(argv: string[]): void {
  const { positionals } = parse(argv, {}, usage);
  if (positionals.length > 1) throw new UsageError(usage);
  const root = projectRoot();
  const jobs = positionals.length === 1 ? [Job.existing(root, positionals[0])] : Job.all(root);
  const blocks = jobs.map((job) =>
    listItems(job, "task", (item) => {
      const title = sectionSummary(item, "タイトル") ?? item.name;
      const blockedBy = item.tryField("status") === "pending" ? safeList(item.frontmatter.bind(item)) : [];
      return blockedBy.length > 0 ? `${title} (待ち: ${blockedBy.join(", ")})` : title;
    }).join("\n"),
  );
  console.log(blocks.join("\n\n"));
}

function safeList(read: () => Frontmatter): string[] {
  try {
    return read().getList("blockedBy") ?? [];
  } catch {
    return [];
  }
}

function move(argv: string[]): void {
  const { positionals } = parse(argv, {}, usage);
  if (positionals.length < 3 || positionals.length > 4) throw new UsageError(usage);
  const [jobName, selector, status, rawBlockedBy] = positionals;
  if (!["todo", "pending", "progress", "done"].includes(status)) throw new UsageError(`状態はtodo、pending、progress、doneのいずれかです: ${status}`);
  const blockedBy = blockedByFor(status, rawBlockedBy, "変更");
  const job = Job.existing(projectRoot(), jobName);
  job.lock(() => {
    const item = job.find("task", selector);
    assertStatusDirs(job, "task");
    const fm = item.frontmatter();
    const old = fm.get("status") ?? "";
    if (!["todo", "pending", "progress", "done"].includes(old)) throw new CliError(`実体のstatusが不正です: ${old || "未設定"}`);
    for (const key of ["updatedAt", "completedAt", "blockedBy"]) {
      if (!fm.has(key)) throw new CliError(`frontmatterに${key}がありません: ${job.display(item.index)}`);
    }
    const today = localDate();
    fm.set("status", status);
    fm.set("updatedAt", today);
    fm.set("completedAt", status === "done" ? today : "");
    fm.set("blockedBy", blockedBy ? [yamlScalar(blockedBy)] : []);
    const link = moveItem(item, status, fm.toString());
    console.log(`変更: ${fm.get("id")} / ${item.name} / ${old} -> ${status}`);
    console.log(`実体: ${job.display(item.index)}`);
    console.log(`索引: ${job.display(link)} -> ${job.linkTarget("task", item.name)}`);
  });
}

function note(argv: string[]): void {
  const { positionals } = parse(argv, {}, usage);
  if (positionals.length < 3 || positionals.length > 4) throw new UsageError(usage);
  const [jobName, selector, rawDetail, rawTitle] = positionals;
  const detail = validateItemName("task", rawDetail);
  const title = singleLine(rawTitle, "見出し", false) ?? detail;
  const job = Job.existing(projectRoot(), jobName);
  job.lock(() => {
    const item = job.find("task", selector);
    const files = readdirSync(item.dir);
    const numbered = files.map((file) => /^(\d{2,})-(.+)\.md$/.exec(file)).filter((match) => match !== null);
    const duplicate = numbered.find((match) => match[2] === detail);
    if (duplicate) throw new CliError(`同名の詳細があります: ${job.display(join(item.dir, duplicate[0]))}`);
    const next = Math.max(0, ...numbered.map((match) => Number(match[1]))) + 1;
    const file = `${String(next).padStart(2, "0")}-${detail}.md`;
    const path = join(item.dir, file);

    const text = item.read();
    const fm = Frontmatter.parse(text, job.display(item.index));
    if (fm.has("updatedAt")) fm.set("updatedAt", localDate());
    const label = title.replace(/[\\[\]]/g, "\\$&");
    const linked = appendToSection(fm.toString(), 2, "詳細", [`* [${label}](${file})`]);
    // 詳細の節が複数あると追加先が曖昧になる
    if (headings(splitLines(text)).filter((heading) => heading.level === 2 && heading.text === "詳細").length > 1) {
      throw new CliError(`「## 詳細」が複数あります: ${job.display(item.index)}`);
    }
    writeFileSync(path, renderTemplate("task/_.md", { title }), { flag: "wx", mode: 0o644 });
    try {
      writeFileAtomic(item.index, linked);
    } catch (error) {
      rmSync(path, { force: true });
      throw error;
    }
    console.log(`作成: ${job.display(path)}`);
    console.log(`リンク: ${job.display(item.index)} の「## 詳細」に追加しました`);
  });
}

export function run(argv: string[]): void {
  const [command, ...rest] = argv;
  const commands: Record<string, (args: string[]) => void> = { add, list, move, note };
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    console.log(usage);
    if (command === undefined) process.exitCode = 2;
    return;
  }
  if (!commands[command]) throw new UsageError(`不明なコマンド: task ${command}\n${usage}`);
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(usage);
    return;
  }
  commands[command](rest);
}
