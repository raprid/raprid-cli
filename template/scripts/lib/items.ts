// タスクと QA に共通する作成・状態変更の処理 (一覧は lib/records.ts と lib/view.ts)。
// 実体 (<名前>/index.md) と状態索引 (status/<状態>/<名前> へのリンク) を一緒に更新し、
// 途中で失敗したらこの実行で変えたものだけを戻す。

import { mkdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "./errors.ts";
import { exists, isDirectory, lstatOrUndefined, tempPath } from "./fsutil.ts";
import { Item, type Job, type Kind } from "./jobs.ts";

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
