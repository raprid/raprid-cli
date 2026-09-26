// agent のセッションログを logs/<YYYY>/<MM>/<DD>/<agent_name>/<session_id>/ に作る。
//   raprid log create <agent_name> [--date YYYY-MM-DD] [--session <session_id>]

import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parse } from "../lib/args.ts";
import { CliError, UsageError } from "../lib/errors.ts";
import { isDirectory, isValidDate, localDate } from "../lib/fsutil.ts";
import { withLock } from "../lib/lock.ts";
import { projectRoot, templatesDir } from "../lib/root.ts";

export const usage = `使い方:
  raprid log create <agent_name> [--date YYYY-MM-DD] [--session <session_id>]

pnpm log:create <agent_name> [...] でも同じ。`;

const templateDir = join(templatesDir, "log");

function subdirs(dir: string, pattern: RegExp): string[] {
  if (!isDirectory(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
    .map((entry) => entry.name);
}

// 日付をまたいで再開したセッションを、開始日のディレクトリに寄せるために探す
function findSession(logsRoot: string, agentName: string, sessionId: string): string[] {
  const found: string[] = [];
  for (const year of subdirs(logsRoot, /^\d{4}$/)) {
    for (const month of subdirs(join(logsRoot, year), /^\d{2}$/)) {
      for (const day of subdirs(join(logsRoot, year, month), /^\d{2}$/)) {
        const candidate = join(logsRoot, year, month, day, agentName, sessionId);
        if (isDirectory(candidate)) found.push(candidate);
      }
    }
  }
  return found;
}

// 一時ディレクトリに複製してから rename し、targetDir は完成した状態でだけ見えるようにする。
// 既にあれば rename が失敗するので、作成済みとして false を返す。
function createFromTemplate(logsRoot: string, targetDir: string): boolean {
  const tmpDir = join(logsRoot, ".tmp", randomUUID());
  mkdirSync(dirname(tmpDir), { recursive: true });
  try {
    cpSync(templateDir, tmpDir, { recursive: true });
    mkdirSync(dirname(targetDir), { recursive: true });
    try {
      renameSync(tmpDir, targetDir);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "EEXIST") return false;
      throw error;
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function create(argv: string[]): void {
  const { values, positionals } = parse(argv, { date: { type: "string" }, session: { type: "string" } }, usage);
  if (values.help) {
    console.log(usage);
    return;
  }
  const [agentName, ...extra] = positionals;
  const dateArg = values.date;
  const sessionArg = values.session;
  if (
    extra.length > 0 ||
    !agentName ||
    !/^[a-z][a-z0-9-]*$/.test(agentName) ||
    (dateArg !== undefined && !isValidDate(dateArg)) ||
    (sessionArg !== undefined && !/^[A-Za-z0-9_-]+$/.test(sessionArg))
  ) {
    throw new UsageError(usage);
  }
  if (!existsSync(templateDir)) throw new CliError(`テンプレートが見つかりません: ${templateDir}`);

  // 検証用に記録先だけを差し替えられるようにする (通常は <root>/logs)
  const logsRoot = resolve(process.env.LOGS_ROOT || join(projectRoot(), "logs"));
  const display = (path: string) => join("logs", relative(logsRoot, path));
  const sessionId = sessionArg ?? randomUUID();
  const date = dateArg ?? localDate();
  const [year, month, day] = date.split("-");
  const targetDir = join(logsRoot, year, month, day, agentName, sessionId);

  const createOrReuse = () => {
    const existing = findSession(logsRoot, agentName, sessionId);
    if (existing.length > 1) {
      throw new CliError(`同じセッション ID のログが複数あります: ${existing.map(display).join(", ")}`);
    } else if (existing.length === 1 && existing[0] !== targetDir && dateArg !== undefined) {
      throw new CliError(`セッションは別の日付で開始済みです: ${display(existing[0])}`);
    } else if (existing.length === 1) {
      console.log(`既存のセッションログ: ${display(existing[0])}`);
    } else if (createFromTemplate(logsRoot, targetDir)) {
      console.log(`セッションログを作成しました: ${display(targetDir)}`);
    } else {
      console.log(`既存のセッションログ: ${display(targetDir)}`);
    }
  };

  // 自動採番の UUID は他と衝突しないので、ID を指定したときだけ排他する
  if (sessionArg === undefined) createOrReuse();
  else withLock(join(logsRoot, ".locks", agentName, sessionId), join(logsRoot, ".tmp"), createOrReuse);
}

export function run(argv: string[]): void {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    console.log(usage);
    if (command === undefined) process.exitCode = 2;
    return;
  }
  if (command !== "create") throw new UsageError(`不明なコマンド: log ${command}\n${usage}`);
  create(rest);
}
