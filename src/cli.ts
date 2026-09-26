#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { parseArgs } from "node:util";
import { init, InitError, loadBundle } from "./init.js";

const usage = `使い方:
  raprid init [<dir>] [--no-git] [--dry-run]
  raprid --version
  raprid --help

コマンド:
  init   <dir> (省略時は現在のディレクトリ) にプロジェクト管理リポジトリの初期ファイルを生成する

オプション (init):
  --no-git   git init を行わない (既定では、Git 管理外のときだけ git init する)
  --dry-run  衝突の確認だけ行い、生成するファイルの数を表示する

終了コード:
  0 成功 / 1 生成できなかった (既存ファイルとの衝突・書き込み失敗) / 2 引数の誤り`;

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
  pnpm log:create claude       # agent のセッションログを作る
  README.md と CLAUDE.md を読み、案件は cp -R job/template job/<案件名> で始める`);
  return 0;
}

function main(argv: string[]): number {
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
