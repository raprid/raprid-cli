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

// 操作対象の管理リポジトリ。raprid CLI は判定したルートを RAPRID_ROOT で渡す (移行開始処理では旧プロジェクト)。
// 指定が無ければ scripts/ の実体の親を使う (scripts/ がシンボリックリンクなら、pnpm raprid はリンク先の親を操作する)
export function projectRoot(): string {
  return resolve(process.env.RAPRID_ROOT || join(scriptsDir, ".."));
}
