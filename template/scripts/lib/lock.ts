import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

const lockTimeoutMs = 10_000;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 削除対象は確認済みの所有者ファイルだけ。別の所有者が配置した非空ディレクトリは消せない。
function removeOwner(lockDir: string, owner: string): void {
  try {
    unlinkSync(join(lockDir, owner));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    rmdirSync(lockDir);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

function recoverDeadOwner(lockDir: string): void {
  let owners: string[];
  try {
    owners = readdirSync(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const owner of owners) {
    const match = /^([1-9]\d*)-[0-9a-f-]{36}$/.exec(owner);
    if (!match) continue;
    try {
      // 同じマシンの PID だけを判定し、不明な所有者は回収しない。
      if (readFileSync(join(lockDir, owner), "utf8") !== hostname()) continue;
      process.kill(Number(match[1]), 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") removeOwner(lockDir, owner);
      else if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  }
}

// 所有者情報を準備してから原子的に公開する。生存中の所有者は時間に関係なく待つ。
// preparedParent は lockDir と同じファイルシステムに置く (rename で公開するため)。
export function withLock<T>(lockDir: string, preparedParent: string, fn: () => T): T {
  const owner = `${process.pid}-${randomUUID()}`;
  const prepared = join(preparedParent, `lock-${owner}`);
  mkdirSync(dirname(lockDir), { recursive: true });
  mkdirSync(prepared, { recursive: true });
  let acquired = false;
  try {
    writeFileSync(join(prepared, owner), hostname(), { flag: "wx" });
    const deadline = performance.now() + lockTimeoutMs;
    for (;;) {
      try {
        renameSync(prepared, lockDir);
        acquired = true;
        break;
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        recoverDeadOwner(lockDir);
        if (performance.now() > deadline) throw new Error(`ロックを取得できません: ${lockDir}`);
        sleep(20);
      }
    }
    return fn();
  } finally {
    if (acquired) removeOwner(lockDir, owner);
    rmSync(prepared, { recursive: true, force: true });
  }
}
