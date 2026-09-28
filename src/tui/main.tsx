// raprid tui の入口。端末と管理リポジトリを確かめてから Ink で画面を開く。
// 通常の CLI 起動では読み込まない (src/cli.ts から tui のときだけ import する)。

import { basename } from "node:path";
import { parseArgs } from "node:util";
import { render } from "ink";
import { currentProject, DelegateError } from "../delegate.js";
import { actorPattern } from "./actions.js";
import { App } from "./app.js";
import { BackendError, ScriptBackend } from "./backend.js";
import { DetailStore, SnapshotStore } from "./stores.js";

export const usage = `使い方:
  raprid tui [<案件名>] [--actor human/<識別子>]

管理リポジトリのタスク・QA・要確認を端末で閲覧する (GitUI 型の画面)。
データは管理リポジトリの scripts/ (ui snapshot・show --json) から 2 秒ごとに取得する。
query-v1 に対応した scripts/ が必要。端末 (TTY) でない場合は raprid task list / qa list (--json) を使う。
キー操作は画面の下部と ? のヘルプに表示する。q または Ctrl+C で終了する。

scripts/ が guarded-write-v1 に対応していれば、a で QA に回答し、m でタスクの状態を変更できる。
更新する人は --actor か最初の更新時の入力で human/<識別子> を指定する (ログイン名などから推測しない)。
保存の前に確認画面を出し、他の変更と競合したときは保存せずに最新の内容を表示する。`;

export interface TuiIo {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

const defaultIo = (): TuiIo => ({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env, cwd: process.cwd() });

export async function runTui(argv: string[], io: TuiIo = defaultIo()): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { help: { type: "boolean", short: "h" }, actor: { type: "string" } } });
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage}\n`);
    return 2;
  }
  if (parsed.values.help) {
    io.stdout.write(`${usage}\n`);
    return 0;
  }
  if (parsed.positionals.length > 1) {
    io.stderr.write(`${usage}\n`);
    return 2;
  }
  const job = parsed.positionals[0] ?? null;
  const actor = parsed.values.actor ?? null;
  if (actor !== null && !actorPattern.test(actor)) {
    io.stderr.write(`--actor は human/<識別子> (英小文字・数字・. _ -) で指定してください: ${actor}\n`);
    return 2;
  }
  if (!io.stdin.isTTY || !io.stdout.isTTY || io.env.TERM === "dumb") {
    io.stderr.write("raprid tui は端末 (TTY) で実行してください。一覧は raprid task list / raprid qa list、機械的に読むときは --json を使ってください。\n");
    return 1;
  }

  let root: string;
  let writable = false;
  try {
    root = currentProject(io.cwd).root;
  } catch (error) {
    if (error instanceof DelegateError) {
      io.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
  const backend = new ScriptBackend(root);
  const snapshots = new SnapshotStore(backend);
  const details = new DetailStore(backend);
  const stop = () => {
    snapshots.dispose();
    details.dispose();
    backend.dispose();
  };
  try {
    const capabilities = await backend.capabilities();
    if (!capabilities.includes("query-v1")) {
      io.stderr.write(
        `このプロジェクトの scripts/ は raprid tui に対応していません (query-v1 が必要): ${root}\n` +
          "project_template の scripts/ を取り込んで更新してください。raprid はプロジェクトを自動で更新しません。\n",
      );
      return 1;
    }
    writable = capabilities.includes("guarded-write-v1");
    // 最初の取得は画面を開く前に行い、存在しない案件はエラーにする
    const first = await backend.snapshot();
    if (job !== null && !first.jobs.some((entry) => entry.name === job)) {
      io.stderr.write(`案件が見つかりません: jobs/${job}\n`);
      return 1;
    }
    snapshots.seed(first);
  } catch (error) {
    stop();
    io.stderr.write(`データを取得できません: ${error instanceof BackendError || error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  snapshots.start();
  const instance = render(
    <App snapshots={snapshots} details={details} initialJob={job} projectName={basename(root)} onUnmount={stop} writer={writable ? backend : undefined} actor={actor} />,
    {
    stdin: io.stdin,
    stdout: io.stdout,
    stderr: io.stderr,
    alternateScreen: true,
      exitOnCtrlC: false, // Ctrl+C は画面側で扱う (保存中の終了を遅らせるため)
    },
  );
  try {
    await instance.waitUntilExit();
    return 0;
  } catch (error) {
    io.stderr.write(`raprid tui が異常終了しました: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    stop();
  }
}
