#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const templateDir = resolve(scriptDir, "template");
// 検証用に記録先だけを差し替えられるようにする (通常は logs/ 自身)
const logsRoot = resolve(process.env.LOGS_ROOT ?? scriptDir);
const usage = "使い方: pnpm log:create <agent_name> [--date YYYY-MM-DD] [--session <session_id>]";

function localDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function subdirs(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
    .map((entry) => entry.name);
}

// 日付をまたいで再開したセッションを、開始日のディレクトリに寄せるために探す
function findSession(agentName: string, sessionId: string): string[] {
  const found: string[] = [];
  for (const year of subdirs(logsRoot, /^\d{4}$/)) {
    for (const month of subdirs(join(logsRoot, year), /^\d{2}$/)) {
      for (const day of subdirs(join(logsRoot, year, month), /^\d{2}$/)) {
        const candidate = join(logsRoot, year, month, day, agentName, sessionId);
        if (existsSync(candidate)) found.push(candidate);
      }
    }
  }
  return found;
}

function display(path: string): string {
  return join("logs", relative(logsRoot, path));
}

function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

function parseCli() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        date: { type: "string" },
        session: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch {
    // 未知のオプションや値の欠けは使い方の表示に回す
    return undefined;
  }
}

const parsed = parseCli();
const [agentName, ...extra] = parsed?.positionals ?? [];
const dateArg = parsed?.values.date;
const sessionArg = parsed?.values.session;

if (parsed?.values.help) {
  console.log(usage);
} else if (
  !parsed ||
  extra.length > 0 ||
  !agentName ||
  !/^[a-z][a-z0-9-]*$/.test(agentName) ||
  (dateArg !== undefined && !isValidDate(dateArg)) ||
  (sessionArg !== undefined && !/^[A-Za-z0-9_-]+$/.test(sessionArg))
) {
  fail(usage);
} else if (!existsSync(templateDir)) {
  fail(`テンプレートが見つかりません: ${templateDir}`);
} else {
  const sessionId = sessionArg ?? randomUUID();
  const date = dateArg ?? localDate();
  const [year, month, day] = date.split("-");
  const targetDir = join(logsRoot, year, month, day, agentName, sessionId);
  const existing = sessionArg === undefined ? [] : findSession(agentName, sessionId);

  if (existing.length > 1) {
    fail(`同じセッション ID のログが複数あります: ${existing.map(display).join(", ")}`);
  } else if (existing.length === 1 && existing[0] !== targetDir && dateArg !== undefined) {
    fail(`セッションは別の日付で開始済みです: ${display(existing[0])}`);
  } else if (existing.length === 1) {
    console.log(`既存のセッションログ: ${display(existing[0])}`);
  } else {
    mkdirSync(dirname(targetDir), { recursive: true });
    try {
      // recursive なしの mkdir は既存なら失敗するため、同時作成でも一方だけが複製する
      mkdirSync(targetDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      console.log(`既存のセッションログ: ${display(targetDir)}`);
      process.exit();
    }
    cpSync(templateDir, targetDir, { recursive: true, force: false, errorOnExist: true });
    console.log(`セッションログを作成しました: ${display(targetDir)}`);
  }
}
