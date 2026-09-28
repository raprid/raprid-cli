import assert from "node:assert/strict";
import { test } from "node:test";
import { load, qa, snapshot, task } from "./tui-fixtures.ts";
import type { UiState } from "../src/tui/model.js";

const editor = await load<typeof import("../src/tui/editor.js")>("../dist/tui/editor.js");
const model = await load<typeof import("../src/tui/model.js")>("../dist/tui/model.js");
const actions = await load<typeof import("../src/tui/actions.js")>("../dist/tui/actions.js");

const data = snapshot({
  tasks: [
    task("T-001", { status: "pending", blockedBy: ["qa/Q-001"] }),
    task("T-002", { status: "pending", blockedBy: ["qa/PROJ-1/Q-001", "other: 承認"] }),
    task("T-001", { job: "other", name: "remote", status: "pending", blockedBy: ["qa/PROJ-1/policy"] }),
    task("T-003", { status: "todo" }),
    task("T-004", { status: "pending", blockedBy: ["qa/Q-002", "task/T-003"] }),
  ],
  qas: [qa("Q-001", { name: "policy" }), qa("Q-002", { name: "done-qa", status: "resolved" })],
});

function base(overrides: Partial<UiState> = {}): UiState {
  return { ...model.initialState(null, { actor: "human/saiki", writable: true }), ...overrides };
}

function context(state: UiState) {
  const rows = model.rowsFor(data, state);
  return { rows, selected: rows[model.selectedIndex(state, rows)], snapshot: data, jobs: ["PROJ-1", "other"], layout: "medium" as const, detailHeight: 5, detailLength: 5 };
}

function press(state: UiState, input: string, key: Record<string, boolean> = {}) {
  return model.handleKey(state, input, key, context(state));
}

function typeAll(state: UiState, ...inputs: (string | Record<string, boolean>)[]) {
  let current = state;
  const effects: unknown[] = [];
  for (const input of inputs) {
    const result = typeof input === "string" ? press(current, input) : press(current, "", input);
    current = result.state;
    effects.push(...result.effects);
  }
  return { state: current, effects };
}

test("入力欄: 日本語・絵文字・結合文字を grapheme 単位で扱い、改行・移動・削除ができる", () => {
  let state = editor.insertText(editor.emptyEditor, "日本語👨‍👩‍👧é");
  assert.deepEqual(state, { lines: ["日本語👨‍👩‍👧é"], row: 0, col: 5 });
  state = editor.backspace(state);
  assert.equal(editor.editorText(state), "日本語👨‍👩‍👧", "結合文字をまとめて消す");
  state = editor.backspace(state);
  assert.equal(editor.editorText(state), "日本語", "ZWJ の絵文字をまとめて消す");
  state = editor.moveCursor(editor.moveCursor(state, "left"), "left");
  state = editor.newline(state);
  assert.deepEqual(state.lines, ["日", "本語"]);
  state = editor.backspace(state);
  assert.deepEqual(state, { lines: ["日本語"], row: 0, col: 1 }, "行頭の削除で前の行とつなぐ");
  state = editor.insertText(state, "1\r\n2\r3\n");
  assert.deepEqual(state.lines, ["日1", "2", "3", "本語"], "貼り付けの改行は LF にそろえる");
  assert.equal(editor.editorText(editor.insertText(editor.emptyEditor, "a\u001b[31mb\u0007\tc")), "ab  c", "制御文字・エスケープは入れない");
  const rows = editor.layoutEditor({ lines: ["あいうえおかきくけこ", "x"], row: 0, col: 7 }, 8, 2);
  // 幅 8 はカーソル分の 1 セルを残して 3 文字ずつ折り返し、カーソルのある行が見える 2 行を返す
  assert.deepEqual(rows.map((row) => `${row.before}[${row.cursor ?? ""}]${row.after}`), ["えおか[]", "き[く]け"]);
});

test("a・m は対象と状態を確かめ、回答者が無ければ先に human/<識別子> を入力させる", () => {
  assert.match(press(base(), "a").state.notice ?? "", /QA の一覧 \(2\)/);
  const qaTab = base({ tab: "qa" });
  assert.equal(press(qaTab, "a").state.mode.kind, "answer");
  assert.match(press(base({ tab: "qa", showAll: true, selection: { ...qaTab.selection, qa: { key: "PROJ-1\u0000qa\u0000Q-002", index: 1 } } }), "a").state.notice ?? "", /unresolved の QA/);
  assert.match(press(base({ tab: "qa", writable: false }), "a").state.notice ?? "", /guarded-write-v1/);

  let state = typeAll(base({ tab: "qa", actor: null }), "a").state;
  assert.deepEqual(state.mode, { kind: "actor", draft: "", error: undefined, then: "answer" });
  state = typeAll(state, "saiki", { return: true }).state;
  assert.match((state.mode as { error?: string }).error ?? "", /human\/<識別子>/, "human/ で始まらない名前は受け付けない");
  state = typeAll(state, { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true }, { backspace: true }, "human/saiki", { return: true }).state;
  assert.equal(state.actor, "human/saiki");
  assert.equal(state.mode.kind, "answer");
});

test("回答欄: q・a・m は文字、Enter は改行、Tab でボタン、空の保存は拒否、確認してから保存する", () => {
  let result = typeAll(base({ tab: "qa" }), "a", "q", "a", "m", { return: true }, "二行目");
  let mode = result.state.mode as import("../src/tui/model.js").AnswerForm;
  assert.equal(editor.editorText(mode.editor), "qam\n二行目");
  assert.deepEqual(result.effects, [], "入力中の文字で終了・操作しない");

  const blank = typeAll(base({ tab: "qa" }), "a", { tab: true }, { return: true });
  assert.equal((blank.state.mode as { error?: string }).error, "回答が空です");

  result = typeAll(result.state, { tab: true });
  assert.equal((result.state.mode as { focus: string }).focus, "save");
  result = typeAll(result.state, { return: true });
  assert.equal(result.state.mode.kind, "answerConfirm", "保存の前に確認する");
  const back = typeAll(result.state, { escape: true });
  assert.equal(editor.editorText((back.state.mode as import("../src/tui/model.js").AnswerForm).editor), "qam\n二行目", "確認から戻っても入力を保つ");
  result = typeAll(result.state, { return: true });
  assert.equal(result.state.mode.kind, "saving");
  assert.deepEqual(result.effects, [
    { kind: "write", request: { type: "answer", target: (result.state.mode as { request: { target: unknown } }).request.target, answer: "qam\n二行目", actor: "human/saiki" } },
  ]);
  mode = (result.state.mode as { resume: import("../src/tui/model.js").AnswerForm }).resume;
  assert.equal(mode.target.revision, "rev-policy", "開いた時点の revision で保存する");
});

test("回答欄の Esc と Ctrl+C は、入力があれば破棄を確認する", () => {
  const empty = typeAll(base({ tab: "qa" }), "a", { escape: true });
  assert.equal(empty.state.mode.kind, "normal");
  let state = typeAll(base({ tab: "qa" }), "a", "下書き", { escape: true }).state;
  assert.equal((state.mode as { discard?: string }).discard, "cancel");
  state = typeAll(state, "n").state;
  assert.equal((state.mode as { discard?: string }).discard, undefined);
  assert.equal(editor.editorText((state.mode as import("../src/tui/model.js").AnswerForm).editor), "下書き");
  const exit = typeAll(state, { ctrl: true }, "y");
  // Ctrl+C は key.ctrl と "c" で届く
  const ctrlC = model.handleKey(state, "c", { ctrl: true }, context(state));
  assert.equal((ctrlC.state.mode as { discard?: string }).discard, "exit");
  assert.deepEqual(model.handleKey(ctrlC.state, "y", {}, context(ctrlC.state)).effects, ["exit"]);
  assert.equal(exit.state.mode.kind, "answer");
  assert.equal(typeAll(state, { escape: true }, "y").state.mode.kind, "normal");
});

test("保存中は操作と終了を受け付けず、終了の要求は保存が終わってから処理する", () => {
  const saving = typeAll(base({ tab: "qa" }), "a", "回答", { tab: true }, { return: true }, { return: true }).state;
  assert.equal(saving.mode.kind, "saving");
  let state = model.handleKey(saving, "c", { ctrl: true }, context(saving)).state;
  assert.equal((state.mode as { exitRequested: boolean }).exitRequested, true);
  assert.match(state.notice ?? "", /保存が終わってから終了します/);
  assert.deepEqual(model.handleKey(state, "q", {}, context(state)).effects, []);
  assert.equal(model.handleKey(state, "", { downArrow: true }, context(state)).state, state);

  const result = { schemaVersion: 1 as const, ok: true as const, item: { ...data.qas[0], status: "resolved" }, issues: [] };
  const finished = actions.applyWriteOutcome(state, { ok: true, result }, data);
  assert.deepEqual(finished.effects, ["refresh", "exit"]);

  state = saving;
  const success = actions.applyWriteOutcome(state, { ok: true, result }, data);
  assert.deepEqual(success.effects, ["refresh"]);
  assert.equal(success.state.mode.kind, "resumeList", "回答後は待っていたタスクを示す");
  const tasks = (success.state.mode as { tasks: { job: string; id: string }[] }).tasks;
  assert.deepEqual(tasks.map((entry) => `${entry.job}/${entry.id}`), ["PROJ-1/T-001", "PROJ-1/T-002", "other/T-001"], "別案件からの参照も集める");
  assert.match(success.state.notice ?? "", /Q-001 に回答しました \(回答者 human\/saiki\)/);
  const selected = typeAll(success.state, { downArrow: true }, { downArrow: true }, { return: true }).state;
  assert.equal(selected.tab, "task");
  assert.equal(selected.selection.task.key, "other\u0000task\u0000T-001");
  assert.match(selected.notice ?? "", /m で状態を変更/, "再開は明示的な操作にする");
  assert.ok(data.tasks.every((entry) => entry.status === "pending" || entry.id === "T-003"), "タスクの状態は変えない");
});

test("競合・失敗では入力を残してフォームへ戻し、自動で再送しない", () => {
  const saving = typeAll(base({ tab: "qa" }), "a", "私の回答", { tab: true }, { return: true }, { return: true }).state;
  const latest = { ...data.qas[0], status: "resolved", answer: "他の人の回答", answeredBy: "human/other", revision: "rev-new" };
  const conflict = actions.applyWriteOutcome(saving, { ok: false, code: "REVISION_CONFLICT", message: "競合", latest }, data);
  assert.deepEqual(conflict.effects, ["refresh"], "再送しない");
  const form = conflict.state.mode as import("../src/tui/model.js").AnswerForm;
  assert.equal(form.kind, "answer");
  assert.equal(editor.editorText(form.editor), "私の回答", "入力を残す");
  assert.match(form.error ?? "", /他の変更と競合したため保存しませんでした/);
  assert.deepEqual(form.latest?.slice(0, 3), ["最新の状態: resolved (更新 2026-09-28)", "回答者: human/other", "回答:"]);
  assert.equal(form.target.revision, "rev-new", "確認した後は最新の revision で保存し直せる");

  const requested = model.handleKey(saving, "q", {}, context(saving)).state;
  const failed = actions.applyWriteOutcome(requested, { ok: false, code: "FAILED", message: "ロックを取得できません" }, data);
  assert.deepEqual(failed.effects, ["refresh"], "失敗したら終了しない");
  assert.match(failed.state.notice ?? "", /終了を取り消しました/);
  assert.equal((failed.state.mode as import("../src/tui/model.js").AnswerForm).target.revision, "rev-policy", "競合以外では revision を変えない");

  const request = (saving.mode as { request: import("../src/tui/model.js").WriteRequest }).request;
  assert.equal(actions.writeConfirmed(request, { ...data.qas[0], status: "resolved", answer: "私の回答", answeredBy: "human/saiki" }), true);
  assert.equal(actions.writeConfirmed(request, { ...data.qas[0], status: "resolved", answer: "別の回答", answeredBy: "human/saiki" }), false);
  assert.ok(actions.knownRejections.has("REVISION_CONFLICT") && !actions.knownRejections.has("INVALID_RESPONSE"));
});

test("状態変更: pending には待ち理由が要り、pending の解除は QA の状態と QA 以外の待ちの確認を求める", () => {
  const onTask = (id: string) => {
    const state = base();
    const rows = model.rowsFor(data, { ...state, showAll: true });
    const index = rows.findIndex((row) => row.record?.id === id && row.record.job === "PROJ-1");
    return { ...state, showAll: true, selection: { ...state.selection, task: { key: rows[index].key, index } } };
  };
  // todo → pending
  let result = typeAll(onTask("T-003"), "m", { downArrow: true }, { return: true });
  assert.equal((result.state.mode as import("../src/tui/model.js").MoveForm).stage, "blocked");
  result = typeAll(result.state, { return: true });
  assert.match((result.state.mode as { error?: string }).error ?? "", /待っている相手/);
  result = typeAll(result.state, "other: 回答待ち", { return: true }, { return: true });
  assert.deepEqual(result.effects.at(-1), { kind: "write", request: { type: "move", target: (result.state.mode as { request: { target: unknown } }).request.target, status: "pending", blockedBy: "other: 回答待ち", actor: "human/saiki" } });

  // 未解決の QA を待つ pending は解除できない
  result = typeAll(onTask("T-001"), "m", { upArrow: true }, { return: true });
  const form = result.state.mode as import("../src/tui/model.js").MoveForm;
  assert.deepEqual(form.blockers, [{ reference: "qa/Q-001", state: "unresolved" }]);
  result = typeAll(result.state, { return: true });
  assert.match((result.state.mode as { error?: string }).error ?? "", /解除できません/);
  assert.equal(result.effects.length, 0);

  // 解決済みの QA とタスク待ち: QA 以外は利用者が確認する
  result = typeAll(onTask("T-004"), "m", { downArrow: true }, { return: true });
  assert.deepEqual((result.state.mode as import("../src/tui/model.js").MoveForm).blockers, [
    { reference: "qa/Q-002", state: "resolved" },
    { reference: "task/T-003", state: "other" },
  ]);
  result = typeAll(result.state, { return: true });
  assert.match((result.state.mode as { error?: string }).error ?? "", /Space で確認欄/);
  result = typeAll(result.state, " ", { return: true });
  assert.equal(result.state.mode.kind, "saving");

  // done は完了条件の確認を求める。同じ状態は選べない
  result = typeAll(onTask("T-003"), "m", { downArrow: true }, { downArrow: true }, { downArrow: true }, { return: true }, { return: true });
  assert.match((result.state.mode as { error?: string }).error ?? "", /Space で確認欄/);
  assert.equal(actions.needsCheck(result.state.mode as import("../src/tui/model.js").MoveForm), true);
  result = typeAll(onTask("T-003"), "m", { return: true });
  assert.equal((result.state.mode as { error?: string }).error, "現在と同じ状態です");
});
