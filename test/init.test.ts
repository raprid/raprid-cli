import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { TemplateBundle } from "../src/bundle.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "dist", "cli.js");
const bundle = JSON.parse(readFileSync(join(repoRoot, "dist", "template.json"), "utf8")) as TemplateBundle;
let work: string;

function raprid(cwd: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function tree(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
}

function sh(cwd: string, command: string, ...args: string[]) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "raprid-init-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

test("空のディレクトリに雛形を生成し git init する", () => {
  const result = raprid(work, "init");
  assert.equal(result.status, 0, result.stderr);
  for (const entry of bundle.entries) {
    assert.ok(lstatSync(join(work, entry.path)), entry.path);
  }
  assert.equal(readlinkSync(join(work, ".agents", "skills")), "../.claude/skills");
  assert.ok(existsSync(join(work, "scripts", "cli.ts")));
  assert.ok(existsSync(join(work, "jobs", "other", "status", "todo", ".gitkeep")));
  assert.equal(existsSync(join(work, "job")), false);
  assert.ok(existsSync(join(work, ".gitignore")));
  assert.ok(existsSync(join(work, ".git")));
  assert.match(result.stdout, /git init を実行しました/);
});

test("テンプレート自身の作業記録や手順書を持ち込まない", () => {
  raprid(work, "init", "--no-git");
  assert.deepEqual(tree(join(work, "logs")).filter((path) => /^\d{4}/.test(path)), []);
  assert.deepEqual(tree(join(work, "docs", "feature")).sort(), ["MEMORY.md", "README.md", "archived", "archived/.gitkeep"]);
  assert.equal(existsSync(join(work, "daily")), false);
  assert.equal(existsSync(join(work, "node_modules")), false);
  assert.doesNotMatch(readFileSync(join(work, "MEMORY.md"), "utf8"), /2026-09-11|daily\//);
});

test("存在しない・空白を含むパスを指定して生成できる", () => {
  const result = raprid(work, "init", "nested/my project", "--no-git");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(work, "nested", "my project", "README.md")));
  assert.equal(existsSync(join(work, "README.md")), false);
});

test("表示した cd を実行しても特殊文字が展開されず生成先へ移動できる", () => {
  for (const name of ["with space", "project-$RAPRID_REVIEW_LABEL", "project-$(touch substituted)", "project-`touch backtick`", "single'quote", "-leading"]) {
    const result = raprid(work, "init", `./${name}`, "--no-git");
    assert.equal(result.status, 0, result.stderr);
    const command = result.stdout.match(/^  (cd .+)$/m)?.[1];
    assert.ok(command, result.stdout);
    const moved = spawnSync("sh", ["-c", `${command} && pwd -P`], {
      cwd: work,
      env: { ...process.env, RAPRID_REVIEW_LABEL: "expanded", CDPATH: "" },
      encoding: "utf8",
    });
    assert.equal(moved.status, 0, moved.stderr);
    assert.equal(moved.stdout.trim(), spawnSync("pwd", ["-P"], { cwd: join(work, name), encoding: "utf8" }).stdout.trim());
    assert.equal(existsSync(join(work, "substituted")), false);
    assert.equal(existsSync(join(work, "backtick")), false);
  }
});

test("既存ファイルと衝突したら何も変更せずに失敗する", () => {
  writeFileSync(join(work, "README.md"), "既存\n");
  writeFileSync(join(work, "notes.txt"), "無関係\n");
  const result = raprid(work, "init");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /何も変更せずに中止しました \(1 件\)/);
  assert.match(result.stderr, /README\.md/);
  assert.deepEqual(tree(work), ["README.md", "notes.txt"]);
  assert.equal(readFileSync(join(work, "README.md"), "utf8"), "既存\n");
});

test("途中の階層がファイルやシンボリックリンクなら衝突として扱う", () => {
  writeFileSync(join(work, "logs"), "");
  const outside = mkdtempSync(join(tmpdir(), "raprid-outside-"));
  try {
    symlinkSync(outside, join(work, "docs"));
    const result = raprid(work, "init");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\n {2}docs\n/);
    assert.match(result.stderr, /\n {2}logs\n/);
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("同じ場所で再実行すると衝突で止まり、生成済みの内容を変えない", () => {
  raprid(work, "init", "--no-git");
  writeFileSync(join(work, "MEMORY.md"), "編集済み\n");
  const result = raprid(work, "init", "--no-git");
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`\\(${bundle.entries.length} 件\\)`));
  assert.equal(readFileSync(join(work, "MEMORY.md"), "utf8"), "編集済み\n");
});

test("Git 初期化済みのディレクトリでは git init をやり直さない", () => {
  sh(work, "git", "init", "--quiet");
  writeFileSync(join(work, ".git", "marker"), "");
  const result = raprid(work, "init");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /既存の Git 作業ツリー内/);
  assert.ok(existsSync(join(work, ".git", "marker")));
});

test("--no-git では git init しない", () => {
  const result = raprid(work, "init", "--no-git");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(work, ".git")), false);
});

test("--dry-run は何も書かない", () => {
  const result = raprid(work, "init", "--dry-run");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`${bundle.entries.length} 件のファイルを生成できます`));
  assert.deepEqual(tree(work), []);
});

test("生成途中で失敗したら、この実行で作ったものだけを削除する", { skip: process.getuid?.() === 0 }, () => {
  writeFileSync(join(work, "keep.txt"), "利用者のファイル\n");
  mkdirSync(join(work, "repos"));
  chmodSync(join(work, "repos"), 0o500);
  try {
    const result = raprid(work, "init", "--no-git");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /この実行で作成したファイルを削除しました/);
    assert.deepEqual(tree(work), ["keep.txt", "repos"]);
  } finally {
    chmodSync(join(work, "repos"), 0o700);
  }
});

test("書き込みの途中で失敗しても作りかけのファイルを残さない", () => {
  // ulimit -f 1 (512 バイト) を超える write が EFBIG で失敗する。open は成功した後の失敗を再現する
  const result = spawnSync("sh", ["-c", `ulimit -f 1; exec "$0" "$@"`, process.execPath, cli, "init", "p", "--no-git"], {
    cwd: work,
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /EFBIG/);
  assert.deepEqual(tree(work), []);
});

test("GIT_DIR などの環境変数があっても生成先に git init する", () => {
  const result = spawnSync(process.execPath, [cli, "init", "p"], {
    cwd: work,
    encoding: "utf8",
    env: { ...process.env, GIT_DIR: join(work, "outside.git"), GIT_WORK_TREE: work },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(work, "p", ".git")));
  assert.equal(existsSync(join(work, "outside.git")), false);
});

test("生成先の途中がファイルやリンクなら通常のエラーで終了する", () => {
  writeFileSync(join(work, "file"), "");
  const underFile = raprid(work, "init", "file/sub", "--dry-run");
  assert.equal(underFile.status, 1);
  assert.match(underFile.stderr, /生成先を確認できません/);
  assert.doesNotMatch(underFile.stderr, /\n\s+at /);

  mkdirSync(join(work, "real"));
  symlinkSync("real", join(work, "link"));
  const link = raprid(work, "init", "link");
  assert.equal(link.status, 1);
  assert.match(link.stderr, /シンボリックリンクは指定できません/);
  assert.deepEqual(readdirSync(join(work, "real")), []);
});

test("引数の誤りは終了コード 2", () => {
  for (const args of [[], ["unknown"], ["init", "a", "b"], ["init", "--force"]]) {
    const result = raprid(work, ...args);
    assert.equal(result.status, 2, args.join(" "));
  }
  assert.deepEqual(tree(work), []);
});

test("生成先でログ作成とタスク管理の初期操作ができる", () => {
  raprid(work, "init", "--no-git");
  const log = raprid(work, "log", "create", "claude", "--session", "first");
  assert.equal(log.status, 0, log.stderr);
  assert.match(log.stdout, /logs\/\d{4}\/\d{2}\/\d{2}\/claude\/first/);

  assert.equal(raprid(work, "job", "create", "sample").status, 0);
  const add = raprid(work, "task", "add", "sample", "first-task", "todo", "最初のタスク");
  assert.equal(add.status, 0, add.stderr);
  assert.ok(lstatSync(join(work, "jobs", "sample", "status", "todo", "first-task")).isSymbolicLink());
  const move = raprid(work, "task", "move", "sample", "T-001", "progress");
  assert.equal(move.status, 0, move.stderr);
  const note = raprid(work, "task", "note", "sample", "T-001", "investigation");
  assert.equal(note.status, 0, note.stderr);
  const list = raprid(work, "task", "list", "sample");
  assert.match(list.stdout, /progress \(1\)\n    T-001 +first-task +最初のタスク/);
});
