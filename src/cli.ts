#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { parseArgs } from "node:util";
import { delegate, DelegateError } from "./delegate.js";
import { init, InitError, loadBundle } from "./init.js";

const usage = `使い方:
  raprid init [<dir>] [--no-git] [--dry-run]
  raprid <group> <command> [...]
  raprid --version
  raprid --help

コマンド:
  init   <dir> (省略時は現在のディレクトリ) にプロジェクト管理リポジトリの初期ファイルを生成する
  job    案件の作成 (create)・旧構成 job/ からの移行 (migrate)
  task   タスクの追加 (add)・一覧 (list)・状態変更 (move)・詳細の追加 (note)
  qa     QA の追加 (add)・一覧 (list)・解決 (resolve)・状態変更 (move)
  log    agent のセッションログの作成 (create)
  repo   submodule の追加 (add)・worktree の展開 (setup-worktrees)

init 以外は、カレントディレクトリから上へ管理リポジトリ (scripts/cli.ts) を探して処理を委譲する。
各 group の使い方は、管理リポジトリの中で raprid <group> --help を実行して表示する。
旧構成 (job/) のプロジェクトでは raprid job migrate だけを同梱の移行処理で実行できる。

オプション (init):
  --no-git   git init を行わない (既定では、Git 管理外のときだけ git init する)
  --dry-run  衝突の確認だけ行い、生成するファイルの数を表示する

終了コード:
  0 成功 / 1 操作できなかった (衝突・書き込み失敗・管理リポジトリが無い・版が非対応) / 2 引数の誤り`;

const groups = new Set(["job", "task", "qa", "log", "repo"]);

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

// POSIX シェルで変数展開・コマンド置換を防ぎ、単一引用符自体もリテラルにする。
function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function parse(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        "no-git": { type: "boolean" },
        "dry-run": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function runInit(target: string, git: boolean, dryRun: boolean): number {
  const bundle = loadBundle();
  const result = init({ target, git, dryRun }, bundle);
  const shown = relative(process.cwd(), result.root) || ".";
  if (dryRun) {
    console.log(`衝突はありません。${shown} に ${bundle.entries.length} 件のファイルを生成できます。`);
    return 0;
  }
  console.log(`${shown} に ${result.written} 件のファイルを生成しました (雛形: ${bundle.source.commit.slice(0, 7)})。`);
  const gitMessage = {
    initialized: "git init を実行しました。",
    existing: "既存の Git 作業ツリー内のため、git init は行っていません。",
    skipped: "git init は行っていません (--no-git)。",
    unavailable: "git init に失敗しました。必要なら手動で実行してください。",
  }[result.git];
  console.log(gitMessage);
  console.log(`
次の手順:
  cd ${shellQuote(shown.startsWith("-") ? `./${shown}` : shown)}
  pnpm install                 # 型チェック・テスト用の依存 (Node.js 24 以上)
  raprid log create claude     # agent のセッションログを作る (pnpm log:create claude も同じ)
  raprid job create <案件名>   # 案件を始める
  README.md と CLAUDE.md を読んで使い始める`);
  return 0;
}

function main(argv: string[]): number {
  // init 以外の group は引数をそのまま管理リポジトリの scripts/cli.ts に渡す
  if (argv.length > 0 && groups.has(argv[0])) {
    try {
      return delegate(argv, loadBundle);
    } catch (error) {
      if (error instanceof DelegateError) {
        console.error(error.message);
        return 1;
      }
      throw error;
    }
  }
  const parsed = parse(argv);
  if (!parsed) {
    console.error(usage);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    console.log(version());
    return 0;
  }
  const [command, ...rest] = positionals;
  if (values.help || command === undefined || command === "help") {
    console.log(usage);
    return command === undefined && !values.help ? 2 : 0;
  }
  if (command !== "init" || rest.length > 1) {
    console.error(command === "init" ? "生成先は 1 つだけ指定してください。" : `不明なコマンド: ${command}`);
    console.error(usage);
    return 2;
  }
  try {
    return runInit(rest[0] ?? ".", !values["no-git"], values["dry-run"] ?? false);
  } catch (error) {
    if (error instanceof InitError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

process.exitCode = main(process.argv.slice(2));
