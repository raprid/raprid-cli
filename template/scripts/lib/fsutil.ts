import { randomUUID } from "node:crypto";
import { lstatSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function localDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

export function lstatOrUndefined(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function exists(path: string): boolean {
  return lstatOrUndefined(path) !== undefined;
}

export function isDirectory(path: string): boolean {
  return lstatOrUndefined(path)?.isDirectory() ?? false;
}

export function isFile(path: string): boolean {
  return lstatOrUndefined(path)?.isFile() ?? false;
}

export function tempPath(dir: string, label: string): string {
  return join(dir, `.${label}.${randomUUID()}`);
}

// 同じディレクトリの一時ファイルへ書いてから置き換える。既存ファイルの権限は保つ
export function writeFileAtomic(path: string, content: string, mode?: number): void {
  const temp = tempPath(dirname(path), basename(path));
  const currentMode = mode ?? (isFile(path) ? statSync(path).mode & 0o777 : 0o644);
  try {
    writeFileSync(temp, content, { flag: "wx", mode: currentMode });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
