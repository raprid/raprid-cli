// 工程型タスク (workflowVersion 3) の画面用の判定と表示。Ink に依存しない純粋な関数。T-015
//
// scripts/ が query-v2・workflow-v3 に対応しているときだけ、snapshot に工程型の項目 (type・phase・phaseStatus・assignee・
// workflow・history) が入る。工程の操作は scripts/ の task claim・complete・decide・block・resume・reopen・assign に渡し、
// 規則 (職務分離・人の受入確認・revision) は scripts/ がロックの中で確かめる。画面は、今の状態と actor でできる操作だけを並べる。
// 旧形式の状態の選択 (todo / done など) は工程型タスクには出さない (単純な状態の選択で承認を迂回できないように)。

import { sanitize } from "./text.js";
import type { ArtifactRef, PhaseRecord, TaskRecord } from "./types.js";

export const workflowPhases = ["plan", "execute", "review", "acceptance"] as const;
export type WorkflowPhase = (typeof workflowPhases)[number];
export type ReturnTarget = "plan" | "execute";

export type WorkflowStep =
  | { op: "claim" }
  | { op: "resume" }
  | { op: "complete"; handoff: string; artifacts: string[]; commits: string[] }
  | { op: "decide"; outcome: "approved" | "changes_requested"; report: string; returnTo?: ReturnTarget; reason?: string }
  | { op: "block"; blockedBy: string[]; reason?: string }
  | { op: "reopen"; returnTo: ReturnTarget; reason: string }
  | { op: "assign"; phase: WorkflowPhase; assignee: string; reason: string; handoff?: string };

export type StepKind = "claim" | "resume" | "complete" | "approve" | "requestChanges" | "block" | "reopen" | "assign";

export const phaseLabels: Record<string, string> = { plan: "計画", execute: "実行", review: "レビュー", acceptance: "受入確認", implement: "実装 (v2)" };
export const typeLabels: Record<string, string> = { research: "調査", implementation: "実装" };

export function isWorkflowTask(record: { kind: string } & Partial<TaskRecord>): record is TaskRecord & { workflowVersion: number } {
  return record.kind === "task" && typeof record.workflowVersion === "number";
}

// 一覧の列。旧形式は種別・担当が「-」、工程が「未移行」
export function typeText(record: TaskRecord): string {
  if (!isWorkflowTask(record)) return "-";
  if (record.readable === false) return "読めない";
  return record.type ? (typeLabels[record.type] ?? sanitize(record.type)) : `v${record.workflowVersion}`;
}

export function phaseText(record: TaskRecord): string {
  if (!isWorkflowTask(record)) return "未移行";
  if (record.status === "closed") return "-";
  return record.phase ? sanitize(record.phase) : "未設定";
}

// 状態の列。工程型は今の工程の状態、閉じていれば closed (工程の done とタスクの closed を区別する)
export function statusText(record: TaskRecord): string {
  if (!isWorkflowTask(record)) return record.status === null ? "未設定" : sanitize(record.status);
  if (record.status === "closed") return "closed";
  return record.phaseStatus ? sanitize(record.phaseStatus) : "未設定";
}

export function assigneeText(record: TaskRecord): string {
  if (!isWorkflowTask(record) || record.status === "closed") return "-";
  return record.assignee ? sanitize(record.assignee) : "未割当";
}

// 旧形式の状態の並び (progress → todo → pending → done) に当てはめた状態。絞り込みと並び順に使う
export function legacyStatusOf(record: TaskRecord): string | null {
  if (!isWorkflowTask(record)) return record.status;
  if (record.status === "closed") return "done";
  return ({ progress: "progress", ready: "todo", pending: "pending" } as Record<string, string>)[record.phaseStatus ?? ""] ?? null;
}

const stepLabels: Record<StepKind, string> = {
  claim: "引き受ける (claim)",
  resume: "再開する (resume)",
  complete: "完了する (complete)",
  approve: "承認する (decide approved)",
  requestChanges: "差し戻す (decide changes_requested)",
  block: "待ちにする (block)",
  reopen: "やり直す (reopen)",
  assign: "担当を替える (assign)",
};

export function stepLabel(kind: StepKind, phase: string | null | undefined): string {
  if (kind === "approve" && phase === "acceptance") return "受け入れる (受入確認の承認)";
  if (kind === "requestChanges" && phase === "acceptance") return "受け入れずに差し戻す (受入確認)";
  return stepLabels[kind];
}

// 今の状態と actor でできる操作。TUI の actor は人 (human/…)。規則の最終判断は scripts/ が行う (ここで出さない操作は scripts/ でも拒否される)
export function availableSteps(record: TaskRecord, actor: string | null): StepKind[] {
  if (!isWorkflowTask(record) || record.workflowVersion !== 3 || record.valid === false) return [];
  if (record.status === "closed") return ["reopen"];
  const phase = record.phase ?? "";
  const current = record.workflow?.[phase];
  const status = record.phaseStatus ?? current?.status;
  const mine = actor !== null && record.assignee === actor;
  const steps: StepKind[] = [];
  if (status === "ready") {
    if (record.assignee === null || record.assignee === undefined || mine) steps.push("claim");
    steps.push("assign");
  } else if (status === "progress") {
    if (mine) steps.push(phase === "plan" || phase === "execute" ? "complete" : "approve", ...(phase === "review" || phase === "acceptance" ? (["requestChanges"] as StepKind[]) : []));
    steps.push("block", "assign");
  } else if (status === "pending") {
    steps.push("resume");
  }
  if (status !== "pending") steps.push("reopen");
  return steps;
}

// scripts/ の CLI の引数 (task <op> <案件名> <タスク> …)。revision と --json は backend が足す
export function stepArgs(step: WorkflowStep, actor: string): string[] {
  switch (step.op) {
    case "claim":
    case "resume":
      return [step.op, "--actor", actor];
    case "complete":
      return ["complete", "--actor", actor, "--handoff", step.handoff, ...step.artifacts.flatMap((path) => ["--artifact", path]), ...step.commits.flatMap((commit) => ["--commit", commit])];
    case "decide":
      return ["decide", step.outcome, "--actor", actor, "--report", step.report, ...(step.returnTo ? ["--return-to", step.returnTo] : []), ...(step.reason ? ["--reason", step.reason] : [])];
    case "block":
      return ["block", "--actor", actor, ...step.blockedBy.flatMap((value) => ["--blocked-by", value]), ...(step.reason ? ["--reason", step.reason] : [])];
    case "reopen":
      return ["reopen", "--return-to", step.returnTo, "--actor", actor, "--reason", step.reason];
    case "assign":
      return ["assign", step.phase, step.assignee, "--by", actor, "--reason", step.reason, ...(step.handoff ? ["--handoff", step.handoff] : [])];
  }
}

export function refText(refs: ArtifactRef[] | undefined): string {
  if (!refs || refs.length === 0) return "-";
  return refs.map((ref) => sanitize([ref.path, ref.repo !== undefined ? `${ref.repo}@${ref.commit ?? "?"}` : undefined].filter((value) => value !== undefined).join(" "))).join(", ");
}

function phaseLine(phase: string, record: PhaseRecord): string {
  const parts = [`${phaseLabels[phase] ?? phase} ${sanitize(record.status)}`, `試行 ${record.attempt}`, `担当 ${record.assignee ? sanitize(record.assignee) : "未割当"}`];
  if (record.completedBy) parts.push(`完了 ${sanitize(record.completedBy)} ${sanitize(record.completedAt ?? "")} ${sanitize(record.outcome ?? "")}`.trimEnd());
  if (record.artifactRefs.length > 0) parts.push(`成果物 ${refText(record.artifactRefs)}`);
  return parts.join(" / ");
}

// 詳細パネルの工程型の部分 (見出しの下に入れる)
export function workflowDetail(record: TaskRecord): { text: string; bold?: boolean; color?: string; dim?: boolean }[] {
  if (!isWorkflowTask(record)) return [];
  if (record.readable === false) return [{ text: "工程型のタスクですが frontmatter を読めません (要確認を見てください)", color: "red" }];
  const lines: { text: string; bold?: boolean; color?: string; dim?: boolean }[] = [
    { text: `種別    ${typeText(record)} (workflowVersion ${record.workflowVersion})${record.valid === false ? "  不整合あり" : ""}`, color: record.valid === false ? "red" : undefined },
    {
      text:
        record.status === "closed"
          ? `状態    closed (${sanitize(record.closureReason ?? "理由なし")})  ※タスク全体が閉じている`
          : `工程    ${phaseLabels[record.phase ?? ""] ?? phaseText(record)} ${statusText(record)} / 担当 ${assigneeText(record)}`,
      bold: true,
    },
    { text: `要件の版 ${record.requirementRevision ?? "-"}` },
  ];
  for (const phase of workflowPhases) {
    const phaseRecord = record.workflow?.[phase];
    if (phaseRecord) lines.push({ text: `  ${phaseLine(phase, phaseRecord)}`, color: phase === record.phase && record.status !== "closed" ? "cyan" : undefined });
  }
  const history = record.history ?? [];
  if (history.length > 0) {
    lines.push({ text: `履歴 (新しい ${Math.min(5, history.length)} 件 / 全 ${history.length} 件)`, dim: true });
    for (const entry of history.slice(-5).reverse()) {
      const text = [entry.seq, entry.at, entry.actor, entry.event, entry.phase, entry.outcome, entry.reason].filter((value) => value !== null && value !== undefined).map((value) => sanitize(String(value))).join(" ");
      lines.push({ text: `  ${text}`, dim: true });
    }
  }
  return lines;
}

// 受入確認の確認画面に示す根拠: 要件の版、レビューの判定と記録、実行の完了と成果物 (対象の commit・資料)。
// 成果物は 1 件ずつ 1 行にし、画面ではすべてをスクロールして見られるようにする (R15-1)
export function acceptanceEvidence(record: TaskRecord): string[] {
  const execute = record.workflow?.execute;
  const review = record.workflow?.review;
  const each = (label: string, refs: ArtifactRef[] | undefined) => (refs && refs.length > 0 ? refs.map((ref, index) => `${index === 0 ? label : " ".repeat(label.length)}${refText([ref])}`) : [`${label}-`]);
  const lines = [
    `要件の版        ${record.requirementRevision ?? "-"}`,
    `レビューの判定  ${review?.outcome ?? "-"} ${review?.completedBy ?? "-"} ${review?.completedAt ?? ""} (試行 ${review?.attempt ?? "-"})`,
    ...each("レビューの記録  ", review?.artifactRefs),
    `実行の完了      ${execute?.completedBy ?? "-"} ${execute?.completedAt ?? ""} (試行 ${execute?.attempt ?? "-"})`,
    ...each("実行の成果物    ", execute?.artifactRefs),
  ];
  const commits = (execute?.artifactRefs ?? []).filter((ref) => ref.commit !== undefined);
  if (record.type === "implementation" && commits.length === 0) lines.push("※ 実行の成果物に commit がありません (資料だけの変更か、引継資料で確かめてください)");
  return lines;
}
