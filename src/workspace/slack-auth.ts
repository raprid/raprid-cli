import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { safe } from "./store.js";

/** プロセス環境を優先し、設定ファイルの値をグローバル環境へ書き込まない。 */
function settings(root: string, env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const file = safe(root, ".env");
  const values = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
  return { token: env.SLACK_USER_OAUTH_TOKEN ?? values.SLACK_USER_OAUTH_TOKEN, channel: env.SLACK_CHANNEL_ID ?? values.SLACK_CHANNEL_ID, workspace: env.SLACK_WORKSPACE_ID ?? values.SLACK_WORKSPACE_ID };
}
export function slackToken(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const token = (settings(root, env).token ?? "").trim();
  if (!token) throw new Error("SLACK_USER_OAUTH_TOKEN を .env または環境変数に設定してください");
  if (!/^xoxp-[A-Za-z0-9-]+$/.test(token))
    throw new Error("SLACK_USER_OAUTH_TOKEN は Slack User OAuth トークンである必要があります");
  return token;
}
export function slackDefaultChannel(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return (settings(root, env).channel ?? "").trim();
}
export function slackDefaultWorkspace(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return (settings(root, env).workspace ?? "").trim();
}
