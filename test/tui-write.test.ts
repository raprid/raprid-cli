import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, render } from "ink-testing-library";
import { createElement } from "react";
import { FakeBackend, load, qa, snapshot, task, tick } from "./tui-fixtures.ts";
import type { Snapshot } from "../src/tui/types.js";

const { App } = await load<typeof import("../src/tui/app.js")>("../dist/tui/app.js");
const { SnapshotStore, DetailStore } = await load<typeof import("../src/tui/stores.js")>("../dist/tui/stores.js");
const { BackendError } = await load<typeof import("../src/tui/backend.js")>("../dist/tui/backend.js");

const keys = { down: "\u001b[B", up: "\u001b[A", enter: "\r", escape: "\u001b", tab: "\t" };
const paste = (text: string) => `\u001b[200~${text}\u001b[201~`;

afterEach(() => cleanup());

const base = snapshot({
  tasks: [task("T-001", { status: "pending", blockedBy: ["qa/Q-001"], name: "impl", title: "実装する" }), task("T-002", { status: "todo" })],
  qas: [qa("Q-001", { name: "policy", question: "方針はこれでよいか" })],
});

function mount(options: { data?: Snapshot; actor?: string | null; writable?: boolean } = {}) {
  const data = options.data ?? base;
  const backend = new FakeBackend(data);
  const snapshots = new SnapshotStore(backend, { intervalMs: 60_000 });
  const details = new DetailStore(backend, { debounceMs: 5 });
  snapshots.seed(data);
  let unmounted = 0;
  const props = {
    snapshots,
    details,
    initialJob: null,
    projectName: "sample",
    columns: 100,
    rows: 30,
    onUnmount: () => unmounted++,
    writer: options.writable === false ? undefined : backend,
    actor: options.actor === undefined ? "human/saiki" : options.actor,
  };
  const view = render(createElement(App, props));
  const frame = () => view.lastFrame() ?? "";
  const press = async (...inputs: string[]) => {
    for (const input of inputs) {
      view.stdin.write(input);
      await tick(input === keys.escape ? 80 : 15);
    }
    await tick(20);
  };
  return { ...view, backend, snapshots, frame, press, unmounted: () => unmounted };
}

const written = (resolved: Snapshot) => ({ schemaVersion: 1 as const, ok: true as const, item: resolved.qas[0], issues: [] });

test("QA に複数行で回答し、確認画面を経て保存し、待っていたタスクを示す (自動では再開しない)", async () => {
  const app = mount();
  await tick(40);
  await app.press("2", "a");
  assert.match(app.frame(), /Q-001 への回答  案件 PROJ-1  回答者 human\/saiki/);
  assert.match(app.frame(), /質問: 方針はこれでよいか/);
  await app.press("日本語で", keys.enter, "q と a と m も文字", keys.enter, paste("## 見出し\r\n\r\n```sh\n## コード\n```"));
  assert.match(app.frame(), /q と a と m も文字/);
  assert.match(app.frame(), /## 見出し/);
  assert.match(app.frame(), /7 行 \/ \d+ バイト/);
  await app.press(keys.tab, keys.enter);
  assert.match(app.frame(), /この内容で回答を保存しますか？/);
  assert.match(app.frame(), /回答者  human\/saiki/);
  assert.match(app.frame(), /回答内容 \(7 行\):/);
  assert.equal(app.backend.writeCalls.length, 0, "確認するまで保存しない");
  await app.press(keys.enter);
  assert.match(app.frame(), /Q-001 に回答しています…/);
  assert.equal(app.backend.writeCalls.length, 1);
  assert.deepEqual(app.backend.writeCalls[0].args, ["resolveQa", "PROJ-1", "policy", "日本語で\nq と a と m も文字\n## 見出し\n\n```sh\n## コード\n```", "human/saiki", "rev-policy"]);

  await app.press("q", keys.enter, "a");
  assert.equal(app.unmounted(), 0, "保存中は終了しない");
  assert.equal(app.backend.writeCalls.length, 1, "保存中は多重実行しない");
  assert.match(app.frame(), /終了の要求を受け付けました/);
  const resolved = snapshot({ tasks: base.tasks, qas: [{ ...base.qas[0], status: "resolved", answer: "日本語で", answeredBy: "human/saiki" }] });
  app.backend.writeCalls[0].reply.resolve(written(resolved));
  await tick(80);
  assert.equal(app.unmounted(), 1, "保存が終わってから終了する");
});

test("回答後に待っていたタスクを示し、選ぶと一覧へ移る", async () => {
  const app = mount();
  await tick(40);
  await app.press("2", "a", "進めてよい", keys.tab, keys.enter, keys.enter);
  app.backend.writeCalls[0].reply.resolve(written(base));
  await tick(60);
  assert.match(app.frame(), /Q-001 を待っていたタスク \(自動では再開しません\)/);
  assert.match(app.frame(), /> T-001  PROJ-1  実装する/);
  assert.match(app.frame(), /Q-001 に回答しました \(回答者 human\/saiki\)/);
  await app.press(keys.enter);
  assert.match(app.frame(), /\[1 task/);
  assert.match(app.frame(), /> T-001 pending/);
  assert.match(app.frame(), /m で状態を変更してください/);
});

test("入力中の下書きはバックグラウンドの更新で置き換えない。競合したら保存せず最新の内容と下書きを示す", async () => {
  const app = mount();
  await tick(40);
  await app.press("2", "a", "私の下書き");
  app.snapshots.refresh();
  await tick(10);
  const other = snapshot({ tasks: base.tasks, qas: [{ ...base.qas[0], status: "resolved", answer: "他の人の回答", answeredBy: "human/other", revision: "rev-other" }] });
  app.backend.current = other;
  app.backend.snapshotCalls[0].resolve(other);
  await tick(60);
  assert.match(app.frame(), /私の下書き/, "更新の後も下書きを残す");
  await app.press(keys.tab, keys.enter, keys.enter);
  app.backend.writeCalls[0].reply.reject(new BackendError("REVISION_CONFLICT", "競合"));
  await tick(80);
  const frame = app.frame();
  assert.match(frame, /他の変更と競合したため保存しませんでした/);
  assert.match(frame, /最新の状態: resolved/);
  assert.match(frame, /回答者: human\/other/);
  assert.match(frame, /他の人の回答/);
  assert.match(frame, /私の下書き/, "下書きを残す");
  assert.equal(app.backend.writeCalls.length, 1, "自動で再送しない");
  await app.press(keys.tab, keys.enter, keys.enter);
  assert.equal(app.backend.writeCalls.length, 2);
  assert.equal(app.backend.writeCalls[1].args.at(-1), "rev-other", "確認して保存し直すときは最新の revision を使う");
});

test("結果が分からない失敗は読み直して確かめ、保存できていれば成功として扱う", async () => {
  const app = mount();
  await tick(40);
  await app.press("2", "a", "確かめる回答", keys.tab, keys.enter, keys.enter);
  app.backend.current = snapshot({ tasks: base.tasks, qas: [{ ...base.qas[0], status: "resolved", answer: "確かめる回答", answeredBy: "human/saiki", revision: "rev-saved" }] });
  app.backend.writeCalls[0].reply.reject(new BackendError("INVALID_RESPONSE", "JSON を読めませんでした"));
  await tick(80);
  assert.match(app.frame(), /再取得して保存を確かめました/);
  assert.equal(app.backend.writeCalls.length, 1);
});

test("タスクの状態変更: 遷移先と待ち理由を確かめてから保存する", async () => {
  const app = mount();
  await tick(40);
  await app.press(keys.down, "m");
  assert.match(app.frame(), /T-002 の状態を変更  \(現在: todo\)  操作者 human\/saiki/);
  await app.press(keys.down, keys.enter, "other: 権限の付与, 予算", keys.enter, paste("qa/Q-001\ntask/T-001"));
  assert.match(app.frame(), /3 件/);
  await app.press(keys.tab, keys.enter);
  assert.match(app.frame(), /変更  todo → pending/);
  assert.match(app.frame(), /待ち: +║\n║  other: 権限の付与, 予算 +║\n║  qa\/Q-001 +║\n║  task\/T-001 /);
  await app.press(keys.enter);
  assert.deepEqual(app.backend.writeCalls[0].args, ["moveTask", "PROJ-1", "t-002", "pending", ["other: 権限の付与, 予算", "qa/Q-001", "task/T-001"], "rev-t-002"]);
  app.backend.writeCalls[0].reply.reject(new BackendError("BLOCKED_BY_QA", "待っているQAが解決していないため pending を解除できません"));
  await tick(60);
  assert.match(app.frame(), /保存できませんでした: 待っているQAが解決していない/);
});

test("回答者が未指定なら最初の更新で入力させ、更新に対応しない scripts/ では a・m を使わせない", async () => {
  const app = mount({ actor: null });
  await tick(40);
  assert.doesNotMatch(app.frame(), /更新者/);
  await app.press("2", "a");
  assert.match(app.frame(), /更新する人を human\/<識別子> で入力してください/);
  await app.press("human/tester", keys.enter);
  assert.match(app.frame(), /Q-001 への回答  案件 PROJ-1  回答者 human\/tester/);
  await app.press(keys.escape);
  assert.match(app.frame(), /更新者 human\/tester/, "セッション中は保つ");

  const readonly = mount({ writable: false });
  await tick(40);
  assert.match(readonly.frame(), /閲覧のみ/);
  await readonly.press("2", "a");
  assert.match(readonly.frame(), /更新操作 \(guarded-write-v1\) に対応していません/);
  assert.doesNotMatch(readonly.frame(), /への回答/);
});
