import React, { useState } from "react";
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
  safe,
  saveDocument,
  textFile,
} from "./store.js";
import { GitHub } from "./github.js";
import { pull, push, status, localRevision } from "./sync.js";
import { wiki } from "./wiki.js";

export function WorkspaceApp({ root }: { root: string }) {
  const { exit } = useApp(),
    { stdout } = useStdout();
  const [snapshot, setSnapshot] = useState(() => status(root)),
    [index, setIndex] = useState(0),
    [tab, setTab] = useState<"issues" | "wiki">("issues"),
    [offset, setOffset] = useState(0);
  const [message, setMessage] = useState(
      "ローカル表示。gで取得、pで送信差分を確認",
    ),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<{
      changes: any[];
      revision: string;
    } | null>(null);
  const [editRevision, setEditRevision] = useState("");
  const [editing, setEditing] = useState<"body" | "title" | "new" | null>(null),
    [input, setInput] = useState("");
  const pages = existsSync(safe(root, "wiki"))
    ? readdirSync(safe(root, "wiki"))
        .filter((x) => x.endsWith(".md"))
        .sort()
    : [];
  const items =
      tab === "issues"
        ? snapshot.issues
        : pages.map((x) => ({ id: x, title: x })),
    selected = items[index];
  function refresh() {
    setSnapshot(status(root));
    setOffset(0);
  }
  async function work(fn: () => Promise<any> | any) {
    setBusy(true);
    try {
      const result = await locked(root, fn);
      setMessage(typeof result === "string" ? result : "処理完了");
      refresh();
      return true;
    } catch (e) {
      setMessage(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  useInput((value, key) => {
    if (busy) return;
    if (editing) {
      if (key.escape) {
        setEditing(null);
        return;
      }
      if (key.ctrl && value === "s") {
        void work(() => {
          if (editing === "new") add(root, input);
          else if (selected) {
            const doc = document(root, selected.id);
            if (hash(doc) !== editRevision)
              throw new Error(
                "編集中に変更されました。入力は保持しています。Escで戻って再確認してください",
              );
            if (editing === "body") doc.body = input;
            else doc.issue.title = input;
            saveDocument(root, selected.id, doc);
          }
        }).then((ok) => {
          if (ok) setEditing(null);
        });
        return;
      }
      if (key.backspace || key.delete)
        setInput((x) => Array.from(x).slice(0, -1).join(""));
      else if (key.return && editing === "body") setInput((x) => x + "\n");
      else if (
        !key.ctrl &&
        !key.meta &&
        !key.upArrow &&
        !key.downArrow &&
        !key.leftArrow &&
        !key.rightArrow
      )
        setInput((x) => x + value);
      return;
    }
    if (preview) {
      if (value === "y") {
        setPreview(null);
        void work(async () => {
          const api = new GitHub(config(root));
          const latest = await push(root, api, true);
          if (hash(latest) !== hash(preview.changes))
            throw new Error("送信計画が変わりました。pで再確認してください");
          return push(root, api, false, preview.revision);
        });
      } else if (value === "n" || key.escape) setPreview(null);
      return;
    }
    if (value === "q") {
      exit();
      return;
    }
    if (key.tab) {
      setTab((x) => (x === "issues" ? "wiki" : "issues"));
      setIndex(0);
      setOffset(0);
      return;
    }
    if (key.upArrow) {
      setIndex((x) => Math.max(0, x - 1));
      setOffset(0);
    }
    if (key.downArrow) {
      setIndex((x) => Math.min(items.length - 1, x + 1));
      setOffset(0);
    }
    if (key.pageDown) setOffset((x) => x + 10);
    if (key.pageUp) setOffset((x) => Math.max(0, x - 10));
    if (value === "r") refresh();
    if (value === "g")
      void work(() =>
        tab === "issues"
          ? pull(root, new GitHub(config(root)))
          : wiki(root, "pull"),
      );
    if (value === "p" && tab === "issues")
      void work(async () => {
        const revision = localRevision(root);
        const changes = await push(root, new GitHub(config(root)), true);
        if (revision !== localRevision(root))
          throw new Error("確認中に編集されました。再度pを押してください");
        setPreview({ changes, revision });
        return `${changes.length}件の変更予定`;
      });
    if (value === "n" && tab === "issues") {
      setEditing("new");
      setInput("");
    }
    if (selected && tab === "issues") {
      if (value === "e" || value === "t") {
        const doc = document(root, selected.id);
        setEditRevision(hash(doc));
        setEditing(value === "e" ? "body" : "title");
        setInput(value === "e" ? doc.body : doc.issue.title);
      }
      if (value === "c")
        void work(() => {
          const doc = document(root, selected.id);
          doc.issue.state = doc.issue.state === "open" ? "closed" : "open";
          doc.issue.stateReason =
            doc.issue.state === "closed" ? "completed" : "reopened";
          saveDocument(root, selected.id, doc);
          return "状態をローカル保存しました。送信にはpを使用";
        });
    }
  });
  let body = "";
  try {
    if (selected)
      body =
        tab === "issues"
          ? document(root, selected.id).body
          : textFile(root, `wiki/${selected.id}`);
  } catch (e) {
    body = String(e);
  }
  const height = Math.max(4, (stdout.rows ?? 24) - 9),
    width = Math.max(20, (stdout.columns ?? 80) - 4);
  const lines = (s: string) =>
    s.split("\n").flatMap((l) => {
      const a = Array.from(l);
      return a.length
        ? Array.from(
            {
              length: Math.ceil(a.length / Math.max(10, Math.floor(width / 2))),
            },
            (_, i) =>
              a
                .slice(
                  i * Math.floor(width / 2),
                  (i + 1) * Math.floor(width / 2),
                )
                .join(""),
          )
        : [""];
    });
  return (
    <Box flexDirection="column">
      <Text bold>
        raprid v2 — {config(root).repository} —{" "}
        {tab === "issues" ? "Issues" : "Wiki"}
      </Text>
      {editing ? (
        <Box flexDirection="column">
          <Text color="yellow">
            {editing} 編集（末尾入力） Ctrl+S:保存 Esc:取消
          </Text>
          <Text>{lines(input).slice(-height).join("\n")}▌</Text>
        </Box>
      ) : preview ? (
        <Box flexDirection="column">
          <Text color="yellow">送信しますか？ y:送信 n:取消</Text>
          <Text>
            {lines(JSON.stringify(preview.changes, null, 2))
              .slice(0, height)
              .join("\n")}
          </Text>
        </Box>
      ) : (
        <Box>
          <Box width="40%" flexDirection="column">
            {items
              .slice(
                Math.max(0, index - height + 1),
                Math.max(height, index + 1),
              )
              .map((item: any) => (
                <Text
                  key={item.id}
                  color={item.id === selected?.id ? "cyan" : undefined}
                >
                  {item.id === selected?.id ? "›" : " "}{" "}
                  {item.number ? `#${item.number}` : ""} {item.dirty ? "*" : ""}
                  {item.conflicts ? "!" : ""} {item.title ?? item.id}
                </Text>
              ))}
          </Box>
          <Box width="60%">
            <Text>
              {lines(body)
                .slice(offset, offset + height)
                .join("\n")}
            </Text>
          </Box>
        </Box>
      )}
      <Text color={busy ? "yellow" : "green"}>
        {busy ? "処理中…" : message.slice(0, width * 2)}
      </Text>
      <Text dimColor>
        ↑↓選択 Tab切替 PgUp/PgDn本文 r再読込 g取得 p送信 n新規 e本文 tタイトル
        c終了/再開 q終了
      </Text>
      <Text dimColor>
        結果確認待ち: {snapshot.operations.length}件 /
        Wiki編集・commit・pushはCLIを使用
      </Text>
    </Box>
  );
}
export async function runWorkspaceTui(root: string): Promise<void> {
  if (
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    process.env.TERM === "dumb"
  )
    throw new Error(
      "TUIには端末が必要です。issue list --jsonを使用してください",
    );
  const app = render(<WorkspaceApp root={root} />);
  await app.waitUntilExit();
}
