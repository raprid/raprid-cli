// 判断記録 (workflowVersion 4 で人が plan・review の提出を承認・見送りする専用の記録)。T-020
// 契約: jobs/project_template/tasks/workflow-v4-contract/03-contract.md の 4 (置き場所・項目・状態・照合・無効化・一覧) と 7 (索引)、
//       04-migration-compat.md の 2 (移行が作る記録)
//
// 置き場所: jobs/<案件>/tasks/<タスク>/decisions/<工程>-<試行>.md (1 記録 = 1 ファイル。frontmatter に項目、本文は人のメモ)。
// タスクのディレクトリの中にあるので、案件のロック 1 つでタスクと一緒に排他できる。
// 状態は open → approved / rejected / superseded の一方向。open 以外は書き換えず、新しい試行には新しい記録を作る。
//
// ここで確かめること:
//   validateDecision      1 つの記録の構造 (型・必須・列挙・書式) と、状態・判断の項目・履歴の整合
//   checkTaskDecisions    タスクと記録の照合 (03 の 4 の 1〜4)。タスクが指す open の記録は今の工程・試行・要件の版・提出の seq と一致し、
//                         閉じた記録はタスクの history の approve / reject / supersede (移行なら移行元の受入確認の decide approved) と対になる。
//                         タスクが指していない open の記録は無効 (WF_APPROVAL_ORPHAN)
//   5 の照合 (--if-match・--record-match の revision) は操作の時に行う (T-021・T-022)
//
// 索引: 作業索引は open なら status/<工程>/<工程の状態>/<名前>、人の確認待ち (タスクの pending) なら status/approval/<工程>/<名前>、closed なら無し。
//       確認待ちの索引は open の記録ごとに approvals/open/<タスク名>--<工程>-<試行> → ../../tasks/<タスク名>/decisions/<工程>-<試行>.md。
//       正は各記録の frontmatter で、索引の書き換えは T-021 (journal と一体更新)

import { join } from "node:path";
import { workLinkPath, workLinkTarget } from "./workindex.ts";
import {
  type ApprovalPhase,
  type ArtifactRef,
  Checker,
  type HistoryEntryV4,
  type PhaseV4,
  type TaskV4,
  type WorkflowIssue,
  approvalIdPattern,
  approvalPhases,
  actorPattern,
  decisionEventsOf,
  isValidDateTime,
  legacyUnverified,
  migrateSeqOf,
  phasesV4,
  sameArtifactRefs,
  submissionOf,
} from "./workflow.ts";
import { YamlFrontmatter } from "./yamlfront.ts";

export const decisionKind = "approval"; // 将来の別種と区別する
export const decisionStatuses = ["open", "approved", "rejected", "superseded"] as const;
export const decisionOutcomes = ["approved", "rejected"] as const;
export const decisionOrigins = ["submit", "import"] as const; // submit = v4 の complete が作った、import = 移行が作った
export const decisionEvents = ["create", "claim", "assign", "approve", "reject", "supersede", "import"] as const;
export const decisionsDir = "decisions";
export const decisionKeys = ["id", "kind", "task", "phase", "attempt", "requirementRevision", "submissionSeq", "submission", "status", "assignee", "decidedBy", "decidedAt", "decisionSeq", "outcome", "returnTo", "reason", "reportRefs", "createdAt", "origin", "history"] as const;
const decisionHistoryKeys = ["seq", "at", "actor", "event", "from", "to", "reason"];
const submissionKeys = ["completedBy", "completedAt", "artifactRefs"];
const taskIdPattern = /^T-\d{3,}$/;
const closingEvents = ["approve", "reject", "supersede"];
const humanEvents = ["claim", "assign", "approve", "reject", "supersede"];

export type DecisionStatus = (typeof decisionStatuses)[number];
export type DecisionOutcome = (typeof decisionOutcomes)[number];
export type DecisionOrigin = (typeof decisionOrigins)[number];
export type DecisionEvent = (typeof decisionEvents)[number];

export interface Submission {
  completedBy: string; // 提出した actor (提出の履歴の actor)
  completedAt: string; // 提出の日時 (提出の履歴の at。タイムゾーン付き)
  artifactRefs: ArtifactRef[]; // 提出の成果物 (提出の履歴の refs)
}

export interface DecisionHistoryEntry {
  seq: number;
  at: string;
  actor: string;
  event: DecisionEvent;
  from: string | null;
  to: string | null;
  reason: string | null;
}

export interface DecisionRecord {
  id: string; // <工程>-<試行> (ファイル名と同じ)
  kind: "approval";
  task: string; // 元タスクの ID
  phase: ApprovalPhase;
  attempt: number;
  requirementRevision: number; // 提出の時の要件の版
  submissionSeq: number; // 判断する提出 (元タスクの history の seq)
  submission: Submission;
  status: DecisionStatus;
  assignee: string | null; // 判断する人。null は未割当
  decidedBy: string | null;
  decidedAt: string | null;
  decisionSeq: number | null; // 承認・見送り・無効化を記録した元タスクの history の seq
  outcome: DecisionOutcome | null;
  returnTo: PhaseV4 | null; // 見送りで戻す工程 (plan の見送りは常に plan)
  reason: string | null; // 見送り・無効化の理由
  reportRefs: ArtifactRef[]; // 人の判断の記録 (Markdown)
  createdAt: string;
  origin: DecisionOrigin;
  history: DecisionHistoryEntry[];
  [key: string]: unknown; // 未知の項目は保持する
}

export function parseDecisionId(id: string): { phase: ApprovalPhase; attempt: number } | null {
  const match = approvalIdPattern.exec(id);
  return match ? { phase: match[1] as ApprovalPhase, attempt: Number(match[2]) } : null;
}

export function decisionId(phase: ApprovalPhase, attempt: number): string {
  return `${phase}-${attempt}`;
}

// タスクのディレクトリからの相対パス (history の refs と同じ形)
export function decisionFile(id: string): string {
  return `${decisionsDir}/${id}.md`;
}

export function decisionPath(taskDir: string, id: string): string {
  return join(taskDir, decisionsDir, `${id}.md`);
}

// 1 つの判断記録を検証する (タスクとの照合は checkTaskDecisions)
export function validateDecision(data: unknown): WorkflowIssue[] {
  const check = new Checker();
  if (!check.object(data, "frontmatter")) return check.issues;
  const present = decisionKeys.filter((key) => check.required(data, key, ""));
  const has = (key: (typeof decisionKeys)[number]) => present.includes(key);
  const line = (value: unknown, path: string): boolean => {
    if (value === null || (typeof value === "string" && !/[\r\n]/.test(value))) return true;
    check.add("WF_TYPE", path, `${path} は 1 行の文字列か空にしてください`);
    return false;
  };
  const human = (value: unknown, path: string, label: string): boolean => {
    if (!check.actor(value, path)) return false;
    if (value === null || (value as string).startsWith("human/")) return true;
    check.add("WF_HUMAN", path, `${label}は人 (human/…) です: ${value}`);
    return false;
  };

  let parsed: { phase: ApprovalPhase; attempt: number } | null = null;
  if (has("id")) {
    parsed = typeof data.id === "string" ? parseDecisionId(data.id) : null;
    if (!parsed) check.add("WF_DECISION", "id", `id は <工程>-<試行> (plan-1・review-3 など) です: ${JSON.stringify(data.id)}`);
  }
  if (has("kind") && data.kind !== decisionKind) check.add("WF_DECISION", "kind", `kind は ${decisionKind} です: ${JSON.stringify(data.kind)}`);
  if (has("task") && !(typeof data.task === "string" && taskIdPattern.test(data.task))) check.add("WF_TYPE", "task", `task は元タスクの ID (T-001 の形) です: ${JSON.stringify(data.task)}`);
  const phaseOk = has("phase") && check.enumValue(data.phase, approvalPhases, "phase");
  const attemptOk = has("attempt") && check.integer(data.attempt, "attempt", 1);
  if (parsed && phaseOk && data.phase !== parsed.phase) check.add("WF_DECISION", "phase", `phase (${data.phase}) が id (${data.id}) の工程と違います`);
  if (parsed && attemptOk && data.attempt !== parsed.attempt) check.add("WF_DECISION", "attempt", `attempt (${data.attempt}) が id (${data.id}) の試行と違います`);
  if (has("requirementRevision")) check.integer(data.requirementRevision, "requirementRevision", 1);
  if (has("submissionSeq")) check.integer(data.submissionSeq, "submissionSeq", 1);
  if (has("submission") && check.object(data.submission, "submission")) {
    const submission = data.submission;
    const unknown = Object.keys(submission).filter((key) => !submissionKeys.includes(key));
    if (unknown.length > 0) check.add("WF_FIELD_UNKNOWN", "submission", `submission に使えない項目があります: ${unknown.join(", ")}`);
    if (submissionKeys.map((key) => check.required(submission, key, "submission")).every(Boolean)) {
      check.actor(submission.completedBy, "submission.completedBy", false);
      check.dateTime(submission.completedAt, "submission.completedAt");
      if (check.refs(submission.artifactRefs, "submission.artifactRefs") && (submission.artifactRefs as unknown[]).length === 0) {
        check.add("WF_DECISION", "submission.artifactRefs", "提出の成果物 (submission.artifactRefs) が無い記録は承認の対象になりません (legacy_import は提出ではない)");
      }
    }
  }
  const statusOk = has("status") && check.enumValue(data.status, decisionStatuses, "status");
  if (has("assignee")) human(data.assignee, "assignee", "判断記録の担当");
  if (has("decidedBy")) human(data.decidedBy, "decidedBy", "承認・見送りをする人");
  if (has("decidedAt") && data.decidedAt !== null) check.dateTime(data.decidedAt, "decidedAt");
  if (has("decisionSeq")) check.integer(data.decisionSeq, "decisionSeq", 1, true);
  const outcomeOk = has("outcome") && check.enumValue(data.outcome, decisionOutcomes, "outcome", true);
  const returnOk = has("returnTo") && check.enumValue(data.returnTo, phasesV4, "returnTo", true);
  const reasonOk = has("reason") && line(data.reason, "reason");
  if (has("reportRefs")) check.refs(data.reportRefs, "reportRefs");
  if (has("createdAt")) check.dateTime(data.createdAt, "createdAt");
  const originOk = has("origin") && check.enumValue(data.origin, decisionOrigins, "origin");

  const history: DecisionHistoryEntry[] = [];
  let historyOk = false;
  if (has("history")) {
    if (!Array.isArray(data.history)) check.add("WF_TYPE", "history", "history は配列にしてください");
    else {
      historyOk = true;
      (data.history as unknown[]).forEach((entry, index) => {
        const path = `history[${index}]`;
        if (!check.object(entry, path)) return void (historyOk = false);
        if (!decisionHistoryKeys.map((key) => check.required(entry, key, path)).every(Boolean)) return void (historyOk = false);
        const fine = [
          check.integer(entry.seq, `${path}.seq`, 1),
          check.dateTime(entry.at, `${path}.at`),
          check.actor(entry.actor, `${path}.actor`, false),
          check.enumValue(entry.event, decisionEvents, `${path}.event`),
          line(entry.from, `${path}.from`),
          line(entry.to, `${path}.to`),
          line(entry.reason, `${path}.reason`),
        ].every(Boolean);
        if (fine) history.push(entry as unknown as DecisionHistoryEntry);
        else historyOk = false;
      });
      if ((data.history as unknown[]).length === 0) {
        check.add("WF_HISTORY_ORDER", "history", "history には作成 (create) か移行 (import) の記録が 1 件以上必要です");
        historyOk = false;
      }
    }
  }

  // 状態ごとの項目
  if (statusOk && outcomeOk && returnOk && reasonOk) {
    const status = data.status as DecisionStatus;
    const decided = ["decidedBy", "decidedAt", "decisionSeq"] as const;
    if (status === "open") {
      for (const key of [...decided, "outcome", "returnTo", "reason"] as const) {
        if (data[key] !== null) check.add("WF_DECISION", key, `open の判断記録には ${key} を書きません (判断のときに記録する)`);
      }
    } else {
      for (const key of decided) if (data[key] === null) check.add("WF_DECISION", key, `${status} の判断記録には ${key} が必要です`);
      if (status === "approved") {
        if (data.outcome !== "approved") check.add("WF_DECISION", "outcome", `approved の判断記録の outcome は approved です: ${JSON.stringify(data.outcome)}`);
        if (data.returnTo !== null) check.add("WF_DECISION", "returnTo", "承認した判断記録に戻す工程 (returnTo) は書きません");
      } else if (status === "rejected") {
        if (data.outcome !== "rejected") check.add("WF_DECISION", "outcome", `rejected の判断記録の outcome は rejected です: ${JSON.stringify(data.outcome)}`);
        if (data.reason === null || (data.reason as string).trim() === "") check.add("WF_DECISION", "reason", "見送り (rejected) には理由 (reason) が必要です (この記録に追記する)");
        if (data.returnTo === null) check.add("WF_DECISION", "returnTo", "見送り (rejected) には戻す工程 (returnTo) が必要です");
        else if (phaseOk && data.phase === "plan" && data.returnTo !== "plan") check.add("WF_DECISION", "returnTo", `plan の見送りで戻す工程は plan だけです: ${data.returnTo}`);
      } else {
        if (data.outcome !== null) check.add("WF_DECISION", "outcome", "無効化 (superseded) は承認でも見送りでもないので outcome は空です");
        if (data.reason === null || (data.reason as string).trim() === "") check.add("WF_DECISION", "reason", "無効化 (superseded) には理由 (reason) が必要です");
        if (data.returnTo !== null) check.add("WF_DECISION", "returnTo", "無効化 (superseded) に戻す工程 (returnTo) は書きません");
      }
    }
  }

  // 履歴の整合
  if (historyOk && history.length > 0) {
    let currentAssignee: string | null = null;
    history.forEach((entry, index) => {
      const path = `history[${index}]`;
      if (entry.seq !== index + 1) check.add("WF_HISTORY_ORDER", `${path}.seq`, `history の seq は 1 から順に並べます (${index + 1} の位置に ${entry.seq})`);
      if (index > 0 && Date.parse(entry.at) < Date.parse(history[index - 1].at)) check.add("WF_HISTORY_ORDER", `${path}.at`, `history の日時が前の履歴より前になっています (${entry.at})`);
      if (index > 0 && (entry.event === "create" || entry.event === "import")) check.add("WF_HISTORY_ORDER", `${path}.event`, `${entry.event} は最初の履歴にだけ書けます`);
      if (humanEvents.includes(entry.event) && !entry.actor.startsWith("human/")) check.add("WF_HUMAN", `${path}.actor`, `判断記録の ${entry.event} は人 (human/…) だけができます: ${entry.actor}`);
      if (["assign", "reject", "supersede"].includes(entry.event) && (entry.reason === null || entry.reason.trim() === "")) check.add("WF_REASON", `${path}.reason`, `${entry.event} には理由 (reason) が必要です`);
      // 履歴を順にたどり、その操作の時点の判断者を確かめる。assign の依頼元権限はタスクとの照合で確かめる。
      if (index === 0 && (entry.event === "create" || entry.event === "import")) {
        if (entry.from !== null) check.add("WF_DECISION", `${path}.from`, `${entry.event} の from は空です`);
        if (entry.to !== null && !(actorPattern.test(entry.to) && entry.to.startsWith("human/"))) check.add("WF_HUMAN", `${path}.to`, `${entry.event} の担当は人 (human/…) か空です: ${entry.to}`);
        currentAssignee = entry.to;
      } else if (entry.event === "claim") {
        if (currentAssignee !== null) check.add("WF_NOT_APPROVER", `${path}.actor`, `claim は未割当の判断記録だけにできます (今の担当: ${currentAssignee})`);
        if (entry.from !== null) check.add("WF_DECISION", `${path}.from`, "claim の from は空 (未割当) です");
        if (entry.to === null || !(actorPattern.test(entry.to) && entry.to.startsWith("human/"))) check.add("WF_HUMAN", `${path}.to`, "claim の to は引き受けた人 (human/…) です");
        if (entry.actor !== entry.to) check.add("WF_NOT_APPROVER", `${path}.actor`, `claim の actor (${entry.actor}) と引受先 (${entry.to}) が違います`);
        currentAssignee = entry.to;
      } else if (entry.event === "assign") {
        if (currentAssignee === null) check.add("WF_NOT_APPROVER", `${path}.actor`, "assign は割当済みの判断記録だけにできます");
        if (entry.from !== currentAssignee) check.add("WF_DECISION", `${path}.from`, `assign の from (${entry.from}) がその時点の担当 (${currentAssignee}) と違います`);
        if (entry.to !== null && !(actorPattern.test(entry.to) && entry.to.startsWith("human/"))) check.add("WF_HUMAN", `${path}.to`, "assign の to は替えた先の人 (human/…) か空です");
        currentAssignee = entry.to;
      } else if (entry.event === "approve" || entry.event === "reject") {
        if (currentAssignee === null || entry.actor !== currentAssignee) check.add("WF_NOT_APPROVER", `${path}.actor`, `${entry.event} はその時点の担当本人だけができます (担当: ${currentAssignee ?? "未割当"}、actor: ${entry.actor})`);
      }
    });
    if (originOk) {
      const first = data.origin === "import" ? "import" : "create";
      if (history[0].event !== first) check.add("WF_HISTORY_ORDER", "history[0].event", `origin ${data.origin} の判断記録の最初の履歴は ${first} です (${history[0].event})`);
    }
    const closing = history.filter((entry) => closingEvents.includes(entry.event));
    if (closing.length > 1) check.add("WF_HISTORY_ORDER", "history", `判断記録を閉じる出来事 (approve / reject / supersede) は 1 件だけです (${closing.map((entry) => entry.event).join(", ")})`);
    else if (closing.length === 1 && closing[0] !== history[history.length - 1]) check.add("WF_HISTORY_ORDER", "history", "閉じた判断記録には履歴を足しません (新しい試行には新しい記録を作る)");
    if (statusOk) {
      const status = data.status as DecisionStatus;
      const expected = { open: null, approved: "approve", rejected: "reject", superseded: "supersede" }[status];
      const last = closing.length === 1 ? closing[0] : undefined;
      if (expected === null && last !== undefined) check.add("WF_DECISION", "status", `open の判断記録に ${last.event} の履歴があります (状態は ${last.event === "approve" ? "approved" : last.event === "reject" ? "rejected" : "superseded"})`);
      // 移行より後の日時なら単体でも approve 履歴が必要。同時刻は単体では先後を決めず、
      // checkTaskDecisions で migrate より前後の seq と出来事を照合する。
      const importedApproval = originOk && data.origin === "import" && status === "approved" &&
        history.length === 1 && history[0].event === "import" && last === undefined &&
        typeof data.decidedAt === "string" && isValidDateTime(data.decidedAt) && Date.parse(data.decidedAt) <= Date.parse(history[0].at);
      if (originOk && data.origin === "import" && status === "approved" && last === undefined && history.length > 1) {
        check.add("WF_HISTORY_ORDER", "history", "approve の履歴が無い移行記録は import の 1 件だけです (移行元の承認かはタスクと照合します)");
      }
      if (expected !== null && last === undefined && !importedApproval) check.add("WF_DECISION", "status", `${status} の判断記録には ${expected} の履歴が必要です (移行が作った承認 (origin: import) だけは移行元の受入確認の記録で判断する)`);
      if (expected !== null && last !== undefined && last.event !== expected) check.add("WF_DECISION", "status", `${status} の判断記録には ${expected} の履歴が必要です (${last.event})`);
      if (expected !== null && last !== undefined && last.event === expected) {
        if (data.decidedBy !== null && last.actor !== data.decidedBy) check.add("WF_DECISION", "decidedBy", `decidedBy (${data.decidedBy}) が ${last.event} の履歴の actor (${last.actor}) と違います`);
        if (data.decidedAt !== null && last.at !== data.decidedAt) check.add("WF_DECISION", "decidedAt", `decidedAt (${data.decidedAt}) が ${last.event} の履歴の日時 (${last.at}) と違います`);
        if (last.event === "reject" && data.returnTo !== null && last.to !== data.returnTo) check.add("WF_DECISION", "returnTo", `returnTo (${data.returnTo}) が reject の履歴の戻す工程 (to: ${last.to}) と違います`);
      }
    }
    // frontmatter の担当は、履歴を最後までたどった結果と一致する。
    if (has("assignee") && (data.assignee ?? null) !== currentAssignee) {
      check.add("WF_DECISION", "assignee", `assignee (${JSON.stringify(data.assignee)}) が履歴を順にたどった担当 (${JSON.stringify(currentAssignee)}) と違います`);
    }
  }
  return check.issues;
}

// decisions/<工程>-<試行>.md を読んで検証する
export function readDecisionFile(text: string, source = "decision.md"): { frontmatter: YamlFrontmatter; issues: WorkflowIssue[] } {
  const frontmatter = YamlFrontmatter.parse(text, source);
  return { frontmatter, issues: validateDecision(frontmatter.data()) };
}

export interface DecisionFile {
  id: string; // ファイル名 (拡張子を除く)
  data: unknown; // frontmatter の値。読めなければ undefined
}

// タスクと判断記録の照合 (03 の 4 の 1〜4、7 の孤立した記録)。task は validateTaskV4 で問題の無いもの
export function checkTaskDecisions(task: TaskV4, files: DecisionFile[]): WorkflowIssue[] {
  const check = new Checker();
  const history = task.history;
  const migrateSeq = migrateSeqOf(history);
  const imported = (seq: number) => migrateSeq !== null && seq < migrateSeq;
  const valid = new Map<string, DecisionRecord>();
  const seen = new Set<string>();
  // タスクが今指している (人の確認待ちの) 記録
  const waitingPhase = task.status === "pending" && task.phase !== null && (approvalPhases as readonly string[]).includes(task.phase) ? (task.phase as ApprovalPhase) : null;
  const waitingId = waitingPhase !== null ? task.workflow[waitingPhase].approval : null;

  for (const file of files) {
    const where = decisionFile(file.id);
    if (seen.has(file.id)) {
      check.add("WF_DECISION", where, `同じ ID の判断記録が複数あります: ${file.id}`);
      continue;
    }
    seen.add(file.id);
    if (!parseDecisionId(file.id)) {
      check.add("WF_DECISION", where, `判断記録のファイル名は <工程>-<試行>.md です: ${file.id}`);
      continue;
    }
    if (file.data === undefined) {
      check.add("WF_DECISION", where, `判断記録を読めません: ${where}`);
      continue;
    }
    const issues = validateDecision(file.data);
    if (issues.length > 0) {
      for (const issue of issues) check.add(issue.code, `${where}: ${issue.path}`, issue.message);
      continue;
    }
    const decision = file.data as DecisionRecord;
    if (decision.id !== file.id) {
      check.add("WF_DECISION", `${where}: id`, `id (${decision.id}) がファイル名 (${file.id}) と違います`);
      continue;
    }
    valid.set(file.id, decision);
    if (decision.task !== task.id) check.add("WF_DECISION", `${where}: task`, `判断記録の task (${decision.task}) がこのタスク (${task.id}) と違います`);
    // assign はその時点の担当本人、または人であるタスクの依頼元だけが行える (T11)。
    let currentAssignee: string | null = null;
    decision.history.forEach((entry, index) => {
      if (entry.event === "create" || entry.event === "import" || entry.event === "claim") currentAssignee = entry.to;
      if (entry.event === "assign") {
        const requester = typeof task.requestedBy === "string" && task.requestedBy.startsWith("human/") && entry.actor === task.requestedBy;
        if (entry.actor !== currentAssignee && !requester) {
          check.add("WF_NOT_APPROVER", `${where}: history[${index}].actor`, `assign はその時点の担当本人か人である依頼元だけができます (担当: ${currentAssignee ?? "未割当"}、actor: ${entry.actor})`);
        }
        currentAssignee = entry.to;
      }
    });
    const record = task.workflow[decision.phase];
    if (decision.attempt > record.attempt) check.add("WF_DECISION", `${where}: attempt`, `試行 ${decision.attempt} は ${decision.phase} の今の試行 ${record.attempt} より大きい`);

    // 提出との照合 (3・4)
    const submission = submissionOf(history, decision.phase, decision.attempt);
    if (!submission) check.add("WF_APPROVAL_STALE", `${where}: submissionSeq`, `${decision.phase} の試行 ${decision.attempt} に提出とみなす履歴 (complete。移行なら移行元の review の decide approved) がありません`);
    else if (decision.submissionSeq !== submission.seq) {
      check.add("WF_APPROVAL_STALE", `${where}: submissionSeq`, `提出の seq が違います (記録: ${decision.submissionSeq}、タスクの ${decision.phase} 試行 ${decision.attempt} の最後の提出: ${submission.seq})`);
    } else {
      if (decision.submission.completedBy !== submission.actor) check.add("WF_APPROVAL_STALE", `${where}: submission.completedBy`, `提出者の写し (${decision.submission.completedBy}) が提出の履歴 seq ${submission.seq} の actor (${submission.actor}) と違います`);
      if (decision.submission.completedAt !== submission.at) check.add("WF_APPROVAL_STALE", `${where}: submission.completedAt`, `提出の日時の写し (${decision.submission.completedAt}) が提出の履歴 seq ${submission.seq} の at (${submission.at}) と違います`);
      if (!sameArtifactRefs(decision.submission.artifactRefs, submission.refs)) check.add("WF_APPROVAL_STALE", `${where}: submission.artifactRefs`, `提出の成果物の写しが提出の履歴 seq ${submission.seq} の refs と違います`);
      if (submission.inputRevision !== null && decision.requirementRevision !== submission.inputRevision) {
        check.add("WF_APPROVAL_STALE", `${where}: requirementRevision`, `要件の版 (${decision.requirementRevision}) が提出の履歴 seq ${submission.seq} の版 (${submission.inputRevision}) と違います`);
      }
      const origin = imported(submission.seq) ? "import" : "submit";
      if (decision.origin !== origin) check.add("WF_DECISION", `${where}: origin`, `提出 (seq ${submission.seq}) は${origin === "import" ? "移行元の記録なので origin は import" : "v4 の complete なので origin は submit"} です: ${decision.origin}`);
    }

    if (decision.status === "open") {
      if (waitingId === decision.id && waitingPhase === decision.phase) {
        if (decision.requirementRevision !== task.requirementRevision) {
          check.add("WF_APPROVAL_STALE", `${where}: requirementRevision`, `要件の版 (${decision.requirementRevision}) が今のタスクの版 (${task.requirementRevision}) と違います (版を上げたら open の記録は superseded にする)`);
        }
      } else {
        check.add("WF_APPROVAL_ORPHAN", where, `タスクが指していない open の判断記録です (承認できない。途中で失敗した操作の残りなら人が確かめて片付ける): ${where}`);
      }
      continue;
    }
    // 閉じた記録は、タスクの history の判断の記録と対になる
    const entry = history.find((item) => item.seq === decision.decisionSeq);
    const event = decision.status === "approved" ? "approve" : decision.status === "rejected" ? "reject" : "supersede";
    if (!entry) check.add("WF_DECISION", `${where}: decisionSeq`, `decisionSeq が存在しない履歴を指しています: ${decision.decisionSeq}`);
    else if (imported(entry.seq)) {
      // decisionSeq が移行元の承認を指すなら、import 後の操作は一切ない。
      if (decision.history.length !== 1 || decision.history[0].event !== "import") {
        check.add("WF_HISTORY_ORDER", `${where}: history`, "移行元で承認済みの判断記録には import 後の履歴を足せません");
      }
      const ok = decision.origin === "import" && decision.status === "approved" && decision.phase === "review" && entry.event === "decide" && entry.phase === "acceptance" && entry.outcome === "approved" && entry.actor.startsWith("human/");
      if (!ok) check.add("WF_DECISION", `${where}: decisionSeq`, `移行した判断記録が判断として指せるのは、移行元の受入確認の decide approved (人) だけです (seq ${entry.seq}: ${entry.event} ${entry.phase ?? "工程なし"} ${entry.outcome ?? ""})`);
      else {
        if (entry.actor !== decision.decidedBy) check.add("WF_DECISION", `${where}: decidedBy`, `decidedBy (${decision.decidedBy}) が移行元の受入確認 seq ${entry.seq} の actor (${entry.actor}) と違います`);
        if (entry.at !== decision.decidedAt) check.add("WF_DECISION", `${where}: decidedAt`, `decidedAt (${decision.decidedAt}) が移行元の受入確認 seq ${entry.seq} の日時 (${entry.at}) と違います (日付だけの completedAt は使わない)`);
      }
    } else if (entry.event !== event || entry.phase !== decision.phase || entry.attempt !== decision.attempt) {
      check.add("WF_DECISION", `${where}: decisionSeq`, `decisionSeq ${entry.seq} は ${decision.phase} (試行 ${decision.attempt}) の ${event} ではありません (${entry.event} ${entry.phase ?? "工程なし"} ${entry.attempt ?? ""})`);
    } else {
      // import 後の承認は、タスクだけでなく判断記録にも approve の閉鎖履歴が必要。
      if (decision.origin === "import" && decision.status === "approved" && decision.history.at(-1)?.event !== "approve") {
        check.add("WF_DECISION", `${where}: history`, "移行後の approve に対応する判断記録の approve 履歴がありません");
      }
      if (entry.actor !== decision.decidedBy) check.add("WF_DECISION", `${where}: decidedBy`, `decidedBy (${decision.decidedBy}) がタスクの ${event} (seq ${entry.seq}) の actor (${entry.actor}) と違います`);
      if (entry.at !== decision.decidedAt) check.add("WF_DECISION", `${where}: decidedAt`, `decidedAt (${decision.decidedAt}) がタスクの ${event} (seq ${entry.seq}) の日時 (${entry.at}) と違います`);
      if (decision.status === "rejected" && entry.to !== decision.returnTo) check.add("WF_DECISION", `${where}: returnTo`, `returnTo (${decision.returnTo}) がタスクの reject (seq ${entry.seq}) の戻す工程 (to: ${entry.to}) と違います`);
    }
  }

  // タスクが指す記録 (2)
  if (waitingPhase !== null && waitingId !== null && waitingId !== legacyUnverified) {
    const path = `workflow.${waitingPhase}.approval`;
    if (!seen.has(waitingId)) check.add("WF_APPROVAL", path, `人の確認待ちの判断記録 ${waitingId} (${decisionFile(waitingId)}) がありません`);
    else {
      const decision = valid.get(waitingId);
      if (decision && decision.status !== "open") check.add("WF_APPROVAL_CLOSED", path, `人の確認待ちの判断記録 ${waitingId} は ${decision.status} です (open の記録だけを待てる)`);
    }
  }
  // 承認されたとして先へ進んだ工程の記録
  for (const phase of approvalPhases) {
    const id = task.workflow[phase].approval;
    if (id === null || id === legacyUnverified || id === waitingId) continue;
    const path = `workflow.${phase}.approval`;
    if (!seen.has(id)) check.add("WF_APPROVAL", path, `判断記録 ${id} (${decisionFile(id)}) がありません`);
    else {
      const decision = valid.get(id);
      if (decision && decision.status !== "approved") check.add("WF_APPROVAL_CLOSED", path, `${id} は ${decision.status} です (承認された記録だけを持ったまま ${phase} の後へ進める)`);
    }
  }
  // 承認・見送り・無効化の履歴が指す記録
  for (const phase of approvalPhases) {
    const attempts = new Set(history.filter((entry) => entry.phase === phase && entry.attempt !== null).map((entry) => entry.attempt as number));
    for (const attempt of attempts) {
      const last = decisionEventsOf(history, phase, attempt).at(-1);
      if (!last) continue;
      const id = decisionId(phase, attempt);
      const path = `history[${last.seq - 1}].refs`;
      if (!seen.has(id)) check.add("WF_DECISION", path, `${last.event} が指す判断記録 ${id} (${decisionFile(id)}) がありません`);
      else {
        const decision = valid.get(id);
        const expected = last.event === "approve" ? "approved" : last.event === "reject" ? "rejected" : "superseded";
        if (decision && decision.status !== expected) check.add("WF_DECISION", `${decisionFile(id)}: status`, `タスクの ${last.event} (seq ${last.seq}) があるので ${id} の状態は ${expected} です: ${decision.status}`);
        else if (decision && decision.decisionSeq !== last.seq) check.add("WF_DECISION", `${decisionFile(id)}: decisionSeq`, `decisionSeq (${decision.decisionSeq}) がタスクの ${last.event} (seq ${last.seq}) と違います`);
      }
    }
  }
  return check.issues;
}

// 提出 (complete) の直後のタスクから、その工程の今の試行の判断記録 (open) を作る。actor は記録を作る操作の actor (提出は提出者、移行は移行を行う人)
export function initialDecision(input: { task: TaskV4; phase: ApprovalPhase; actor: string; at: string; assignee?: string | null; reason?: string | null }): DecisionRecord {
  const record = input.task.workflow[input.phase];
  const submission = submissionOf(input.task.history, input.phase, record.attempt);
  if (!submission) throw new TypeError(`${input.phase} (試行 ${record.attempt}) に提出の履歴がありません`);
  if (!actorPattern.test(input.actor)) throw new TypeError(`actor は human/<識別子> か agent/<識別子> です: ${JSON.stringify(input.actor)}`);
  if (!isValidDateTime(input.at)) throw new TypeError(`at はタイムゾーン付きの日時です: ${JSON.stringify(input.at)}`);
  const assignee = input.assignee !== undefined ? input.assignee : (input.task.approvers?.[input.phase] ?? null);
  if (assignee !== null && !(actorPattern.test(assignee) && assignee.startsWith("human/"))) throw new TypeError(`判断記録の担当は人 (human/<識別子>) です: ${JSON.stringify(assignee)}`);
  const migrateSeq = migrateSeqOf(input.task.history);
  const origin: DecisionOrigin = migrateSeq !== null && submission.seq < migrateSeq ? "import" : "submit";
  return {
    id: decisionId(input.phase, record.attempt),
    kind: decisionKind,
    task: input.task.id,
    phase: input.phase,
    attempt: record.attempt,
    requirementRevision: submission.inputRevision ?? input.task.requirementRevision,
    submissionSeq: submission.seq,
    submission: { completedBy: submission.actor, completedAt: submission.at, artifactRefs: structuredClone(submission.refs) },
    status: "open",
    assignee,
    decidedBy: null,
    decidedAt: null,
    decisionSeq: null,
    outcome: null,
    returnTo: null,
    reason: null,
    reportRefs: [],
    createdAt: input.at,
    origin,
    history: [{ seq: 1, at: input.at, actor: input.actor, event: origin === "import" ? "import" : "create", from: null, to: assignee, reason: input.reason ?? null }],
  };
}

// ---- 索引 ----------------------------------------------------------------------------------------------------------

export const approvalIndexName = "approval"; // status/approval/<工程>/<名前> (approval は工程名ではなく予約した名前)
export const approvalQueueDirs = ["approvals", "open"] as const; // jobs/<案件>/approvals/open/

// 人の確認待ち (タスクの pending) の作業索引
export function approvalWorkLinkPath(jobDir: string, phase: ApprovalPhase, name: string): string {
  return workLinkPath(jobDir, approvalIndexName, phase, name);
}

// v4 のタスクの今の作業索引 (open なら今の工程と状態、pending なら status/approval/<工程>/、closed なら無し)。リンク先は workLinkTarget(name)
export function expectedWorkLinkV4(jobDir: string, name: string, task: Pick<TaskV4, "status" | "phase" | "workflow">): string | null {
  if (task.phase === null) return null;
  if (task.status === "open") return workLinkPath(jobDir, task.phase, task.workflow[task.phase].status, name);
  if (task.status === "pending" && (approvalPhases as readonly string[]).includes(task.phase)) return approvalWorkLinkPath(jobDir, task.phase as ApprovalPhase, name);
  return null;
}

export function approvalQueueDir(jobDir: string): string {
  return join(jobDir, ...approvalQueueDirs);
}

export function approvalQueueLinkName(name: string, id: string): string {
  return `${name}--${id}`;
}

// 確認待ちの索引 (open の記録ごとに 1 件)
export function approvalQueueLinkPath(jobDir: string, name: string, id: string): string {
  return join(approvalQueueDir(jobDir), approvalQueueLinkName(name, id));
}

export function approvalQueueLinkTarget(name: string, id: string): string {
  return `../../tasks/${name}/${decisionFile(id)}`;
}

// approvals/open/ のエントリ名からタスク名と判断記録の ID を取り出す (タスク名にはハイフンがあるので、最後の "--" で分ける)
export function parseApprovalQueueLinkName(entry: string): { name: string; id: string } | null {
  const at = entry.lastIndexOf("--");
  if (at <= 0) return null;
  const name = entry.slice(0, at);
  const id = entry.slice(at + 2);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || !approvalIdPattern.test(id)) return null;
  return { name, id };
}

// あるべき確認待ちの索引 (open の記録だけ。閉じた記録は 0 件)
export function expectedQueueLinks(jobDir: string, name: string, decisions: readonly Pick<DecisionRecord, "id" | "status">[]): string[] {
  return decisions.filter((decision) => decision.status === "open").map((decision) => approvalQueueLinkPath(jobDir, name, decision.id));
}

// リンク先 (workLinkTarget と同じ深さ) を再輸出しておく
export { workLinkTarget };
