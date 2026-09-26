// project_template の指定コミットから template/ を作り直す。
//
//   pnpm template:sync <project_template のパス> [--ref <ref>]
//
// Git 管理下のファイルだけを git archive で取り出し、生成対象外のものを除き、
// overrides/ の初期ファイルで上書きしてから template/ を置き換える。

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { TemplateSource } from "../src/bundle.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = join(repoRoot, "template");
const overridesDir = join(repoRoot, "overrides");

// 生成対象外: テンプレート自身の作業記録と、テンプレート自身を検証する手順書
const docsFeatureKeep = new Set(["docs/feature/README.md", "docs/feature/MEMORY.md", "docs/feature/archived/.gitkeep"]);
function excluded(path: string): boolean {
  if (/^logs\/\d{4}\//.test(path)) return true;
  if (path.startsWith("docs/feature/") && !docsFeatureKeep.has(path)) return true;
  return false;
}

function files(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const stat = lstatSync(full);
    return stat.isDirectory() && !stat.isSymbolicLink() ? files(full, base) : [relative(base, full).split("\\").join("/")];
  });
}

function removeEmptyDirs(dir: string): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = lstatSync(full);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      removeEmptyDirs(full);
      if (readdirSync(full).length === 0) rmSync(full, { recursive: true });
    }
  }
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { ref: { type: "string", default: "HEAD" } },
});
if (positionals.length !== 1) {
  console.error("使い方: pnpm template:sync <project_template のパス> [--ref <ref>]");
  process.exit(2);
}

const sourceRepo = resolve(positionals[0]);
const git = (...args: string[]) => execFileSync("git", ["-C", sourceRepo, ...args], { encoding: "utf8" }).trim();
const commit = git("rev-parse", "--verify", `${values.ref}^{commit}`);
const refName = values.ref === "HEAD" ? git("rev-parse", "--abbrev-ref", "HEAD") : values.ref;
let repository = sourceRepo;
try {
  repository = git("remote", "get-url", "origin");
} catch {
  // リモートが無ければローカルのパスを記録する
}

const work = mkdtempSync(join(tmpdir(), "raprid-template-"));
try {
  const extractDir = join(work, "template");
  mkdirSync(extractDir);
  execFileSync("git", ["-C", sourceRepo, "archive", "--format=tar", "-o", join(work, "template.tar"), commit]);
  execFileSync("tar", ["-xf", join(work, "template.tar"), "-C", extractDir]);

  const removed = files(extractDir).filter(excluded);
  for (const path of removed) rmSync(join(extractDir, path));
  removeEmptyDirs(extractDir);

  const overrides = existsSync(overridesDir) ? files(overridesDir) : [];
  const missing = overrides.filter((path) => !existsSync(join(extractDir, path)));
  if (missing.length > 0) {
    // 上書き先が雛形から消えたら、overrides/ の見直しが必要
    throw new Error(`雛形に存在しない overrides があります: ${missing.join(", ")}`);
  }
  for (const path of overrides) cpSync(join(overridesDir, path), join(extractDir, path));

  rmSync(templateDir, { recursive: true, force: true });
  cpSync(extractDir, templateDir, { recursive: true, verbatimSymlinks: true });

  const source: TemplateSource = { repository, ref: refName, commit };
  writeFileSync(join(repoRoot, "template-source.json"), `${JSON.stringify(source, null, 2)}\n`);

  console.log(`template/ を ${commit.slice(0, 7)} (${refName}) から作り直しました: ${files(templateDir).length} 件`);
  console.log(`除外: ${removed.length} 件`);
  for (const path of removed) console.log(`  - ${path}`);
  console.log(`上書き: ${overrides.length} 件`);
  for (const path of overrides) console.log(`  * ${path}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
