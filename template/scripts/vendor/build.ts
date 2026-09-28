// scripts/vendor/ の同梱ファイルを node_modules から作り直す。
//
//   pnpm vendor:build
//
// scripts/ は node_modules なしでも node scripts/cli.ts で動かすため、表示幅の計算に使う
// string-width を依存ごと 1 ファイルにまとめて置く。版は package.json と pnpm-lock.yaml で固定する。
// 生成物は決定的なので、clean checkout で pnpm install → pnpm vendor:build をしても差分は出ない。

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const vendorDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(vendorDir, "..", "..");

export async function bundleTextWidth(): Promise<{ code: string; licenses: string }> {
  const result = await build({
    stdin: {
      contents: 'export { default as stringWidth } from "string-width";\n',
      resolveDir: projectDir,
      sourcefile: "text-width-entry.js",
      loader: "js",
    },
    bundle: true,
    format: "esm",
    platform: "node",
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
      return { ...pkg, text: readFileSync(join(dir, "license"), "utf8").trim() };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const banner = [
    "// 生成ファイル。直接編集しない (pnpm vendor:build で作り直す: scripts/vendor/build.ts)",
    `// 同梱: ${notices.map((notice) => `${notice.name}@${notice.version} (${notice.license})`).join(", ")}`,
    "// ライセンス全文は scripts/vendor/THIRD_PARTY_LICENSES.txt",
    "",
  ].join("\n");
  const licenses = notices.map((notice) => `${notice.name}@${notice.version} (${notice.license})\n\n${notice.text}\n`).join("\n----------------------------------------\n\n");
  return { code: banner + result.outputFiles[0].text, licenses };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, licenses } = await bundleTextWidth();
  writeFileSync(join(vendorDir, "text-width.mjs"), code);
  writeFileSync(join(vendorDir, "THIRD_PARTY_LICENSES.txt"), licenses);
  console.log(`scripts/vendor/text-width.mjs を作り直しました (${code.split("\n")[1].replace("// ", "")})`);
}
