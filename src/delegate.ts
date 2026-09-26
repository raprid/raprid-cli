// init 以外のサブコマンドを、管理リポジトリの scripts/cli.ts に委譲する。
// 処理の実体はプロジェクトと一緒に版管理し、CLI はルートの判定と版の確認だけを行う。

import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TemplateBundle } from "./bundle.js";

// この CLI が扱える委譲プロトコルの版 (scripts/package.json の raprid.protocol)
export const supportedProtocols = [1];

export class DelegateError extends Error {}

export type Project =
  | { kind: "current"; root: string; protocol: number }
  | { kind: "legacy"; root: string };

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function protocolOf(root: string): number | undefined {
  const pkgPath = join(root, "scripts", "package.json");
  if (!exists(pkgPath) || !exists(join(root, "scripts", "cli.ts"))) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { raprid?: { protocol?: unknown } };
    return typeof pkg.raprid?.protocol === "number" ? pkg.raprid.protocol : undefined;
  } catch {
    return undefined;
  }
}

// 旧構成: job/ に操作スクリプトか job/<案件>/list/ がある
function isLegacy(root: string): boolean {
  const job = join(root, "job");
  if (!isDirectory(job)) return false;
  if (exists(join(job, "task-transition.sh")) || exists(join(job, "add-task.sh"))) return true;
  return readdirSync(job).some((name) => isDirectory(join(job, name, "list")));
}

// カレントから上へ探し、最も近い管理リポジトリを返す。
// Git リポジトリの境界 (.git があるディレクトリ) より上は探さない。
export function findProject(start: string): Project | undefined {
  let dir = realpathSync(start);
  for (;;) {
    const protocol = protocolOf(dir);
    if (protocol !== undefined) return { kind: "current", root: dir, protocol };
    if (isLegacy(dir)) return { kind: "legacy", root: dir };
    if (exists(join(dir, ".git"))) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function run(script: string, argv: string[], env: NodeJS.ProcessEnv): number {
  const result = spawnSync(process.execPath, [script, ...argv], { stdio: "inherit", env });
  if (result.error) throw new DelegateError(`scripts/cli.ts を起動できません: ${result.error.message}`);
  if (result.status !== null) return result.status;
  return 1;
}

function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  if (!("RAPRID_ROOT" in extra)) delete env.RAPRID_ROOT;
  return env;
}

// 同梱した project_template の scripts/ を一時ディレクトリに展開する
function extractScripts(bundle: TemplateBundle): string {
  const dir = mkdtempSync(join(tmpdir(), "raprid-scripts-"));
  for (const entry of bundle.entries) {
    if (!entry.path.startsWith("scripts/")) continue;
    if (entry.type !== "file") throw new DelegateError(`scripts/ にシンボリックリンクは同梱できません: ${entry.path}`);
    const path = join(dir, entry.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(entry.content, "base64"));
    chmodSync(path, entry.mode);
  }
  if (!exists(join(dir, "scripts", "cli.ts"))) {
    rmSync(dir, { recursive: true, force: true });
    throw new DelegateError("同梱の雛形に scripts/cli.ts がありません");
  }
  return dir;
}

export function delegate(argv: string[], loadBundle: () => TemplateBundle, cwd = process.cwd()): number {
  const migrating = argv[0] === "job" && argv[1] === "migrate";
  const project = findProject(cwd);
  if (!project) {
    throw new DelegateError(
      "管理リポジトリが見つかりません (scripts/package.json と scripts/cli.ts のあるディレクトリを、Git リポジトリの境界まで探しました)。\n" +
        "新しく作る場合は raprid init を使ってください。",
    );
  }

  if (project.kind === "legacy") {
    if (!migrating) {
      throw new DelegateError(
        `旧構成 (job/) のプロジェクトです: ${project.root}\n` +
          "raprid job migrate --dry-run で移行計画を確認し、raprid job migrate --apply で新構成へ移してください。",
      );
    }
    // 旧プロジェクトには委譲先が無いので、同梱の移行処理を一時展開して対象ルートを指定する
    const dir = extractScripts(loadBundle());
    try {
      return run(join(dir, "scripts", "cli.ts"), argv, childEnv({ RAPRID_ROOT: project.root }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const min = Math.min(...supportedProtocols);
  const max = Math.max(...supportedProtocols);
  if (project.protocol > max) {
    throw new DelegateError(
      `このプロジェクトの scripts/ (protocol ${project.protocol}) は、この raprid (対応: ${min}〜${max}) より新しい版です。\n` +
        "raprid を更新してください: npm install -g --prefer-online https://github.com/raprid/raprid-cli/releases/latest/download/raprid.tgz\n" +
        "更新できない場合は pnpm raprid ... または node scripts/cli.ts ... で直接実行できます。",
    );
  }
  if (project.protocol < min) {
    throw new DelegateError(
      `このプロジェクトの scripts/ (protocol ${project.protocol}) は、この raprid (対応: ${min}〜${max}) が扱えない古い版です。\n` +
        "project_template の scripts/ を取り込むか、pnpm raprid ... で直接実行してください。",
    );
  }
  if (!migrating && isDirectory(join(project.root, "job")) && !exists(join(project.root, "jobs"))) {
    throw new DelegateError(
      `旧構成の job/ が残っています: ${project.root}\n` + "raprid job migrate --dry-run で移行計画を確認してください。",
    );
  }
  return run(join(project.root, "scripts", "cli.ts"), argv, childEnv());
}
