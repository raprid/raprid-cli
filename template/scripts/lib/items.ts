// タスクと QA に共通する作成・状態変更・一覧の処理。
// 実体 (<名前>/index.md) と状態索引 (status/<状態>/<名前> へのリンク) を一緒に更新し、
// 途中で失敗したらこの実行で変えたものだけを戻す。

import { mkdirSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "./errors.ts";
import { exists, isDirectory, lstatOrUndefined, tempPath } from "./fsutil.ts";
import { Item, type Job, type Kind } from "./jobs.ts";
import { firstLine } from "./markdown.ts";

export function assertNameFree(job: Job, kind: Kind, name: string): void {
  const item = new Item(job, kind, name);
  if (exists(item.dir)) throw new CliError(`同名の${item.label}が存在します: ${job.display(item.dir)}`);
  for (const status of job.statuses(kind)) {
    const candidate = join(job.statusDir(kind, status), name);
    if (lstatOrUndefined(candidate)) throw new CliError(`同名の状態索引が存在します: ${job.display(candidate)}`);
  }
}

export function assertStatusDirs(job: Job, kind: Kind): void {
  for (const status of job.statuses(kind)) {
    const dir = job.statusDir(kind, status);
    if (!isDirectory(dir)) throw new CliError(`状態ディレクトリが見つかりません: ${job.display(dir)}`);
  }
}

// 完成したディレクトリを rename で公開してから索引を張る
export function createItem(job: Job, kind: Kind, name: string, content: string, status: string): Item {
  const item = new Item(job, kind, name);
  const temp = tempPath(job.itemsDir(kind), `add-${name}`);
  const link = join(job.statusDir(kind, status), name);
  let published = false;
  try {
    mkdirSync(temp);
    writeFileSync(join(temp, "index.md"), content, { flag: "wx", mode: 0o644 });
    renameSync(temp, item.dir);
    published = true;
    symlinkSync(job.linkTarget(kind, name), link);
    return item;
  } catch (error) {
    if (published) rmSync(item.dir, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// 索引が 0 件または 1 件で、リンク先が正しいことを確かめる
export function currentLink(item: Item) {
  const expected = item.job.linkTarget(item.kind, item.name);
  const links = item.links();
  for (const link of links) {
    if (link.target !== expected) throw new CliError(`状態索引のリンク先が不正です: ${item.job.display(link.path)} -> ${link.target}`);
  }
  if (links.length > 1) throw new CliError(`同じ${item.label}の状態索引が複数あります: ${item.name}`);
  return links[0];
}

export function moveItem(item: Item, newStatus: string, updated: string): string {
  const job = item.job;
  const source = currentLink(item);
  const target = join(job.statusDir(item.kind, newStatus), item.name);
  const temp = tempPath(item.dir, "index.md");
  let linkAction: "none" | "move" | "create" = "none";
  let committed = false;
  try {
    writeFileSync(temp, updated, { flag: "wx", mode: statSync(item.index).mode & 0o777 });
    if (source && source.path !== target) {
      renameSync(source.path, target);
      linkAction = "move";
    } else if (!source) {
      symlinkSync(job.linkTarget(item.kind, item.name), target);
      linkAction = "create";
    }
    renameSync(temp, item.index);
    committed = true;
    return target;
  } finally {
    rmSync(temp, { force: true });
    if (!committed) {
      try {
        if (linkAction === "move" && source) renameSync(target, source.path);
        if (linkAction === "create") rmSync(target, { force: true });
      } catch {
        // 戻せなかった索引は list で不一致として報告される
      }
    }
  }
}

// 一覧: frontmatter の status を正として状態ごとに並べ、ID と索引の不一致を報告する
export function listItems(job: Job, kind: Kind, describe: (item: Item) => string): string[] {
  const out: string[] = [];
  const items = job.items(kind);
  const statuses = kind === "task" ? ["progress", "todo", "pending", "done"] : ["unresolved", "resolved"];
  const statusOf = new Map(items.map((item) => [item, item.tryField("status")]));
  out.push(kind === "task" ? `${job.name} (jobs/${job.name}/)` : `${job.name} QA (jobs/${job.name}/qa/)`);
  for (const status of statuses) {
    const matched = items.filter((item) => statusOf.get(item) === status);
    out.push(`  ${status} (${matched.length})`);
    for (const item of matched) {
      out.push(`    ${(item.idOrEmpty() || "ID未設定").padEnd(8)} ${item.name.padEnd(40)} ${describe(item)}`);
    }
  }
  const unknown = items.filter((item) => !statuses.includes(statusOf.get(item) ?? ""));
  if (unknown.length > 0) {
    out.push(`  unknown (${unknown.length})`);
    for (const item of unknown) {
      out.push(`    ${(item.idOrEmpty() || "ID未設定").padEnd(8)} ${item.name} (status: ${statusOf.get(item) || "未設定"})`);
    }
  }
  out.push(`  合計: ${items.length}`);

  const issues: string[] = [];
  const pattern = kind === "task" ? /^T-\d{3,}$/ : /^Q-\d{3,}$/;
  const byId = new Map<string, string[]>();
  for (const item of items) {
    const id = item.idOrEmpty();
    if (!pattern.test(id)) {
      issues.push(`IDが未設定または不正: ${item.name} (${id || "未設定"})`);
      continue;
    }
    byId.set(id, [...(byId.get(id) ?? []), item.name]);
  }
  for (const [id, names] of byId) if (names.length > 1) issues.push(`ID重複: ${id} (${names.join(", ")})`);
  const names = new Set(items.map((item) => item.name));
  for (const item of items) {
    try {
      const links = item.links();
      const status = statusOf.get(item);
      if (links.length === 0) issues.push(`索引なし: ${item.name} (status: ${status || "未設定"})`);
      if (links.length > 1) issues.push(`索引が複数: ${item.name} (${links.map((link) => link.status).join(", ")})`);
      for (const link of links) {
        if (link.target !== job.linkTarget(kind, item.name)) issues.push(`リンク先が不正: ${job.display(link.path)} -> ${link.target}`);
        else if (link.status !== status) issues.push(`索引の不一致: ${item.name} (索引: ${link.status}, status: ${status || "未設定"})`);
      }
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }
  for (const status of job.statuses(kind)) {
    const dir = job.statusDir(kind, status);
    if (!isDirectory(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (entry !== ".gitkeep" && !names.has(entry)) issues.push(`実体のない索引: ${job.display(join(dir, entry))}`);
    }
  }
  if (issues.length > 0) {
    out.push("  要確認:");
    for (const issue of issues) out.push(`    ${issue}`);
  }
  return out;
}

export function sectionSummary(item: Item, heading: string): string | undefined {
  try {
    return firstLine(item.read(), 2, heading);
  } catch {
    return undefined;
  }
}
