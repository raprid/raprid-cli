// TUI の試験で使う snapshot と偽の backend

import type { Backend, WriteResult } from "../src/tui/backend.js";
import type { Issue, PhaseRecord, QaRecord, ShowResult, Snapshot, TaskRecord } from "../src/tui/types.js";
import type { WorkflowStep } from "../src/tui/workflow.js";

export function task(id: string | null, fields: Partial<TaskRecord> = {}): TaskRecord {
  const name = fields.name ?? (id ?? "no-id").toLowerCase();
  const job = fields.job ?? "PROJ-1";
  return {
    job,
    kind: "task",
    id,
    name,
    path: `jobs/${job}/tasks/${name}/index.md`,
    title: `タスク ${id ?? name}`,
    status: "todo",
    createdAt: "2026-09-28",
    updatedAt: "2026-09-28",
    requestedBy: "human/saiki",
    createdBy: "agent/claude",
    revision: `rev-${name}`,
    completedAt: null,
    blockedBy: [],
    ...fields,
  };
}

// 工程型タスク (schemaVersion 2 の項目つき)。phase と phaseStatus・担当から工程ごとの記録を作る
export function workflowTask(id: string, fields: Partial<TaskRecord> & { phase?: string | null; phaseStatus?: string | null } = {}): TaskRecord {
  const phase = fields.phase === undefined ? "plan" : fields.phase;
  const status = fields.status ?? "open";
  const order = ["plan", "execute", "review", "acceptance"];
  const index = phase === null ? order.length : order.indexOf(phase);
  const record = (position: number): PhaseRecord => ({
    status: status === "closed" || position < index ? "done" : position === index ? (fields.phaseStatus ?? "ready") : "waiting",
    attempt: 1,
    assignee: position === index ? (fields.assignee ?? null) : position === 3 ? "human/saiki" : null,
    completedBy: status === "closed" || position < index ? (position === 1 ? "agent/claude" : position === 3 ? "human/saiki" : "agent/codex") : null,
    completedAt: status === "closed" || position < index ? "2026-09-29" : null,
    outcome: status === "closed" || position < index ? (position < 2 ? "completed" : "approved") : null,
    inputRevision: 1,
    inputSeq: null,
    artifactRefs: status === "closed" || position < index ? (position === 1 ? [{ path: "02-handoff.md" }, { repo: "project_template", commit: "873ca38" }] : [{ path: `0${position + 1}.md` }]) : [],
  });
  return task(id, {
    status,
    workflowVersion: 3,
    type: "implementation",
    phase: status === "closed" ? null : phase,
    phaseStatus: status === "closed" ? null : (fields.phaseStatus ?? "ready"),
    assignee: fields.assignee ?? null,
    requirementRevision: 1,
    closureReason: status === "closed" ? "accepted" : null,
    relatedTasks: [],
    workflow: Object.fromEntries(order.map((name, position) => [name, record(position)])),
    history: [{ seq: 1, at: "2026-09-29T00:00:00Z", actor: "agent/codex", event: "create", phase: "plan", attempt: 1, outcome: null, from: null, to: "ready", reason: null, refersTo: null, refs: [] }],
    valid: true,
    readable: true,
    ...fields,
  });
}

export function qa(id: string, fields: Partial<QaRecord> = {}): QaRecord {
  const name = fields.name ?? id.toLowerCase();
  const job = fields.job ?? "PROJ-1";
  return {
    job,
    kind: "qa",
    id,
    name,
    path: `jobs/${job}/qa/${name}/index.md`,
    title: `質問 ${id}`,
    status: "unresolved",
    createdAt: "2026-09-28",
    updatedAt: "2026-09-28",
    requestedBy: "agent/claude",
    createdBy: "agent/claude",
    revision: `rev-${name}`,
    question: `質問 ${id}`,
    answer: null,
    askTo: "customer",
    answeredBy: null,
    resolvedAt: null,
    ...fields,
  };
}

export function snapshot(parts: { tasks?: TaskRecord[]; qas?: QaRecord[]; issues?: Issue[]; jobs?: string[] } = {}): Snapshot {
  const tasks = parts.tasks ?? [];
  const qas = parts.qas ?? [];
  const names = parts.jobs ?? [...new Set([...tasks, ...qas].map((record) => record.job))].sort();
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-28T00:00:00.000Z",
    scope: { job: null },
    jobs: names.map((name) => ({
      name,
      path: `jobs/${name}`,
      title: null,
      counts: {
        task: { total: tasks.filter((record) => record.job === name).length, byStatus: {} },
        qa: { total: qas.filter((record) => record.job === name).length, byStatus: {} },
      },
    })),
    tasks,
    qas,
    issues: parts.issues ?? [],
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, ng) => {
    resolve = ok;
    reject = ng;
  });
  return { promise, resolve, reject };
}

// 呼び出しを記録し、応答を試験側で決める backend
export class FakeBackend implements Backend {
  snapshotCalls: ReturnType<typeof deferred<Snapshot>>[] = [];
  showCalls: { kind: string; job: string; selector: string; reply: ReturnType<typeof deferred<ShowResult>> }[] = [];
  disposed = false;
  autoShow = true;
  current: Snapshot;

  constructor(initial: Snapshot) {
    this.current = initial;
  }

  capabilities(): Promise<string[]> {
    return Promise.resolve(["query-v1"]);
  }

  snapshot(): Promise<Snapshot> {
    const call = deferred<Snapshot>();
    this.snapshotCalls.push(call);
    return call.promise;
  }

  show(kind: "task" | "qa", job: string, selector: string): Promise<ShowResult> {
    const reply = deferred<ShowResult>();
    this.showCalls.push({ kind, job, selector, reply });
    if (this.autoShow) {
      const record = [...this.current.tasks, ...this.current.qas].find((item) => item.job === job && item.kind === kind && item.name === selector);
      if (record) reply.resolve(showOf(record));
      else reply.reject(new Error(`not found: ${selector}`));
    }
    return reply.promise;
  }

  writeCalls: { args: unknown[]; reply: ReturnType<typeof deferred<WriteResult>> }[] = [];

  resolveQa(job: string, selector: string, answer: string, answeredBy: string, revision: string): Promise<WriteResult> {
    const reply = deferred<WriteResult>();
    this.writeCalls.push({ args: ["resolveQa", job, selector, answer, answeredBy, revision], reply });
    return reply.promise;
  }

  moveTask(job: string, selector: string, status: string, blockedBy: string[] | undefined, revision: string): Promise<WriteResult> {
    const reply = deferred<WriteResult>();
    this.writeCalls.push({ args: ["moveTask", job, selector, status, blockedBy, revision], reply });
    return reply.promise;
  }

  workflowStep(job: string, selector: string, step: WorkflowStep, actor: string, revision: string): Promise<WriteResult> {
    const reply = deferred<WriteResult>();
    this.writeCalls.push({ args: ["workflowStep", job, selector, step, actor, revision], reply });
    return reply.promise;
  }

  dispose(): void {
    this.disposed = true;
  }
}

export function showOf(record: TaskRecord | QaRecord, body = `## タイトル\n\n${record.title}\n\n## 内容\n\n${record.name} の本文`): ShowResult {
  return { schemaVersion: 1, kind: record.kind, item: { ...record, rawMarkdown: `---\nid: ${record.id}\n---\n\n# 概要\n\n${body}\n` }, issues: [] };
}

export const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

// 実行時は build 済みの dist/ を読み、型は src/ から取る (typecheck を build に依存させない)
export function load<T>(path: string): Promise<T> {
  return import(new URL(path, import.meta.url).href) as Promise<T>;
}
