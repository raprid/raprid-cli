// 工程型タスク (workflowVersion 2・3・4) のデータ形式と整合性の検証。
// v4 (AI 工程と人の判断記録) はこのファイルの末尾の「workflowVersion 4」の節。v2・v3 の規則 (validateWorkflow) は T-020 で変えていない。
// 採用仕様: jobs/project_template/tasks/task-review-status/02-workflow-design.md (T-011)、
//           v3 は jobs/project_template/tasks/task-types-and-common-phases/02-accepted-plan.md (T-017) の差分仕様
//
// 版の違い:
//   v2 (T-012 で合格した形式。契約を変えない) 工程は plan → implement → review → acceptance
//   v3 (新しいタスクの形式)  種別 type (research / implementation) が必須。工程は種別によらず共通の plan → execute → review → acceptance
//   v3 の規則は v2 と同じ (工程名が execute になり、type が増えただけ)。v3 に implement が混ざっていたら WF_PHASE_RENAMED で移行を案内する。
//   v2 のタスクを同じ版のまま execute に書き換えない (v2 → v3 の移行は T-016)。
//   種別・工程の状態・担当は独立で、研究 (research) でも独立レビューと人の受入確認を必須にする。
//   成果物 (artifactRefs) は資料のパスだけでもよい (research に repo/commit を一律には求めない)。
//
// タスク全体は open / closed、工程は plan → implement → review → acceptance の 4 つで、
// 各工程が waiting / ready / progress / pending / done の状態・担当・試行回数・入力版・成果物を持つ。
// 過去の試行と担当交代は history に追記する (消さない)。遷移の操作は T-013、CLI への接続は T-014 で扱う。
//
// 構造 (型・必須・列挙・書式) は schema/task-workflow-v2.schema.json と同じ規則で、
// 項目をまたぐ規則 (工程の順序・職務分離・入力版・前工程の完了との対応・移行の例外・履歴の参照) はここでだけ検証する。
//
// 入力の追跡: 各工程は、受け取った前工程の完了 (history の seq) を inputSeq に、対象にした要件の版を inputRevision に持つ。
// 完了した工程は、完了の履歴 (complete / decide / legacy_import) と担当・版・成果物が一致しなければならない。
// これで、実装のやり直しの後に古いレビュー承認を流用したり、要件の版を上げた後に古い計画を使ったりしたデータを拒否できる。

import { YamlFrontmatter } from "./yamlfront.ts";

export const workflowVersion = 2; // v2 の版。v3 は workflowVersionV3
export const workflowVersionV3 = 3;
export const phases = ["plan", "implement", "review", "acceptance"] as const; // v2 の工程
export const phasesV3 = ["plan", "execute", "review", "acceptance"] as const;
export const taskTypes = ["research", "implementation"] as const;
export const phaseStatuses = ["waiting", "ready", "progress", "pending", "done"] as const;
export const taskStatuses = ["open", "closed"] as const;
export const outcomes = ["completed", "approved", "changes_requested", "legacy_import"] as const;
export const closureReasons = ["accepted", "legacy_done"] as const;
export const historyEvents = ["create", "assign", "claim", "block", "resume", "complete", "decide", "reopen", "revise", "legacy_import"] as const;

export type Phase = (typeof phases)[number];
export type PhaseV3 = (typeof phasesV3)[number];
export type TaskType = (typeof taskTypes)[number];
export type PhaseStatus = (typeof phaseStatuses)[number];
export type Outcome = (typeof outcomes)[number];

export interface ArtifactRef {
  path?: string; // タスクのディレクトリからの相対パス (Markdown など)
  repo?: string; // repos/<名前>
  commit?: string;
}

export interface PhaseRecord {
  status: PhaseStatus;
  attempt: number;
  assignee: string | null;
  completedBy: string | null;
  completedAt: string | null;
  outcome: Outcome | null;
  inputRevision: number | null; // この工程の作業が対象にした requirementRevision
  inputSeq: number | null; // 受け取った前工程の完了の履歴 (seq)。plan と waiting の工程は空
  artifactRefs: ArtifactRef[];
}

export interface HistoryEntry {
  seq: number;
  at: string; // タイムゾーン付きの日時 (ISO 8601。新しく書くときは UTC)
  actor: string;
  event: (typeof historyEvents)[number];
  phase: Phase | null;
  attempt: number | null;
  inputRevision: number | null;
  outcome: Outcome | null;
  from: string | null;
  to: string | null;
  reason: string | null;
  refersTo: number | null; // 前の履歴の seq (差戻しの元のレビューなど)。後ろや自分は指せない
  refs: ArtifactRef[];
  sessionId?: string | null;
}

export interface TaskV2 {
  id: string;
  workflowVersion: 2;
  status: "open" | "closed";
  phase: Phase | null;
  requirementRevision: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  closureReason: (typeof closureReasons)[number] | null;
  requestedBy: string | null;
  createdBy: string | null;
  blockedBy: string[];
  relatedTasks: string[];
  workflow: Record<Phase, PhaseRecord>;
  history: HistoryEntry[];
  [key: string]: unknown; // 未知の項目 (test など) は保持する
}

// workflowVersion 3。工程は共通の 4 つ (execute)、種別 type を持つ。ほかの項目の意味は v2 と同じ
export interface HistoryEntryV3 extends Omit<HistoryEntry, "phase"> {
  phase: PhaseV3 | null;
}

// 項目はすべて明示する。TaskV2 は未知の項目のための [key: string]: unknown を持つので、Omit<TaskV2, …> から作ると
// 明示した項目の必須性と型が失われる (R18-1)。v2 と共通の項目の型が同じことは workflow-v3-types.test.ts で確かめる
export interface TaskV3 {
  id: string;
  workflowVersion: 3;
  type: TaskType;
  status: "open" | "closed";
  phase: PhaseV3 | null;
  requirementRevision: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  closureReason: (typeof closureReasons)[number] | null;
  requestedBy: string | null;
  createdBy: string | null;
  blockedBy: string[];
  relatedTasks: string[];
  workflow: Record<PhaseV3, PhaseRecord>;
  history: HistoryEntryV3[];
  [key: string]: unknown; // 未知の項目 (test など) は保持する
}

export type TaskFormat = { kind: "legacy" } | { kind: "v2" } | { kind: "v3" } | { kind: "v4" } | { kind: "unsupported"; version: unknown };

// workflowVersion が無ければ旧形式 (status: todo/pending/progress/done)。2・3・4 以外の版 (文字列の "3" を含む) は扱わない
export function detectFormat(data: Record<string, unknown>): TaskFormat {
  if (!("workflowVersion" in data) || data.workflowVersion === null || data.workflowVersion === undefined) return { kind: "legacy" };
  if (data.workflowVersion === workflowVersion) return { kind: "v2" };
  if (data.workflowVersion === workflowVersionV3) return { kind: "v3" };
  if (data.workflowVersion === workflowVersionV4) return { kind: "v4" };
  return { kind: "unsupported", version: data.workflowVersion };
}

export interface WorkflowIssue {
  code: string;
  path: string; // 対象の項目 (例: workflow.review.completedBy、history[2].refersTo)
  message: string;
}

export const actorPattern = /^(human|agent)\/[a-z0-9][a-z0-9._-]*$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const dateTimePattern = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const idPattern = /^T-\d{3,}$/;
const taskRefPattern = /^task\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)?T-\d{3,}$/;
const repoPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const commitPattern = /^[0-9a-f]{7,40}$/;
const sessionPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// タイムゾーン付きの日時。比べるときは文字列ではなく時刻 (Date.parse) で比べる
export function isValidDateTime(value: string): boolean {
  const match = dateTimePattern.exec(value);
  return match !== null && isValidDate(match[1]) && !Number.isNaN(Date.parse(value));
}

function isValidDate(value: string): boolean {
  if (!datePattern.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

// タスクのディレクトリの中を指す相対パス (絶対パス・..・空の要素を拒否)
export function isSafeRelativePath(value: string): boolean {
  if (value === "" || value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:/.test(value)) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export class Checker {
  readonly issues: WorkflowIssue[] = [];

  add(code: string, path: string, message: string): void {
    this.issues.push({ code, path, message });
  }

  object(value: unknown, path: string): value is Record<string, unknown> {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return true;
    this.add("WF_TYPE", path, `${path} は key: 値 の形 (オブジェクト) にしてください`);
    return false;
  }

  required(object: Record<string, unknown>, key: string, path: string): boolean {
    if (key in object) return true;
    this.add("WF_FIELD_MISSING", path ? `${path}.${key}` : key, `${path ? `${path}.` : ""}${key} がありません`);
    return false;
  }

  enumValue(value: unknown, allowed: readonly string[], path: string, nullable = false): boolean {
    if (nullable && value === null) return true;
    if (typeof value === "string" && allowed.includes(value)) return true;
    this.add("WF_ENUM", path, `${path} は ${allowed.join(" / ")}${nullable ? " か空" : ""} のいずれかです: ${JSON.stringify(value)}`);
    return false;
  }

  integer(value: unknown, path: string, min: number, nullable = false): boolean {
    if (nullable && value === null) return true;
    if (typeof value === "number" && Number.isInteger(value) && value >= min) return true;
    this.add("WF_TYPE", path, `${path} は ${min} 以上の整数${nullable ? "か空" : ""}にしてください: ${JSON.stringify(value)}`);
    return false;
  }

  actor(value: unknown, path: string, nullable = true): boolean {
    if (nullable && value === null) return true;
    if (typeof value === "string" && actorPattern.test(value)) return true;
    this.add("WF_ACTOR", path, `${path} は human/<識別子> か agent/<識別子>${nullable ? " か空" : ""}にしてください: ${JSON.stringify(value)}`);
    return false;
  }

  dateTime(value: unknown, path: string): boolean {
    if (typeof value === "string" && isValidDateTime(value)) return true;
    this.add("WF_DATETIME", path, `${path} はタイムゾーン付きの日時 (例: 2026-09-28T06:12:00Z) にしてください: ${JSON.stringify(value)}`);
    return false;
  }

  date(value: unknown, path: string, nullable = false): boolean {
    if (nullable && value === null) return true;
    if (typeof value === "string" && isValidDate(value)) return true;
    this.add("WF_DATE", path, `${path} は YYYY-MM-DD の日付${nullable ? "か空" : ""}にしてください: ${JSON.stringify(value)}`);
    return false;
  }

  stringList(value: unknown, path: string, pattern?: RegExp): value is string[] {
    if (!Array.isArray(value)) {
      this.add("WF_TYPE", path, `${path} は配列 ([] か「- 値」の並び) にしてください`);
      return false;
    }
    value.forEach((item, index) => {
      if (typeof item !== "string" || item.trim() === "" || /[\r\n]/.test(item)) this.add("WF_TYPE", `${path}[${index}]`, `${path}[${index}] は空でない 1 行の文字列にしてください`);
      else if (pattern && !pattern.test(item)) this.add("WF_REF", `${path}[${index}]`, `${path}[${index}] の参照の形が不正です: ${item}`);
    });
    return true;
  }

  refs(value: unknown, path: string): value is ArtifactRef[] {
    if (!Array.isArray(value)) {
      this.add("WF_TYPE", path, `${path} は配列にしてください`);
      return false;
    }
    value.forEach((item, index) => {
      const at = `${path}[${index}]`;
      if (!this.object(item, at)) return;
      const unknown = Object.keys(item).filter((key) => !["path", "repo", "commit"].includes(key));
      if (unknown.length > 0) this.add("WF_FIELD_UNKNOWN", at, `${at} に使えない項目があります: ${unknown.join(", ")}`);
      if (item.path === undefined && item.commit === undefined) this.add("WF_REF", at, `${at} には path か commit が必要です`);
      if (item.path !== undefined && (typeof item.path !== "string" || !isSafeRelativePath(item.path))) {
        this.add("WF_REF", `${at}.path`, `${at}.path はタスクのディレクトリからの相対パス (.. や絶対パスは不可) にしてください: ${JSON.stringify(item.path)}`);
      }
      if (item.commit !== undefined && (typeof item.commit !== "string" || !commitPattern.test(item.commit))) {
        this.add("WF_REF", `${at}.commit`, `${at}.commit は 7〜40 桁の小文字 16 進数にしてください: ${JSON.stringify(item.commit)}`);
      }
      if (item.commit !== undefined && item.repo === undefined) this.add("WF_REF", `${at}.repo`, `${at} の commit にはどの repo か (repo) が必要です`);
      if (item.repo !== undefined && (typeof item.repo !== "string" || !repoPattern.test(item.repo))) this.add("WF_REF", `${at}.repo`, `${at}.repo の名前が不正です: ${JSON.stringify(item.repo)}`);
    });
    return true;
  }
}

const phaseKeys = ["status", "attempt", "assignee", "completedBy", "completedAt", "outcome", "inputRevision", "inputSeq", "artifactRefs"];
const historyKeys = ["seq", "at", "actor", "event", "phase", "attempt", "inputRevision", "outcome", "from", "to", "reason", "refersTo", "refs"];
const topKeys = ["id", "workflowVersion", "status", "phase", "requirementRevision", "createdAt", "updatedAt", "completedAt", "closureReason", "requestedBy", "createdBy", "blockedBy", "relatedTasks", "workflow", "history"];

// 版ごとの違い。v2 と v3 は工程の名前 (implement / execute) と種別 (type) の有無だけが違い、ほかの規則は同じ
interface WorkflowSpec {
  version: 2 | 3;
  phases: readonly string[];
  work: readonly string[]; // 完了 (complete) で終わる工程。ほかは判定 (decide) で終わる
  execute: string; // 成果物を作る工程 (職務分離でレビューと別の actor にする)
  topKeys: readonly string[];
  typed: boolean; // type (research / implementation) が必須か
  renamed?: { from: string; to: string }; // 前の版の工程名 (v3 の implement)。混ざっていたら移行の案内を出す
}

const specV2: WorkflowSpec = { version: 2, phases, work: ["plan", "implement"], execute: "implement", topKeys, typed: false };
const specV3: WorkflowSpec = {
  version: 3,
  phases: phasesV3,
  work: ["plan", "execute"],
  execute: "execute",
  topKeys: [...topKeys.slice(0, 2), "type", ...topKeys.slice(2)],
  typed: true,
  renamed: { from: "implement", to: "execute" },
};

// 工程型タスク (workflowVersion 2) を検証する。T-012 で合格した契約で、v3 を追加しても変えない
export function validateTaskV2(data: unknown): WorkflowIssue[] {
  return validateWorkflow(data, specV2);
}

// 種別と共通工程を持つタスク (workflowVersion 3) を検証する
export function validateTaskV3(data: unknown): WorkflowIssue[] {
  return validateWorkflow(data, specV3);
}

function validateWorkflow(data: unknown, spec: WorkflowSpec): WorkflowIssue[] {
  const check = new Checker();
  if (!check.object(data, "frontmatter")) return check.issues;
  const format = detectFormat(data);
  if (format.kind !== `v${spec.version}`) {
    const found = format.kind === "legacy" ? "workflowVersion がありません (旧形式のタスクです)" : format.kind === "unsupported" ? `対応していない workflowVersion です: ${JSON.stringify(format.version)}` : `workflowVersion ${format.kind.slice(1)} のタスクです`;
    check.add("WF_VERSION", "workflowVersion", `${found} (workflowVersion ${spec.version} として検証しました)`);
    return check.issues;
  }
  // 工程が完了したときに取りうる結果。changes_requested は工程を差し戻した履歴にだけ現れる
  const doneOutcomes = (phase: string): readonly Outcome[] => (spec.work.includes(phase) ? ["completed", "legacy_import"] : ["approved", "legacy_import"]);
  // 工程の名前。前の版の名前 (v3 の implement) は、種別の別名としても工程名としても受け付けず、移行を案内する
  const phaseValue = (value: unknown, path: string, nullable: boolean): boolean => {
    if (spec.renamed && value === spec.renamed.from) {
      check.add("WF_PHASE_RENAMED", path, `workflowVersion ${spec.version} の工程は ${spec.renamed.to} です (${spec.renamed.from} は workflowVersion 2 の名前。v2 のタスクは移行してから使う)`);
      return false;
    }
    return check.enumValue(value, spec.phases, path, nullable);
  };
  const present = spec.topKeys.filter((key) => check.required(data, key, ""));
  const has = (key: string) => present.includes(key);

  if (has("id") && (typeof data.id !== "string" || !idPattern.test(data.id))) check.add("WF_TYPE", "id", `id は T-001 の形にしてください: ${JSON.stringify(data.id)}`);
  const statusOk = has("status") && check.enumValue(data.status, taskStatuses, "status");
  if (spec.typed && has("type") && !(typeof data.type === "string" && (taskTypes as readonly string[]).includes(data.type))) {
    check.add("WF_ENUM", "type", `type は ${taskTypes.join(" / ")} のいずれかです (search・implement などの別名や未知の種別は受け付けません): ${JSON.stringify(data.type)}`);
  }
  const phaseOk = has("phase") && phaseValue(data.phase, "phase", true);
  const revisionOk = has("requirementRevision") && check.integer(data.requirementRevision, "requirementRevision", 1);
  if (has("createdAt")) check.date(data.createdAt, "createdAt");
  if (has("updatedAt")) check.date(data.updatedAt, "updatedAt");
  if (has("completedAt")) check.date(data.completedAt, "completedAt", true);
  const closureOk = has("closureReason") && check.enumValue(data.closureReason, closureReasons, "closureReason", true);
  if (has("requestedBy")) check.actor(data.requestedBy, "requestedBy");
  if (has("createdBy")) check.actor(data.createdBy, "createdBy");
  const blockedOk = has("blockedBy") && check.stringList(data.blockedBy, "blockedBy");
  if (has("relatedTasks")) check.stringList(data.relatedTasks, "relatedTasks", taskRefPattern);

  // 工程
  const records: Partial<Record<string, PhaseRecord>> = {};
  if (has("workflow") && check.object(data.workflow, "workflow")) {
    const workflow = data.workflow;
    const extra = Object.keys(workflow).filter((key) => !spec.phases.includes(key));
    for (const key of extra.filter((key) => key === spec.renamed?.from)) phaseValue(key, `workflow.${key}`, false);
    const unknown = extra.filter((key) => key !== spec.renamed?.from);
    if (unknown.length > 0) check.add("WF_FIELD_UNKNOWN", "workflow", `workflow に使えない工程があります: ${unknown.join(", ")} (工程は ${spec.phases.join(" / ")})`);
    for (const phase of spec.phases) {
      const path = `workflow.${phase}`;
      if (!check.required(workflow, phase, "workflow")) continue;
      const record = workflow[phase];
      if (!check.object(record, path)) continue;
      const ok = phaseKeys.map((key) => check.required(record, key, path)).every(Boolean);
      if (!ok) continue;
      const fine = [
        check.enumValue(record.status, phaseStatuses, `${path}.status`),
        check.integer(record.attempt, `${path}.attempt`, 1),
        check.actor(record.assignee, `${path}.assignee`),
        check.actor(record.completedBy, `${path}.completedBy`),
        check.date(record.completedAt, `${path}.completedAt`, true),
        check.enumValue(record.outcome, outcomes, `${path}.outcome`, true),
        check.integer(record.inputRevision, `${path}.inputRevision`, 1, true),
        check.integer(record.inputSeq, `${path}.inputSeq`, 1, true),
        check.refs(record.artifactRefs, `${path}.artifactRefs`),
      ].every(Boolean);
      if (fine) records[phase] = record as unknown as PhaseRecord;
    }
  }

  // 履歴
  const history: HistoryEntry[] = [];
  if (has("history")) {
    if (!Array.isArray(data.history)) check.add("WF_TYPE", "history", "history は配列にしてください");
    else {
      data.history.forEach((entry, index) => {
        const path = `history[${index}]`;
        if (!check.object(entry, path)) return;
        if (!historyKeys.map((key) => check.required(entry, key, path)).every(Boolean)) return;
        const fine = [
          check.integer(entry.seq, `${path}.seq`, 1),
          check.dateTime(entry.at, `${path}.at`),
          check.actor(entry.actor, `${path}.actor`, false),
          check.enumValue(entry.event, historyEvents, `${path}.event`),
          phaseValue(entry.phase, `${path}.phase`, true),
          check.integer(entry.attempt, `${path}.attempt`, 1, true),
          check.integer(entry.inputRevision, `${path}.inputRevision`, 1, true),
          check.enumValue(entry.outcome, outcomes, `${path}.outcome`, true),
          check.integer(entry.refersTo, `${path}.refersTo`, 1, true),
          check.refs(entry.refs, `${path}.refs`),
        ].every(Boolean);
        for (const key of ["from", "to", "reason"]) {
          const value = entry[key];
          if (value !== null && (typeof value !== "string" || /[\r\n]/.test(value))) check.add("WF_TYPE", `${path}.${key}`, `${path}.${key} は 1 行の文字列か空にしてください`);
        }
        if ("sessionId" in entry && entry.sessionId !== null && (typeof entry.sessionId !== "string" || !sessionPattern.test(entry.sessionId))) {
          check.add("WF_TYPE", `${path}.sessionId`, `${path}.sessionId の形が不正です`);
        }
        if (fine) history.push(entry as unknown as HistoryEntry);
      });
    }
  }

  // ここから項目をまたぐ規則。構造が壊れている項目は上で報告済みなので、読めた範囲だけを確かめる
  const allPhases = spec.phases.every((phase) => records[phase] !== undefined);
  const revision = revisionOk ? (data.requirementRevision as number) : undefined;
  if (allPhases && statusOk && phaseOk) {
    const status = data.status as string;
    const current = data.phase as string | null;
    if (status === "open") {
      if (current === null) check.add("WF_OPEN_PHASE", "phase", "open のタスクには現在の工程 (phase) が必要です");
      else {
        const index = spec.phases.indexOf(current);
        spec.phases.forEach((phase, position) => {
          const record = records[phase]!;
          const path = `workflow.${phase}.status`;
          if (position < index && record.status !== "done") check.add("WF_ORDER", path, `現在の工程 ${current} より前の ${phase} が done ではありません (${record.status})`);
          if (position === index && !["ready", "progress", "pending"].includes(record.status)) {
            check.add("WF_ORDER", path, `現在の工程 ${current} は ready / progress / pending のいずれかです (${record.status})`);
          }
          if (position > index && record.status !== "waiting") check.add("WF_ORDER", path, `現在の工程 ${current} より後の ${phase} は waiting です (${record.status})`);
        });
        if (blockedOk) {
          const pending = records[current]!.status === "pending";
          const blocked = (data.blockedBy as string[]).length > 0;
          if (pending && !blocked) check.add("WF_BLOCKED", "blockedBy", `工程 ${current} が pending なのに blockedBy が空です`);
          if (!pending && blocked) check.add("WF_BLOCKED", "blockedBy", `工程 ${current} が pending ではないのに blockedBy があります`);
        }
      }
      if (data.completedAt !== null && has("completedAt")) check.add("WF_CLOSED", "completedAt", "open のタスクには completedAt を書きません");
      if (closureOk && data.closureReason !== null) check.add("WF_CLOSED", "closureReason", "open のタスクには closureReason を書きません");
    } else {
      if (current !== null) check.add("WF_CLOSED", "phase", "closed のタスクの phase は空にします");
      if (has("completedAt") && data.completedAt === null) check.add("WF_CLOSED", "completedAt", "closed のタスクには閉じた日 (completedAt) が必要です");
      if (blockedOk && (data.blockedBy as string[]).length > 0) check.add("WF_BLOCKED", "blockedBy", "closed のタスクに blockedBy は書きません");
      if (closureOk && data.closureReason === null) check.add("WF_CLOSED", "closureReason", "closed のタスクには閉じた理由 (accepted / legacy_done) が必要です");
      for (const phase of spec.phases) {
        if (records[phase]!.status !== "done") check.add("WF_CLOSED", `workflow.${phase}.status`, `closed のタスクの工程はすべて done です (${phase}: ${records[phase]!.status})`);
      }
      if (closureOk && data.closureReason === "accepted") {
        const acceptance = records.acceptance!;
        if (acceptance.outcome !== "approved") check.add("WF_CLOSED", "workflow.acceptance.outcome", "accepted で閉じるには受入確認 (acceptance) の結果が approved である必要があります");
      }
      if (closureOk && data.closureReason === "legacy_done") {
        // 旧 done の移行では承認を捏造しない
        for (const phase of spec.phases) {
          if (records[phase]!.outcome !== "legacy_import") check.add("WF_LEGACY", `workflow.${phase}.outcome`, `legacy_done で閉じたタスクの工程の結果は legacy_import です (${phase}: ${records[phase]!.outcome})`);
        }
      }
    }
  }

  // 完了の履歴: 工程と試行が同じで、結果に合った出来事 (plan / implement は complete、review / acceptance は decide、移行は legacy_import)
  const completionOf = (phase: string, record: PhaseRecord): HistoryEntry | undefined => {
    const event = record.outcome === "legacy_import" ? "legacy_import" : spec.work.includes(phase) ? "complete" : "decide";
    return history.filter((entry) => entry.phase === phase && entry.attempt === record.attempt && entry.event === event && entry.outcome === record.outcome).at(-1);
  };
  const sameRefs = (a: ArtifactRef[], b: ArtifactRef[]) =>
    a.length === b.length && a.every((ref, index) => ref.path === b[index].path && ref.repo === b[index].repo && ref.commit === b[index].commit);

  // 工程ごとの記録の整合
  for (const phase of spec.phases) {
    const record = records[phase];
    if (!record) continue;
    const path = `workflow.${phase}`;
    const legacy = record.outcome === "legacy_import";
    if (record.status === "done") {
      // 旧形式から移した工程 (legacy_import) は、誰がいつ完了したか分からないので空のままにできる
      if (!legacy) {
        if (record.completedBy === null) check.add("WF_DONE", `${path}.completedBy`, `done の工程 ${phase} には完了した人 (completedBy) が必要です`);
        if (record.completedAt === null) check.add("WF_DONE", `${path}.completedAt`, `done の工程 ${phase} には完了日 (completedAt) が必要です`);
        if (record.inputRevision === null) check.add("WF_DONE", `${path}.inputRevision`, `done の工程 ${phase} には対象にした要件の版 (inputRevision) が必要です`);
        if (record.artifactRefs.length === 0) check.add("WF_DONE", `${path}.artifactRefs`, `done の工程 ${phase} には成果物・引継資料 (artifactRefs) が必要です`);
      }
      if (record.outcome === null || !doneOutcomes(phase).includes(record.outcome)) {
        check.add("WF_OUTCOME", `${path}.outcome`, `done の工程 ${phase} の結果は ${doneOutcomes(phase).join(" / ")} のいずれかです (${record.outcome ?? "空"})`);
      } else if (history.length > 0) {
        const completion = completionOf(phase, record);
        if (!completion) {
          if (legacy) check.add("WF_LEGACY", `${path}.outcome`, `${phase} の legacy_import に対応する移行の記録 (history の legacy_import、試行 ${record.attempt}) がありません`);
          else check.add("WF_COMPLETION", `${path}.status`, `done の工程 ${phase} (試行 ${record.attempt}) に対応する完了の履歴がありません`);
        } else if (!legacy) {
          if (completion.actor !== record.completedBy) check.add("WF_COMPLETION", `${path}.completedBy`, `${phase} の completedBy (${record.completedBy}) が完了の履歴 seq ${completion.seq} の actor (${completion.actor}) と違います`);
          if (completion.inputRevision !== record.inputRevision) check.add("WF_COMPLETION", `${path}.inputRevision`, `${phase} の inputRevision (${record.inputRevision}) が完了の履歴 seq ${completion.seq} の版 (${completion.inputRevision}) と違います`);
          if (!sameRefs(completion.refs, record.artifactRefs)) check.add("WF_COMPLETION", `${path}.artifactRefs`, `${phase} の成果物が完了の履歴 seq ${completion.seq} の記録と違います (完了の後に成果物を差し替えるときは新しい試行にする)`);
        }
      }
    } else {
      for (const key of ["completedBy", "completedAt", "outcome"] as const) {
        if (record[key] !== null) check.add("WF_DONE", `${path}.${key}`, `${record.status} の工程 ${phase} には ${key} を書きません (前の結果は history に残す)`);
      }
      if (record.status === "waiting") {
        if (record.inputRevision !== null) check.add("WF_DONE", `${path}.inputRevision`, `waiting の工程 ${phase} には inputRevision を書きません`);
        if (record.inputSeq !== null) check.add("WF_INPUT", `${path}.inputSeq`, `waiting の工程 ${phase} には inputSeq を書きません`);
      } else if (record.inputRevision === null) {
        check.add("WF_DONE", `${path}.inputRevision`, `${record.status} の工程 ${phase} には対象にする要件の版 (inputRevision) が必要です`);
      }
      if ((record.status === "progress" || record.status === "pending") && record.assignee === null) {
        check.add("WF_ASSIGNEE", `${path}.assignee`, `${record.status} の工程 ${phase} には担当 (assignee) が必要です`);
      }
    }
    // 作業中・完了した工程は、今の要件の版に対するものだけ (版を上げたら計画からやり直す)。移行した工程は版を持たない
    if (revision !== undefined && record.status !== "waiting" && !legacy && record.inputRevision !== null && record.inputRevision !== revision) {
      check.add("WF_STALE", `${path}.inputRevision`, `${phase} の inputRevision (${record.inputRevision}) が今の要件の版 (${revision}) と違います`);
    }
  }
  // 前工程の入力: 作業中・完了した工程は、前工程の今の試行の完了を受け取っていなければならない
  spec.phases.forEach((phase, index) => {
    const record = records[phase];
    if (!record || record.status === "waiting") return;
    const path = `workflow.${phase}.inputSeq`;
    if (index === 0) {
      if (record.inputSeq !== null) check.add("WF_INPUT", path, "plan は前工程が無いので inputSeq を書きません");
      return;
    }
    const previous = spec.phases[index - 1];
    const before = records[previous];
    if (!before || before.status !== "done" || before.outcome === null || history.length === 0) return; // 順序の誤りとして報告済み
    const completion = completionOf(previous, before);
    if (!completion) return; // 完了の履歴が無いことは報告済み
    if (record.inputSeq !== completion.seq) {
      check.add("WF_INPUT", path, `${phase} は前工程 ${previous} の今の試行 ${before.attempt} の完了 (seq ${completion.seq}) を受け取っていません (inputSeq: ${record.inputSeq ?? "空"})`);
    }
  });
  // 職務分離: 成果物を作る工程 (v2 は implement、v3 は execute) を完了した人は、同じ成果物をレビューできない。受入確認は人だけ
  const execute = records[spec.execute];
  const review = records.review;
  if (execute && review && review.status === "done" && review.outcome === "approved" && execute.completedBy !== null && execute.completedBy === review.completedBy) {
    const message = spec.version === 2 ? `実装を完了した ${execute.completedBy} が同じ実装をレビューしています` : `実行 (execute) を完了した ${execute.completedBy} が同じ成果物をレビューしています`;
    check.add("WF_SEPARATION", "workflow.review.completedBy", message);
  }
  const acceptance = records.acceptance;
  if (acceptance) {
    if (acceptance.assignee !== null && !acceptance.assignee.startsWith("human/")) check.add("WF_HUMAN", "workflow.acceptance.assignee", `受入確認の担当は人 (human/…) です: ${acceptance.assignee}`);
    if (acceptance.completedBy !== null && !acceptance.completedBy.startsWith("human/")) check.add("WF_HUMAN", "workflow.acceptance.completedBy", `受入確認を完了できるのは人 (human/…) です: ${acceptance.completedBy}`);
  }

  // 履歴: seq は 1 から増え続け、refersTo は前の履歴だけを指す (循環しない)。日時と試行回数は戻らない
  const eventPhases: Partial<Record<string, readonly (string | null)[]>> = { complete: spec.work, decide: ["review", "acceptance"], revise: [null] };
  let migrating = history.length > 0 && history[0].event === "legacy_import";
  history.forEach((entry, index) => {
    const path = `history[${index}]`;
    if (entry.seq !== index + 1) check.add("WF_HISTORY_ORDER", `${path}.seq`, `history の seq は 1 から順に並べます (${index + 1} の位置に ${entry.seq})`);
    if (entry.refersTo !== null && entry.refersTo >= entry.seq) check.add("WF_HISTORY_REF", `${path}.refersTo`, `history の refersTo は前の履歴 (seq ${entry.seq} より小さい) だけを指せます: ${entry.refersTo}`);
    if (entry.refersTo !== null && !history.some((other) => other.seq === entry.refersTo)) check.add("WF_HISTORY_REF", `${path}.refersTo`, `history の refersTo が存在しない履歴を指しています: ${entry.refersTo}`);
    if (index > 0 && Date.parse(entry.at) < Date.parse(history[index - 1].at)) check.add("WF_HISTORY_ORDER", `${path}.at`, `history の日時が前の履歴より前になっています (${entry.at})`);
    const allowed = eventPhases[entry.event];
    if (allowed && !allowed.includes(entry.phase)) check.add("WF_HISTORY_EVENT", `${path}.event`, `${entry.event} は ${allowed.map((phase) => phase ?? "工程なし").join(" / ")} の出来事です (${entry.phase ?? "工程なし"})`);
    // 移行の記録 (legacy_import) は、移行した時に履歴の先頭へまとめて書く。通常のタスクの途中には現れない
    if (entry.event === "legacy_import") {
      if (!migrating) check.add("WF_LEGACY", `${path}.event`, "legacy_import は移行した時の記録として履歴の先頭にだけ書けます (通常の操作では使えない)");
      if (entry.phase === null || entry.outcome !== "legacy_import") check.add("WF_LEGACY", path, "legacy_import の履歴には移した工程 (phase) と結果 legacy_import が必要です");
    } else {
      migrating = false;
    }
    if (entry.outcome === "legacy_import" && entry.event !== "legacy_import") check.add("WF_LEGACY", `${path}.outcome`, `結果 legacy_import は移行の記録 (event: legacy_import) にだけ使えます (${entry.event})`);
    if (entry.phase !== null && entry.attempt !== null) {
      const record = records[entry.phase];
      if (record && entry.attempt > record.attempt) check.add("WF_HISTORY_ATTEMPT", `${path}.attempt`, `history の ${entry.phase} の試行 ${entry.attempt} が現在の試行 ${record.attempt} より大きい`);
      const earlier = history.slice(0, index).filter((other) => other.phase === entry.phase && other.attempt !== null);
      if (earlier.length > 0 && entry.attempt < earlier[earlier.length - 1].attempt!) {
        check.add("WF_HISTORY_ATTEMPT", `${path}.attempt`, `history の ${entry.phase} の試行回数が戻っています (${earlier[earlier.length - 1].attempt} の後に ${entry.attempt})`);
      }
    }
    if (revision !== undefined && entry.inputRevision !== null && entry.inputRevision > revision) {
      check.add("WF_STALE", `${path}.inputRevision`, `history の inputRevision (${entry.inputRevision}) が requirementRevision (${revision}) より新しい`);
    }
  });
  for (const phase of spec.phases) {
    const record = records[phase];
    if (record && record.inputSeq !== null && !history.some((entry) => entry.seq === record.inputSeq)) {
      check.add("WF_INPUT", `workflow.${phase}.inputSeq`, `${phase} の inputSeq が存在しない履歴を指しています: ${record.inputSeq}`);
    }
  }
  if (has("history") && Array.isArray(data.history) && data.history.length === 0) check.add("WF_HISTORY_ORDER", "history", "history には作成 (create) か移行 (legacy_import) の記録が 1 件以上必要です");
  if (history.length > 0 && history[0].event !== "create" && history[0].event !== "legacy_import") {
    check.add("WF_HISTORY_ORDER", "history[0].event", `history の最初は create か legacy_import です (${history[0].event})`);
  }
  return check.issues;
}

// 新しいタスクの初期値。計画が ready、後続は waiting、全体は open
export function initialTaskV2(fields: { id: string; date: string; at?: string; requestedBy: string; createdBy: string }): TaskV2 {
  const phase = (status: PhaseStatus): PhaseRecord => ({ status, attempt: 1, assignee: null, completedBy: null, completedAt: null, outcome: null, inputRevision: status === "waiting" ? null : 1, inputSeq: null, artifactRefs: [] });
  return {
    id: fields.id,
    workflowVersion: 2,
    status: "open",
    phase: "plan",
    requirementRevision: 1,
    createdAt: fields.date,
    updatedAt: fields.date,
    completedAt: null,
    closureReason: null,
    requestedBy: fields.requestedBy,
    createdBy: fields.createdBy,
    blockedBy: [],
    relatedTasks: [],
    workflow: { plan: phase("ready"), implement: phase("waiting"), review: phase("waiting"), acceptance: phase("waiting") },
    history: [
      { seq: 1, at: fields.at ?? new Date().toISOString(), actor: fields.createdBy, event: "create", phase: "plan", attempt: 1, inputRevision: 1, outcome: null, from: null, to: "ready", reason: null, refersTo: null, refs: [] },
    ],
  };
}

// 新しいタスク (workflowVersion 3) の初期値。種別は必須で、計画が ready、後続は waiting、全体は open
export function initialTaskV3(fields: { id: string; type: TaskType; date: string; at?: string; requestedBy: string; createdBy: string }): TaskV3 {
  if (!(taskTypes as readonly string[]).includes(fields.type)) {
    throw new TypeError(`種別 (type) は ${taskTypes.join(" / ")} のいずれかを指定してください: ${JSON.stringify(fields.type)}`);
  }
  // 工程名以外は v2 の初期値と同じ (作成の履歴は plan なので工程名の違いは無い)
  const v2 = initialTaskV2(fields);
  return {
    id: v2.id,
    workflowVersion: 3,
    type: fields.type,
    status: "open",
    phase: "plan",
    requirementRevision: v2.requirementRevision,
    createdAt: v2.createdAt,
    updatedAt: v2.updatedAt,
    completedAt: null,
    closureReason: null,
    requestedBy: v2.requestedBy,
    createdBy: v2.createdBy,
    blockedBy: [],
    relatedTasks: [],
    workflow: { plan: v2.workflow.plan, execute: v2.workflow.implement, review: v2.workflow.review, acceptance: v2.workflow.acceptance },
    history: [{ ...v2.history[0], phase: "plan" }],
  };
}

// index.md を読み、形式を見分けて検証する。旧形式は検証せずに legacy として返す。
// 対応していない版は WF_VERSION の診断を返す (v2 の規則で読み替えない)。v4 は判断記録との照合を含まない (lib/decision.ts の checkTaskDecisions)
export function readTaskFile(text: string, source = "index.md"): { format: TaskFormat; frontmatter: YamlFrontmatter; issues: WorkflowIssue[] } {
  const frontmatter = YamlFrontmatter.parse(text, source);
  const data = frontmatter.data();
  const format = detectFormat(data);
  const issues = format.kind === "legacy" ? [] : format.kind === "v4" ? validateTaskV4(data) : format.kind === "v3" ? validateTaskV3(data) : validateTaskV2(data);
  return { format, frontmatter, issues };
}

// =====================================================================================================================
// workflowVersion 4: AI 工程 (plan → execute → review) と人の判断記録を別の軸に持つタスク。T-020
// 契約: jobs/project_template/tasks/workflow-v4-contract/03-contract.md (1 タスクの形、2 版と試行、3 人の確認待ち、4 判断記録、7 整合性) と
//       04-migration-compat.md (v3 からの変換)。判断記録そのものとタスクとの照合は lib/decision.ts。
//
// v3 との違い:
//   工程は plan → execute → review の 3 つ。受入確認 (acceptance) は工程ではなく、人の判断記録 (decisions/<工程>-<試行>.md) に記録する
//   タスクの状態は open / pending / closed。pending = 人の確認待ち (plan・review の提出の後)。工程の pending は外部の待ちだけで、同時には成り立たない
//   plan・review の記録に approval (この試行の判断記録の ID / legacy_unverified / null) を足す。execute には無い
//   工程の結果は completed / legacy_import だけ (人の判断は判断記録の outcome)。closureReason は approved / legacy_done
//   history の出来事に send_back・approve・reject・supersede・migrate を足し、decide は使わない (migrate より前の移行元の記録にだけ残る)
//   approvers (判断記録を作るときの初期の担当)・migratedFrom (v4 に写せない移行元の記録) は任意
//
// 移行元の記録: 最後の migrate より前の履歴には v4 の出来事の規則を当てず、構造 (seq・日時・actor・参照) と、
// 提出・判断に使う記録の形 (v3 の complete / review の decide approved / 受入確認の decide approved) だけを確かめる。
// legacy_unverified (人が確かめていない承認) は、移行より前に完了した工程と legacy_import の工程にだけ書ける。

export const workflowVersionV4 = 4;
export const phasesV4 = ["plan", "execute", "review"] as const;
export const approvalPhases = ["plan", "review"] as const; // 判断記録を持つ工程
export const taskStatusesV4 = ["open", "pending", "closed"] as const;
export const outcomesV4 = ["completed", "legacy_import"] as const;
export const closureReasonsV4 = ["approved", "legacy_done"] as const;
export const historyEventsV4 = ["create", "assign", "claim", "block", "resume", "complete", "send_back", "approve", "reject", "revise", "reopen", "supersede", "migrate", "legacy_import"] as const;
// 最後の migrate より前の移行元 (v2・v3) の履歴にだけ現れる値
export const importedHistoryEvents = ["decide"] as const;
export const importedPhases = ["implement", "acceptance"] as const;
export const importedOutcomes = ["approved", "changes_requested"] as const;
export const legacyUnverified = "legacy_unverified"; // 判断記録が無い (移行で人が確かめていない) 承認
export const approvalIdPattern = /^(plan|review)-([1-9]\d*)$/; // 判断記録の ID <工程>-<試行>
export const approvalBlockerPattern = /^approval\/((?:plan|review)-[1-9]\d*)$/; // blockedBy の判断記録の待ち

export type PhaseV4 = (typeof phasesV4)[number];
export type ApprovalPhase = (typeof approvalPhases)[number];
export type TaskStatusV4 = (typeof taskStatusesV4)[number];
export type OutcomeV4 = (typeof outcomesV4)[number];
export type ClosureReasonV4 = (typeof closureReasonsV4)[number];
export type HistoryEventV4 = (typeof historyEventsV4)[number];

export interface PhaseRecordV4 {
  status: PhaseStatus;
  attempt: number;
  assignee: string | null;
  completedBy: string | null;
  completedAt: string | null;
  outcome: OutcomeV4 | null;
  inputRevision: number | null;
  inputSeq: number | null;
  artifactRefs: ArtifactRef[];
}

// plan・review の記録。approval はこの試行の判断記録の ID (plan-2 など)、legacy_unverified (移行で判断記録が無い)、null (未提出)
export interface ApprovalPhaseRecordV4 extends PhaseRecordV4 {
  approval: string | null;
}

export interface HistoryEntryV4 {
  seq: number;
  at: string;
  actor: string;
  event: HistoryEventV4 | (typeof importedHistoryEvents)[number];
  phase: PhaseV4 | (typeof importedPhases)[number] | null;
  attempt: number | null;
  inputRevision: number | null;
  outcome: OutcomeV4 | (typeof importedOutcomes)[number] | null;
  from: string | null;
  to: string | null;
  reason: string | null;
  refersTo: number | null;
  refs: ArtifactRef[];
  sessionId?: string | null;
}

export interface Approvers {
  plan?: string | null;
  review?: string | null;
}

export interface MigratedFrom {
  workflowVersion: number | null;
  [key: string]: unknown;
}

export interface WorkflowV4 {
  plan: ApprovalPhaseRecordV4;
  execute: PhaseRecordV4;
  review: ApprovalPhaseRecordV4;
}

// 項目はすべて明示する (R18-1 と同じ理由)。v3 と共通の項目の型は workflow-v4-types.test.ts で確かめる
export interface TaskV4 {
  id: string;
  workflowVersion: 4;
  type: TaskType;
  status: TaskStatusV4;
  phase: PhaseV4 | null;
  requirementRevision: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  closureReason: ClosureReasonV4 | null;
  requestedBy: string | null;
  createdBy: string | null;
  blockedBy: string[];
  relatedTasks: string[];
  approvers?: Approvers;
  workflow: WorkflowV4;
  history: HistoryEntryV4[];
  migratedFrom?: MigratedFrom;
  [key: string]: unknown; // 未知の項目 (test など) は保持する
}

const topKeysV4 = [...topKeys.slice(0, 2), "type", ...topKeys.slice(2)]; // approvers・migratedFrom は任意なので含めない
const approversKeys = ["plan", "review"];
const decisionEventsV4 = ["approve", "reject", "supersede"]; // 判断記録を閉じる出来事 (人だけ)

export function sameArtifactRefs(a: ArtifactRef[], b: ArtifactRef[]): boolean {
  return a.length === b.length && a.every((ref, index) => ref.path === b[index].path && ref.repo === b[index].repo && ref.commit === b[index].commit);
}

// 最後の移行 (migrate) の seq。これより前の履歴は移行元 (v2・v3) の記録
export function migrateSeqOf(history: readonly { seq: number; event: string }[]): number | null {
  const found = history.filter((entry) => entry.event === "migrate").at(-1);
  return found ? found.seq : null;
}

// 提出とみなす履歴 (判断記録の submissionSeq が指せるもの): その工程・試行の complete (v4 でも移行元の v3 でも) か、
// 移行元の review の decide approved。legacy_import は提出者も成果物も無いので提出にならない
export function submissionOf(history: readonly HistoryEntryV4[], phase: ApprovalPhase, attempt: number): HistoryEntryV4 | undefined {
  const migrateSeq = migrateSeqOf(history);
  return history
    .filter((entry) => entry.phase === phase && entry.attempt === attempt)
    .filter((entry) => (entry.event === "complete" && entry.outcome === "completed") || (phase === "review" && entry.event === "decide" && entry.outcome === "approved" && migrateSeq !== null && entry.seq < migrateSeq))
    .at(-1);
}

// 工程の今の試行の完了の履歴。legacy_import は移行の記録、それ以外は提出 (submissionOf と同じ。execute は complete だけ)
export function completionOfV4(history: readonly HistoryEntryV4[], phase: PhaseV4, record: PhaseRecordV4): HistoryEntryV4 | undefined {
  if (record.outcome === "legacy_import") return history.filter((entry) => entry.phase === phase && entry.attempt === record.attempt && entry.event === "legacy_import" && entry.outcome === "legacy_import").at(-1);
  if (phase === "execute") return history.filter((entry) => entry.phase === phase && entry.attempt === record.attempt && entry.event === "complete" && entry.outcome === "completed").at(-1);
  return submissionOf(history, phase, record.attempt);
}

// 移行より後の、判断記録を閉じた出来事 (approve / reject / supersede)。判断記録の decisionSeq と対になる
export function decisionEventsOf(history: readonly HistoryEntryV4[], phase: ApprovalPhase, attempt: number): HistoryEntryV4[] {
  const migrateSeq = migrateSeqOf(history);
  return history.filter((entry) => (migrateSeq === null || entry.seq > migrateSeq) && decisionEventsV4.includes(entry.event) && entry.phase === phase && entry.attempt === attempt);
}

// 移行元の人の承認: 受入確認 (acceptance) の decide approved を人が記録したもの (04 の 2)。無ければ承認の証拠が無い
export function importedApprovalOf(history: readonly HistoryEntryV4[]): HistoryEntryV4 | undefined {
  const migrateSeq = migrateSeqOf(history);
  if (migrateSeq === null) return undefined;
  return history.filter((entry) => entry.seq < migrateSeq && entry.event === "decide" && entry.phase === "acceptance" && entry.outcome === "approved" && entry.actor.startsWith("human/")).at(-1);
}

export type WaitingV4 = { kind: "approval"; phase: ApprovalPhase; approval: string } | { kind: "external"; phase: PhaseV4; blockedBy: string[] } | null;

// タスクが何を待っているか。人の確認待ち (タスクの pending) と工程の外部の待ち (工程の pending) を別の値で示す (一覧・JSON で使う)
export function waitingOfV4(task: Pick<TaskV4, "status" | "phase" | "blockedBy" | "workflow">): WaitingV4 {
  if (task.phase === null) return null;
  if (task.status === "pending") {
    if (!(approvalPhases as readonly string[]).includes(task.phase)) return null;
    const approval = task.workflow[task.phase as ApprovalPhase].approval;
    return approval === null ? null : { kind: "approval", phase: task.phase as ApprovalPhase, approval };
  }
  if (task.status === "open" && task.workflow[task.phase].status === "pending") return { kind: "external", phase: task.phase, blockedBy: [...task.blockedBy] };
  return null;
}

// workflowVersion 4 のタスクを検証する。判断記録のファイルとの照合 (03 の 4 の 1〜4) は lib/decision.ts の checkTaskDecisions
export function validateTaskV4(data: unknown): WorkflowIssue[] {
  const check = new Checker();
  if (!check.object(data, "frontmatter")) return check.issues;
  const format = detectFormat(data);
  if (format.kind !== "v4") {
    const found = format.kind === "legacy" ? "workflowVersion がありません (旧形式のタスクです)" : format.kind === "unsupported" ? `対応していない workflowVersion です: ${JSON.stringify(format.version)}` : `workflowVersion ${format.kind.slice(1)} のタスクです`;
    check.add("WF_VERSION", "workflowVersion", `${found} (workflowVersion 4 として検証しました)`);
    return check.issues;
  }
  // 工程の名前。implement (v2) は別名として受け付けず、acceptance (v2・v3) は移行元の履歴にだけ許す
  const phaseValue = (value: unknown, path: string, nullable: boolean, imported = false): boolean => {
    if (value === "implement") {
      check.add("WF_PHASE_RENAMED", path, "workflowVersion 4 の工程は execute です (implement は workflowVersion 2 の名前。移行してから使う)");
      return false;
    }
    if (value === "acceptance" && !imported) {
      check.add("WF_PHASE_REMOVED", path, "workflowVersion 4 に受入確認の工程 (acceptance) はありません (人の承認は判断記録に記録する。v3 のタスクは移行してから使う)");
      return false;
    }
    return check.enumValue(value, imported ? [...phasesV4, ...importedPhases] : phasesV4, path, nullable);
  };
  const approvalValue = (value: unknown, path: string): boolean => {
    if (value === null || value === legacyUnverified || (typeof value === "string" && approvalIdPattern.test(value))) return true;
    check.add("WF_APPROVAL", path, `${path} は判断記録の ID (<工程>-<試行>)、legacy_unverified、空のいずれかです: ${JSON.stringify(value)}`);
    return false;
  };
  const present = topKeysV4.filter((key) => check.required(data, key, ""));
  const has = (key: string) => present.includes(key);

  if (has("id") && (typeof data.id !== "string" || !idPattern.test(data.id))) check.add("WF_TYPE", "id", `id は T-001 の形にしてください: ${JSON.stringify(data.id)}`);
  const statusOk = has("status") && check.enumValue(data.status, taskStatusesV4, "status");
  if (has("type") && !(typeof data.type === "string" && (taskTypes as readonly string[]).includes(data.type))) {
    check.add("WF_ENUM", "type", `type は ${taskTypes.join(" / ")} のいずれかです (search・implement などの別名や未知の種別は受け付けません): ${JSON.stringify(data.type)}`);
  }
  const phaseOk = has("phase") && phaseValue(data.phase, "phase", true);
  const revisionOk = has("requirementRevision") && check.integer(data.requirementRevision, "requirementRevision", 1);
  if (has("createdAt")) check.date(data.createdAt, "createdAt");
  if (has("updatedAt")) check.date(data.updatedAt, "updatedAt");
  if (has("completedAt")) check.date(data.completedAt, "completedAt", true);
  const closureOk = has("closureReason") && check.enumValue(data.closureReason, closureReasonsV4, "closureReason", true);
  if (has("requestedBy")) check.actor(data.requestedBy, "requestedBy");
  if (has("createdBy")) check.actor(data.createdBy, "createdBy");
  // 待っている相手。判断記録の待ち (approval/<工程>-<試行>) と外部の待ち (qa/…・task/…・other: …) を分ける
  const blockedOk = has("blockedBy") && check.stringList(data.blockedBy, "blockedBy");
  const approvalBlockers: string[] = [];
  const externalBlockers: string[] = [];
  if (blockedOk) {
    (data.blockedBy as unknown[]).forEach((item, index) => {
      if (typeof item !== "string") return;
      if (!item.startsWith("approval/")) return void externalBlockers.push(item);
      const match = approvalBlockerPattern.exec(item);
      if (match) approvalBlockers.push(match[1]);
      else check.add("WF_BLOCKED", `blockedBy[${index}]`, `判断記録の待ちは approval/<工程>-<試行> (approval/plan-1 など) の形です: ${item}`);
    });
  }
  if (has("relatedTasks")) check.stringList(data.relatedTasks, "relatedTasks", taskRefPattern);
  // 判断記録の初期の担当 (任意)。人だけ
  if ("approvers" in data && data.approvers !== undefined && check.object(data.approvers, "approvers")) {
    const approvers = data.approvers;
    const unknown = Object.keys(approvers).filter((key) => !approversKeys.includes(key));
    if (unknown.length > 0) check.add("WF_FIELD_UNKNOWN", "approvers", `approvers に使えない項目があります: ${unknown.join(", ")} (判断記録があるのは plan と review)`);
    for (const key of approversKeys) {
      if (!(key in approvers)) continue;
      const value = approvers[key];
      if (check.actor(value, `approvers.${key}`) && value !== null && !(value as string).startsWith("human/")) check.add("WF_HUMAN", `approvers.${key}`, `判断記録の担当は人 (human/…) です: ${value}`);
    }
  }
  // 移行元の記録 (任意)。移行した元の版と、v4 に写せない記録
  if ("migratedFrom" in data && data.migratedFrom !== undefined && check.object(data.migratedFrom, "migratedFrom") && check.required(data.migratedFrom, "workflowVersion", "migratedFrom")) {
    check.integer(data.migratedFrom.workflowVersion, "migratedFrom.workflowVersion", 1, true);
  }

  // 工程
  const records: Partial<Record<PhaseV4, PhaseRecordV4 & { approval?: unknown }>> = {};
  if (has("workflow") && check.object(data.workflow, "workflow")) {
    const workflow = data.workflow;
    for (const key of Object.keys(workflow).filter((key) => !(phasesV4 as readonly string[]).includes(key))) {
      if (key === "implement" || key === "acceptance") phaseValue(key, `workflow.${key}`, false);
      else check.add("WF_FIELD_UNKNOWN", "workflow", `workflow に使えない工程があります: ${key} (工程は ${phasesV4.join(" / ")})`);
    }
    for (const phase of phasesV4) {
      const path = `workflow.${phase}`;
      if (!check.required(workflow, phase, "workflow")) continue;
      const record = workflow[phase];
      if (!check.object(record, path)) continue;
      const withApproval = (approvalPhases as readonly string[]).includes(phase);
      const keys = withApproval ? [...phaseKeys, "approval"] : phaseKeys;
      const ok = keys.map((key) => check.required(record, key, path)).every(Boolean);
      if (!withApproval && "approval" in record) check.add("WF_FIELD_UNKNOWN", `${path}.approval`, `${path} に approval は書きません (判断記録があるのは plan と review)`);
      if (!ok) continue;
      const fine = [
        check.enumValue(record.status, phaseStatuses, `${path}.status`),
        check.integer(record.attempt, `${path}.attempt`, 1),
        check.actor(record.assignee, `${path}.assignee`),
        check.actor(record.completedBy, `${path}.completedBy`),
        check.date(record.completedAt, `${path}.completedAt`, true),
        check.enumValue(record.outcome, outcomesV4, `${path}.outcome`, true),
        check.integer(record.inputRevision, `${path}.inputRevision`, 1, true),
        check.integer(record.inputSeq, `${path}.inputSeq`, 1, true),
        check.refs(record.artifactRefs, `${path}.artifactRefs`),
        withApproval ? approvalValue(record.approval, `${path}.approval`) : true,
      ].every(Boolean);
      if (fine) records[phase] = record as unknown as PhaseRecordV4 & { approval?: unknown };
    }
  }

  // 履歴。最後の migrate より前は移行元の記録として、v3 の出来事 (decide)・工程 (acceptance・implement)・結果 (approved・changes_requested) を許す
  const history: HistoryEntryV4[] = [];
  if (has("history")) {
    if (!Array.isArray(data.history)) check.add("WF_TYPE", "history", "history は配列にしてください");
    else {
      const raw = data.history as unknown[];
      const migrateIndex = raw.map((entry) => (entry !== null && typeof entry === "object" && (entry as Record<string, unknown>).event === "migrate" ? 1 : 0)).lastIndexOf(1);
      raw.forEach((entry, index) => {
        const path = `history[${index}]`;
        const imported = migrateIndex >= 0 && index < migrateIndex;
        if (!check.object(entry, path)) return;
        if (!historyKeys.map((key) => check.required(entry, key, path)).every(Boolean)) return;
        let eventOk: boolean;
        if (!imported && entry.event === "decide") {
          check.add("WF_HISTORY_EVENT", `${path}.event`, "workflowVersion 4 に decide はありません (review は complete で提出し、人の判断は approve / reject で記録する。decide は移行元の記録にだけ残る)");
          eventOk = false;
        } else eventOk = check.enumValue(entry.event, imported ? [...historyEventsV4, ...importedHistoryEvents] : historyEventsV4, `${path}.event`);
        let outcomeOk: boolean;
        if (!imported && (importedOutcomes as readonly string[]).includes(entry.outcome as string)) {
          check.add("WF_OUTCOME", `${path}.outcome`, `workflowVersion 4 の工程の結果は ${outcomesV4.join(" / ")} です (人の判断 ${entry.outcome} は判断記録に記録する): ${path}.outcome`);
          outcomeOk = false;
        } else outcomeOk = check.enumValue(entry.outcome, imported ? [...outcomesV4, ...importedOutcomes] : outcomesV4, `${path}.outcome`, true);
        const fine = [
          check.integer(entry.seq, `${path}.seq`, 1),
          check.dateTime(entry.at, `${path}.at`),
          check.actor(entry.actor, `${path}.actor`, false),
          eventOk,
          phaseValue(entry.phase, `${path}.phase`, true, imported),
          check.integer(entry.attempt, `${path}.attempt`, 1, true),
          check.integer(entry.inputRevision, `${path}.inputRevision`, 1, true),
          outcomeOk,
          check.integer(entry.refersTo, `${path}.refersTo`, 1, true),
          check.refs(entry.refs, `${path}.refs`),
        ].every(Boolean);
        for (const key of ["from", "to", "reason"]) {
          const value = entry[key];
          if (value !== null && (typeof value !== "string" || /[\r\n]/.test(value))) check.add("WF_TYPE", `${path}.${key}`, `${path}.${key} は 1 行の文字列か空にしてください`);
        }
        if ("sessionId" in entry && entry.sessionId !== null && (typeof entry.sessionId !== "string" || !sessionPattern.test(entry.sessionId))) {
          check.add("WF_TYPE", `${path}.sessionId`, `${path}.sessionId の形が不正です`);
        }
        if (fine) history.push(entry as unknown as HistoryEntryV4);
      });
    }
  }

  // ここから項目をまたぐ規則。構造が壊れている項目は上で報告済みなので、読めた範囲だけを確かめる
  const migrateSeq = migrateSeqOf(history);
  const imported = (entry: HistoryEntryV4) => migrateSeq !== null && entry.seq < migrateSeq;
  const importedApproval = importedApprovalOf(history);
  const approvalIdOf = (phase: ApprovalPhase, attempt: number) => `${phase}-${attempt}`;
  const allPhases = phasesV4.every((phase) => records[phase] !== undefined);
  const revision = revisionOk ? (data.requirementRevision as number) : undefined;
  const status = statusOk ? (data.status as TaskStatusV4) : undefined;
  const current = phaseOk ? (data.phase as PhaseV4 | null) : undefined;

  if (allPhases && status !== undefined && current !== undefined) {
    if (status === "open" || status === "pending") {
      if (current === null) check.add("WF_OPEN_PHASE", "phase", `${status} のタスクには現在の工程 (phase) が必要です`);
      else {
        const index = phasesV4.indexOf(current);
        phasesV4.forEach((phase, position) => {
          const record = records[phase]!;
          const path = `workflow.${phase}.status`;
          if (position < index && record.status !== "done") check.add("WF_ORDER", path, `現在の工程 ${current} より前の ${phase} が done ではありません (${record.status})`);
          if (position === index && status === "open" && !["ready", "progress", "pending"].includes(record.status)) {
            check.add("WF_ORDER", path, `現在の工程 ${current} は ready / progress / pending のいずれかです (${record.status})`);
          }
          if (position === index && status === "pending" && record.status !== "done") {
            check.add("WF_APPROVAL", path, `人の確認待ち (タスクの pending) では、提出した工程 ${current} は done に固定します (${record.status}。工程の pending は外部の待ちで、同時には持たない)`);
          }
          if (position > index && record.status !== "waiting") {
            check.add("WF_ORDER", path, `現在の工程 ${current} より後の ${phase} は waiting です (${record.status})${status === "pending" ? " (人が承認するまで次の工程を ready にしない)" : ""}`);
          }
        });
        if (status === "open") {
          if (blockedOk) {
            const pending = records[current]!.status === "pending";
            const blocked = externalBlockers.length > 0;
            if (pending && !blocked) check.add("WF_BLOCKED", "blockedBy", `工程 ${current} が pending なのに blockedBy が空です`);
            if (!pending && blocked) check.add("WF_BLOCKED", "blockedBy", `工程 ${current} が pending ではないのに blockedBy があります`);
            if (approvalBlockers.length > 0) check.add("WF_BLOCKED", "blockedBy", `open のタスクは判断記録を待ちません (approval/… は人の確認待ち (タスクの pending) だけに書く): ${approvalBlockers.map((id) => `approval/${id}`).join(", ")}`);
          }
        } else if (!(approvalPhases as readonly string[]).includes(current)) {
          check.add("WF_APPROVAL", "phase", `人の確認待ち (タスクの pending) になるのは plan か review の提出の後だけです (${current})`);
        } else {
          const record = records[current]! as PhaseRecordV4 & { approval?: unknown };
          const id = approvalIdOf(current as ApprovalPhase, record.attempt);
          if (record.status === "done") {
            if (record.outcome !== "completed") check.add("WF_APPROVAL", `workflow.${current}.outcome`, `人の確認待ちの ${current} の結果は completed です (legacy_import は提出ではないので承認の対象にならない): ${record.outcome}`);
            if (record.approval !== id) check.add("WF_APPROVAL", `workflow.${current}.approval`, `人の確認待ちの ${current} (試行 ${record.attempt}) の approval は ${id} です: ${JSON.stringify(record.approval)}`);
            else if (decisionEventsOf(history, current as ApprovalPhase, record.attempt).length > 0) {
              check.add("WF_APPROVAL", `workflow.${current}.approval`, `${id} には承認・見送り・無効化の履歴があるので、確認待ち (タスクの pending) ではありません`);
            }
          }
          if (blockedOk) {
            if (externalBlockers.length > 0) check.add("WF_BLOCKED", "blockedBy", `人の確認待ちと外部の待ちは同時に持てません (blockedBy は approval/${id} の 1 件だけ): ${externalBlockers.join(", ")}`);
            if (approvalBlockers.length !== 1 || approvalBlockers[0] !== id) check.add("WF_BLOCKED", "blockedBy", `人の確認待ちの blockedBy は approval/${id} の 1 件だけです: ${JSON.stringify(data.blockedBy)}`);
          }
        }
      }
      if (has("completedAt") && data.completedAt !== null) check.add("WF_CLOSED", "completedAt", `${status} のタスクには completedAt を書きません`);
      if (closureOk && data.closureReason !== null) check.add("WF_CLOSED", "closureReason", `${status} のタスクには closureReason を書きません`);
    } else {
      if (current !== null) check.add("WF_CLOSED", "phase", "closed のタスクの phase は空にします");
      if (has("completedAt") && data.completedAt === null) check.add("WF_CLOSED", "completedAt", "closed のタスクには閉じた日 (completedAt) が必要です");
      if (blockedOk && (data.blockedBy as string[]).length > 0) check.add("WF_BLOCKED", "blockedBy", "closed のタスクに blockedBy は書きません");
      if (closureOk && data.closureReason === null) check.add("WF_CLOSED", "closureReason", "closed のタスクには閉じた理由 (approved / legacy_done) が必要です");
      for (const phase of phasesV4) {
        if (records[phase]!.status !== "done") check.add("WF_CLOSED", `workflow.${phase}.status`, `closed のタスクの工程はすべて done です (${phase}: ${records[phase]!.status})`);
      }
      if (closureOk && data.closureReason === "approved") {
        const review = records.review! as PhaseRecordV4 & { approval?: unknown };
        const id = approvalIdOf("review", review.attempt);
        if (review.outcome !== "completed") check.add("WF_CLOSED", "workflow.review.outcome", `approved で閉じるには review の提出 (outcome: completed) が必要です (${review.outcome ?? "空"})`);
        else if (review.approval !== id) check.add("WF_CLOSED", "workflow.review.approval", `approved で閉じるには review の判断記録 ${id} を人が承認している必要があります (approval: ${JSON.stringify(review.approval)})`);
        else {
          const events = decisionEventsOf(history, "review", review.attempt);
          const completion = completionOfV4(history, "review", review);
          const approved = events.length > 0 ? events.at(-1)!.event === "approve" : completion !== undefined && imported(completion) && importedApproval !== undefined && importedApproval.seq > completion.seq;
          if (!approved) check.add("WF_CLOSED", "workflow.review.approval", `approved で閉じるには ${id} を人が承認した履歴 (approve。移行なら移行元の受入確認の decide approved) が必要です`);
        }
      }
      if (closureOk && data.closureReason === "legacy_done") {
        // 旧 done の移行では承認を捏造しない
        for (const phase of phasesV4) {
          const record = records[phase]! as PhaseRecordV4 & { approval?: unknown };
          if (record.outcome !== "legacy_import") check.add("WF_LEGACY", `workflow.${phase}.outcome`, `legacy_done で閉じたタスクの工程の結果は legacy_import です (${phase}: ${record.outcome})`);
          if ((approvalPhases as readonly string[]).includes(phase) && record.approval !== legacyUnverified) {
            check.add("WF_LEGACY", `workflow.${phase}.approval`, `legacy_done で閉じたタスクに判断記録はありません (${phase} の approval は legacy_unverified): ${JSON.stringify(record.approval)}`);
          }
        }
      }
    }
  }

  // 工程ごとの記録の整合
  for (const phase of phasesV4) {
    const record = records[phase];
    if (!record) continue;
    const path = `workflow.${phase}`;
    const legacy = record.outcome === "legacy_import";
    const completion = history.length > 0 ? completionOfV4(history, phase, record) : undefined;
    if (record.status === "done") {
      if (!legacy) {
        if (record.completedBy === null) check.add("WF_DONE", `${path}.completedBy`, `done の工程 ${phase} には完了した人 (completedBy) が必要です`);
        if (record.completedAt === null) check.add("WF_DONE", `${path}.completedAt`, `done の工程 ${phase} には完了日 (completedAt) が必要です`);
        if (record.inputRevision === null) check.add("WF_DONE", `${path}.inputRevision`, `done の工程 ${phase} には対象にした要件の版 (inputRevision) が必要です`);
        if (record.artifactRefs.length === 0) check.add("WF_DONE", `${path}.artifactRefs`, `done の工程 ${phase} には成果物・引継資料 (artifactRefs) が必要です`);
      }
      if (record.outcome === null) check.add("WF_OUTCOME", `${path}.outcome`, `done の工程 ${phase} の結果は ${outcomesV4.join(" / ")} のいずれかです (空)`);
      else if (history.length > 0) {
        if (!completion) {
          if (legacy) check.add("WF_LEGACY", `${path}.outcome`, `${phase} の legacy_import に対応する移行の記録 (history の legacy_import、試行 ${record.attempt}) がありません`);
          else check.add("WF_COMPLETION", `${path}.status`, `done の工程 ${phase} (試行 ${record.attempt}) に対応する完了の履歴 (complete${phase === "review" ? "。移行なら移行元の review の decide approved" : ""}) がありません`);
        } else if (!legacy) {
          if (completion.actor !== record.completedBy) check.add("WF_COMPLETION", `${path}.completedBy`, `${phase} の completedBy (${record.completedBy}) が完了の履歴 seq ${completion.seq} の actor (${completion.actor}) と違います`);
          if (completion.inputRevision !== record.inputRevision) check.add("WF_COMPLETION", `${path}.inputRevision`, `${phase} の inputRevision (${record.inputRevision}) が完了の履歴 seq ${completion.seq} の版 (${completion.inputRevision}) と違います`);
          if (!sameArtifactRefs(completion.refs, record.artifactRefs)) check.add("WF_COMPLETION", `${path}.artifactRefs`, `${phase} の成果物が完了の履歴 seq ${completion.seq} の記録と違います (完了の後に成果物を差し替えるときは新しい試行にする)`);
        }
      }
      // 判断記録の参照 (plan・review)
      if ((approvalPhases as readonly string[]).includes(phase)) {
        const approval = record.approval;
        const id = approvalIdOf(phase as ApprovalPhase, record.attempt);
        if (approval === null) check.add("WF_APPROVAL", `${path}.approval`, `done の ${phase} (試行 ${record.attempt}) には判断記録の ID (${id}) か legacy_unverified が必要です`);
        else if (legacy) {
          if (approval !== legacyUnverified) check.add("WF_APPROVAL", `${path}.approval`, `legacy_import の ${phase} に判断記録はありません (approval は legacy_unverified): ${JSON.stringify(approval)}`);
        } else if (approval === legacyUnverified) {
          if (!(completion !== undefined && imported(completion))) check.add("WF_APPROVAL", `${path}.approval`, `legacy_unverified は移行 (migrate) より前に完了した工程にだけ書けます (v4 で提出した ${phase} には判断記録を作る)`);
        } else if (approval !== id) check.add("WF_APPROVAL", `${path}.approval`, `${phase} (試行 ${record.attempt}) の approval は ${id} です: ${JSON.stringify(approval)}`);
        else if (!(status === "pending" && current === phase)) {
          // 提出の後へ進んでいる (open で後の工程が動いている・closed) なら、人が承認した履歴が要る
          const last = decisionEventsOf(history, phase as ApprovalPhase, record.attempt).at(-1);
          if (last === undefined) {
            const viaImport = phase === "review" && completion !== undefined && imported(completion) && importedApproval !== undefined && importedApproval.seq > completion.seq;
            if (!viaImport) check.add("WF_APPROVAL", `${path}.approval`, `${id} を人が承認した履歴 (approve) が無いのに、${phase} の後へ進んでいます (承認まで次の工程を始めない)`);
          } else if (last.event !== "approve") {
            check.add("WF_APPROVAL", `${path}.approval`, `${id} は${last.event === "reject" ? "見送られた" : "無効化された"}ので、${phase} は新しい試行でやり直します (この approval を持ったまま進めない)`);
          }
        }
      }
    } else {
      for (const key of ["completedBy", "completedAt", "outcome"] as const) {
        if (record[key] !== null) check.add("WF_DONE", `${path}.${key}`, `${record.status} の工程 ${phase} には ${key} を書きません (前の結果は history に残す)`);
      }
      if (record.status === "waiting") {
        if (record.inputRevision !== null) check.add("WF_DONE", `${path}.inputRevision`, `waiting の工程 ${phase} には inputRevision を書きません`);
        if (record.inputSeq !== null) check.add("WF_INPUT", `${path}.inputSeq`, `waiting の工程 ${phase} には inputSeq を書きません`);
      } else if (record.inputRevision === null) {
        check.add("WF_DONE", `${path}.inputRevision`, `${record.status} の工程 ${phase} には対象にする要件の版 (inputRevision) が必要です`);
      }
      if ((record.status === "progress" || record.status === "pending") && record.assignee === null) {
        check.add("WF_ASSIGNEE", `${path}.assignee`, `${record.status} の工程 ${phase} には担当 (assignee) が必要です`);
      }
      if ((approvalPhases as readonly string[]).includes(phase) && record.approval !== null) {
        check.add("WF_APPROVAL", `${path}.approval`, `${record.status} の工程 ${phase} に approval は書きません (提出 (complete) のときに判断記録を作る。前の試行の記録は history と decisions/ に残る)`);
      }
    }
    if (revision !== undefined && record.status !== "waiting" && !legacy && record.inputRevision !== null && record.inputRevision !== revision) {
      check.add("WF_STALE", `${path}.inputRevision`, `${phase} の inputRevision (${record.inputRevision}) が今の要件の版 (${revision}) と違います`);
    }
  }
  // 前工程の入力: 作業中・完了した工程は、前工程の今の試行の完了を受け取っていなければならない (execute は plan の完了 = 人が承認した提出)
  phasesV4.forEach((phase, index) => {
    const record = records[phase];
    if (!record || record.status === "waiting") return;
    const path = `workflow.${phase}.inputSeq`;
    if (index === 0) {
      if (record.inputSeq !== null) check.add("WF_INPUT", path, "plan は前工程が無いので inputSeq を書きません");
      return;
    }
    const previous = phasesV4[index - 1];
    const before = records[previous];
    if (!before || before.status !== "done" || before.outcome === null || history.length === 0) return;
    const completion = completionOfV4(history, previous, before);
    if (!completion) return;
    if (record.inputSeq !== completion.seq) {
      check.add("WF_INPUT", path, `${phase} は前工程 ${previous} の今の試行 ${before.attempt} の完了 (seq ${completion.seq}) を受け取っていません (inputSeq: ${record.inputSeq ?? "空"})`);
    }
  });
  // 職務分離: execute を完了した actor は同じ成果物の review を引き受けられず、完了もできない
  const execute = records.execute;
  const review = records.review;
  if (execute && review && execute.completedBy !== null) {
    if (review.status === "done" && review.outcome === "completed" && review.completedBy === execute.completedBy) {
      check.add("WF_SEPARATION", "workflow.review.completedBy", `実行 (execute) を完了した ${execute.completedBy} が同じ成果物をレビューしています`);
    } else if (review.status !== "done" && review.assignee === execute.completedBy) {
      check.add("WF_SEPARATION", "workflow.review.assignee", `実行 (execute) を完了した ${execute.completedBy} は同じ成果物の review を担当できません`);
    }
  }

  // 履歴: seq は 1 から増え続け、refersTo は前の履歴だけを指す。日時と試行回数は戻らない。
  // 最後の migrate より前 (移行元の記録) には v4 の出来事の規則を当てない
  const eventPhases: Partial<Record<string, readonly (string | null)[]>> = { complete: phasesV4, send_back: ["execute", "review"], approve: approvalPhases, reject: approvalPhases, supersede: approvalPhases, revise: [null], migrate: [null] };
  const reasonRequired = ["send_back", "reject", "supersede", "revise", "reopen"];
  const humanOnly = ["approve", "reject", "supersede", "revise", "reopen"];
  let migrating = history.length > 0 && history[0].event === "legacy_import";
  history.forEach((entry, index) => {
    const path = `history[${index}]`;
    if (entry.seq !== index + 1) check.add("WF_HISTORY_ORDER", `${path}.seq`, `history の seq は 1 から順に並べます (${index + 1} の位置に ${entry.seq})`);
    if (entry.refersTo !== null && entry.refersTo >= entry.seq) check.add("WF_HISTORY_REF", `${path}.refersTo`, `history の refersTo は前の履歴 (seq ${entry.seq} より小さい) だけを指せます: ${entry.refersTo}`);
    if (entry.refersTo !== null && !history.some((other) => other.seq === entry.refersTo)) check.add("WF_HISTORY_REF", `${path}.refersTo`, `history の refersTo が存在しない履歴を指しています: ${entry.refersTo}`);
    if (index > 0 && Date.parse(entry.at) < Date.parse(history[index - 1].at)) check.add("WF_HISTORY_ORDER", `${path}.at`, `history の日時が前の履歴より前になっています (${entry.at})`);
    if (entry.phase !== null && entry.attempt !== null) {
      const record = records[entry.phase as PhaseV4];
      if (record && entry.attempt > record.attempt) check.add("WF_HISTORY_ATTEMPT", `${path}.attempt`, `history の ${entry.phase} の試行 ${entry.attempt} が現在の試行 ${record.attempt} より大きい`);
      const earlier = history.slice(0, index).filter((other) => other.phase === entry.phase && other.attempt !== null);
      if (earlier.length > 0 && entry.attempt < earlier[earlier.length - 1].attempt!) {
        check.add("WF_HISTORY_ATTEMPT", `${path}.attempt`, `history の ${entry.phase} の試行回数が戻っています (${earlier[earlier.length - 1].attempt} の後に ${entry.attempt})`);
      }
    }
    if (revision !== undefined && entry.inputRevision !== null && entry.inputRevision > revision) {
      check.add("WF_STALE", `${path}.inputRevision`, `history の inputRevision (${entry.inputRevision}) が requirementRevision (${revision}) より新しい`);
    }
    if (imported(entry)) return; // 移行元の記録: 出来事の規則は元の版のもの
    const allowed = eventPhases[entry.event];
    if (allowed && !allowed.includes(entry.phase)) check.add("WF_HISTORY_EVENT", `${path}.event`, `${entry.event} は ${allowed.map((phase) => phase ?? "工程なし").join(" / ")} の出来事です (${entry.phase ?? "工程なし"})`);
    if (entry.event === "legacy_import") {
      if (!migrating) check.add("WF_LEGACY", `${path}.event`, "legacy_import は移行した時の記録として履歴の先頭にだけ書けます (通常の操作では使えない)");
      if (entry.phase === null || entry.outcome !== "legacy_import") check.add("WF_LEGACY", path, "legacy_import の履歴には移した工程 (phase) と結果 legacy_import が必要です");
    } else migrating = false;
    if (entry.outcome === "legacy_import" && entry.event !== "legacy_import") check.add("WF_LEGACY", `${path}.outcome`, `結果 legacy_import は移行の記録 (event: legacy_import) にだけ使えます (${entry.event})`);
    if (reasonRequired.includes(entry.event) && (entry.reason === null || entry.reason.trim() === "")) check.add("WF_REASON", `${path}.reason`, `${entry.event} には理由 (reason) が必要です`);
    if (humanOnly.includes(entry.event) && !entry.actor.startsWith("human/")) check.add("WF_HUMAN", `${path}.actor`, `${entry.event} は人 (human/…) だけができます: ${entry.actor}`);
    if (decisionEventsV4.includes(entry.event)) {
      if (entry.attempt === null) check.add("WF_HISTORY_EVENT", `${path}.attempt`, `${entry.event} には判断記録の試行 (attempt) が必要です`);
      else {
        const ref = `decisions/${entry.phase}-${entry.attempt}.md`;
        if (!entry.refs.some((item) => item.path === ref)) check.add("WF_HISTORY_REF", `${path}.refs`, `${entry.event} は判断記録 ${ref} を refs に持ちます`);
      }
    }
    if (entry.event === "send_back") {
      const target = entry.phase === "execute" ? "plan" : "execute";
      if (entry.to !== target) check.add("WF_HISTORY_EVENT", `${path}.to`, `${entry.phase} からの send_back の戻し先 (to) は ${target} です: ${JSON.stringify(entry.to)}`);
    }
  });
  for (const phase of phasesV4) {
    const record = records[phase];
    if (record && record.inputSeq !== null && !history.some((entry) => entry.seq === record.inputSeq)) {
      check.add("WF_INPUT", `workflow.${phase}.inputSeq`, `${phase} の inputSeq が存在しない履歴を指しています: ${record.inputSeq}`);
    }
  }
  if (has("history") && Array.isArray(data.history) && data.history.length === 0) check.add("WF_HISTORY_ORDER", "history", "history には作成 (create) か移行 (legacy_import) の記録が 1 件以上必要です");
  if (history.length > 0 && history[0].event !== "create" && history[0].event !== "legacy_import") {
    check.add("WF_HISTORY_ORDER", "history[0].event", `history の最初は create か legacy_import です (${history[0].event})`);
  }
  if (history.length > 0 && history[0].event === "migrate") check.add("WF_LEGACY", "history[0].event", "migrate の前には移行元の記録が必要です (先頭に migrate は書けない)");
  return check.issues;
}

// 新しいタスク (workflowVersion 4) の初期値。種別は必須で、計画が ready、後続は waiting、全体は open。判断記録の担当 (approvers) は任意で人だけ
export function initialTaskV4(fields: { id: string; type: TaskType; date: string; at?: string; requestedBy: string; createdBy: string; approvers?: Approvers }): TaskV4 {
  if (!(taskTypes as readonly string[]).includes(fields.type)) {
    throw new TypeError(`種別 (type) は ${taskTypes.join(" / ")} のいずれかを指定してください: ${JSON.stringify(fields.type)}`);
  }
  if (fields.approvers !== undefined) {
    for (const [key, value] of Object.entries(fields.approvers)) {
      if (!approversKeys.includes(key)) throw new TypeError(`判断記録の担当 (approvers) に指定できるのは plan と review です: ${key}`);
      if (value !== null && value !== undefined && !(actorPattern.test(value) && value.startsWith("human/"))) throw new TypeError(`判断記録の担当は人 (human/<識別子>) です: ${JSON.stringify(value)}`);
    }
  }
  const record = (status: PhaseStatus): PhaseRecordV4 => ({ status, attempt: 1, assignee: null, completedBy: null, completedAt: null, outcome: null, inputRevision: status === "waiting" ? null : 1, inputSeq: null, artifactRefs: [] });
  return {
    id: fields.id,
    workflowVersion: 4,
    type: fields.type,
    status: "open",
    phase: "plan",
    requirementRevision: 1,
    createdAt: fields.date,
    updatedAt: fields.date,
    completedAt: null,
    closureReason: null,
    requestedBy: fields.requestedBy,
    createdBy: fields.createdBy,
    blockedBy: [],
    relatedTasks: [],
    ...(fields.approvers !== undefined ? { approvers: { ...fields.approvers } } : {}),
    workflow: { plan: { ...record("ready"), approval: null }, execute: record("waiting"), review: { ...record("waiting"), approval: null } },
    history: [
      { seq: 1, at: fields.at ?? new Date().toISOString(), actor: fields.createdBy, event: "create", phase: "plan", attempt: 1, inputRevision: 1, outcome: null, from: null, to: "ready", reason: null, refersTo: null, refs: [] },
    ],
  };
}
