// 工程型タスク (workflowVersion 3) の task サブコマンド。T-014
//
// 作成 (add --type)・工程の操作 (claim・assign・complete・decide・block・resume・reopen)・質問 (ask)・詳細の追加 (note) を、
// T-013 の遷移サービス (lib/taskflow.ts) に接続する。すべての更新は案件のロックの中で --if-match の revision を照合し、
// index.md と作業索引 (status/<工程>/<工程の状態>/<名前>) を一緒に書き換える。--json は schemaVersion 2 で返す。
// actor は --actor (担当の割当は --by) で必ず明示する (環境変数から補わない。人の受入確認を AI が代わりに記録しないように)。

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, singleLine } from "../lib/args.ts";
import { actor } from "../lib/actor.ts";
import { CliError, UsageError } from "../lib/errors.ts";
import { localDate } from "../lib/fsutil.ts";
import { assertRevision, parseIfMatch, revisionOf } from "../lib/guard.ts";
import { assertNameFree, assertStatusDirs, createItem } from "../lib/items.ts";
import { Item, Job, validateItemName } from "../lib/jobs.ts";
import { appendToSection, headings, splitLines } from "../lib/markdown.ts";
import { findItem, ownIssues, printJson, recordJsonV2 } from "../lib/query.ts";
import { Collector } from "../lib/records.ts";
import { hasWorkflowVersion } from "../lib/taskformat.ts";
import { projectRoot } from "../lib/root.ts";
import { runTransition, type TransitionResult } from "../lib/taskflow.ts";
import { blockedByLines, renderTemplate } from "../lib/template.ts";
import type { Operation, ReturnTarget } from "../lib/transitions.ts";
import { currentLinks, expectedLink, workLinkPath, workLinkTarget } from "../lib/workindex.ts";
import { type ArtifactRef, initialTaskV3, phasesV3, readTaskFile, type TaskType, taskTypes } from "../lib/workflow.ts";
import { YamlFrontmatter } from "../lib/yamlfront.ts";

export const workflowUsage = `工程型タスク (workflowVersion 3):
  raprid task add <案件名> <タスク名> --type research|implementation <タイトル> --requested-by <actor> --created-by <actor> [--json]
  raprid task claim <案件名> <ID> --actor <actor> --if-match <revision> [--json]
  raprid task assign <案件名> <ID> <工程> <担当> --by <actor> --reason <理由> [--handoff <md>] --if-match <revision> [--json]
  raprid task complete <案件名> <ID> --actor <actor> --handoff <md> [--artifact <パス> ...] [--commit <repo>:<commit> ...] --if-match <revision> [--json]
  raprid task decide <案件名> <ID> approved|changes_requested --actor <actor> --report <md> [--return-to plan|execute] [--reason <理由>] --if-match <revision> [--json]
  raprid task block <案件名> <ID> --actor <actor> --blocked-by <値> [--blocked-by <値> ...] [--reason <理由>] --if-match <revision> [--json]
  raprid task resume <案件名> <ID> --actor <actor> --if-match <revision> [--json]
  raprid task reopen <案件名> <ID> --return-to plan|execute --actor <actor> --reason <理由> --if-match <revision> [--json]
  raprid task ask <案件名> <ID> <QA名> <確認先> <質問内容> --actor <actor> --requested-by <actor> --created-by <actor> --if-match <revision>
  raprid task note <案件名> <ID> <詳細名> [<見出し>] --if-match <revision>

種別: research (調査) | implementation (実装)。工程は種別によらず plan → execute → review → acceptance
complete は計画・実行の完了 (--handoff の引継資料に「対象・成果物」「実施・検証」「未確認・制約」「次の担当への依頼」の節が必要)、
decide はレビュー・受入確認の判定 (受入確認は人 human/… だけ)。実装の実行の完了には --artifact か --commit の対象が必要
--if-match は task show --json --schema-version 2 の revision。工程型タスクの更新はすべて必須
task move は工程型タスクには使えない (上の操作を使う)`;

const commonOptions = { actor: { type: "string" }, "if-match": { type: "string" }, json: { type: "boolean" } } as const;

export function requireActor(value: string | undefined, option: string): string {
  if (value === undefined) throw new UsageError(`${option} で actor を指定してください (工程型タスクの操作では環境変数から補わない)`);
  return actor(value, option);
}

export function requireText(value: string | undefined, option: string): string {
  return singleLine(value, option, true)!;
}

function commitRef(value: string): ArtifactRef {
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*):([0-9a-f]{7,40})$/.exec(value);
  if (!match) throw new UsageError(`--commit は <repo>:<commit> (commit は 7〜40 桁の小文字 16 進数) です: ${value}`);
  return { repo: match[1], commit: match[2] };
}

function returnTarget(value: string | undefined, required: boolean): ReturnTarget | undefined {
  if (value === undefined) {
    if (required) throw new UsageError("--return-to に plan か execute を指定してください");
    return undefined;
  }
  if (value !== "plan" && value !== "execute") throw new UsageError(`--return-to は plan か execute です: ${value}`);
  return value;
}

// index.md が工程型 (workflowVersion のある) タスクか。v4 (T-020) はこの v3 の操作では書き換えない (v4 の操作は T-022)
export function workflowKind(item: Item): "legacy" | "v2" | "v3" | "v4" | "unsupported" {
  const text = item.read();
  if (!hasWorkflowVersion(text)) return "legacy";
  try {
    const kind = readTaskFile(text, item.job.display(item.index)).format.kind;
    return kind === "legacy" ? "unsupported" : kind;
  } catch {
    return "unsupported";
  }
}

// v2・v4・対応していない版の工程型タスクは、この (v3 の) 操作では書き換えない (v2 は移行してから使う。v4 は v4 の操作を使う)
export function assertWritableWorkflow(kind: ReturnType<typeof workflowKind>, item: Item): void {
  if (kind === "v2") throw new CliError(`workflowVersion 2 のタスクは変更できません。workflowVersion 3 へ移行してから使ってください: ${item.job.display(item.index)}`, 1, "WF_NOT_V3");
  if (kind === "v4") {
    throw new CliError(
      `workflowVersion 4 のタスクは workflowVersion 3 の操作では変更できません: ${item.job.display(item.index)}\n` +
        "工程は raprid task claim・complete・send-back・block・resume・assign・revise・reopen、人の判断は raprid approval を使ってください (raprid task --help)",
      1,
      "WF_NOT_V3",
    );
  }
  if (kind === "unsupported") throw new CliError(`対応していない形式のタスクは変更できません: ${item.job.display(item.index)}`, 1, "WF_VERSION");
}

// 更新の結果を表示する。--json は schemaVersion 2 で、更新後の一覧の項目・revision・追記した履歴・診断を返す
function report(root: string, job: Job, result: TransitionResult, json: boolean | undefined, lines: string[] = []): void {
  if (json) {
    const collector = new Collector(root);
    const data = collector.job(job);
    const entry = findItem(data, "task", result.item.name);
    printJson({ schemaVersion: 2, ok: true, item: recordJsonV2(entry.record), revision: result.revision, appended: result.appended, issues: ownIssues(data, entry) });
    return;
  }
  const { task } = result;
  const phase = task.phase;
  const where = phase === null ? "closed" : `${phase} ${task.workflow[phase].status}${task.workflow[phase].assignee ? ` (担当: ${task.workflow[phase].assignee})` : ""}`;
  console.log(`変更: ${task.id} / ${result.item.name} / ${result.appended.map((entry) => entry.event).join(" → ")} → ${where}`);
  const link = expectedLink(job.dir, result.item.name, task);
  console.log(link ? `索引: ${job.display(link)} -> ${workLinkTarget(result.item.name)}` : "索引: なし (closed)");
  for (const line of lines) console.log(line);
  console.log(`revision: ${result.revision}`);
}

function transitionCommand(argv: string[], extra: Record<string, { type: "string" | "boolean"; multiple?: boolean }>, positionalCount: number, build: (values: Record<string, unknown>, positionals: string[]) => Operation): void {
  const { positionals, values } = parse(argv, { ...commonOptions, ...extra }, workflowUsage);
  if (positionals.length !== positionalCount) throw new UsageError(workflowUsage);
  const operation = build(values as Record<string, unknown>, positionals);
  const root = projectRoot();
  const job = Job.existing(root, positionals[0]);
  const result = runTransition(root, job.name, positionals[1], values["if-match"] as string | undefined, operation);
  report(root, job, result, values.json as boolean | undefined);
}

export function claim(argv: string[]): void {
  transitionCommand(argv, {}, 2, (values) => ({ kind: "claim", actor: requireActor(values.actor as string | undefined, "--actor") }));
}

export function resume(argv: string[]): void {
  transitionCommand(argv, {}, 2, (values) => ({ kind: "resume", actor: requireActor(values.actor as string | undefined, "--actor") }));
}

export function assign(argv: string[]): void {
  transitionCommand(argv, { by: { type: "string" }, reason: { type: "string" }, handoff: { type: "string" } }, 4, (values, positionals) => {
    const phase = positionals[2];
    if (!(phasesV3 as readonly string[]).includes(phase)) throw new UsageError(`工程は ${phasesV3.join(" / ")} のいずれかです: ${phase}`);
    if (values.actor !== undefined) throw new UsageError("assign は --actor ではなく --by (割り当てた actor) を指定してください");
    return {
      kind: "assign",
      phase: phase as (typeof phasesV3)[number],
      assignee: actor(positionals[3], "担当"),
      by: requireActor(values.by as string | undefined, "--by"),
      reason: requireText(values.reason as string | undefined, "--reason"),
      handoff: values.handoff === undefined ? undefined : { path: values.handoff as string },
    };
  });
}

export function artifactRefs(values: Record<string, unknown>): ArtifactRef[] {
  return [...((values.artifact as string[] | undefined) ?? []).map((path) => ({ path })), ...((values.commit as string[] | undefined) ?? []).map(commitRef)];
}

export function complete(argv: string[]): void {
  transitionCommand(argv, { handoff: { type: "string" }, artifact: { type: "string", multiple: true }, commit: { type: "string", multiple: true } }, 2, (values) => {
    if (values.handoff === undefined) throw new UsageError("--handoff に引継資料 (タスクのディレクトリの Markdown) を指定してください");
    return { kind: "complete", actor: requireActor(values.actor as string | undefined, "--actor"), refs: [{ path: values.handoff as string }, ...artifactRefs(values)] };
  });
}

export function decide(argv: string[]): void {
  transitionCommand(argv, { report: { type: "string" }, "return-to": { type: "string" }, reason: { type: "string" }, artifact: { type: "string", multiple: true }, commit: { type: "string", multiple: true } }, 3, (values, positionals) => {
    const outcome = positionals[2];
    if (outcome !== "approved" && outcome !== "changes_requested") throw new UsageError(`判定は approved か changes_requested です: ${outcome}`);
    if (values.report === undefined) throw new UsageError("--report にレビュー・受入確認の記録 (タスクのディレクトリの Markdown) を指定してください");
    return {
      kind: "decide",
      actor: requireActor(values.actor as string | undefined, "--actor"),
      outcome,
      refs: [{ path: values.report as string }, ...artifactRefs(values)],
      returnTo: returnTarget(values["return-to"] as string | undefined, false),
      reason: singleLine(values.reason as string | undefined, "--reason", false),
    };
  });
}

export function block(argv: string[]): void {
  transitionCommand(argv, { "blocked-by": { type: "string", multiple: true }, reason: { type: "string" } }, 2, (values) => ({
    kind: "block",
    actor: requireActor(values.actor as string | undefined, "--actor"),
    blockedBy: ((values["blocked-by"] as string[] | undefined) ?? []).map((value) => requireText(value, "--blocked-by")),
    reason: singleLine(values.reason as string | undefined, "--reason", false),
  }));
}

export function reopen(argv: string[]): void {
  transitionCommand(argv, { "return-to": { type: "string" }, reason: { type: "string" } }, 2, (values) => ({
    kind: "reopen",
    actor: requireActor(values.actor as string | undefined, "--actor"),
    returnTo: returnTarget(values["return-to"] as string | undefined, true)!,
    reason: requireText(values.reason as string | undefined, "--reason"),
  }));
}

// v3 のタスクを作る。本文は旧形式の雛形と同じ節 (タイトル・内容・完了条件・詳細・結果) で、frontmatter だけが v3
export function addV3(positionals: string[], values: { type?: string; "requested-by"?: string; "created-by"?: string; json?: boolean; "blocked-by"?: string[] }): void {
  if (positionals.length !== 3) throw new UsageError(`--type を付けた task add は <案件名> <タスク名> <タイトル> を指定します (状態は指定しない)\n${workflowUsage}`);
  if (values["blocked-by"] !== undefined) throw new UsageError("--type を付けた task add では待ちを指定できません (作った後に block を使う)");
  const [jobName, rawName, rawTitle] = positionals;
  const type = values.type as TaskType;
  if (!(taskTypes as readonly string[]).includes(type)) throw new UsageError(`--type は ${taskTypes.join(" / ")} のいずれかです (search・implement などの別名は受け付けない): ${values.type}`);
  const name = validateItemName("task", rawName);
  const title = requireText(rawTitle, "タイトル");
  // 作成者・依頼元は、旧形式の add と同じく環境変数 RAPRID_ACTOR で補える (工程の操作ではない)
  const requestedBy = actor(values["requested-by"] ?? process.env.RAPRID_ACTOR, "--requested-by");
  const createdBy = actor(values["created-by"] ?? process.env.RAPRID_ACTOR, "--created-by");
  const root = projectRoot();
  const job = Job.existing(root, jobName);
  const created = job.writeLock(() => {
    // 実体・旧形式の状態索引・作業索引 (v2 の implement、waiting・done を含むすべての工程と状態) に同名の残りがあれば作らない
    assertNameFree(job, "task", name);
    const left = currentLinks(job.dir, name);
    if (left.length > 0) throw new CliError(`同名の作業索引が存在します: ${left.map((link) => job.display(link.path)).join(", ")}`);
    const id = job.nextId("task");
    const date = localDate();
    const task = initialTaskV3({ id, type, date, requestedBy, createdBy });
    // 本文は旧形式の雛形から取る (frontmatter の後ろ)
    const legacy = renderTemplate("task/index.md", { id, status: "todo", date, title, requestedBy, createdBy, blockedBy: blockedByLines(undefined) });
    const body = legacy.slice(legacy.indexOf("\n---\n", 4) + 5);
    const frontmatter = YamlFrontmatter.parse(`---\n---\n${body}`);
    for (const [key, value] of Object.entries(task)) frontmatter.set([key], value);
    frontmatter.set(["test"], []);
    const content = frontmatter.toString();
    const errors = readTaskFile(content).issues;
    if (errors.length > 0) throw new CliError(`作成するタスクが形式の規則を満たしません (内部の誤り): ${errors.map((issue) => issue.code).join(", ")}`, 1, "WF_INTERNAL");
    // 実体は旧形式の createItem で公開し、作業索引 (status/plan/ready/<名前>) を張る
    const item = createWithWorkLink(job, name, content);
    return { id, item, content };
  });
  if (values.json) {
    const data = new Collector(root).job(job);
    const entry = findItem(data, "task", created.item.name);
    printJson({ schemaVersion: 2, ok: true, item: recordJsonV2(entry.record), revision: revisionOf(Buffer.from(created.content)), appended: [], issues: ownIssues(data, entry) });
    return;
  }
  console.log(`作成: ${created.id} / ${job.display(created.item.index)} (workflowVersion 3・${type === "research" ? "調査" : "実装"})`);
  console.log(`索引: ${job.display(workLinkPath(job.dir, "plan", "ready", name))} -> ${workLinkTarget(name)}`);
  console.log(`revision: ${revisionOf(Buffer.from(created.content))}`);
}

// createItem は旧形式の状態索引 (status/<状態>/) に張るので、作業索引の場所へ張る版をここで作る
function createWithWorkLink(job: Job, name: string, content: string): Item {
  assertStatusDirs(job, "task");
  const link = workLinkPath(job.dir, "plan", "ready", name);
  return createItem(job, "task", name, content, "todo", { link, target: workLinkTarget(name) });
}

// 工程型タスクの質問: QA を作り、今の工程を待ち (block、待ち: qa/<ID>) にする。タスクの更新に失敗したら QA を消す
export function askV3(root: string, job: Job, selector: string, qa: { name: string; askTo: string; question: string; requestedBy: string; createdBy: string }, values: { actor?: string; "if-match"?: string }): void {
  const blocker = requireActor(values.actor, "--actor");
  const result = runTransition(root, job.name, selector, values["if-match"], { kind: "block", actor: blocker, blockedBy: ["qa/Q-000"] }, {
    prepare: () => {
      assertStatusDirs(job, "qa");
      assertNameFree(job, "qa", qa.name);
      const id = job.nextId("qa");
      const content = renderTemplate("qa/index.md", { id, date: localDate(), job: job.name, askTo: qa.askTo, question: qa.question, requestedBy: qa.requestedBy, createdBy: qa.createdBy, blockedBy: blockedByLines(undefined) });
      const item = createItem(job, "qa", qa.name, content, "unresolved");
      return {
        operation: { kind: "block", actor: blocker, blockedBy: [`qa/${id}`], reason: `qa/${id} の回答待ち` },
        undo: () => {
          rmSync(join(job.statusDir("qa", "unresolved"), qa.name), { force: true });
          rmSync(item.dir, { recursive: true, force: true });
        },
      };
    },
  });
  const qaId = result.task.blockedBy[0];
  console.log(`作成: ${qaId.replace(/^qa\//, "")} / ${job.display(join(job.itemsDir("qa"), qa.name, "index.md"))}`);
  report(root, job, result, false);
}

// 工程型タスクの詳細の追加: 本文の「## 詳細」にリンクを足すだけ (frontmatter は 1 バイトも変えない)
export function noteV3(job: Job, item: Item, file: string, title: string, path: string, ifMatch: string | undefined, write: (index: string, text: string) => void): void {
  if (ifMatch === undefined) throw new CliError("工程型タスクに詳細を追加するには --if-match に revision (task show の revision) を指定してください", 2, "REVISION_REQUIRED");
  const bytes = readFileSync(item.index);
  assertRevision(parseIfMatch(ifMatch), bytes, job.display(item.index));
  const text = bytes.toString("utf8");
  if (headings(splitLines(text)).filter((heading) => heading.level === 2 && heading.text === "詳細").length > 1) throw new CliError(`「## 詳細」が複数あります: ${job.display(item.index)}`);
  const label = title.replace(/[\\[\]]/g, "\\$&");
  const linked = appendToSection(text, 2, "詳細", [`* [${label}](${file})`]);
  const close = text.indexOf("\n---\n", 4);
  if (close < 0 || linked.slice(0, close) !== text.slice(0, close)) throw new CliError("frontmatter を変えずに詳細を追加できません (内部の誤り)", 1, "WF_INTERNAL");
  writeFileSync(path, renderTemplate("task/_.md", { title }), { flag: "wx", mode: 0o644 });
  try {
    write(item.index, linked);
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
}
