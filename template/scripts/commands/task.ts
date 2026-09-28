import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, singleLine } from "../lib/args.ts";
import { actor } from "../lib/actor.ts";
import { CliError, UsageError } from "../lib/errors.ts";
import { Frontmatter, yamlScalar } from "../lib/frontmatter.ts";
import { localDate, writeFileAtomic } from "../lib/fsutil.ts";
import { assertRevision, parseIfMatch } from "../lib/guard.ts";
import { assertNameFree, assertStatusDirs, createItem, moveItem } from "../lib/items.ts";
import { Job, validateItemName, withJobLocks } from "../lib/jobs.ts";
import { listCommand, showCommand } from "../lib/listing.ts";
import { appendToSection, headings, splitLines } from "../lib/markdown.ts";
import { findItem, ownIssues, printJson, recordJson, schemaVersion } from "../lib/query.ts";
import { Collector } from "../lib/records.ts";
import { projectRoot } from "../lib/root.ts";
import { blockedByLines, renderTemplate } from "../lib/template.ts";
import { displayUsage } from "../lib/view.ts";

export const usage = `使い方:
  raprid task add <案件名> <タスク名> <状態> <タイトル> [blockedBy] --requested-by <actor> --created-by <actor>
  raprid task list [<案件名>] [--status <状態,...> | --all] [--search <文字列>] [--long] [--json]
  raprid task show <案件名> <タスクIDまたは名前> [--json]
  raprid task ask <案件名> <タスクIDまたは名前> <QA名> <確認先> <質問内容> --requested-by <actor> --created-by <actor>
  raprid task move <案件名> <タスクIDまたは名前> <状態> [blockedBy] [--if-match <revision>] [--json]
  raprid task note <案件名> <タスクIDまたは名前> <詳細名> [<見出し>]

状態: add は todo | progress | pending、move は todo | pending | progress | done
pending には blockedBy (qa/Q-001、qa/<案件名>/Q-001、task/T-001、other: <待っているもの>) が必要
pending から離れるときは、待っているQA (別案件を含む) がすべて resolved であることを確かめる (task/other は確かめない)
--if-match は show --json の revision。更新前に一致を確かめ、違えば REVISION_CONFLICT で何も変えない
actor: human/<識別子> | agent/<識別子>

list は既定で done 以外を表示する (--all で全件、--status todo,pending で状態を指定)。
--search は ID・名前・タイトルの部分一致 (大文字小文字を区別しない)。未知の状態と「要確認」は常に表示する。
${displayUsage}

例:
  raprid task add PROJ-123 check-prod-data todo "本番データを確認する" --requested-by human/saiki --created-by agent/codex
  raprid task ask PROJ-123 T-001 deploy-policy customer "本番反映の手順はこれでよいか" --requested-by agent/codex --created-by agent/codex
  raprid task list PROJ-123 --status pending --long
  raprid task show PROJ-123 T-001
  raprid task move PROJ-123 T-001 pending qa/Q-001
  raprid task note PROJ-123 T-001 investigation "原因の調査"`;

function blockedByFor(status: string, blockedBy: string | undefined, verb: string): string | undefined {
  const value = singleLine(blockedBy, "blockedBy", false);
  if (status === "pending" && !value) throw new UsageError("pendingにはblockedByが必要です");
  if (status !== "pending" && value) throw new UsageError(`blockedByを指定できるのはpendingへの${verb}時だけです`);
  return value;
}

function add(argv: string[]): void {
  const { positionals, values } = parse(argv, { "requested-by": { type: "string" }, "created-by": { type: "string" } }, usage);
  if (positionals.length < 4 || positionals.length > 5) throw new UsageError(usage);
  const [jobName, rawName, status, rawTitle, rawBlockedBy] = positionals;
  const name = validateItemName("task", rawName);
  if (!["todo", "progress", "pending"].includes(status)) throw new UsageError(`初期状態はtodo、progress、pendingのいずれかです: ${status}`);
  const title = singleLine(rawTitle, "タイトル", true)!;
  const blockedBy = blockedByFor(status, rawBlockedBy, "作成");
  const requestedBy = actor(values["requested-by"] ?? process.env.RAPRID_ACTOR, "--requested-by");
  const createdBy = actor(values["created-by"] ?? process.env.RAPRID_ACTOR, "--created-by");
  const job = Job.existing(projectRoot(), jobName);
  assertStatusDirs(job, "task");
  job.lock(() => {
    assertNameFree(job, "task", name);
    const id = job.nextId("task");
    const content = renderTemplate("task/index.md", {
      id,
      status,
      date: localDate(),
      title,
      requestedBy,
      createdBy,
      blockedBy: blockedByLines(blockedBy),
    });
    const item = createItem(job, "task", name, content, status);
    console.log(`作成: ${id} / ${job.display(item.index)}`);
    console.log(`索引: jobs/${job.name}/status/${status}/${name} -> ${job.linkTarget("task", name)}`);
    console.log("内容・完了条件・testは必要に応じて index.md を編集し、作業の記録は raprid task note で追加してください。");
  });
}

function list(argv: string[]): void {
  listCommand("task", argv, usage);
}

function show(argv: string[]): void {
  showCommand("task", argv, usage);
}

function ask(argv: string[]): void {
  const { positionals, values } = parse(argv, { "requested-by": { type: "string" }, "created-by": { type: "string" } }, usage);
  if (positionals.length !== 5) throw new UsageError(usage);
  const [jobName, selector, rawName, askTo, rawQuestion] = positionals;
  const name = validateItemName("qa", rawName);
  if (!["customer", "internal", "undecided"].includes(askTo)) throw new UsageError(`確認先はcustomer、internal、undecidedのいずれかです: ${askTo}`);
  const question = singleLine(rawQuestion, "質問内容", true)!;
  const requestedBy = actor(values["requested-by"] ?? process.env.RAPRID_ACTOR, "--requested-by");
  const createdBy = actor(values["created-by"] ?? process.env.RAPRID_ACTOR, "--created-by");
  const job = Job.existing(projectRoot(), jobName);
  job.lock(() => {
    const task = job.find("task", selector);
    assertStatusDirs(job, "task");
    assertStatusDirs(job, "qa");
    assertNameFree(job, "qa", name);
    const taskFm = task.frontmatter();
    const old = taskFm.get("status") ?? "";
    if (!["todo", "progress"].includes(old)) throw new CliError(`質問を作れるタスクの状態はtodoまたはprogressです: ${old || "未設定"}`);
    for (const key of ["updatedAt", "completedAt", "blockedBy"]) {
      if (!taskFm.has(key)) throw new CliError(`frontmatterに${key}がありません: ${job.display(task.index)}`);
    }
    const id = job.nextId("qa");
    const qaContent = renderTemplate("qa/index.md", {
      id,
      date: localDate(),
      job: job.name,
      askTo,
      question,
      requestedBy,
      createdBy,
      blockedBy: blockedByLines(undefined),
    });
    const qa = createItem(job, "qa", name, qaContent, "unresolved");
    try {
      taskFm.set("status", "pending");
      taskFm.set("updatedAt", localDate());
      taskFm.set("completedAt", "");
      taskFm.set("blockedBy", [`qa/${id}`]);
      moveItem(task, "pending", taskFm.toString());
    } catch (error) {
      rmSync(join(job.statusDir("qa", "unresolved"), name), { force: true });
      rmSync(qa.dir, { recursive: true, force: true });
      throw error;
    }
    console.log(`作成: ${id} / ${job.display(qa.index)}`);
    console.log(`変更: ${taskFm.get("id")} / ${task.name} / ${old} -> pending (待ち: qa/${id})`);
  });
}

// blockedBy のうち QA を指すものの案件名 (qa/Q-001 は同じ案件、qa/<案件名>/Q-001 は別案件)
function qaJobs(jobName: string, blockedBy: string[]): string[] {
  return blockedBy
    .map((reference) => reference.split("/"))
    .filter((parts) => parts[0] === "qa" && (parts.length === 2 || parts.length === 3))
    .map((parts) => (parts.length === 3 ? parts[1] : jobName));
}

// blockedBy を読む。読めない書式のときは、QA を指していそうなら止め、そうでなければ空として扱う (従来どおり置き換える)
function blockersOf(fm: Frontmatter, source: string): string[] {
  try {
    return fm.getList("blockedBy") ?? [];
  } catch (error) {
    if (/qa\//.test(fm.get("blockedBy") ?? "")) {
      throw new CliError(`blockedBy を読み取れないため、待っているQAを確認できません: ${source}`, 1, "BLOCKED_BY_UNREADABLE");
    }
    return [];
  }
}

// pending から離れるとき、待っている QA がすべて解決済みか確かめる (ロック内で読み直す)
function assertQaResolved(root: string, job: Job, blockedBy: string[]): void {
  const collector = new Collector(root);
  const problems: string[] = [];
  for (const reference of blockedBy) {
    const result = collector.resolveQa(job, reference);
    if (result.state === "not-qa" || result.state === "resolved") continue;
    const reason = { unresolved: "未解決", "invalid-status": "状態が不正", ambiguous: "特定できない (ID が重複)", "not-found": "見つからない" }[result.state];
    problems.push(`${reference} (${reason})`);
  }
  if (problems.length > 0) {
    throw new CliError(`待っているQAが解決していないため pending を解除できません: ${problems.join(", ")}\nQAを解決してから再度実行してください`, 1, "BLOCKED_BY_QA");
  }
}

function move(argv: string[]): void {
  const { positionals, values } = parse(argv, { "if-match": { type: "string" }, json: { type: "boolean" } }, usage);
  if (positionals.length < 3 || positionals.length > 4) throw new UsageError(usage);
  const [jobName, selector, status, rawBlockedBy] = positionals;
  if (!["todo", "pending", "progress", "done"].includes(status)) throw new UsageError(`状態はtodo、pending、progress、doneのいずれかです: ${status}`);
  const blockedBy = blockedByFor(status, rawBlockedBy, "変更");
  const ifMatch = parseIfMatch(values["if-match"]);
  const root = projectRoot();
  const job = Job.existing(root, jobName);
  // 待っている QA の案件も名前順にロックする。ロック内で依存が変わっていたら取り直す
  let done: { item: ReturnType<Job["find"]>; link: string; old: string; id: string } | undefined;
  for (let attempt = 0; attempt < 3 && !done; attempt++) {
    let planned: string[] = [];
    try {
      const current = job.find("task", selector);
      const fm = current.frontmatter();
      if (fm.get("status") === "pending" && status !== "pending") planned = qaJobs(job.name, blockersOf(fm, job.display(current.index)));
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      // 見つからない・読めない場合はロック内で同じ確認をして報告する
    }
    const locked = new Set([job.name, ...planned.filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))]);
    done = withJobLocks(root, [...locked], () => {
      const item = job.find("task", selector);
      assertStatusDirs(job, "task");
      const bytes = readFileSync(item.index);
      assertRevision(ifMatch, bytes, job.display(item.index));
      const fm = Frontmatter.parse(bytes.toString("utf8"), job.display(item.index));
      const old = fm.get("status") ?? "";
      if (!["todo", "pending", "progress", "done"].includes(old)) throw new CliError(`実体のstatusが不正です: ${old || "未設定"}`);
      for (const key of ["updatedAt", "completedAt", "blockedBy"]) {
        if (!fm.has(key)) throw new CliError(`frontmatterに${key}がありません: ${job.display(item.index)}`);
      }
      if (old === "pending" && status !== "pending") {
        const blockers = blockersOf(fm, job.display(item.index));
        if (!qaJobs(job.name, blockers).every((name) => locked.has(name))) return undefined; // 依存が変わった
        assertQaResolved(root, job, blockers);
      }
      const today = localDate();
      fm.set("status", status);
      fm.set("updatedAt", today);
      fm.set("completedAt", status === "done" ? today : "");
      fm.set("blockedBy", blockedBy ? [yamlScalar(blockedBy)] : []);
      const link = moveItem(item, status, fm.toString());
      return { item, link, old, id: fm.get("id") ?? "" };
    });
  }
  if (!done) throw new CliError("待っているQAの参照が変わり続けたため中止しました。再度実行してください", 1, "DEPENDENCY_CHANGED");
  if (values.json) {
    const collector = new Collector(root);
    const data = collector.job(job);
    const entry = findItem(data, "task", done.item.name);
    printJson({ schemaVersion, ok: true, item: recordJson(entry.record), issues: ownIssues(data, entry) });
    return;
  }
  console.log(`変更: ${done.id} / ${done.item.name} / ${done.old} -> ${status}`);
  console.log(`実体: ${job.display(done.item.index)}`);
  console.log(`索引: ${job.display(done.link)} -> ${job.linkTarget("task", done.item.name)}`);
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
  const commands: Record<string, (args: string[]) => void> = { add, ask, list, move, note, show };
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
