// 種別と共通工程を持つタスク (workflowVersion 3) の遷移。
// 採用仕様: jobs/project_template/tasks/task-review-status/02-workflow-design.md (T-011) と、
//           その工程名・版・種別を更新した jobs/project_template/tasks/task-types-and-common-phases/02-accepted-plan.md (T-017)
//
// タスクのデータ (TaskV3) と操作を受け取り、遷移後のデータを返す純粋な関数。v2・旧形式のタスクは扱わない (移行してから使う)。
// 規則は種別 (research / implementation) によらず同じ。ファイル・ロック・revision・資料の存在と構造 (種別ごとの成果物を含む) の
// 確認は lib/taskflow.ts が行う。ここでは状態・担当・職務分離・人間の受入確認の規則だけを扱う。
//
// 操作と遷移 (列挙していない遷移はすべて TransitionError):
//   assign   工程の担当を決める・替える。progress 中の交代は引継資料が必要で、ready に戻して次の担当が claim する
//   claim    現在の工程を引き受ける (ready → progress)。担当が未定なら実行した actor を担当にする
//   complete 計画・実行を完了する (progress → done/completed)。次の工程を ready にする
//   decide   レビュー・受入確認を判定する。approved なら次へ (受入確認なら closed)、
//            changes_requested なら判定を履歴に残し、計画か実行から新しい試行をやり直す
//   block    外部の待ちで止める (progress → pending、blockedBy が必要)
//   resume   待ちの解消後に再開する (pending → progress。QA の解決は taskflow.ts が確かめる)
//   reopen   計画か実行からやり直す。closed のタスクを開き直すのは人だけ
//
// 職務分離: 実行 (execute) を完了した actor は同じ成果物のレビューを引き受けられず、判定もできない (調査でも同じ)。
// 受入確認の担当・引受・判定は人 (human/…) だけ。actor は申告であって認証ではない (agent 名の別名による迂回は防げない)。
// 計画へ戻すと requirementRevision を上げ (revise)、計画以降を新しい試行にする。実行へ戻すと計画の版を保ち、実行以降を新しい試行にする。
// やり直す工程の前の結果 (完了・判定) は history に残り、消さない。

import { type ArtifactRef, type HistoryEntryV3, type PhaseRecord, type PhaseV3, type TaskV3, actorPattern, phasesV3, validateTaskV3 } from "./workflow.ts";

type Phase = PhaseV3;
type HistoryEntry = HistoryEntryV3;
const phases = phasesV3;

export interface Clock {
  date: string; // YYYY-MM-DD (完了日・更新日)
  at: string; // タイムゾーン付きの日時 (履歴)
}

export type ReturnTarget = "plan" | "execute";

export type Operation =
  | { kind: "assign"; phase: Phase; assignee: string; by: string; reason: string; handoff?: ArtifactRef }
  | { kind: "claim"; actor: string }
  | { kind: "complete"; actor: string; refs: ArtifactRef[] }
  | { kind: "decide"; actor: string; outcome: "approved" | "changes_requested"; refs: ArtifactRef[]; returnTo?: ReturnTarget; reason?: string }
  | { kind: "block"; actor: string; blockedBy: string[]; reason?: string }
  | { kind: "resume"; actor: string }
  | { kind: "reopen"; actor: string; returnTo: ReturnTarget; reason: string };

// 遷移できないとき。code は CLI の JSON でそのまま返す
export class TransitionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const isHuman = (actor: string | null) => actor !== null && actor.startsWith("human/");

function fail(code: string, message: string): never {
  throw new TransitionError(code, message);
}

function requireActor(value: string, label: string): void {
  if (!actorPattern.test(value)) fail("WF_ACTOR", `${label} は human/<識別子> か agent/<識別子> です: ${value}`);
}

function requireText(value: string | undefined, label: string): string {
  const text = value?.trim() ?? "";
  if (text === "" || /[\r\n]/.test(text)) fail("WF_REASON", `${label} を 1 行で指定してください`);
  return text;
}

class Draft {
  readonly task: TaskV3;
  private readonly clock: Clock;

  constructor(task: TaskV3, clock: Clock) {
    this.task = structuredClone(task);
    this.clock = clock;
    this.task.updatedAt = clock.date;
  }

  record(phase: Phase): PhaseRecord {
    return this.task.workflow[phase];
  }

  // 開いていて、現在の工程があること
  current(): { phase: Phase; record: PhaseRecord } {
    if (this.task.status !== "open" || this.task.phase === null) fail("WF_CLOSED", `${this.task.id} は closed です (やり直すときは reopen)`);
    return { phase: this.task.phase, record: this.record(this.task.phase) };
  }

  // 履歴を追記して seq を返す。日時は前の履歴より前にしない (時計のずれで順序の検証に落ちないように)
  log(entry: Omit<HistoryEntry, "seq" | "at">): number {
    const history = this.task.history;
    const last = history[history.length - 1];
    const at = last && Date.parse(last.at) > Date.parse(this.clock.at) ? last.at : this.clock.at;
    const seq = history.length + 1;
    history.push({ seq, at, actor: entry.actor, event: entry.event, phase: entry.phase, attempt: entry.attempt, inputRevision: entry.inputRevision, outcome: entry.outcome, from: entry.from, to: entry.to, reason: entry.reason, refersTo: entry.refersTo, refs: entry.refs });
    return seq;
  }

  // 工程の今の試行の完了 (complete / decide / 移行の legacy_import) の履歴
  completionSeq(phase: Phase): number {
    const record = this.record(phase);
    const event = record.outcome === "legacy_import" ? "legacy_import" : phase === "plan" || phase === "execute" ? "complete" : "decide";
    const entry = this.task.history.filter((item) => item.phase === phase && item.attempt === record.attempt && item.event === event && item.outcome === record.outcome).at(-1);
    if (!entry) fail("WF_INTERNAL", `${phase} の完了の履歴が見つかりません`);
    return entry.seq;
  }

  // 工程を完了し、次の工程を ready にする。受入確認の承認ならタスクを閉じる
  finish(phase: Phase, actor: string, outcome: "completed" | "approved", refs: ArtifactRef[], reason: string | null): void {
    const record = this.record(phase);
    const seq = this.log({ actor, event: phase === "plan" || phase === "execute" ? "complete" : "decide", phase, attempt: record.attempt, inputRevision: record.inputRevision, outcome, from: record.status, to: "done", reason, refersTo: null, refs });
    Object.assign(record, { status: "done", completedBy: actor, completedAt: this.clock.date, outcome, artifactRefs: refs });
    const next = phases[phases.indexOf(phase) + 1];
    if (next === undefined) {
      Object.assign(this.task, { status: "closed", phase: null, completedAt: this.clock.date, closureReason: "accepted", blockedBy: [] });
      return;
    }
    Object.assign(this.record(next), { status: "ready", inputRevision: this.task.requirementRevision, inputSeq: seq });
    this.task.phase = next;
  }

  // target から後ろを新しい試行にしてやり直す。計画へ戻すときは要件の版を上げる
  returnTo(target: ReturnTarget, actor: string, reason: string, refersTo: number | null): void {
    let cause = refersTo;
    if (target === "plan") {
      this.task.requirementRevision += 1;
      cause = this.log({ actor, event: "revise", phase: null, attempt: null, inputRevision: this.task.requirementRevision, outcome: null, from: null, to: null, reason, refersTo, refs: [] });
    }
    const start = phases.indexOf(target);
    const previous = this.record(target).status;
    for (const phase of phases.slice(start)) {
      const record = this.record(phase);
      const used = record.status !== "waiting"; // 今の試行で動いた工程だけ試行回数を上げる
      Object.assign(record, {
        status: phase === target ? "ready" : "waiting",
        attempt: record.attempt + (used ? 1 : 0),
        completedBy: null,
        completedAt: null,
        outcome: null,
        inputRevision: phase === target ? this.task.requirementRevision : null,
        inputSeq: phase === target && target === "execute" ? this.completionSeq("plan") : null,
        artifactRefs: [],
      });
    }
    const record = this.record(target);
    this.log({ actor, event: "reopen", phase: target, attempt: record.attempt, inputRevision: record.inputRevision, outcome: null, from: previous, to: "ready", reason, refersTo: cause, refs: [] });
    Object.assign(this.task, { status: "open", phase: target, completedAt: null, closureReason: null, blockedBy: [] });
  }
}

// 実行を完了した actor (今の試行) は、その成果物をレビューできない
function assertNotSelfReview(draft: Draft, actor: string): void {
  const execute = draft.record("execute");
  if (execute.status === "done" && execute.completedBy === actor) fail("WF_SEPARATION", `${actor} は実行 (execute) を完了した担当なので、同じ成果物をレビューできません`);
}

function assertAssignee(record: PhaseRecord, phase: Phase, actor: string): void {
  if (record.assignee !== actor) fail("WF_NOT_ASSIGNEE", `${phase} の担当は ${record.assignee ?? "未定"} です (${actor} は担当ではありません。替えるときは assign)`);
}

function assertState(phase: Phase, record: PhaseRecord, expected: PhaseRecord["status"], operation: string): void {
  if (record.status !== expected) fail("WF_STATE", `${operation} できるのは ${phase} が ${expected} のときだけです (今は ${record.status})`);
}

function assertRefs(refs: ArtifactRef[], label: string): void {
  if (refs.length === 0 || refs[0].path === undefined) fail("WF_HANDOFF", `${label} (タスクのディレクトリの Markdown) を指定してください`);
}

export function transition(task: TaskV3, operation: Operation, clock: Clock): TaskV3 {
  const draft = new Draft(task, clock);
  switch (operation.kind) {
    case "assign": {
      requireActor(operation.assignee, "担当");
      requireActor(operation.by, "実行した actor");
      const reason = requireText(operation.reason, "担当を替える理由");
      if (draft.task.status !== "open") fail("WF_CLOSED", `${draft.task.id} は closed です`);
      const record = draft.record(operation.phase);
      if (record.status === "done") fail("WF_STATE", `${operation.phase} は今の試行が完了しているので担当を替えられません (やり直すときは reopen)`);
      if (record.status === "pending") fail("WF_STATE", `${operation.phase} は待ち (pending) なので、再開 (resume) してから担当を替えてください`);
      if (record.assignee === operation.assignee) fail("WF_NOOP", `${operation.phase} の担当はすでに ${operation.assignee} です`);
      if (operation.phase === "acceptance" && (!isHuman(operation.assignee) || !isHuman(operation.by))) fail("WF_HUMAN", "受入確認の担当を決められるのは人だけで、担当も人 (human/…) です");
      if (operation.phase === "review") assertNotSelfReview(draft, operation.assignee);
      const refs = operation.handoff ? [operation.handoff] : [];
      const from = record.status;
      if (from === "progress") {
        // 作業中の交代は、引継資料を残して ready に戻し、次の担当が引き受ける
        if (!operation.handoff) fail("WF_HANDOFF", `${operation.phase} は作業中 (progress) なので、担当を替えるには引継資料が必要です`);
        record.status = "ready";
      }
      draft.log({ actor: operation.by, event: "assign", phase: operation.phase, attempt: record.attempt, inputRevision: record.inputRevision, outcome: null, from: record.assignee, to: operation.assignee, reason, refersTo: null, refs });
      record.assignee = operation.assignee;
      break;
    }
    case "claim": {
      requireActor(operation.actor, "actor");
      const { phase, record } = draft.current();
      assertState(phase, record, "ready", "引き受け (claim)");
      if (phase === "acceptance" && !isHuman(operation.actor)) fail("WF_HUMAN", "受入確認を引き受けられるのは人 (human/…) だけです");
      if (record.assignee !== null && record.assignee !== operation.actor) assertAssignee(record, phase, operation.actor);
      if (phase === "review") assertNotSelfReview(draft, operation.actor);
      draft.log({ actor: operation.actor, event: "claim", phase, attempt: record.attempt, inputRevision: record.inputRevision, outcome: null, from: "ready", to: "progress", reason: null, refersTo: null, refs: [] });
      Object.assign(record, { status: "progress", assignee: operation.actor });
      break;
    }
    case "complete": {
      requireActor(operation.actor, "actor");
      const { phase, record } = draft.current();
      if (phase !== "plan" && phase !== "execute") fail("WF_PHASE", `complete は計画・実行の完了です (今の工程は ${phase}。レビュー・受入確認は decide)`);
      assertState(phase, record, "progress", "完了 (complete)");
      assertAssignee(record, phase, operation.actor);
      assertRefs(operation.refs, "引継資料");
      draft.finish(phase, operation.actor, "completed", operation.refs, null);
      break;
    }
    case "decide": {
      requireActor(operation.actor, "actor");
      const { phase, record } = draft.current();
      if (phase !== "review" && phase !== "acceptance") fail("WF_PHASE", `decide はレビュー・受入確認の判定です (今の工程は ${phase}。計画・実行は complete)`);
      assertState(phase, record, "progress", "判定 (decide)");
      assertAssignee(record, phase, operation.actor);
      if (phase === "acceptance" && !isHuman(operation.actor)) fail("WF_HUMAN", "受入確認を判定できるのは人 (human/…) だけです");
      if (phase === "review") assertNotSelfReview(draft, operation.actor);
      assertRefs(operation.refs, phase === "review" ? "レビューの記録" : "受入確認の記録");
      if (operation.outcome === "approved") {
        if (operation.returnTo !== undefined) fail("WF_USAGE", "承認 (approved) では戻す工程 (returnTo) を指定しません");
        draft.finish(phase, operation.actor, "approved", operation.refs, operation.reason?.trim() || null);
        break;
      }
      if (operation.returnTo === undefined) fail("WF_USAGE", "差戻し (changes_requested) には戻す工程 (plan か execute) が必要です");
      const reason = requireText(operation.reason, "差し戻す理由");
      const seq = draft.log({ actor: operation.actor, event: "decide", phase, attempt: record.attempt, inputRevision: record.inputRevision, outcome: "changes_requested", from: "progress", to: "done", reason, refersTo: null, refs: operation.refs });
      draft.returnTo(operation.returnTo, operation.actor, reason, seq);
      break;
    }
    case "block": {
      requireActor(operation.actor, "actor");
      const { phase, record } = draft.current();
      assertState(phase, record, "progress", "待ち (block) に");
      if (!isHuman(operation.actor)) assertAssignee(record, phase, operation.actor);
      const blockedBy = [...new Set(operation.blockedBy.map((value) => value.trim()))];
      if (blockedBy.length === 0 || blockedBy.some((value) => value === "" || /[\r\n]/.test(value))) fail("WF_BLOCKED_BY", "待っている相手 (blockedBy) を 1 件以上、1 行ずつ指定してください");
      draft.log({ actor: operation.actor, event: "block", phase, attempt: record.attempt, inputRevision: record.inputRevision, outcome: null, from: "progress", to: "pending", reason: operation.reason?.trim() || blockedBy.join(" / "), refersTo: null, refs: [] });
      record.status = "pending";
      draft.task.blockedBy = blockedBy;
      break;
    }
    case "resume": {
      requireActor(operation.actor, "actor");
      const { phase, record } = draft.current();
      assertState(phase, record, "pending", "再開 (resume)");
      if (!isHuman(operation.actor)) assertAssignee(record, phase, operation.actor);
      draft.log({ actor: operation.actor, event: "resume", phase, attempt: record.attempt, inputRevision: record.inputRevision, outcome: null, from: "pending", to: "progress", reason: draft.task.blockedBy.join(" / ") || null, refersTo: null, refs: [] });
      record.status = "progress";
      draft.task.blockedBy = [];
      break;
    }
    case "reopen": {
      requireActor(operation.actor, "actor");
      const reason = requireText(operation.reason, "やり直す理由");
      if (draft.task.status === "closed") {
        if (!isHuman(operation.actor)) fail("WF_HUMAN", "closed のタスクを開き直せるのは人 (human/…) だけです");
      } else {
        const { phase, record } = draft.current();
        if (phases.indexOf(operation.returnTo) > phases.indexOf(phase)) fail("WF_PHASE", `今の工程 ${phase} より後の ${operation.returnTo} へは戻せません`);
        if (record.status === "pending") fail("WF_STATE", `${phase} は待ち (pending) なので、再開 (resume) してからやり直してください`);
        if (!isHuman(operation.actor) && record.assignee !== operation.actor) fail("WF_NOT_ASSIGNEE", `やり直せるのは人か、今の工程 ${phase} の担当 (${record.assignee ?? "未定"}) だけです`);
      }
      if (operation.returnTo === "execute" && draft.record("plan").status !== "done") fail("WF_PHASE", "計画が完了していないので実行からはやり直せません");
      draft.returnTo(operation.returnTo, operation.actor, reason, null);
      break;
    }
  }
  // 遷移の結果は必ず形式の規則を満たす (満たさなければ遷移の誤り)
  const issues = validateTaskV3(draft.task);
  if (issues.length > 0) fail("WF_INTERNAL", `遷移の結果が不正です (内部の誤り): ${issues.map((issue) => `${issue.code} ${issue.path}: ${issue.message}`).join(" / ")}`);
  return draft.task;
}
