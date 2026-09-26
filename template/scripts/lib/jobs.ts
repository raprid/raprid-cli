import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { CliError, UsageError } from "./errors.ts";
import { Frontmatter } from "./frontmatter.ts";
import { isDirectory, isFile, lstatOrUndefined } from "./fsutil.ts";
import { withLock } from "./lock.ts";

export const taskStatuses = ["todo", "pending", "progress", "done"] as const;
export const qaStatuses = ["unresolved", "resolved"] as const;
export type Kind = "task" | "qa";

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
    if (!isDirectory(job.dir)) throw new CliError(`案件が見つかりません: jobs/${job.name}`);
    return job;
  }

  static all(root: string): Job[] {
    const jobsDir = join(root, "jobs");
    if (!isDirectory(jobsDir)) throw new CliError("jobs/ が見つかりません");
    return readdirSync(jobsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => new Job(root, entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
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

  // 案件単位で採番・状態変更・詳細追加を直列化する
  lock<T>(fn: () => T): T {
    const locks = join(this.root, "jobs", ".locks");
    return withLock(join(locks, this.name), locks, fn);
  }

  items(kind: Kind): Item[] {
    const dir = this.itemsDir(kind);
    if (!isDirectory(dir)) throw new CliError(`構成が不完全です: ${this.display(dir)}`);
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !(kind === "qa" && reservedQaNames.has(entry.name)))
      .map((entry) => new Item(this, kind, entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // 既存 ID を検証して次の ID を返す
  nextId(kind: Kind): string {
    const prefix = kind === "task" ? "T" : "Q";
    const seen = new Set<string>();
    let max = 0;
    for (const item of this.items(kind)) {
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
    return isFile(this.index) ? this.tryField("id") : "";
  }

  id(): string {
    return this.frontmatter().get("id") ?? "";
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
