import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { atomic, read, safe, write, writeBatch } from "./store.js";
import { slackToken } from "./slack-auth.js";

const id = (value: string, pattern: RegExp, label: string): string => {
  if (!pattern.test(value)) throw new Error(`${label}が不正です`);
  return value;
};
const channelId = (v: string) => id(v, /^[CDG][A-Z0-9]+$/, "チャンネルID");
const workspaceId = (v: string) => id(v, /^T[A-Z0-9]+$/, "ワークスペースID");
const timestamp = (v: string) => id(v, /^\d+\.\d+$/, "メッセージID");
const draftId = (v: string) => id(v, /^[a-f0-9-]{36}$/, "下書きID");
export interface SlackApi { call(method: string, args: Record<string, string>): Promise<any> }
export class Slack implements SlackApi {
  private token: string;
  constructor(root: string) { this.token = slackToken(root); }
  async call(method: string, args: Record<string, string>): Promise<any> {
    const get = method === "conversations.history" || method === "conversations.replies";
    const url = new URL(`https://slack.com/api/${method}`);
    if (get) url.search = new URLSearchParams(args).toString();
    const response = await fetch(url, {
      method: get ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json; charset=utf-8" },
      body: get ? undefined : JSON.stringify(args),
    });
    if (!response.ok) throw new Error(`Slack API ${method}: HTTP ${response.status}${response.status === 429 ? ` (Retry-After: ${response.headers.get("retry-after") ?? "不明"}秒)` : ""}`);
    const result: any = await response.json();
    if (!result.ok) throw new Error(`Slack API ${method}: ${String(result.error ?? "unknown_error").replace(/[^a-z_]/g, "")}`);
    return result;
  }
}
async function pages(api: SlackApi, method: string, args: Record<string, string>, key: string, checkpoint?: { root: string; directory: string }): Promise<any[]> {
  const cache = checkpoint && `${checkpoint.directory}/${createHash("sha256").update(JSON.stringify({ method, args, key })).digest("hex")}.json`;
  const prior = cache ? read<any>(checkpoint!.root, cache, null) : null;
  if (prior && (!Array.isArray(prior.output) || !Array.isArray(prior.seen) || typeof prior.cursor !== "string")) throw new Error("Slack の取得再開情報が不正です");
  const output: any[] = prior?.output ?? [], seen = new Set<string>(prior?.seen ?? []);
  let cursor = prior?.cursor ?? "";
  if (prior?.complete === true) return output;
  do {
    const page = await api.call(method, cursor ? { ...args, cursor } : args);
    if (!Array.isArray(page[key])) throw new Error(`Slack API ${method}: 応答形式が不正です`);
    output.push(...page[key]);
    cursor = page.response_metadata?.next_cursor ?? "";
    if (!cursor && page.has_more === true) throw new Error(`Slack API ${method}: 次ページを取得できません。取得を中止しました`);
    if (cursor && seen.has(cursor)) throw new Error("Slack APIのページングが循環しています");
    seen.add(cursor);
    if (cache) write(checkpoint!.root, cache, { output, seen: [...seen], cursor, complete: !cursor });
  } while (cursor);
  return output;
}
async function identity(api: SlackApi): Promise<{ team: string; user: string }> {
  const result = await api.call("auth.test", {});
  return { team: workspaceId(result.team_id), user: id(result.user_id, /^[UW][A-Z0-9]+$/, "ユーザーID") };
}
function channelPath(team: string, channel: string): string {
  return `slack/workspaces/${workspaceId(team)}/channels/${channelId(channel)}`;
}
function saveMessage(root: string, changes: Record<string, string>, base: string, msg: any): void {
  const ts = timestamp(msg.ts);
  const path = `${base}/${ts}`;
  const old = read<any>(root, `${path}/message.json`, null);
  const file = safe(root, `${path}/message.md`);
  if (!old && existsSync(file)) throw new Error(`既存ファイルと取得データが衝突しています: ${path}`);
  if (old && existsSync(file) && readFileSync(file, "utf8") !== (typeof old.text === "string" ? old.text : "")) throw new Error(`取得済みメッセージがローカルで変更されています: ${path}`);
  changes[`${path}/message.json`] = JSON.stringify(msg, null, 2) + "\n";
  changes[`${path}/message.md`] = typeof msg.text === "string" ? msg.text : "";
  changes[`${path}/presence.json`] = JSON.stringify({ present: true }) + "\n";
}
export async function pullSlack(root: string, api: SlackApi, channel: string, oldest?: string, latest?: string): Promise<any> {
  channelId(channel);
  if (oldest) timestamp(oldest);
  if (latest) timestamp(latest);
  const who = await identity(api), base = channelPath(who.team, channel);
  const params: Record<string, string> = { channel, limit: "15" };
  if (oldest) params.oldest = oldest;
  if (latest) params.latest = latest;
  // 全ページを取得してから反映する。失敗時に部分取得を完了と記録しない。
  const staging = `.raprid/sync/slack/staging/${who.team}/${who.user}/${channel}/${createHash("sha256").update(JSON.stringify(params)).digest("hex")}`;
  const checkpoint = { root, directory: staging };
  const messages = await pages(api, "conversations.history", params, "messages", checkpoint);
  const threads: Array<{ parent: string; replies: any[] }> = [];
  for (const msg of messages) {
    timestamp(msg.ts);
    if (msg.reply_count > 0) {
      const replies = await pages(api, "conversations.replies", { channel, ts: msg.ts, limit: "15" }, "messages", checkpoint);
      for (const reply of replies) timestamp(reply.ts);
      threads.push({ parent: msg.ts, replies: replies.filter(x => x.ts !== msg.ts) });
    }
  }
  const changes: Record<string, string> = {};
  for (const msg of messages) saveMessage(root, changes, `${base}/messages`, msg);
  for (const thread of threads) for (const reply of thread.replies) saveMessage(root, changes, `${base}/messages/${thread.parent}/replies`, reply);
  // 全履歴を取得した場合のみ、不在の既存メッセージを削除せず不在と記録する。
  if (!oldest && !latest) {
    const parents = new Set(messages.map(m => m.ts));
    const dir = `${base}/messages`;
    if (existsSync(safe(root, dir))) for (const name of readdirSync(safe(root, dir))) {
      if (!/^\d+\.\d+$/.test(name)) continue;
      const parent = `${dir}/${name}`;
      if (!parents.has(name)) changes[`${parent}/presence.json`] = JSON.stringify({ present: false }) + "\n";
      else {
        const thread = threads.find(t => t.parent === name);
        const current = new Set((thread?.replies ?? []).map(r => r.ts));
        const replies = `${parent}/replies`;
        if (existsSync(safe(root, replies))) for (const reply of readdirSync(safe(root, replies))) {
          if (/^\d+\.\d+$/.test(reply) && !current.has(reply)) changes[`${replies}/${reply}/presence.json`] = JSON.stringify({ present: false }) + "\n";
        }
      }
    }
  }
  changes[`${base}/channel.json`] = JSON.stringify({ id: channel }) + "\n";
  changes[`slack/workspaces/${who.team}/workspace.json`] = JSON.stringify({ id: who.team }) + "\n";
  changes[`.raprid/sync/slack/${who.team}/${channel}.json`] = JSON.stringify({ fetchedAt: new Date().toISOString(), oldest: oldest ?? null, latest: latest ?? null, messages: messages.length, threads: threads.length }) + "\n";
  writeBatch(root, changes);
  rmSync(safe(root, staging), { recursive: true, force: true });
  return { workspace: who.team, channel, messages: messages.length, threads: threads.length };
}
export function createDraft(root: string, team: string, channel: string, body: string, thread?: string): string {
  const base = channelPath(team, channel), draft = randomUUID();
  if (thread) timestamp(thread);
  if (!body.trim()) throw new Error("下書きの本文が空です");
  write(root, `${base}/drafts/${draft}/draft.json`, { workspaceId: team, channelId: channel, threadTs: thread ?? null });
  atomic(root, `${base}/drafts/${draft}/message.md`, body);
  return draft;
}
function draftData(root: string, team: string, channel: string, draft: string) {
  const base = `${channelPath(team, channel)}/drafts/${draftId(draft)}`;
  const meta = read<any>(root, `${base}/draft.json`), body = readFileSync(safe(root, `${base}/message.md`), "utf8");
  if (meta.workspaceId !== team || meta.channelId !== channel || (meta.threadTs !== null && typeof meta.threadTs !== "string")) throw new Error("下書きの送信先が不正です");
  if (meta.threadTs) timestamp(meta.threadTs);
  if (!body.trim()) throw new Error("下書きの本文が空です");
  const revision = createHash("sha256").update(JSON.stringify({ meta, body })).digest("hex");
  return { meta, body, revision };
}
export function previewDraft(root: string, team: string, channel: string, draft: string) {
  return { id: draft, ...draftData(root, team, channel, draft) };
}
export async function sendDraft(root: string, api: SlackApi, team: string, channel: string, draft: string, revision: string) {
  const data = draftData(root, team, channel, draft);
  if (data.revision !== revision) throw new Error("下書きが変更されています。プレビューをやり直してください");
  const journal = `.raprid/sync/slack/operations/${draftId(draft)}.json`;
  if (existsSync(safe(root, journal))) throw new Error("送信済みまたは結果確認待ちです。自動再送しません");
  const who = await identity(api);
  if (who.team !== team) throw new Error("トークンのワークスペースが下書きと一致しません");
  const again = draftData(root, team, channel, draft);
  if (again.revision !== revision) throw new Error("下書きが変更されています。プレビューをやり直してください");
  write(root, journal, { status: "unknown", team, channel, draft, revision, user: who.user, startedAt: new Date().toISOString() });
  const args: Record<string, string> = { channel, text: data.body };
  if (data.meta.threadTs) args.thread_ts = data.meta.threadTs;
  const result = await api.call("chat.postMessage", args);
  if (result.channel !== channel || typeof result.ts !== "string") throw new Error("送信結果を確認できません。自動再送しません");
  timestamp(result.ts);
  write(root, journal, { status: "sent", team, channel, draft, revision, ts: result.ts, sentAt: new Date().toISOString() });
  return { status: "sent", channel, ts: result.ts };
}
export async function reconcileDraft(root: string, api: SlackApi, draft: string, remoteTs: string) {
  timestamp(remoteTs);
  const path = `.raprid/sync/slack/operations/${draftId(draft)}.json`;
  const op = read<any>(root, path);
  if (op.status !== "unknown") throw new Error("結果確認待ちの送信ではありません");
  const data = draftData(root, op.team, op.channel, draft);
  if (data.revision !== op.revision) throw new Error("送信後に下書きが変更されています。送信時の内容に戻してから照合してください");
  const who = await identity(api);
  if (who.team !== op.team || who.user !== op.user) throw new Error("送信時と異なる Slack アカウントです");
  const method = data.meta.threadTs ? "conversations.replies" : "conversations.history";
  const args: Record<string, string> = data.meta.threadTs
    ? { channel: op.channel, ts: data.meta.threadTs, limit: "15" }
    : { channel: op.channel, oldest: remoteTs, latest: remoteTs, inclusive: "true", limit: "15" };
  const messages = await pages(api, method, args, "messages");
  const match = messages.find(m => m.ts === remoteTs && m.user === op.user && m.text === data.body && (!data.meta.threadTs || m.thread_ts === data.meta.threadTs));
  if (!match) throw new Error("指定メッセージと送信内容が一致しません。結果確認待ちを維持します");
  write(root, path, { ...op, status: "sent", ts: remoteTs, reconciledAt: new Date().toISOString() });
  return { status: "sent", channel: op.channel, ts: remoteTs };
}
export function searchSlack(root: string, term: string) {
  if (!term) throw new Error("検索語を指定してください");
  const found: Array<{ path: string; text: string }> = [];
  function scan(path: string) {
    if (!existsSync(safe(root, path))) return;
    if (read<any>(root, `${path}/presence.json`, { present: true }).present === false) return;
    for (const entry of readdirSync(safe(root, path), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const next = `${path}/${entry.name}`;
      if (entry.isDirectory() && entry.name !== "drafts") scan(next);
      else if (entry.isFile() && entry.name === "message.md") {
        if (read<any>(root, `${path}/presence.json`, { present: true }).present === false) continue;
        const text = readFileSync(safe(root, next), "utf8");
        if (text.includes(term)) found.push({ path: next, text });
      }
    }
  }
  scan("slack/workspaces");
  return found;
}
