// 疑似端末 (PTY) で raprid tui を動かし、キー操作・端末サイズの変更・シグナル・異常終了の後に
// 端末が元に戻る (代替画面を出る・カーソルを出す・canonical/echo に戻る) ことを確かめる。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "dist", "cli.js");
const harness = join(repoRoot, "test", "pty-harness.py");
const python = spawnSync("python3", ["-c", "import pty, termios"], { encoding: "utf8" }).status === 0;
const skip = !python || !["darwin", "linux"].includes(process.platform) ? "python3 の pty が使えない環境" : false;

let work: string;
let project: string;

type Step =
  | { expect: string; timeout?: number }
  | { send: string; after?: number }
  | { wait: number }
  | { resize: [number, number]; after?: number }
  | { signal: string; after?: number }
  | { run: string[]; env?: Record<string, string>; after?: number };

interface Result {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  expects: { expect: string; found: boolean; at: number }[];
  signals: { signal: string; pid: number | null; sent: boolean; error: string | null }[];
  termios: { icanon: boolean; echo: boolean } | null;
}

// 失敗したときに原因を追えるよう、終了状態・シグナル・出力の末尾を添える
function describe(result: Result): string {
  const tail = result.output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").slice(-800);
  return JSON.stringify({ exitCode: result.exitCode, timedOut: result.timedOut, signals: result.signals, termios: result.termios }) + `\n${tail}`;
}

function pty(args: string[], steps: Step[], options: { cwd?: string; cols?: number; rows?: number; env?: Record<string, string> } = {}): Result {
  const spec = {
    argv: [process.execPath, cli, ...args],
    cwd: options.cwd ?? project,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TERM: "xterm-256color", LANG: "ja_JP.UTF-8", ...options.env },
    cols: options.cols ?? 100,
    rows: options.rows ?? 24,
    steps,
    timeout: 15,
  };
  const file = join(work, `spec-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(spec));
  const run = spawnSync("python3", [harness, file], { encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout) as Result;
}

function assertRestored(result: Result): void {
  assert.equal(result.timedOut, false, `終了する\n${describe(result)}`);
  assert.deepEqual(result.termios, { icanon: true, echo: true }, `canonical と echo に戻る\n${describe(result)}`);
  const entered = result.output.lastIndexOf("\u001b[?1049h");
  assert.ok(entered >= 0, "代替画面に入る");
  const rest = result.output.slice(entered);
  assert.ok(rest.includes("\u001b[?1049l"), "代替画面から出る");
  assert.ok(rest.includes("\u001b[?25h"), "カーソルを表示に戻す");
}

function allFound(result: Result): void {
  for (const expect of result.expects) assert.ok(expect.found, `画面に「${expect.expect}」が出る\n${result.output.slice(-2000)}`);
}

before(() => {
  work = mkdtempSync(join(tmpdir(), "raprid-tui-pty-"));
  project = join(work, "p");
  assert.equal(spawnSync(process.execPath, [cli, "init", project], { encoding: "utf8" }).status, 0);
  const env = { ...process.env, RAPRID_ACTOR: "agent/test" };
  const run = (...args: string[]) => assert.equal(spawnSync(process.execPath, [cli, ...args], { cwd: project, env, encoding: "utf8" }).status, 0, args.join(" "));
  run("job", "create", "PROJ-1");
  run("task", "add", "PROJ-1", "first", "todo", "最初のタスク");
  run("task", "add", "PROJ-1", "second", "todo", "二番目のタスク👨‍👩‍👧");
  run("qa", "add", "PROJ-1", "question", "customer", "確認したいこと");
});

after(() => {
  rmSync(work, { recursive: true, force: true });
});

test("q で終了すると端末が元に戻る", { skip }, () => {
  const result = pty(["tui"], [{ expect: "> T-001" , timeout: 10 }, { send: "\u001b[B", after: 0.3 }, { expect: "> T-002" }, { send: "q" }]);
  allFound(result);
  assert.equal(result.exitCode, 0);
  assertRestored(result);
});

test("別の CLI で追加したタスクが 2 秒ごとの再取得で現れる", { skip }, () => {
  const result = pty(
    ["tui", "PROJ-1"],
    [
      { expect: "> T-001", timeout: 10 },
      { run: [process.execPath, cli, "task", "add", "PROJ-1", "later", "todo", "あとから追加したタスク"], env: { RAPRID_ACTOR: "agent/test" } },
      { expect: "あとから追加したタスク", timeout: 6 },
      { expect: "[1 task 3]" },
      { send: "q" },
    ],
  );
  allFound(result);
  assert.equal(result.exitCode, 0);
  assertRestored(result);
});

test("Ctrl+C でも終了し、端末が元に戻る", { skip }, () => {
  const result = pty(["tui", "PROJ-1"], [{ expect: "案件: PROJ-1", timeout: 10 }, { send: "\u0003" }]);
  allFound(result);
  assert.equal(result.exitCode, 0);
  assertRestored(result);
});

test("端末を小さくすると案内を出し、広げると選択を保ったまま戻る", { skip }, () => {
  const result = pty(
    ["tui"],
    [
      { expect: "> T-001", timeout: 10 },
      { send: "\u001b[B", after: 0.3 },
      { expect: "> T-002" },
      { resize: [30, 10], after: 0.5 },
      { expect: "端末が小さすぎます" },
      { expect: "(30x10)" },
      { send: "\u001b[A", after: 0.2 }, // 小さい間の操作は無視する
      { resize: [130, 24], after: 0.5 },
      { expect: "> T-002" },
      { expect: "案件" },
      { send: "q" },
    ],
  );
  allFound(result);
  assert.equal(result.exitCode, 0);
  assertRestored(result);
});

function fakeProject(name: string, body: string): string {
  const root = join(work, name);
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "jobs"), { recursive: true });
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "scripts", "package.json"), JSON.stringify({ type: "module", raprid: { format: 1, protocol: 1 } }));
  writeFileSync(join(root, "scripts", "cli.ts"), body);
  return root;
}

const emptySnapshot = { schemaVersion: 1, generatedAt: "2026-09-28T00:00:00.000Z", scope: { job: null }, jobs: [{ name: "PROJ-1", path: "jobs/PROJ-1", title: null, counts: { task: { total: 0, byStatus: {} }, qa: { total: 0, byStatus: {} } } }], tasks: [], qas: [], issues: [] };

test("SIGTERM で終了すると、取得中の子プロセスを止めて端末を戻す", { skip }, () => {
  const pidFile = join(work, "hung.pid");
  const marker = join(work, "first-done");
  const root = fakeProject(
    "hang",
    `import { existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--capabilities") console.log(JSON.stringify({ schemaVersion: 1, capabilities: ["query-v1"] }));
else if (args[0] === "ui" && !existsSync(${JSON.stringify(marker)})) { writeFileSync(${JSON.stringify(marker)}, ""); console.log(${JSON.stringify(JSON.stringify(emptySnapshot))}); }
else if (args[0] === "ui") { writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60_000); }
`,
  );
  const result = pty(["tui"], [{ expect: "該当する項目がありません", timeout: 10 }, { wait: 3 }, { signal: "TERM", after: 1 }], { cwd: root });
  allFound(result);
  assert.deepEqual(result.signals.map((entry) => [entry.signal, entry.sent, entry.error]), [["TERM", true, null]], describe(result));
  assert.equal(result.exitCode, 143, `SIGTERM で終了する\n${describe(result)}`);
  assertRestored(result);
  assert.ok(existsSync(pidFile), "2 秒後の取得が実行中だった");
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), "取得中の子プロセスが残らない");
});

test("描画中の例外で異常終了しても端末を戻す", { skip }, () => {
  const broken = { ...emptySnapshot, tasks: [{ job: "PROJ-1", kind: "task", id: "T-001", name: "x", path: "jobs/PROJ-1/tasks/x/index.md", title: "壊れた応答", status: "pending", blockedBy: null }] };
  const root = fakeProject(
    "broken",
    `const args = process.argv.slice(2);
if (args[0] === "--capabilities") console.log(JSON.stringify({ schemaVersion: 1, capabilities: ["query-v1"] }));
else if (args[0] === "ui") console.log(${JSON.stringify(JSON.stringify(broken))});
else { console.log(JSON.stringify({ schemaVersion: 1, error: { code: "NOT_FOUND", message: "無い" } })); process.exitCode = 1; }
`,
  );
  const result = pty(["tui"], [{ expect: "異常終了しました", timeout: 10 }], { cwd: root });
  allFound(result);
  assert.equal(result.exitCode, 1);
  assertRestored(result);
});

test("端末でない・TERM=dumb・非対応の scripts/・存在しない案件は画面を開かずに終了する", { skip }, () => {
  const piped = spawnSync(process.execPath, [cli, "tui"], { cwd: project, encoding: "utf8" });
  assert.equal(piped.status, 1);
  assert.match(piped.stderr, /端末 \(TTY\) で実行してください。一覧は raprid task list/);
  const help = spawnSync(process.execPath, [cli, "tui", "--help"], { cwd: project, encoding: "utf8" });
  assert.equal(help.status, 0, "--help は端末でなくても使える");
  assert.match(help.stdout, /raprid tui \[<案件名>\]/);
  assert.equal(spawnSync(process.execPath, [cli, "tui", "a", "b"], { cwd: project, encoding: "utf8" }).status, 2);

  const dumb = pty(["tui"], [{ expect: "端末 (TTY) で実行してください", timeout: 10 }], { env: { TERM: "dumb" } });
  allFound(dumb);
  assert.equal(dumb.exitCode, 1);
  assert.doesNotMatch(dumb.output, /\u001b\[\?1049h/, "画面を開かない");

  const legacy = fakeProject("legacy", `console.error("不明な group"); process.exitCode = 2;\n`);
  const unsupported = pty(["tui"], [{ expect: "query-v1 が必要", timeout: 10 }], { cwd: legacy });
  allFound(unsupported);
  assert.equal(unsupported.exitCode, 1);
  assert.match(unsupported.output, /自動で更新しません/);
  assert.ok(!existsSync(join(legacy, "jobs", "PROJ-1")), "init・移行・展開をしない");

  const missing = pty(["tui", "NOPE"], [{ expect: "案件が見つかりません: jobs/NOPE", timeout: 10 }]);
  allFound(missing);
  assert.equal(missing.exitCode, 1);

  const outside = mkdtempSync(join(tmpdir(), "raprid-tui-none-"));
  try {
    mkdirSync(join(outside, ".git"));
    const none = pty(["tui"], [{ expect: "管理リポジトリが見つかりません", timeout: 10 }], { cwd: outside });
    allFound(none);
    assert.equal(none.exitCode, 1);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("複数行の回答と貼り付けを保存し、別の CLI の回答と競合したら上書きせずに下書きを残す", { skip }, () => {
  const root = join(work, "write");
  assert.equal(spawnSync(process.execPath, [cli, "init", root], { encoding: "utf8" }).status, 0);
  const env = { ...process.env, RAPRID_ACTOR: "agent/test" };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: "utf8" });
  assert.equal(run("job", "create", "PROJ-1").status, 0);
  assert.equal(run("task", "add", "PROJ-1", "impl", "progress", "実装する").status, 0);
  assert.equal(run("task", "ask", "PROJ-1", "T-001", "policy", "customer", "方針はこれでよいか").status, 0);
  assert.equal(run("qa", "add", "PROJ-1", "second", "internal", "二つ目の質問").status, 0);

  const saved = pty(
    ["tui", "PROJ-1", "--actor", "human/tester"],
    [
      { expect: "> T-001", timeout: 10 },
      { send: "2", after: 0.3 },
      { send: "a", after: 0.3 },
      { expect: "Q-001 への回答" },
      { send: "日本語の回答", after: 0.1 },
      { send: "\r", after: 0.1 },
      { send: "\u001b[200~## 貼り付けた見出し\r\n\r\n```sh\n## コード\n```\u001b[201~", after: 0.3 },
      { send: "\t", after: 0.2 },
      { send: "\r", after: 0.3 },
      { expect: "この内容で回答を保存しますか" },
      { send: "\r", after: 0.2 },
      { expect: "Q-001 に回答しました", timeout: 8 },
      { expect: "を待っていたタスク" },
      { send: "\u001b", after: 0.3 },
      { send: "q" },
    ],
    { cwd: root },
  );
  allFound(saved);
  assert.equal(saved.exitCode, 0);
  assertRestored(saved);
  const answer = JSON.parse(run("qa", "show", "PROJ-1", "Q-001", "--json").stdout).item;
  assert.equal(answer.answer, "日本語の回答\n## 貼り付けた見出し\n\n```sh\n## コード\n```");
  assert.equal(answer.answeredBy, "human/tester");
  assert.equal(JSON.parse(run("task", "show", "PROJ-1", "T-001", "--json").stdout).item.status, "pending", "回答してもタスクは自動で再開しない");

  const conflict = pty(
    ["tui", "PROJ-1", "--actor", "human/tester"],
    [
      { expect: "> T-001", timeout: 10 },
      { send: "2", after: 0.3 },
      { expect: "> Q-002" },
      { send: "a", after: 0.3 },
      { send: "TUI の下書き", after: 0.2 },
      { run: [process.execPath, cli, "qa", "resolve", "PROJ-1", "Q-002", "CLI の回答", "--answered-by", "human/cli"] },
      { send: "\t", after: 0.2 },
      { send: "\r", after: 0.3 },
      { send: "\r", after: 0.2 },
      { expect: "競合したため保存しませんでした", timeout: 8 },
      { expect: "CLI の回答" },
      { expect: "TUI の下書き" },
      { send: "\u001b", after: 0.3 },
      { expect: "破棄しますか" },
      { send: "y", after: 0.3 },
      { send: "q" },
    ],
    { cwd: root },
  );
  allFound(conflict);
  assert.equal(conflict.exitCode, 0);
  assertRestored(conflict);
  const second = JSON.parse(run("qa", "show", "PROJ-1", "Q-002", "--json").stdout).item;
  assert.deepEqual([second.answer, second.answeredBy], ["CLI の回答", "human/cli"], "先に保存した回答を上書きしない");
});
