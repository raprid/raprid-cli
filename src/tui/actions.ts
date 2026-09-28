// 更新操作 (QA の回答・タスクの状態変更) のフォーム。Ink に依存しない純粋な関数。
//
// 保存の前に必ず確認画面を通し、保存中は多重実行と終了を抑止する。失敗・競合では入力を残し、自動で再送しない。
// 回答してもタスクは自動では再開せず、待っていたタスクを示すだけにする。

import type { WriteResult } from "./backend.js";
import { backspace, editorIsBlank, editorText, emptyEditor, insertText, moveCursor, newline, normalizeInput } from "./editor.js";
import type { AnswerForm, Blocker, Effect, KeyContext, KeyInput, KeyResult, MoveForm, UiState, WaitingTask, WriteRequest, WriteTarget } from "./model.js";
import { graphemes, sanitize } from "./text.js";
import { type ItemRecord, type QaRecord, type Snapshot, statusOrder, type TaskRecord } from "./types.js";

export const actorPattern = /^human\/[a-z0-9][a-z0-9._-]*$/;
export const answerLimit = 1024 * 1024;

const done = (state: UiState, ...effects: Effect[]): KeyResult => ({ state, effects });
const normal = (state: UiState, notice?: string): UiState => ({ ...state, mode: { kind: "normal" }, notice });

function targetOf(record: ItemRecord): WriteTarget {
  return {
    kind: record.kind,
    job: record.job,
    id: record.id,
    name: record.name,
    path: record.path,
    revision: record.revision ?? "",
    title: record.title ?? record.name,
    status: record.status,
    blockedBy: record.kind === "task" ? record.blockedBy : [],
  };
}

function label(target: WriteTarget): string {
  return target.id ?? target.name;
}

// QA を指す blockedBy の状態を snapshot から調べる (保存時は scripts/ がロック内で確かめ直す)
export function blockersOf(snapshot: Snapshot | undefined, job: string, blockedBy: string[]): Blocker[] {
  return blockedBy.map((reference) => {
    const parts = reference.split("/");
    if (parts[0] !== "qa" || parts.length < 2 || parts.length > 3) return { reference, state: "other" as const };
    const qaJob = parts.length === 3 ? parts[1] : job;
    const selector = parts.at(-1)!;
    const matches = (snapshot?.qas ?? []).filter((qa) => qa.job === qaJob && (qa.id === selector || qa.name === selector));
    if (matches.length !== 1) return { reference, state: "missing" as const };
    return { reference, state: matches[0].status === "resolved" ? ("resolved" as const) : ("unresolved" as const) };
  });
}

// この QA を待っている pending のタスク (別案件からの qa/<案件名>/<ID> も含む)
export function waitingFor(snapshot: Snapshot | undefined, qa: Pick<QaRecord, "job" | "id" | "name">): WaitingTask[] {
  const references = new Set([`qa/${qa.job}/${qa.name}`, ...(qa.id ? [`qa/${qa.job}/${qa.id}`] : [])]);
  const local = new Set([`qa/${qa.name}`, ...(qa.id ? [`qa/${qa.id}`] : [])]);
  return (snapshot?.tasks ?? [])
    .filter((task) => task.status === "pending" && task.blockedBy.some((value) => references.has(value) || (task.job === qa.job && local.has(value))))
    .map((task: TaskRecord) => ({ job: task.job, id: task.id, name: task.name, title: task.title ?? task.name, path: task.path }));
}

function openForm(state: UiState, context: KeyContext, then: "answer" | "move"): KeyResult {
  const record = context.selected?.record;
  if (!record) return done(state);
  if (then === "answer") {
    return done({ ...state, mode: { kind: "answer", target: targetOf(record), editor: emptyEditor, focus: "editor", discard: undefined, error: undefined, latest: undefined } });
  }
  const current = statusOrder.task.indexOf(record.status ?? "");
  const form: MoveForm = {
    kind: "move",
    target: targetOf(record),
    stage: "status",
    index: Math.max(0, current),
    blocked: record.kind === "task" && record.status === "pending" ? record.blockedBy.join(", ") : "",
    checked: false,
    focus: "ok",
    blockers: [],
    error: undefined,
    latest: undefined,
  };
  return done({ ...state, mode: form });
}

// a / m。対象を確かめ、回答者が未設定なら先に入力してもらう
export function startAction(state: UiState, context: KeyContext, action: "answer" | "move"): KeyResult {
  if (!state.writable) return done({ ...state, notice: "このプロジェクトの scripts/ は更新操作 (guarded-write-v1) に対応していません。scripts/ を更新してください" });
  const record = context.selected?.record;
  if (action === "answer") {
    if (state.tab !== "qa" || !record || record.kind !== "qa") return done({ ...state, notice: "QA の一覧 (2) で回答する QA を選んでから a を押してください" });
    if (record.status !== "unresolved") return done({ ...state, notice: "回答できるのは unresolved の QA です (再オープンは raprid qa move で行います)" });
  } else if (state.tab !== "task" || !record || record.kind !== "task") {
    return done({ ...state, notice: "タスクの一覧 (1) で対象を選んでから m を押してください" });
  } else if (!statusOrder.task.includes(record.status ?? "")) {
    return done({ ...state, notice: "状態が不明なタスクは変更できません (index.md を確認してください)" });
  }
  if (record.revision === null || record.id === null) return done({ ...state, notice: "ID か内容を読み取れない項目は変更できません (要確認を確認してください)" });
  if (state.actor === null) return done({ ...state, mode: { kind: "actor", draft: "", error: undefined, then: action } });
  return openForm(state, context, action);
}

function typedLine(input: string): string {
  return sanitize(normalizeInput(input)).replace(/\n/g, "");
}

function withoutLast(value: string): string {
  const parts = graphemes(value);
  parts.pop();
  return parts.join("");
}

function answerKey(state: UiState, form: AnswerForm, input: string, key: KeyInput): KeyResult {
  const set = (next: Partial<AnswerForm>) => done({ ...state, mode: { ...form, ...next } });
  // 破棄の確認
  if (form.discard) {
    if (input === "y") return form.discard === "exit" ? done(normal(state), "exit") : done(normal(state, "回答を破棄しました"));
    if (input === "n" || key.escape) return set({ discard: undefined });
    return done(state);
  }
  const cancel = (exit: boolean): KeyResult => {
    if (editorIsBlank(form.editor)) return exit ? done(normal(state), "exit") : done(normal(state));
    return set({ discard: exit ? "exit" : "cancel" });
  };
  if (key.ctrl && input === "c") return cancel(true);
  if (key.escape) return cancel(false);
  if (key.tab) {
    const order = ["editor", "save", "cancel"] as const;
    const index = order.indexOf(form.focus);
    return set({ focus: order[(index + (key.shift ? order.length - 1 : 1)) % order.length] });
  }
  if (form.focus !== "editor") {
    if (key.leftArrow || key.rightArrow) return set({ focus: form.focus === "save" ? "cancel" : "save" });
    if (!key.return) return done(state);
    if (form.focus === "cancel") return cancel(false);
    if (editorIsBlank(form.editor)) return set({ error: "回答が空です", focus: "editor" });
    if (Buffer.byteLength(editorText(form.editor), "utf8") > answerLimit) return set({ error: "回答が大きすぎます (1 MiB まで)" });
    return done({ ...state, mode: { kind: "answerConfirm", form: { ...form, error: undefined }, focus: "ok" } });
  }
  let editor = form.editor;
  if (key.return) editor = newline(editor);
  else if (key.backspace || key.delete) editor = backspace(editor);
  else if (key.leftArrow) editor = moveCursor(editor, "left");
  else if (key.rightArrow) editor = moveCursor(editor, "right");
  else if (key.upArrow) editor = moveCursor(editor, "up");
  else if (key.downArrow) editor = moveCursor(editor, "down");
  else if (key.home) editor = moveCursor(editor, "home");
  else if (key.end) editor = moveCursor(editor, "end");
  else if (input && !key.ctrl && !key.meta) editor = insertText(editor, input); // q・a・m なども文字として入れる
  else return done(state);
  return set({ editor, error: undefined });
}

export function pasteIntoForm(state: UiState, text: string): UiState {
  const mode = state.mode;
  if (mode.kind === "answer" && mode.focus === "editor" && !mode.discard) return { ...state, mode: { ...mode, editor: insertText(mode.editor, text), error: undefined } };
  if (mode.kind === "actor") return { ...state, mode: { ...mode, draft: mode.draft + typedLine(text), error: undefined } };
  if (mode.kind === "move" && mode.stage === "blocked") return { ...state, mode: { ...mode, blocked: mode.blocked + typedLine(text), error: undefined } };
  return state;
}

function moveKey(state: UiState, form: MoveForm, input: string, key: KeyInput, context: KeyContext): KeyResult {
  const set = (next: Partial<MoveForm>) => done({ ...state, mode: { ...form, ...next } });
  const statuses = statusOrder.task;
  if (form.stage === "status") {
    if (key.escape) return done(normal(state));
    if (key.upArrow || key.downArrow) return set({ index: Math.min(statuses.length - 1, Math.max(0, form.index + (key.upArrow ? -1 : 1))), error: undefined });
    if (!key.return) return done(state);
    const status = statuses[form.index];
    if (status === form.target.status && status !== "pending") return set({ error: "現在と同じ状態です" });
    if (status === "pending") return set({ stage: "blocked", error: undefined });
    const leaving = form.target.status === "pending";
    return set({ stage: "confirm", checked: false, focus: "ok", blockers: leaving ? blockersOf(context.snapshot, form.target.job, form.target.blockedBy) : [], error: undefined });
  }
  if (form.stage === "blocked") {
    if (key.escape) return set({ stage: "status" });
    if (key.return) {
      const blocked = form.blocked.trim();
      if (blocked === "") return set({ error: "pending には待っている相手 (qa/Q-001、task/T-001、other: …) が必要です" });
      return set({ stage: "confirm", blocked, checked: false, focus: "ok", blockers: [], error: undefined });
    }
    if (key.backspace || key.delete) return set({ blocked: withoutLast(form.blocked) });
    if (input && !key.ctrl && !key.meta && !key.tab) return set({ blocked: form.blocked + typedLine(input), error: undefined });
    return done(state);
  }
  // confirm
  if (key.escape) return set({ stage: statuses[form.index] === "pending" ? "blocked" : "status", error: undefined });
  if (key.tab || key.leftArrow || key.rightArrow) return set({ focus: form.focus === "ok" ? "back" : "ok" });
  if (input === " ") return set({ checked: !form.checked, error: undefined });
  if (!key.return) return done(state);
  if (form.focus === "back") return set({ stage: statuses[form.index] === "pending" ? "blocked" : "status", error: undefined });
  const status = statuses[form.index];
  if (form.blockers.some((blocker) => blocker.state === "unresolved" || blocker.state === "missing")) {
    return set({ error: "未解決・見つからない QA を待っているため解除できません。QA を解決してから変更してください" });
  }
  if (needsCheck(form) && !form.checked) return set({ error: "Space で確認欄に印を付けてから変更してください" });
  const request: WriteRequest = { type: "move", target: form.target, status, blockedBy: status === "pending" ? form.blocked : undefined, actor: state.actor! };
  return done({ ...state, mode: { kind: "saving", request, resume: form, exitRequested: false } }, { kind: "write", request });
}

// done への変更と、QA 以外の待ちの解除は、利用者が確認したことを明示してもらう
export function needsCheck(form: MoveForm): boolean {
  return statusOrder.task[form.index] === "done" || form.blockers.some((blocker) => blocker.state === "other");
}

export function handleFormKey(state: UiState, input: string, key: KeyInput, context: KeyContext): KeyResult {
  const mode = state.mode;
  switch (mode.kind) {
    case "saving":
      if ((key.ctrl && input === "c") || input === "q") return done({ ...state, mode: { ...mode, exitRequested: true }, notice: "保存が終わってから終了します" });
      return done(state);
    case "actor": {
      if (key.ctrl && input === "c") return done(state, "exit");
      if (key.escape) return done(normal(state));
      if (key.return) {
        const actor = mode.draft.trim();
        if (!actorPattern.test(actor)) return done({ ...state, mode: { ...mode, error: "human/<識別子> (英小文字・数字・. _ -) の形で入力してください" } });
        return openForm({ ...state, actor, mode: { kind: "normal" } }, context, mode.then);
      }
      if (key.backspace || key.delete) return done({ ...state, mode: { ...mode, draft: withoutLast(mode.draft) } });
      if (input && !key.ctrl && !key.meta && !key.tab) return done({ ...state, mode: { ...mode, draft: mode.draft + typedLine(input), error: undefined } });
      return done(state);
    }
    case "answer":
      return answerKey(state, mode, input, key);
    case "answerConfirm": {
      if (key.ctrl && input === "c") return done({ ...state, mode: { ...mode.form, discard: "exit" } });
      if (key.escape) return done({ ...state, mode: mode.form });
      if (key.tab || key.leftArrow || key.rightArrow) return done({ ...state, mode: { ...mode, focus: mode.focus === "ok" ? "back" : "ok" } });
      if (!key.return) return done(state);
      if (mode.focus === "back") return done({ ...state, mode: mode.form });
      const request: WriteRequest = { type: "answer", target: mode.form.target, answer: editorText(mode.form.editor), actor: state.actor! };
      return done({ ...state, mode: { kind: "saving", request, resume: mode.form, exitRequested: false } }, { kind: "write", request });
    }
    case "move":
      if (key.ctrl && input === "c") return done(state, "exit");
      return moveKey(state, mode, input, key, context);
    case "resumeList": {
      if (key.ctrl && input === "c") return done(state, "exit");
      if (key.escape || input === "q") return done(normal(state));
      if (key.upArrow || key.downArrow) return done({ ...state, mode: { ...mode, index: Math.min(mode.tasks.length - 1, Math.max(0, mode.index + (key.upArrow ? -1 : 1))) } });
      if (key.return) {
        const task = mode.tasks[mode.index];
        if (!task) return done(normal(state));
        // 一覧でそのタスクを選ぶ。再開は m で明示的に行う
        const key = task.id === null ? `path\u0000${task.path}` : `${task.job}\u0000task\u0000${task.id}`;
        return done({
          ...state,
          tab: "task",
          job: state.job === null || state.job === task.job ? state.job : null,
          focus: "list",
          selection: { ...state.selection, task: { key, index: 0 } },
          mode: { kind: "normal" },
          notice: `${task.id ?? task.name} を選びました。再開するには m で状態を変更してください`,
        });
      }
      return done(state);
    }
    default:
      return done(state);
  }
}

export type WriteOutcome =
  | { ok: true; result: WriteResult; confirmed?: boolean } // confirmed: 結果が不明だったが再取得で保存を確かめた
  | { ok: false; code: string; message: string; latest?: ItemRecord };

// 保存の結果を画面に反映する。失敗したら入力を残してフォームへ戻す (自動で再送しない)
export function applyWriteOutcome(state: UiState, outcome: WriteOutcome, snapshot: Snapshot | undefined): KeyResult {
  const mode = state.mode;
  if (mode.kind !== "saving") return done(state);
  const request = mode.request;
  const name = label(request.target);
  if (outcome.ok) {
    const suffix = outcome.confirmed ? " (応答は不明でしたが、再取得して保存を確かめました)" : "";
    if (request.type === "answer") {
      const waiting = waitingFor(snapshot, { job: request.target.job, id: request.target.id, name: request.target.name });
      const notice = `${name} に回答しました (回答者 ${request.actor})${suffix}`;
      const next: UiState = waiting.length > 0 && !mode.exitRequested ? { ...state, mode: { kind: "resumeList", qa: name, tasks: waiting, index: 0 }, notice } : normal(state, notice);
      return mode.exitRequested ? done(next, "refresh", "exit") : done(next, "refresh");
    }
    const next = normal(state, `${name} を ${request.status} にしました${suffix}`);
    return mode.exitRequested ? done(next, "refresh", "exit") : done(next, "refresh");
  }
  const latest = outcome.latest ? latestLines(outcome.latest) : undefined;
  const conflict = outcome.code === "REVISION_CONFLICT";
  const message = conflict ? "他の変更と競合したため保存しませんでした。最新の内容を下に表示しています。確認してから保存し直してください" : `保存できませんでした: ${sanitize(outcome.message)}`;
  // 競合したときは最新の revision で保存し直せるようにする (入力はそのまま。送り直すのは利用者)
  const target = conflict && outcome.latest?.revision ? { ...request.target, revision: outcome.latest.revision, status: outcome.latest.status, blockedBy: outcome.latest.kind === "task" ? outcome.latest.blockedBy : [] } : request.target;
  const resume = mode.resume.kind === "answer" ? { ...mode.resume, target, error: message, latest, focus: "editor" as const } : { ...mode.resume, target, error: message, latest, stage: "confirm" as const };
  const cancelled = mode.exitRequested ? "。保存に失敗したため終了を取り消しました" : "";
  return done({ ...state, mode: resume, notice: mode.exitRequested ? `終了を取り消しました${cancelled}` : undefined }, "refresh");
}

function latestLines(record: ItemRecord): string[] {
  const lines = [`最新の状態: ${record.status ?? "未設定"} (更新 ${record.updatedAt ?? "-"})`];
  if (record.kind === "qa") {
    lines.push(`回答者: ${record.answeredBy ?? "-"}`);
    if (record.answer) lines.push("回答:", ...sanitize(record.answer, true).split("\n").slice(0, 8));
  } else {
    lines.push(`待ち: ${record.blockedBy.length > 0 ? record.blockedBy.join(", ") : "-"}`);
  }
  return lines;
}

// 結果が分からない失敗 (応答が壊れた等) で、実体を読み直すと保存できていたか
export function writeConfirmed(request: WriteRequest, latest: ItemRecord): boolean {
  if (request.type === "answer") {
    // scripts/ は改行を LF にそろえ、末尾の空白を落として保存する
    const expected = request.answer.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
    return latest.kind === "qa" && latest.status === "resolved" && latest.answer === expected && latest.answeredBy === request.actor;
  }
  return latest.kind === "task" && latest.status === request.status && (request.blockedBy === undefined ? latest.blockedBy.length === 0 : latest.blockedBy.join(", ") === request.blockedBy);
}

// scripts/ が変更前に拒否したことが分かっている失敗 (読み直して確かめる必要がない)
export const knownRejections = new Set(["REVISION_CONFLICT", "BLOCKED_BY_QA", "BLOCKED_BY_UNREADABLE", "DEPENDENCY_CHANGED", "INVALID_ANSWER", "USAGE", "NOT_FOUND", "JOB_NOT_FOUND", "FAILED"]);
