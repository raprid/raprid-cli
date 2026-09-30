// 工程型タスク (workflowVersion 2・3) の作業索引。T-014
//
// open のタスクは status/<工程>/<工程の状態>/<名前> に、実体への相対リンク (../../../tasks/<名前>) を 1 つだけ置く。
// closed のタスクはリンクを置かない。waiting の後続工程は索引にしない (今の工程だけ)。旧形式の状態索引 (status/<todo…>/) とは別。
//
// 実体 (index.md) と索引は、次の順で 1 回の操作として書く (旧形式の items.ts の moveItem と同じ考え方)。
//   1. index.md の新しい内容を同じディレクトリの一時ファイルに書く
//   2. リンクを動かす (移す・作る・消す)。移し先に別のものがあれば何も変えずに止める
//   3. 一時ファイルを index.md に置き換える
// 2・3 で失敗したら、この実行で動かしたリンクを元に戻し、index.md は元のまま残す。

import { mkdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CliError } from "./errors.ts";
import { lstatOrUndefined, tempPath } from "./fsutil.ts";

// 索引の工程・状態 (v2 の implement を含む。読み取りの診断で使う)
export const workIndexPhases = ["plan", "implement", "execute", "review", "acceptance"] as const;
export const workIndexStatuses = ["waiting", "ready", "progress", "pending", "done"] as const;

export function workLinkPath(jobDir: string, phase: string, status: string, name: string): string {
  return join(jobDir, "status", phase, status, name);
}

export function workLinkTarget(name: string): string {
  return `../../../tasks/${name}`;
}

// タスクの今の作業索引 (open なら今の工程と状態、closed なら無し)
export function expectedLink(jobDir: string, name: string, task: { status: unknown; phase: unknown; workflow?: unknown }): string | null {
  if (task.status !== "open" || typeof task.phase !== "string") return null;
  const record = (task.workflow as Record<string, { status?: unknown }> | undefined)?.[task.phase];
  if (typeof record?.status !== "string") return null;
  return workLinkPath(jobDir, task.phase, record.status, name);
}

// このタスクの作業索引として置かれているもの (すべての工程・状態を探す)
export function currentLinks(jobDir: string, name: string): { path: string; target: string | undefined }[] {
  const found: { path: string; target: string | undefined }[] = [];
  for (const phase of workIndexPhases) {
    for (const status of workIndexStatuses) {
      const path = workLinkPath(jobDir, phase, status, name);
      const stat = lstatOrUndefined(path);
      if (!stat) continue;
      found.push({ path, target: stat.isSymbolicLink() ? readlinkSync(path) : undefined });
    }
  }
  return found;
}

// 試験で失敗を注入するための操作 (既定は node:fs)
export interface IndexFs {
  writeTemp(path: string, text: string, mode: number): void;
  rename(from: string, to: string): void;
  symlink(target: string, path: string): void;
  unlink(path: string): void;
}

export const defaultIndexFs: IndexFs = {
  writeTemp: (path, text, mode) => writeFileSync(path, text, { flag: "wx", mode }),
  rename: (from, to) => renameSync(from, to),
  symlink: (target, path) => symlinkSync(target, path),
  unlink: (path) => rmSync(path),
};

function indexError(message: string): CliError {
  return new CliError(`${message}\n作業索引を直してから再度実行してください (raprid task list で不整合を確認できる)`, 1, "WF_INDEX");
}

// 実体と作業索引を一緒に書き換える。before は操作の前の今のリンク (無ければ null)、after は操作の後にあるべきリンク (closed なら null)
export function commitWithIndex(index: string, text: string, name: string, jobDir: string, after: string | null, fs: IndexFs = defaultIndexFs): void {
  // 今のリンクを確かめる。複数・リンク以外・リンク先の誤りは直さずに止める (推測で直さない)。無い場合は作り直す
  const links = currentLinks(jobDir, name);
  if (links.length > 1) throw indexError(`作業索引が複数あります: ${links.map((link) => link.path).join(", ")}`);
  const before = links[0];
  if (before && before.target === undefined) throw indexError(`作業索引にリンク以外があります: ${before.path}`);
  if (before && before.target !== workLinkTarget(name)) throw indexError(`作業索引のリンク先が不正です: ${before.path} -> ${before.target}`);
  if (after !== null && before?.path !== after && lstatOrUndefined(after)) throw indexError(`作業索引の移し先に別のものがあります: ${after}`);

  const temp = tempPath(dirname(index), "index.md");
  let moved: "none" | "rename" | "create" | "remove" = "none";
  let createdDir: string | undefined; // この実行で作った作業索引のディレクトリ (戻すときに消す)
  let committed = false;
  try {
    fs.writeTemp(temp, text, statSync(index).mode & 0o777);
    if (before && after !== null && before.path !== after) {
      createdDir = mkdirSync(dirname(after), { recursive: true });
      fs.rename(before.path, after);
      moved = "rename";
    } else if (!before && after !== null) {
      createdDir = mkdirSync(dirname(after), { recursive: true });
      fs.symlink(workLinkTarget(name), after);
      moved = "create";
    } else if (before && after === null) {
      fs.unlink(before.path);
      moved = "remove";
    }
    fs.rename(temp, index);
    committed = true;
  } finally {
    rmSync(temp, { force: true });
    if (!committed) {
      try {
        if (moved === "rename" && before && after !== null) renameSync(after, before.path);
        if (moved === "create" && after !== null) rmSync(after, { force: true });
        if (moved === "remove" && before) symlinkSync(workLinkTarget(name), before.path);
        if (createdDir) rmSync(createdDir, { recursive: true, force: true });
      } catch {
        // 戻せなかった索引は task list で不一致として報告される
      }
    }
  }
}
