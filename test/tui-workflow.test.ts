// 工程型タスク (workflowVersion 3) の TUI の試験。T-015
// 純粋な関数 (操作の一覧・フォーム・絞り込み・詳細)、偽の backend での描画、実際の scripts/ との接続 (RAPRID_TEST_SCRIPTS を指したときだけ)。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { cleanup, render } from "ink-testing-library";
import { createElement } from "react";
import { FakeBackend, load, qa, snapshot, task, tick, workflowTask } from "./tui-fixtures.ts";
import type { UiState } from "../src/tui/model.js";
import type { Snapshot, TaskRecord } from "../src/tui/types.js";

const model = await load<typeof import("../src/tui/model.js")>("../dist/tui/model.js");
const actions = await load<typeof import("../src/tui/actions.js")>("../dist/tui/actions.js");
const workflow = await load<typeof import("../src/tui/workflow.js")>("../dist/tui/workflow.js");
const steps = await load<typeof import("../src/tui/steps.js")>("../dist/tui/steps.js");
const { App } = await load<typeof import("../src/tui/app.js")>("../dist/tui/app.js");
const { SnapshotStore, DetailStore } = await load<typeof import("../src/tui/stores.js")>("../dist/tui/stores.js");
const { BackendError, ScriptBackend } = await load<typeof import("../src/tui/backend.js")>("../dist/tui/backend.js");

afterEach(() => cleanup());

const me = "human/saiki";
const data: Snapshot = {
  ...snapshot({
    tasks: [
      task("T-001", { status: "todo", name: "legacy", title: "旧形式のタスク" }),
      workflowTask("T-002", { name: "plan-ready", title: "計画待ち (未割当)", phase: "plan", phaseStatus: "ready" }),
      workflowTask("T-003", { name: "exec-mine", title: "自分の実行", phase: "execute", phaseStatus: "progress", assignee: me }),
      workflowTask("T-004", { name: "review-other", title: "他の人のレビュー", phase: "review", phaseStatus: "ready", assignee: "agent/codex" }),
      workflowTask("T-005", { name: "accept-mine", title: "受入確認", phase: "acceptance", phaseStatus: "progress", assignee: me }),
      workflowTask("T-006", { name: "closed", title: "閉じたタスク", status: "closed", phase: null }),
      workflowTask("T-007", { name: "exec-ready-mine", title: "自分の担当の ready", phase: "execute", phaseStatus: "ready", assignee: me }),
      workflowTask("T-008", { name: "waiting", title: "QA 待ち", phase: "execute", phaseStatus: "pending", assignee: me, blockedBy: ["qa/Q-001"] }),
    ],
    qas: [qa("Q-001", { name: "policy" })],
  }),
  schemaVersion: 2,
};

const byId = (id: string) => data.tasks.find((record) => record.id === id)!;

function base(overrides: Partial<UiState> = {}): UiState {
  return { ...model.initialState(null, { actor: me, writable: true, workflow: true }), ...overrides };
}

function context(state: UiState, snap: Snapshot = data) {
  const rows = model.rowsFor(snap, state);
  return { rows, selected: rows[model.selectedIndex(state, rows)], snapshot: snap, jobs: ["PROJ-1"], layout: "medium" as const, detailHeight: 5, detailLength: 5 };
}

function press(state: UiState, input: string, key: Record<string, boolean> = {}, snap: Snapshot = data) {
  return model.handleKey(state, input, key, context(state, snap));
}

function run(state: UiState, ...inputs: (string | Record<string, boolean>)[]) {
  let current = state;
  const effects: unknown[] = [];
  for (const input of inputs) {
    const result = typeof input === "string" ? press(current, input) : press(current, "", input);
    current = result.state;
    effects.push(...result.effects);
  }
  return { state: current, effects };
}

// 一覧でタスクを選んだ状態
function select(id: string, overrides: Partial<UiState> = {}): UiState {
  const state = base(overrides);
  const rows = model.rowsFor(data, state);
  const index = rows.findIndex((row) => row.record?.id === id);
  assert.ok(index >= 0, `${id} が一覧にある`);
  return { ...state, selection: { ...state.selection, task: { key: rows[index].key, index } } };
}

const enter = { return: true };
const tab = { tab: true };

test("操作の一覧は今の状態と actor でできるものだけで、旧形式の状態の選択は出さない", () => {
  const kinds = (id: string, actor: string | null = me) => workflow.availableSteps(byId(id), actor);
  assert.deepEqual(kinds("T-002"), ["claim", "assign", "reopen"], "未割当の ready は誰でも引き受けられる");
  assert.deepEqual(kinds("T-004"), ["assign", "reopen"], "他の人が担当の ready は引き受けられない");
  assert.deepEqual(kinds("T-007"), ["claim", "assign", "reopen"]);
  assert.deepEqual(kinds("T-003"), ["complete", "block", "assign", "reopen"], "自分の実行中は完了できる");
  assert.deepEqual(kinds("T-003", "human/other"), ["block", "assign", "reopen"], "担当でなければ完了できない");
  assert.deepEqual(kinds("T-005"), ["approve", "requestChanges", "block", "assign", "reopen"], "受入確認は判定");
  assert.deepEqual(kinds("T-008"), ["resume"], "待ちは再開だけ");
  assert.deepEqual(kinds("T-006"), ["reopen"], "closed はやり直しだけ");
  assert.deepEqual(workflow.availableSteps(byId("T-001"), me), [], "旧形式は工程の操作の対象外");
  assert.deepEqual(workflow.availableSteps({ ...byId("T-002"), workflowVersion: 2 }, me), [], "v2 は変更しない");
  assert.deepEqual(workflow.availableSteps({ ...byId("T-002"), valid: false }, me), [], "不整合があれば変更しない");
  // 工程型タスクで m を押すと工程の操作の一覧が開き、状態の選択 (move) にはならない
  for (const id of ["T-002", "T-003", "T-005", "T-006", "T-008"]) {
    const opened = press(select(id, { showAll: true }), "m").state;
    assert.equal(opened.mode.kind, "step", id);
    assert.equal(opened.mode.kind === "step" && opened.mode.steps.some((step) => ["todo", "done", "progress", "pending"].includes(step)), false, `${id}: 状態を直接選ぶ操作は無い`);
  }
  // 旧形式は従来どおり状態の選択
  assert.equal(press(select("T-001"), "m").state.mode.kind, "move");
  // scripts/ が workflow-v3 に対応していなければ工程型は変更できない
  assert.match(press(select("T-002", { workflow: false }), "m").state.notice ?? "", /workflow-v3/);
});

test("工程の操作から scripts/ の CLI の引数を作る (1 件ずつ --artifact・--commit・--blocked-by)", () => {
  assert.deepEqual(workflow.stepArgs({ op: "claim" }, me), ["claim", "--actor", me]);
  assert.deepEqual(workflow.stepArgs({ op: "complete", handoff: "02.md", artifacts: ["a b.md"], commits: ["project_template:873ca38", "raprid-cli:230ad56"] }, me), [
    "complete", "--actor", me, "--handoff", "02.md", "--artifact", "a b.md", "--commit", "project_template:873ca38", "--commit", "raprid-cli:230ad56",
  ]);
  assert.deepEqual(workflow.stepArgs({ op: "decide", outcome: "changes_requested", report: "03.md", returnTo: "execute", reason: "R-1, R-2" }, me), ["decide", "changes_requested", "--actor", me, "--report", "03.md", "--return-to", "execute", "--reason", "R-1, R-2"]);
  assert.deepEqual(workflow.stepArgs({ op: "block", blockedBy: ["qa/Q-001", "other: 権限, 予算"] }, me), ["block", "--actor", me, "--blocked-by", "qa/Q-001", "--blocked-by", "other: 権限, 予算"]);
  assert.deepEqual(workflow.stepArgs({ op: "assign", phase: "review", assignee: "agent/codex", reason: "レビュー" }, me), ["assign", "review", "agent/codex", "--by", me, "--reason", "レビュー"]);
  assert.deepEqual(workflow.stepArgs({ op: "reopen", returnTo: "plan", reason: "要件の変更" }, me), ["reopen", "--return-to", "plan", "--actor", me, "--reason", "要件の変更"]);
});

test("完了のフォーム: 引継資料・成果物・commit を入力し、確認してから保存する。必須・書式の誤りは保存しない", () => {
  let state = press(select("T-003"), "m").state;
  state = run(state, enter).state; // 完了する
  assert.equal(state.mode.kind === "step" && state.mode.stage, "edit");
  // 引継資料が空のまま次へ
  let result = run(state, tab, tab, tab, enter);
  assert.match(result.state.mode.kind === "step" ? (result.state.mode.error ?? "") : "", /引継資料を入力/);
  // 入力する (1 行の欄は Enter で次の欄へ、複数行の欄は改行)
  result = run(state, "0", "2", "-", "h", ".", "m", "d", enter, "a", ".", "m", "d", enter, "b", ".", "m", "d", tab, "b", "a", "d", tab, enter);
  assert.match(result.state.mode.kind === "step" ? (result.state.mode.error ?? "") : "", /commit は <repo>:<commit>/, "commit の書式を確かめる");
  state = result.state;
  // commit を直す
  if (state.mode.kind !== "step") throw new Error("step のまま");
  const form = state.mode;
  const fields = form.fields.map((field) => (field.key === "commits" ? { ...field, editor: { lines: ["project_template:873ca38"], row: 0, col: 24 } } : field));
  state = { ...state, mode: { ...form, fields, focus: form.fields.length, error: undefined } };
  result = run(state, enter);
  assert.equal(result.state.mode.kind === "step" && result.state.mode.stage, "confirm");
  result = run(result.state, enter);
  assert.equal(result.state.mode.kind, "saving");
  const effect = result.effects[0] as { kind: string; request: { type: string; step: unknown; actor: string; target: { revision: string } } };
  assert.deepEqual(effect.request.step, { op: "complete", handoff: "02-h.md", artifacts: ["a.md", "b.md"], commits: ["project_template:873ca38"] });
  assert.equal(effect.request.actor, me);
  assert.equal(effect.request.target.revision, "rev-exec-mine");
});

test("受入確認の判定は根拠 (実行の成果物・レビュー) を示す確認画面で、確認欄に印を付けないと確定できない", () => {
  let state = press(select("T-005"), "m").state;
  state = run(state, enter).state; // 受け入れる
  if (state.mode.kind !== "step") throw new Error("step");
  assert.equal(workflow.stepLabel("approve", "acceptance"), "受け入れる (受入確認の承認)");
  state = { ...state, mode: { ...state.mode, fields: state.mode.fields.map((field) => ({ ...field, editor: { lines: ["04-acceptance.md"], row: 0, col: 16 } })) } };
  state = run(state, tab, enter).state; // 次へ
  assert.equal(state.mode.kind === "step" && state.mode.stage, "confirm");
  if (state.mode.kind !== "step") throw new Error("step");
  assert.equal(steps.isAcceptanceDecision(state.mode), true);
  const evidence = workflow.acceptanceEvidence(state.mode.record).join("\n");
  assert.match(evidence, /実行の成果物 +02-handoff\.md\n +project_template@873ca38/, "成果物は 1 件ずつ 1 行");
  assert.match(evidence, /レビューの判定 +approved agent\/codex/);
  // 印を付けずに確定
  let result = run(state, enter);
  assert.equal(result.state.mode.kind, "step");
  assert.match(result.state.mode.kind === "step" ? (result.state.mode.error ?? "") : "", /確認欄に印/);
  assert.deepEqual(result.effects, []);
  result = run(state, " ", enter);
  assert.equal(result.state.mode.kind, "saving");
  assert.deepEqual((result.effects[0] as { request: { step: unknown } }).request.step, { op: "decide", outcome: "approved", report: "04-acceptance.md" });
});

test("担当の変更と差戻しのフォーム: 工程・担当・理由・戻す工程を入力して、scripts/ に渡す操作を作る", () => {
  // 担当の変更 (T-002 の ready): 工程を review にし、担当・理由を入れる
  let state = press(select("T-002"), "m").state;
  state = run(state, { downArrow: true }, enter).state; // 担当を替える
  if (state.mode.kind !== "step") throw new Error("step");
  assert.deepEqual(state.mode.fields.map((field) => field.key), ["phase", "assignee", "reason", "handoff"]);
  state = run(state, { rightArrow: true }, { rightArrow: true }, enter, ..."agent/codex", enter, ..."レビューを頼む", tab, tab, enter).state;
  assert.equal(state.mode.kind === "step" && state.mode.stage, "confirm");
  if (state.mode.kind !== "step") throw new Error("step");
  assert.deepEqual(steps.buildStep(state.mode), { op: "assign", phase: "review", assignee: "agent/codex", reason: "レビューを頼む", handoff: undefined });
  // 担当の書式が違えば保存しない
  let bad = press(select("T-002"), "m").state;
  bad = run(bad, { downArrow: true }, enter, enter, ..."codex", enter, ..."r", tab, tab, enter).state;
  assert.match(bad.mode.kind === "step" ? (bad.mode.error ?? "") : "", /human\/<識別子> か agent\/<識別子>/);
  // 受入確認で差し戻す: 戻す工程を plan にし、理由を入れる。確認欄に印を付けてから確定する
  let back = press(select("T-005"), "m").state;
  back = run(back, { downArrow: true }, enter, ..."04.md", enter, { rightArrow: true }, enter, ..."要件の不足", tab, enter).state;
  if (back.mode.kind !== "step") throw new Error("step");
  assert.equal(back.mode.stage, "confirm");
  assert.deepEqual(steps.buildStep(back.mode), { op: "decide", outcome: "changes_requested", report: "04.md", returnTo: "plan", reason: "要件の不足" });
  const saved = run(back, " ", enter);
  assert.equal(saved.state.mode.kind, "saving");
});

test("受入確認の根拠が長くてもスクロールしてすべて見られ、最後まで表示しないと確認欄に印を付けられない (R15-1)", () => {
  // レビューの再現例: 実行の成果物に長い commit が 8 件
  const commits = Array.from({ length: 8 }, (_, index) => ({ path: `成果物${index}.md` }));
  const long = Array.from({ length: 8 }, (_, index) => ({ repo: "project_template", commit: `abcdef0123456789abcdef0123456789abcd${String(index).padStart(4, "0")}` }));
  const base5 = byId("T-005");
  const record: TaskRecord = { ...base5, workflow: { ...base5.workflow!, execute: { ...base5.workflow!.execute, artifactRefs: [...commits, ...long] } } };
  const snap: Snapshot = { ...data, tasks: data.tasks.map((item) => (item.id === "T-005" ? record : item)) };
  const small = { formWidth: 60, formHeight: 20 };
  const key = (state: UiState, input: string, k: Record<string, boolean> = {}) => model.handleKey(state, input, k, { ...context(state, snap), ...small });
  let state = select("T-005");
  state = key(state, "m").state;
  state = key(state, "", enter).state;
  if (state.mode.kind !== "step") throw new Error("step");
  state = { ...state, mode: { ...state.mode, fields: state.mode.fields.map((field) => ({ ...field, editor: { lines: ["04.md"], row: 0, col: 5 } })) } };
  state = key(key(state, "", tab).state, "", enter).state;
  if (state.mode.kind !== "step") throw new Error("step");
  const rows = steps.evidenceRows(record, 60);
  const window = steps.evidenceWindow(20);
  assert.ok(rows.length > window, "根拠が 1 画面に収まらない");
  assert.equal(state.mode.evidenceSeen, false);
  assert.match(rows.slice(0, window).join("\n"), /レビューの判定 +approved/, "レビューの判定と記録は最初に見える");
  // 最後まで表示しないうちは印を付けられず、確定もできない
  let tried = key(state, " ").state;
  assert.match(tried.mode.kind === "step" ? (tried.mode.error ?? "") : "", /最後まで表示/);
  assert.deepEqual(key(state, "", enter).effects, []);
  // スクロールしてすべての commit を表示する
  let scrolled = state;
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    if (scrolled.mode.kind !== "step") throw new Error("step");
    for (const line of rows.slice(scrolled.mode.evidenceScroll, scrolled.mode.evidenceScroll + window)) seen.add(line);
    scrolled = key(scrolled, "", { downArrow: true }).state;
  }
  assert.ok(rows.every((line) => seen.has(line)), "すべての根拠の行を表示できる");
  if (scrolled.mode.kind !== "step") throw new Error("step");
  assert.equal(scrolled.mode.evidenceSeen, true);
  tried = key(scrolled, " ").state;
  const saved = key(tried, "", enter);
  assert.equal(saved.state.mode.kind, "saving");
  // End で最後へ飛んでも「見た」になる
  const ended = key(state, "", { end: true }).state;
  assert.equal(ended.mode.kind === "step" && ended.mode.evidenceSeen, true);
});

test("ready の一覧 (w) は状態の絞り込み (f・v) に左右されない (R15-2)", () => {
  const ids = (state: UiState) => model.rowsFor(data, state).map((row) => row.record?.id);
  // レビューの再現例: f で pending だけにしてから w
  const pendingOnly = base({ filters: { task: ["pending"], qa: null } });
  assert.deepEqual(ids(pendingOnly), ["T-008"]);
  assert.deepEqual(ids(press(pendingOnly, "w").state), ["T-007", "T-002", "T-004"]);
  // w の後に f で絞り込んでも ready の一覧は変わらない
  const queue = press(base(), "w").state;
  assert.deepEqual(ids({ ...queue, filters: { task: ["done"], qa: null } }), ["T-007", "T-002", "T-004"]);
  assert.deepEqual(ids({ ...queue, showAll: true }), ["T-007", "T-002", "T-004"]);
  // 検索は ready の一覧にも効く
  assert.deepEqual(ids({ ...queue, search: "未割当" }), ["T-002"]);
});

test("保存の失敗・競合では入力を残して確認画面へ戻り、競合では最新の revision と状態を示す。結果が分からない失敗は履歴で確かめる", () => {
  let state = press(select("T-003"), "m").state;
  state = run(state, { downArrow: true }, enter).state; // 待ちにする
  if (state.mode.kind !== "step") throw new Error("step");
  state = { ...state, mode: { ...state.mode, fields: state.mode.fields.map((field) => (field.key === "blockedBy" ? { ...field, editor: { lines: ["qa/Q-001", "other: 承認"], row: 1, col: 9 } } : field)) } };
  state = run(state, tab, tab, enter, enter).state; // 次へ → 保存
  assert.equal(state.mode.kind, "saving");
  const latest: TaskRecord = { ...byId("T-003"), revision: "rev-new", phaseStatus: "pending", history: [...(byId("T-003").history ?? []), { seq: 2, at: "2026-09-29T01:00:00Z", actor: "agent/other", event: "block", phase: "execute", attempt: 1, outcome: null, from: "progress", to: "pending", reason: null, refersTo: null, refs: [] }] };
  const conflict = actions.applyWriteOutcome(state, { ok: false, code: "REVISION_CONFLICT", message: "競合", latest }, data).state;
  assert.equal(conflict.mode.kind, "step");
  if (conflict.mode.kind !== "step") throw new Error("step");
  assert.equal(conflict.mode.stage, "confirm");
  assert.equal(conflict.mode.target.revision, "rev-new", "送り直すときは最新の revision");
  assert.deepEqual(steps.buildStep(conflict.mode), { op: "block", blockedBy: ["qa/Q-001", "other: 承認"], reason: undefined }, "入力は残る");
  assert.match(conflict.mode.latest?.join("\n") ?? "", /最新の状態: execute pending/);
  const rejected = actions.applyWriteOutcome({ ...state }, { ok: false, code: "WF_NOT_ASSIGNEE", message: "担当ではありません" }, data).state;
  assert.match(rejected.mode.kind === "step" ? (rejected.mode.error ?? "") : "", /担当ではありません/);
  assert.equal(actions.isKnownRejection("WF_NOT_ASSIGNEE"), true, "WF_… は書き込む前の拒否");
  // 結果が分からない失敗: この actor の操作の履歴が増えていれば保存できていた
  if (state.mode.kind !== "saving") throw new Error("saving");
  const request = state.mode.request;
  // scripts/ は理由を省いた block の理由を、待ちの相手を「 / 」でつないで保存する
  const mine = { ...latest, blockedBy: ["qa/Q-001", "other: 承認"], history: [...(byId("T-003").history ?? []), { ...latest.history!.at(-1)!, actor: me, reason: "qa/Q-001 / other: 承認" }] };
  assert.equal(actions.writeConfirmed(request, mine), true);
  assert.equal(actions.writeConfirmed(request, { ...mine, history: latest.history }), false, "他の人の操作では確かめたことにしない");
  assert.equal(actions.writeConfirmed(request, { ...mine, revision: request.target.revision }), false, "revision が同じなら保存していない");
  // R15-3 の再現例: 同じ操作者の別の block (待ちの相手が違う) は、この操作の保存とみなさない
  assert.equal(actions.writeConfirmed(request, { ...mine, blockedBy: ["qa/Q-002"] }), false, "待ちの相手が違う");
  assert.equal(actions.writeConfirmed(request, { ...mine, history: [...mine.history!, { ...mine.history!.at(-1)!, seq: 3 }] }), false, "履歴が余分に増えていれば区別できない");
  // R15-4 の再現例: 待ちの相手が同じでも、理由が違う block はこの操作の保存とみなさない
  const reasoned = { ...request, step: { op: "block" as const, blockedBy: ["other: 承認"], reason: "待ち理由A" }, target: { ...request.target, blockedBy: [] } };
  const other = (why: string) => ({ ...mine, blockedBy: ["other: 承認"], history: [...(byId("T-003").history ?? []), { ...mine.history!.at(-1)!, reason: why }] });
  assert.equal(actions.writeConfirmed(reasoned, other("待ち理由B")), false, "理由が違う");
  assert.equal(actions.writeConfirmed(reasoned, other("待ち理由A")), true, "理由まで一致すれば保存できた");
  // R15-5: FAILED は書き込む前の拒否と決められないので、結果が分からない失敗として扱う
  assert.equal(actions.isKnownRejection("FAILED"), false);
  const failed = actions.applyWriteOutcome({ ...state }, { ok: false, code: "FAILED", message: "終了コード 1 で終了しました" }, data).state;
  assert.match(failed.mode.kind === "step" ? (failed.mode.error ?? "") : "", /保存できたか分かりません/);
  // 区別できない失敗は「保存できたか分からない」と示し、入力を残す
  const unknown = actions.applyWriteOutcome({ ...state }, { ok: false, code: "INVALID_RESPONSE", message: "応答が壊れた", latest: { ...mine, blockedBy: ["qa/Q-002"] } }, data).state;
  assert.equal(unknown.mode.kind, "step");
  assert.match(unknown.mode.kind === "step" ? (unknown.mode.error ?? "") : "", /保存できたか分かりません/);
  assert.deepEqual(unknown.mode.kind === "step" ? steps.buildStep(unknown.mode) : undefined, { op: "block", blockedBy: ["qa/Q-001", "other: 承認"], reason: undefined });
});

test("一覧: 工程型は今の工程の状態で絞り込み、closed は既定で隠す。ready の一覧 (w) は自分・未割当を上に出す", () => {
  const ids = (state: UiState) => model.rowsFor(data, state).map((row) => row.record?.id);
  assert.deepEqual(ids(base()), ["T-001", "T-002", "T-003", "T-004", "T-005", "T-007", "T-008"], "closed (T-006) は隠す");
  assert.ok(ids(base({ showAll: true })).includes("T-006"));
  assert.deepEqual(ids(base({ filters: { task: ["pending"], qa: null } })), ["T-008"]);
  assert.deepEqual(ids(base({ filters: { task: ["done"], qa: null } })), ["T-006"], "closed は done として絞り込む");
  const queue = press(base(), "w").state;
  assert.equal(queue.readyQueue, true);
  assert.deepEqual(ids(queue), ["T-007", "T-002", "T-004"], "自分の担当 → 未割当 → 他の人");
  assert.equal(press(base({ workflow: false }), "w").state.readyQueue, false);
  // 詳細: 工程ごとの記録・成果物・履歴。工程の done とタスクの closed を区別する
  const detail = (id: string) => model.detailLines({ key: id, record: byId(id) }, { target: undefined, result: undefined, loading: false, error: undefined, current: true } as never, data).map((line) => line.text).join("\n");
  const exec = detail("T-003");
  assert.match(exec, /種別 +実装 \(workflowVersion 3\)/);
  assert.match(exec, /工程 +実行 progress \/ 担当 human\/saiki/);
  assert.match(exec, /計画 done \/ 試行 1 \/ 担当 未割当 \/ 完了 agent\/codex 2026-09-29 completed/);
  assert.match(detail("T-006"), /状態 +closed \(accepted\) +※タスク全体が閉じている/);
});

function mount(options: { data?: Snapshot; columns?: number; workflow?: boolean } = {}) {
  const snap = options.data ?? data;
  const backend = new FakeBackend(snap);
  const snapshots = new SnapshotStore(backend, { intervalMs: 60_000 });
  const details = new DetailStore(backend, { debounceMs: 5 });
  snapshots.seed(snap);
  const view = render(createElement(App, { snapshots, details, initialJob: null, projectName: "sample", columns: options.columns ?? 120, rows: 32, onUnmount: () => {}, writer: backend, workflow: options.workflow ?? true, actor: me }));
  const frame = () => view.lastFrame() ?? "";
  const pressKeys = async (...inputs: string[]) => {
    for (const input of inputs) {
      view.stdin.write(input);
      await tick(input === "\u001b" ? 80 : 15);
    }
    await tick(20);
  };
  return { ...view, backend, frame, press: pressKeys };
}

test("画面: 一覧に種別・工程・状態・担当の列が出て、ready の一覧と工程の操作が使える", async () => {
  const app = mount({ columns: 200 });
  await tick(40);
  assert.match(app.frame(), /T-001 +- +未移行 +todo +- +旧形式のタスク/);
  assert.match(app.frame(), /T-003 +実装 +execute +progress +human\/saiki +自分の実行/);
  await app.press("w");
  assert.match(app.frame(), /ready の工程だけ/);
  assert.match(app.frame(), /> T-007/);
  await app.press("m");
  assert.match(app.frame(), /T-007 の工程の操作/);
  assert.match(app.frame(), /引き受ける \(claim\)/);
  assert.doesNotMatch(app.frame(), /\bdone\b.*\(現在\)/, "状態の選択は出ない");
  await app.press("\r"); // 引き受ける → 入力が無いので確認
  assert.match(app.frame(), /この内容で保存しますか/);
  await app.press("\r");
  assert.equal(app.backend.writeCalls.length, 1);
  assert.deepEqual(app.backend.writeCalls[0].args, ["workflowStep", "PROJ-1", "exec-ready-mine", { op: "claim" }, me, "rev-exec-ready-mine"]);
  assert.match(app.frame(), /保存中/);
  app.backend.writeCalls[0].reply.resolve({ schemaVersion: 2, ok: true, item: { ...byId("T-007"), phaseStatus: "progress" }, issues: [], revision: "rev-2" });
  await tick(40);
  assert.match(app.frame(), /T-007 を「引き受ける \(claim\)」しました。今の工程: execute progress/);
});

test("画面: 40〜79 桁の狭い端末・日本語のタイトルでも列が崩れず、受入確認の確認画面に根拠が出る", async () => {
  const narrow = mount({ columns: 60 });
  await tick(40);
  const lines = narrow.frame().split("\n");
  assert.ok(lines.every((line) => line.length <= 60 * 2), "はみ出さない");
  assert.match(narrow.frame(), /T-003 実装 execute/);
  cleanup();
  const app = mount();
  await tick(40);
  for (let i = 0; i < 4; i++) await app.press("\u001b[B"); // T-005 へ
  assert.match(app.frame(), /> T-005/);
  await app.press("m", "\r");
  await app.press("0", "4", ".", "m", "d", "\t", "\r");
  assert.match(app.frame(), /受入確認: 次の根拠を確かめてから確定/);
  assert.match(app.frame(), /実行の成果物 +02-handoff\.md/);
  assert.match(app.frame(), /project_template@873ca38/);
  await app.press("\r");
  assert.match(app.frame(), /確認欄に印/);
  assert.equal(app.backend.writeCalls.length, 0, "印が無ければ保存しない");
  await app.press(" ", "\r");
  assert.equal(app.backend.writeCalls.length, 1);
});

test("画面: 受入確認の根拠が長いときは位置を示してスクロールでき、最後の commit まで表示してから確定できる (R15-1)", async () => {
  const base5 = byId("T-005");
  const refs = [{ path: "02-handoff.md" }, ...Array.from({ length: 8 }, (_, index) => ({ repo: "project_template", commit: `abcdef0123456789abcdef0123456789abcd${String(index).padStart(4, "0")}` }))];
  const record: TaskRecord = { ...base5, workflow: { ...base5.workflow!, execute: { ...base5.workflow!.execute, artifactRefs: refs } } };
  const snap: Snapshot = { ...data, tasks: data.tasks.map((item) => (item.id === "T-005" ? record : item)) };
  const backend = new FakeBackend(snap);
  const snapshots = new SnapshotStore(backend, { intervalMs: 60_000 });
  const details = new DetailStore(backend, { debounceMs: 5 });
  snapshots.seed(snap);
  const view = render(createElement(App, { snapshots, details, initialJob: null, projectName: "sample", columns: 60, rows: 22, onUnmount: () => {}, writer: backend, workflow: true, actor: me }));
  const press = async (...inputs: string[]) => {
    for (const input of inputs) {
      view.stdin.write(input);
      await tick(input === "\u001b" ? 80 : 15);
    }
    await tick(20);
  };
  await tick(40);
  for (let i = 0; i < 4; i++) await press("\u001b[B");
  await press("m", "\r", ..."04.md", "\t", "\r");
  const frame = () => view.lastFrame() ?? "";
  assert.match(frame(), /根拠 \(1〜\d+ \/ \d+ 行 +↑↓ PgUp\/PgDn でスクロール\)/);
  assert.match(frame(), /レビューの判定 +approved/);
  assert.doesNotMatch(frame(), /abcd0007/, "最後の commit は最初は見えない");
  await press(" ");
  assert.match(frame(), /最後まで表示/);
  await press("\u001b[F"); // End
  assert.match(frame(), /abcd0007/, "最後の commit を表示できる");
  await press(" ", "\r");
  assert.equal(backend.writeCalls.length, 1);
});

test("画面: 書き込んだ後の異常終了 (FAILED) は読み直して照合し、保存できていれば成功、区別できなければ入力を残して「分からない」と示す (R15-5)", async () => {
  for (const saved of [true, false]) {
    const backend = new FakeBackend(data);
    const snapshots = new SnapshotStore(backend, { intervalMs: 60_000 });
    const details = new DetailStore(backend, { debounceMs: 5 });
    snapshots.seed(data);
    const view = render(createElement(App, { snapshots, details, initialJob: null, projectName: "sample", columns: 120, rows: 30, onUnmount: () => {}, writer: backend, workflow: true, actor: me }));
    const press = async (...inputs: string[]) => {
      for (const input of inputs) {
        view.stdin.write(input);
        await tick(input === "\u001b" ? 80 : 15);
      }
      await tick(20);
    };
    await tick(40);
    await press("w", "m", "\r", "\r"); // T-007 を引き受ける
    assert.equal(backend.writeCalls.length, 1);
    // 読み直すと、保存できていた (この操作者の claim が 1 件増えている) か、できていなかった
    const before = byId("T-007");
    const after: TaskRecord = saved
      ? { ...before, revision: "rev-new", phaseStatus: "progress", assignee: me, history: [...before.history!, { seq: 2, at: "2026-09-29T01:00:00Z", actor: me, event: "claim", phase: "execute", attempt: 1, outcome: null, from: "ready", to: "progress", reason: null, refersTo: null, refs: [] }] }
      : before;
    backend.current = { ...data, tasks: data.tasks.map((item) => (item.id === "T-007" ? after : item)) };
    backend.writeCalls[0].reply.reject(new BackendError("FAILED", "終了コード 1 で終了しました"));
    await tick(80);
    const frame = view.lastFrame() ?? "";
    if (saved) assert.match(frame, /応答は不明でしたが、再取得して保存を確かめました/);
    else {
      assert.match(frame, /保存できたか分かりません/);
      assert.match(frame, /T-007 の工程の操作/, "入力を残してフォームに戻る");
    }
    assert.equal(backend.writeCalls.length, 1, "自動で送り直さない");
    cleanup();
  }
});

// 実際の scripts/ (T-014 の CLI) との接続。RAPRID_TEST_SCRIPTS に project_template の scripts/ を指したときだけ実行する
const scripts = process.env.RAPRID_TEST_SCRIPTS;
const integration = scripts && existsSync(join(scripts, "cli.ts")) ? false : "RAPRID_TEST_SCRIPTS が指定されていない";

test("実際の scripts/: capability で schemaVersion 2 を選び、工程の操作を送り、競合・拒否を code で受け取る。旧 schemaVersion は止まる", { skip: integration }, async () => {
  const root = mkdtempSync(join(tmpdir(), "raprid-tui-workflow-"));
  try {
    cpSync(scripts!, join(root, "scripts"), { recursive: true, filter: (source) => !source.includes("node_modules") });
    mkdirSync(join(root, "jobs"));
    const cli = (...args: string[]) => spawnSync(process.execPath, [join(root, "scripts", "cli.ts"), ...args], { cwd: root, env: { ...process.env, RAPRID_ROOT: root, RAPRID_ACTOR: "agent/test" }, encoding: "utf8" });
    assert.equal(cli("job", "create", "PROJ").status, 0);
    assert.equal(cli("task", "add", "PROJ", "work", "--type", "implementation", "実装する", "--requested-by", me, "--created-by", "agent/codex").status, 0);
    const backend = new ScriptBackend(root);
    const capabilities = await backend.capabilities();
    assert.ok(capabilities.includes("query-v2") && capabilities.includes("workflow-v3"), capabilities.join(","));
    // schemaVersion 1 のままだと、工程型があるので止まる (旧 TUI と同じ)
    await assert.rejects(backend.snapshot(), (error: unknown) => error instanceof BackendError && error.code === "SCHEMA_V2_REQUIRED");
    backend.useSchema(2);
    const snap = await backend.snapshot();
    const record = snap.tasks.find((item) => item.name === "work")!;
    assert.deepEqual([record.workflowVersion, record.type, record.phase, record.phaseStatus], [3, "implementation", "plan", "ready"]);
    const claimed = await backend.workflowStep("PROJ", "work", { op: "claim" }, me, record.revision!);
    assert.equal(claimed.schemaVersion, 2);
    assert.equal((claimed.item as TaskRecord).phaseStatus, "progress");
    await assert.rejects(backend.workflowStep("PROJ", "work", { op: "resume" }, me, record.revision!), (error: unknown) => error instanceof BackendError && error.code === "REVISION_CONFLICT");
    const shown = await backend.show("task", "PROJ", "work");
    await assert.rejects(backend.workflowStep("PROJ", "work", { op: "complete", handoff: "none.md", artifacts: [], commits: [] }, me, shown.item.revision!), (error: unknown) => error instanceof BackendError && error.code === "WF_HANDOFF");
    writeFileSync(join(root, "jobs", "PROJ", "tasks", "work", "01.md"), "# 計画\n\n## 対象・成果物\n\n- x\n\n## 実施・検証\n\n- y\n\n## 未確認・制約\n\n- なし\n\n## 次の担当への依頼\n\n- z\n");
    const completed = await backend.workflowStep("PROJ", "work", { op: "complete", handoff: "01.md", artifacts: [], commits: [] }, me, shown.item.revision!);
    assert.equal((completed.item as TaskRecord).phase, "execute");
    backend.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
