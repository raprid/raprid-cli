#!/usr/bin/env node

// 管理リポジトリの操作の共通入口。raprid CLI からも pnpm raprid からもここを実行する。
//   node scripts/cli.ts <group> <command> [...]

import { CliError } from "./lib/errors.ts";
import { capabilities, errorJson, printJson, schemaVersion } from "./lib/query.ts";
import { scriptsInfo } from "./lib/root.ts";

const usage = `使い方: raprid <group> <command> [...]  (pnpm raprid <group> <command> [...] でも同じ)

group:
  job   案件の作成 (create)・一覧 (list)・旧構成からの移行 (migrate)
  task  タスクの追加 (add)・一覧 (list)・詳細表示 (show)・質問 (ask)・状態変更 (move)・詳細の追加 (note)
  qa    QA の追加 (add)・一覧 (list)・詳細表示 (show)・解決 (resolve)・状態変更 (move)
  ui    TUI 用のデータ取得 (snapshot)
  log   agent のセッションログの作成 (create)
  repo  submodule の追加 (add)・worktree の展開 (setup-worktrees)

各 group の使い方は raprid <group> --help で表示する。
list・show は --json で機械向けの JSON (schemaVersion 1) を出す。--capabilities で対応機能を表示する。
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
    qa: () => import("./commands/qa.ts"),
    log: () => import("./commands/log.ts"),
    repo: () => import("./commands/repo.ts"),
    ui: () => import("./commands/ui.ts"),
  };
  if (!loaders[group]) {
    console.error(`不明な group: ${group}\n${usage}`);
    return 2;
  }
  // --json のときは、失敗も stdout に 1 つの JSON として返す
  const json = rest.includes("--json") && !rest.includes("--help") && !rest.includes("-h");
  try {
    (await loaders[group]()).run(rest);
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (error) {
    if (json) {
      const known = error instanceof CliError;
      printJson(errorJson(known ? error.code : "INTERNAL", error instanceof Error ? error.message : String(error)));
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
