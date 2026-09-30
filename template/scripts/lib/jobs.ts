import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { CliError, UsageError } from "./errors.ts";
import { Frontmatter } from "./frontmatter.ts";
import { isDirectory, isFile, lstatOrUndefined } from "./fsutil.ts";
import { type RecoveryFs, recoverJournals } from "./journal.ts";
import { withLock } from "./lock.ts";
import { hasWorkflowVersion } from "./taskformat.ts";
import { YamlFrontmatter } from "./yamlfront.ts";

export const taskStatuses = ["todo", "pending", "progress", "done"] as const;
export const qaStatuses = ["unresolved", "resolved"] as const;
export type Kind = "task" | "qa";

// ロケールに依存しない比較 (UTF-16 の符号単位順)。一覧の順序を環境で変えない
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const namePattern = /^[a-z0-9][a-z0-9-]*$/;
// QA の実体と状態索引は同じ qa/ に並ぶため、索引のディレクトリ名は使えない
const reservedQaNames = new Set(["status"]);

export function validateJobName(name: string | undefined): string {
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new UsageError(`案件名は英数字で始まる英数字・ピリオド・ハイフン・下線で指定してください: ${name ?? ""}`);
  }
  return name;
}

export function validateItemName(kind: Kind, name: string | undefined): string {
  const label = kind === "task" ? "タスク名" : "QA名";
  if (!name || !namePattern.test(name)) throw new UsageError(`${label}は英小文字・数字・ハイフンで指定してください: ${name ?? ""}`);
  if (kind === "qa" && reservedQaNames.has(name)) throw new UsageError(`QA名に ${name} は使えません (状態索引と衝突するため)`);
  return name;
}

export function isSelector(kind: Kind, value: string): boolean {
  const idPattern = kind === "task" ? /^T-\d{3,}$/ : /^Q-\d{3,}$/;
  return idPattern.test(value) || namePattern.test(value);
}

// 複数の案件を名前順にロックする (順序を揃えてデッドロックを避け、同じ案件は二重に取らない)。
// 途中で取得に失敗したら、それまでに取ったロックは withLock の finally で外れる
export function withJobLocks<T>(root: string, names: string[], fn: () => T): T {
  const sorted = [...new Set(names)].sort(compareText);
  const locks = join(root, "jobs", ".locks");
  const acquire = (index: number): T => (index >= sorted.length ? fn() : withLock(join(locks, sorted[index]), locks, () => acquire(index + 1)));
  return acquire(0);
}

// 案件の書き込みの操作のロック (契約 7「次にその案件の書き込みの操作をするとき、ロックの中で残った journal を調べる」)。
// lockNames (待っている QA の案件など、読むだけの案件を含む) を名前順にロックし、その中で writeNames の案件の残った journal を
// 先に復旧してから fn を実行する。不整合な journal があれば fn を実行せずに止まる (何も変えない)。
// ロックは withJobLocks の 1 回だけで、復旧はロックを取らない (二重ロック・案件の間のデッドロックを作らない)。
// 読み取りの操作はこれを使わない (読み取りで復旧・書き込みをしない)
export function withJobWriteLocks<T>(root: string, lockNames: string[], writeNames: string[], fn: (recovered: string[]) => T, fs?: RecoveryFs): T {
  const writes = [...new Set(writeNames)].sort(compareText);
  return withJobLocks(root, [...lockNames, ...writes], () => fn(recoverJournals(writes.map((name) => new Job(root, name).dir), fs)));
}

export class Job {
  readonly root: string;
  readonly name: string;
  readonly dir: string;

  constructor(root: string, name: string) {
    this.root = root;
    this.name = validateJobName(name);
    this.dir = join(root, "jobs", name);
  }

  static existing(root: string, name: string | undefined): Job {
    const job = new Job(root, validateJobName(name));
    if (!isDirectory(job.dir)) throw new CliError(`案件が見つかりません: jobs/${job.name}`, 1, "JOB_NOT_FOUND");
    return job;
  }

  static all(root: string): Job[] {
    const jobsDir = join(root, "jobs");
    if (!isDirectory(jobsDir)) throw new CliError("jobs/ が見つかりません", 1, "JOBS_DIR_MISSING");
    return readdirSync(jobsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => new Job(root, entry.name))
      .sort((a, b) => compareText(a.name, b.name));
  }

  display(path: string): string {
    return relative(this.root, path);
  }

  itemsDir(kind: Kind): string {
    return kind === "task" ? join(this.dir, "tasks") : join(this.dir, "qa");
  }

  statusDir(kind: Kind, status: string): string {
    return kind === "task" ? join(this.dir, "status", status) : join(this.dir, "qa", "status", status);
  }

  statuses(kind: Kind): readonly string[] {
    return kind === "task" ? taskStatuses : qaStatuses;
  }

  // 状態索引から実体へのリンク先 (status/<状態>/<名前> からの相対パス)
  linkTarget(kind: Kind, name: string): string {
    return kind === "task" ? `../../tasks/${name}` : `../../${name}`;
  }

  // 案件単位で採番・状態変更・詳細追加を直列化する (復旧はしない。案件を書き換える操作は writeLock を使う)
  lock<T>(fn: () => T): T {
    const locks = join(this.root, "jobs", ".locks");
    return withLock(join(locks, this.name), locks, fn);
  }

  // 案件を書き換える操作のロック。ロックの中で残った journal を復旧してから fn を実行する (withJobWriteLocks)
  writeLock<T>(fn: () => T): T {
    return withJobWriteLocks(this.root, [this.name], [this.name], () => fn());
  }

  items(kind: Kind): Item[] {
    const dir = this.itemsDir(kind);
    if (!isDirectory(dir)) throw new CliError(`構成が不完全です: ${this.display(dir)}`);
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !(kind === "qa" && reservedQaNames.has(entry.name)))
      .map((entry) => new Item(this, kind, entry.name))
      .sort((a, b) => compareText(a.name, b.name));
  }

  // 既存 ID を検証して次の ID を返す
  nextId(kind: Kind): string {
    const prefix = kind === "task" ? "T" : "Q";
    const seen = new Set<string>();
    let max = 0;
    for (const item of this.items(kind)) {
      if (!isFile(item.index)) throw new CliError(`index.md の無いディレクトリがあります: ${this.display(item.dir)}`);
      const id = item.id();
      if (!new RegExp(`^${prefix}-\\d{3,}$`).test(id)) {
        throw new CliError(`既存の${item.label}のIDが未設定または不正です: ${this.display(item.index)} (${id || "未設定"})`);
      }
      if (seen.has(id)) throw new CliError(`${item.label}のIDが重複しています: ${id}`);
      seen.add(id);
      max = Math.max(max, Number(id.slice(2)));
    }
    return `${prefix}-${String(max + 1).padStart(3, "0")}`;
  }

  find(kind: Kind, selector: string): Item {
    if (!isSelector(kind, selector)) {
      throw new UsageError(`${kind === "task" ? "タスク" : "QA"}のIDまたは名前の形式が不正です: ${selector}`);
    }
    const label = kind === "task" ? "タスク" : "QA";
    let item: Item;
    if (/^[TQ]-\d{3,}$/.test(selector)) {
      const matches = this.items(kind).filter((candidate) => candidate.idOrEmpty() === selector);
      if (matches.length === 0) throw new CliError(`${label}のIDが見つかりません: ${selector}`);
      if (matches.length > 1) throw new CliError(`${label}のIDが重複しています: ${selector}`);
      item = matches[0];
    } else {
      item = new Item(this, kind, selector);
      if (!isFile(item.index)) throw new CliError(`${label}が見つかりません: ${this.display(item.index)}`);
    }
    const id = item.id();
    const pattern = kind === "task" ? /^T-\d{3,}$/ : /^Q-\d{3,}$/;
    if (!pattern.test(id)) throw new CliError(`${label}のIDが未設定または不正です: ${this.display(item.index)} (${id || "未設定"})`);
    if (this.items(kind).filter((candidate) => candidate.idOrEmpty() === id).length > 1) {
      throw new CliError(`${label}のIDが重複しています: ${id}`);
    }
    return item;
  }
}

export interface IndexLink {
  status: string;
  path: string;
  target: string;
}

export class Item {
  readonly job: Job;
  readonly kind: Kind;
  readonly name: string;

  constructor(job: Job, kind: Kind, name: string) {
    this.job = job;
    this.kind = kind;
    this.name = name;
  }

  get label(): string {
    return this.kind === "task" ? "タスク" : "QA";
  }

  get dir(): string {
    return join(this.job.itemsDir(this.kind), this.name);
  }

  get index(): string {
    return join(this.dir, "index.md");
  }

  read(): string {
    return readFileSync(this.index, "utf8");
  }

  frontmatter(): Frontmatter {
    return Frontmatter.parse(this.read(), this.job.display(this.index));
  }

  // 一覧のように壊れたファイルがあっても続けたい場面で使う
  tryField(key: string): string {
    try {
      return this.frontmatter().get(key) ?? "";
    } catch {
      return "";
    }
  }

  idOrEmpty(): string {
    if (!isFile(this.index)) return "";
    return this.tryField("id") || this.nestedId();
  }

  // 旧形式の frontmatter として読めなければ、工程型 (入れ子) の frontmatter から ID を読む。
  // 同じ案件に旧形式と工程型のタスクがあっても、採番・ID での検索が止まらないように (T-014)
  id(): string {
    try {
      return this.frontmatter().get("id") ?? "";
    } catch (error) {
      const nested = this.nestedId();
      if (nested !== "") return nested;
      // 読めない工程型のタスクは、旧形式の読み取りの誤りではなく工程型として読めないことを示す (旧形式として扱わない)
      if (hasWorkflowVersion(this.read())) throw new CliError(`工程型のタスクの frontmatter を読み取れません: ${this.job.display(this.index)}`, 1, "WF_READ");
      throw error;
    }
  }

  private nestedId(): string {
    try {
      const value = YamlFrontmatter.parse(this.read(), this.job.display(this.index)).get(["id"]);
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  }

  // status/<状態>/<名前> に置かれた索引。リンク以外があれば停止する
  links(): IndexLink[] {
    const found: IndexLink[] = [];
    for (const status of this.job.statuses(this.kind)) {
      const path = join(this.job.statusDir(this.kind, status), this.name);
      const stat = lstatOrUndefined(path);
      if (!stat) continue;
      if (!stat.isSymbolicLink()) throw new CliError(`状態索引にリンク以外があります: ${this.job.display(path)}`);
      found.push({ status, path, target: readlinkSync(path) });
    }
    return found;
  }
}
