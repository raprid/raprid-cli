import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// scripts/ 自身の場所。雛形もここから読む
export const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const templatesDir = join(scriptsDir, "templates");

export interface ScriptsInfo {
  format: number;
  protocol: number;
}

export function scriptsInfo(dir = scriptsDir): ScriptsInfo {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { raprid?: ScriptsInfo };
  if (!pkg.raprid) throw new Error(`管理形式の情報がありません: ${join(dir, "package.json")}`);
  return pkg.raprid;
}

// 操作対象の管理リポジトリ。通常は scripts/ の親で、配布CLIの移行開始処理だけが RAPRID_ROOT で指定する
export function projectRoot(): string {
  return resolve(process.env.RAPRID_ROOT || join(scriptsDir, ".."));
}
