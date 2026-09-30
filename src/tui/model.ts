// TUI の画面状態とキー操作。Ink に依存しない純粋な関数にして、単体で試験する。

import { handleFormKey, startAction } from "./actions.js";
import type { EditorState } from "./editor.js";
import type { DetailState } from "./stores.js";
import { bodyOf, graphemes, type Line, markdownLines, sanitize } from "./text.js";
import { type Issue, type ItemRecord, type Kind, type Snapshot, statusOrder, type TaskRecord } from "./types.js";
import { isWorkflowTask, legacyStatusOf, type StepKind, statusText as workflowStatusText, workflowDetail, type WorkflowStep } from "./workflow.js";

export type Tab = "task" | "qa" | "issues";
export type Panel = "jobs" | "list" | "detail";
export type Layout = "wide" | "medium" | "narrow" | "tooSmall";

export const minColumns = 40;
export const minRows = 12;

export function layoutFor(columns: number, rows: number): Layout {
  if (columns < minColumns || rows < minRows) return "tooSmall";
  if (columns >= 120) return "wide";
  if (columns >= 80) return "medium";
  return "narrow";
}

// 更新の対象。revision は開いた時点のもので、保存時に --if-match として渡す
export interface WriteTarget {
  kind: Kind;
  job: string;
  id: string | null;
  name: string;
  path: string;
  revision: string;
  title: string;
  status: string | null;
  blockedBy: string[];
  history: number; // 工程型タスクの履歴の件数 (結果が分からない失敗のときに、保存できていたかを確かめる)
  phase?: string | null; // 工程型タスクの開いた時点の工程
}

export type WriteRequest =
  | { type: "answer"; target: WriteTarget; answer: string; actor: string }
  | { type: "move"; target: WriteTarget; status: string; blockedBy: string[] | undefined; actor: string }
  | { type: "workflow"; target: WriteTarget; kind: StepKind; step: WorkflowStep; actor: string };

export interface Blocker {
  reference: string;
  state: "resolved" | "unresolved" | "missing" | "other";
}

export interface WaitingTask {
  job: string;
  id: string | null;
  name: string;
  title: string;
  path: string;
}

export interface AnswerForm {
  kind: "answer";
  target: WriteTarget;
  editor: EditorState;
  focus: "editor" | "save" | "cancel";
  discard: "cancel" | "exit" | undefined; // 破棄の確認中 (exit は Ctrl+C から)
  error: string | undefined;
  latest: string[] | undefined; // 競合・失敗の後に読み直した最新の内容
}

export interface MoveForm {
  kind: "move";
  target: WriteTarget;
  stage: "status" | "blocked" | "confirm";
  index: number; // 遷移先 (statusOrder.task の位置)
  blocked: EditorState; // pending の待ち理由 (1 行に 1 件。カンマで分けない)
  blockedFocus: "editor" | "next" | "back";
  checked: boolean; // done・QA 以外の待ちの解除を確認した
  focus: "ok" | "back";
  blockers: Blocker[];
  error: string | undefined;
  latest: string[] | undefined;
}

// 工程型タスクの工程の操作 (m)。操作の選択 → 入力 → 確認 (受入確認は根拠を示して確認欄に印を付ける) → 保存
export interface StepField {
  key: "handoff" | "artifacts" | "commits" | "report" | "returnTo" | "reason" | "blockedBy" | "phase" | "assignee";
  label: string;
  kind: "line" | "lines" | "choice";
  required: boolean;
  editor: EditorState;
  choices?: string[];
  choice?: number;
  hint?: string;
}

export interface StepForm {
  kind: "step";
  stage: "menu" | "edit" | "confirm";
  target: WriteTarget;
  record: TaskRecord; // 開いた時点の記録 (受入確認の根拠の表示に使う)
  steps: StepKind[];
  index: number; // 操作の一覧の選択
  step: StepKind | undefined;
  fields: StepField[];
  focus: number; // 入力欄の位置。fields.length は「次へ」、fields.length + 1 は「戻る」
  checked: boolean; // 受入確認の確認欄
  evidenceScroll: number; // 受入確認の根拠のスクロール位置
  evidenceSeen: boolean; // 受入確認の根拠を最後まで表示した (印を付けられる)
  confirmFocus: "ok" | "back";
  error: string | undefined;
  latest: string[] | undefined;
}

export type Mode =
  | { kind: "normal" }
  | { kind: "search"; draft: string; before: string }
  | { kind: "jobPicker"; index: number }
  | { kind: "filter"; index: number; draft: string[] }
  | { kind: "help" }
  | { kind: "actor"; draft: string; error: string | undefined; then: "answer" | "move" }
  | AnswerForm
  | { kind: "answerConfirm"; form: AnswerForm; focus: "ok" | "back" }
  | MoveForm
  | StepForm
  | { kind: "saving"; request: WriteRequest; resume: AnswerForm | MoveForm | StepForm; exitRequested: boolean }
  | { kind: "resumeList"; qa: string; tasks: WaitingTask[]; index: number };

const formModes = new Set(["actor", "answer", "answerConfirm", "move", "step", "saving", "resumeList"]);

export function inForm(state: UiState): boolean {
  return formModes.has(state.mode.kind);
}

export interface Selection {
  key: string | null;
  index: number;
}

export interface UiState {
  job: string | null; // null は全案件
  tab: Tab;
  focus: Panel;
  search: string;
  showAll: boolean; // 完了済み (done / resolved) も表示する
  filters: Record<Kind, string[] | null>; // null は既定 (showAll に従う)
  selection: Record<Tab, Selection>;
  detailScroll: number;
  narrowDetail: boolean; // 40〜79 桁で詳細を全面に出している
  mode: Mode;
  notice: string | undefined;
  actor: string | null; // 更新する人 (human/<識別子>)。--actor か最初の更新時の入力で決め、セッション中だけ保つ
  writable: boolean; // scripts/ が guarded-write-v1 に対応している
  workflow: boolean; // scripts/ が query-v2・workflow-v3 に対応している (工程型タスクの操作ができる)
  readyQueue: boolean; // ready の工程だけを出す (w)
}

export function initialState(job: string | null = null, options: { actor?: string | null; writable?: boolean; workflow?: boolean } = {}): UiState {
  const empty = { key: null, index: 0 };
  return {
    job,
    tab: "task",
    focus: "list",
    search: "",
    showAll: false,
    filters: { task: null, qa: null },
    selection: { task: empty, qa: empty, issues: empty },
    detailScroll: 0,
    narrowDetail: false,
    mode: { kind: "normal" },
    notice: undefined,
    actor: options.actor ?? null,
    writable: options.writable ?? false,
    workflow: options.workflow ?? false,
    readyQueue: false,
  };
}

export interface Row {
  key: string;
  record?: ItemRecord;
  issue?: Issue;
}

// 案件 + 種類 + ID で識別する。ID が無い・重複しているものは path で識別する
const keyCache = new WeakMap<Snapshot, Map<ItemRecord, string>>();

export function recordKey(snapshot: Snapshot, record: ItemRecord): string {
  let keys = keyCache.get(snapshot);
  if (!keys) {
    keys = new Map();
    const counts = new Map<string, number>();
    const idKey = (item: ItemRecord) => `${item.job}\u0000${item.kind}\u0000${item.id}`;
    const all: ItemRecord[] = [...snapshot.tasks, ...snapshot.qas];
    for (const item of all) if (item.id !== null) counts.set(idKey(item), (counts.get(idKey(item)) ?? 0) + 1);
    for (const item of all) keys.set(item, item.id !== null && counts.get(idKey(item)) === 1 ? idKey(item) : `path\u0000${item.path}`);
    keyCache.set(snapshot, keys);
  }
  return keys.get(record) ?? `path\u0000${record.path}`;
}

export function issueKey(issue: Issue): string {
  return `issue\u0000${issue.job}\u0000${issue.code}\u0000${issue.path}\u0000${issue.message}`;
}

export function defaultStatuses(kind: Kind): string[] {
  return kind === "task" ? ["progress", "todo", "pending"] : ["unresolved"];
}

// 工程型タスクは、今の工程の状態を旧形式の状態 (progress・todo・pending・done) に当てはめて絞り込む (closed は done)
function statusForFilter(record: ItemRecord): string | null {
  return record.kind === "task" ? legacyStatusOf(record) : record.status;
}

function visibleStatus(kind: Kind, status: string | null, state: Pick<UiState, "showAll" | "filters">): boolean {
  if (status === null || !statusOrder[kind].includes(status)) return true; // 未知の状態は隠さない
  const filter = state.filters[kind];
  if (filter) return filter.includes(status);
  return state.showAll || defaultStatuses(kind).includes(status);
}

function matches(values: (string | null)[], search: string): boolean {
  if (search === "") return true;
  const needle = search.toLowerCase();
  return values.some((value) => value !== null && value.toLowerCase().includes(needle));
}

export function rowsFor(snapshot: Snapshot | undefined, state: Pick<UiState, "job" | "tab" | "search" | "showAll" | "filters"> & Partial<Pick<UiState, "readyQueue" | "actor">>): Row[] {
  if (!snapshot) return [];
  const inScope = (job: string) => state.job === null || job === state.job;
  if (state.tab === "issues") {
    return snapshot.issues
      .filter((issue) => inScope(issue.job) && matches([issue.message, issue.code, issue.path, issue.id], state.search))
      .map((issue) => ({ key: issueKey(issue), issue }));
  }
  const records: ItemRecord[] = state.tab === "task" ? snapshot.tasks : snapshot.qas;
  const searched = records
    .filter((record) => inScope(record.job))
    .filter((record) => matches([record.id, record.name, record.title, record.kind === "qa" ? record.question : null], state.search));
  if (state.tab === "task" && state.readyQueue) {
    // ready の一覧: 今の工程が ready の工程型タスク。状態の絞り込み (f・v) には左右されない (R15-2)。担当が自分・未割当のものを先に出す
    const ready = searched.filter((record) => record.kind === "task" && isWorkflowTask(record) && record.status === "open" && record.phaseStatus === "ready") as TaskRecord[];
    const rank = (record: TaskRecord) => (record.assignee === state.actor && state.actor !== null ? 0 : record.assignee === null || record.assignee === undefined ? 1 : 2);
    return ready
      .map((record, order) => ({ record, order }))
      .sort((a, b) => rank(a.record) - rank(b.record) || a.order - b.order)
      .map(({ record }) => ({ key: recordKey(snapshot, record), record }));
  }
  return searched.filter((record) => visibleStatus(record.kind, statusForFilter(record), state)).map((record) => ({ key: recordKey(snapshot, record), record }));
}

export function unresolvedCount(snapshot: Snapshot | undefined, job: string | null): number {
  if (!snapshot) return 0;
  return snapshot.qas.filter((qa) => (job === null || qa.job === job) && qa.status === "unresolved").length;
}

export function selectedIndex(state: UiState, rows: Row[]): number {
  if (rows.length === 0) return -1;
  const selection = state.selection[state.tab];
  const found = selection.key === null ? -1 : rows.findIndex((row) => row.key === selection.key);
  return found >= 0 ? found : Math.min(Math.max(0, selection.index), rows.length - 1);
}

// 選択していた項目が一覧から消えたとき、近くの項目へ移す。snapshot からも消えていれば知らせる
export function reconcile(state: UiState, rows: Row[], snapshot: Snapshot | undefined): UiState {
  const selection = state.selection[state.tab];
  if (rows.length === 0 || selection.key === null || rows.some((row) => row.key === selection.key)) {
    if (rows.length > 0 && selection.key === null) return withSelection(state, 0, rows);
    return state;
  }
  const index = selectedIndex(state, rows);
  const stillExists =
    snapshot !== undefined &&
    (state.tab === "issues"
      ? snapshot.issues.some((issue) => issueKey(issue) === selection.key)
      : [...snapshot.tasks, ...snapshot.qas].some((record) => recordKey(snapshot, record) === selection.key));
  const next = withSelection(state, index, rows);
  return stillExists ? next : { ...next, notice: "選択していた項目が無くなったため、近くの項目を選択しました" };
}

function withSelection(state: UiState, index: number, rows: Row[]): UiState {
  const clamped = Math.min(Math.max(0, index), Math.max(0, rows.length - 1));
  return { ...state, selection: { ...state.selection, [state.tab]: { key: rows[clamped]?.key ?? null, index: clamped } }, detailScroll: 0 };
}

export interface KeyInput {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  backspace?: boolean;
  delete?: boolean;
}

export interface KeyContext {
  rows: Row[];
  selected?: Row;
  snapshot?: Snapshot;
  jobs: string[];
  layout: Layout;
  detailHeight: number; // 詳細の表示行数
  detailLength: number; // 詳細の総行数
  formWidth?: number; // フォームの幅・高さ (受入確認の根拠のスクロールに使う。省略は 80x24)
  formHeight?: number;
}

export type Effect = "exit" | "refresh" | { kind: "write"; request: WriteRequest };

export interface KeyResult {
  state: UiState;
  effects: Effect[];
}

export function panelsFor(layout: Layout, state: UiState): Panel[] {
  if (layout === "wide") return ["jobs", "list", "detail"];
  if (layout === "medium") return ["list", "detail"];
  return [state.narrowDetail ? "detail" : "list"];
}

function scrolled(state: UiState, delta: number, context: KeyContext): UiState {
  const max = Math.max(0, context.detailLength - context.detailHeight);
  return { ...state, detailScroll: Math.min(max, Math.max(0, state.detailScroll + delta)) };
}

// 入力欄に入れる文字。制御文字と改行は入れない
function typed(input: string): string {
  return sanitize(input).replace(/\n/g, "");
}

function withoutLast(value: string): string {
  const parts = graphemes(value);
  parts.pop();
  return parts.join("");
}

export function handleKey(state: UiState, input: string, key: KeyInput, context: KeyContext): KeyResult {
  const done = (next: UiState, ...effects: Effect[]): KeyResult => ({ state: next, effects });
  // 保存中は終了を後回しにする。入力中の回答は Ctrl+C でも破棄の確認を出す
  if (inForm(state)) {
    if (context.layout === "tooSmall" && !(key.ctrl && input === "c") && state.mode.kind !== "saving") return done(state);
    return handleFormKey(state, input, key, context);
  }
  if (key.ctrl && input === "c") return done(state, "exit");
  // 小さすぎる端末では q だけを受け付け、状態は変えない
  if (context.layout === "tooSmall") return state.mode.kind === "normal" && input === "q" ? done(state, "exit") : done(state);
  const mode = state.mode;
  const rows = context.rows;

  if (mode.kind === "search") {
    if (key.escape) return done({ ...state, search: mode.before, mode: { kind: "normal" } });
    if (key.return) return done({ ...state, mode: { kind: "normal" }, notice: undefined });
    let draft = mode.draft;
    if (key.backspace || key.delete) draft = withoutLast(draft);
    else if (input && !key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow) draft += typed(input);
    else return done(state);
    const next: UiState = { ...state, search: draft, mode: { ...mode, draft } };
    return done({ ...next, selection: { ...next.selection, [state.tab]: { key: null, index: 0 } }, detailScroll: 0 });
  }

  if (mode.kind === "jobPicker") {
    const options: (string | null)[] = [null, ...context.jobs];
    if (key.escape) return done({ ...state, mode: { kind: "normal" } });
    if (key.upArrow || key.downArrow) {
      const index = Math.min(options.length - 1, Math.max(0, mode.index + (key.upArrow ? -1 : 1)));
      return done({ ...state, mode: { ...mode, index } });
    }
    if (key.return) {
      const job = options[mode.index] ?? null;
      const reset = { key: null, index: 0 };
      return done({ ...state, job, mode: { kind: "normal" }, selection: { task: reset, qa: reset, issues: reset }, detailScroll: 0, notice: undefined });
    }
    return done(state);
  }

  if (mode.kind === "filter") {
    const kind = state.tab as Kind;
    const statuses = statusOrder[kind];
    if (key.escape) return done({ ...state, mode: { kind: "normal" } });
    if (key.upArrow || key.downArrow) {
      const index = Math.min(statuses.length - 1, Math.max(0, mode.index + (key.upArrow ? -1 : 1)));
      return done({ ...state, mode: { ...mode, index } });
    }
    if (input === " ") {
      const status = statuses[mode.index];
      const draft = mode.draft.includes(status) ? mode.draft.filter((value) => value !== status) : statuses.filter((value) => value === status || mode.draft.includes(value));
      return done({ ...state, mode: { ...mode, draft } });
    }
    if (key.return) {
      return done({ ...state, filters: { ...state.filters, [kind]: mode.draft.length > 0 ? mode.draft : null }, mode: { kind: "normal" }, detailScroll: 0, notice: undefined });
    }
    return done(state);
  }

  if (mode.kind === "help") {
    if (key.escape || input === "?" || input === "q") return done({ ...state, mode: { kind: "normal" } });
    return done(state);
  }

  // 通常の操作
  const panels = panelsFor(context.layout, state);
  const focus = panels.includes(state.focus) ? state.focus : panels.includes("list") ? "list" : panels[0];
  if (input === "q") return done(state, "exit");
  if (input === "?") return done({ ...state, mode: { kind: "help" } });
  if (input === "/") return done({ ...state, mode: { kind: "search", draft: state.search, before: state.search } });
  if (input === "g") return done({ ...state, mode: { kind: "jobPicker", index: state.job === null ? 0 : Math.max(0, context.jobs.indexOf(state.job) + 1) } });
  if (input === "f") {
    if (state.tab === "issues") return done({ ...state, notice: "要確認には状態の絞り込みがありません" });
    const kind = state.tab;
    return done({ ...state, mode: { kind: "filter", index: 0, draft: state.filters[kind] ?? (state.showAll ? [...statusOrder[kind]] : defaultStatuses(kind)) } });
  }
  if (input === "w") {
    if (!state.workflow) return done({ ...state, notice: "このプロジェクトの scripts/ は工程型タスク (workflow-v3) に対応していません" });
    const readyQueue = !state.readyQueue;
    return done({ ...state, tab: "task", readyQueue, selection: { ...state.selection, task: { key: null, index: 0 } }, notice: readyQueue ? "ready の工程だけを表示します (自分・未割当が上)" : "ready の一覧を閉じました" });
  }
  if (input === "v") {
    const showAll = !state.showAll;
    return done({ ...state, showAll, notice: showAll ? "完了済みも表示します" : "完了済みを隠します" });
  }
  if (input === "r") return done({ ...state, notice: undefined }, "refresh");
  if (input === "a") return startAction(state, context, "answer");
  if (input === "m") return startAction(state, context, "move");
  if (input === "1" || input === "2" || input === "3") {
    const tab: Tab = input === "1" ? "task" : input === "2" ? "qa" : "issues";
    return done({ ...state, tab, focus: focus === "jobs" ? "jobs" : "list", narrowDetail: false, detailScroll: 0 });
  }
  if (key.tab) {
    if (panels.length < 2) return done(state);
    const index = panels.indexOf(focus);
    const next = panels[(index + (key.shift ? panels.length - 1 : 1)) % panels.length];
    return done({ ...state, focus: next });
  }
  if (key.return) {
    if (focus === "jobs") return done({ ...state, focus: "list" });
    if (focus === "list" && rows.length > 0) {
      return done({ ...state, focus: "detail", narrowDetail: context.layout === "narrow" });
    }
    return done(state);
  }
  if (key.escape) {
    if (state.narrowDetail) return done({ ...state, narrowDetail: false, focus: "list" });
    if (focus === "detail") return done({ ...state, focus: "list" });
    return done({ ...state, notice: undefined });
  }
  if (key.pageUp || key.pageDown) return done(scrolled(state, (key.pageUp ? -1 : 1) * Math.max(1, context.detailHeight - 1), context));
  if (key.upArrow || key.downArrow || key.home || key.end) {
    const delta = key.upArrow ? -1 : 1;
    if (focus === "detail") {
      if (key.home) return done({ ...state, detailScroll: 0 });
      if (key.end) return done(scrolled(state, context.detailLength, context));
      return done(scrolled(state, delta, context));
    }
    if (focus === "jobs") {
      const options: (string | null)[] = [null, ...context.jobs];
      const current = state.job === null ? 0 : Math.max(0, options.indexOf(state.job));
      const target = key.home ? 0 : key.end ? options.length - 1 : Math.min(options.length - 1, Math.max(0, current + delta));
      const reset = { key: null, index: 0 };
      return done({ ...state, job: options[target] ?? null, selection: { task: reset, qa: reset, issues: reset }, detailScroll: 0 });
    }
    if (rows.length === 0) return done(state);
    const current = selectedIndex(state, rows);
    const target = key.home ? 0 : key.end ? rows.length - 1 : current + delta;
    return done({ ...withSelection(state, target, rows), notice: undefined });
  }
  return done(state);
}

// 詳細パネルの内容。本文は show の結果、それ以外は snapshot から作る
export function detailLines(row: Row | undefined, detail: DetailState, snapshot: Snapshot | undefined): Line[] {
  if (!row) return [{ text: "項目がありません", dim: true }];
  if (row.issue) {
    const issue = row.issue;
    return [
      { text: `${issue.severity === "error" ? "エラー" : "警告"}  ${sanitize(issue.code)}`, bold: true, color: issue.severity === "error" ? "red" : "yellow" },
      { text: sanitize(issue.message) },
      { text: "" },
      { text: `案件  ${sanitize(issue.job)}` },
      { text: `種類  ${issue.kind}` },
      { text: `ID    ${issue.id === null ? "-" : sanitize(issue.id)}` },
      { text: `パス  ${sanitize(issue.path)}` },
    ];
  }
  const record = row.record!;
  const actor = (value: string | null) => (value === null ? "不明（旧記録）" : sanitize(value));
  const date = (value: string | null) => (value === null ? "-" : sanitize(value));
  const heading = record.kind === "task" && isWorkflowTask(record) ? workflowStatusText(record) : record.status === null ? "未設定" : sanitize(record.status);
  const lines: Line[] = [
    { text: `${record.id === null ? "ID未設定" : sanitize(record.id)}  ${heading}`, bold: true },
    { text: sanitize(record.title ?? record.name), bold: true },
    { text: "" },
    { text: `案件    ${sanitize(record.job)}` },
    { text: `パス    ${sanitize(record.path)}` },
    { text: `依頼    ${actor(record.requestedBy)}` },
    { text: `記録    ${actor(record.createdBy)}` },
  ];
  if (record.kind === "task" && isWorkflowTask(record)) lines.push(...workflowDetail(record));
  if (record.kind === "task") {
    lines.push({ text: `日付    作成 ${date(record.createdAt)} / 更新 ${date(record.updatedAt)} / 完了 ${date(record.completedAt)}` });
    lines.push({ text: `待ち    ${record.blockedBy.length > 0 ? record.blockedBy.map((value) => sanitize(value)).join(", ") : "-"}` });
  } else {
    lines.push({ text: `確認先  ${record.askTo === null ? "未設定" : sanitize(record.askTo)}` });
    lines.push({ text: `回答者  ${record.answeredBy === null ? "-" : actor(record.answeredBy)}` });
    lines.push({ text: `日付    作成 ${date(record.createdAt)} / 更新 ${date(record.updatedAt)} / 解決 ${date(record.resolvedAt)}` });
  }
  const issues = (snapshot?.issues ?? []).filter(
    (issue) => issue.job === record.job && issue.kind === record.kind && (issue.path === record.path || (record.id !== null && issue.id === record.id)),
  );
  if (issues.length > 0) {
    lines.push({ text: "" }, { text: `要確認 (${issues.length})`, bold: true, color: "yellow" });
    for (const issue of issues) lines.push({ text: `  ${sanitize(issue.message)}`, color: "yellow" });
  }
  lines.push({ text: "" });
  const sameTarget = detail.target?.path === record.path;
  if (sameTarget && detail.error) lines.push({ text: `詳細の取得に失敗しました: ${sanitize(detail.error.message)} (r で再取得)`, color: "red" });
  if (sameTarget && detail.result?.item.rawMarkdown) {
    if (!detail.current && detail.loading) lines.push({ text: "更新を読み込み中…", dim: true });
    lines.push(...markdownLines(bodyOf(detail.result.item.rawMarkdown)));
  } else if (!sameTarget || detail.loading) lines.push({ text: "読み込み中…", dim: true });
  else if (!detail.error) lines.push({ text: "(本文を読み取れません)", dim: true });
  return lines;
}
