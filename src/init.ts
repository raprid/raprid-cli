import { spawnSync } from "node:child_process";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// 同梱雛形のパスとリンク先が生成先の外を指していないことを確かめる
function assertEntryInside(root: string, entry: TemplateEntry): string {
  const path = resolve(root, entry.path);
  if (!isInside(root, path)) throw new InitError(`テンプレートのパスが不正です: ${entry.path}`);
  if (entry.type === "symlink" && (isAbsolute(entry.target) || !isInside(root, resolve(dirname(path), entry.target)))) {
    throw new InitError(`テンプレートのリンク先が不正です: ${entry.path} -> ${entry.target}`);
  }
  return path;
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

  write(root: string, realRoot: string, entry: TemplateEntry): void {
    const path = assertEntryInside(root, entry);
    this.mkdirs(dirname(path));
    // 検査後に途中の階層がリンクへ置き換えられても、外へは書き込まない
    if (!isInside(realRoot, join(realpathSync(dirname(path)), "x"))) {
      throw new InitError(`生成先の外を指す階層があります: ${dirname(entry.path)}`);
    }
    if (entry.type === "symlink") {
      symlinkSync(entry.target, path);
      this.created.push({ path, kind: "file" });
      return;
    }
    // wx: 衝突の検査後に別のプロセスが作ったファイルも上書きしない。mode は umask を通して適用される
    const fd = openSync(path, "wx", entry.mode);
    // 書き込みに失敗しても消せるよう、作成した時点で記録する
    this.created.push({ path, kind: "file" });
    try {
      const content = Buffer.from(entry.content, "base64");
      for (let offset = 0; offset < content.length; ) {
        offset += writeSync(fd, content, offset);
      }
    } finally {
      closeSync(fd);
    }
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

// GIT_DIR などが設定されていると git init が生成先の外にリポジトリを作るため、GIT_* を除いて実行する
function runGit(args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return spawnSync("git", args, { encoding: "utf8", env });
}

function insideGitWorkTree(dir: string): boolean {
  const result = runGit(["-C", dir, "rev-parse", "--is-inside-work-tree"]);
  return result.status === 0 && result.stdout.trim() === "true";
}

export interface InitResult {
  root: string;
  written: number;
  git: "initialized" | "existing" | "skipped" | "unavailable";
}

export function init(options: InitOptions, bundle: TemplateBundle = loadBundle()): InitResult {
  const root = resolve(options.target);
  let conflicts: string[];
  try {
    const rootStat = lstatOrUndefined(root);
    if (rootStat?.isSymbolicLink()) throw new InitError(`生成先にシンボリックリンクは指定できません: ${root}`);
    if (rootStat && !rootStat.isDirectory()) throw new InitError(`生成先がディレクトリではありません: ${root}`);
    for (const entry of bundle.entries) assertEntryInside(root, entry);
    conflicts = findConflicts(root, bundle.entries);
  } catch (error) {
    if (error instanceof InitError) throw error;
    // 途中の階層がファイル (ENOTDIR) や読めないディレクトリ (EACCES) の場合
    throw new InitError(`生成先を確認できません: ${error instanceof Error ? error.message : String(error)}`);
  }
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
    const realRoot = realpathSync(root);
    for (const entry of bundle.entries) writer.write(root, realRoot, entry);
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
      const result = runGit(["init", "--quiet", root]);
      git = result.status === 0 ? "initialized" : "unavailable";
    }
  }

  return { root, written: bundle.entries.length, git };
}
