import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "create_log.ts");
const execFileAsync = promisify(execFile);
let root: string;

function run(...args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, LOGS_ROOT: root },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function sessions(agentDir: string): string[] {
  return existsSync(agentDir) ? readdirSync(agentDir).sort() : [];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "create-log-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("新規セッションをテンプレートから作成する", () => {
  const result = run("claude", "--date", "2026-09-26", "--session", "s1");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /作成しました: logs\/2026\/09\/26\/claude\/s1/);
  const dir = join(root, "2026", "09", "26", "claude", "s1");
  assert.deepEqual(readdirSync(dir).sort(), ["_.md", "index.md", "outputs"]);
});

test("セッション ID を省略すると当日の UUID ディレクトリを作る", () => {
  const result = run("codex");
  assert.equal(result.status, 0);
  const path = result.stdout.match(/logs\/(\d{4})\/(\d{2})\/(\d{2})\/codex\/([0-9a-f-]{36})/);
  assert.ok(path, result.stdout);
  const now = new Date();
  assert.equal(path[1], String(now.getFullYear()));
});

test("同じ ID で再実行しても既存の記録を変更しない", () => {
  run("claude", "--date", "2026-09-26", "--session", "s1");
  const index = join(root, "2026", "09", "26", "claude", "s1", "index.md");
  writeFileSync(index, "記録済み\n");
  const result = run("claude", "--date", "2026-09-26", "--session", "s1");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /既存のセッションログ/);
  assert.equal(readFileSync(index, "utf8"), "記録済み\n");
});

test("同じ日・同じ agent の複数セッションは別ディレクトリになる", () => {
  run("claude", "--date", "2026-09-26");
  run("claude", "--date", "2026-09-26");
  run("claude", "--date", "2026-09-26", "--session", "s1");
  assert.equal(sessions(join(root, "2026", "09", "26", "claude")).length, 3);
});

test("別 agent は同じセッション ID でも衝突しない", () => {
  run("claude", "--date", "2026-09-26", "--session", "s1");
  run("codex", "--date", "2026-09-26", "--session", "s1");
  assert.ok(existsSync(join(root, "2026", "09", "26", "claude", "s1")));
  assert.ok(existsSync(join(root, "2026", "09", "26", "codex", "s1")));
});

test("日付を省略して再開すると開始日のディレクトリを使う", () => {
  run("claude", "--date", "2026-09-25", "--session", "s1");
  const result = run("claude", "--session", "s1");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /既存のセッションログ: logs\/2026\/09\/25\/claude\/s1/);
  assert.equal(readdirSync(root).length, 1);
  assert.deepEqual(sessions(join(root, "2026", "09")), ["25"]);
});

test("開始日と異なる日付を指定すると重複を作らずに失敗する", () => {
  run("claude", "--date", "2026-09-25", "--session", "s1");
  const result = run("claude", "--date", "2026-09-26", "--session", "s1");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /別の日付で開始済み/);
  assert.equal(existsSync(join(root, "2026", "09", "26")), false);
});

test("不正な引数は使い方を表示して失敗する", () => {
  for (const args of [
    [],
    ["Claude"],
    ["claude", "--date", "2026-02-30"],
    ["claude", "--date", "2026/09/26"],
    ["claude", "--session", "../x"],
    ["claude", "--session", "a b"],
    ["claude", "--unknown"],
    ["claude", "extra"],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, /使い方/);
  }
  assert.deepEqual(readdirSync(root), []);
});

test("同時に作成しても1つだけ作られ、どれも成功する", async () => {
  const runs = Array.from({ length: 8 }, () =>
    execFileAsync(process.execPath, [script, "claude", "--date", "2026-09-26", "--session", "s1"], {
      env: { ...process.env, LOGS_ROOT: root },
    }),
  );
  const results = await Promise.all(runs);
  const created = results.filter((result) => result.stdout.includes("作成しました"));
  assert.equal(created.length, 1);
  const dir = join(root, "2026", "09", "26", "claude", "s1");
  assert.deepEqual(readdirSync(dir).sort(), ["_.md", "index.md", "outputs"]);
});
