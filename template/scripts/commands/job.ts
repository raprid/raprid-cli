import { cpSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../lib/args.ts";
import { CliError, UsageError } from "../lib/errors.ts";
import { exists, isDirectory, tempPath } from "../lib/fsutil.ts";
import { Job } from "../lib/jobs.ts";
import { assertCompatible, issuesOf, jobJson, parseSchemaVersion, printJson } from "../lib/query.ts";
import { Collector } from "../lib/records.ts";
import { projectRoot, templatesDir } from "../lib/root.ts";
import { sanitize } from "../lib/text.ts";
import { migrate, usage as migrateUsage } from "./migrate.ts";
import { migrateWorkflow, usage as migrateWorkflowUsage } from "./migrate-workflow.ts";

export const usage = `使い方:
  raprid job create <案件名>
  raprid job list [--search <文字列>] [--json [--schema-version 2|3]]
  raprid job migrate [--dry-run | --apply [--plan <計画ハッシュ>] | --restore <移行ID>]
  raprid job migrate-workflow --map <対応表> [--dry-run | --apply --plan <計画ハッシュ>] | --restore <移行ID>

create   scripts/templates/job/ から jobs/<案件名>/ を作る (既存の案件は上書きしない)
list     jobs/ 配下の案件を名前順に表示する (--search で名前の部分一致、--json で件数・診断付きの JSON)
migrate  旧構成 (job/<案件名>/list/ など) を jobs/ の構成へ移す。詳細は raprid job migrate --help
migrate-workflow  旧形式・workflowVersion 2 のタスクを workflowVersion 3 (種別と工程) へ移す。詳細は raprid job migrate-workflow --help

例:
  raprid job create PROJ-123
  raprid job list`;

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
  console.log(`タスクは raprid task add ${job.name} <タスク名> todo "<タイトル>" --requested-by <actor> --created-by <actor> で追加してください。`);
}

function list(argv: string[]): void {
  const { positionals, values } = parse(argv, { json: { type: "boolean" }, search: { type: "string" }, "schema-version": { type: "string" } }, usage);
  if (positionals.length !== 0) throw new UsageError(usage);
  const version = parseSchemaVersion(values["schema-version"]);
  if (values.search !== undefined && values.search.trim() === "") throw new UsageError("--search には空でない文字列を指定してください");
  const needle = values.search?.toLowerCase();
  const collector = new Collector(projectRoot());
  const all = collector.jobs();
  const shown = needle === undefined ? all : all.filter((job) => job.name.toLowerCase().includes(needle));
  if (values.json) {
    // 件数と診断のために案件の中身も読む (表示は名前だけなので、通常の一覧では読まない)
    const datas = all.map((job) => collector.job(job));
    const names = new Set(shown.map((job) => job.name));
    // schemaVersion 1 の件数 (byStatus) は旧形式の状態だけ。工程型のタスクがあれば止める。v4 のタスクがあれば 1・2 も止める (T-022)
    assertCompatible(datas.flatMap((data) => data.tasks.map((entry) => entry.record)), version);
    printJson({
      schemaVersion: version,
      kind: "job",
      items: datas.filter((data) => names.has(data.job.name)).map((data) => jobJson(data.record)),
      counts: { total: all.length, shown: shown.length, byStatus: {} },
      issues: [...issuesOf(datas), ...collector.rootIssues],
    });
    return;
  }
  console.log(`案件 (${shown.length})`);
  for (const job of shown) console.log(`  ${sanitize(job.name)}`);
  console.log(needle === undefined ? `合計: ${all.length}` : `合計: ${shown.length} (全${all.length}件中)`);
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
  } else if (command === "list") {
    if (rest.includes("--help") || rest.includes("-h")) console.log(usage);
    else list(rest);
  } else if (command === "migrate") {
    if (rest.includes("--help") || rest.includes("-h")) console.log(migrateUsage);
    else migrate(rest);
  } else if (command === "migrate-workflow") {
    if (rest.includes("--help") || rest.includes("-h")) console.log(migrateWorkflowUsage);
    else migrateWorkflow(rest);
  } else {
    throw new UsageError(`不明なコマンド: job ${command}\n${usage}`);
  }
}
