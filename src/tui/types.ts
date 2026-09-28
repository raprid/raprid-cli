// project の scripts/ が返す JSON (schemaVersion 1 / query-v1) の型。
// 画面はこの形だけに依存し、プロジェクトのコードを直接 import しない。

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

export interface TaskRecord extends BaseRecord {
  kind: "task";
  completedAt: string | null;
  blockedBy: string[];
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
  schemaVersion: 1;
  generatedAt: string;
  scope: { job: string | null };
  jobs: JobRecord[];
  tasks: TaskRecord[];
  qas: QaRecord[];
  issues: Issue[];
}

export interface ShowResult {
  schemaVersion: 1;
  kind: Kind;
  item: ItemRecord & { rawMarkdown: string | null };
  issues: Issue[];
}

export const statusOrder: Record<Kind, readonly string[]> = {
  task: ["progress", "todo", "pending", "done"],
  qa: ["unresolved", "resolved"],
};
