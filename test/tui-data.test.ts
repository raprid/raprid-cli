import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { FakeBackend, load, showOf, snapshot, task, tick } from "./tui-fixtures.ts";

const { SnapshotStore, DetailStore } = await load<typeof import("../src/tui/stores.js")>("../dist/tui/stores.js");
const { ScriptBackend, BackendError } = await load<typeof import("../src/tui/backend.js")>("../dist/tui/backend.js");

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "raprid-tui-data-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

test("snapshot は同時に 1 件だけ取得し、実行中の再取得要求は次回へまとめる", async () => {
  const first = snapshot({ tasks: [task("T-001")] });
  const backend = new FakeBackend(first);
  const store = new SnapshotStore(backend, { intervalMs: 10_000 });
  store.start();
  assert.equal(backend.snapshotCalls.length, 1);
  assert.equal(store.getState().loading, true);
  store.refresh();
  store.refresh();
  assert.equal(backend.snapshotCalls.length, 1, "実行中は新しい取得を始めない");
  backend.snapshotCalls[0].resolve(first);
  await tick(5);
  assert.equal(backend.snapshotCalls.length, 2, "まとめた再取得を 1 回だけ行う");
  assert.equal(store.getState().snapshot, first);
  const second = snapshot({ tasks: [task("T-002")] });
  backend.snapshotCalls[1].resolve(second);
  await tick(5);
  assert.equal(backend.snapshotCalls.length, 2);
  assert.equal(store.getState().snapshot, second);
  store.dispose();
});

test("取得に失敗しても前回の表示を保ち、タイムアウトでは自動取得を止めて r で再開する", async () => {
  const first = snapshot({ tasks: [task("T-001")] });
  const backend = new FakeBackend(first);
  const store = new SnapshotStore(backend, { intervalMs: 20 });
  store.seed(first);
  store.start();
  await tick(40);
  assert.equal(backend.snapshotCalls.length, 1, "seed の後は間隔を置いてから取得する");
  backend.snapshotCalls[0].reject(new BackendError("FAILED", "壊れた応答"));
  await tick(5);
  assert.equal(store.getState().snapshot, first);
  assert.equal(store.getState().error?.message, "壊れた応答");
  assert.equal(store.getState().stopped, false);
  await tick(40);
  assert.equal(backend.snapshotCalls.length, 2, "通常の失敗では自動取得を続ける");
  backend.snapshotCalls[1].reject(new BackendError("TIMEOUT", "15秒以内に応答がありませんでした"));
  await tick(60);
  assert.equal(store.getState().stopped, true);
  assert.equal(backend.snapshotCalls.length, 2, "タイムアウト後は自動で取得しない");
  store.refresh();
  assert.equal(backend.snapshotCalls.length, 3);
  assert.equal(store.getState().stopped, false);
  backend.snapshotCalls[2].resolve(first);
  await tick(5);
  assert.equal(store.getState().error, undefined);
  store.dispose();
  await tick(40);
  assert.equal(backend.snapshotCalls.length, 3, "dispose 後は取得しない");
});

test("詳細は選択の変化を 100ms まとめて取得し、古い応答を表示せず、path + revision でキャッシュする", async () => {
  const records = [task("T-001"), task("T-002"), task("T-003")];
  const backend = new FakeBackend(snapshot({ tasks: records }));
  backend.autoShow = false;
  const store = new DetailStore(backend, { debounceMs: 20 });
  const target = (index: number, revision?: string) => ({ kind: "task" as const, job: "PROJ-1", name: records[index].name, path: records[index].path, revision: revision ?? records[index].revision });
  store.select(target(0));
  store.select(target(1));
  await tick(5);
  store.select(target(2));
  await tick(40);
  assert.deepEqual(backend.showCalls.map((call) => call.selector), ["t-003"], "連続した選択はまとめる");
  store.select(target(0));
  await tick(40);
  assert.equal(backend.showCalls.length, 1, "実行中は 2 件目を始めない");
  backend.showCalls[0].reply.resolve(showOf(records[2]));
  await tick(10);
  assert.equal(store.getState().target?.name, "t-001");
  assert.equal(store.getState().result, undefined, "選択が変わった古い応答は表示しない");
  assert.equal(backend.showCalls.length, 2, "終わったら最新の選択を取得する");
  backend.showCalls[1].reply.resolve(showOf(records[0]));
  await tick(5);
  assert.equal(store.getState().result?.item.name, "t-001");
  assert.equal(store.getState().current, true);

  store.select(target(2));
  assert.equal(store.getState().result?.item.name, "t-003", "キャッシュ済みはすぐ表示する");
  assert.equal(backend.showCalls.length, 2);
  store.select(target(2, "rev-changed"));
  assert.equal(store.getState().loading, true, "revision が変わったら取り直す");
  assert.equal(store.getState().result?.item.name, "t-003", "取り直す間は同じ path の前回の結果を出す");
  await tick(40);
  backend.showCalls[2].reply.reject(new BackendError("TIMEOUT", "15秒以内に応答がありませんでした"));
  await tick(5);
  assert.equal(store.getState().error?.code, "TIMEOUT");
  assert.equal(store.getState().result?.item.name, "t-003", "失敗しても前回の表示を保つ");
  store.dispose();
});

function project(name: string, cli: string): string {
  const root = join(work, name);
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "package.json"), JSON.stringify({ type: "module", raprid: { format: 1, protocol: 1 } }));
  writeFileSync(join(root, "scripts", "cli.ts"), cli);
  mkdirSync(join(root, ".git"));
  return root;
}

test("backend は shell を通さずに scripts/cli.ts を実行し、JSON・エラー・タイムアウトを区別する", async () => {
  const argsFile = join(work, "args.json");
  const root = project(
    "p",
    `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ args, root: process.env.RAPRID_ROOT }));
if (args[0] === "--capabilities") console.log(JSON.stringify({ schemaVersion: 1, capabilities: ["query-v1"] }));
else if (args[0] === "ui") console.log(JSON.stringify({ schemaVersion: 1, generatedAt: "x", scope: { job: null }, jobs: [], tasks: [], qas: [], issues: [] }));
else if (args[1] === "show" && args[3] === "missing") { console.log(JSON.stringify({ schemaVersion: 1, error: { code: "NOT_FOUND", message: "無い" } })); process.exitCode = 1; }
else if (args[1] === "show" && args[3] === "slow") setTimeout(() => {}, 10_000);
else console.log("not json");
`,
  );
  const backend = new ScriptBackend(root, { timeoutMs: 300 });
  assert.deepEqual(await backend.capabilities(), ["query-v1"]);
  assert.deepEqual((await backend.snapshot()).tasks, []);
  assert.deepEqual(JSON.parse(readFileSync(argsFile, "utf8")), { args: ["ui", "snapshot", "--json"], root });
  await assert.rejects(backend.show("task", "PROJ-1", "missing"), (error: InstanceType<typeof BackendError>) => error.code === "NOT_FOUND" && error.message === "無い");
  await backend.show("task", "$(touch x)", "a b; echo").catch(() => undefined);
  assert.deepEqual(JSON.parse(readFileSync(argsFile, "utf8")).args, ["task", "show", "$(touch x)", "a b; echo", "--json"], "引数はそのまま渡す");
  assert.equal(existsSync(join(root, "x")), false);
  const started = Date.now();
  await assert.rejects(backend.show("task", "PROJ-1", "slow"), (error: InstanceType<typeof BackendError>) => error.code === "TIMEOUT");
  assert.ok(Date.now() - started < 3000);
  assert.equal(backend.running, 0);
});

test("dispose は実行中の子プロセスを止め、--capabilities を知らない古い scripts/ は非対応として扱う", async () => {
  const pidFile = join(work, "pid");
  const root = project("slow", `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => {}, 30_000);\n`);
  const backend = new ScriptBackend(root);
  const pending = backend.snapshot().catch((error: unknown) => error);
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await tick(20);
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.equal(backend.running, 1);
  backend.dispose();
  await pending;
  await tick(50);
  assert.throws(() => process.kill(pid, 0), "子プロセスが残らない");
  await assert.rejects(backend.snapshot(), (error: InstanceType<typeof BackendError>) => error.code === "DISPOSED");

  const legacy = project("legacy", `console.error("不明な group: --capabilities"); process.exitCode = 2;\n`);
  assert.deepEqual(await new ScriptBackend(legacy).capabilities(), []);
});

test("初期化したプロジェクトの scripts/ で ui snapshot と show を取得できる", async () => {
  const cli = join(repoRoot, "dist", "cli.js");
  const root = join(work, "init");
  assert.equal(spawnSync(process.execPath, [cli, "init", root, "--no-git"], { encoding: "utf8" }).status, 0);
  const env = { ...process.env, RAPRID_ACTOR: "agent/test" };
  assert.equal(spawnSync(process.execPath, [cli, "job", "create", "PROJ-1"], { cwd: root, env }).status, 0);
  assert.equal(spawnSync(process.execPath, [cli, "task", "add", "PROJ-1", "a", "todo", "日本語"], { cwd: root, env }).status, 0);
  const backend = new ScriptBackend(root);
  assert.deepEqual(await backend.capabilities(), ["query-v1"]);
  const data = await backend.snapshot();
  assert.equal(data.tasks[0].title, "日本語");
  const shown = await backend.show("task", "PROJ-1", "a");
  assert.match(shown.item.rawMarkdown ?? "", /## タイトル\n\n日本語/);
});

test("通常の CLI は Ink / React を読み込まず、tui のときだけ読み込む", () => {
  // node_modules の無い場所に dist/ だけを置き、依存が無くても通常の CLI が動くことで確かめる
  const bare = join(work, "bare");
  mkdirSync(bare);
  cpSync(join(repoRoot, "dist"), join(bare, "dist"), { recursive: true });
  cpSync(join(repoRoot, "package.json"), join(bare, "package.json"));
  const run = (...args: string[]) => spawnSync(process.execPath, [join(bare, "dist", "cli.js"), ...args], { cwd: work, encoding: "utf8" });
  assert.equal(run("--version").stdout.trim(), JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version);
  assert.equal(run("--help").status, 0);
  assert.equal(run("init", join(work, "generated"), "--no-git").status, 0);
  const tui = run("tui", "--help");
  assert.notEqual(tui.status, 0);
  assert.match(tui.stderr, /Cannot find package '(ink|react)'/, "tui だけが Ink / React を読み込む");
});
