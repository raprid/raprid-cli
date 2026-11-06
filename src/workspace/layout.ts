import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { atomic, config, read, safe, write } from "./store.js";

export function migrateLayout(root: string, apply: boolean) {
  const c: any = config(root), journal = ".raprid/layout-migration.json";
  const plan = { from: ["issues", "wiki"], to: ["github/issues", "github/wiki"] };
  if (c.layout === "services-v1") {
    const prior = read<any>(root, journal, null);
    if (prior && !prior.complete && apply) write(root, journal, { version: 1, complete: true });
    return { ...plan, alreadyMigrated: true };
  }
  if (c.layout && c.layout !== "services-v1") throw new Error("未知のワークスペース形式です");
  if (!apply) return { ...plan, apply: false };
  const state = read<any>(root, journal, null);
  if (!state) {
    if (existsSync(join(root, "github"))) throw new Error("github/ が既に存在します");
    for (const name of ["issues", "wiki"]) {
      const source = join(root, name);
      if (existsSync(source) && (!lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink())) throw new Error(`${name}/ は通常のディレクトリである必要があります`);
    }
    const wikiGit = join(root, "wiki/.git");
    if (existsSync(wikiGit) && !lstatSync(wikiGit).isDirectory()) throw new Error("Wiki の .git がファイルです。移行前に Git の参照を確認してください");
    write(root, journal, { version: 1 });
  } else if (state.version !== 1) throw new Error("移行記録が不正です");
  if (existsSync(join(root, "github")) && (lstatSync(join(root, "github")).isSymbolicLink() || !lstatSync(join(root, "github")).isDirectory())) throw new Error("github/ は通常のディレクトリである必要があります");
  mkdirSync(join(root, "github"), { recursive: true });
  for (const name of ["issues", "wiki"]) {
    const source = join(root, name), target = join(root, "github", name);
    if (existsSync(source) && existsSync(target)) throw new Error(`${name} の移行元と移行先が両方存在します`);
    if (existsSync(source)) renameSync(source, target);
    else if (!existsSync(target)) mkdirSync(target);
  }
  const ignore = existsSync(join(root, ".gitignore")) ? readFileSync(join(root, ".gitignore"), "utf8") : "";
  const lines = ignore.split(/\r?\n/);
  const extra = [".env", "github/wiki/"].filter(line => !lines.includes(line));
  if (extra.length) atomic(root, ".gitignore", `${ignore}${ignore && !ignore.endsWith("\n") ? "\n" : ""}${extra.join("\n")}\n`);
  if (!existsSync(join(root, ".env.example"))) atomic(root, ".env.example", "SLACK_USER_OAUTH_TOKEN=\nSLACK_WORKSPACE_ID=\nSLACK_CHANNEL_ID=\n");
  mkdirSync(join(root, "slack"), { recursive: true });
  write(root, ".raprid/config.json", { ...c, layout: "services-v1" });
  // 完了記録は監査用に残し、中断記録と区別する。
  write(root, journal, { version: 1, complete: true });
  return { ...plan, apply: true };
}
