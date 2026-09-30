// TUI (raprid tui) がデータを取得するための入口。表示はしない。

import { parse } from "../lib/args.ts";
import { UsageError } from "../lib/errors.ts";
import { parseSchemaVersion, printJson, scopeJobs, snapshotJson } from "../lib/query.ts";
import { Collector } from "../lib/records.ts";
import { projectRoot } from "../lib/root.ts";

export const usage = `使い方:
  raprid ui snapshot [<案件名>] --json [--schema-version 2|3]

snapshot  案件・タスク・QA・診断を、絞り込み前の全状態で 1 つの JSON として出力する
          (raprid tui が使う。各ファイルは読み取った内容で一貫するが、全体の排他はしない)
          既定は schemaVersion 1。工程型 (workflowVersion 2・3) のタスクがあれば SCHEMA_V2_REQUIRED で止まるので、--schema-version 2 を使う
          workflowVersion 4 のタスクがあれば schemaVersion 1・2 は SCHEMA_V3_REQUIRED で止まる。--schema-version 3 は確認待ち (approvals) も返す`;

function snapshot(argv: string[]): void {
  const { positionals, values } = parse(argv, { json: { type: "boolean" }, "schema-version": { type: "string" } }, usage);
  if (positionals.length > 1) throw new UsageError(usage);
  if (!values.json) throw new UsageError(`ui snapshot は --json で実行してください\n${usage}`);
  const version = parseSchemaVersion(values["schema-version"]);
  const collector = new Collector(projectRoot());
  const datas = scopeJobs(collector, positionals[0]).map((job) => collector.job(job));
  printJson(snapshotJson(datas, positionals[0] ?? null, positionals[0] === undefined ? collector.rootIssues : [], new Date(), version));
}

export function run(argv: string[]): void {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    console.log(usage);
    if (command === undefined) process.exitCode = 2;
    return;
  }
  if (command !== "snapshot") throw new UsageError(`不明なコマンド: ui ${command}\n${usage}`);
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(usage);
    return;
  }
  snapshot(rest);
}
