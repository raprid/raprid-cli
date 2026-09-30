import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, singleLine } from "../lib/args.ts";
import { actor } from "../lib/actor.ts";
import { CliError, UsageError } from "../lib/errors.ts";
import { Frontmatter, FrontmatterError, yamlScalar } from "../lib/frontmatter.ts";
import { localDate, writeFileAtomic } from "../lib/fsutil.ts";
import { assertRevision, parseIfMatch } from "../lib/guard.ts";
import { assertNameFree, assertStatusDirs, createItem, moveItem } from "../lib/items.ts";
import { Job, validateItemName, withJobWriteLocks } from "../lib/jobs.ts";
import { listCommand, showCommand } from "../lib/listing.ts";
import { appendToSection, headings, splitLines } from "../lib/markdown.ts";
import { findItem, ownIssues, printJson, recordJson, schemaVersion } from "../lib/query.ts";
import { assertQaResolved, qaJobs } from "../lib/blockers.ts";
import { Collector } from "../lib/records.ts";
import { projectRoot } from "../lib/root.ts";
import { blockedByLines, renderTemplate } from "../lib/template.ts";
import { displayUsage } from "../lib/view.ts";
import { assertLegacyAddAllowed } from "./migrate-workflow.ts";
import { addV3, askV3, assertWritableWorkflow, assign, block, claim, complete, decide, noteV3, reopen, resume, workflowKind, workflowUsage } from "./task-workflow.ts";
import { addV4, assignV4, blockV4, claimV4, completeV4, decideOnV4, peekTask, reopenV4, resumeV4, revise, sendBack, workflowUsageV4 } from "./task-workflow-v4.ts";

export const usage = `使い方:
  raprid task add <案件名> <タスク名> <状態> <タイトル> [blockedBy | --blocked-by <値> ...] --requested-by <actor> --created-by <actor>
  raprid task list [<案件名>] [--status <状態,...> | --closed | --all] [--type <種別>] [--phase <工程>] [--assignee <actor>] [--search <文字列>] [--long] [--json [--schema-version 2|3]]
  raprid task show <案件名> <タスクIDまたは名前> [--json [--schema-version 2|3]]
  raprid task ask <案件名> <タスクIDまたは名前> <QA名> <確認先> <質問内容> --requested-by <actor> --created-by <actor>
  raprid task move <案件名> <タスクIDまたは名前> <状態> [blockedBy | --blocked-by <値> ...] [--if-match <revision>] [--json]
  raprid task note <案件名> <タスクIDまたは名前> <詳細名> [<見出し>]

状態: add は todo | progress | pending、move は todo | pending | progress | done
pending には blockedBy (qa/Q-001、qa/<案件名>/Q-001、task/T-001、other: <待っているもの>) が必要
待っている相手が複数なら --blocked-by を繰り返す (値の中のカンマは区切りとみなさない)
pending から離れるときは、待っているQA (別案件を含む) がすべて resolved であることを確かめる (task/other は確かめない)
--if-match は show --json の revision。更新前に一致を確かめ、違えば REVISION_CONFLICT で何も変えない
actor: human/<識別子> | agent/<識別子>

list は既定で done・closed 以外を表示する (--all で全件、--closed で done・closed だけ、--status todo,pending で状態を指定)。
工程型タスクの --status は今の工程の状態 (ready・progress・pending)。--type・--phase・--assignee は工程型タスクだけを絞り込む。
--search は ID・名前・タイトルの部分一致 (大文字小文字を区別しない)。未知の状態と「要確認」は常に表示する。
--json の既定は schemaVersion 1 (旧形式だけ)。工程型タスクがある案件では --schema-version 2 を付ける (付けないと SCHEMA_V2_REQUIRED)
workflowVersion 4 のタスクがある案件では --schema-version 3 を付ける (1・2 は SCHEMA_V3_REQUIRED)。--status approval は v4 の人の確認待ち
${displayUsage}

${workflowUsage}

${workflowUsageV4}

v3 と v4 で同じ名前の操作 (claim・assign・complete・block・resume・reopen) は、タスクの workflowVersion で振り分ける。
decide は v3 だけ、send-back・revise は v4 だけ (版の違うタスクには WF_NOT_V3 / WF_NOT_V4 で移行か別の操作を案内する)

例:
  raprid task add PROJ-123 check-prod-data todo "本番データを確認する" --requested-by human/saiki --created-by agent/codex
  raprid task ask PROJ-123 T-001 deploy-policy customer "本番反映の手順はこれでよいか" --requested-by agent/codex --created-by agent/codex
  raprid task list PROJ-123 --status pending --long
  raprid task show PROJ-123 T-001
  raprid task move PROJ-123 T-001 pending qa/Q-001
  raprid task note PROJ-123 T-001 investigation "原因の調査"`;

// 待っている相手の一覧。位置引数は従来どおり 1 件、複数は --blocked-by を繰り返す。
// 値の中のカンマは区切りとみなさない (other: の説明にカンマを書けるように)
function blockedByFor(status: string, positional: string | undefined, repeated: string[] | undefined, verb: string): string[] {
  if (positional !== undefined && repeated !== undefined && repeated.length > 0) {
    throw new UsageError("blockedBy の位置引数と --blocked-by は同時に指定できません (複数なら --blocked-by を繰り返す)");
  }
  const values = repeated !== undefined && repeated.length > 0 ? repeated.map((value) => singleLine(value, "--blocked-by", true)!) : [singleLine(positional, "blockedBy", false)].filter((value): value is string => value !== undefined);
  if (status === "pending" && values.length === 0) throw new UsageError("pendingにはblockedByが必要です");
  if (status !== "pending" && values.length > 0) throw new UsageError(`blockedByを指定できるのはpendingへの${verb}時だけです`);
  return [...new Set(values)];
}

function add(argv: string[]): void {
  const { positionals, values } = parse(
    argv,
    {
      "requested-by": { type: "string" },
      "created-by": { type: "string" },
      "blocked-by": { type: "string", multiple: true },
      type: { type: "string" },
      "workflow-version": { type: "string" },
      "plan-approver": { type: "string" },
      "review-approver": { type: "string" },
      json: { type: "boolean" },
    },
    usage,
  );
  // --type があれば工程型 (既定は workflowVersion 3、--workflow-version 4 で v4)。無ければ移行までの互換として旧形式で作る
  const version = values["workflow-version"];
  if (version !== undefined && values.type === undefined) throw new UsageError("--workflow-version は --type と一緒に指定します");
  if (version !== undefined && version !== "3" && version !== "4") throw new UsageError(`--workflow-version は 3 か 4 です: ${version}`);
  if (version !== "4" && (values["plan-approver"] !== undefined || values["review-approver"] !== undefined)) throw new UsageError("--plan-approver・--review-approver は --workflow-version 4 だけで使えます");
  if (values.type !== undefined && version === "4") return addV4(positionals, values);
  if (values.type !== undefined) return addV3(positionals, values);
  if (values.json) throw new UsageError("--json は --type を付けた task add (工程型) だけで使えます");
  if (positionals.length < 4 || positionals.length > 5) throw new UsageError(usage);
  const [jobName, rawName, status, rawTitle, rawBlockedBy] = positionals;
  const name = validateItemName("task", rawName);
  if (!["todo", "progress", "pending"].includes(status)) throw new UsageError(`初期状態はtodo、progress、pendingのいずれかです: ${status}`);
  const title = singleLine(rawTitle, "タイトル", true)!;
  const blockedBy = blockedByFor(status, rawBlockedBy, values["blocked-by"], "作成");
  const requestedBy = actor(values["requested-by"] ?? process.env.RAPRID_ACTOR, "--requested-by");
  const createdBy = actor(values["created-by"] ?? process.env.RAPRID_ACTOR, "--created-by");
  const job = Job.existing(projectRoot(), jobName);
  assertStatusDirs(job, "task");
  job.writeLock(() => {
    // workflowVersion 3 へ移行した後は旧形式のタスクを作らない (移行はすべての案件のロックの中で印を置く)
    assertLegacyAddAllowed(job.root);
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
  const { positionals, values } = parse(argv, { "requested-by": { type: "string" }, "created-by": { type: "string" }, actor: { type: "string" }, "if-match": { type: "string" } }, usage);
  if (positionals.length !== 5) throw new UsageError(usage);
  const [jobName, selector, rawName, askTo, rawQuestion] = positionals;
  const name = validateItemName("qa", rawName);
  if (!["customer", "internal", "undecided"].includes(askTo)) throw new UsageError(`確認先はcustomer、internal、undecidedのいずれかです: ${askTo}`);
  const question = singleLine(rawQuestion, "質問内容", true)!;
  const requestedBy = actor(values["requested-by"] ?? process.env.RAPRID_ACTOR, "--requested-by");
  const createdBy = actor(values["created-by"] ?? process.env.RAPRID_ACTOR, "--created-by");
  const root = projectRoot();
  const job = Job.existing(root, jobName);
  // 工程型タスクは QA の作成と今の工程の待ち (block) を、遷移サービスのロックの中で一緒に行う
  const target = job.find("task", selector);
  const kind = workflowKind(target);
  if (kind === "v4") {
    // v4 の遷移サービスは QA の作成と待ちを 1 回の操作にしない (T-022 の範囲外)。2 つの操作に分けて案内する
    throw new CliError(
      `workflowVersion 4 のタスクには task ask を使えません: ${job.display(target.index)}\n` +
        "raprid qa add で QA を作り、raprid task block <案件名> <ID> --blocked-by qa/<QAのID> --actor <actor> --if-match <revision> で今の工程を待ちにしてください",
      1,
      "WF_NOT_V3",
    );
  }
  if (kind !== "legacy") {
    assertWritableWorkflow(kind, target);
    askV3(root, job, selector, { name, askTo, question, requestedBy, createdBy }, values);
    return;
  }
  if (values.actor !== undefined || values["if-match"] !== undefined) throw new UsageError("--actor・--if-match は工程型タスクへの質問だけで使えます");
  job.writeLock(() => {
    const task = job.find("task", selector);
    if (workflowKind(task) !== "legacy") throw new CliError("タスクの形式が変わりました。再度実行してください", 1, "DEPENDENCY_CHANGED");
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

function move(argv: string[]): void {
  const { positionals, values } = parse(argv, { "if-match": { type: "string" }, json: { type: "boolean" }, "blocked-by": { type: "string", multiple: true } }, usage);
  if (positionals.length < 3 || positionals.length > 4) throw new UsageError(usage);
  const [jobName, selector, status, rawBlockedBy] = positionals;
  if (!["todo", "pending", "progress", "done"].includes(status)) throw new UsageError(`状態はtodo、pending、progress、doneのいずれかです: ${status}`);
  const blockedBy = blockedByFor(status, rawBlockedBy, values["blocked-by"], "変更");
  const ifMatch = parseIfMatch(values["if-match"]);
  const root = projectRoot();
  const job = Job.existing(root, jobName);
  // 待っている QA の案件も名前順にロックする。ロック内で依存が変わっていたら取り直す。書き込むのはこの案件だけなので、復旧もこの案件だけ
  let done: { item: ReturnType<Job["find"]>; link: string; old: string; id: string } | undefined;
  for (let attempt = 0; attempt < 3 && !done; attempt++) {
    let planned: string[] = [];
    try {
      const current = job.find("task", selector);
      const fm = current.frontmatter();
      if (fm.get("status") === "pending" && status !== "pending") planned = qaJobs(job.name, blockersOf(fm, job.display(current.index)));
    } catch (error) {
      if (!(error instanceof CliError) && !(error instanceof FrontmatterError)) throw error;
      // 見つからない・読めない (工程型を含む) 場合はロック内で同じ確認をして報告する
    }
    const locked = new Set([job.name, ...planned.filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))]);
    done = withJobWriteLocks(root, [...locked], [job.name], () => {
      const item = job.find("task", selector);
      const kind = workflowKind(item);
      if (kind !== "legacy") {
        assertWritableWorkflow(kind, item);
        throw new CliError(
          `工程型タスクは task move で状態を変えられません: ${job.display(item.index)}\n工程の操作 (task claim・complete・decide・block・resume・reopen・assign) を使ってください`,
          1,
          "WF_USE_WORKFLOW_COMMANDS",
        );
      }
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
      fm.set("blockedBy", blockedBy.map(yamlScalar));
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
  const { positionals, values } = parse(argv, { "if-match": { type: "string" } }, usage);
  if (positionals.length < 3 || positionals.length > 4) throw new UsageError(usage);
  const [jobName, selector, rawDetail, rawTitle] = positionals;
  const detail = validateItemName("task", rawDetail);
  const title = singleLine(rawTitle, "見出し", false) ?? detail;
  const job = Job.existing(projectRoot(), jobName);
  job.writeLock(() => {
    const item = job.find("task", selector);
    const files = readdirSync(item.dir);
    const numbered = files.map((file) => /^(\d{2,})-(.+)\.md$/.exec(file)).filter((match) => match !== null);
    const duplicate = numbered.find((match) => match[2] === detail);
    if (duplicate) throw new CliError(`同名の詳細があります: ${job.display(join(item.dir, duplicate[0]))}`);
    const next = Math.max(0, ...numbered.map((match) => Number(match[1]))) + 1;
    const file = `${String(next).padStart(2, "0")}-${detail}.md`;
    const path = join(item.dir, file);
    // 工程型タスクは本文にリンクを足すだけ (frontmatter は変えない)。新形式の書き込みなので --if-match が必要
    const kind = workflowKind(item);
    if (kind !== "legacy") {
      // 本文の「## 詳細」にリンクを足すだけで frontmatter は変えないので、v4 のタスクにも同じ操作を使う
      if (kind !== "v4") assertWritableWorkflow(kind, item);
      noteV3(job, item, file, title, path, values["if-match"], writeFileAtomic);
      console.log(`作成: ${job.display(path)}`);
      console.log(`リンク: ${job.display(item.index)} の「## 詳細」に追加しました (frontmatter は変えていない)`);
      return;
    }
    if (values["if-match"] !== undefined) throw new UsageError("--if-match は工程型タスクへの詳細の追加だけで使えます");

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

// v3 と v4 で同じ名前の工程の操作。対象のタスクの版で振り分ける (振り分けの後、各サービスがロックの中で読み直して版を確かめる)
const sharedOptions: Record<string, Record<string, { type: "string" | "boolean"; multiple?: boolean }>> = {
  claim: {},
  resume: {},
  assign: { by: { type: "string" }, reason: { type: "string" }, handoff: { type: "string" } },
  complete: { handoff: { type: "string" }, report: { type: "string" }, artifact: { type: "string", multiple: true }, commit: { type: "string", multiple: true } },
  block: { "blocked-by": { type: "string", multiple: true }, reason: { type: "string" } },
  reopen: { "return-to": { type: "string" }, reason: { type: "string" } },
  decide: { report: { type: "string" }, "return-to": { type: "string" }, reason: { type: "string" }, artifact: { type: "string", multiple: true }, commit: { type: "string", multiple: true } },
};

function byVersion(command: string, v3: (args: string[]) => void, v4: (args: string[], phase: string | null) => void): (args: string[]) => void {
  return (args) => {
    const peeked = peekTask(args, sharedOptions[command], usage);
    if (peeked?.kind === "v4") return v4(args, peeked.phase);
    return v3(args);
  };
}

export function run(argv: string[]): void {
  const [command, ...rest] = argv;
  const commands: Record<string, (args: string[]) => void> = {
    add,
    ask,
    list,
    move,
    note,
    show,
    claim: byVersion("claim", claim, claimV4),
    assign: byVersion("assign", assign, assignV4),
    complete: byVersion("complete", complete, completeV4),
    decide: (args) => {
      const peeked = peekTask(args, sharedOptions.decide, usage);
      if (peeked?.kind === "v4") decideOnV4(peeked.item);
      decide(args);
    },
    block: byVersion("block", block, blockV4),
    resume: byVersion("resume", resume, resumeV4),
    reopen: byVersion("reopen", reopen, reopenV4),
    "send-back": sendBack,
    revise,
  };
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
