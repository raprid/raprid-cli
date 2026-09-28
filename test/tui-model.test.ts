import assert from "node:assert/strict";
import { test } from "node:test";
import { load, qa, snapshot, task } from "./tui-fixtures.ts";

const model = await load<typeof import("../src/tui/model.js")>("../dist/tui/model.js");
const text = await load<typeof import("../src/tui/text.js")>("../dist/tui/text.js");
const { handleKey, initialState, layoutFor, reconcile, rowsFor, selectedIndex } = model;

const data = snapshot({
  tasks: [
    task("T-001", { status: "progress", title: "API を用意する" }),
    task("T-002", { status: "todo" }),
    task("T-003", { status: "pending", blockedBy: ["qa/Q-001"] }),
    task("T-004", { status: "done", title: "終わった作業" }),
    task("T-005", { status: "doing", name: "weird" }),
    task("T-001", { job: "other", name: "same-id" }),
  ],
  qas: [qa("Q-001"), qa("Q-002", { status: "resolved" }), qa("Q-001", { job: "other" })],
  issues: [{ code: "LINK_ORPHAN", severity: "warning", job: "PROJ-1", kind: "task", id: null, path: "jobs/PROJ-1/status/done/x", message: "実体のない索引: jobs/PROJ-1/status/done/x" }],
});

function context(state: ReturnType<typeof initialState>, layout: ReturnType<typeof layoutFor> = "medium") {
  return { rows: rowsFor(data, state), jobs: data.jobs.map((job) => job.name), layout, detailHeight: 5, detailLength: 20 };
}

function press(state: ReturnType<typeof initialState>, input: string, key: Record<string, boolean> = {}, layout: ReturnType<typeof layoutFor> = "medium") {
  return handleKey(state, input, key, context(state, layout));
}

test("端末の大きさで配置を決める", () => {
  assert.equal(layoutFor(120, 30), "wide");
  assert.equal(layoutFor(119, 30), "medium");
  assert.equal(layoutFor(80, 12), "medium");
  assert.equal(layoutFor(79, 30), "narrow");
  assert.equal(layoutFor(40, 12), "narrow");
  assert.equal(layoutFor(39, 30), "tooSmall");
  assert.equal(layoutFor(100, 11), "tooSmall");
});

test("既定で done/resolved を隠し、未知の状態は表示する。v・f・案件・検索で絞り込む", () => {
  let state = initialState();
  assert.deepEqual(rowsFor(data, state).map((row) => `${row.record!.job}/${row.record!.id}`), ["PROJ-1/T-001", "PROJ-1/T-002", "PROJ-1/T-003", "PROJ-1/T-005", "other/T-001"]);
  state = press(state, "v").state;
  assert.equal(rowsFor(data, state).length, 6);
  state = { ...initialState(), job: "PROJ-1", filters: { task: ["done"], qa: null } };
  assert.deepEqual(rowsFor(data, state).map((row) => row.record!.id), ["T-004", "T-005"], "未知の状態は絞り込みでも隠さない");
  state = { ...initialState(), search: "api" };
  assert.deepEqual(rowsFor(data, state).map((row) => row.record!.id), ["T-001"]);
  state = { ...initialState(), tab: "qa" };
  assert.deepEqual(rowsFor(data, state).map((row) => `${row.record!.job}/${row.record!.id}`), ["PROJ-1/Q-001", "other/Q-001"]);
  state = { ...initialState(), tab: "issues", job: "other" };
  assert.equal(rowsFor(data, state).length, 0);
  assert.equal(model.unresolvedCount(data, null), 2);
  assert.equal(model.unresolvedCount(data, "PROJ-1"), 1, "未解決 QA は対象の案件の範囲で数える");
});

test("案件と種類と ID で識別し、別案件の同じ ID を混同しない", () => {
  const rows = rowsFor(data, initialState());
  const keys = rows.map((row) => row.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes("PROJ-1\u0000task\u0000T-001") && keys.includes("other\u0000task\u0000T-001"));
  const duplicated = snapshot({ tasks: [task("T-009", { name: "a" }), task("T-009", { name: "b" })] });
  assert.deepEqual(rowsFor(duplicated, initialState()).map((row) => row.key), ["path\u0000jobs/PROJ-1/tasks/a/index.md", "path\u0000jobs/PROJ-1/tasks/b/index.md"], "重複した ID は path で識別する");
});

test("キー操作: 移動・パネル・種類・詳細・戻る・終了", () => {
  let state = reconcile(initialState(), rowsFor(data, initialState()), data);
  assert.equal(state.selection.task.key, "PROJ-1\u0000task\u0000T-001");
  state = press(state, "", { downArrow: true }).state;
  state = press(state, "", { downArrow: true }).state;
  assert.equal(selectedIndex(state, rowsFor(data, state)), 2);
  state = press(state, "", { end: true }).state;
  assert.equal(selectedIndex(state, rowsFor(data, state)), 4);
  state = press(state, "", { downArrow: true }).state;
  assert.equal(selectedIndex(state, rowsFor(data, state)), 4, "末尾で止まる");
  assert.equal(press(state, "", { tab: true }).state.focus, "detail");
  assert.equal(press(state, "", { tab: true, shift: true }, "wide").state.focus, "jobs");
  assert.equal(press(state, "", { tab: true }, "narrow").state.focus, "list", "狭い端末では Tab で移動しない");
  state = press(state, "2").state;
  assert.equal(state.tab, "qa");
  state = press(state, "1").state;
  assert.equal(selectedIndex(state, rowsFor(data, state)), 4, "種類ごとに選択を保つ");

  const narrow = press(state, "", { return: true }, "narrow").state;
  assert.equal(narrow.narrowDetail, true);
  assert.equal(narrow.focus, "detail");
  assert.equal(press(narrow, "", { escape: true }, "narrow").state.narrowDetail, false);
  const scrolledDown = press({ ...state, focus: "detail" }, "", { pageDown: true }).state;
  assert.equal(scrolledDown.detailScroll, 4);
  assert.equal(press(scrolledDown, "", { pageDown: true }).state.detailScroll, 8);
  assert.equal(press({ ...scrolledDown, detailScroll: 15 }, "", { downArrow: true }).state.detailScroll, 15, "最後の行を超えない");

  assert.deepEqual(press(state, "q").effects, ["exit"]);
  assert.deepEqual(press(state, "c", { ctrl: true }).effects, ["exit"]);
  assert.deepEqual(press(state, "r").effects, ["refresh"]);
  assert.deepEqual(press(state, "a").state, state, "a と m は T-010 用に予約し、閲覧では何もしない");
  assert.deepEqual(press(state, "m").state, state);
});

test("入力中は文字をショートカットとして扱わず、Esc で元に戻す", () => {
  let state = press(initialState(), "/").state;
  assert.equal(state.mode.kind, "search");
  for (const input of ["q", "g", "v", "日本"]) {
    const result = press(state, input);
    assert.deepEqual(result.effects, []);
    state = result.state;
  }
  assert.equal(state.search, "qgv日本");
  state = press(state, "", { backspace: true }).state;
  assert.equal(state.search, "qgv日", "grapheme 単位で消す");
  assert.equal(press(state, "c", { ctrl: true }).effects[0], "exit", "Ctrl+C は入力中も終了できる");
  const cancelled = press(state, "", { escape: true }).state;
  assert.equal(cancelled.search, "");
  assert.equal(cancelled.mode.kind, "normal");
  const committed = press(state, "", { return: true }).state;
  assert.equal(committed.search, "qgv日");
  assert.equal(press(state, "\u001b[31mx\u0007").state.search, "qgv日x", "制御文字は入れない");
});

test("案件選択・状態フィルター・ヘルプの画面", () => {
  let state = press(initialState(), "g").state;
  assert.deepEqual(state.mode, { kind: "jobPicker", index: 0 });
  state = press(state, "", { downArrow: true }).state;
  state = press(state, "", { return: true }).state;
  assert.equal(state.job, "PROJ-1");
  assert.equal(press(state, "g").state.mode.kind === "jobPicker" && (press(state, "g").state.mode as { index: number }).index, 1);

  state = press(state, "f").state;
  assert.deepEqual(state.mode, { kind: "filter", index: 0, draft: ["progress", "todo", "pending"] });
  state = press(state, " ").state; // progress を外す
  state = press(press(press(state, "", { downArrow: true }).state, "", { downArrow: true }).state, "", { downArrow: true }).state;
  state = press(state, " ").state; // done を入れる
  state = press(state, "", { return: true }).state;
  assert.deepEqual(state.filters.task, ["todo", "pending", "done"]);
  assert.deepEqual(rowsFor(data, state).map((row) => row.record!.id), ["T-002", "T-003", "T-004", "T-005"]);
  assert.equal(press({ ...state, tab: "issues" }, "f").state.mode.kind, "normal");

  state = press(state, "?").state;
  assert.equal(state.mode.kind, "help");
  assert.deepEqual(press(state, "q").effects, [], "ヘルプの q は閉じるだけ");
  assert.equal(press(state, "", { escape: true }).state.mode.kind, "normal");
});

test("小さすぎる端末では q だけを受け付け、状態を変えない", () => {
  const state = { ...initialState(), search: "x", tab: "qa" as const };
  assert.deepEqual(press(state, "", { downArrow: true }, "tooSmall").state, state);
  assert.deepEqual(press(state, "2", {}, "tooSmall").state, state);
  assert.deepEqual(press(state, "q", {}, "tooSmall").effects, ["exit"]);
});

test("選択が消えたら近くへ移し、snapshot から消えたときだけ知らせる", () => {
  let state = reconcile(initialState(), rowsFor(data, initialState()), data);
  state = press(press(state, "", { downArrow: true }).state, "", { downArrow: true }).state; // T-003
  const removed = snapshot({ qas: data.qas, issues: data.issues, tasks: data.tasks.filter((record) => record.id !== "T-003" || record.job !== "PROJ-1") });
  const moved = reconcile(state, rowsFor(removed, state), removed);
  assert.equal(moved.selection.task.key, "PROJ-1\u0000task\u0000T-005");
  assert.match(moved.notice ?? "", /無くなった/);
  const filtered = { ...state, search: "API" };
  const kept = reconcile(filtered, rowsFor(data, filtered), data);
  assert.equal(kept.selection.task.key, "PROJ-1\u0000task\u0000T-001");
  assert.equal(kept.notice, undefined, "絞り込みで隠れただけなら知らせない");
});

test("詳細は本文を平文にし、診断と actor 欠落を示す", () => {
  const record = task("T-010", { requestedBy: null, title: "\u001b[31m赤\u001b[0m" });
  const view = snapshot({ tasks: [record], issues: [{ code: "LINK_MISSING", severity: "warning", job: "PROJ-1", kind: "task", id: "T-010", path: record.path, message: "索引なし: t-010" }] });
  const row = rowsFor(view, initialState())[0];
  const loading = model.detailLines(row, { target: undefined, result: undefined, current: false, loading: true, error: undefined }, view).map((line) => line.text);
  assert.ok(loading.includes("赤"), "タイトルの制御文字を除く");
  assert.ok(loading.includes("依頼    不明（旧記録）"));
  assert.ok(loading.includes("  索引なし: t-010"));
  assert.ok(loading.includes("読み込み中…"));
  const lines = text.markdownLines("# 見出し\n\n- [リンク](http://x) と **強調** と `code`\n\n```sh\n## コード\n```\n");
  assert.deepEqual(lines.map((line) => line.text), ["見出し", "", "- リンク <http://x> と 強調 と code", "", "```sh", "## コード", "```"]);
  assert.equal(lines[0].bold, true);
  assert.equal(lines[5].dim, true, "コードブロックの中は見出しにしない");
  assert.deepEqual(text.wrap("👨‍👩‍👧‍👦👨‍👩‍👧‍👦あい", 4), ["👨‍👩‍👧‍👦👨‍👩‍👧‍👦", "あい"]);
});
