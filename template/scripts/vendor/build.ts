// scripts/vendor/ の同梱ファイルを node_modules から作り直す。
//
//   pnpm vendor:build
//
// scripts/ は node_modules なしでも node scripts/cli.ts で動かすため、使う依存を 1 ファイルずつにまとめて置く。
//   text-width.mjs: 表示幅の計算 (string-width)
//   yaml.mjs:       ネストした frontmatter の読み書き (yaml。コメントと未知の項目を保って書き換える)
// 版は package.json と pnpm-lock.yaml で固定する。
// 生成物は決定的なので、clean checkout で pnpm install → pnpm vendor:build をしても差分は出ない。

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const vendorDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(vendorDir, "..", "..");

// yaml は Node 向けの版が CommonJS で組み込みモジュールを require するため、条件 "default" の ESM 版を取り込む
export const bundles = [
  { file: "text-width.mjs", entry: 'export { default as stringWidth } from "string-width";\n', platform: "node" },
  { file: "yaml.mjs", entry: 'export { isMap, isScalar, isSeq, parseDocument, stringify, visit } from "yaml";\n', platform: "neutral" },
] as const;

interface Notice {
  name: string;
  version: string;
  license: string;
  text: string;
}

async function bundle(entry: string, platform: "node" | "neutral"): Promise<{ code: string; notices: Notice[] }> {
  const result = await build({
    stdin: { contents: entry, resolveDir: projectDir, sourcefile: "vendor-entry.js", loader: "js" },
    bundle: true,
    format: "esm",
    platform,
    ...(platform === "neutral" ? { mainFields: ["module", "main"] } : {}),
    target: "node24",
    legalComments: "none",
    write: false,
    metafile: true,
    charset: "utf8",
    absWorkingDir: projectDir,
  });
  // 実際に取り込んだファイルから、同梱したパッケージとライセンスを集める
  const packageDirs = new Set<string>();
  for (const input of Object.keys(result.metafile.inputs)) {
    const match = /^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(input);
    if (match) packageDirs.add(join(projectDir, match[1]));
  }
  const notices = [...packageDirs]
    .map((dir) => {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string; version: string; license: string };
      const licenseFile = ["license", "LICENSE", "LICENSE.md", "license.md"].map((name) => join(dir, name)).find((path) => {
        try {
          readFileSync(path);
          return true;
        } catch {
          return false;
        }
      });
      if (!licenseFile) throw new Error(`ライセンスファイルが見つかりません: ${pkg.name}`);
      return { name: pkg.name, version: pkg.version, license: pkg.license, text: readFileSync(licenseFile, "utf8").trim() };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const banner = [
    "// 生成ファイル。直接編集しない (pnpm vendor:build で作り直す: scripts/vendor/build.ts)",
    `// 同梱: ${notices.map((notice) => `${notice.name}@${notice.version} (${notice.license})`).join(", ")}`,
    "// ライセンス全文は scripts/vendor/THIRD_PARTY_LICENSES.txt",
    "",
  ].join("\n");
  return { code: banner + result.outputFiles[0].text, notices };
}

export async function buildVendor(): Promise<{ files: Record<string, string>; licenses: string }> {
  const files: Record<string, string> = {};
  const all = new Map<string, Notice>();
  for (const { file, entry, platform } of bundles) {
    const { code, notices } = await bundle(entry, platform);
    files[file] = code;
    for (const notice of notices) all.set(notice.name, notice);
  }
  const licenses = [...all.values()]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((notice) => `${notice.name}@${notice.version} (${notice.license})\n\n${notice.text}\n`)
    .join("\n----------------------------------------\n\n");
  return { files, licenses };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { files, licenses } = await buildVendor();
  for (const [file, code] of Object.entries(files)) {
    writeFileSync(join(vendorDir, file), code);
    console.log(`scripts/vendor/${file} を作り直しました (${code.split("\n")[1].replace("// ", "")})`);
  }
  writeFileSync(join(vendorDir, "THIRD_PARTY_LICENSES.txt"), licenses);
}
