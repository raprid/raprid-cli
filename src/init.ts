import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { TemplateBundle, TemplateEntry } from "./bundle.js";

export interface InitOptions {
  target: string;
  git: boolean;
  dryRun: boolean;
}

export class InitError extends Error {}

export function loadBundle(): TemplateBundle {
  const bundlePath = new URL("./template.json", import.meta.url);
  return JSON.parse(readFileSync(bundlePath, "utf8")) as TemplateBundle;
}

function lstatOrUndefined(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// 生成先に既にあるもの、または途中の階層がディレクトリ以外 (ファイル・シンボリックリンク) のものを衝突とする。
// シンボリックリンクをたどって生成先の外へ書き込まないよう、途中の階層のリンクも衝突に含める。
export function findConflicts(root: string, entries: TemplateEntry[]): string[] {
  const conflicts = new Set<string>();
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const rel = parts.slice(0, i).join("/");
      const stat = lstatOrUndefined(join(root, rel));
      if (!stat) break;
      if (i === parts.length || !stat.isDirectory()) {
        conflicts.add(rel);
        break;
      }
    }
  }
  return [...conflicts].sort();
}

function assertInside(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(sep)) {
    throw new InitError(`テンプレートのパスが不正です: ${path}`);
  }
}

// 書き込みに失敗したら、この実行で作ったものだけを逆順に消す
class Writer {
  private created: { path: string; kind: "file" | "dir" }[] = [];

  mkdirs(path: string): void {
    const missing: string[] = [];
    for (let current = path; !lstatOrUndefined(current); current = dirname(current)) {
      missing.unshift(current);
    }
    for (const dir of missing) {
      mkdirSync(dir);
      this.created.push({ path: dir, kind: "dir" });
    }
  }

  write(root: string, entry: TemplateEntry): void {
    const path = resolve(root, entry.path);
    assertInside(root, path);
    this.mkdirs(dirname(path));
    if (entry.type === "symlink") {
      symlinkSync(entry.target, path);
    } else {
      // wx: 衝突の検査後に別のプロセスが作ったファイルも上書きしない
      writeFileSync(path, Buffer.from(entry.content, "base64"), { flag: "wx" });
      chmodSync(path, entry.mode);
    }
    this.created.push({ path, kind: "file" });
  }

  rollback(): void {
    for (const { path, kind } of this.created.reverse()) {
      try {
        if (kind === "file") unlinkSync(path);
        else rmdirSync(path);
      } catch {
        // 消せなかったものは残す (利用者が作ったファイルを消さないため再帰削除はしない)
      }
    }
    this.created = [];
  }
}

function insideGitWorkTree(dir: string): boolean {
  const result = spawnSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() === "true";
}

export interface InitResult {
  root: string;
  written: number;
  git: "initialized" | "existing" | "skipped" | "unavailable";
}

export function init(options: InitOptions, bundle: TemplateBundle = loadBundle()): InitResult {
  const root = resolve(options.target);
  const rootStat = lstatOrUndefined(root);
  if (rootStat && !rootStat.isDirectory()) {
    throw new InitError(`生成先がディレクトリではありません: ${root}`);
  }

  const conflicts = findConflicts(root, bundle.entries);
  if (conflicts.length > 0) {
    const shown = conflicts.slice(0, 20).map((path) => `  ${path}`);
    if (conflicts.length > shown.length) shown.push(`  ...ほか ${conflicts.length - shown.length} 件`);
    throw new InitError(
      [`生成先に既存のファイルがあるため、何も変更せずに中止しました (${conflicts.length} 件):`, ...shown].join("\n"),
    );
  }

  if (options.dryRun) {
    return { root, written: 0, git: "skipped" };
  }

  const writer = new Writer();
  try {
    writer.mkdirs(root);
    for (const entry of bundle.entries) writer.write(root, entry);
  } catch (error) {
    writer.rollback();
    const message = error instanceof Error ? error.message : String(error);
    throw new InitError(`生成中に失敗したため、この実行で作成したファイルを削除しました: ${message}`);
  }

  let git: InitResult["git"] = "skipped";
  if (options.git) {
    if (insideGitWorkTree(root)) {
      git = "existing";
    } else {
      const result = spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" });
      git = result.status === 0 ? "initialized" : "unavailable";
    }
  }

  return { root, written: bundle.entries.length, git };
}
