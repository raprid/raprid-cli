// 一覧・詳細・snapshot の絞り込みと JSON の組み立て。
//   schemaVersion 1 (query-v1): 旧形式のタスクと QA。工程型 (workflowVersion 2・3) のタスクは表せないので、対象にあれば
//                               SCHEMA_V2_REQUIRED で止める (旧 TUI などが旧形式として誤って読まないように)
//   schemaVersion 2 (query-v2): --schema-version 2 で選ぶ。タスクに workflowVersion (旧形式は null) と工程型の項目を足す
//   schemaVersion 3 (query-v3): --schema-version 3 で選ぶ。T-022。v4 のタスク (人の確認待ち・判断記録) を表す項目を足す。
//                               v4 のタスクが対象にあれば、schemaVersion 1・2 は SCHEMA_V3_REQUIRED で止める (03-contract.md の 7)

import { CliError, UsageError } from "./errors.ts";
import { Job, type Kind } from "./jobs.ts";
import {
  type Collected,
  Collector,
  compareRecords,
  countRecords,
  type DecisionInfo,
  type Issue,
  isKnownStatus,
  isWorkflow,
  type ItemRecord,
  type JobData,
  type JobRecord,
  statusOrder,
  type TaskRecord,
  type WorkflowInfo,
  workflowFilterStatus,
} from "./records.ts";

export const schemaVersion = 1;
export type SchemaVersion = 1 | 2 | 3;
// query-v1: 一覧・詳細・snapshot の JSON (schemaVersion 1)。guarded-write-v1: --if-match・--answer-file・更新の --json。
// query-v2: schemaVersion 2 の JSON (--schema-version 2)。workflow-v3: 工程型タスク (workflowVersion 3) の作成と工程の操作
// query-v3: schemaVersion 3 の JSON (--schema-version 3・approval list/show)。workflow-v4: v4 のタスクの作成・工程の操作・判断記録の操作 (T-022)
export const capabilities = ["query-v1", "guarded-write-v1", "query-v2", "workflow-v3", "query-v3", "workflow-v4"];

// --json の失敗を返すときの schemaVersion。v4 のタスクへの操作は schemaVersion 3 で返す (cli.ts が読む。版で振り分けた後に決まる)
export const response: { version: SchemaVersion | undefined } = { version: undefined };

// --schema-version の値 (省略は 1)
export function parseSchemaVersion(value: string | undefined): SchemaVersion {
  if (value === undefined || value === "1") return 1;
  if (value === "2") return 2;
  if (value === "3") return 3;
  throw new UsageError(`--schema-version は 1・2・3 のいずれかです: ${value}`);
}

const isV4 = (record: ItemRecord) => isWorkflow(record) && record.workflow.version === 4;

// schemaVersion 1・2 では v4 のタスク (人の確認待ち・判断記録) を表せない。黙って v3 以前として出さずに止める
export function assertCompatible(records: ItemRecord[], version: SchemaVersion): void {
  if (version >= 3) return;
  const found = records.filter(isV4);
  if (found.length > 0) {
    throw new CliError(
      `workflowVersion 4 のタスク (${found.slice(0, 3).map((record) => record.id ?? record.name).join(", ")}${found.length > 3 ? " ほか" : ""}) は schemaVersion ${version} の JSON では表せません。` +
        "raprid を更新し、--schema-version 3 で取得してください (capability: query-v3・workflow-v4)",
      1,
      "SCHEMA_V3_REQUIRED",
    );
  }
  if (version === 1) assertV1Compatible(records);
}

// schemaVersion 1 では工程型のタスクを表せない。黙って旧形式として出さずに止める
export function assertV1Compatible(records: ItemRecord[]): void {
  const found = records.filter(isWorkflow);
  if (found.length === 0) return;
  throw new CliError(
    `工程型のタスク (${found.slice(0, 3).map((record) => record.id ?? record.name).join(", ")}${found.length > 3 ? " ほか" : ""}) は schemaVersion 1 の JSON では表せません。` +
      "raprid を更新し、--schema-version 2 で取得してください",
    1,
    "SCHEMA_V2_REQUIRED",
  );
}

export interface ListFilter {
  statuses: ReadonlySet<string> | "all";
  search: string | undefined;
  closed?: boolean; // closed のタスクと旧形式の done だけ
  type?: string;
  phase?: string;
  assignee?: string;
}

// 工程型のタスクの --status に使える今の工程の状態。approval は v4 の人の確認待ち (タスクの pending。AI 工程は done)
export const phaseStatusFilters = ["ready", "progress", "pending", "approval"];
export const typeFilters = ["research", "implementation"];
export const phaseFilters = ["plan", "execute", "review", "acceptance"];

// task の既定は done・closed 以外、QA の既定は unresolved
export function parseFilter(kind: Kind, values: { status?: string; all?: boolean; search?: string; closed?: boolean; type?: string; phase?: string; assignee?: string }): ListFilter {
  if (values.all && values.status !== undefined) throw new UsageError("--all と --status は同時に指定できません");
  if (values.closed && (values.all || values.status !== undefined)) throw new UsageError("--closed は --all・--status と同時に指定できません");
  if (values.search !== undefined && values.search.trim() === "") throw new UsageError("--search には空でない文字列を指定してください");
  if (values.type !== undefined && !typeFilters.includes(values.type)) throw new UsageError(`--type は ${typeFilters.join(" / ")} のいずれかです: ${values.type}`);
  if (values.phase !== undefined && !phaseFilters.includes(values.phase)) throw new UsageError(`--phase は ${phaseFilters.join(" / ")} のいずれかです: ${values.phase}`);
  if (values.assignee !== undefined && values.assignee.trim() === "") throw new UsageError("--assignee には actor を指定してください");
  const extra = { closed: values.closed, type: values.type, phase: values.phase, assignee: values.assignee };
  if (values.closed) return { statuses: "all", search: values.search, ...extra };
  const known = kind === "task" ? [...statusOrder.task, ...phaseStatusFilters.filter((status) => !statusOrder.task.includes(status))] : statusOrder[kind];
  let statuses: ReadonlySet<string> | "all";
  if (values.all) statuses = "all";
  else if (values.status !== undefined) {
    const list = values.status.split(",").map((value) => value.trim()).filter((value) => value !== "");
    if (list.length === 0) throw new UsageError(`--status には ${known.join(",")} をカンマ区切りで指定してください`);
    const unknown = list.filter((value) => !known.includes(value));
    if (unknown.length > 0) throw new UsageError(`不明な状態です: ${unknown.join(", ")} (指定できるのは ${known.join(", ")})`);
    statuses = new Set(list);
  } else statuses = new Set(kind === "task" ? known.filter((status) => status !== "done") : ["unresolved"]);
  return { statuses, search: values.search, ...extra };
}

export function searchable(record: ItemRecord): string[] {
  const fields = [record.id, record.name, record.title];
  if (record.kind === "qa") fields.push(record.question);
  return fields.filter((value): value is string => value !== null);
}

// 未知の状態は隠さずに表示する (診断と一緒に末尾へ並ぶ)。
// 工程型のタスクは、--status を今の工程の状態で比べ、closed は既定で隠す (--closed・--all で出す)
export function matchesFilter(record: ItemRecord, filter: ListFilter): boolean {
  if (isWorkflow(record)) {
    const closed = record.status === "closed";
    if (filter.closed && !closed) return false;
    const status = workflowFilterStatus(record);
    if (!filter.closed && filter.statuses !== "all" && (closed || (status !== null && !filter.statuses.has(status)))) return false;
    if (filter.type !== undefined && record.workflow.type !== filter.type) return false;
    if (filter.phase !== undefined && record.workflow.phase !== filter.phase) return false;
    if (filter.assignee !== undefined && record.workflow.assignee !== filter.assignee) return false;
  } else {
    if (filter.closed && !(record.kind === "task" && record.status === "done")) return false;
    // 種別・工程・担当で絞るときは、旧形式 (工程が無い) は出さない
    if (filter.type !== undefined || filter.phase !== undefined || filter.assignee !== undefined) return false;
    if (!filter.closed && isKnownStatus(record.kind, record.status) && filter.statuses !== "all" && !filter.statuses.has(record.status!)) return false;
  }
  if (filter.search === undefined) return true;
  const needle = filter.search.toLowerCase();
  return searchable(record).some((value) => value.toLowerCase().includes(needle));
}

// 対象案件。指定した案件が無ければエラー (0 件の案件とは区別する)
export function scopeJobs(collector: Collector, jobName: string | undefined): Job[] {
  if (jobName === undefined) return collector.jobs();
  return [Job.existing(collector.root, jobName)];
}

export function recordJson(record: ItemRecord): Record<string, unknown> {
  const base = {
    job: record.job,
    kind: record.kind,
    id: record.id,
    name: record.name,
    path: record.path,
    title: record.title,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    requestedBy: record.requestedBy,
    createdBy: record.createdBy,
    revision: record.revision,
  };
  if (record.kind === "task") return { ...base, completedAt: record.completedAt, blockedBy: record.blockedBy };
  return { ...base, question: record.question, answer: record.answer, askTo: record.askTo, answeredBy: record.answeredBy, resolvedAt: record.resolvedAt };
}

// schemaVersion 2 の項目。タスクに workflowVersion (旧形式は null) を足し、工程型は工程・担当・記録を足す
export function recordJsonV2(record: ItemRecord): Record<string, unknown> {
  const base = recordJson(record);
  if (record.kind !== "task") return base;
  if (!isWorkflow(record)) return { ...base, workflowVersion: null };
  const { workflow } = record;
  const data = workflow.data;
  return {
    ...base,
    workflowVersion: workflow.version,
    type: workflow.type,
    phase: workflow.phase,
    phaseStatus: workflow.phaseStatus,
    assignee: workflow.assignee,
    requirementRevision: workflow.requirementRevision,
    closureReason: workflow.closureReason,
    relatedTasks: workflow.relatedTasks,
    workflow: data.workflow ?? null,
    history: data.history ?? [],
    valid: workflow.valid,
    readable: workflow.readable,
  };
}

// 判断記録の要約 (タスクの approvals と approval list の項目に共通)
function decisionSummary(decision: DecisionInfo): Record<string, unknown> {
  const data = decision.data ?? {};
  const value = (key: string) => (data[key] === undefined ? null : data[key]);
  return {
    id: decision.id,
    phase: value("phase"),
    attempt: value("attempt"),
    status: value("status"),
    assignee: value("assignee"),
    outcome: value("outcome"),
    returnTo: value("returnTo"),
    origin: value("origin"),
    path: decision.path,
    recordRevision: decision.revision,
    current: decision.current,
    valid: decision.valid,
  };
}

// schemaVersion 3 の項目。schemaVersion 2 の項目に、タスクの軸の人の確認待ち (waiting・approval) と判断記録の一覧を足す。
// AI 工程の軸は phase・phaseStatus・assignee (v4 の人の確認待ちでは、提出した工程が done のまま)、タスクの軸は status (open・pending・closed)。
// waiting: 人の確認待ちは {kind: "approval", phase, approval}、外部の待ちは {kind: "external", phase, blockedBy}、無ければ null。v3 以前は null
export function recordJsonV3(record: ItemRecord): Record<string, unknown> {
  const base = recordJsonV2(record);
  if (record.kind !== "task") return base;
  if (!isWorkflow(record) || record.workflow.version !== 4) return { ...base, waiting: null, approvers: null, approval: null, approvals: [], migratedFrom: null };
  const { workflow } = record;
  const current = workflow.decisions.find((decision) => decision.current);
  return {
    ...base,
    waiting: workflow.waiting,
    approvers: workflow.approvers,
    approval: current ? decisionSummary(current) : null,
    approvals: workflow.decisions.map(decisionSummary),
    migratedFrom: workflow.data.migratedFrom ?? null,
  };
}

export function recordJsonFor(version: SchemaVersion, record: ItemRecord): Record<string, unknown> {
  return version === 3 ? recordJsonV3(record) : version === 2 ? recordJsonV2(record) : recordJson(record);
}

// ---- 判断記録 (approval list / show) ----------------------------------------------------------------------------------

export interface ApprovalEntry {
  task: TaskRecord & { workflow: WorkflowInfo };
  decision: DecisionInfo;
}

// v4 のタスクの判断記録。all でなければ open の記録だけ (確認待ちの一覧)
export function approvalEntries(datas: JobData[], all = false): ApprovalEntry[] {
  const entries: ApprovalEntry[] = [];
  for (const data of datas) {
    for (const { record } of data.tasks) {
      if (!isWorkflow(record) || record.kind !== "task" || record.workflow.version !== 4) continue;
      for (const decision of record.workflow.decisions) {
        if (all || decision.data?.status === "open") entries.push({ task: record as TaskRecord & { workflow: WorkflowInfo }, decision });
      }
    }
  }
  return entries.sort((a, b) => compareRecords(a.task, b.task) || compareText(a.decision.id, b.decision.id));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// 確認待ちの一覧・詳細の項目。taskRevision はタスクの --if-match、recordRevision は判断記録の --record-match
export function approvalJson(entry: ApprovalEntry, detail = false): Record<string, unknown> {
  const { task, decision } = entry;
  const data = decision.data ?? {};
  const value = (key: string) => (data[key] === undefined ? null : data[key]);
  const item: Record<string, unknown> = {
    job: task.job,
    task: task.id,
    taskName: task.name,
    taskTitle: task.title,
    taskStatus: task.status,
    taskPhase: task.workflow.phase,
    taskRequestedBy: task.requestedBy,
    taskRevision: task.revision,
    id: decision.id,
    phase: value("phase"),
    attempt: value("attempt"),
    status: value("status"),
    assignee: value("assignee"),
    requirementRevision: value("requirementRevision"),
    submission: value("submission"),
    submissionSeq: value("submissionSeq"),
    createdAt: value("createdAt"),
    origin: value("origin"),
    path: decision.path,
    recordRevision: decision.revision,
    current: decision.current,
    valid: decision.valid,
  };
  if (!detail) return item;
  return {
    ...item,
    decidedBy: value("decidedBy"),
    decidedAt: value("decidedAt"),
    decisionSeq: value("decisionSeq"),
    outcome: value("outcome"),
    returnTo: value("returnTo"),
    reason: value("reason"),
    reportRefs: value("reportRefs") ?? [],
    history: value("history") ?? [],
    rawMarkdown: decision.body,
  };
}

export interface ApprovalFilter {
  unassigned?: boolean;
  assignee?: string;
}

export function matchesApproval(entry: ApprovalEntry, filter: ApprovalFilter): boolean {
  const assignee = entry.decision.data?.assignee ?? null;
  if (filter.unassigned && assignee !== null) return false;
  if (filter.assignee !== undefined && assignee !== filter.assignee) return false;
  return true;
}

// 判断記録の診断 (このタスクの診断のうち、判断記録・確認待ちの索引・journal に関するもの)
export function approvalIssues(datas: JobData[], entries: ApprovalEntry[]): Issue[] {
  const names = new Set(entries.map((entry) => `${entry.task.job}/${entry.task.name}`));
  return datas.flatMap((data) =>
    data.issues
      .filter((owned) => owned.issue.code === "WF_JOURNAL_PENDING" || owned.issue.path.includes("/approvals/") || owned.issue.path.includes("/decisions/") || (owned.owner?.kind === "task" && names.has(`${data.job.name}/${owned.owner.name}`)))
      .map((owned) => owned.issue),
  );
}

export function approvalListJson(entries: ApprovalEntry[], shown: ApprovalEntry[], issues: Issue[]): Record<string, unknown> {
  const unassigned = entries.filter((entry) => (entry.decision.data?.assignee ?? null) === null).length;
  return {
    schemaVersion: 3,
    kind: "approval",
    items: shown.map((entry) => approvalJson(entry)),
    counts: { total: entries.length, shown: shown.length, unassigned, assigned: entries.length - unassigned },
    issues,
  };
}

export function jobJson(record: JobRecord): Record<string, unknown> {
  return { name: record.name, path: record.path, title: record.title, counts: record.counts };
}

export function issuesOf(datas: JobData[], kind?: Kind): Issue[] {
  return datas.flatMap((data) => data.issues.filter((owned) => kind === undefined || owned.issue.kind === kind).map((owned) => owned.issue));
}

export function itemsOf(data: JobData, kind: Kind): Collected[] {
  return kind === "task" ? data.tasks : data.qas;
}

export interface ListGroup {
  job: JobData;
  all: ItemRecord[];
  shown: ItemRecord[];
  issues: Issue[];
}

export function listGroups(kind: Kind, datas: JobData[], filter: ListFilter): ListGroup[] {
  return datas.map((data) => {
    const all = itemsOf(data, kind).map((entry) => entry.record).sort(compareRecords);
    return { job: data, all, shown: all.filter((record) => matchesFilter(record, filter)), issues: issuesOf([data], kind) };
  });
}

export function listJson(kind: Kind, groups: ListGroup[], extra: Issue[] = [], version: SchemaVersion = 1): Record<string, unknown> {
  const all = groups.flatMap((group) => group.all);
  const shown = groups.flatMap((group) => group.shown);
  assertCompatible(all, version);
  const counts = countRecords(kind, all);
  return {
    schemaVersion: version,
    kind,
    items: shown.map((record) => recordJsonFor(version, record)),
    counts: { total: counts.total, shown: shown.length, byStatus: counts.byStatus },
    issues: [...groups.flatMap((group) => group.issues), ...extra],
  };
}

// show の対象。ID が重複していれば選ばない。名前なら実体が一意に決まる
export function findItem(data: JobData, kind: Kind, selector: string): Collected {
  const label = kind === "task" ? "タスク" : "QA";
  const idPattern = kind === "task" ? /^T-\d{3,}$/ : /^Q-\d{3,}$/;
  const namePattern = /^[a-z0-9][a-z0-9-]*$/;
  if (!idPattern.test(selector) && !namePattern.test(selector)) throw new UsageError(`${label}のIDまたは名前の形式が不正です: ${selector}`);
  const items = itemsOf(data, kind);
  if (idPattern.test(selector)) {
    const matches = items.filter((entry) => entry.record.id === selector);
    if (matches.length === 0) throw new CliError(`${label}のIDが見つかりません: ${data.job.name} ${selector}`, 1, "NOT_FOUND");
    if (matches.length > 1) {
      throw new CliError(`${label}のIDが重複しているため特定できません: ${selector} (${matches.map((entry) => entry.record.path).join(", ")})`, 1, "AMBIGUOUS");
    }
    return matches[0];
  }
  const found = items.find((entry) => entry.record.name === selector);
  if (!found) throw new CliError(`${label}が見つかりません: jobs/${data.job.name}/${kind === "task" ? "tasks/" : "qa/"}${selector}`, 1, "NOT_FOUND");
  return found;
}

export function ownIssues(data: JobData, entry: Collected): Issue[] {
  return data.issues.filter((owned) => owned.owner?.kind === entry.record.kind && owned.owner.name === entry.record.name).map((owned) => owned.issue);
}

export function showJson(entry: Collected, issues: Issue[], version: SchemaVersion = 1): Record<string, unknown> {
  assertCompatible([entry.record], version);
  return { schemaVersion: version, kind: entry.record.kind, item: { ...recordJsonFor(version, entry.record), rawMarkdown: entry.text ?? null }, issues };
}

// TUI 用。絞り込み前の全状態を返す
export function snapshotJson(datas: JobData[], scope: string | null, extra: Issue[] = [], now = new Date(), version: SchemaVersion = 1): Record<string, unknown> {
  assertCompatible(datas.flatMap((data) => data.tasks.map((entry) => entry.record)), version);
  const records = (kind: Kind) => datas.flatMap((data) => itemsOf(data, kind).map((entry) => entry.record)).sort(compareRecords).map((record) => recordJsonFor(version, record));
  return {
    schemaVersion: version,
    generatedAt: now.toISOString(),
    scope: { job: scope },
    jobs: datas.map((data) => jobJson(data.record)),
    tasks: records("task"),
    qas: records("qa"),
    // schemaVersion 3 は確認待ちの一覧 (open の判断記録。approval list --json の items と同じ形) も返す
    ...(version === 3 ? { approvals: approvalEntries(datas).map((entry) => approvalJson(entry)) } : {}),
    issues: [...issuesOf(datas), ...extra],
  };
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function errorJson(code: string, message: string, version: SchemaVersion = 1): Record<string, unknown> {
  return { schemaVersion: version, error: { code, message } };
}
