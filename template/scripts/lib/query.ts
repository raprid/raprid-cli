// 一覧・詳細・snapshot の絞り込みと JSON (schemaVersion 1 / query-v1) の組み立て。

import { CliError, UsageError } from "./errors.ts";
import { Job, type Kind } from "./jobs.ts";
import {
  type Collected,
  Collector,
  compareRecords,
  countRecords,
  type Issue,
  isKnownStatus,
  type ItemRecord,
  type JobData,
  type JobRecord,
  statusOrder,
} from "./records.ts";

export const schemaVersion = 1;
// query-v1: 一覧・詳細・snapshot の JSON。guarded-write-v1: --if-match・--answer-file・更新の --json
export const capabilities = ["query-v1", "guarded-write-v1"];

export interface ListFilter {
  statuses: ReadonlySet<string> | "all";
  search: string | undefined;
}

// task の既定は done 以外、QA の既定は unresolved
export function parseFilter(kind: Kind, values: { status?: string; all?: boolean; search?: string }): ListFilter {
  if (values.all && values.status !== undefined) throw new UsageError("--all と --status は同時に指定できません");
  if (values.search !== undefined && values.search.trim() === "") throw new UsageError("--search には空でない文字列を指定してください");
  const known = statusOrder[kind];
  let statuses: ReadonlySet<string> | "all";
  if (values.all) statuses = "all";
  else if (values.status !== undefined) {
    const list = values.status.split(",").map((value) => value.trim()).filter((value) => value !== "");
    if (list.length === 0) throw new UsageError(`--status には ${known.join(",")} をカンマ区切りで指定してください`);
    const unknown = list.filter((value) => !known.includes(value));
    if (unknown.length > 0) throw new UsageError(`不明な状態です: ${unknown.join(", ")} (指定できるのは ${known.join(", ")})`);
    statuses = new Set(list);
  } else statuses = new Set(kind === "task" ? known.filter((status) => status !== "done") : ["unresolved"]);
  return { statuses, search: values.search };
}

export function searchable(record: ItemRecord): string[] {
  const fields = [record.id, record.name, record.title];
  if (record.kind === "qa") fields.push(record.question);
  return fields.filter((value): value is string => value !== null);
}

// 未知の状態は隠さずに表示する (診断と一緒に末尾へ並ぶ)
export function matchesFilter(record: ItemRecord, filter: ListFilter): boolean {
  if (isKnownStatus(record.kind, record.status) && filter.statuses !== "all" && !filter.statuses.has(record.status!)) return false;
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

export function listJson(kind: Kind, groups: ListGroup[], extra: Issue[] = []): Record<string, unknown> {
  const all = groups.flatMap((group) => group.all);
  const shown = groups.flatMap((group) => group.shown);
  const counts = countRecords(kind, all);
  return {
    schemaVersion,
    kind,
    items: shown.map(recordJson),
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

export function showJson(entry: Collected, issues: Issue[]): Record<string, unknown> {
  return { schemaVersion, kind: entry.record.kind, item: { ...recordJson(entry.record), rawMarkdown: entry.text ?? null }, issues };
}

// TUI 用。絞り込み前の全状態を返す
export function snapshotJson(datas: JobData[], scope: string | null, extra: Issue[] = [], now = new Date()): Record<string, unknown> {
  const records = (kind: Kind) => datas.flatMap((data) => itemsOf(data, kind).map((entry) => entry.record)).sort(compareRecords).map(recordJson);
  return {
    schemaVersion,
    generatedAt: now.toISOString(),
    scope: { job: scope },
    jobs: datas.map((data) => jobJson(data.record)),
    tasks: records("task"),
    qas: records("qa"),
    issues: [...issuesOf(datas), ...extra],
  };
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function errorJson(code: string, message: string): Record<string, unknown> {
  return { schemaVersion, error: { code, message } };
}
