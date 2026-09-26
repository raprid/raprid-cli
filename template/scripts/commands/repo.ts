// 関連リポジトリ (submodule) を repos/<名前>/ に追加し、worktree を展開する。
//   raprid repo add <SSH URL> [--dir-name <名前>] <権限>
//   raprid repo setup-worktrees <リポジトリ名> [ブランチ名 ...]

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parse } from "../lib/args.ts";
import { CliError, UsageError } from "../lib/errors.ts";
import { exists, isDirectory, writeFileAtomic } from "../lib/fsutil.ts";
import { projectRoot } from "../lib/root.ts";
import { renderTemplate } from "../lib/template.ts";

export const usage = `使い方:
  raprid repo add <リモートリポジトリのssh経由URL> [--dir-name <ディレクトリ名>] <権限>
  raprid repo setup-worktrees <リポジトリ名> [ブランチ名 ...]

add:
  <権限> は2桁の数字。1桁目=project_group、2桁目=submodule。4=r / 2=w / 1=x の合計値 (7=rwx)
  --dir-name を省略すると URL のリポジトリ名を使う (--dir_name も可)
  repos/<名前>/repo への submodule 追加、local/verification への切り替えと .worktrees/ の展開、
  MEMORY.md / BRANCH.md / WORKTREES.md の作成、repos/README.md の権限表への追記を行い、ステージする

setup-worktrees:
  ブランチ名を省略すると、既存のローカルブランチと origin にある main / dev / stg / prod を展開する。
  local/verification は repo/ で使う。全リモートブランチは展開しない

例:
  raprid repo add git@github.com:example/foo.git --dir-name foo 77
  raprid repo setup-worktrees foo feature/login`;

const verificationBranch = "local/verification";

// 呼び出し元の GIT_DIR などに引きずられず、必ず -C で指定したリポジトリを操作する
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_PREFIX"]) {
    delete env[key];
  }
  return env;
}

function git(cwd: string, args: string[], options: { inherit?: boolean } = {}): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: gitEnv(),
    stdio: options.inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new CliError(`git を実行できません: ${result.error.message}`);
  if (result.status !== 0) throw new CliError(`git ${args.join(" ")} に失敗しました${result.stderr ? `:\n${result.stderr.trim()}` : ""}`);
  return (result.stdout ?? "").trim();
}

function gitOk(cwd: string, args: string[]): boolean {
  return spawnSync("git", ["-C", cwd, ...args], { stdio: "ignore", env: gitEnv() }).status === 0;
}

function permToRwx(digit: number): string {
  return `${digit & 4 ? "r" : "-"}${digit & 2 ? "w" : "-"}${digit & 1 ? "x" : "-"}`;
}

function validateRepoName(name: string | undefined): string {
  if (!name || name.includes("/") || name === "." || name === ".." || name.startsWith("-")) {
    throw new UsageError(`リポジトリ名が不正です: ${name ?? ""}`);
  }
  return name;
}

const tableHeader = /^[ \t]*\|[ \t]*submodule_dir[ \t]*\|/;

// 権限表の同名の行を置き換え、無ければ末尾に足す。空セルだけのプレースホルダ行は除く
export function updatePermissionTable(readme: string, dir: string, projectGroup: string, submodule: string): string {
  const lines = readme.split("\n");
  const header = lines.findIndex((line) => tableHeader.test(line));
  if (header < 0) throw new CliError("README.mdにアクセス権限テーブルのヘッダが見つかりません");
  let last = header;
  while (last + 1 < lines.length && /^[ \t]*\|/.test(lines[last + 1])) last++;
  const row = `| ${dir} | ${projectGroup} | ${submodule} |`;
  const out: string[] = [];
  let done = false;
  lines.forEach((line, index) => {
    if (index >= header + 2 && index <= last) {
      const key = line.split("|")[1]?.trim() ?? "";
      if (key === dir) {
        out.push(row);
        done = true;
        return;
      }
      if (line.replace(/[|\s]/g, "") === "") return;
    }
    if (index === last + 1 && !done) {
      out.push(row);
      done = true;
    }
    out.push(line);
  });
  if (!done) out.push(row);
  return out.join("\n");
}

export function setupWorktrees(reposDir: string, name: string, branches: string[]): void {
  const wrapper = join(reposDir, validateRepoName(name));
  const repo = join(wrapper, "repo");
  const worktrees = join(wrapper, ".worktrees");
  if (!isDirectory(repo)) throw new CliError(`submodule が見つかりません: ${repo}`);
  if (!gitOk(repo, ["rev-parse", "--git-dir"])) throw new CliError(`Git リポジトリではありません: ${repo}`);
  if (!gitOk(repo, ["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"])) throw new CliError("origin/main が見つかりません");

  // git submodule add 後の absorbed gitdir は core.worktree を共通 config に持つ。
  // worktree を増やす前に主作業ツリー固有の config へ移し、linked worktree へ漏らさない。
  const coreWorktree = spawnSync("git", ["-C", repo, "config", "--local", "--get", "core.worktree"], { encoding: "utf8", env: gitEnv() });
  if (coreWorktree.status === 0 && coreWorktree.stdout.trim() !== "") {
    git(repo, ["config", "extensions.worktreeConfig", "true"]);
    git(repo, ["config", "--local", "--unset", "core.worktree"]);
    git(repo, ["config", "--worktree", "core.worktree", coreWorktree.stdout.trim()]);
  }

  mkdirSync(worktrees, { recursive: true });
  git(repo, ["worktree", "prune"]);

  if (git(repo, ["branch", "--show-current"]) !== verificationBranch) {
    if (git(repo, ["status", "--porcelain"]) !== "") {
      throw new CliError(`repo/ に未コミット変更があります。保持方法を決めてから ${verificationBranch} へ切り替えてください`);
    }
    if (gitOk(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${verificationBranch}`])) git(repo, ["switch", verificationBranch], { inherit: true });
    else git(repo, ["switch", "-c", verificationBranch, "origin/main"], { inherit: true });
  }
  if (!gitOk(repo, ["merge-base", "--is-ancestor", "origin/main", verificationBranch])) {
    throw new CliError(`${verificationBranch} は現在の origin/main から分岐した履歴ではありません`);
  }
  gitOk(repo, ["branch", "--unset-upstream", verificationBranch]);

  let targets: string[];
  if (branches.length > 0) {
    targets = branches.filter((branch) => branch !== "");
  } else {
    targets = git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
      .split("\n")
      .filter((branch) => branch !== "" && branch !== verificationBranch);
    for (const branch of ["main", "dev", "stg", "prod"]) {
      if (gitOk(repo, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`])) targets.push(branch);
    }
  }
  targets = [...new Set(targets)].sort();

  for (const branch of targets) {
    if (branch === verificationBranch) throw new CliError(`${verificationBranch} は .worktrees/ ではなく repo/ で使います`);
    if (branch.startsWith("-") || !gitOk(repo, ["check-ref-format", "--branch", branch])) throw new CliError(`ブランチ名が不正です: ${branch}`);
    const remoteRef = `refs/remotes/origin/${branch}`;
    const localRef = `refs/heads/${branch}`;
    const registered = git(repo, ["worktree", "list", "--porcelain"])
      .split("\n\n")
      .map((block) => ({ path: /^worktree (.*)$/m.exec(block)?.[1], ref: /^branch (.*)$/m.exec(block)?.[1] }))
      .find((entry) => entry.ref === localRef);
    if (registered?.path) {
      console.log(`既存: ${branch} -> ${registered.path}`);
      continue;
    }
    if (gitOk(repo, ["show-ref", "--verify", "--quiet", localRef])) {
      if (gitOk(repo, ["show-ref", "--verify", "--quiet", remoteRef]) && gitOk(repo, ["merge-base", "--is-ancestor", localRef, remoteRef])) {
        git(repo, ["branch", "-f", branch, `origin/${branch}`]);
      }
    } else if (gitOk(repo, ["show-ref", "--verify", "--quiet", remoteRef])) {
      git(repo, ["branch", "--track", branch, `origin/${branch}`]);
    } else {
      throw new CliError(`ローカルにも origin にもブランチがありません: ${branch}`);
    }
    const target = join(worktrees, branch);
    if (exists(target)) throw new CliError(`未登録のパスが既に存在します: ${target}`);
    mkdirSync(dirname(target), { recursive: true });
    git(repo, ["worktree", "add", target, branch], { inherit: true });
  }

  console.log(`\n主作業ツリー: ${repo} (${verificationBranch})`);
  console.log(git(repo, ["worktree", "list"]));
}

function add(argv: string[]): void {
  const { values, positionals } = parse(argv, { "dir-name": { type: "string" }, dir_name: { type: "string" } }, usage);
  if (positionals.length !== 2) throw new UsageError(`URLと権限は必須です\n${usage}`);
  const [url, perm] = positionals;
  if (url.startsWith("-")) throw new UsageError(`URLが不正です: ${url}`);
  if (!/^[0-7][0-7]$/.test(perm)) throw new UsageError(`権限は2桁の数字 (各桁0-7) で指定してください: ${perm}`);
  const derived = url.split("/").at(-1)!.split(":").at(-1)!.replace(/\.git$/, "");
  const name = validateRepoName(values["dir-name"] ?? values.dir_name ?? derived);

  const root = projectRoot();
  const reposDir = join(root, "repos");
  const readmePath = join(reposDir, "README.md");
  const topLevel = git(root, ["rev-parse", "--show-toplevel"]);
  const wrapper = join(reposDir, name);
  const wrapperPath = relative(realpathSync(topLevel), join(realpathSync(reposDir), name)).split("\\").join("/");
  const submodulePath = `${wrapperPath}/repo`;
  if (!exists(readmePath)) throw new CliError(`README.mdが見つかりません: ${readmePath}`);
  const readme = readFileSync(readmePath, "utf8");
  if (!readme.split("\n").some((line) => tableHeader.test(line))) throw new CliError("README.mdにアクセス権限テーブルのヘッダが見つかりません");
  if (exists(wrapper)) throw new CliError(`すでに存在します: ${submodulePath}`);

  console.log(`submoduleを追加します: ${url} -> ${submodulePath}`);
  mkdirSync(wrapper);
  try {
    git(topLevel, ["submodule", "add", "--", url, submodulePath], { inherit: true });
  } catch (error) {
    // 追加に失敗したら、この実行で作った空のディレクトリだけを消す
    try {
      rmdirSync(wrapper);
    } catch {
      // 中身が残っている場合は利用者の確認に任せる
    }
    throw error;
  }

  const repo = join(wrapper, "repo");
  const originHead = spawnSync("git", ["-C", repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { encoding: "utf8", env: gitEnv() });
  const defaultBranch = originHead.status === 0 ? originHead.stdout.trim().replace(/^origin\//, "") || "未確認" : "未確認";
  setupWorktrees(reposDir, name, []);
  const values2 = { name, defaultBranch, currentBranch: git(repo, ["branch", "--show-current"]), head: git(repo, ["rev-parse", "--short=8", "HEAD"]) };
  const docs = ["MEMORY.md", "BRANCH.md", "WORKTREES.md"];
  for (const doc of docs) writeFileSync(join(wrapper, doc), renderTemplate(`repo/${doc}`, values2), { flag: "wx" });

  const projectGroup = permToRwx(Number(perm[0]));
  const submodule = permToRwx(Number(perm[1]));
  writeFileAtomic(readmePath, updatePermissionTable(readme, name, projectGroup, submodule));
  git(topLevel, ["add", "--", readmePath, ...docs.map((doc) => join(wrapper, doc))]);
  console.log(`アクセス権限テーブルを更新しました: | ${name} | ${projectGroup} | ${submodule} |`);
  console.log("変更はステージ済みです。内容を確認してcommitしてください。");
}

function setup(argv: string[]): void {
  const { positionals } = parse(argv, {}, usage);
  if (positionals.length === 0) throw new UsageError(usage);
  const [name, ...branches] = positionals;
  setupWorktrees(join(projectRoot(), "repos"), name, branches);
}

export function run(argv: string[]): void {
  const [command, ...rest] = argv;
  const commands: Record<string, (args: string[]) => void> = { add, "setup-worktrees": setup };
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    console.log(usage);
    if (command === undefined) process.exitCode = 2;
    return;
  }
  if (!commands[command]) throw new UsageError(`不明なコマンド: repo ${command}\n${usage}`);
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(usage);
    return;
  }
  commands[command](rest);
}
