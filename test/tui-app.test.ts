import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, render } from "ink-testing-library";
import { createElement } from "react";
import { FakeBackend, load, qa, snapshot, task, tick } from "./tui-fixtures.ts";
import type { Snapshot } from "../src/tui/types.js";

const { App } = await load<typeof import("../src/tui/app.js")>("../dist/tui/app.js");
const { SnapshotStore, DetailStore } = await load<typeof import("../src/tui/stores.js")>("../dist/tui/stores.js");
const { BackendError } = await load<typeof import("../src/tui/backend.js")>("../dist/tui/backend.js");
const { width } = await load<typeof import("../src/tui/text.js")>("../dist/tui/text.js");

const keys = { up: "\u001b[A", down: "\u001b[B", enter: "\r", escape: "\u001b", tab: "\t", shiftTab: "\u001b[Z", pageDown: "\u001b[6~" };

afterEach(() => cleanup());

const longTitle = "日本語と絵文字👨‍👩‍👧‍👦と結合文字éを含み、パネルの幅を大きく超えるとても長いタイトルを省略して表示する確認";
const base = snapshot({
  tasks: [
    task("T-001", { status: "progress", title: longTitle }),
    task("T-002", { status: "pending", blockedBy: ["qa/Q-001"], requestedBy: null }),
    task("T-003", { status: "done", title: "終わった作業" }),
    task("T-001", { job: "other", name: "other-task", title: "別案件の作業" }),
  ],
  qas: [qa("Q-001", { question: "方針はこれでよいか" })],
  issues: [{ code: "ID_DUPLICATE", severity: "error", job: "PROJ-1", kind: "task", id: "T-009", path: "jobs/PROJ-1/tasks/x/index.md", message: "ID重複: T-009 (x, y)" }],
});

function mount(options: { data?: Snapshot; columns?: number; rows?: number; job?: string | null } = {}) {
  const data = options.data ?? base;
  const backend = new FakeBackend(data);
  const snapshots = new SnapshotStore(backend, { intervalMs: 60_000 });
  const details = new DetailStore(backend, { debounceMs: 5 });
  snapshots.seed(data);
  let unmounted = 0;
  const props = { snapshots, details, initialJob: options.job ?? null, projectName: "sample", columns: options.columns ?? 100, rows: options.rows ?? 20, onUnmount: () => unmounted++ };
  const view = render(createElement(App, props));
  const frame = () => view.lastFrame() ?? "";
  const press = async (...inputs: string[]) => {
    for (const input of inputs) {
      view.stdin.write(input);
      // ESC の直後に文字が続くと Alt+文字 と解釈されるため、実際の打鍵と同じく間を空ける
      await tick(input === keys.escape ? 80 : 15);
    }
    await tick(20);
  };
  return { ...view, backend, snapshots, details, frame, press, props, unmounted: () => unmounted };
}

test("80〜119 桁では一覧と詳細を並べ、上部に件数、下部にキー案内を出す", async () => {
  const app = mount({ rows: 30 });
  await tick(60);
  const frame = app.frame();
  const lines = frame.split("\n");
  assert.match(lines[0], /^raprid tui  sample  案件: 全案件  未解決QA 1  更新 \d\d:\d\d:\d\d/);
  assert.match(frame, /▶ \[1 task 3\]  2 QA 1   3 要確認 1/);
  assert.match(frame, /> T-001 progress 日本語と絵文字/);
  assert.match(frame, /T-002 pending  タスク T-002  待ち: qa\/Q-…║/, "待ち理由はパネルの幅で省略する");
  assert.doesNotMatch(frame, /T-003/, "done は既定で隠す");
  assert.match(frame, /詳細/);
  assert.match(frame, /t-001 の本文/, "選択した項目の本文を show で取得して出す");
  assert.match(lines.at(-1)!, /↑↓ 移動  Tab パネル  1-3 種類/);
  for (const line of lines) assert.ok(width(line) <= 100, `幅を超えない: ${line}`);
  assert.equal(lines.length, 30);
});

test("選択・パネル移動・種類の切替・詳細のスクロール", async () => {
  const app = mount();
  await tick(40);
  await app.press(keys.down);
  assert.match(app.frame(), /> T-002 pending/);
  assert.match(app.frame(), /依頼    不明（旧記録）/);
  await app.press(keys.tab);
  assert.match(app.frame(), /║▶ 詳細/, "フォーカスは枠と印で示す");
  await app.press(keys.pageDown);
  assert.doesNotMatch(app.frame(), /T-002  pending\n/, "詳細をページ送りできる");
  await app.press(keys.shiftTab, "2");
  assert.match(app.frame(), /\[2 QA 1\]/);
  assert.match(app.frame(), /> Q-001 unresolved customer  質問 Q-001/);
  await app.press("3");
  assert.match(app.frame(), /> E T-009  ID重複: T-009 \(x, y\)/);
  assert.match(app.frame(), /エラー  ID_DUPLICATE/);
  await app.press("1");
  assert.match(app.frame(), /> T-002 pending/, "種類ごとに選択を保つ");
});

test("検索・状態フィルター・全件表示・案件の選択", async () => {
  const app = mount();
  await tick(40);
  await app.press("/", "別案件");
  assert.match(app.frame(), /\/別案件▏/);
  assert.match(app.frame(), /\[1 task 1\]/);
  assert.match(app.frame(), /> T-001 todo 別案件の作業/);
  await app.press(keys.enter);
  assert.match(app.frame(), /検索: 別案件/);
  await app.press("/", keys.escape);
  assert.match(app.frame(), /検索: 別案件/, "Esc は入力前の検索に戻す");
  await app.press("/", "\u007f\u007f\u007f", keys.enter);
  assert.match(app.frame(), /\[1 task 3\]/);

  await app.press("v");
  assert.match(app.frame(), /\[1 task 4\]/);
  assert.match(app.frame(), /T-003 done/);
  await app.press("v", "f");
  assert.match(app.frame(), /task の状態/);
  assert.match(app.frame(), /> \[x\] progress/);
  await app.press(" ", keys.down, keys.down, " ", keys.enter); // progress と pending を外す
  assert.match(app.frame(), /状態: todo/);
  assert.match(app.frame(), /\[1 task 1\]/);

  await app.press("f", keys.down, " ", keys.enter); // todo を外すと空 → 既定に戻す
  assert.match(app.frame(), /未完了のみ/);
  await app.press("g");
  assert.match(app.frame(), /案件を選択/);
  assert.match(app.frame(), /> 全案件/);
  await app.press(keys.down, keys.down, keys.enter);
  assert.match(app.frame(), /案件: other/);
  assert.match(app.frame(), /\[1 task 1\]/);
  assert.match(app.frame(), /未解決QA 0/);
});

test("空の一覧・取得失敗・入力中の文字", async () => {
  const empty = mount({ data: snapshot({ jobs: ["PROJ-1"] }) });
  await tick(40);
  assert.match(empty.frame(), /該当する項目がありません/);
  assert.match(empty.frame(), /項目がありません/);
  empty.snapshots.refresh();
  await tick(10);
  empty.backend.snapshotCalls[0].reject(new BackendError("FAILED", "JSON を読めませんでした"));
  await tick(40);
  assert.match(empty.frame(), /更新失敗 \d\d:\d\d:\d\d: JSON を読めませんでした/);
  assert.match(empty.frame(), /該当する項目がありません/, "失敗しても前回の表示を保つ");
  await empty.press("/", "q");
  assert.equal(empty.unmounted(), 0, "入力中の q は終了にしない");
  assert.match(empty.frame(), /\/q▏/);
});

test("取得中も入力を受け付け、選択は job/kind/id で保つ", async () => {
  const app = mount();
  await tick(40);
  await app.press(keys.down);
  app.snapshots.refresh();
  await app.press(keys.up, keys.down);
  assert.match(app.frame(), /> T-002 pending/, "取得の完了を待たずに操作できる");
  const reordered = snapshot({ tasks: [task("T-000", { status: "progress", name: "new" }), ...base.tasks], qas: base.qas, issues: base.issues });
  app.backend.current = reordered;
  app.backend.snapshotCalls[0].resolve(reordered);
  await tick(60);
  assert.match(app.frame(), /> T-002 pending/, "前に項目が増えても同じ項目を選んだまま");
  app.snapshots.refresh();
  const removed = snapshot({ tasks: reordered.tasks.filter((record) => record.id !== "T-002"), qas: base.qas, issues: base.issues });
  app.backend.snapshotCalls[1].resolve(removed);
  await tick(60);
  assert.match(app.frame(), /選択していた項目が無くなったため、近くの項目を選択しました/);
});

test("幅 120 以上は案件・一覧・詳細、40〜79 は一覧だけで Enter/Esc で詳細と往復、小さすぎる端末は案内", async () => {
  const wide = mount({ columns: 130, rows: 20 });
  await tick(40);
  assert.match(wide.frame(), /> 全案件 +4/);
  assert.match(wide.frame(), /  PROJ-1 +3/);
  await wide.press(keys.shiftTab);
  assert.match(wide.frame(), /▶ 案件/);
  await wide.press(keys.down, keys.down);
  assert.match(wide.frame(), /案件: other/);
  for (const line of wide.frame().split("\n")) assert.ok(width(line) <= 130, line);

  const narrow = mount({ columns: 60, rows: 16 });
  await tick(40);
  assert.doesNotMatch(narrow.frame(), /[│║][ ▶] 詳細/, "詳細パネルを出さない");
  await narrow.press(keys.enter);
  assert.match(narrow.frame(), /▶ 詳細/);
  assert.match(narrow.frame(), /Esc 一覧へ/);
  await narrow.press(keys.escape);
  assert.match(narrow.frame(), /▶ \[1 task 3\]/);
  for (const line of narrow.frame().split("\n")) assert.ok(width(line) <= 60, line);

  const small = mount({ columns: 39, rows: 16 });
  await tick(20);
  assert.match(small.frame().replace(/\n/g, ""), /端末が小さすぎます \(39x16\)。40x12 ?以上に広げてください。q で終了します。/);
  await small.press(keys.down);
  small.rerender(createElement(App, { ...small.props, columns: 100, rows: 20 }));
  await tick(40);
  assert.match(small.frame(), /> T-001 progress/, "広げると元の選択のまま戻る");
});

test("ヘルプ・終了と、閉じるときに取得を止める", async () => {
  const app = mount();
  await tick(40);
  await app.press("?");
  assert.match(app.frame(), /q \/ Ctrl\+C +終了/);
  await app.press(keys.escape, "q");
  await tick(40);
  assert.equal(app.unmounted(), 1, "q で終了し、onUnmount で子プロセスを止める");
});

test("1,000 件でも選択の移動は描画まで 100ms 以内 (目安)", async () => {
  const tasks = Array.from({ length: 1000 }, (_, index) => task(`T-${String(index + 1).padStart(4, "0")}`, { status: ["progress", "todo", "pending"][index % 3], title: `日本語のタイトル ${index + 1}` }));
  const app = mount({ data: snapshot({ tasks }), rows: 40 });
  await tick(100);
  const timings: number[] = [];
  for (let i = 0; i < 30; i++) {
    const before = app.frames.length;
    const started = performance.now();
    app.stdin.write(keys.down);
    while (app.frames.length === before && performance.now() - started < 1000) await new Promise((resolve) => setImmediate(resolve));
    timings.push(performance.now() - started);
  }
  timings.sort((a, b) => a - b);
  const median = timings[Math.floor(timings.length / 2)];
  const worst = timings.at(-1)!;
  console.log(`1,000 件の選択移動: 中央値 ${median.toFixed(1)}ms / 最大 ${worst.toFixed(1)}ms`);
  assert.ok(median < 100, `中央値 ${median}ms`);
  await tick(50);
  assert.match(app.frame(), /> T-0031/);
});
