// 工程型タスクの工程の操作のフォーム (m)。Ink に依存しない純粋な関数。T-015
//
// 操作の選択 → 入力 → 確認 → 保存。保存の前に必ず確認画面を通し、失敗・競合では入力を残して確認画面へ戻す (自動で再送しない)。
// 受入確認の判定 (受け入れる・差し戻す) は、実行の成果物・レビューの判定と記録・要件の版を示す別の確認画面で、
// 確認欄に印を付けてからでないと保存しない。旧形式の状態の選択は工程型タスクには出さない (承認を迂回できないように)。

import { backspace, editorIsBlank, type EditorState, editorText, emptyEditor, insertText, moveCursor, newline, normalizeInput } from "./editor.js";
import type { Effect, KeyContext, KeyInput, KeyResult, StepField, StepForm, UiState, WriteRequest, WriteTarget } from "./model.js";
import { sanitize, wrap } from "./text.js";
import type { ArtifactRef, TaskRecord } from "./types.js";
import { acceptanceEvidence, availableSteps, type ReturnTarget, type StepKind, stepLabel, type WorkflowPhase, workflowPhases, type WorkflowStep } from "./workflow.js";

const done = (state: UiState, ...effects: Effect[]): KeyResult => ({ state, effects });
const normal = (state: UiState, notice?: string): UiState => ({ ...state, mode: { kind: "normal" }, notice });

function line(key: StepField["key"], label: string, required: boolean, hint?: string, value = ""): StepField {
  return { key, label, kind: "line", required, editor: value === "" ? emptyEditor : { lines: [value], row: 0, col: [...value].length }, hint };
}

function lines(key: StepField["key"], label: string, required: boolean, hint?: string): StepField {
  return { key, label, kind: "lines", required, editor: emptyEditor, hint };
}

function choice(key: StepField["key"], label: string, choices: string[], index: number): StepField {
  return { key, label, kind: "choice", required: true, editor: emptyEditor, choices, choice: index };
}

// 操作ごとの入力欄
export function fieldsFor(kind: StepKind, record: TaskRecord): StepField[] {
  switch (kind) {
    case "claim":
    case "resume":
      return [];
    case "complete":
      return [
        line("handoff", "引継資料", true, "タスクのディレクトリの Markdown (「対象・成果物」「実施・検証」「未確認・制約」「次の担当への依頼」の節が必要)"),
        lines("artifacts", "成果物のパス", false, "1 行に 1 件 (タスクのディレクトリのファイル)"),
        lines("commits", "commit", false, "1 行に 1 件 (<repo>:<commit>)。実装の実行は成果物のパスか commit が必要"),
      ];
    case "approve":
      return [line("report", record.phase === "acceptance" ? "受入確認の記録" : "レビューの記録", true, "タスクのディレクトリの Markdown")];
    case "requestChanges":
      return [
        line("report", record.phase === "acceptance" ? "受入確認の記録" : "レビューの記録", true, "タスクのディレクトリの Markdown"),
        choice("returnTo", "戻す工程", ["execute", "plan"], 0),
        line("reason", "差し戻す理由", true),
      ];
    case "block":
      return [lines("blockedBy", "待っている相手", true, "1 行に 1 件 (qa/Q-001、task/T-001、other: …)"), line("reason", "理由", false)];
    case "reopen":
      return [choice("returnTo", "戻す工程", ["execute", "plan"], 0), line("reason", "やり直す理由", true)];
    case "assign": {
      const current = Math.max(0, workflowPhases.indexOf((record.phase ?? "plan") as WorkflowPhase));
      return [
        choice("phase", "工程", [...workflowPhases], current),
        line("assignee", "新しい担当", true, "human/<識別子> か agent/<識別子>"),
        line("reason", "理由", true),
        line("handoff", "引継資料", false, "作業中の工程の担当を替えるときは必要"),
      ];
    }
  }
}

function text(field: StepField | undefined): string {
  return field ? editorText(field.editor).trim() : "";
}

function list(field: StepField | undefined): string[] {
  return field ? [...new Set(editorText(field.editor).split("\n").map((value) => value.trim()).filter((value) => value !== ""))] : [];
}

function chosen(field: StepField | undefined): string {
  return field?.choices?.[field.choice ?? 0] ?? "";
}

// 入力から scripts/ に渡す操作を作る
export function buildStep(form: StepForm): WorkflowStep {
  const get = (key: StepField["key"]) => form.fields.find((field) => field.key === key);
  switch (form.step!) {
    case "claim":
      return { op: "claim" };
    case "resume":
      return { op: "resume" };
    case "complete":
      return { op: "complete", handoff: text(get("handoff")), artifacts: list(get("artifacts")), commits: list(get("commits")) };
    case "approve":
      return { op: "decide", outcome: "approved", report: text(get("report")) };
    case "requestChanges":
      return { op: "decide", outcome: "changes_requested", report: text(get("report")), returnTo: chosen(get("returnTo")) as ReturnTarget, reason: text(get("reason")) };
    case "block":
      return { op: "block", blockedBy: list(get("blockedBy")), reason: text(get("reason")) || undefined };
    case "reopen":
      return { op: "reopen", returnTo: chosen(get("returnTo")) as ReturnTarget, reason: text(get("reason")) };
    case "assign":
      return { op: "assign", phase: chosen(get("phase")) as WorkflowPhase, assignee: text(get("assignee")), reason: text(get("reason")), handoff: text(get("handoff")) || undefined };
  }
}

// 受入確認の判定 (人の最終確認) か
export function isAcceptanceDecision(form: StepForm): boolean {
  return (form.step === "approve" || form.step === "requestChanges") && form.record.phase === "acceptance";
}

export function openStepForm(state: UiState, record: TaskRecord, target: WriteTarget): KeyResult {
  const steps = availableSteps(record, state.actor);
  if (steps.length === 0) return done({ ...state, notice: "このタスクで今できる工程の操作はありません (形式に不整合があるか、担当が違います)" });
  const form: StepForm = { kind: "step", stage: "menu", target, record, steps, index: 0, step: undefined, fields: [], focus: 0, checked: false, evidenceScroll: 0, evidenceSeen: false, confirmFocus: "ok", error: undefined, latest: undefined };
  return done({ ...state, mode: form });
}

function missing(form: StepForm): string | undefined {
  for (const field of form.fields) {
    if (field.kind !== "choice" && field.required && editorIsBlank(field.editor)) return `${field.label}を入力してください`;
  }
  if (form.step === "assign") {
    const assignee = text(form.fields.find((field) => field.key === "assignee"));
    if (!/^(human|agent)\/[a-z0-9][a-z0-9._-]*$/.test(assignee)) return "新しい担当は human/<識別子> か agent/<識別子> で入力してください";
  }
  if (form.step === "complete") {
    const bad = list(form.fields.find((field) => field.key === "commits")).find((value) => !/^[A-Za-z0-9][A-Za-z0-9._-]*:[0-9a-f]{7,40}$/.test(value));
    if (bad) return `commit は <repo>:<commit> (7〜40 桁の小文字 16 進数) で入力してください: ${bad}`;
  }
  return undefined;
}

function editField(field: StepField, input: string, key: KeyInput): StepField | undefined {
  if (field.kind === "choice") {
    if (!key.leftArrow && !key.rightArrow && input !== " ") return undefined;
    const count = field.choices!.length;
    return { ...field, choice: ((field.choice ?? 0) + (key.leftArrow ? count - 1 : 1)) % count };
  }
  let editor: EditorState = field.editor;
  if (key.return && field.kind === "lines") editor = newline(editor);
  else if (key.backspace || key.delete) editor = backspace(editor);
  else if (key.leftArrow) editor = moveCursor(editor, "left");
  else if (key.rightArrow) editor = moveCursor(editor, "right");
  else if (key.upArrow && field.kind === "lines") editor = moveCursor(editor, "up");
  else if (key.downArrow && field.kind === "lines") editor = moveCursor(editor, "down");
  else if (key.home) editor = moveCursor(editor, "home");
  else if (key.end) editor = moveCursor(editor, "end");
  else if (input && !key.ctrl && !key.meta && !key.return) editor = insertText(editor, field.kind === "line" ? normalizeInput(input).replace(/\n/g, " ") : input);
  else return undefined;
  return { ...field, editor };
}

// 受入確認の根拠を、フォームの幅で折り返した表示行。画面 (forms.tsx) とキー操作で同じものを使う
export function evidenceRows(record: TaskRecord, formWidth: number): string[] {
  const inner = Math.max(10, formWidth - 2);
  return acceptanceEvidence(record).flatMap((line) => wrap(sanitize(line), inner));
}

// 根拠を出す行数 (枠・見出し・確認の内容 (最大 6 行)・位置の表示・確認欄・ボタン・エラーの分を除く)
export function evidenceWindow(formHeight: number): number {
  return Math.max(3, formHeight - 15);
}

// 確認画面に入るとき: 根拠が 1 画面に収まれば最初から「見た」とする
function enterConfirm(form: StepForm, context: KeyContext | undefined): Partial<StepForm> {
  const rows = evidenceRows(form.record, context?.formWidth ?? 80).length;
  return { stage: "confirm", checked: false, confirmFocus: "ok", error: undefined, evidenceScroll: 0, evidenceSeen: rows <= evidenceWindow(context?.formHeight ?? 24) };
}

export function stepKey(state: UiState, form: StepForm, input: string, key: KeyInput, context?: KeyContext): KeyResult {
  const set = (next: Partial<StepForm>) => done({ ...state, mode: { ...form, ...next } });
  if (key.ctrl && input === "c") return done(state, "exit");
  if (form.stage === "menu") {
    if (key.escape) return done(normal(state));
    if (key.upArrow || key.downArrow) return set({ index: Math.min(form.steps.length - 1, Math.max(0, form.index + (key.upArrow ? -1 : 1))), error: undefined });
    if (!key.return) return done(state);
    const step = form.steps[form.index];
    const fields = fieldsFor(step, form.record);
    if (fields.length === 0) return set({ step, fields, focus: 0, ...enterConfirm({ ...form, step }, context) });
    return set({ step, fields, focus: 0, stage: "edit", checked: false, confirmFocus: "ok", error: undefined });
  }
  if (form.stage === "edit") {
    const next = form.fields.length;
    const back = form.fields.length + 1;
    if (key.escape) return set({ stage: "menu", error: undefined });
    if (key.tab) return set({ focus: (form.focus + (key.shift ? back : 1)) % (back + 1) });
    if (form.focus >= next) {
      if (key.leftArrow || key.rightArrow) return set({ focus: form.focus === next ? back : next });
      if (!key.return) return done(state);
      if (form.focus === back) return set({ stage: "menu", error: undefined });
      const problem = missing(form);
      if (problem) return set({ error: problem });
      return set(enterConfirm(form, context));
    }
    const field = form.fields[form.focus];
    // 1 行の欄と選択の欄は Enter で次の欄へ
    if (key.return && field.kind !== "lines") return set({ focus: form.focus + 1 });
    const edited = editField(field, input, key);
    if (!edited) return done(state);
    return set({ fields: form.fields.map((item, index) => (index === form.focus ? edited : item)), error: undefined });
  }
  // confirm
  const acceptance = isAcceptanceDecision(form);
  const backStage = form.fields.length === 0 ? "menu" : "edit";
  if (key.escape) return set({ stage: backStage, error: undefined });
  if (key.tab || key.leftArrow || key.rightArrow) return set({ confirmFocus: form.confirmFocus === "ok" ? "back" : "ok" });
  if (acceptance && (key.upArrow || key.downArrow || key.pageUp || key.pageDown || key.home || key.end)) {
    // 根拠をスクロールする。最後まで表示したら確認欄に印を付けられる (R15-1)
    const rows = evidenceRows(form.record, context?.formWidth ?? 80).length;
    const window = evidenceWindow(context?.formHeight ?? 24);
    const max = Math.max(0, rows - window);
    const step = key.pageUp || key.pageDown ? Math.max(1, window - 1) : 1;
    const scroll = key.home ? 0 : key.end ? max : Math.min(max, Math.max(0, form.evidenceScroll + (key.upArrow || key.pageUp ? -step : step)));
    return set({ evidenceScroll: scroll, evidenceSeen: form.evidenceSeen || scroll >= max, error: undefined });
  }
  if (input === " " && acceptance) {
    if (!form.evidenceSeen) return set({ error: "根拠を最後まで表示してから (↓・PgDn・End) 確認欄に印を付けてください" });
    return set({ checked: !form.checked, error: undefined });
  }
  if (!key.return) return done(state);
  if (form.confirmFocus === "back") return set({ stage: backStage, error: undefined });
  if (acceptance && (!form.evidenceSeen || !form.checked)) return set({ error: "根拠 (レビューの判定と記録・実行の成果物) を最後まで確かめ、Space で確認欄に印を付けてから確定してください" });
  const request: WriteRequest = { type: "workflow", target: form.target, kind: form.step!, step: buildStep(form), actor: state.actor! };
  return done({ ...state, mode: { kind: "saving", request, resume: form, exitRequested: false } }, { kind: "write", request });
}

export function pasteIntoStep(form: StepForm, value: string): StepForm {
  if (form.stage !== "edit" || form.focus >= form.fields.length) return form;
  const field = form.fields[form.focus];
  if (field.kind === "choice") return form;
  const inserted = insertText(field.editor, field.kind === "line" ? normalizeInput(value).replace(/\n/g, " ") : value);
  return { ...form, fields: form.fields.map((item, index) => (index === form.focus ? { ...item, editor: inserted } : item)), error: undefined };
}

// 確認画面の内容
export function confirmLines(form: StepForm): string[] {
  const step = buildStep(form);
  const out = [`案件  ${form.target.job}`, `ID    ${form.target.id ?? form.target.name}  ${sanitize(form.target.title)}`, `操作  ${stepLabel(form.step!, form.record.phase)}`];
  for (const field of form.fields) {
    const value = field.kind === "choice" ? chosen(field) : field.kind === "lines" ? list(field).join(", ") : text(field);
    if (value !== "") out.push(`${field.label}  ${sanitize(value)}`);
  }
  if (step.op === "decide" && step.outcome === "approved" && form.record.phase === "review") out.push("承認すると受入確認 (人) が ready になります");
  if (step.op === "decide" && step.outcome === "approved" && form.record.phase === "acceptance") out.push("受け入れるとタスク全体が closed になります");
  return out;
}

// 保存に成功したときの知らせ
export function stepNotice(request: Extract<WriteRequest, { type: "workflow" }>, record: TaskRecord | undefined): string {
  const name = request.target.id ?? request.target.name;
  const where = record ? (record.status === "closed" ? "closed になりました" : `今の工程: ${record.phase ?? "-"} ${record.phaseStatus ?? "-"}`) : "";
  return `${name} を「${stepLabel(request.kind, undefined)}」しました。${where}`;
}

function sameRefs(a: ArtifactRef[] | undefined, b: ArtifactRef[]): boolean {
  const list = a ?? [];
  return list.length === b.length && list.every((ref, index) => ref.path === b[index].path && ref.repo === b[index].repo && ref.commit === b[index].commit);
}

function refsOf(step: WorkflowStep): ArtifactRef[] {
  if (step.op === "complete") return [{ path: step.handoff }, ...step.artifacts.map((path) => ({ path })), ...step.commits.map((value) => ({ repo: value.split(":")[0], commit: value.split(":")[1] }))];
  if (step.op === "decide") return [{ path: step.report }];
  if (step.op === "assign") return step.handoff ? [{ path: step.handoff }] : [];
  return [];
}

// 結果が分からない失敗 (応答が壊れた等) で、実体を読み直すと保存できていたか (R15-3)。
// revision が変わり、開いた時点の後の履歴が「この操作だけで増える件数」で、すべてこの操作者のもので、最初の履歴の出来事・工程・結果・引数
// (成果物・理由・担当・戻す工程) が要求と一致し、結果の状態 (待ちの相手など) も要求どおりのときだけ保存できたとみなす。
// 区別できないときは false (入力を残して「結果が分からない」と示し、自動で送り直さない)
export function stepConfirmed(request: Extract<WriteRequest, { type: "workflow" }>, latest: TaskRecord): boolean {
  const history = latest.history ?? [];
  if (latest.revision === request.target.revision) return false;
  const added = history.slice(request.target.history);
  const step = request.step;
  const expected = step.op === "decide" && step.outcome === "changes_requested" ? (step.returnTo === "plan" ? 3 : 2) : step.op === "reopen" && step.returnTo === "plan" ? 2 : 1;
  if (added.length !== expected || added.some((entry) => entry.actor !== request.actor)) return false;
  const first = added[0];
  const phase = request.target.phase ?? null;
  // 理由は scripts/ が保存する値と比べる (省略した block の理由は待ちの相手を「 / 」でつないだもの、approve・claim などは空)
  const reason = (value: string | undefined) => (value?.trim() ? value.trim() : null);
  switch (step.op) {
    case "claim":
      return first.event === "claim" && first.phase === phase && first.reason === null && latest.phaseStatus === "progress" && latest.assignee === request.actor;
    case "resume":
      return first.event === "resume" && first.phase === phase && first.reason === (request.target.blockedBy.join(" / ") || null) && latest.phaseStatus === "progress";
    case "block":
      return (
        first.event === "block" &&
        first.phase === phase &&
        first.reason === (reason(step.reason) ?? step.blockedBy.join(" / ")) &&
        latest.phaseStatus === "pending" &&
        latest.blockedBy.length === step.blockedBy.length &&
        latest.blockedBy.every((value, index) => value === step.blockedBy[index])
      );
    case "complete":
      return first.event === "complete" && first.phase === phase && first.outcome === "completed" && first.reason === null && sameRefs(first.refs, refsOf(step));
    case "decide":
      return (
        first.event === "decide" &&
        first.phase === phase &&
        first.outcome === step.outcome &&
        sameRefs(first.refs, refsOf(step)) &&
        first.reason === reason(step.reason) &&
        (step.outcome === "approved" || (added.at(-1)!.event === "reopen" && added.at(-1)!.phase === step.returnTo && added.at(-1)!.reason === reason(step.reason)))
      );
    case "reopen":
      return first.event === (step.returnTo === "plan" ? "revise" : "reopen") && added.at(-1)!.event === "reopen" && added.at(-1)!.phase === step.returnTo && first.reason === reason(step.reason) && added.at(-1)!.reason === reason(step.reason);
    case "assign":
      return first.event === "assign" && first.phase === step.phase && first.to === step.assignee && first.reason === reason(step.reason) && sameRefs(first.refs, refsOf(step));
  }
}
