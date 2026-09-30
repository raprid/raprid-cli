// 疑似端末 (PTY) で、工程型タスク (workflowVersion 3) がある管理リポジトリの raprid tui を動かす。T-015
// RAPRID_TEST_SCRIPTS に project_template の scripts/ (query-v2・workflow-v3 に対応したもの) を指したときだけ実行する。
// 実端末 (Terminal.app など) での確認の代わりではない (実端末の確認は人が行う)。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "dist", "cli.js");
const harness = join(repoRoot, "test", "pty-harness.py");
const python = spawnSync("python3", ["-c", "import pty, termios"], { encoding: "utf8" }).status === 0;
const scripts = process.env.RAPRID_TEST_SCRIPTS;
const skip = !python || !["darwin", "linux"].includes(process.platform) ? "python3 の pty が使えない環境" : !scripts || !existsSync(join(scripts, "cli.ts")) ? "RAPRID_TEST_SCRIPTS が指定されていない" : false;

let work: string;
let project: string;

interface Result {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  expects: { expect: string; found: boolean }[];
  termios: { icanon: boolean; echo: boolean } | null;
}

function pty(args: string[], steps: unknown[], size: [number, number] = [120, 30]): Result {
  const spec = {
    argv: [process.execPath, cli, ...args],
    cwd: project,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TERM: "xterm-256color", LANG: "ja_JP.UTF-8" },
    cols: size[0],
    rows: size[1],
    steps,
    timeout: 20,
  };
  const file = join(work, `spec-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(spec));
  const run = spawnSync("python3", [harness, file], { encoding: "utf8", timeout: 90_000 });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout) as Result;
}

function check(result: Result): void {
  for (const expect of result.expects) assert.ok(expect.found, `画面に「${expect.expect}」が出る\n${result.output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").slice(-1500)}`);
  assert.equal(result.timedOut, false, "終了する");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.termios, { icanon: true, echo: true }, "canonical と echo に戻る");
  const rest = result.output.slice(result.output.lastIndexOf("\u001b[?1049h"));
  assert.ok(rest.includes("\u001b[?1049l") && rest.includes("\u001b[?25h"), "代替画面から出てカーソルを戻す");
}

const cliRun = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: project, env: { ...process.env, RAPRID_ACTOR: "agent/test" }, encoding: "utf8" });

before(() => {
  if (skip) return;
  work = mkdtempSync(join(tmpdir(), "raprid-tui-workflow-pty-"));
  project = join(work, "p");
  assert.equal(spawnSync(process.execPath, [cli, "init", project], { encoding: "utf8" }).status, 0);
  // 工程型タスクに対応した scripts/ に差し替える
  rmSync(join(project, "scripts"), { recursive: true, force: true });
  cpSync(scripts!, join(project, "scripts"), { recursive: true, filter: (source) => !source.includes("node_modules") });
  for (const args of [
    ["job", "create", "PROJ-1"],
    ["task", "add", "PROJ-1", "legacy", "todo", "旧形式のタスク"],
    ["task", "add", "PROJ-1", "research-a", "--type", "research", "調査のタスク👨‍👩‍👧", "--requested-by", "human/saiki", "--created-by", "agent/codex"],
  ]) {
    const result = cliRun(...args);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  }
});

after(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

test("工程型タスクを種別・工程・担当つきで表示し、ready の一覧から引き受けて保存し、端末を戻す", { skip }, () => {
  const result = pty(
    ["tui", "PROJ-1", "--actor", "human/saiki"],
    [
      { expect: "未移行", timeout: 15 },
      { expect: "調査" },
      { send: "w", after: 0.5 },
      { expect: "ready の工程だけ" },
      { send: "m", after: 0.5 },
      { expect: "工程の操作" },
      { expect: "引き受ける (claim)" },
      { send: "\r", after: 0.5 },
      { expect: "この内容で保存しますか" },
      { send: "\r", after: 2 },
      { expect: "しました", timeout: 10 },
      { send: "q" },
    ],
  );
  check(result);
  const index = readFileSync(join(project, "jobs", "PROJ-1", "tasks", "research-a", "index.md"), "utf8");
  assert.match(index, /\n {2}plan:\n {4}status: progress\n {4}attempt: 1\n {4}assignee: human\/saiki\n/, "scripts/ を通して保存した");
  assert.ok(existsSync(join(project, "jobs", "PROJ-1", "status", "plan", "progress", "research-a")), "作業索引も移った");
});

test("狭い端末 (60 桁) でも工程型タスクの一覧と操作の画面を開いて閉じられる", { skip }, () => {
  // 他の試験に頼らないよう、ready の工程型タスクを作って ready の一覧 (w) から選ぶ
  assert.equal(cliRun("task", "add", "PROJ-1", "narrow", "--type", "implementation", "狭い端末の確認", "--requested-by", "human/saiki", "--created-by", "agent/codex").status, 0);
  const result = pty(
    ["tui", "PROJ-1", "--actor", "human/saiki"],
    [
      { expect: "実装", timeout: 15 },
      { send: "w", after: 0.5 },
      { expect: "ready の工程だけ" },
      { send: "m", after: 0.5 },
      { expect: "工程の操作" },
      { send: "\u001b", after: 0.5 },
      { send: "q" },
    ],
    [60, 20],
  );
  check(result);
});
