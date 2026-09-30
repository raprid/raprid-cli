// AI 工程と人の判断記録を持つタスク (workflowVersion 4) の遷移。T-021
// 契約: jobs/project_template/tasks/workflow-v4-contract/03-contract.md の 5 (遷移表 T2〜T17)・6 (権限)。
//       データの形と照合は T-020 の lib/workflow.ts (validateTaskV4) と lib/decision.ts (validateDecision・checkTaskDecisions・initialDecision)
//
// タスク (TaskV4) と、そのタスクの判断記録と、操作を受け取り、遷移後のタスクと、作った・変えた判断記録を返す純粋な関数。
// v3 の lib/transitions.ts は変えない (v2・v3 のタスクは扱わない)。ファイル・ロック・revision (--if-match・--record-match)・
// 資料の存在と構造・索引・journal は lib/taskflow-v4.ts が行う。
//
// 操作と遷移 (列挙していない遷移はすべて TransitionError):
//   claim            T2  今の工程を引き受ける (ready → progress)。担当が未定なら実行した actor を担当にする
//   assign           T3  工程の担当を替える (理由が必須)。progress 中の交代は引継資料が必要で、ready に戻す
//   block / resume   T4  外部の待ちで止める・再開する (工程の pending。blockedBy に approval/… は書かない)
//   complete         T5・T6・T7  plan・review は done に固定してタスクを pending (人の確認待ち) にし、判断記録を open で作る。
//                    execute は done にして review を ready にする (人の承認を挟まない)
//   send-back        T8・T9  AI の担当が理由を付けて差し戻す。execute → plan (要件の版 +1)、review → execute
//   approval-claim   T10 人が未割当の判断記録を引き受ける
//   approval-assign  T11 判断者を替える (今の判断者本人か、人であるタスクの依頼元だけ。理由が必須)
//   approve          T12・T14 判断者本人が承認する。plan なら execute を ready に、review ならタスクを closed (approved) にする
//   reject           T13・T15 判断者本人が理由を付けて見送る。plan は plan へ (版 +1)、review は戻す工程 (plan / execute / review) が必須
//   revise           T16 人が要件を変える (版 +1、plan から新しい試行)。確認待ちの open の記録は superseded にする
//   reopen           T17 人が closed のタスクを戻す工程から開き直す (plan なら版 +1)。閉じた記録は変えない
//
// 人の確認待ち (タスクの pending) の間は、提出した工程にも後の工程にも工程の操作 (claim・assign・block・complete・send-back) をできない。
// 判断記録の claim・判断者の変更・承認・見送り・revise・reopen は人 (human/…) だけ。AI は complete で判断記録を作る以外に触れない。
// actor は申告であって認証ではない (v3 と同じ前提)。
// やり直す工程から後ろは、今の試行で動いた工程だけ試行を 1 上げる (v3 と同じ)。前の完了・判断記録は history と decisions/ に残る。

import { type DecisionRecord, checkTaskDecisions, decisionFile, initialDecision, validateDecision } from "./decision.ts";
import { type Clock, TransitionError } from "./transitions.ts";
import {
  type ApprovalPhase,
  type ApprovalPhaseRecordV4,
  type ArtifactRef,
  type HistoryEntryV4,
  type PhaseRecordV4,
  type PhaseV4,
  type TaskV4,
  actorPattern,
  approvalPhases,
  completionOfV4,
  phasesV4,
  validateTaskV4,
} from "./workflow.ts";

export type OperationV4 =
  | { kind: "claim"; actor: string }
  | { kind: "assign"; phase: PhaseV4; assignee: string; by: string; reason: string; handoff?: ArtifactRef }
  | { kind: "block"; actor: string; blockedBy: string[]; reason?: string }
  | { kind: "resume"; actor: string }
  | { kind: "complete"; actor: string; refs: ArtifactRef[] }
  | { kind: "send-back"; actor: string; reason: string }
  | { kind: "revise"; actor: string; reason: string }
  | { kind: "reopen"; actor: string; returnTo: PhaseV4; reason: string }
  | { kind: "approval-claim"; actor: string; id: string }
  | { kind: "approval-assign"; actor: string; id: string; to: string | null; reason: string }
  | { kind: "approve"; actor: string; id: string; reportRefs?: ArtifactRef[] }
  | { kind: "reject"; actor: string; id: string; reason: string; returnTo?: PhaseV4; reportRefs?: ArtifactRef[] };

export type ApprovalOperationKind = "approval-claim" | "approval-assign" | "approve" | "reject";
export const approvalOperationKinds: readonly ApprovalOperationKind[] = ["approval-claim", "approval-assign", "approve", "reject"];

export function isApprovalOperation(operation: OperationV4): operation is Extract<OperationV4, { kind: ApprovalOperationKind }> {
  return (approvalOperationKinds as readonly string[]).includes(operation.kind);
}

export interface DecisionChange {
  id: string;
  record: DecisionRecord; // 操作の後の記録
  created: boolean; // この操作で作った (complete の T5・T7)
}

export interface TransitionResultV4 {
  task: TaskV4;
  taskChanged: boolean; // 判断記録の claim・判断者の変更だけならタスクは変わらない
  decisions: DecisionChange[];
}

const isHuman = (actor: string | null | undefined): actor is string => typeof actor === "string" && actor.startsWith("human/");

function fail(code: string, message: string): never {
  throw new TransitionError(code, message);
}

function requireActor(value: string, label: string): void {
  if (typeof value !== "string" || !actorPattern.test(value)) fail("WF_ACTOR", `${label} は human/<識別子> か agent/<識別子> です: ${value}`);
}

function requireHuman(actor: string, what: string): void {
  requireActor(actor, "actor");
  if (!isHuman(actor)) fail("WF_HUMAN", `${what}は人 (human/…) だけができます (AI は判断記録を作る以外に触れない): ${actor}`);
}

function requireText(value: string | undefined, label: string): string {
  const text = value?.trim() ?? "";
  if (text === "" || /[\r\n]/.test(text)) fail("WF_REASON", `${label} を 1 行で指定してください`);
  return text;
}

// 日時の比較で遅い方 (時計のずれで履歴の順序の検証に落ちないように、前の履歴より前の日時にしない)
function latest(first: string, ...rest: (string | undefined)[]): string {
  let result = first;
  for (const value of rest) if (value !== undefined && Date.parse(value) > Date.parse(result)) result = value;
  return result;
}

class DraftV4 {
  readonly task: TaskV4;
  readonly decisions: Map<string, DecisionRecord>;
  readonly changes = new Map<string, DecisionChange>();
  private readonly clock: Clock;
  taskChanged = false;

  constructor(task: TaskV4, decisions: ReadonlyMap<string, DecisionRecord>, clock: Clock) {
    this.task = structuredClone(task);
    this.decisions = new Map([...decisions].map(([id, record]) => [id, structuredClone(record)]));
    this.clock = clock;
  }

  record(phase: PhaseV4): PhaseRecordV4 {
    return this.task.workflow[phase];
  }

  approvalRecord(phase: ApprovalPhase): ApprovalPhaseRecordV4 {
    return this.task.workflow[phase];
  }

  // 今の工程。工程の操作は、タスクが open のときだけ (人の確認待ち・closed は拒否)
  current(operation: string): { phase: PhaseV4; record: PhaseRecordV4 } {
    if (this.task.status === "closed" || this.task.phase === null) fail("WF_CLOSED", `${this.task.id} は closed です (開き直すのは人の reopen)`);
    if (this.task.status === "pending") {
      fail("WF_STATE", `${this.task.id} は人の確認待ち (${this.task.blockedBy.join(", ")}) なので ${operation} できません (判断者の承認か見送りを待つ。待つ理由は判断記録のメモに書く)`);
    }
    return { phase: this.task.phase, record: this.record(this.task.phase) };
  }

  // この操作の履歴の日時。タスクの最後の履歴 (と判断記録の最後の履歴) より前にしない
  at(decision?: DecisionRecord): string {
    return latest(this.clock.at, this.task.history.at(-1)?.at, decision?.history.at(-1)?.at);
  }

  log(entry: Omit<HistoryEntryV4, "seq" | "at">, at = this.at()): HistoryEntryV4 {
    const history = this.task.history;
    const full: HistoryEntryV4 = {
      seq: history.length + 1,
      at,
      actor: entry.actor,
      event: entry.event,
      phase: entry.phase,
      attempt: entry.attempt,
      inputRevision: entry.inputRevision,
      outcome: entry.outcome,
      from: entry.from,
      to: entry.to,
      reason: entry.reason,
      refersTo: entry.refersTo,
      refs: entry.refs,
    };
    history.push(full);
    this.task.updatedAt = this.clock.date;
    this.taskChanged = true;
    return full;
  }

  // 判断記録の履歴に追記する
  logDecision(decision: DecisionRecord, entry: { at: string; actor: string; event: DecisionRecord["history"][number]["event"]; from: string | null; to: string | null; reason: string | null }): void {
    decision.history.push({ seq: decision.history.length + 1, at: entry.at, actor: entry.actor, event: entry.event, from: entry.from, to: entry.to, reason: entry.reason });
    this.touch(decision, false);
  }

  touch(decision: DecisionRecord, created: boolean): void {
    this.decisions.set(decision.id, decision);
    this.changes.set(decision.id, { id: decision.id, record: decision, created: created || (this.changes.get(decision.id)?.created ?? false) });
  }

  // 工程の今の試行の完了の seq (plan の完了は execute の、execute の完了は review の入力)
  completionSeq(phase: PhaseV4): number {
    const entry = completionOfV4(this.task.history, phase, this.record(phase));
    if (!entry) fail("WF_INTERNAL", `${phase} の今の試行の完了の履歴が見つかりません`);
    return entry.seq;
  }

  // target から後ろを新しい試行にしてやり直す (bump なら要件の版を上げる)。担当は前の試行の担当のまま
  restart(target: PhaseV4, bump: boolean): void {
    if (bump) this.task.requirementRevision += 1;
    const start = phasesV4.indexOf(target);
    for (const phase of phasesV4.slice(start)) {
      const record = this.record(phase);
      const used = record.status !== "waiting"; // 今の試行で動いた工程だけ試行を上げる
      Object.assign(record, {
        status: phase === target ? "ready" : "waiting",
        attempt: record.attempt + (used ? 1 : 0),
        completedBy: null,
        completedAt: null,
        outcome: null,
        inputRevision: phase === target ? this.task.requirementRevision : null,
        inputSeq: phase === target && start > 0 ? this.completionSeq(phasesV4[start - 1]) : null,
        artifactRefs: [],
      });
      if ((approvalPhases as readonly string[]).includes(phase)) (record as ApprovalPhaseRecordV4).approval = null;
    }
    Object.assign(this.task, { status: "open", phase: target, completedAt: null, closureReason: null, blockedBy: [] });
  }
}

function assertNotSelfReview(draft: DraftV4, actor: string): void {
  const execute = draft.record("execute");
  if (execute.status === "done" && execute.completedBy === actor) fail("WF_SEPARATION", `${actor} は実行 (execute) を完了した担当なので、同じ成果物をレビューできません`);
}

function assertAssignee(record: PhaseRecordV4, phase: PhaseV4, actor: string): void {
  if (record.assignee !== actor) fail("WF_NOT_ASSIGNEE", `${phase} の担当は ${record.assignee ?? "未定"} です (${actor} は担当ではありません。替えるときは assign)`);
}

function assertState(phase: PhaseV4, record: PhaseRecordV4, expected: PhaseRecordV4["status"], operation: string): void {
  if (record.status === expected) return;
  const hint = record.status === "pending" ? " (外部の待ちは resume してから)" : "";
  fail("WF_STATE", `${operation} できるのは ${phase} が ${expected} のときだけです (今は ${record.status})${hint}`);
}

function assertRefs(refs: ArtifactRef[], label: string, code: string): void {
  if (refs.length === 0 || refs[0].path === undefined) fail(code, `${label} (タスクのディレクトリの Markdown) を指定してください`);
}

// 判断記録の操作の対象 (03 の 4 の照合 1〜4)。一つでも合わなければ何も変えずに拒否する
function actionable(draft: DraftV4, id: string): DecisionRecord {
  const decision = draft.decisions.get(id);
  if (!decision) fail("APPROVAL_NOT_FOUND", `判断記録 ${id} (${decisionFile(id)}) がありません`);
  if (decision.status !== "open") fail("WF_APPROVAL_CLOSED", `判断記録 ${id} は ${decision.status} です (閉じた記録は操作できない。新しい試行には新しい記録ができる)`);
  const task = draft.task;
  const pointed = task.status === "pending" && task.phase === decision.phase && draft.approvalRecord(decision.phase).approval === id && task.blockedBy.length === 1 && task.blockedBy[0] === `approval/${id}`;
  if (!pointed) fail("WF_APPROVAL_STALE", `判断記録 ${id} はタスクが今待っている記録ではありません (古い試行・要件の版、または途中で失敗した操作の残り。人が確かめて片付ける)`);
  const record = draft.approvalRecord(decision.phase);
  if (decision.attempt !== record.attempt) fail("WF_APPROVAL_STALE", `判断記録 ${id} の試行 (${decision.attempt}) が今の ${decision.phase} の試行 (${record.attempt}) と違います`);
  if (decision.requirementRevision !== task.requirementRevision) fail("WF_APPROVAL_STALE", `判断記録 ${id} の要件の版 (${decision.requirementRevision}) が今のタスクの版 (${task.requirementRevision}) と違います`);
  const submission = completionOfV4(task.history, decision.phase, record);
  if (!submission || submission.seq !== decision.submissionSeq) fail("WF_APPROVAL_STALE", `判断記録 ${id} の提出 (seq ${decision.submissionSeq}) が今の ${decision.phase} の最後の提出 (seq ${submission?.seq ?? "なし"}) と違います`);
  return decision;
}

// 判断者本人か (未割当は先に claim)
function assertApprover(decision: DecisionRecord, actor: string, what: string): void {
  if (decision.assignee === null) fail("WF_NOT_APPROVER", `判断記録 ${decision.id} は未割当です (${what}の前に approval claim で引き受ける)`);
  if (decision.assignee !== actor) fail("WF_NOT_APPROVER", `判断記録 ${decision.id} の${what}ができるのは判断者 ${decision.assignee} 本人だけです (${actor})`);
}

function assertReportRefs(refs: ArtifactRef[] | undefined): ArtifactRef[] {
  const list = refs ?? [];
  if (list.some((ref) => ref.path === undefined)) fail("WF_REPORT", "判断の記録 (report) はタスクのディレクトリの Markdown です");
  return structuredClone(list);
}

// 判断記録を閉じる (承認・見送り・無効化)。タスクの履歴の seq と日時を記録と対にする
function closeDecision(draft: DraftV4, decision: DecisionRecord, entry: HistoryEntryV4, fields: { status: "approved" | "rejected" | "superseded"; outcome: "approved" | "rejected" | null; returnTo: PhaseV4 | null; reason: string | null; reportRefs: ArtifactRef[] }): void {
  const event = fields.status === "approved" ? "approve" : fields.status === "rejected" ? "reject" : "supersede";
  Object.assign(decision, {
    status: fields.status,
    decidedBy: entry.actor,
    decidedAt: entry.at,
    decisionSeq: entry.seq,
    outcome: fields.outcome,
    returnTo: fields.returnTo,
    reason: fields.reason,
    reportRefs: [...decision.reportRefs, ...fields.reportRefs],
  });
  draft.logDecision(decision, { at: entry.at, actor: entry.actor, event, from: "open", to: fields.status === "rejected" ? fields.returnTo : fields.status, reason: fields.reason });
}

export function transitionV4(task: TaskV4, decisions: ReadonlyMap<string, DecisionRecord>, operation: OperationV4, clock: Clock): TransitionResultV4 {
  const draft = new DraftV4(task, decisions, clock);
  switch (operation.kind) {
    case "claim": {
      requireActor(operation.actor, "actor");
      const { phase, record } = draft.current("引き受け (claim)");
      assertState(phase, record, "ready", "引き受け (claim)");
      if (record.assignee !== null && record.assignee !== operation.actor) assertAssignee(record, phase, operation.actor);
      if (phase === "review") assertNotSelfReview(draft, operation.actor);
      draft.log({ actor: operation.actor, event: "claim", phase, attempt: record.attempt, inputRevision: record.inputRevision, outcome: null, from: "ready", to: "progress", reason: null, refersTo: null, refs: [] });
      Object.assign(record, { status: "progress", assignee: operation.actor });
      break;
    }
    case "assign": {
      requireActor(operation.assignee, "担当");
      requireActor(operation.by, "実行した actor");
      const reason = requireText(operation.reason, "担当を替える理由");
      if (!(phasesV4 as readonly string[]).includes(operation.phase)) fail("WF_PHASE", `工程は ${phasesV4.join(" / ")} のいずれかです: ${operation.phase}`);
      draft.current("工程の担当の変更 (assign)");
      const record = draft.record(operation.phase);
      if (record.status === "done") fail("WF_STATE", `${operation.phase} は今の試行が完了しているので担当を替えられません`);
      if (record.status === "pending") fail("WF_STATE", `${operation.phase} は外部の待ち (pending) なので、再開 (resume) してから担当を替えてください`);
      if (record.assignee === operation.assignee) fail("WF_NOOP", `${operation.phase} の担当はすでに ${operation.assignee} です`);
      if (operation.phase === "review") assertNotSelfReview(draft, operation.assignee);
      const refs = operation.handoff ? [operation.handoff] : [];
      if (record.status === "progress") {
        // 作業中の交代は、引継資料を残して ready に戻し、次の担当が引き受ける
        if (!operation.handoff) fail("WF_HANDOFF", `${operation.phase} は作業中 (progress) なので、担当を替えるには引継資料が必要です`);
        record.status = "ready";
      }
      draft.log({ actor: operation.by, event: "assign", phase: operation.phase, attempt: record.attempt, inputRevision: record.inputRevision, outcome: null, from: record.assignee, to: operation.assignee, reason, refersTo: null, refs });
      record.assignee = operation.assignee;
      break;
    }
    case "block": {
      requireActor(operation.actor, "actor");
      const { phase, record } = draft.current("外部の待ち (block) に");
      assertState(phase, record, "progress", "外部の待ち (block) に");
      if (!isHuman(operation.actor)) assertAssignee(record, phase, operation.actor);
      const blockedBy = [...new Set(operation.blockedBy.map((value) => value.trim()))];
      if (blockedBy.length === 0 || blockedBy.some((value) => value === "" || /[\r\n]/.test(value))) fail("WF_BLOCKED_BY", "待っている相手 (blockedBy) を 1 件以上、1 行ずつ指定してください");
      if (blockedBy.some((value) => value.startsWith("approval/"))) fail("WF_BLOCKED_BY", "approval/… (人の確認待ち) は block では指定できません (plan・review の complete が判断記録を作って待つ)");
      draft.log({ actor: operation.actor, event: "block", phase, attempt: record.attempt, inputRevision: record.inputRevision, outcome: null, from: "progress", to: "pending", reason: operation.reason?.trim() || blockedBy.join(" / "), refersTo: null, refs: [] });
      record.status = "pending";
      draft.task.blockedBy = blockedBy;
      break;
    }
    case "resume": {
      requireActor(operation.actor, "actor");
      const { phase, record } = draft.current("再開 (resume)");
      assertState(phase, record, "pending", "再開 (resume)");
      if (!isHuman(operation.actor)) assertAssignee(record, phase, operation.actor);
      draft.log({ actor: operation.actor, event: "resume", phase, attempt: record.attempt, inputRevision: record.inputRevision, outcome: null, from: "pending", to: "progress", reason: draft.task.blockedBy.join(" / ") || null, refersTo: null, refs: [] });
      record.status = "progress";
      draft.task.blockedBy = [];
      break;
    }
    case "complete": {
      requireActor(operation.actor, "actor");
      const { phase, record } = draft.current("完了 (complete)");
      assertState(phase, record, "progress", "完了 (complete)");
      assertAssignee(record, phase, operation.actor);
      if (phase === "review") assertNotSelfReview(draft, operation.actor);
      assertRefs(operation.refs, phase === "review" ? "レビューの記録" : "引継資料", phase === "review" ? "WF_REPORT" : "WF_HANDOFF");
      const refs = structuredClone(operation.refs);
      const entry = draft.log({ actor: operation.actor, event: "complete", phase, attempt: record.attempt, inputRevision: record.inputRevision, outcome: "completed", from: "progress", to: "done", reason: null, refersTo: null, refs });
      Object.assign(record, { status: "done", completedBy: operation.actor, completedAt: clock.date, outcome: "completed", artifactRefs: structuredClone(refs) });
      if (phase === "execute") {
        // T6: 人の承認を挟まずに review へ
        Object.assign(draft.record("review"), { status: "ready", inputRevision: draft.task.requirementRevision, inputSeq: entry.seq });
        draft.task.phase = "review";
        break;
      }
      // T5・T7: AI の完了として固定し、人の確認待ちにする
      const id = `${phase}-${record.attempt}`;
      if (draft.decisions.has(id)) fail("WF_APPROVAL_CONFLICT", `同じ ID の判断記録 ${decisionFile(id)} が既にあるので作りません (既存の記録は上書きしない。人が確かめて片付ける)`);
      (record as ApprovalPhaseRecordV4).approval = id;
      draft.task.status = "pending";
      draft.task.blockedBy = [`approval/${id}`];
      draft.touch(initialDecision({ task: draft.task, phase: phase as ApprovalPhase, actor: operation.actor, at: entry.at }), true);
      break;
    }
    case "send-back": {
      requireActor(operation.actor, "actor");
      const reason = requireText(operation.reason, "差し戻す理由");
      const { phase, record } = draft.current("差戻し (send-back)");
      if (phase === "plan") fail("WF_PHASE", "plan からは差し戻せません (差戻しは execute → plan と review → execute)");
      assertState(phase, record, "progress", "差戻し (send-back)");
      assertAssignee(record, phase, operation.actor);
      const target: PhaseV4 = phase === "execute" ? "plan" : "execute";
      draft.log({ actor: operation.actor, event: "send_back", phase, attempt: record.attempt, inputRevision: record.inputRevision, outcome: null, from: "progress", to: target, reason, refersTo: null, refs: [] });
      draft.restart(target, target === "plan"); // T8 は版 +1、T9 は版を保つ
      break;
    }
    case "approval-claim": {
      requireHuman(operation.actor, "判断記録の引受 (claim) ");
      const decision = actionable(draft, operation.id);
      if (decision.assignee !== null) fail("WF_NOT_APPROVER", `判断記録 ${decision.id} は ${decision.assignee} が担当しています (claim は未割当の記録だけ。替えるのは判断者本人か依頼元の assign)`);
      draft.logDecision(decision, { at: draft.at(decision), actor: operation.actor, event: "claim", from: null, to: operation.actor, reason: null });
      decision.assignee = operation.actor;
      break;
    }
    case "approval-assign": {
      requireHuman(operation.actor, "判断者の変更 (assign) ");
      const decision = actionable(draft, operation.id);
      if (decision.assignee === null) fail("WF_NOT_APPROVER", `判断記録 ${decision.id} は未割当です (先に approval claim で引き受ける)`);
      const requester = isHuman(draft.task.requestedBy) && draft.task.requestedBy === operation.actor;
      if (decision.assignee !== operation.actor && !requester) {
        fail("WF_NOT_APPROVER", `判断者を替えられるのは今の判断者 (${decision.assignee}) 本人か、人であるタスクの依頼元 (${draft.task.requestedBy ?? "なし"}) だけです (${operation.actor})`);
      }
      const reason = requireText(operation.reason, "判断者を替える理由");
      const to = operation.to;
      if (to !== null) {
        requireActor(to, "替えた先の判断者");
        if (!isHuman(to)) fail("WF_HUMAN", `判断者は人 (human/…) か未割当です: ${to}`);
      }
      if (to === decision.assignee) fail("WF_NOOP", `判断記録 ${decision.id} の判断者はすでに ${to} です`);
      draft.logDecision(decision, { at: draft.at(decision), actor: operation.actor, event: "assign", from: decision.assignee, to, reason });
      decision.assignee = to;
      break;
    }
    case "approve": {
      requireHuman(operation.actor, "承認 (approve) ");
      const decision = actionable(draft, operation.id);
      assertApprover(decision, operation.actor, "承認");
      const reportRefs = assertReportRefs(operation.reportRefs);
      const phase = decision.phase;
      const record = draft.approvalRecord(phase);
      const closing = phase === "review";
      const entry = draft.log(
        { actor: operation.actor, event: "approve", phase, attempt: decision.attempt, inputRevision: record.inputRevision, outcome: null, from: "pending", to: closing ? "closed" : "open", reason: null, refersTo: null, refs: [{ path: decisionFile(decision.id) }, ...reportRefs] },
        draft.at(decision),
      );
      closeDecision(draft, decision, entry, { status: "approved", outcome: "approved", returnTo: null, reason: null, reportRefs });
      if (closing) {
        // T14: review の承認でタスクを閉じる (review は done のまま)
        Object.assign(draft.task, { status: "closed", phase: null, completedAt: clock.date, closureReason: "approved", blockedBy: [] });
      } else {
        // T12: plan は done のまま、execute を ready (入力は plan の完了と今の版)
        Object.assign(draft.record("execute"), { status: "ready", inputRevision: draft.task.requirementRevision, inputSeq: decision.submissionSeq });
        Object.assign(draft.task, { status: "open", phase: "execute", blockedBy: [] });
      }
      break;
    }
    case "reject": {
      requireHuman(operation.actor, "見送り (reject) ");
      const decision = actionable(draft, operation.id);
      assertApprover(decision, operation.actor, "見送り");
      const reason = requireText(operation.reason, "見送る理由");
      const phase = decision.phase;
      let target: PhaseV4;
      if (phase === "plan") {
        if (operation.returnTo !== undefined && operation.returnTo !== "plan") fail("WF_USAGE", `plan の見送りで戻す工程は plan だけです: ${operation.returnTo}`);
        target = "plan";
      } else {
        if (operation.returnTo === undefined) fail("WF_USAGE", "review の見送りには戻す工程 (plan / execute / review) が必要です");
        if (!(phasesV4 as readonly string[]).includes(operation.returnTo)) fail("WF_USAGE", `戻す工程は ${phasesV4.join(" / ")} のいずれかです: ${operation.returnTo}`);
        target = operation.returnTo;
      }
      const reportRefs = assertReportRefs(operation.reportRefs);
      const record = draft.approvalRecord(phase);
      const entry = draft.log(
        { actor: operation.actor, event: "reject", phase, attempt: decision.attempt, inputRevision: record.inputRevision, outcome: null, from: "pending", to: target, reason, refersTo: null, refs: [{ path: decisionFile(decision.id) }, ...reportRefs] },
        draft.at(decision),
      );
      closeDecision(draft, decision, entry, { status: "rejected", outcome: "rejected", returnTo: target, reason, reportRefs });
      draft.restart(target, target === "plan"); // T13・T15: plan へ戻すときだけ版 +1
      break;
    }
    case "revise": {
      requireHuman(operation.actor, "要件の変更 (revise) ");
      const reason = requireText(operation.reason, "要件を変える理由");
      if (draft.task.status === "closed") fail("WF_CLOSED", `${draft.task.id} は closed です (開き直すのは reopen)`);
      // 確認待ちの open の記録は無効化する (承認・見送りで閉じた記録は変えない)
      let waiting: DecisionRecord | undefined;
      if (draft.task.status === "pending" && draft.task.phase !== null && (approvalPhases as readonly string[]).includes(draft.task.phase)) {
        const id = draft.approvalRecord(draft.task.phase as ApprovalPhase).approval;
        waiting = id === null ? undefined : draft.decisions.get(id);
        if (!waiting || waiting.status !== "open") fail("WF_APPROVAL", `人の確認待ちの判断記録 ${id ?? "なし"} が open ではありません (記録の不整合を先に確かめる)`);
      }
      const at = draft.at(waiting);
      const before = draft.task.requirementRevision;
      draft.log({ actor: operation.actor, event: "revise", phase: null, attempt: null, inputRevision: before + 1, outcome: null, from: String(before), to: String(before + 1), reason, refersTo: null, refs: [] }, at);
      if (waiting) {
        const record = draft.approvalRecord(waiting.phase);
        const supersedeReason = `要件の変更 (revise) で無効化: ${reason}`;
        const entry = draft.log(
          { actor: operation.actor, event: "supersede", phase: waiting.phase, attempt: waiting.attempt, inputRevision: record.inputRevision, outcome: null, from: "open", to: "superseded", reason: supersedeReason, refersTo: null, refs: [{ path: decisionFile(waiting.id) }] },
          at,
        );
        closeDecision(draft, waiting, entry, { status: "superseded", outcome: null, returnTo: null, reason: supersedeReason, reportRefs: [] });
      }
      draft.restart("plan", true);
      break;
    }
    case "reopen": {
      requireHuman(operation.actor, "closed のタスクの開き直し (reopen) ");
      const reason = requireText(operation.reason, "開き直す理由");
      if (!(phasesV4 as readonly string[]).includes(operation.returnTo)) fail("WF_USAGE", `戻す工程は ${phasesV4.join(" / ")} のいずれかです: ${operation.returnTo}`);
      if (draft.task.status !== "closed") fail("WF_STATE", `reopen は closed のタスクだけです (${draft.task.status} のタスクは send-back・見送り・revise で戻す)`);
      const previous = draft.record(operation.returnTo).status;
      draft.restart(operation.returnTo, operation.returnTo === "plan");
      const record = draft.record(operation.returnTo);
      draft.log({ actor: operation.actor, event: "reopen", phase: operation.returnTo, attempt: record.attempt, inputRevision: record.inputRevision, outcome: null, from: previous, to: "ready", reason, refersTo: null, refs: [] });
      break;
    }
    default:
      fail("WF_USAGE", `未対応の操作です: ${(operation as { kind: string }).kind}`);
  }

  // 遷移の結果は必ずデータ層の規則 (T-020) を満たす (満たさなければ遷移の誤り)
  const issues = [...(draft.taskChanged ? validateTaskV4(draft.task) : [])];
  for (const change of draft.changes.values()) issues.push(...validateDecision(change.record).map((issue) => ({ ...issue, path: `${decisionFile(change.id)}: ${issue.path}` })));
  if (issues.length === 0) issues.push(...checkTaskDecisions(draft.task, [...draft.decisions].map(([id, data]) => ({ id, data }))));
  if (issues.length > 0) fail("WF_INTERNAL", `遷移の結果が不正です (内部の誤り): ${issues.map((issue) => `${issue.code} ${issue.path}: ${issue.message}`).join(" / ")}`);
  return { task: draft.task, taskChanged: draft.taskChanged, decisions: [...draft.changes.values()] };
}
