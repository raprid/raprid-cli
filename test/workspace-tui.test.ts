import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { load } from "./tui-fixtures.ts";
const { initialize, add, document, saveDocument } = await load<
  typeof import("../src/workspace/store.js")
>("../dist/workspace/store.js");
const { WorkspaceApp } = await load<typeof import("../src/workspace/tui.js")>(
  "../dist/workspace/tui.js",
);
const wait = () => new Promise((r) => setTimeout(r, 60));
test("TUIの本文編集は外部更新を上書きせず入力を保持する", async () => {
  const root = mkdtempSync(join(tmpdir(), "raprid-tui-"));
  initialize(root, "test/repo");
  const id = add(root, "題名", "元本文");
  const view = render(createElement(WorkspaceApp, { root }));
  try {
    await wait();
    view.stdin.write("e");
    await wait();
    view.stdin.write("追記");
    await wait();
    const doc = document(root, id);
    doc.body = "別の操作";
    saveDocument(root, id, doc);
    view.stdin.write("\x13");
    await wait();
    assert.equal(document(root, id).body, "別の操作");
    assert.match(view.lastFrame() ?? "", /編集中に変更|入力は保持/);
    assert.match(view.lastFrame() ?? "", /追記/);
    view.stdin.write("\x1b");
    await wait();
  } finally {
    view.unmount();
    cleanup();
  }
});
test("TUIの保存とWikiタブ切替はネットワークなしで操作できる", async () => {
  const root = mkdtempSync(join(tmpdir(), "raprid-tui-"));
  initialize(root, "test/repo");
  const id = add(root, "題名", "本文");
  const view = render(createElement(WorkspaceApp, { root }));
  try {
    await wait();
    view.stdin.write("e");
    await wait();
    view.stdin.write("追記");
    await wait();
    view.stdin.write("\x13");
    await wait();
    assert.equal(document(root, id).body, "本文追記");
    view.stdin.write("w");
    await wait();
    assert.match(view.lastFrame() ?? "", /Wiki/);
  } finally {
    view.unmount();
    cleanup();
  }
});
test("キーボードでヘルプとビューを操作できる", async () => {
  const root = mkdtempSync(join(tmpdir(), "raprid-tui-"));
  initialize(root, "test/repo");
  add(root, "最初のIssue", "本文");
  const view = render(createElement(WorkspaceApp, { root }));
  try {
    await wait();
    view.stdin.write("?");
    await wait();
    assert.match(view.lastFrame() ?? "", /操作ヘルプ/);
    view.stdin.write("\x1b");
    await wait();
    view.stdin.write("w");
    await wait();
    assert.match(view.lastFrame() ?? "", /Wiki/);
  } finally {
    view.unmount();
    cleanup();
  }
});
