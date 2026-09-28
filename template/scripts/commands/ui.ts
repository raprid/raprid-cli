// TUI (raprid tui) がデータを取得するための入口。表示はしない。

import { parse } from "../lib/args.ts";
import { UsageError } from "../lib/errors.ts";
import { printJson, scopeJobs, snapshotJson } from "../lib/query.ts";
import { Collector } from "../lib/records.ts";
import { projectRoot } from "../lib/root.ts";

export const usage = `使い方:
  raprid ui snapshot [<案件名>] --json

snapshot  案件・タスク・QA・診断を、絞り込み前の全状態で 1 つの JSON として出力する
          (schemaVersion 1。raprid tui が使う。各ファイルは読み取った内容で一貫するが、全体の排他はしない)`;

function snapshot(argv: string[]): void {
  const { positionals, values } = parse(argv, { json: { type: "boolean" } }, usage);
  if (positionals.length > 1) throw new UsageError(usage);
  if (!values.json) throw new UsageError(`ui snapshot は --json で実行してください\n${usage}`);
  const collector = new Collector(projectRoot());
  const datas = scopeJobs(collector, positionals[0]).map((job) => collector.job(job));
  printJson(snapshotJson(datas, positionals[0] ?? null, positionals[0] === undefined ? collector.rootIssues : []));
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
