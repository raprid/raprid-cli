import { cpSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../lib/args.ts";
import { CliError, UsageError } from "../lib/errors.ts";
import { exists, isDirectory, tempPath } from "../lib/fsutil.ts";
import { Job } from "../lib/jobs.ts";
import { projectRoot, templatesDir } from "../lib/root.ts";
import { migrate, usage as migrateUsage } from "./migrate.ts";

export const usage = `使い方:
  raprid job create <案件名>
  raprid job migrate [--dry-run | --apply [--plan <計画ハッシュ>] | --restore <移行ID>]

create   scripts/templates/job/ から jobs/<案件名>/ を作る (既存の案件は上書きしない)
migrate  旧構成 (job/<案件名>/list/ など) を jobs/ の構成へ移す。詳細は raprid job migrate --help

例:
  raprid job create PROJ-123`;

function create(argv: string[]): void {
  const { positionals } = parse(argv, {}, usage);
  if (positionals.length !== 1) throw new UsageError(usage);
  const root = projectRoot();
  const job = new Job(root, positionals[0]);
  const jobsDir = join(root, "jobs");
  if (!isDirectory(jobsDir)) throw new CliError("jobs/ が見つかりません。旧構成なら raprid job migrate を実行してください");
  if (exists(job.dir)) throw new CliError(`同名の案件が存在します: jobs/${job.name}`);
  // 完成した状態でだけ見えるよう、一時ディレクトリに複製してから rename する
  const temp = tempPath(jobsDir, `create-${job.name}`);
  try {
    cpSync(join(templatesDir, "job"), temp, { recursive: true, errorOnExist: true });
    try {
      renameSync(temp, job.dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTEMPTY") throw new CliError(`同名の案件が存在します: jobs/${job.name}`);
      throw error;
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  console.log(`作成: jobs/${job.name}/`);
  console.log(`タスクは raprid task add ${job.name} <タスク名> todo "<タイトル>" で追加してください。`);
}

export function run(argv: string[]): void {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    console.log(usage);
    if (command === undefined) process.exitCode = 2;
    return;
  }
  if (command === "create") {
    if (rest.includes("--help") || rest.includes("-h")) console.log(usage);
    else create(rest);
  } else if (command === "migrate") {
    if (rest.includes("--help") || rest.includes("-h")) console.log(migrateUsage);
    else migrate(rest);
  } else {
    throw new UsageError(`不明なコマンド: job ${command}\n${usage}`);
  }
}
