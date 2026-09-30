// タスク・QA・案件を読み取り、表示と JSON に共通のレコードと診断 (issues) を作る。
// 整形はしない (表示は lib/view.ts、JSON の組み立ては lib/query.ts)。
//
// 各 index.md は 1 回だけ読み、同じバイト列から frontmatter・本文・revision を得る。
// 壊れたファイルや走査中の削除があっても止めず、issues に記録して続ける。

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, type Dirent } from "node:fs";
import { dirname, join, relative } from "node:path";
import { CliError } from "./errors.ts";
import { Frontmatter, FrontmatterError } from "./frontmatter.ts";
import { isDirectory, isFile, lstatOrUndefined } from "./fsutil.ts";
import { compareText, Job, type Kind, qaStatuses, taskStatuses } from "./jobs.ts";
import { answerBegin, answerEnd } from "./guard.ts";
import { fencedLines, findSection, splitLines } from "./markdown.ts";
import { workIndexPhases, workIndexStatuses, workLinkPath, workLinkTarget } from "./workindex.ts";
import { hasWorkflowVersion } from "./taskformat.ts";
import { approvalQueueDir, approvalQueueLinkTarget, approvalWorkLinkPath, checkTaskDecisions, parseApprovalQueueLinkName } from "./decision.ts";
import { pendingJournals } from "./journal.ts";
import { readDecisionFiles } from "./taskflow-v4.ts";
import { approvalPhases, readTaskFile, type TaskV4, waitingOfV4, type WaitingV4 } from "./workflow.ts";

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
  workflow: WorkflowInfo | null; // 工程型 (workflowVersion 2・3・4) のタスクだけ。旧形式は null
}

// v4 のタスクの判断記録 (decisions/<工程>-<試行>.md) の要約。正は各記録の frontmatter
export interface DecisionInfo {
  id: string; // ファイル名 (拡張子を除く)
  path: string; // 管理リポジトリ直下からのパス
  revision: string | null; // ファイルのバイト列の SHA-256 (--record-match)。通常のファイルとして読めなければ null
  data: Record<string, unknown> | null; // frontmatter。読めなければ null
  body: string | null; // frontmatter を除く本文 (人のメモ)
  valid: boolean; // 記録そのものの規則と、タスクとの照合 (03 の 4 の 1〜4) に問題が無い
  current: boolean; // タスクが今この記録を待っている (タスク pending で、工程の approval と blockedBy が指す)
}

// 工程型のタスクの要約。status (open / closed、v4 は pending も) は BaseRecord の status と同じ値
export interface WorkflowInfo {
  version: number; // 2・3・4 (対応していない版はその値)
  type: string | null; // v3 の種別 (research / implementation)
  phase: string | null; // 今の工程 (closed は null)
  phaseStatus: string | null; // 今の工程の状態
  assignee: string | null; // 今の工程の担当
  requirementRevision: number | null;
  closureReason: string | null;
  relatedTasks: string[];
  data: Record<string, unknown>; // frontmatter 全体 (workflow・history を含む)
  valid: boolean; // 形式の規則を満たす (満たさなければ issues に WF_… を出す。v4 は判断記録との照合も含む)
  readable: boolean; // frontmatter を読めた (読めなければ PARSE_ERROR。それでも工程型として扱い、旧形式の JSON に出さない)
  // 以下は v4 だけ (v2・v3 は null・[])。AI 工程の軸 (phase・phaseStatus・assignee) と、タスクの軸の人の確認待ちを分ける
  waiting: WaitingV4; // 人の確認待ち (approval) か外部の待ち (external) か null
  approvers: Record<string, unknown> | null;
  decisions: DecisionInfo[];
}

// v4 のタスクの人の確認待ち (タスクの pending)。AI 工程は done のまま
export function isAwaitingApproval(record: ItemRecord): boolean {
  return isWorkflow(record) && record.workflow.version === 4 && record.status === "pending";
}

// 一覧の --status・並び順に使う状態。工程型は今の工程の状態で、v4 の人の確認待ちは approval (AI 工程の done と区別する)
export function workflowFilterStatus(record: TaskRecord & { workflow: WorkflowInfo }): string | null {
  if (isAwaitingApproval(record)) return "approval";
  return record.workflow.phaseStatus;
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

export { compareText, hasWorkflowVersion };

function idNumber(record: ItemRecord): number {
  const match = record.id === null ? null : idPatterns[record.kind].exec(record.id);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

export function isKnownStatus(kind: Kind, status: string | null): boolean {
  return status !== null && statusOrder[kind].includes(status);
}

export function isWorkflow(record: ItemRecord): record is TaskRecord & { workflow: WorkflowInfo } {
  return record.kind === "task" && record.workflow !== null;
}

// 並び順の上での状態。工程型は今の工程の状態を旧形式の状態の順 (progress → todo → pending → done) に当てはめる
function rankStatus(record: ItemRecord): string | null {
  if (!isWorkflow(record)) return record.status;
  if (record.status === "closed") return "done";
  return { progress: "progress", ready: "todo", pending: "pending", approval: "pending" }[workflowFilterStatus(record) ?? ""] ?? null;
}

// 案件名 → 状態 (progress…、未知は末尾) → 数値ID → パス の順
export function compareRecords(a: ItemRecord, b: ItemRecord): number {
  if (a.job !== b.job) return compareText(a.job, b.job);
  const order = statusOrder[a.kind];
  const rank = (record: ItemRecord) => {
    const status = rankStatus(record);
    return status !== null && order.includes(status) ? order.indexOf(status) : order.length;
  };
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

// 回答内容。--answer-file の回答は区切り行で囲むので、見出しやコードブロックを含んでも途中で切れない
export function answerOf(text: string): string | null {
  const lines = splitLines(text);
  const section = findSection(lines, 2, "回答内容");
  if (section) {
    let first = section.start + 1;
    while (first < lines.length && lines[first].trim() === "") first++;
    if (lines[first]?.trim() === answerBegin) {
      const end = lines.findIndex((line, index) => index > first && line.trim() === answerEnd);
      if (end > first) return lines.slice(first + 1, end).join("\n");
    }
  }
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
    // 工程型は open / closed (v4 は人の確認待ちの pending も) で数える (旧形式だけの案件では項目が増えない)
    if (isWorkflow(record)) {
      const key = record.status === "open" || record.status === "closed" || (record.status === "pending" && record.workflow.version === 4) ? record.status : "unknown";
      counts.byStatus[key] = (counts.byStatus[key] ?? 0) + 1;
      continue;
    }
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

// v4 のタスクのあるべき作業索引。open は status/<工程>/<工程の状態>/、人の確認待ちは status/approval/<工程>/、closed は無し。
// 形式が不正でも、読めた値から決まる範囲で照合する (決まらなければ null で、LINK_MISSING を出さない)
function expectedV4(jobDir: string, record: TaskRecord & { workflow: WorkflowInfo }): string | null {
  const { phase, phaseStatus } = record.workflow;
  if (phase === null) return null;
  if (record.status === "open" && phaseStatus !== null) return workLinkPath(jobDir, phase, phaseStatus, record.name);
  if (record.status === "pending" && (approvalPhases as readonly string[]).includes(phase)) return approvalWorkLinkPath(jobDir, phase as "plan" | "review", record.name);
  return null;
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
    this.inspectQueueLinks(job, collected.task, issues);
    this.inspectJournals(job, collected.task, issues);
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
        ? { ...base, kind, completedAt: null, blockedBy: [], workflow: null }
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
    if (kind === "task" && hasWorkflowVersion(text)) return this.readWorkflowTask(job, name, path, text, revision, issues);
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
      const record: TaskRecord = { ...common, kind, title: firstNonEmpty(sectionText(text, "タイトル")), completedAt: field("completedAt"), blockedBy, workflow: null };
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

  // 工程型 (workflowVersion のある) タスク。入れ子の frontmatter を読み、形式の規則の違反を WF_… の診断にする
  private readWorkflowTask(job: Job, name: string, path: string, text: string, revision: string, issues: OwnedIssue[]): Collected {
    const owner = { kind: "task" as const, name };
    const title = firstNonEmpty(sectionText(text, "タイトル"));
    const empty: TaskRecord = { job: job.name, kind: "task", id: null, name, path, title, status: null, createdAt: null, updatedAt: null, requestedBy: null, createdBy: null, revision, completedAt: null, blockedBy: [], workflow: null };
    let read: ReturnType<typeof readTaskFile>;
    try {
      read = readTaskFile(text, path);
    } catch (error) {
      if (!(error instanceof FrontmatterError)) throw error;
      this.issue(issues, { code: "PARSE_ERROR", severity: "error", job: job.name, kind: "task", id: null, path, message: error.message }, owner);
      // workflowVersion の行があるので工程型と判定したまま返す (旧形式として schemaVersion 1 に出さない。R14-2)
      const declared = /^\s*["']?workflowVersion["']?\s*:\s*(\d+)\b/m.exec(text);
      const unreadable: WorkflowInfo = { version: declared ? Number(declared[1]) : Number.NaN, type: null, phase: null, phaseStatus: null, assignee: null, requirementRevision: null, closureReason: null, relatedTasks: [], data: {}, valid: false, readable: false, waiting: null, approvers: null, decisions: [] };
      return { record: { ...empty, workflow: unreadable }, text, parsed: false };
    }
    const data = read.frontmatter.data();
    const text1 = (key: string) => (typeof data[key] === "string" && data[key] !== "" ? (data[key] as string) : null);
    const list = (key: string) => (Array.isArray(data[key]) ? (data[key] as unknown[]).filter((value): value is string => typeof value === "string") : []);
    const phase = text1("phase");
    const workflow = (data.workflow ?? {}) as Record<string, Record<string, unknown> | undefined>;
    const current = phase !== null ? workflow[phase] : undefined;
    const version = typeof data.workflowVersion === "number" ? data.workflowVersion : Number.NaN;
    // workflowVersion のキーがあるのに値が空なら、形式の判定は旧形式になるが、旧形式としては扱わない
    const found = read.format.kind === "legacy" ? [{ code: "WF_VERSION", path: "workflowVersion", message: "workflowVersion が空です (工程型のタスクとして読めません)" }] : read.issues;
    for (const each of found) {
      this.issue(issues, { code: each.code, severity: "error", job: job.name, kind: "task", id: text1("id"), path, message: `${each.path}: ${each.message}` }, owner);
    }
    // v4: 判断記録を読み、タスクとの照合 (古い版・古い提出・孤立・閉じた記録) を診断にする。タスク自体が不正なら照合しない
    const v4 = read.format.kind === "v4";
    const decisions = v4 ? this.readDecisions(job, name, found.length === 0 ? (data as unknown as TaskV4) : null, text1("id"), issues) : [];
    const decisionsValid = decisions.every((decision) => decision.valid);
    const record: TaskRecord = {
      job: job.name,
      kind: "task",
      id: text1("id"),
      name,
      path,
      title,
      status: text1("status"),
      createdAt: text1("createdAt"),
      updatedAt: text1("updatedAt"),
      requestedBy: text1("requestedBy"),
      createdBy: text1("createdBy"),
      revision,
      completedAt: text1("completedAt"),
      blockedBy: list("blockedBy"),
      workflow: {
        version,
        type: text1("type"),
        phase,
        phaseStatus: typeof current?.status === "string" ? current.status : null,
        assignee: typeof current?.assignee === "string" ? current.assignee : null,
        requirementRevision: typeof data.requirementRevision === "number" ? data.requirementRevision : null,
        closureReason: text1("closureReason"),
        relatedTasks: list("relatedTasks"),
        data,
        valid: found.length === 0 && decisionsValid,
        readable: true,
        waiting: v4 && found.length === 0 ? waitingOfV4(data as unknown as TaskV4) : null,
        approvers: v4 && data.approvers !== null && typeof data.approvers === "object" && !Array.isArray(data.approvers) ? (data.approvers as Record<string, unknown>) : null,
        decisions,
      },
    };
    return { record, text, parsed: true };
  }

  // v4 のタスクの decisions/ を読む。task が null (タスク自体が不正) なら記録そのものの規則だけを確かめる
  private readDecisions(job: Job, name: string, task: TaskV4 | null, id: string | null, issues: OwnedIssue[]): DecisionInfo[] {
    const owner = { kind: "task" as const, name };
    const taskDir = join(job.itemsDir("task"), name);
    // 置き場所がリンク・ファイルなら中を読まない (書き込みは T-021 の assertRealDir が止める)。空として黙って扱わずに報告する
    const dir = join(taskDir, "decisions");
    const stat = lstatOrUndefined(dir);
    if (stat && !stat.isDirectory()) {
      this.issue(issues, { code: "WF_DECISION", severity: "error", job: job.name, kind: "task", id, path: this.rel(dir), message: `判断記録の置き場所 (decisions) が実際のディレクトリではないので読みません: ${this.rel(dir)}` }, owner);
    }
    let files: ReturnType<typeof readDecisionFiles>;
    try {
      files = readDecisionFiles(taskDir);
    } catch (error) {
      const path = this.rel(join(taskDir, "decisions"));
      this.issue(issues, { code: "READ_ERROR", severity: "error", job: job.name, kind: "task", id, path, message: `判断記録を読み取れません: ${path} (${(error as NodeJS.ErrnoException).code ?? String(error)})` }, owner);
      return [];
    }
    const found = task ? checkTaskDecisions(task, files) : [];
    const invalid = new Set<string>();
    for (const each of found) {
      // checkTaskDecisions の path は decisions/<ID>.md[: 項目] か、タスクの項目 (history[…] など)
      const match = /^decisions\/([^:]+)\.md/.exec(each.path);
      if (match) invalid.add(match[1]);
      const path = match ? this.rel(join(taskDir, "decisions", `${match[1]}.md`)) : this.rel(join(taskDir, "index.md"));
      this.issue(issues, { code: each.code, severity: "error", job: job.name, kind: "task", id, path, message: `${each.path}: ${each.message}` }, owner);
    }
    const waitingId = task && task.status === "pending" && task.phase !== null && (approvalPhases as readonly string[]).includes(task.phase) ? task.workflow[task.phase as "plan" | "review"].approval : null;
    return files.map((file) => {
      const data = file.data !== undefined && file.data !== null && typeof file.data === "object" ? (file.data as Record<string, unknown>) : null;
      let body: string | null = null;
      if (file.bytes) {
        const text = file.bytes.toString("utf8");
        const lines = text.split(/\r?\n/);
        const close = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
        body = close < 0 ? null : lines.slice(close + 1).join("\n").replace(/^\n+/, "");
      }
      return {
        id: file.id,
        path: this.rel(file.path),
        revision: file.bytes ? createHash("sha256").update(file.bytes).digest("hex") : null,
        data,
        body,
        // 記録そのものの規則は checkTaskDecisions が確かめる。タスクが不正なら照合できないので有効としない
        valid: task !== null && data !== null && !invalid.has(file.id),
        current: waitingId !== null && waitingId === file.id,
      };
    });
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
      if (isWorkflow(record)) continue; // 状態・待ちの整合は形式の検証 (WF_…) で報告済み
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
    if (kind === "task") this.inspectWorkLinks(job, items, found, issues);
    for (const { record } of items) {
      if (isWorkflow(record)) continue; // 工程型は作業索引で確かめる
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

  // 工程型のタスクの作業索引 (status/<工程>/<工程の状態>/<名前>)。open は今の工程と状態のリンクが 1 つだけ、closed は 0 件。
  // 旧形式の索引 (legacy) に工程型のタスクがあれば不整合。リンクの有無から状態を推測しない
  private inspectWorkLinks(job: Job, items: Collected[], legacy: Map<string, { status: string; path: string; target: string | undefined }[]>, issues: OwnedIssue[]): void {
    const names = new Map(items.map((entry) => [entry.record.name, entry.record]));
    const found = new Map<string, { path: string; target: string | undefined; symlink: boolean }[]>();
    // v2・v3・v4 の工程と状態 (status/<工程>/<工程の状態>/) と、v4 の人の確認待ち (status/approval/<工程>/)
    const dirs = [...workIndexPhases.flatMap((phase) => workIndexStatuses.map((status) => join(job.dir, "status", phase, status))), ...approvalPhases.map((phase) => dirname(approvalWorkLinkPath(job.dir, phase, "x")))];
    {
      for (const dir of dirs) {
        for (const entry of (readDir(dir) ?? []).sort((a, b) => compareText(a.name, b.name))) {
          if (entry.name === ".gitkeep") continue;
          const path = join(dir, entry.name);
          if (!names.has(entry.name)) {
            this.issue(issues, { code: "LINK_ORPHAN", job: job.name, kind: "task", id: null, path: this.rel(path), message: `実体のない索引: ${this.rel(path)}` });
            continue;
          }
          let target: string | undefined;
          try {
            target = entry.isSymbolicLink() ? readlinkSync(path) : undefined;
          } catch {
            target = undefined;
          }
          found.set(entry.name, [...(found.get(entry.name) ?? []), { path, target, symlink: entry.isSymbolicLink() }]);
        }
      }
    }
    for (const { record } of items) {
      const links = found.get(record.name) ?? [];
      const owner = { kind: "task" as const, name: record.name };
      const base = { job: job.name, kind: "task" as const, id: record.id };
      if (!isWorkflow(record)) {
        for (const link of links) this.issue(issues, { ...base, code: "LINK_MISMATCH", path: this.rel(link.path), message: `旧形式のタスクが作業索引にあります: ${this.rel(link.path)}` }, owner);
        continue;
      }
      for (const link of legacy.get(record.name) ?? []) {
        this.issue(issues, { ...base, code: "LINK_MISMATCH", path: this.rel(link.path), message: `工程型のタスクが旧形式の状態索引にあります: ${this.rel(link.path)}` }, owner);
      }
      if (!record.workflow.readable) continue; // 読めないので正しい索引が決まらない (PARSE_ERROR で報告済み)
      // v4 は人の確認待ち (タスクの pending) なら status/approval/<工程>/<名前>。形式が不正で決まらなければ推測しない
      const v4 = record.workflow.version === 4;
      const expected = v4
        ? expectedV4(job.dir, record)
        : record.status === "open" && record.workflow.phase !== null && record.workflow.phaseStatus !== null
          ? workLinkPath(job.dir, record.workflow.phase, record.workflow.phaseStatus, record.name)
          : null;
      const where = isAwaitingApproval(record) ? `approval/${record.workflow.phase}` : `${record.workflow.phase}/${record.workflow.phaseStatus}`;
      if (expected !== null && links.length === 0) this.issue(issues, { ...base, code: "LINK_MISSING", path: record.path, message: `作業索引なし: ${record.name} (${where})` }, owner);
      if (links.length > 1) this.issue(issues, { ...base, code: "LINK_MULTIPLE", path: record.path, message: `作業索引が複数: ${record.name} (${links.map((link) => this.rel(link.path)).join(", ")})` }, owner);
      for (const link of links) {
        if (!link.symlink) {
          this.issue(issues, { ...base, code: "LINK_NOT_SYMLINK", severity: "error", path: this.rel(link.path), message: `作業索引にリンク以外があります: ${this.rel(link.path)}` }, owner);
        } else if (link.target !== undefined && link.target !== workLinkTarget(record.name)) {
          this.issue(issues, { ...base, code: "LINK_TARGET_INVALID", severity: "error", path: this.rel(link.path), message: `リンク先が不正: ${this.rel(link.path)} -> ${link.target}` }, owner);
        } else if (expected === null) {
          this.issue(issues, { ...base, code: "LINK_MISMATCH", path: this.rel(link.path), message: `closed のタスクに作業索引があります: ${this.rel(link.path)}` }, owner);
        } else if (link.path !== expected) {
          this.issue(issues, { ...base, code: "LINK_MISMATCH", path: this.rel(link.path), message: `作業索引の不一致: ${record.name} (索引: ${this.rel(link.path)}, 工程: ${where})` }, owner);
        }
      }
    }
  }

  // 確認待ちの索引 (approvals/open/<名前>--<工程>-<試行>)。open の判断記録ごとに 1 件、閉じた記録は 0 件。
  // 正は各記録の frontmatter で、索引の有無から記録の状態を推測しない
  private inspectQueueLinks(job: Job, items: Collected[], issues: OwnedIssue[]): void {
    const dir = approvalQueueDir(job.dir);
    const tasks = new Map(items.map((entry) => [entry.record.name, entry.record]));
    const seen = new Set<string>();
    for (const entry of (readDir(dir) ?? []).sort((a, b) => compareText(a.name, b.name))) {
      if (entry.name === ".gitkeep") continue;
      const path = join(dir, entry.name);
      const parsed = parseApprovalQueueLinkName(entry.name);
      const record = parsed ? tasks.get(parsed.name) : undefined;
      if (!parsed || !record) {
        this.issue(issues, { code: "LINK_ORPHAN", job: job.name, kind: "task", id: null, path: this.rel(path), message: `実体のない確認待ちの索引: ${this.rel(path)}` });
        continue;
      }
      const owner = { kind: "task" as const, name: record.name };
      const base = { job: job.name, kind: "task" as const, id: record.id, path: this.rel(path) };
      seen.add(`${parsed.name}--${parsed.id}`);
      if (!entry.isSymbolicLink()) {
        this.issue(issues, { ...base, code: "LINK_NOT_SYMLINK", severity: "error", message: `確認待ちの索引にリンク以外があります: ${this.rel(path)}` }, owner);
        continue;
      }
      let target: string | undefined;
      try {
        target = readlinkSync(path);
      } catch {
        continue; // 走査中に消えた
      }
      if (target !== approvalQueueLinkTarget(parsed.name, parsed.id)) {
        this.issue(issues, { ...base, code: "LINK_TARGET_INVALID", severity: "error", message: `リンク先が不正: ${this.rel(path)} -> ${target}` }, owner);
        continue;
      }
      const decision = isWorkflow(record) ? record.workflow.decisions.find((each) => each.id === parsed.id) : undefined;
      if (!isWorkflow(record) || record.workflow.version !== 4) {
        this.issue(issues, { ...base, code: "LINK_MISMATCH", message: `workflowVersion 4 ではないタスクの確認待ちの索引: ${this.rel(path)}` }, owner);
      } else if (!decision) {
        this.issue(issues, { ...base, code: "LINK_MISMATCH", message: `判断記録の無い確認待ちの索引: ${this.rel(path)}` }, owner);
      } else if (decision.data?.status !== "open") {
        this.issue(issues, { ...base, code: "LINK_MISMATCH", message: `閉じた判断記録 (${String(decision.data?.status ?? "読めない")}) の確認待ちの索引: ${this.rel(path)}` }, owner);
      }
    }
    for (const { record } of items) {
      if (!isWorkflow(record) || record.workflow.version !== 4) continue;
      for (const decision of record.workflow.decisions) {
        if (decision.data?.status !== "open" || seen.has(`${record.name}--${decision.id}`)) continue;
        this.issue(issues, { code: "LINK_MISSING", job: job.name, kind: "task", id: record.id, path: decision.path, message: `確認待ちの索引なし: ${record.name} (${decision.id})` }, { kind: "task", name: record.name });
      }
    }
  }

  // 異常終了で残った操作の記録 (jobs/<案件>/.raprid-ops/*.json)。一覧だけでは片付けず、要確認として出す。
  // 次の書き込みの操作がロックの中で journal の前後の状態と照合して復旧する (照合できなければ WF_APPROVAL_ORPHAN で止まる)
  private inspectJournals(job: Job, items: Collected[], issues: OwnedIssue[]): void {
    let journals: string[];
    try {
      journals = pendingJournals(job.dir);
    } catch {
      return;
    }
    const names = new Set(items.map((entry) => entry.record.name));
    for (const path of journals) {
      // 対象のタスクは journal の task.path から分かる範囲で結び付ける (読めなくても診断は出す)
      let owner: { kind: "task"; name: string } | undefined;
      try {
        if (!lstatSync(path).isFile()) throw new Error("journal が通常のファイルではない");
        const data = JSON.parse(readFileSync(path, "utf8")) as { task?: { path?: unknown } };
        const match = typeof data.task?.path === "string" ? /^tasks\/([a-z0-9][a-z0-9-]*)\/index\.md$/.exec(data.task.path) : null;
        if (match && names.has(match[1])) owner = { kind: "task", name: match[1] };
      } catch {
        owner = undefined;
      }
      const id = owner ? (items.find((entry) => entry.record.name === owner!.name)?.record.id ?? null) : null;
      this.issue(
        issues,
        {
          code: "WF_JOURNAL_PENDING",
          severity: "error",
          job: job.name,
          kind: "task",
          id,
          path: this.rel(path),
          message: `中断した操作の記録が残っています: ${this.rel(path)} (次の書き込みの操作が照合して戻す。照合できずに WF_APPROVAL_ORPHAN で止まる場合は、人が判断記録・索引・タスクを確かめて片付ける)`,
        },
        owner,
      );
    }
  }

  // pending のタスクが待っている QA を確かめる。別案件の QA は必要な案件だけ読む
  private inspectTasks(data: JobData): void {
    for (const { record } of data.tasks) {
      if (record.kind !== "task" || (isWorkflow(record) ? record.workflow.phaseStatus !== "pending" : record.status !== "pending")) continue;
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
