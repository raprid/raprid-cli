import { readFileSync } from "node:fs";
import { parse, singleLine } from "../lib/args.ts";
import { actor } from "../lib/actor.ts";
import { CliError, UsageError } from "../lib/errors.ts";
import { Frontmatter } from "../lib/frontmatter.ts";
import { localDate } from "../lib/fsutil.ts";
import { answerBegin, answerEnd, assertRevision, parseIfMatch, readAnswer } from "../lib/guard.ts";
import { assertNameFree, assertStatusDirs, createItem, moveItem } from "../lib/items.ts";
import { Job, validateItemName } from "../lib/jobs.ts";
import { listCommand, showCommand } from "../lib/listing.ts";
import { fencedLines, findSection, splitLines } from "../lib/markdown.ts";
import { findItem, ownIssues, printJson, recordJson, schemaVersion } from "../lib/query.ts";
import { Collector } from "../lib/records.ts";
import { projectRoot } from "../lib/root.ts";
import { blockedByLines, renderTemplate } from "../lib/template.ts";
import { displayUsage } from "../lib/view.ts";

export const usage = `使い方:
  raprid qa add <案件名> <QA名> <確認先> <質問内容> [blockedBy] --requested-by <actor> --created-by <actor>
  raprid qa list [<案件名>] [--status <状態,...> | --all] [--search <文字列>] [--long] [--json]
  raprid qa show <案件名> <QA IDまたは名前> [--json]
  raprid qa resolve <案件名> <QA IDまたは名前> <回答> --answered-by <actor>
  raprid qa resolve <案件名> <QA IDまたは名前> --answer-file <パス|-> --answered-by <actor> [--if-match <revision>] [--json]
  raprid qa move <案件名> <QA IDまたは名前> unresolved
  raprid qa move <案件名> <QA IDまたは名前> resolved <回答> --answered-by <actor>

確認先: customer | internal | undecided
actor: human/<識別子> | agent/<識別子>

list は既定で unresolved を表示する (--all で全件、--status resolved で状態を指定)。
--search は ID・名前・質問の部分一致 (大文字小文字を区別しない)。未知の状態と「要確認」は常に表示する。
${displayUsage}
--answer-file は複数行の Markdown (UTF-8、1 MiB まで。- は標準入力) を回答にする。
--if-match は show --json の revision。更新前に一致を確かめ、違えば REVISION_CONFLICT で何も変えない。

例:
  raprid qa add PROJ-123 correction-policy customer "補正方法はこの方針でよいか" --requested-by agent/codex --created-by agent/codex
  raprid qa resolve PROJ-123 Q-001 "確認環境から実行する" --answered-by human/saiki
  raprid qa move PROJ-123 Q-001 unresolved`;

function add(argv: string[]): void {
  const { positionals, values } = parse(argv, { "requested-by": { type: "string" }, "created-by": { type: "string" } }, usage);
  if (positionals.length < 4 || positionals.length > 5) throw new UsageError(usage);
  const [jobName, rawName, askTo, rawQuestion, rawBlockedBy] = positionals;
  const name = validateItemName("qa", rawName);
  if (!["customer", "internal", "undecided"].includes(askTo)) throw new UsageError(`確認先はcustomer、internal、undecidedのいずれかです: ${askTo}`);
  const question = singleLine(rawQuestion, "質問内容", true)!;
  const blockedBy = singleLine(rawBlockedBy, "blockedBy", false);
  const requestedBy = actor(values["requested-by"] ?? process.env.RAPRID_ACTOR, "--requested-by");
  const createdBy = actor(values["created-by"] ?? process.env.RAPRID_ACTOR, "--created-by");
  const job = Job.existing(projectRoot(), jobName);
  assertStatusDirs(job, "qa");
  job.lock(() => {
    assertNameFree(job, "qa", name);
    const id = job.nextId("qa");
    const content = renderTemplate("qa/index.md", {
      id,
      date: localDate(),
      job: job.name,
      askTo,
      question,
      requestedBy,
      createdBy,
      blockedBy: blockedByLines(blockedBy),
    });
    const item = createItem(job, "qa", name, content, "unresolved");
    console.log(`作成: ${id} / ${job.display(item.index)}`);
    console.log(`索引: jobs/${job.name}/qa/status/unresolved/${name} -> ${job.linkTarget("qa", name)}`);
    console.log("補足や回答は必要に応じて index.md へ追記し、資料は同じディレクトリに置いてください。");
  });
}

function list(argv: string[]): void {
  listCommand("qa", argv, usage);
}

function show(argv: string[]): void {
  showCommand("qa", argv, usage);
}

// 回答欄の先頭に回答を入れる。既存のメモは残し、"未回答" の仮置きだけを置き換える。
// 複数行の回答 (--answer-file) は区切り行で囲み、見出しを含んでも次の読み取りで切れないようにする
function insertAnswer(text: string, answer: string, source: string, marked: boolean): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = splitLines(text);
  const section = findSection(lines, 2, "回答内容");
  if (!section) throw new CliError(`回答内容の見出しがありません: ${source}`);
  const fenced = fencedLines(lines);
  let next = section.start + 1;
  while (next < section.end && lines[next].trim() === "") next++;
  const rest = lines.slice(next);
  if (next < section.end && !fenced[next] && ["未回答", "未回答。"].includes(lines[next].trim())) {
    rest.shift();
    while (rest.length > 0 && rest[0].trim() === "") rest.shift();
  }
  const head = lines.slice(0, section.start + 1);
  const body = marked ? [answerBegin, ...answer.split("\n"), answerEnd] : [answer];
  const separator = rest.length > 0 && rest[0].trim() !== "" ? [""] : [];
  return [...head, "", ...body, ...separator, ...(rest.length > 0 ? rest : [""])].join(eol);
}

interface TransitionOptions {
  ifMatch?: string;
  json?: boolean;
  marked?: boolean;
}

// このQAを待っている pending のタスク (別案件からの qa/<案件名>/<ID> も含む)
function waitingTasks(root: string, job: Job, id: string, name: string): { job: string; id: string; name: string }[] {
  const local = new Set([`qa/${id}`, `qa/${name}`]);
  const remote = new Set([`qa/${job.name}/${id}`, `qa/${job.name}/${name}`]);
  const found: { job: string; id: string; name: string }[] = [];
  for (const other of new Collector(root).jobs()) {
    let tasks;
    try {
      tasks = other.items("task");
    } catch {
      continue;
    }
    for (const task of tasks) {
      if (task.tryField("status") !== "pending") continue;
      try {
        const refs = task.frontmatter().getList("blockedBy") ?? [];
        if (refs.some((value) => remote.has(value) || (other.name === job.name && local.has(value)))) found.push({ job: other.name, id: task.idOrEmpty(), name: task.name });
      } catch {
        // 読めない依存は list の要確認で報告される
      }
    }
  }
  return found;
}

function transition(jobName: string, selector: string, status: string, answer: string | undefined, answeredBy: string | undefined, options: TransitionOptions = {}): void {
  const root = projectRoot();
  const job = Job.existing(root, jobName);
  const done = job.lock(() => {
    const item = job.find("qa", selector);
    assertStatusDirs(job, "qa");
    // revision の確認と書き換えは、ロック内で読み取った同じ内容に対して行う
    const bytes = readFileSync(item.index);
    assertRevision(options.ifMatch, bytes, job.display(item.index));
    const fm = Frontmatter.parse(bytes.toString("utf8"), job.display(item.index));
    const old = fm.get("status") ?? "";
    if (!["unresolved", "resolved"].includes(old)) throw new CliError(`実体のstatusが不正です: ${old || "未設定"}`);
    for (const key of ["updatedAt", "resolvedAt"]) {
      if (!fm.has(key)) throw new CliError(`frontmatterに${key}がありません: ${job.display(item.index)}`);
    }
    const today = localDate();
    fm.set("status", status);
    fm.set("updatedAt", today);
    fm.set("resolvedAt", status === "resolved" ? today : "");
    fm.set("answeredBy", status === "resolved" ? actor(answeredBy ?? process.env.RAPRID_ACTOR, "--answered-by") : "");
    if (status === "resolved" && fm.has("blockedBy")) fm.set("blockedBy", []);
    let updated = fm.toString();
    if (!findSection(splitLines(updated), 2, "回答内容")) throw new CliError(`回答内容の見出しがありません: ${job.display(item.index)}`);
    if (answer !== undefined) updated = insertAnswer(updated, answer, job.display(item.index), options.marked ?? false);
    const link = moveItem(item, status, updated);
    return { item, link, old, id: fm.get("id") ?? "" };
  });
  const waiting = status === "resolved" ? waitingTasks(root, job, done.id, done.item.name) : [];
  if (options.json) {
    const collector = new Collector(root);
    const data = collector.job(job);
    const entry = findItem(data, "qa", done.item.name);
    printJson({ schemaVersion, ok: true, item: recordJson(entry.record), issues: ownIssues(data, entry) });
    return;
  }
  console.log(`変更: ${done.id} / ${done.item.name} / ${done.old} -> ${status}`);
  console.log(`実体: ${job.display(done.item.index)}`);
  console.log(`索引: ${job.display(done.link)} -> ${job.linkTarget("qa", done.item.name)}`);
  for (const task of waiting) {
    const where = task.job === job.name ? "" : ` (案件: ${task.job})`;
    console.log(`再開待ち: ${task.id} / ${task.name}${where} (raprid task move ${task.job} ${task.id} progress)`);
  }
}

function move(argv: string[]): void {
  const { positionals, values } = parse(argv, { "answered-by": { type: "string" } }, usage);
  if (positionals.length < 3 || positionals.length > 4) throw new UsageError(usage);
  const [jobName, selector, status, rawAnswer] = positionals;
  if (status === "unresolved") {
    if (positionals.length !== 3) throw new UsageError("unresolvedへの変更では回答を指定しません");
    if (values["answered-by"]) throw new UsageError("unresolvedへの変更では--answered-byを指定しません");
    transition(jobName, selector, status, undefined, undefined);
  } else if (status === "resolved") {
    const answer = singleLine(rawAnswer, "回答", false);
    if (!answer) throw new UsageError("resolvedへの変更には空でない1行の回答が必要です");
    transition(jobName, selector, status, answer, values["answered-by"]);
  } else {
    throw new UsageError(`状態はunresolvedまたはresolvedです: ${status}`);
  }
}

function resolve(argv: string[]): void {
  const { positionals, values } = parse(
    argv,
    { "answered-by": { type: "string" }, "answer-file": { type: "string" }, "if-match": { type: "string" }, json: { type: "boolean" } },
    usage,
  );
  const file = values["answer-file"];
  if (file !== undefined && positionals.length === 3) throw new UsageError("回答の位置引数と --answer-file は同時に指定できません");
  if (positionals.length !== (file === undefined ? 3 : 2)) throw new UsageError(usage);
  const answeredBy = actor(values["answered-by"] ?? process.env.RAPRID_ACTOR, "--answered-by");
  const ifMatch = parseIfMatch(values["if-match"]);
  // 回答は変更前に検証する (空・上限超過・UTF-8 でないものは何も変えずに拒否)
  const answer = file === undefined ? singleLine(positionals[2], "回答", true)! : readAnswer(file);
  transition(positionals[0], positionals[1], "resolved", answer, answeredBy, { ifMatch, json: values.json, marked: file !== undefined });
}

export function run(argv: string[]): void {
  const [command, ...rest] = argv;
  const commands: Record<string, (args: string[]) => void> = { add, list, move, resolve, show };
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    console.log(usage);
    if (command === undefined) process.exitCode = 2;
    return;
  }
  if (!commands[command]) throw new UsageError(`不明なコマンド: qa ${command}\n${usage}`);
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(usage);
    return;
  }
  commands[command](rest);
}
