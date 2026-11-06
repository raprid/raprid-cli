import React, { useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { readdirSync, existsSync } from "node:fs";
import {
  add,
  atomic,
  hash,
  config,
  document,
  issuePath,
  locked,
  read,
  safe,
  saveDocument,
  textFile,
} from "./store.js";
import { GitHub } from "./github.js";
import { pull, push, status, localRevision, comments, addComment } from "./sync.js";
import { wiki } from "./wiki.js";

type Filter = "all" | "open" | "closed" | "changed" | "conflicts";
type DetailTab = "overview" | "body" | "comments" | "metadata" | "sync";
type EditMode = "body" | "title" | "new" | "comment" | null;
const filters: { id: Filter; label: string }[] = [
  { id: "all", label: "すべて" },
  { id: "open", label: "オープン" },
  { id: "closed", label: "クローズ" },
  { id: "changed", label: "未同期" },
  { id: "conflicts", label: "競合" },
];
const detailTabs: { id: DetailTab; label: string }[] = [
  { id: "overview", label: "概要" },
  { id: "body", label: "本文" },
  { id: "comments", label: "コメント" },
  { id: "metadata", label: "属性" },
  { id: "sync", label: "同期" },
];

export function WorkspaceApp({ root }: { root: string }) {
  const { exit } = useApp(), { stdout } = useStdout();
  const [snapshot, setSnapshot] = useState(() => status(root));
  const [index, setIndex] = useState(0), [view, setView] = useState<Filter>("all");
  const [tab, setTab] = useState<"issues" | "wiki">("issues");
  const [detail, setDetail] = useState<DetailTab>("overview");
  const [search, setSearch] = useState<string | null>(null), [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0), [message, setMessage] = useState("ローカル表示。g:取得 p:送信計画");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ changes: any[]; revision: string } | null>(null);
  const [editRevision, setEditRevision] = useState(""), [editing, setEditing] = useState<EditMode>(null), [input, setInput] = useState("");
  const [narrowDetail, setNarrowDetail] = useState(false);
  const pages = existsSync(safe(root, "wiki")) ? readdirSync(safe(root, "wiki")).filter((x) => x.endsWith(".md")).sort() : [];
  const visible = useMemo(() => snapshot.issues.filter((x: any) => {
    if (view === "open" && x.state !== "open") return false;
    if (view === "closed" && x.state !== "closed") return false;
    if (view === "changed" && !x.dirty) return false;
    if (view === "conflicts" && !x.conflicts) return false;
    return !query || `${x.number ?? ""} ${x.title ?? ""} ${x.id}`.toLowerCase().includes(query.toLowerCase());
  }), [snapshot, view, query]);
  const items: any[] = tab === "issues" ? visible : pages.map((id) => ({ id, title: id }));
  const selected = items[Math.min(index, Math.max(0, items.length - 1))];
  const selectedIssue = tab === "issues" && selected ? snapshot.issues.find((x: any) => x.id === selected.id) : null;
  function refresh() { setSnapshot(status(root)); setIndex((x) => Math.min(x, Math.max(0, items.length - 1))); setOffset(0); }
  async function work(fn: () => Promise<any> | any) {
    setBusy(true);
    try { const result = await locked(root, fn); setMessage(typeof result === "string" ? result : "処理完了"); refresh(); return true; }
    catch (e) { setMessage(String(e)); return false; }
    finally { setBusy(false); }
  }
  function beginEdit(mode: Exclude<EditMode, null>) {
    if (mode === "new") { setEditRevision(""); setInput(""); }
    else if (mode === "comment") { setEditRevision(""); setInput(""); }
    else if (selected) { const doc = document(root, selected.id); setEditRevision(hash(doc)); setInput(mode === "body" ? doc.body : doc.issue.title); }
    setEditing(mode);
  }
  useInput((value, key) => {
    if (busy) return;
    if (editing) {
      if (key.escape) { setEditing(null); return; }
      if (key.ctrl && value === "s") {
        const mode = editing;
        void work(() => {
          if (mode === "new") { const title = input.split("\n")[0]; if (!title.trim()) throw new Error("タイトルを入力してください"); add(root, title, input.split("\n").slice(1).join("\n")); }
          else if (mode === "comment" && selected) addComment(root, selected.id, input);
          else if (selected) { const doc = document(root, selected.id); if (hash(doc) !== editRevision) throw new Error("編集中に変更されました。入力は保持しています。Escで戻って再確認してください"); if (mode === "body") doc.body = input; else if (mode === "title") doc.issue.title = input; saveDocument(root, selected.id, doc); }
        }).then((ok) => { if (ok) setEditing(null); }); return;
      }
      if (key.backspace || key.delete) setInput((x) => Array.from(x).slice(0, -1).join(""));
      else if (key.return) setInput((x) => x + "\n");
      else if (!key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) setInput((x) => x + value);
      return;
    }
    if (search !== null) {
      if (key.escape) { setSearch(null); return; }
      if (key.return) { setQuery(search); setSearch(null); setIndex(0); return; }
      if (key.backspace || key.delete) setSearch((x) => (x ?? "").slice(0, -1));
      else if (!key.ctrl && !key.meta) setSearch((x) => x + value);
      return;
    }
    if (preview) {
      if (value === "y") { const p = preview; setPreview(null); void work(async () => { const api = new GitHub(config(root)); const latest = await push(root, api, true); if (hash(latest) !== hash(p.changes)) throw new Error("送信計画が変わりました。pで再確認してください"); return push(root, api, false, p.revision); }); }
      else if (value === "n" || key.escape) setPreview(null);
      return;
    }
    if (value === "q") { exit(); return; }
    if (key.tab) { setTab((x) => x === "issues" ? "wiki" : "issues"); setIndex(0); setOffset(0); return; }
    if (key.upArrow) setIndex((x) => Math.max(0, x - 1));
    if (key.downArrow) setIndex((x) => Math.min(Math.max(0, items.length - 1), x + 1));
    if (key.pageDown) setOffset((x) => x + 10);
    if (key.pageUp) setOffset((x) => Math.max(0, x - 10));
    if (value === "r") refresh();
    if (value === "/") { setSearch(""); return; }
    if (value === "x") { setQuery(""); setIndex(0); }
    if (value === "[" || value === "]") { const i = filters.findIndex((x) => x.id === view); setView(filters[(i + (value === "]" ? 1 : filters.length - 1)) % filters.length].id); setIndex(0); }
    if (value === "1" || value === "2" || value === "3" || value === "4" || value === "5") setDetail(detailTabs[Number(value) - 1].id);
    if (value === "g") void work(() => tab === "issues" ? pull(root, new GitHub(config(root))) : wiki(root, "pull"));
    if (value === "p" && tab === "issues") void work(async () => { const revision = localRevision(root); const changes = await push(root, new GitHub(config(root)), true); if (revision !== localRevision(root)) throw new Error("確認中に編集されました。再度pを押してください"); setPreview({ changes, revision }); return `${changes.length}件の変更予定`; });
    if (value === "n" && tab === "issues") beginEdit("new");
    if (selected && tab === "issues") {
      if (value === "e") beginEdit("body");
      if (value === "t") beginEdit("title");
      if (value === "a") beginEdit("comment");
      if (value === "c") void work(() => { const doc = document(root, selected.id); doc.issue.state = doc.issue.state === "open" ? "closed" : "open"; doc.issue.stateReason = doc.issue.state === "closed" ? "completed" : "reopened"; saveDocument(root, selected.id, doc); return "状態をローカル保存しました。送信にはpを使用"; });
    }
    if (key.return && (stdout.columns ?? 80) < 100) setNarrowDetail((x) => !x);
  });
  let doc: any = null, body = "", commentList: any[] = [], relations: any = null, fields: any = null, remote: any = null, conflicts: any[] = [];
  if (selected && tab === "issues") try { doc = document(root, selected.id); body = doc.body; commentList = comments(root, selected.id); relations = read(root, `${issuePath(selected.id)}/relations.json`, null); fields = read(root, `${issuePath(selected.id)}/fields.json`, null); remote = read(root, `${issuePath(selected.id)}/remote.json`, null); conflicts = read(root, `.raprid/sync/issues/${selected.id}/conflicts/document.json`, []); } catch (e) { body = String(e); }
  else if (selected) try { body = textFile(root, `wiki/${selected.id}`); } catch (e) { body = String(e); }
  const cols = stdout.columns ?? 100, rows = stdout.rows ?? 24, compact = cols < 100, tiny = cols < 60 || rows < 14;
  const height = Math.max(4, rows - 11), width = Math.max(16, cols - 4);
  const wrap = (s: string) => s.split("\n").flatMap((line) => { const a = Array.from(line), size = Math.max(12, Math.floor((tiny ? width : width * (compact ? .58 : .4)) * .9)); return a.length ? Array.from({ length: Math.ceil(a.length / size) }, (_, i) => a.slice(i * size, (i + 1) * size).join("")) : [""]; });
  const content = tab === "wiki" ? wrap(body) : detail === "overview" ? [
    `#${selectedIssue?.number ?? "local"}  ${doc?.issue.title ?? selected?.title ?? ""}`,
    `状態: ${doc?.issue.state ?? "—"}    ${selectedIssue?.dirty ? "● 未同期" : "同期済み"}    ${selectedIssue?.conflicts ? `⚠ 競合 ${selectedIssue.conflicts}` : ""}`,
    `ラベル: ${doc?.issue.labels?.join(", ") || "なし"}`,
    `担当: ${doc?.issue.assignees?.join(", ") || "なし"}`,
    `マイルストーン: ${doc?.issue.milestone ?? "なし"}    種別: ${doc?.issue.type ?? "なし"}`,
    "", ...wrap(body).slice(0, 14), "", `コメント ${commentList.length}件  |  URL ${remote?.html_url ?? "未作成"}`,
  ] : detail === "body" ? wrap(body) : detail === "comments" ? commentList.flatMap((c: any, i: number) => [`[${i + 1}] ${c.meta?.remote?.user?.login ?? "ローカル"}  ${c.meta?.remote?.created_at ?? ""}`, ...wrap(c.body), ""]) : detail === "metadata" ? wrap(JSON.stringify({ issue: doc?.issue, relations, fields }, null, 2)) : detail === "sync" ? [
    `同期状態: ${selectedIssue?.dirty ? "ローカル変更あり" : "クリーン"}`, `最終取得: ${selectedIssue?.fetched?.fetchedAt ?? "未取得"}`, `競合: ${conflicts.length}`,
    ...conflicts.flatMap((c: any) => [`• ${c.field}`, `  ローカル: ${JSON.stringify(c.local)}`, `  リモート: ${JSON.stringify(c.remote)}`]),
    `結果確認待ち操作: ${snapshot.operations.length}`,
  ] : wrap(body);
  return <Box flexDirection="column">
    <Box justifyContent="space-between"><Text bold>raprid v2.1 — {config(root).repository}</Text><Text color="cyan">{tab === "issues" ? "Issues" : "Wiki"}  [Tab切替]</Text></Box>
    {editing ? <Box flexDirection="column"><Text color="yellow">{editing === "new" ? "新規Issue (1行目:タイトル、以降:本文)" : editing === "comment" ? "コメント" : editing === "body" ? "本文編集" : "タイトル編集"}  Ctrl+S:保存 Esc:取消</Text><Text>{wrap(input).slice(-height).join("\n")}▌</Text></Box>
      : preview ? <Box flexDirection="column"><Text color="yellow">送信計画 {preview.changes.length}件 — y:送信 n:取消</Text><Text>{wrap(JSON.stringify(preview.changes, null, 2)).slice(0, height).join("\n")}</Text></Box>
      : search !== null ? <Text color="yellow">検索: {search}▌  Enter:適用 Esc:取消</Text>
      : tiny && narrowDetail ? <Box flexDirection="column"><Text bold>{selected?.title ?? "Issueなし"}</Text><Text>{detailTabs.find((x) => x.id === detail)?.label}</Text><Text>{content.slice(offset, offset + height).join("\n")}</Text></Box>
      : <Box>
        {!compact && <Box width="18%" flexDirection="column" borderStyle="single" borderColor="gray"><Text bold> VIEWS </Text>{filters.map((f, i) => <Text key={f.id} color={view === f.id ? "cyan" : undefined}>{view === f.id ? "›" : " "} {i + 1}. {f.label}{f.id === "all" ? ` (${snapshot.issues.length})` : f.id === "changed" ? ` (${snapshot.issues.filter((x: any) => x.dirty).length})` : f.id === "conflicts" ? ` (${snapshot.issues.filter((x: any) => x.conflicts).length})` : ""}</Text>)}<Text dimColor> </Text><Text dimColor>[/] 検索</Text><Text dimColor>[ ] ビュー</Text></Box>}
        {!(tiny && narrowDetail) && <Box width={compact ? "42%" : "35%"} flexDirection="column" borderStyle="single" borderColor="gray"><Text bold> ISSUES {query ? ` / ${query}` : ""} </Text>{items.length ? items.slice(Math.max(0, index - height + 1), Math.max(height, index + 1)).map((item: any, i: number) => <Text key={item.id} color={item.id === selected?.id ? "cyan" : undefined} wrap="truncate">{item.id === selected?.id ? "›" : " "} {item.number ? `#${item.number}` : "local"} {item.state === "open" ? "○" : item.state === "closed" ? "●" : ""} {item.dirty ? "*" : " "}{item.conflicts ? `!${item.conflicts}` : ""} {item.title ?? item.id}</Text>) : <Text dimColor>該当なし</Text>}</Box>}
        {!compact && <Box width="47%" flexDirection="column" borderStyle="single" borderColor="gray"><Box><Text bold>{selected?.title ?? "詳細"} </Text>{detailTabs.map((t, i) => <Text key={t.id} color={detail === t.id ? "cyan" : "gray"}> {i + 1}:{t.label}</Text>)}</Box><Text>{content.slice(offset, offset + height).join("\n")}</Text></Box>}
        {compact && <Box width="58%" flexDirection="column" borderStyle="single" borderColor="gray"><Text bold>{selected?.title ?? "詳細"} — Enterで詳細切替</Text><Text>{content.slice(offset, offset + height).join("\n")}</Text></Box>}
      </Box>}
    <Text color={busy ? "yellow" : "green"}>{busy ? "処理中…" : message.slice(0, width * 2)}</Text>
    <Text dimColor>↑↓ 選択  Tab Issues/Wiki  1–5 詳細  /検索  [ ]ビュー  n新規 e本文 tタイトル aコメント c状態  g取得 p送信確認  PgUp/PgDnスクロール  r更新 q終了</Text>
    <Text dimColor>ローカル変更は送信計画を確認してからGitHubへ反映します。Wiki編集はCLIを使用してください。</Text>
  </Box>;
}
export async function runWorkspaceTui(root: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === "dumb") throw new Error("TUIには端末が必要です。issue list --jsonを使用してください");
  const app = render(<WorkspaceApp root={root} />); await app.waitUntilExit();
}
