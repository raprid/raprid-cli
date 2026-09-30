#!/usr/bin/env node

// 管理リポジトリの操作の共通入口。raprid CLI からも pnpm raprid からもここを実行する。
//   node scripts/cli.ts <group> <command> [...]

import { CliError } from "./lib/errors.ts";
import { capabilities, errorJson, printJson, response, schemaVersion } from "./lib/query.ts";
import { scriptsInfo } from "./lib/root.ts";

const usage = `使い方: raprid <group> <command> [...]  (pnpm raprid <group> <command> [...] でも同じ)

group:
  job   案件の作成 (create)・一覧 (list)・旧構成からの移行 (migrate)・工程型への移行 (migrate-workflow)
  task  タスクの追加 (add)・一覧 (list)・詳細表示 (show)・質問 (ask)・状態変更 (move)・詳細の追加 (note)・工程の操作
  approval 人の判断記録 (workflowVersion 4) の確認待ちの一覧 (list)・詳細 (show)・引受 (claim)・判断者の変更 (assign)・承認 (approve)・見送り (reject)
  qa    QA の追加 (add)・一覧 (list)・詳細表示 (show)・解決 (resolve)・状態変更 (move)
  ui    TUI 用のデータ取得 (snapshot)
  log   agent のセッションログの作成 (create)
  repo  submodule の追加 (add)・worktree の展開 (setup-worktrees)

各 group の使い方は raprid <group> --help で表示する。
list・show は --json で機械向けの JSON を出す (既定は schemaVersion 1。工程型のタスクは --schema-version 2、workflowVersion 4 のタスクは --schema-version 3)。
approval の JSON は常に schemaVersion 3。--capabilities で対応機能を表示する。
終了コード: 0 成功 / 1 操作の失敗 / 2 引数の誤り`;

async function main(argv: string[]): Promise<number> {
  const [group, ...rest] = argv;
  if (group === undefined || group === "--help" || group === "-h" || group === "help") {
    console.log(usage);
    return group === undefined ? 2 : 0;
  }
  if (group === "--protocol") {
    console.log(JSON.stringify(scriptsInfo()));
    return 0;
  }
  if (group === "--capabilities") {
    printJson({ schemaVersion, capabilities });
    return 0;
  }
  // 使う group だけを読み込む (log create の排他処理に他の group の読み込みを挟まない)
  const loaders: Record<string, () => Promise<{ run: (args: string[]) => void }>> = {
    job: () => import("./commands/job.ts"),
    task: () => import("./commands/task.ts"),
    approval: () => import("./commands/approval.ts"),
    qa: () => import("./commands/qa.ts"),
    log: () => import("./commands/log.ts"),
    repo: () => import("./commands/repo.ts"),
    ui: () => import("./commands/ui.ts"),
  };
  if (!loaders[group]) {
    console.error(`不明な group: ${group}\n${usage}`);
    return 2;
  }
  // --json のときは、失敗も stdout に 1 つの JSON として返す。工程の操作と --schema-version 2 は schemaVersion 2 で返す。
  // approval・v4 にだけある操作 (send-back・revise)・--schema-version 3・v4 のタスクへ振り分けた操作は schemaVersion 3 で返す
  const json = rest.includes("--json") && !rest.includes("--help") && !rest.includes("-h");
  const workflowCommand = group === "task" && ["claim", "assign", "complete", "decide", "block", "resume", "reopen"].includes(rest[0] ?? "");
  const v4Command = group === "approval" || (group === "task" && ["send-back", "revise"].includes(rest[0] ?? ""));
  const schemaOption = (version: string) => rest.includes(`--schema-version=${version}`) || rest.some((value, index) => value === "--schema-version" && rest[index + 1] === version);
  const errorVersion = v4Command || schemaOption("3") ? 3 : workflowCommand || schemaOption("2") ? 2 : 1;
  try {
    (await loaders[group]()).run(rest);
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (error) {
    if (json) {
      const known = error instanceof CliError;
      printJson(errorJson(known ? error.code : "INTERNAL", error instanceof Error ? error.message : String(error), response.version ?? errorVersion));
      return known ? error.exitCode : 1;
    }
    if (error instanceof CliError) {
      console.error(error.exitCode === 2 ? error.message : `error: ${error.message}`);
      return error.exitCode;
    }
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
