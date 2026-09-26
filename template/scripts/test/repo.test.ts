import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { updatePermissionTable } from "../commands/repo.ts";
import { raprid, read, write } from "./helpers.ts";

let work: string;
let root: string;
let remote: string;

// 外部リポジトリを使わず、ローカルの bare リポジトリを submodule の取得元にする
const gitEnv = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "protocol.file.allow",
  GIT_CONFIG_VALUE_0: "always",
  GIT_CONFIG_KEY_1: "init.defaultBranch",
  GIT_CONFIG_VALUE_1: "main",
};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, ...gitEnv } });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const readme = `# repos

| submodule_dir | project_group | submodule |
| --- | --- | --- |
| <例> | rwx | rwx |
|  |  |  |

## 次の節
`;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "raprid-repo-"));
  const seed = join(work, "seed");
  mkdirSync(seed);
  git(seed, "init");
  write(seed, "README.md", "seed\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "init");
  git(seed, "branch", "dev");
  git(seed, "branch", "feature/x");
  remote = join(work, "remote.git");
  git(work, "clone", "--bare", seed, remote);

  root = join(work, "project");
  mkdirSync(root);
  git(root, "init");
  write(root, "repos/README.md", readme);
  git(root, "add", ".");
  git(root, "commit", "-m", "init");
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

test("submodule を追加し、local/verification と worktree・管理文書・権限表を用意する", () => {
  const result = raprid(root, ["repo", "add", remote, "--dir-name", "foo", "75"], { env: gitEnv });
  assert.equal(result.status, 0, result.stderr);
  const repo = join(root, "repos/foo/repo");
  assert.equal(git(repo, "branch", "--show-current"), "local/verification");
  assert.ok(existsSync(join(root, "repos/foo/.worktrees/main/README.md")));
  assert.ok(existsSync(join(root, "repos/foo/.worktrees/dev/README.md")));
  assert.equal(existsSync(join(root, "repos/foo/.worktrees/feature/x")), false, "指定の無いリモートブランチは展開しない");
  assert.match(read(root, "repos/foo/MEMORY.md"), /- 既定ブランチ: `main`\n- 現在: `local\/verification` \/ `[0-9a-f]{8}`/);
  assert.match(read(root, "repos/foo/WORKTREES.md"), /raprid repo setup-worktrees foo/);
  assert.match(read(root, "repos/foo/BRANCH.md"), /機能: foo の変更を対象ブランチへ安全に統合する/);
  assert.equal(read(root, "repos/README.md"), readme.replace("|  |  |  |\n", "| foo | rwx | r-x |\n"));
  const staged = git(root, "diff", "--cached", "--name-only").split("\n");
  for (const path of [".gitmodules", "repos/README.md", "repos/foo/MEMORY.md", "repos/foo/BRANCH.md", "repos/foo/WORKTREES.md", "repos/foo/repo"]) {
    assert.ok(staged.includes(path), path);
  }

  const again = raprid(root, ["repo", "setup-worktrees", "foo", "feature/x"], { env: gitEnv });
  assert.equal(again.status, 0, again.stderr);
  assert.ok(existsSync(join(root, "repos/foo/.worktrees/feature/x/README.md")));
  const rerun = raprid(root, ["repo", "setup-worktrees", "foo"], { env: gitEnv });
  assert.match(rerun.stdout, /既存: main ->/);
});

test("引数の誤りと既存のディレクトリでは何もしない", () => {
  assert.equal(raprid(root, ["repo", "add", remote, "8"], { env: gitEnv }).status, 2);
  assert.equal(raprid(root, ["repo", "add", remote], { env: gitEnv }).status, 2);
  assert.equal(raprid(root, ["repo", "add", remote, "--dir-name", "a/b", "77"], { env: gitEnv }).status, 2);
  mkdirSync(join(root, "repos/remote"));
  const result = raprid(root, ["repo", "add", remote, "77"], { env: gitEnv });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /すでに存在します/);
  assert.equal(git(root, "status", "--porcelain"), "");
  assert.equal(raprid(root, ["repo", "setup-worktrees", "missing"], { env: gitEnv }).status, 1);
  assert.equal(raprid(root, ["repo", "setup-worktrees", "foo", "local/verification"], { env: gitEnv }).status, 1);
});

test("権限表は同名の行を置き換え、プレースホルダ行を除く", () => {
  const once = updatePermissionTable(readme, "foo", "rwx", "r--");
  assert.equal(updatePermissionTable(once, "foo", "r--", "---"), readme.replace("|  |  |  |\n", "| foo | r-- | --- |\n"));
  assert.throws(() => updatePermissionTable("# none\n", "foo", "rwx", "rwx"), /ヘッダが見つかりません/);
});
