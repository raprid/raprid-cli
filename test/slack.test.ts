import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "./tui-fixtures.ts";
const { Slack, pullSlack, createDraft, previewDraft, sendDraft, reconcileDraft, searchSlack } = await load<typeof import("../src/workspace/slack.js")>("../dist/workspace/slack.js");
const who = { ok: true, team_id: "T123", user_id: "U123" };
test("Slack 履歴とスレッド API は GET のクエリで呼び出す", async () => {
 const root=mkdtempSync(join(tmpdir(),"slack-http-")); const original=globalThis.fetch;
 try {writeFileSync(join(root,".env"),"SLACK_USER_OAUTH_TOKEN=xoxp-test-token\n");
 globalThis.fetch=async (url, options) => {assert.equal(options?.method,"GET"); assert.equal(new URL(String(url)).searchParams.get("channel"),"C123"); assert.equal(new URL(String(url)).searchParams.get("ts"),"1.000001"); assert.ok(!String(url).includes("xoxp")); return new Response(JSON.stringify({ok:true,messages:[]}),{status:200});};
 await new Slack(root).call("conversations.replies",{channel:"C123",ts:"1.000001",limit:"15"});
 } finally {globalThis.fetch=original;rmSync(root,{recursive:true,force:true});}
});
test("ページとスレッドを取得しローカル検索できる", async () => {
 const root = mkdtempSync(join(tmpdir(), "slack-test-"));
 try {
  const api = { async call(method: string, args: Record<string,string>) {
   if (method === "auth.test") return who;
   if (method === "conversations.history") return args.cursor ? { messages: [{ ts: "2.000002", text: "二番" }] } : { messages: [{ ts: "1.000001", text: "親", reply_count: 1 }], response_metadata: { next_cursor: "next" } };
   if (method === "conversations.replies") return { messages: [{ts:"1.000001"}, {ts:"1.000002",text:"返信本文"}] };
   throw new Error(method);
  }};
  const result = await pullSlack(root, api, "C123");
  assert.equal(result.messages, 2);
  assert.match(searchSlack(root, "返信本文")[0].path, /replies\/1\.000002\/message.md$/);
  assert.equal(readFileSync(join(root, "slack/workspaces/T123/channels/C123/messages/1.000001/message.md"), "utf8"), "親");
 } finally { rmSync(root, {recursive:true,force:true}); }
});
test("下書き変更を検出し、送信結果不明時は再送しない", async () => {
 const root = mkdtempSync(join(tmpdir(), "slack-test-")); let sends = 0;
 try {
  const draft = createDraft(root, "T123", "C123", "返信", "1.000001");
  const preview = previewDraft(root, "T123", "C123", draft);
  const api = { async call(method: string) { if (method === "auth.test") return who; sends++; throw new Error("通信断"); } };
  const body = join(root, `slack/workspaces/T123/channels/C123/drafts/${draft}/message.md`);
  writeFileSync(body, "変更");
  await assert.rejects(sendDraft(root, api, "T123", "C123", draft, preview.revision), /変更/);
  const revised = previewDraft(root, "T123", "C123", draft);
  await assert.rejects(sendDraft(root, api, "T123", "C123", draft, revised.revision), /通信断/);
  await assert.rejects(sendDraft(root, api, "T123", "C123", draft, revised.revision), /自動再送しません/);
  assert.equal(sends, 1);
  const verify = { async call(method: string) { return method === "auth.test" ? who : { messages: [{ts:"2.000002", user:"U123", text:"変更", thread_ts:"1.000001"}] }; } };
  await assert.rejects(reconcileDraft(root, verify, draft, "3.000003"), /一致しません/);
  assert.equal((await reconcileDraft(root, verify, draft, "2.000002")).status, "sent");
 } finally { rmSync(root, {recursive:true,force:true}); }
});
test("取得できなかった投稿は保持し検索から除き、再取得で復帰する", async () => {
 const root=mkdtempSync(join(tmpdir(),"slack-test-")); let content:any[]=[{ts:"1.000001",text:"対象"}];
 const api={async call(method:string){return method==="auth.test"?who:{messages:content};}};
 try {
  await pullSlack(root,api,"C123"); assert.equal(searchSlack(root,"対象").length,1);
  content=[]; await pullSlack(root,api,"C123"); assert.equal(searchSlack(root,"対象").length,0);
  assert.equal(readFileSync(join(root,"slack/workspaces/T123/channels/C123/messages/1.000001/message.md"),"utf8"),"対象");
  content=[{ts:"1.000001",text:"更新"}]; await pullSlack(root,api,"C123"); assert.equal(searchSlack(root,"更新").length,1);
 } finally {rmSync(root,{recursive:true,force:true});}
});
test("取得エラーで部分データを確定しない", async () => {
 const root=mkdtempSync(join(tmpdir(),"slack-test-"));
 const api={async call(method:string){if(method==="auth.test")return who; if(method==="conversations.history")return {messages:[{ts:"1.000001",text:"本文",reply_count:1}]}; throw new Error("429");}};
 try {await assert.rejects(pullSlack(root,api,"C123"),/429/); assert.equal(searchSlack(root,"本文").length,0);} finally {rmSync(root,{recursive:true,force:true});}
});
test("取得途中の失敗後は保存済みページから再開する", async () => {
 const root=mkdtempSync(join(tmpdir(),"slack-test-")); let histories=0, failures=1;
 const api={async call(method:string){if(method==="auth.test")return who; if(method==="conversations.history"){histories++;return {messages:[{ts:"1.000001",text:"親",reply_count:1}]};} if(failures-- > 0)throw new Error("429"); return {messages:[{ts:"1.000001"},{ts:"1.000002",text:"返信"}]};}};
 try {await assert.rejects(pullSlack(root,api,"C123"),/429/); await pullSlack(root,api,"C123"); assert.equal(histories,1); assert.equal(searchSlack(root,"返信").length,1);} finally {rmSync(root,{recursive:true,force:true});}
});
