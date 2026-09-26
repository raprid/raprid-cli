import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "create_log.ts");
const execFileAsync = promisify(execFile);
let root: string;
const children: ReturnType<typeof controlled>[] = [];

function allSessions(session: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((path) => /^\d{4}\/\d{2}\/\d{2}\/claude\//.test(path) && path.endsWith(`/${session}`)).sort();
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!check()) {
    assert.ok(performance.now() < deadline, "子プロセスの同期地点に到達しない");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// 製品コードに検証専用の分岐を入れず、子プロセスの時計と fs の境界を制御する。
function controlled(args: string[], options: { date?: string; pause?: "copy" | "unlink"; failCopy?: boolean; clockOffset?: number } = {}): {
  child: ReturnType<typeof spawn>;
  result: Promise<{ status: number | null; stdout: string; stderr: string }>;
  prefix: string;
  resume: () => void;
} {
  const prefix = join(root, `hook-${children.length}`);
  const hook = `${prefix}.cjs`;
  writeFileSync(hook, `
    const fs = require("node:fs");
    const options = ${JSON.stringify(options)};
    const prefix = ${JSON.stringify(prefix)};
    const RealDate = Date;
    global.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [options.date || RealDate.now()])); }
      static now() { return RealDate.now() + (options.clockOffset || 0); }
    };
    function pause() {
      fs.writeFileSync(prefix + ".ready", "");
      while (!fs.existsSync(prefix + ".resume")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    const copy = fs.cpSync;
    fs.cpSync = (...args) => {
      if (options.pause === "copy") pause();
      if (options.failCopy) throw new Error("複製失敗の模擬");
      return copy(...args);
    };
    const unlink = fs.unlinkSync;
    let paused = false;
    fs.unlinkSync = (...args) => {
      if (options.pause === "unlink" && !paused) { paused = true; pause(); }
      return unlink(...args);
    };
    const rename = fs.renameSync;
    let attempts = 0;
    fs.renameSync = (...args) => {
      fs.writeFileSync(prefix + ".attempt", String(++attempts));
      return rename(...args);
    };
    require("node:module").syncBuiltinESMExports();
  `);
  const child = spawn(process.execPath, ["--require", hook, script, ...args], {
    env: { ...process.env, LOGS_ROOT: root }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const result = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  const control = { child, result, prefix, resume: () => writeFileSync(`${prefix}.resume`, "") };
  children.push(control);
  return control;
}

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

afterEach(async () => {
  for (const control of children) if (control.child.exitCode === null) control.child.kill("SIGKILL");
  await Promise.allSettled(children.map((control) => control.result));
  children.length = 0;
  rmSync(root, { recursive: true, force: true });
});

test("新規セッションをテンプレートから作成する", () => {
  const result = run("claude", "--date", "2026-09-26", "--session", "s1");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /作成しました: logs\/2026\/09\/26\/claude\/s1/);
  const dir = join(root, "2026", "09", "26", "claude", "s1");
  assert.deepEqual(readdirSync(dir).sort(), ["_.md", "index.md", "outputs"]);
});

test("既存と報告された時点でテンプレートの複製が済んでいる", async () => {
  const runs = Array.from({ length: 8 }, () =>
    execFileAsync(process.execPath, [script, "claude", "--session", "s1"], {
      env: { ...process.env, LOGS_ROOT: root },
    }).then((result) => {
      // 自分が返った瞬間に、完成したディレクトリが見えていること
      const path = result.stdout.match(/logs\/(.+)$/m)?.[1];
      assert.ok(path, result.stdout);
      return readdirSync(join(root, path)).sort();
    }),
  );
  for (const listing of await Promise.all(runs)) {
    assert.deepEqual(listing, ["_.md", "index.md", "outputs"]);
  }
});

test("日付の異なる同時実行でも同じセッションは1つだけ作られる", async () => {
  for (let i = 0; i < 5; i++) {
    const session = `race-${i}`;
    const variants = [["--date", "2026-09-25"], ["--date", "2026-09-26"], []];
    const results = await Promise.allSettled(
      variants.map((extra) =>
        execFileAsync(process.execPath, [script, "claude", "--session", session, ...extra], {
          env: { ...process.env, LOGS_ROOT: root },
        }),
      ),
    );
    const paths = allSessions(session);
    assert.equal(paths.length, 1, `${session}: ${paths.join(",")}`);
    let created = 0;
    for (const result of results) {
      if (result.status === "fulfilled") {
        assert.ok(result.value.stdout.includes(`logs/${paths[0]}`), result.value.stdout);
        if (result.value.stdout.includes("作成しました")) created++;
      } else {
        assert.equal(result.reason.code, 1);
        assert.match(result.reason.stderr, /別の日付で開始済み/);
      }
    }
    assert.equal(created, 1);
    assert.equal(results[2].status, "fulfilled", "日付省略の再開は成功する");
  }
});

test("作業用のディレクトリを残さない", () => {
  run("claude", "--session", "s1");
  run("claude");
  assert.deepEqual(readdirSync(join(root, ".tmp")), []);
  assert.deepEqual(readdirSync(join(root, ".locks", "claude")), []);
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
  assert.deepEqual(readdirSync(root).filter((name) => /^\d{4}$/.test(name)), ["2026"]);
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

for (const date of ["2026-10-01T12:00:00", "2027-01-01T12:00:00"]) {
  test(`日付省略側が先行しても全日付を検証する (${date})`, async () => {
    const first = controlled(["claude", "--session", "calendar"], { date, pause: "copy" });
    await waitFor(() => existsSync(`${first.prefix}.ready`));
    const others = ["2026-09-25", "2026-09-26"].map((day) =>
      controlled(["claude", "--session", "calendar", "--date", day]));
    await Promise.all(others.map((other) => waitFor(() => existsSync(`${other.prefix}.attempt`))));
    first.resume();
    const result = await first.result;
    assert.equal(result.status, 0, result.stderr);
    const paths = allSessions("calendar");
    assert.deepEqual(paths, [`${date.slice(0, 10).replaceAll("-", "/")}/claude/calendar`]);
    for (const other of others) {
      const result = await other.result;
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /別の日付で開始済み/);
    }
  });
}

test("30秒を過ぎても生存中の所有者を奪わず、再開後に同じ記録を使う", async () => {
  const args = ["claude", "--session", "slow"];
  const first = controlled([...args, "--date", "2026-09-25"], { pause: "copy" });
  await waitFor(() => existsSync(`${first.prefix}.ready`));
  const lock = join(root, ".locks", "claude", "slow");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  const follower = controlled([...args, "--date", "2026-09-26"], { clockOffset: 31_000 });
  await waitFor(() => existsSync(`${follower.prefix}.attempt`));
  await waitFor(() => Number(readFileSync(`${follower.prefix}.attempt`, "utf8")) >= 2);
  assert.deepEqual(allSessions("slow"), []);
  assert.equal(follower.child.exitCode, null);
  first.resume();
  assert.equal((await first.result).status, 0);
  const next = await follower.result;
  assert.equal(next.status, 1, next.stderr);
  assert.match(next.stderr, /別の日付で開始済み/);
  assert.deepEqual(allSessions("slow"), ["2026/09/25/claude/slow"]);
  assert.equal(run(...args).status, 0);
  assert.deepEqual(readdirSync(join(root, ".locks", "claude")), []);
});

test("強制終了した所有者を並列に回収しても1件だけ作成する", async () => {
  const args = ["claude", "--session", "crashed"];
  const first = controlled(args, { pause: "copy" });
  await waitFor(() => existsSync(`${first.prefix}.ready`));
  first.child.kill("SIGKILL");
  await first.result;
  const followers = Array.from({ length: 8 }, () => controlled(args));
  const results = await Promise.all(followers.map((child) => child.result));
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  assert.equal(results.filter((result) => result.stdout.includes("作成しました")).length, 1);
  assert.equal(allSessions("crashed").length, 1);
  assert.deepEqual(readdirSync(join(root, ".locks", "claude")), []);
});

test("遅れて再開した回収処理が次の所有者のロックを消さない", async () => {
  const args = ["claude", "--session", "recovery"];
  const first = controlled(args, { pause: "copy" });
  await waitFor(() => existsSync(`${first.prefix}.ready`));
  first.child.kill("SIGKILL");
  await first.result;
  const delayed = controlled(args, { pause: "unlink" });
  await waitFor(() => existsSync(`${delayed.prefix}.ready`));
  const owner = controlled(args, { pause: "copy" });
  await waitFor(() => existsSync(`${owner.prefix}.ready`));
  const lock = join(root, ".locks", "claude", "recovery");
  const markers = readdirSync(lock);
  delayed.resume();
  await waitFor(() => Number(readFileSync(`${delayed.prefix}.attempt`, "utf8")) >= 2);
  assert.deepEqual(readdirSync(lock), markers);
  assert.deepEqual(allSessions("recovery"), []);
  owner.resume();
  assert.equal((await owner.result).status, 0);
  assert.equal((await delayed.result).status, 0);
  assert.equal(allSessions("recovery").length, 1);
  assert.deepEqual(readdirSync(join(root, ".locks", "claude")), []);
});

test("複製の失敗でもロックを解放して次の実行で回復する", async () => {
  const args = ["claude", "--session", "failed"];
  const first = controlled(args, { failCopy: true });
  const result = await first.result;
  assert.equal(result.status, 1);
  assert.match(result.stderr, /複製失敗の模擬/);
  assert.deepEqual(allSessions("failed"), []);
  assert.deepEqual(readdirSync(join(root, ".locks", "claude")), []);
  assert.deepEqual(readdirSync(join(root, ".tmp")), []);
  assert.equal(run(...args).status, 0);
});
