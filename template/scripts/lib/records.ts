// タスク・QA・案件を読み取り、表示と JSON に共通のレコードと診断 (issues) を作る。
// 整形はしない (表示は lib/view.ts、JSON の組み立ては lib/query.ts)。
//
// 各 index.md は 1 回だけ読み、同じバイト列から frontmatter・本文・revision を得る。
// 壊れたファイルや走査中の削除があっても止めず、issues に記録して続ける。

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync, type Dirent } from "node:fs";
import { join, relative } from "node:path";
import { CliError } from "./errors.ts";
import { Frontmatter, FrontmatterError } from "./frontmatter.ts";
import { isDirectory, isFile } from "./fsutil.ts";
import { compareText, Job, type Kind, qaStatuses, taskStatuses } from "./jobs.ts";
import { fencedLines, findSection, splitLines } from "./markdown.ts";

export type Severity = "warning" | "error";

export interface Issue {
  code: string;
  severity: Severity;
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

// 収集結果。issues の owner は対象の実体名 (show で絞り込むため。JSON には出さない)
export interface Collected {
  record: ItemRecord;
  text: string | undefined;
  parsed: boolean;
}

export interface OwnedIssue {
  issue: Issue;
  owner?: { kind: Kind; name: string };
}

export interface JobData {
  job: Job;
  record: JobRecord;
  tasks: Collected[];
  qas: Collected[];
  issues: OwnedIssue[];
}

export const statusOrder: Record<Kind, readonly string[]> = {
  task: ["progress", "todo", "pending", "done"],
  qa: ["unresolved", "resolved"],
};

export const idPatterns: Record<Kind, RegExp> = { task: /^T-(\d{3,})$/, qa: /^Q-(\d{3,})$/ };

export { compareText };

function idNumber(record: ItemRecord): number {
  const match = record.id === null ? null : idPatterns[record.kind].exec(record.id);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

export function isKnownStatus(kind: Kind, status: string | null): boolean {
  return status !== null && statusOrder[kind].includes(status);
}

// 案件名 → 状態 (progress…、未知は末尾) → 数値ID → パス の順
export function compareRecords(a: ItemRecord, b: ItemRecord): number {
  if (a.job !== b.job) return compareText(a.job, b.job);
  const order = statusOrder[a.kind];
  const rank = (record: ItemRecord) => (isKnownStatus(record.kind, record.status) ? order.indexOf(record.status!) : order.length);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const [idA, idB] = [idNumber(a), idNumber(b)];
  if (idA !== idB) return idA < idB ? -1 : 1;
  return compareText(a.path, b.path);
}

export function sectionText(text: string, heading: string): string | null {
  const lines = splitLines(text);
  const section = findSection(lines, 2, heading);
  if (!section) return null;
  const body = lines.slice(section.start + 1, section.end);
  while (body.length > 0 && body[0].trim() === "") body.shift();
  while (body.length > 0 && body.at(-1)!.trim() === "") body.pop();
  return body.length > 0 ? body.join("\n") : null;
}

function firstNonEmpty(text: string | null): string | null {
  if (text === null) return null;
  const lines = splitLines(text);
  const fenced = fencedLines(lines);
  const found = lines.find((line, index) => !fenced[index] && line.trim() !== "");
  return found === undefined ? null : found.trim();
}

function blank(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

export function answerOf(text: string): string | null {
  const answer = sectionText(text, "回答内容");
  if (answer === null || ["未回答", "未回答。"].includes(answer.trim())) return null;
  return answer;
}

function emptyCounts(kind: Kind): StatusCounts {
  return { total: 0, byStatus: Object.fromEntries([...statusOrder[kind], "unknown"].map((status) => [status, 0])) };
}

export function countRecords(kind: Kind, records: ItemRecord[]): StatusCounts {
  const counts = emptyCounts(kind);
  for (const record of records) {
    counts.total++;
    const key = isKnownStatus(kind, record.status) ? record.status! : "unknown";
    counts.byStatus[key]++;
  }
  return counts;
}

function readDir(path: string): Dirent[] | undefined {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
}

// 案件ごとの収集結果をキャッシュし、別案件の QA 参照も同じ読取結果で解決する
export class Collector {
  readonly root: string;
  // 案件に属さない診断 (案件名として扱えないディレクトリなど)。全案件を対象にしたときだけ出す
  readonly rootIssues: Issue[] = [];
  private cache = new Map<string, JobData>();

  constructor(root: string) {
    this.root = root;
  }

  rel(path: string): string {
    return relative(this.root, path).split("\\").join("/");
  }

  // jobs/ 直下の案件 (名前順)。案件名として扱えないディレクトリは止めずに報告する
  jobs(): Job[] {
    const entries = readDir(join(this.root, "jobs"));
    if (!entries) throw new CliError("jobs/ が見つかりません", 1, "JOBS_DIR_MISSING");
    const jobs: Job[] = [];
    this.rootIssues.length = 0;
    for (const entry of entries.filter((dirent) => dirent.isDirectory() && !dirent.name.startsWith(".")).sort((a, b) => compareText(a.name, b.name))) {
      try {
        jobs.push(new Job(this.root, entry.name));
      } catch {
        const path = `jobs/${entry.name}`;
        this.rootIssues.push({ code: "JOB_NAME_INVALID", severity: "warning", job: entry.name, kind: "job", id: null, path, message: `案件名として扱えないディレクトリ: ${path}` });
      }
    }
    return jobs;
  }

  job(job: Job): JobData {
    const cached = this.cache.get(job.name);
    if (cached) return cached;
    const data = this.collectItems(job);
    this.cache.set(job.name, data);
    this.inspectTasks(data);
    return data;
  }

  private issue(list: OwnedIssue[], issue: Omit<Issue, "severity"> & { severity?: Severity }, owner?: { kind: Kind; name: string }): void {
    list.push({ issue: { code: issue.code, severity: issue.severity ?? "warning", job: issue.job, kind: issue.kind, id: issue.id, path: issue.path, message: issue.message }, owner });
  }

  private collectItems(job: Job): JobData {
    const issues: OwnedIssue[] = [];
    const collected: Record<Kind, Collected[]> = { task: [], qa: [] };
    for (const kind of ["task", "qa"] as const) {
      const dir = job.itemsDir(kind);
      const entries = readDir(dir);
      if (!entries) {
        this.issue(issues, { code: "STRUCTURE_MISSING", severity: "error", job: job.name, kind, id: null, path: this.rel(dir), message: `構成が不完全です: ${this.rel(dir)}` });
        continue;
      }
      const names = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !(kind === "qa" && entry.name === "status"))
        .map((entry) => entry.name)
        .sort(compareText);
      for (const name of names) collected[kind].push(this.readItem(job, kind, name, issues));
      this.inspectIds(job, kind, collected[kind], issues);
      this.inspectLinks(job, kind, collected[kind], issues);
    }
    const title = this.jobTitle(job);
    const record: JobRecord = {
      name: job.name,
      path: this.rel(job.dir),
      title,
      counts: { task: countRecords("task", collected.task.map((entry) => entry.record)), qa: countRecords("qa", collected.qa.map((entry) => entry.record)) },
    };
    return { job, record, tasks: collected.task, qas: collected.qa, issues };
  }

  private jobTitle(job: Job): string | null {
    for (const file of ["README.md", "MEMORY.md"]) {
      const path = join(job.dir, file);
      if (!isFile(path)) continue;
      try {
        const heading = /^#\s+(.+?)\s*$/m.exec(readFileSync(path, "utf8"));
        if (heading) return heading[1];
      } catch {
        // 読めない案件の説明は表示しないだけ
      }
    }
    return null;
  }

  private readItem(job: Job, kind: Kind, name: string, issues: OwnedIssue[]): Collected {
    const index = join(job.itemsDir(kind), name, "index.md");
    const path = this.rel(index);
    const owner = { kind, name };
    const base = { job: job.name, name, path, title: null, status: null, createdAt: null, updatedAt: null, requestedBy: null, createdBy: null, revision: null, id: null };
    const empty: ItemRecord =
      kind === "task"
        ? { ...base, kind, completedAt: null, blockedBy: [] }
        : { ...base, kind, question: null, answer: null, askTo: null, answeredBy: null, resolvedAt: null };
    let bytes: Buffer;
    try {
      bytes = readFileSync(index);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        this.issue(issues, { code: "INDEX_MISSING", severity: "error", job: job.name, kind, id: null, path: this.rel(join(job.itemsDir(kind), name)), message: `index.md が無い: ${this.rel(join(job.itemsDir(kind), name))}` }, owner);
      } else {
        this.issue(issues, { code: "READ_ERROR", severity: "error", job: job.name, kind, id: null, path, message: `読み取れません: ${path} (${code ?? String(error)})` }, owner);
      }
      return { record: empty, text: undefined, parsed: false };
    }
    const text = bytes.toString("utf8");
    const revision = createHash("sha256").update(bytes).digest("hex");
    let fm: Frontmatter;
    try {
      fm = Frontmatter.parse(text, path);
    } catch (error) {
      if (!(error instanceof FrontmatterError)) throw error;
      this.issue(issues, { code: "PARSE_ERROR", severity: "error", job: job.name, kind, id: null, path, message: error.message }, owner);
      const title = kind === "task" ? firstNonEmpty(sectionText(text, "タイトル")) : firstNonEmpty(sectionText(text, "質問内容"));
      return { record: { ...empty, title, revision }, text, parsed: false };
    }
    const field = (key: string) => blank(fm.get(key));
    const common = {
      job: job.name,
      id: field("id"),
      name,
      path,
      status: field("status"),
      createdAt: field("createdAt"),
      updatedAt: field("updatedAt"),
      requestedBy: field("requestedBy"),
      createdBy: field("createdBy"),
      revision,
    };
    if (kind === "task") {
      let blockedBy: string[] = [];
      try {
        blockedBy = fm.getList("blockedBy") ?? [];
      } catch (error) {
        if (!(error instanceof FrontmatterError)) throw error;
        this.issue(issues, { code: "PARSE_ERROR", severity: "error", job: job.name, kind, id: common.id, path, message: `${error.message}: ${path}` }, owner);
      }
      const record: TaskRecord = { ...common, kind, title: firstNonEmpty(sectionText(text, "タイトル")), completedAt: field("completedAt"), blockedBy };
      return { record, text, parsed: true };
    }
    const question = sectionText(text, "質問内容");
    const record: QaRecord = {
      ...common,
      kind,
      title: firstNonEmpty(question),
      question,
      answer: answerOf(text),
      askTo: field("askTo"),
      answeredBy: field("answeredBy"),
      resolvedAt: field("resolvedAt"),
    };
    const declaredJob = field("job");
    if (declaredJob !== null && declaredJob !== job.name) {
      this.issue(issues, { code: "QA_JOB_MISMATCH", job: job.name, kind, id: record.id, path, message: `frontmatter の job が案件と異なる: ${name} (job: ${declaredJob})` }, owner);
    }
    return { record, text, parsed: true };
  }

  private inspectIds(job: Job, kind: Kind, items: Collected[], issues: OwnedIssue[]): void {
    const byId = new Map<string, Collected[]>();
    for (const entry of items) {
      const { record } = entry;
      if (!entry.parsed) continue; // 読めない・frontmatter が壊れているものは報告済み
      const owner = { kind, name: record.name };
      if (record.id === null || !idPatterns[kind].test(record.id)) {
        this.issue(issues, { code: record.id === null ? "ID_MISSING" : "ID_INVALID", severity: "error", job: job.name, kind, id: record.id, path: record.path, message: `IDが未設定または不正: ${record.name} (${record.id ?? "未設定"})` }, owner);
      } else {
        byId.set(record.id, [...(byId.get(record.id) ?? []), entry]);
      }
      if (!isKnownStatus(kind, record.status)) {
        this.issue(issues, { code: "STATUS_UNKNOWN", job: job.name, kind, id: record.id, path: record.path, message: `status が未設定または不明: ${record.name} (status: ${record.status ?? "未設定"})` }, owner);
      }
      if (kind === "task" && record.status === "pending" && (record as TaskRecord).blockedBy.length === 0) {
        this.issue(issues, { code: "PENDING_WITHOUT_BLOCKER", job: job.name, kind, id: record.id, path: record.path, message: `pending なのに blockedBy が空: ${record.name}` }, owner);
      }
    }
    for (const [id, entries] of byId) {
      if (entries.length < 2) continue;
      const names = entries.map((entry) => entry.record.name).join(", ");
      for (const entry of entries) {
        this.issue(issues, { code: "ID_DUPLICATE", severity: "error", job: job.name, kind, id, path: entry.record.path, message: `ID重複: ${id} (${names})` }, { kind, name: entry.record.name });
      }
    }
  }

  private inspectLinks(job: Job, kind: Kind, items: Collected[], issues: OwnedIssue[]): void {
    const found = new Map<string, { status: string; path: string; target: string | undefined }[]>();
    const names = new Set(items.map((entry) => entry.record.name));
    for (const status of kind === "task" ? taskStatuses : qaStatuses) {
      const dir = job.statusDir(kind, status);
      const entries = readDir(dir);
      if (!entries) {
        this.issue(issues, { code: "STATUS_DIR_MISSING", severity: "error", job: job.name, kind, id: null, path: this.rel(dir), message: `状態ディレクトリが見つかりません: ${this.rel(dir)}` });
        continue;
      }
      for (const entry of entries.sort((a, b) => compareText(a.name, b.name))) {
        if (entry.name === ".gitkeep") continue;
        const path = join(dir, entry.name);
        if (!names.has(entry.name)) {
          this.issue(issues, { code: "LINK_ORPHAN", job: job.name, kind, id: null, path: this.rel(path), message: `実体のない索引: ${this.rel(path)}` });
          continue;
        }
        const record = items.find((item) => item.record.name === entry.name)!.record;
        if (!entry.isSymbolicLink()) {
          this.issue(issues, { code: "LINK_NOT_SYMLINK", severity: "error", job: job.name, kind, id: record.id, path: this.rel(path), message: `状態索引にリンク以外があります: ${this.rel(path)}` }, { kind, name: entry.name });
          found.set(entry.name, [...(found.get(entry.name) ?? []), { status, path, target: undefined }]);
          continue;
        }
        let target: string | undefined;
        try {
          target = readlinkSync(path);
        } catch {
          target = undefined; // 走査中に消えた
        }
        found.set(entry.name, [...(found.get(entry.name) ?? []), { status, path, target }]);
      }
    }
    for (const { record } of items) {
      const links = found.get(record.name) ?? [];
      const owner = { kind, name: record.name };
      const status = record.status ?? "未設定";
      if (links.length === 0) this.issue(issues, { code: "LINK_MISSING", job: job.name, kind, id: record.id, path: record.path, message: `索引なし: ${record.name} (status: ${status})` }, owner);
      if (links.length > 1) this.issue(issues, { code: "LINK_MULTIPLE", job: job.name, kind, id: record.id, path: record.path, message: `索引が複数: ${record.name} (${links.map((link) => link.status).join(", ")})` }, owner);
      for (const link of links) {
        if (link.target === undefined) continue;
        if (link.target !== job.linkTarget(kind, record.name)) {
          this.issue(issues, { code: "LINK_TARGET_INVALID", severity: "error", job: job.name, kind, id: record.id, path: this.rel(link.path), message: `リンク先が不正: ${this.rel(link.path)} -> ${link.target}` }, owner);
        } else if (link.status !== record.status) {
          this.issue(issues, { code: "LINK_MISMATCH", job: job.name, kind, id: record.id, path: this.rel(link.path), message: `索引の不一致: ${record.name} (索引: ${link.status}, status: ${status})` }, owner);
        }
      }
    }
  }

  // pending のタスクが待っている QA を確かめる。別案件の QA は必要な案件だけ読む
  private inspectTasks(data: JobData): void {
    for (const { record } of data.tasks) {
      if (record.status !== "pending" || record.kind !== "task") continue;
      for (const reference of record.blockedBy) {
        const resolved = this.resolveQa(data.job, reference);
        if (resolved.state === "not-qa" || resolved.state === "unresolved") continue;
        const owner = { kind: "task" as const, name: record.name };
        const base = { job: data.job.name, kind: "task" as const, id: record.id, path: record.path };
        if (resolved.state === "resolved") this.issue(data.issues, { ...base, code: "QA_REF_RESOLVED", message: `解決済みQAを待機中: ${record.name} (${reference})` }, owner);
        else if (resolved.state === "invalid-status") this.issue(data.issues, { ...base, code: "QA_REF_INVALID_STATUS", message: `状態が不正なQAを待機中: ${record.name} (${reference})` }, owner);
        else if (resolved.state === "ambiguous") this.issue(data.issues, { ...base, code: "QA_REF_AMBIGUOUS", message: `参照先QAが特定できない: ${record.name} (${reference})` }, owner);
        else this.issue(data.issues, { ...base, code: "QA_REF_NOT_FOUND", message: `参照先QAが見つからない: ${record.name} (${reference})` }, owner);
      }
    }
  }

  // qa/Q-001・qa/<名前> は同じ案件、qa/<案件名>/Q-001 は別案件の QA
  resolveQa(job: Job, reference: string): { state: "not-qa" | "unresolved" | "resolved" | "invalid-status" | "ambiguous" | "not-found"; record?: QaRecord } {
    const parts = reference.split("/");
    if (parts[0] !== "qa" || parts.length < 2 || parts.length > 3) return { state: "not-qa" };
    const jobName = parts.length === 3 ? parts[1] : job.name;
    const selector = parts.at(-1)!;
    let target: JobData;
    try {
      if (jobName === job.name) target = this.cache.get(job.name) ?? this.job(job);
      else {
        const other = new Job(this.root, jobName);
        if (!isDirectory(other.dir)) return { state: "not-found" };
        target = this.job(other);
      }
    } catch {
      return { state: "not-found" };
    }
    const matches = idPatterns.qa.test(selector)
      ? target.qas.filter((entry) => entry.record.id === selector)
      : target.qas.filter((entry) => entry.record.name === selector && entry.record.revision !== null);
    if (matches.length === 0) return { state: "not-found" };
    if (matches.length > 1) return { state: "ambiguous" };
    const record = matches[0].record as QaRecord;
    if (record.status === "resolved") return { state: "resolved", record };
    if (record.status === "unresolved") return { state: "unresolved", record };
    return { state: "invalid-status", record };
  }
}
