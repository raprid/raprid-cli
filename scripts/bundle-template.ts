// template/ と template-links.json を dist/template.json にまとめる。npm run build から呼ぶ。
//
// GitHub からのインストールでは npm が tarball の展開時にシンボリックリンクを落とすため、
// リンクは template/ に置かず template-links.json に記録している。

import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TemplateBundle, TemplateEntry, TemplateSource } from "../src/bundle.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = join(repoRoot, "template");
const distDir = join(repoRoot, "dist");

function walk(dir: string): TemplateEntry[] {
  const entries: TemplateEntry[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const path = relative(templateDir, full).split("\\").join("/");
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      throw new Error(`template/ にシンボリックリンクは置けません (template-links.json に書く): ${path}`);
    } else if (stat.isDirectory()) {
      entries.push(...walk(full));
    } else if (stat.isFile()) {
      // Git と同じく実行権限の有無だけを持ち込む
      const mode = stat.mode & 0o111 ? 0o755 : 0o644;
      entries.push({ type: "file", path, mode, content: readFileSync(full).toString("base64") });
    } else {
      throw new Error(`扱えない種類のファイルです: ${path}`);
    }
  }
  return entries;
}

function links(): TemplateEntry[] {
  const map = JSON.parse(readFileSync(join(repoRoot, "template-links.json"), "utf8")) as Record<string, string>;
  return Object.entries(map).map(([path, target]) => {
    const resolved = relative(templateDir, resolve(templateDir, dirname(path), target));
    if (isAbsolute(target) || resolved.startsWith("..") || isAbsolute(resolved)) {
      throw new Error(`template/ の外を指すリンクは同梱できません: ${path} -> ${target}`);
    }
    return { type: "symlink", path, target };
  });
}

const source = JSON.parse(readFileSync(join(repoRoot, "template-source.json"), "utf8")) as TemplateSource;
const entries = [...walk(templateDir), ...links()].sort((a, b) => (a.path < b.path ? -1 : 1));
const bundle: TemplateBundle = { format: 1, source, entries };

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir);
writeFileSync(join(distDir, "template.json"), JSON.stringify(bundle));
console.log(`dist/template.json: ${bundle.entries.length} 件 (雛形 ${source.commit.slice(0, 7)})`);
