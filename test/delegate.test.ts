import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "dist", "cli.js");
let work: string;

function raprid(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

function project(name: string): string {
  const root = join(work, name);
  const result = raprid(work, ["init", name, "--no-git"]);
  assert.equal(result.status, 0, result.stderr);
  return root;
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "raprid-delegate-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

test("子ディレクトリや特殊文字を含むパスからでも管理リポジトリの scripts/ に委譲する", () => {
  for (const name of ["plain", "with space", "quote'and\"dq", "doll$r`tick`", "日本語"]) {
    const root = project(name);
    const nested = join(root, "docs", "unofficial");
    mkdirSync(nested, { recursive: true });
    assert.equal(raprid(nested, ["job", "create", "PROJ-1"]).status, 0, name);
    const add = raprid(nested, ["task", "add", "PROJ-1", "first", "todo", "$(echo 展開しない) `x` 'y'", "--requested-by", "human/test", "--created-by", "agent/test"]);
    assert.equal(add.status, 0, `${name}: ${add.stderr}`);
    assert.match(readFileSync(join(root, "jobs/PROJ-1/tasks/first/index.md"), "utf8"), /\$\(echo 展開しない\) `x` 'y'/);
    const viaCli = raprid(nested, ["task", "list", "PROJ-1"]);
    const direct = spawnSync(process.execPath, [join(root, "scripts", "cli.ts"), "task", "list", "PROJ-1"], { cwd: work, encoding: "utf8" });
    assert.equal(viaCli.status, 0);
    assert.equal(viaCli.stdout, direct.stdout, "直接実行と同じ出力");
  }
});

test("一覧の JSON と ui snapshot を委譲し、stdout の JSON をそのまま返す", () => {
  const root = project("p");
  assert.equal(raprid(root, ["job", "create", "PROJ-1"]).status, 0);
  assert.equal(raprid(root, ["task", "add", "PROJ-1", "a", "todo", "日本語のタイトル", "--requested-by", "human/test", "--created-by", "agent/test"]).status, 0);
  const listed = raprid(root, ["task", "list", "PROJ-1", "--json"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).items.map((item: { id: string; title: string }) => `${item.id} ${item.title}`), ["T-001 日本語のタイトル"]);
  const snapshot = raprid(root, ["ui", "snapshot", "--json"]);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  assert.deepEqual(Object.keys(JSON.parse(snapshot.stdout)), ["schemaVersion", "generatedAt", "scope", "jobs", "tasks", "qas", "issues"]);
  const failed = raprid(root, ["task", "list", "NOPE", "--json"]);
  assert.equal(failed.status, 1);
  assert.equal(JSON.parse(failed.stdout).error.code, "JOB_NOT_FOUND");
  const capabilities = spawnSync(process.execPath, [join(root, "scripts", "cli.ts"), "--capabilities"], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(capabilities.stdout), { schemaVersion: 1, capabilities: ["query-v1", "guarded-write-v1"] });
});

test("標準出力・標準エラー・終了コードをそのまま返す", () => {
  const root = project("p");
  const usage = raprid(root, ["task", "add", "other"]);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /使い方/);
  const failure = raprid(root, ["task", "move", "other", "T-001", "done"]);
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /タスクのIDが見つかりません/);
  const help = raprid(root, ["qa", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /raprid qa resolve/);
});

test("pnpm raprid と raprid は同じ処理を呼ぶ", { skip: spawnSync("pnpm", ["--version"]).status !== 0 }, () => {
  const root = project("p");
  // pnpm は実行前に依存を確認して自動で入れることがある。raprid スクリプトは依存を使わないので確認を省き、
  // 空のストア・オフラインでも install なしに動く (ローカルのストアやネットワークに依存しない) ことを確かめる
  const store = mkdtempSync(join(work, "store-"));
  const viaPnpm = spawnSync(
    "pnpm",
    ["--config.verify-deps-before-run=false", `--config.store-dir=${store}`, "--config.offline=true", "-s", "raprid", "task", "list", "other"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(existsSync(join(root, "node_modules")), false, "依存をインストールしていない");
  assert.equal(viaPnpm.status, 0, viaPnpm.stderr);
  assert.equal(viaPnpm.stdout, raprid(root, ["task", "list", "other"]).stdout);
});

test("Git の境界を越えて親の管理リポジトリへ委譲しない", () => {
  const root = project("parent");
  const child = join(root, "repos", "child", "repo");
  mkdirSync(child, { recursive: true });
  writeFileSync(join(child, ".git"), "gitdir: /nowhere\n");
  const result = raprid(join(child), ["task", "list"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /管理リポジトリが見つかりません/);
  assert.equal(raprid(join(root, "repos"), ["task", "list"]).status, 0, "境界の手前からは委譲する");
});

test("入れ子の管理リポジトリでは最も近いものを使う", () => {
  const outer = project("outer");
  const inner = project("outer/nested/inner");
  raprid(inner, ["job", "create", "INNER"]);
  const result = raprid(join(inner, "docs"), ["task", "list"]);
  assert.match(result.stdout, /^INNER /m);
  assert.doesNotMatch(raprid(outer, ["task", "list"]).stdout, /INNER/);
});

test("対応外の版や scripts/ の欠落は原因を表示して終了コード 1", () => {
  const root = project("p");
  const pkgPath = join(root, "scripts", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  writeFileSync(pkgPath, JSON.stringify({ ...pkg, raprid: { ...pkg.raprid, protocol: 99 } }));
  let result = raprid(root, ["task", "list"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /protocol 99.*より新しい版/s);
  writeFileSync(pkgPath, JSON.stringify({ ...pkg, raprid: { ...pkg.raprid, protocol: 0 } }));
  result = raprid(root, ["task", "list"]);
  assert.match(result.stderr, /扱えない古い版/);
  rmSync(join(root, "scripts"), { recursive: true });
  result = raprid(root, ["task", "list"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /管理リポジトリが見つかりません/);
  assert.equal(raprid(work, ["log", "create", "claude"]).status, 1);
});

test("RAPRID_ROOT を指定されても委譲先のルートは変えない", () => {
  const root = project("p");
  const other = project("q");
  raprid(other, ["job", "create", "OTHER"]);
  const result = raprid(root, ["task", "list"], { RAPRID_ROOT: other });
  assert.doesNotMatch(result.stdout, /OTHER/);
});

// 旧構成 (raprid 0.1.x で生成したものや templates リポジトリ) を模したもの
function legacy(root: string): void {
  for (const script of ["add-task.sh", "task-transition.sh"]) {
    write(root, `job/${script}`, "#!/usr/bin/env bash\n");
    chmodSync(join(root, "job", script), 0o755);
  }
  write(root, "job/template/list/template.md", "---\nid:\n---\n");
  write(
    root,
    "job/PROJ-1/list/api.md",
    "---\nid: T-001\nstatus: todo\ncreatedAt: 2026-09-01\nupdatedAt: 2026-09-01\ncompletedAt:\nblockedBy: []\ntest: []\n---\n\n# 計画\n\n## タイトル\n\nAPI\n\n## ログ\n\n### フェーズ1\n\n#### 計画\n\n調べる\n\n## 結果\n",
  );
  for (const status of ["todo", "pending", "progress", "done"]) mkdirSync(join(root, "job/PROJ-1/status", status), { recursive: true });
  symlinkSync("../../list/api.md", join(root, "job/PROJ-1/status/todo/api.md"));
  mkdirSync(join(root, "job/PROJ-1/qa/list"), { recursive: true });
  write(root, "README.md", "[API](job/PROJ-1/list/api.md)\n");
  write(root, "CLAUDE.md", "# CLAUDE.md\n");
}

test("scripts/ の無い旧プロジェクトは同梱の移行処理で移行でき、以後は委譲する", () => {
  const root = join(work, "legacy project");
  mkdirSync(root);
  legacy(root);
  const guarded = raprid(root, ["task", "list"]);
  assert.equal(guarded.status, 1);
  assert.match(guarded.stderr, /旧構成 \(job\/\) のプロジェクトです/);

  const plan = raprid(join(root, "job"), ["job", "migrate", "--dry-run"]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /job\/PROJ-1\/list\/api\.md -> jobs\/PROJ-1\/tasks\/api\/index\.md/);
  assert.ok(existsSync(join(root, "job")), "dry-run は変更しない");
  const hash = /計画ハッシュ: ([0-9a-f]+)/.exec(plan.stdout)![1];

  const applied = raprid(root, ["job", "migrate", "--apply", "--plan", hash]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(existsSync(join(root, "job")), false);
  assert.ok(existsSync(join(root, "scripts", "cli.ts")));
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "[API](jobs/PROJ-1/tasks/api/index.md)\n");
  assert.match(readFileSync(join(root, "jobs/PROJ-1/tasks/api/01-phase1.md"), "utf8"), /^# フェーズ1\n\n## 計画\n\n調べる\n/);

  const list = raprid(root, ["task", "list", "PROJ-1"]);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /^T-001  todo  API/m);
  const again = raprid(root, ["job", "migrate", "--apply"]);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /移行済み/);
});

test("移行処理の一時展開は後に残さない", () => {
  const root = join(work, "legacy");
  mkdirSync(root);
  legacy(root);
  const temp = mkdtempSync(join(work, "tmp-"));
  assert.equal(raprid(root, ["job", "migrate"], { TMPDIR: temp }).status, 0);
  assert.equal(spawnSync("ls", ["-A", temp], { encoding: "utf8" }).stdout, "");
});

test("scripts/ がシンボリックリンクでも判定したルートを操作する", () => {
  const root = project("p");
  const shared = join(work, "shared");
  mkdirSync(shared);
  spawnSync("mv", [join(root, "scripts"), join(shared, "scripts")]);
  symlinkSync(join(shared, "scripts"), join(root, "scripts"));
  const result = raprid(root, ["job", "create", "LINKED"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(root, "jobs", "LINKED")));
  assert.equal(existsSync(join(shared, "jobs")), false);
});

test("管理リポジトリの目印の無い job/ は旧プロジェクトとみなさない", () => {
  const home = join(work, "home");
  mkdirSync(join(home, "job", "x", "list"), { recursive: true });
  const result = raprid(join(home, "job"), ["job", "migrate", "--apply"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /管理リポジトリが見つかりません/);
});

test("対応表に無い protocol (小数など) は委譲しない", () => {
  const root = project("p");
  const pkgPath = join(root, "scripts", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  writeFileSync(pkgPath, JSON.stringify({ ...pkg, raprid: { ...pkg.raprid, protocol: 1.5 } }));
  const result = raprid(root, ["task", "list"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /protocol \(1\.5\)/);
});
