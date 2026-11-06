import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { config, safe, write } from "./store.js";
const gitEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  );
export function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      env: { ...gitEnv(), GIT_TERMINAL_PROMPT: "0" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60000,
    }).trim();
  } catch (e: any) {
    throw new Error(
      `Git操作に失敗しました: ${args[0]}\n${String(e.stderr ?? "").slice(0, 2000)}`,
    );
  }
}
export function wiki(
  root: string,
  action: string,
  dryRun = false,
  message = "Wikiを更新",
  run: typeof git = git,
): any {
  const path = safe(root, "wiki"),
    c = config(root),
    url = `git@${c.host}:${c.repository}.wiki.git`;
  if (!existsSync(safe(root, "wiki/.git"))) {
    if (action === "status") return { initialized: false };
    if (action !== "pull")
      throw new Error("先にraprid wiki pullでWikiを取得してください");
    if (existsSync(path) && readdirSync(path).length)
      throw new Error(
        "wiki/に既存ファイルがあります。別の場所へ保持してから取得してください",
      );
    if (dryRun) return { action: "clone", url };
    run(root, ["clone", "--", url, path]);
  }
  const origin = run(path, ["remote", "get-url", "origin"]);
  if (origin !== url && origin !== `https://${c.host}/${c.repository}.wiki.git`)
    throw new Error("Wikiのoriginが設定と一致しません");
  const changes = run(path, ["status", "--porcelain"]);
  if (action === "status")
    return {
      initialized: true,
      branch: run(path, ["branch", "--show-current"]),
      changes,
    };
  if (dryRun) return { action, changes };
  if (action === "pull") {
    if (changes)
      throw new Error(
        "Wikiに未コミットの編集があります。wiki commitで保存してからpullしてください",
      );
    run(path, ["fetch", "origin"]);
    const upstream = run(path, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
    // 分岐した履歴は強制上書きせず、Gitの通常マージで競合を残す。
    run(path, ["merge", "--no-edit", upstream]);
  } else if (action === "commit") {
    if (!changes) return { action, changed: false };
    run(path, ["add", "--all"]);
    run(path, ["commit", "-m", message]);
  } else if (action === "push") {
    if (changes)
      throw new Error(
        "Wikiに未コミットの編集があります。wiki commitを先に実行してください",
      );
    run(path, ["fetch", "origin"]);
    const upstream = run(path, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
    run(path, ["merge-base", "--is-ancestor", upstream, "HEAD"]);
    run(path, ["push", "origin", "HEAD"]);
  } else throw new Error("wiki status|pull|commit|push を指定してください");
  const result = {
    action,
    head: run(path, ["rev-parse", "HEAD"]),
    at: new Date().toISOString(),
  };
  write(root, ".raprid/sync/wiki.json", result);
  return result;
}
