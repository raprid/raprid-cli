import {
  readdirSync,
  existsSync,
  lstatSync,
  readFileSync,
  mkdirSync,
  copyFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { add, initialize, safe, write, atomic, hash } from "./store.js";
function files(root: string, path: string): string[] {
  if (!existsSync(join(root, path))) return [];
  return readdirSync(join(root, path))
    .sort()
    .flatMap((n) => {
      const p = join(path, n),
        s = lstatSync(join(root, p));
      if (s.isSymbolicLink()) return [];
      return s.isDirectory() ? files(root, p) : [p];
    });
}
export function migrate(
  source: string,
  target: string,
  repository: string,
  apply: boolean,
): any {
  source = resolve(source);
  target = resolve(target);
  if (
    target === source ||
    target.startsWith(source + "/") ||
    source.startsWith(target + "/")
  )
    throw new Error("移行先は元データと独立したディレクトリを指定してください");
  safe(source, "jobs");
  safe(source, "docs");
  safe(dirname(target), target);
  const archive = [...files(source, "jobs"), ...files(source, "docs")];
  const inputs = archive.filter((p) =>
    /^jobs\/[^/]+\/(tasks|qa)\/[^/]+\/index\.md$/.test(p),
  );
  const docs = archive.filter((p) => p.startsWith("docs/"));
  const records = inputs.map((path) => {
    const original = readFileSync(join(source, path), "utf8"),
      m = original.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) throw new Error(`frontmatterがありません: ${path}`);
    const attributes = parseYaml(m[1]) ?? {},
      body = m[2],
      title =
        body.match(/^## タイトル\s*\n+([^\n]+)/m)?.[1] ??
        attributes.title ??
        path;
    return { path, original, attributes, body, title };
  });
  const fingerprint = () =>
    hash(
      archive.map((p) => [p, readFileSync(join(source, p)).toString("base64")]),
    );
  const plan = {
    source,
    target,
    issues: inputs,
    documents: docs,
    hash: fingerprint(),
  };
  if (!apply) return plan;
  if (existsSync(target) && readdirSync(target).length)
    throw new Error("移行先が空ではありません");
  mkdirSync(dirname(target), { recursive: true });
  const stage = mkdtempSync(join(dirname(target), ".raprid-migration-"));
  try {
    initialize(stage, repository);
    const mappings: any[] = [],
      wikiPages: any[] = [];
    for (const record of records) {
      const id = add(stage, record.title, record.body);
      write(stage, `issues/${id}/legacy.json`, {
        path: record.path,
        attributes: record.attributes,
      });
      atomic(stage, `issues/${id}/legacy-index.md`, record.original);
      mappings.push({
        path: record.path,
        id,
        legacyStatus: record.attributes.status,
      });
    }
    // 詳細・添付・旧工程を含む元ファイルを保存し、GitHub状態には自動変換しない。
    for (const path of archive) {
      const dest = safe(stage, `logs/migration/source/${path}`);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(source, path), dest);
    }
    // Wikiの既存ページを上書きしないよう、取り込み候補を独立して生成する。
    for (const path of docs.filter((p) => p.endsWith(".md"))) {
      const name = `Imported-${path.slice(5, -3).replace(/[^\p{L}\p{N}_-]/gu, "-")}-${hash(path).slice(0, 8)}.md`;
      atomic(
        stage,
        `.raprid/migration/wiki-pages/${name}`,
        readFileSync(join(source, path), "utf8"),
      );
      wikiPages.push({ source: path, page: name });
    }
    write(stage, ".raprid/migration.json", {
      ...plan,
      mappings,
      wikiPages,
      at: new Date().toISOString(),
      note: "旧状態・原本・添付を保持。Wiki候補の相対リンクは公開前に確認すること。",
    });
    if (fingerprint() !== plan.hash)
      throw new Error("移行中に元データが変更されました");
    renameSync(stage, target);
    return { ...plan, mappings, wikiPages };
  } catch (e) {
    rmSync(stage, { recursive: true, force: true });
    throw e;
  }
}
