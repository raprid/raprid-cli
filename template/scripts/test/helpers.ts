import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const cli = resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli.ts");

export interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function raprid(root: string, args: string[], options: { script?: string; env?: NodeJS.ProcessEnv; require?: string } = {}): Result {
  const script = options.script ?? cli;
  const env = { ...process.env, ...(options.script ? {} : { RAPRID_ROOT: root }), ...options.env };
  if (options.script) delete env.RAPRID_ROOT;
  const result = spawnSync(process.execPath, [...(options.require ? ["--require", options.require] : []), script, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function rapridAsync(root: string, args: string[]): Promise<Result> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, RAPRID_ROOT: root } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

export function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

export function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

// ファイルの内容・リンク先・権限の一覧。変更がないことの確認に使う
export function snapshot(root: string, skip: (rel: string) => boolean = () => false, rel = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(join(root, rel)).sort()) {
    const child = rel ? `${rel}/${name}` : name;
    if (skip(child)) continue;
    const full = join(root, child);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) out[child] = `link:${readlinkSync(full)}`;
    else if (stat.isDirectory()) {
      out[`${child}/`] = "dir";
      Object.assign(out, snapshot(root, skip, child));
    } else out[child] = `${(stat.mode & 0o777).toString(8)}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`;
  }
  return out;
}

export function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
