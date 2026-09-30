// project の scripts/ が返す JSON の型。schemaVersion 1 (query-v1) と、工程型タスクを含む schemaVersion 2 (query-v2)。
// 画面はこの形だけに依存し、プロジェクトのコードを直接 import しない。schemaVersion 2 の項目は任意 (旧 scripts では無い)。

export type Kind = "task" | "qa";

export interface Issue {
  code: string;
  severity: "warning" | "error";
  job: string;
  kind: Kind | "job";
  id: string | null;
  path: string;
  message: string;
}

interface BaseRecord {
  job: string;
  kind: Kind;
  id: string | null;
  name: string;
  path: string;
  title: string | null;
  status: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  requestedBy: string | null;
  createdBy: string | null;
  revision: string | null;
}

export interface ArtifactRef {
  path?: string;
  repo?: string;
  commit?: string;
}

// 工程ごとの記録 (workflowVersion 3)
export interface PhaseRecord {
  status: string;
  attempt: number;
  assignee: string | null;
  completedBy: string | null;
  completedAt: string | null;
  outcome: string | null;
  inputRevision: number | null;
  inputSeq: number | null;
  artifactRefs: ArtifactRef[];
}

export interface HistoryEntry {
  seq: number;
  at: string;
  actor: string;
  event: string;
  phase: string | null;
  attempt: number | null;
  outcome: string | null;
  from: string | null;
  to: string | null;
  reason: string | null;
  refersTo: number | null;
  refs: ArtifactRef[];
}

export interface TaskRecord extends BaseRecord {
  kind: "task";
  completedAt: string | null;
  blockedBy: string[];
  // schemaVersion 2 だけ。workflowVersion が null なら旧形式、2・3 なら工程型
  workflowVersion?: number | null;
  type?: string | null; // research / implementation
  phase?: string | null;
  phaseStatus?: string | null;
  assignee?: string | null;
  requirementRevision?: number | null;
  closureReason?: string | null;
  relatedTasks?: string[];
  workflow?: Record<string, PhaseRecord> | null;
  history?: HistoryEntry[];
  valid?: boolean;
  readable?: boolean;
}

export interface QaRecord extends BaseRecord {
  kind: "qa";
  question: string | null;
  answer: string | null;
  askTo: string | null;
  answeredBy: string | null;
  resolvedAt: string | null;
}

export type ItemRecord = TaskRecord | QaRecord;

export interface StatusCounts {
  total: number;
  byStatus: Record<string, number>;
}

export interface JobRecord {
  name: string;
  path: string;
  title: string | null;
  counts: { task: StatusCounts; qa: StatusCounts };
}

export interface Snapshot {
  schemaVersion: 1 | 2;
  generatedAt: string;
  scope: { job: string | null };
  jobs: JobRecord[];
  tasks: TaskRecord[];
  qas: QaRecord[];
  issues: Issue[];
}

export interface ShowResult {
  schemaVersion: 1 | 2;
  kind: Kind;
  item: ItemRecord & { rawMarkdown: string | null };
  issues: Issue[];
}

export const statusOrder: Record<Kind, readonly string[]> = {
  task: ["progress", "todo", "pending", "done"],
  qa: ["unresolved", "resolved"],
};
