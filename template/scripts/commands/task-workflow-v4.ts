// AI 工程と人の判断記録を持つタスク (workflowVersion 4) の task サブコマンド。T-022
// 契約: jobs/project_template/tasks/workflow-v4-contract/03-contract.md の 5 (遷移表)・6 (権限)・7 (整合性)
//
// v3 と同じ名前の工程の操作 (claim・assign・complete・block・resume・reopen) は、タスクの版を読んでここか v3 (task-workflow.ts) に振り分ける。
// 振り分けた後の版の違いは、各サービス (taskflow-v4.ts・taskflow.ts) がロックの中で読み直して拒否する (WF_NOT_V4・WF_VERSION)。
// v4 にだけある操作 (send-back・revise) は振り分けずにここで行い、v4 以外のタスクは WF_NOT_V4 で移行を案内する。
// v3 にだけある decide は、v4 のタスクには WF_NOT_V3 で v4 の操作 (complete・approval approve / reject) を案内する。
// すべての更新は --if-match が必須で、actor は --actor (担当の割当は --by) で必ず明示する (環境変数から補わない)。
// --json は schemaVersion 3 で、更新後のタスク・revision・追記した履歴・作った/変えた判断記録・先に復旧した journal・診断を返す。

import { relative } from "node:path";
import { parse, singleLine } from "../lib/args.ts";
import { actor } from "../lib/actor.ts";
import { CliError, UsageError } from "../lib/errors.ts";
import { localDate } from "../lib/fsutil.ts";
import { revisionOf } from "../lib/guard.ts";
import { Item, Job, validateItemName } from "../lib/jobs.ts";
import { approvalJson, findItem, ownIssues, printJson, recordJsonV3, response } from "../lib/query.ts";
import { Collector, isWorkflow, type TaskRecord, type WorkflowInfo } from "../lib/records.ts";
import { projectRoot } from "../lib/root.ts";
import { runTransitionV4, type TransitionResultV4Service } from "../lib/taskflow-v4.ts";
import { blockedByLines, renderTemplate } from "../lib/template.ts";
import type { OperationV4 } from "../lib/transitions-v4.ts";
import { currentLinks, workLinkPath, workLinkTarget } from "../lib/workindex.ts";
import { type Approvers, initialTaskV4, type PhaseV4, phasesV4, readTaskFile, type TaskType, taskTypes } from "../lib/workflow.ts";
import { YamlFrontmatter } from "../lib/yamlfront.ts";
import { approvalQueueLinkPath, approvalQueueLinkTarget, expectedWorkLinkV4 } from "../lib/decision.ts";
import { assertNameFree, assertStatusDirs, createItem } from "../lib/items.ts";
import { artifactRefs, requireActor, requireText, workflowKind } from "./task-workflow.ts";

export const workflowUsageV4 = `工程型タスク (workflowVersion 4。人の承認は判断記録で行う):
  raprid task add <案件名> <タスク名> --type research|implementation <タイトル> --workflow-version 4 [--plan-approver <human/…>] [--review-approver <human/…>] --requested-by <actor> --created-by <actor> [--json]
  raprid task claim <案件名> <ID> --actor <actor> --if-match <revision> [--json]
  raprid task assign <案件名> <ID> plan|execute|review <担当> --by <actor> --reason <理由> [--handoff <md>] --if-match <revision> [--json]
  raprid task complete <案件名> <ID> --actor <actor> (--handoff <md> | --report <md>) [--artifact <パス> ...] [--commit <repo>:<commit> ...] --if-match <revision> [--json]
  raprid task send-back <案件名> <ID> --actor <actor> --reason <理由> --if-match <revision> [--json]
  raprid task block <案件名> <ID> --actor <actor> --blocked-by <値> [--blocked-by <値> ...] [--reason <理由>] --if-match <revision> [--json]
  raprid task resume <案件名> <ID> --actor <actor> --if-match <revision> [--json]
  raprid task revise <案件名> <ID> --actor <human/…> --reason <理由> --if-match <revision> [--json]
  raprid task reopen <案件名> <ID> --return-to plan|execute|review --actor <human/…> --reason <理由> --if-match <revision> [--json]

工程は plan → execute → review (acceptance は無い)。plan・review の complete は AI 工程を done に固定し、タスクを人の確認待ち (pending) にして
判断記録 decisions/<工程>-<試行>.md を作る。承認・見送りは raprid approval (人 human/… だけ)。execute の complete は承認を挟まずに review へ進む
complete の資料は plan・execute が --handoff (引継資料の 4 節が必要)、review が --report (レビューの記録)。実装の execute は --artifact か --commit も必要
send-back は AI 工程の担当が理由を付けて戻す (execute → plan は要件の版 +1、review → execute)。revise・reopen は人だけ
--if-match は task show --json --schema-version 3 の revision。decide は v4 では使わない (review の完了は complete、人の判断は approval)`;

// ---- 結果の表示 --------------------------------------------------------------------------------------------------------

function waitingText(record: TaskRecord & { workflow: WorkflowInfo }): string {
  if (record.status === "closed") return `closed (${record.workflow.closureReason ?? "理由なし"})`;
  const waiting = record.workflow.waiting;
  if (waiting?.kind === "approval") {
    const decision = record.workflow.decisions.find((each) => each.id === waiting.approval);
    const assignee = decision?.data?.assignee;
    return `確認待ち ${waiting.approval} (判断者: ${typeof assignee === "string" ? assignee : "未割当"})`;
  }
  const phase = record.workflow.phase;
  const where = `${phase} ${record.workflow.phaseStatus}${record.workflow.assignee ? ` (担当: ${record.workflow.assignee})` : ""}`;
  return waiting?.kind === "external" ? `${where} 外部待ち ${waiting.blockedBy.join(", ")}` : where;
}

export function reportV4(root: string, job: Job, result: TransitionResultV4Service, json: boolean | undefined): void {
  const collector = new Collector(root);
  const data = collector.job(job);
  const entry = findItem(data, "task", result.item.name);
  const record = entry.record;
  if (!isWorkflow(record) || record.kind !== "task") throw new CliError(`更新後のタスクを読めません (内部の誤り): ${record.path}`, 1, "WF_INTERNAL");
  const task = record as TaskRecord & { workflow: WorkflowInfo };
  const decisions = result.decisions.map((change) => {
    const decision = task.workflow.decisions.find((each) => each.id === change.id);
    return decision ? approvalJson({ task, decision }, true) : { id: change.id, path: relative(root, change.path), recordRevision: change.revision };
  });
  const recovered = result.recovered.map((path) => relative(root, path));
  if (json) {
    printJson({ schemaVersion: 3, ok: true, item: recordJsonV3(record), revision: result.revision, appended: result.appended, decisions, recovered, issues: ownIssues(data, entry) });
    return;
  }
  for (const path of recovered) console.log(`復旧: ${path} (中断した操作を journal の前の状態へ戻した)`);
  const events = result.appended.map((each) => each.event).join(" → ");
  console.log(`変更: ${result.task.id} / ${result.item.name} / ${events || "判断記録だけ"} → ${waitingText(task)}`);
  const link = expectedWorkLinkV4(job.dir, result.item.name, result.task);
  console.log(link ? `索引: ${job.display(link)} -> ${workLinkTarget(result.item.name)}` : "索引: なし (closed)");
  for (const change of result.decisions) {
    const status = change.record.status;
    console.log(`判断記録: ${change.id} ${status}${change.record.assignee ? ` (判断者: ${change.record.assignee})` : status === "open" ? " (未割当)" : ""} ${job.display(change.path)}`);
    if (status === "open") console.log(`確認待ちの索引: ${job.display(approvalQueueLinkPath(job.dir, result.item.name, change.id))} -> ${approvalQueueLinkTarget(result.item.name, change.id)}`);
    console.log(`recordRevision: ${change.revision}`);
  }
  console.log(`revision: ${result.revision}`);
}

// ---- 操作 ---------------------------------------------------------------------------------------------------------------

const commonOptions = { actor: { type: "string" }, "if-match": { type: "string" }, json: { type: "boolean" } } as const;
type Spec = Record<string, { type: "string" | "boolean"; multiple?: boolean }>;

function transitionCommandV4(argv: string[], extra: Spec, positionalCount: number, build: (values: Record<string, unknown>, positionals: string[]) => OperationV4): void {
  response.version = 3;
  const { positionals, values } = parse(argv, { ...commonOptions, ...extra }, workflowUsageV4);
  if (positionals.length !== positionalCount) throw new UsageError(workflowUsageV4);
  const operation = build(values as Record<string, unknown>, positionals);
  const root = projectRoot();
  const job = Job.existing(root, positionals[0]);
  const result = runTransitionV4(root, job.name, positionals[1], { ifMatch: values["if-match"] as string | undefined }, operation);
  reportV4(root, job, result, values.json as boolean | undefined);
}

function phaseV4(value: string | undefined, option: string): PhaseV4 {
  if (value === undefined) throw new UsageError(`${option} に ${phasesV4.join(" / ")} のいずれかを指定してください`);
  if (!(phasesV4 as readonly string[]).includes(value)) throw new UsageError(`${option} は ${phasesV4.join(" / ")} のいずれかです (workflowVersion 4 に acceptance は無い): ${value}`);
  return value as PhaseV4;
}

export function claimV4(argv: string[]): void {
  transitionCommandV4(argv, {}, 2, (values) => ({ kind: "claim", actor: requireActor(values.actor as string | undefined, "--actor") }));
}

export function resumeV4(argv: string[]): void {
  transitionCommandV4(argv, {}, 2, (values) => ({ kind: "resume", actor: requireActor(values.actor as string | undefined, "--actor") }));
}

export function assignV4(argv: string[]): void {
  transitionCommandV4(argv, { by: { type: "string" }, reason: { type: "string" }, handoff: { type: "string" } }, 4, (values, positionals) => {
    if (values.actor !== undefined) throw new UsageError("assign は --actor ではなく --by (割り当てた actor) を指定してください");
    return {
      kind: "assign",
      phase: phaseV4(positionals[2], "工程"),
      assignee: actor(positionals[3], "担当"),
      by: requireActor(values.by as string | undefined, "--by"),
      reason: requireText(values.reason as string | undefined, "--reason"),
      handoff: values.handoff === undefined ? undefined : { path: values.handoff as string },
    };
  });
}

// complete の資料は、今の工程が review なら --report、plan・execute なら --handoff。今の工程は --if-match で照合する同じ内容から読む
export function completeV4(argv: string[], phase: string | null): void {
  transitionCommandV4(argv, { handoff: { type: "string" }, report: { type: "string" }, artifact: { type: "string", multiple: true }, commit: { type: "string", multiple: true } }, 2, (values) => {
    const handoff = values.handoff as string | undefined;
    const report = values.report as string | undefined;
    if (handoff !== undefined && report !== undefined) throw new UsageError("--handoff と --report は同時に指定できません (plan・execute は --handoff、review は --report)");
    if (phase === "review" && report === undefined) throw new UsageError(`review の完了には --report にレビューの記録 (タスクのディレクトリの Markdown) を指定してください${handoff !== undefined ? " (--handoff ではない)" : ""}`);
    if (phase !== "review" && handoff === undefined) throw new UsageError(`${phase ?? "今の工程"} の完了には --handoff に引継資料 (タスクのディレクトリの Markdown) を指定してください${report !== undefined ? " (--report は review だけ)" : ""}`);
    return { kind: "complete", actor: requireActor(values.actor as string | undefined, "--actor"), refs: [{ path: (report ?? handoff)! }, ...artifactRefs(values)] };
  });
}

export function sendBack(argv: string[]): void {
  transitionCommandV4(argv, { reason: { type: "string" } }, 2, (values) => ({
    kind: "send-back",
    actor: requireActor(values.actor as string | undefined, "--actor"),
    reason: requireText(values.reason as string | undefined, "--reason"),
  }));
}

export function blockV4(argv: string[]): void {
  transitionCommandV4(argv, { "blocked-by": { type: "string", multiple: true }, reason: { type: "string" } }, 2, (values) => ({
    kind: "block",
    actor: requireActor(values.actor as string | undefined, "--actor"),
    blockedBy: ((values["blocked-by"] as string[] | undefined) ?? []).map((value) => requireText(value, "--blocked-by")),
    reason: singleLine(values.reason as string | undefined, "--reason", false),
  }));
}

export function revise(argv: string[]): void {
  transitionCommandV4(argv, { reason: { type: "string" } }, 2, (values) => ({
    kind: "revise",
    actor: requireActor(values.actor as string | undefined, "--actor"),
    reason: requireText(values.reason as string | undefined, "--reason"),
  }));
}

export function reopenV4(argv: string[]): void {
  transitionCommandV4(argv, { "return-to": { type: "string" }, reason: { type: "string" } }, 2, (values) => ({
    kind: "reopen",
    actor: requireActor(values.actor as string | undefined, "--actor"),
    returnTo: phaseV4(values["return-to"] as string | undefined, "--return-to"),
    reason: requireText(values.reason as string | undefined, "--reason"),
  }));
}

// v4 のタスクへの decide は、AI の review の完了と人の判断に分かれた操作へ案内する
export function decideOnV4(item: Item): never {
  response.version = 3;
  throw new CliError(
    `workflowVersion 4 のタスクには decide を使えません: ${item.job.display(item.index)}\n` +
      "AI の review の完了は raprid task complete --report <md>、人の承認・見送りは raprid approval approve / reject を使ってください",
    1,
    "WF_NOT_V3",
  );
}

// ---- 作成 (T1) ----------------------------------------------------------------------------------------------------------

export function addV4(positionals: string[], values: { type?: string; "requested-by"?: string; "created-by"?: string; json?: boolean; "blocked-by"?: string[]; "plan-approver"?: string; "review-approver"?: string }): void {
  response.version = 3;
  if (positionals.length !== 3) throw new UsageError(`--type を付けた task add は <案件名> <タスク名> <タイトル> を指定します (状態は指定しない)\n${workflowUsageV4}`);
  if (values["blocked-by"] !== undefined) throw new UsageError("--type を付けた task add では待ちを指定できません (作った後に block を使う)");
  const [jobName, rawName, rawTitle] = positionals;
  const type = values.type as TaskType;
  if (!(taskTypes as readonly string[]).includes(type)) throw new UsageError(`--type は ${taskTypes.join(" / ")} のいずれかです (search・implement などの別名は受け付けない): ${values.type}`);
  const name = validateItemName("task", rawName);
  const title = requireText(rawTitle, "タイトル");
  const requestedBy = actor(values["requested-by"] ?? process.env.RAPRID_ACTOR, "--requested-by");
  const createdBy = actor(values["created-by"] ?? process.env.RAPRID_ACTOR, "--created-by");
  // 判断者の初期値は人だけ (判断記録を作るときの担当。無ければ未割当)
  const approvers: Approvers = {};
  for (const [phase, option] of [["plan", "--plan-approver"], ["review", "--review-approver"]] as const) {
    const value = values[option.slice(2) as "plan-approver" | "review-approver"];
    if (value === undefined) continue;
    if (!actor(value, option).startsWith("human/")) throw new UsageError(`${option} は人 (human/<識別子>) です: ${value}`);
    approvers[phase] = value;
  }
  const root = projectRoot();
  const job = Job.existing(root, jobName);
  const created = job.writeLock(() => {
    assertNameFree(job, "task", name);
    const left = currentLinks(job.dir, name);
    if (left.length > 0) throw new CliError(`同名の作業索引が存在します: ${left.map((link) => job.display(link.path)).join(", ")}`);
    const id = job.nextId("task");
    const date = localDate();
    const task = initialTaskV4({ id, type, date, requestedBy, createdBy, ...(Object.keys(approvers).length > 0 ? { approvers } : {}) });
    const legacy = renderTemplate("task/index.md", { id, status: "todo", date, title, requestedBy, createdBy, blockedBy: blockedByLines(undefined) });
    const body = legacy.slice(legacy.indexOf("\n---\n", 4) + 5);
    const frontmatter = YamlFrontmatter.parse(`---\n---\n${body}`);
    for (const [key, value] of Object.entries(task)) frontmatter.set([key], value);
    frontmatter.set(["test"], []);
    const content = frontmatter.toString();
    const read = readTaskFile(content);
    if (read.format.kind !== "v4" || read.issues.length > 0) throw new CliError(`作成するタスクが形式の規則を満たしません (内部の誤り): ${read.issues.map((issue) => issue.code).join(", ")}`, 1, "WF_INTERNAL");
    assertStatusDirs(job, "task");
    const item = createItem(job, "task", name, content, "todo", { link: workLinkPath(job.dir, "plan", "ready", name), target: workLinkTarget(name) });
    return { id, item, content };
  });
  if (values.json) {
    const data = new Collector(root).job(job);
    const entry = findItem(data, "task", created.item.name);
    printJson({ schemaVersion: 3, ok: true, item: recordJsonV3(entry.record), revision: revisionOf(Buffer.from(created.content)), appended: [], decisions: [], recovered: [], issues: ownIssues(data, entry) });
    return;
  }
  console.log(`作成: ${created.id} / ${job.display(created.item.index)} (workflowVersion 4・${type === "research" ? "調査" : "実装"})`);
  console.log(`索引: ${job.display(workLinkPath(job.dir, "plan", "ready", name))} -> ${workLinkTarget(name)}`);
  console.log(`判断者の初期値: plan ${approvers.plan ?? "未割当"} / review ${approvers.review ?? "未割当"}`);
  console.log(`revision: ${revisionOf(Buffer.from(created.content))}`);
}

// ---- 版による振り分け ---------------------------------------------------------------------------------------------------

// 工程の操作の対象の版と今の工程を読む (振り分けにだけ使う。書き換えの前に各サービスがロックの中で読み直す)
export function peekTask(argv: string[], options: Spec, usage: string): { kind: ReturnType<typeof workflowKind>; phase: string | null; item: Item } | undefined {
  const { positionals } = parse(argv, { ...commonOptions, ...options }, usage);
  if (positionals.length < 2) return undefined;
  let item: Item;
  try {
    item = Job.existing(projectRoot(), positionals[0]).find("task", positionals[1]);
  } catch {
    return undefined; // 見つからない・名前の誤りは、振り分け先のサービスが同じ確認をして報告する
  }
  const kind = workflowKind(item);
  let phase: string | null = null;
  if (kind === "v4") {
    try {
      const value = YamlFrontmatter.parse(item.read()).data().phase;
      phase = typeof value === "string" ? value : null;
    } catch {
      phase = null;
    }
  }
  return { kind, phase, item };
}
