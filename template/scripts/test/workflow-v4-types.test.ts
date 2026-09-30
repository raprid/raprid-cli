// TaskV4・DecisionRecord の公開型の契約 (R18-1 と同じ考え方)。実行時の検証 (validateTaskV4・validateDecision) とは別に、
// 型が T-019 の契約 (03-contract.md の 1・4) を表しているかを確かめる。
//
// (1) このファイルの contracts() は pnpm typecheck の対象。@ts-expect-error を付けた行が型エラーにならなければ型検査が失敗する
// (2) 下の試験は pnpm test からも tsc を実行し、(1) が通ることと、指示なしの欠落・誤った型が実際に型エラーになることを確かめる

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type DecisionRecord, initialDecision } from "../lib/decision.ts";
import { type ApprovalPhase, type HistoryEntryV3, type HistoryEntryV4, type PhaseRecord, type PhaseRecordV4, type PhaseStatus, type PhaseV4, type TaskStatusV4, type TaskType, type TaskV3, type TaskV4, type WaitingV4, initialTaskV3, initialTaskV4, waitingOfV4 } from "../lib/workflow.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const workflowPath = join(root, "scripts", "lib", "workflow.ts");
const decisionPath = join(root, "scripts", "lib", "decision.ts");
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
const options = ["--noEmit", "--strict", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--allowImportingTsExtensions", "--verbatimModuleSyntax", "--skipLibCheck", "--types", "node"];

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type KnownKeys<T> = keyof { [K in keyof T as string extends K ? never : K]: T[K] };
type UnknownFields<T> = { [K in KnownKeys<T>]-?: unknown extends T[K] ? K : never }[KnownKeys<T>];
// v3 と v4 で意味も型も同じ項目
type Shared = "id" | "type" | "requirementRevision" | "createdAt" | "updatedAt" | "completedAt" | "requestedBy" | "createdBy" | "blockedBy" | "relatedTasks";

export function contracts(): void {
  const full = initialTaskV4({ id: "T-001", type: "research", date: "2026-10-01", requestedBy: "human/saiki", createdBy: "agent/codex" });

  // 正しい TaskV4 の項目は、キャストなしで具体的な型として使える
  const id: string = full.id;
  const type: TaskType = full.type;
  const status: TaskStatusV4 = full.status;
  const phase: PhaseV4 | null = full.phase;
  const closureReason: "approved" | "legacy_done" | null = full.closureReason;
  const planApproval: string | null = full.workflow.plan.approval;
  const executeStatus: PhaseStatus = full.workflow.execute.status;
  const planOutcome: "completed" | "legacy_import" | null = full.workflow.plan.outcome;
  const approvers: { plan?: string | null; review?: string | null } | undefined = full.approvers;
  const historyPhase: PhaseV4 | "implement" | "acceptance" | null = full.history[0].phase;
  const waiting: WaitingV4 = waitingOfV4(full);
  void [id, type, status, phase, closureReason, planApproval, executeStatus, planOutcome, approvers, historyPhase, waiting];

  // 未知の拡張項目 (test など) は許す。approvers・migratedFrom は任意
  const extended: TaskV4 = { ...full, test: ["docs/feature/raprid/workflow-v4-data-model.feature"], approvers: { plan: "human/saiki" }, migratedFrom: { workflowVersion: 3, acceptance: {} } };
  void extended;

  // 明示した項目に unknown が無く、項目の一覧が契約どおり。v3 と共通の項目の型は v3 と同じ。工程の記録は v3 の項目に approval を足したもの
  const noUnknownV4: Equal<UnknownFields<TaskV4>, never> = true;
  const noUnknownHistory: Equal<UnknownFields<HistoryEntryV4>, never> = true;
  const noUnknownDecision: Equal<UnknownFields<DecisionRecord>, never> = true;
  const keysV4: Equal<KnownKeys<TaskV4>, Shared | "workflowVersion" | "status" | "phase" | "closureReason" | "approvers" | "workflow" | "history" | "migratedFrom"> = true;
  const sharedSame: Equal<Pick<TaskV3, Shared>, Pick<TaskV4, Shared>> = true;
  const executeSame: Equal<Omit<PhaseRecordV4, "outcome">, Omit<PhaseRecord, "outcome">> = true;
  const historyShared: Equal<Omit<HistoryEntryV4, "phase" | "event" | "outcome">, Omit<HistoryEntryV3, "phase" | "event" | "outcome">> = true;
  const workflowKeys: Equal<keyof TaskV4["workflow"], PhaseV4> = true;
  const approvalPhases: Equal<ApprovalPhase, "plan" | "review"> = true;
  void [noUnknownV4, noUnknownHistory, noUnknownDecision, keysV4, sharedSame, executeSame, historyShared, workflowKeys, approvalPhases];

  // 必須の項目が欠けていたら型エラー
  const { id: _id, ...withoutId } = full;
  const { status: _status, ...withoutStatus } = full;
  const { type: _type, ...withoutType } = full;
  const { workflow: _workflow, ...withoutWorkflow } = full;
  // @ts-expect-error id が無い
  const missingId: TaskV4 = withoutId;
  // @ts-expect-error status が無い
  const missingStatus: TaskV4 = withoutStatus;
  // @ts-expect-error 種別 type が無い
  const missingType: TaskV4 = withoutType;
  // @ts-expect-error workflow が無い
  const missingWorkflow: TaskV4 = withoutWorkflow;
  // @ts-expect-error plan の記録には approval が要る
  const missingApproval: TaskV4 = { ...full, workflow: { ...full.workflow, plan: full.workflow.execute } };
  void [missingId, missingStatus, missingType, missingWorkflow, missingApproval];

  // 既知の項目の型が違えば型エラー
  // @ts-expect-error status は open / pending / closed (v3 に無い pending を持つ。done は無い)
  const badStatus: TaskV4 = { ...full, status: "done" };
  // @ts-expect-error v4 の工程に acceptance は無い
  const badPhase: TaskV4 = { ...full, phase: "acceptance" };
  // @ts-expect-error workflowVersion は 4
  const badVersion: TaskV4 = { ...full, workflowVersion: 3 };
  // @ts-expect-error closureReason は approved / legacy_done (v3 の accepted は無い)
  const badClosure: TaskV4 = { ...full, closureReason: "accepted" };
  // @ts-expect-error 工程の結果に approved は無い (人の判断は判断記録)
  const badOutcome: TaskV4 = { ...full, workflow: { ...full.workflow, plan: { ...full.workflow.plan, outcome: "approved" } } };
  // @ts-expect-error workflow に acceptance は無い
  const badWorkflow: TaskV4 = { ...full, workflow: { ...full.workflow, acceptance: full.workflow.execute } };
  // @ts-expect-error approvers は plan / review だけ
  const badApprovers: TaskV4 = { ...full, approvers: { execute: "human/saiki" } };
  void [badStatus, badPhase, badVersion, badClosure, badOutcome, badWorkflow, badApprovers];

  // 判断記録
  const pending: TaskV4 = {
    ...full,
    status: "pending",
    blockedBy: ["approval/plan-1"],
    workflow: { ...full.workflow, plan: { ...full.workflow.plan, status: "done", assignee: "agent/codex", completedBy: "agent/codex", completedAt: "2026-10-01", outcome: "completed", artifactRefs: [{ path: "01-plan.md" }], approval: "plan-1" } },
    history: [...full.history, { seq: 2, at: "2026-10-01T03:00:00Z", actor: "agent/codex", event: "complete", phase: "plan", attempt: 1, inputRevision: 1, outcome: "completed", from: "progress", to: "done", reason: null, refersTo: null, refs: [{ path: "01-plan.md" }] }],
  };
  const decision = initialDecision({ task: pending, phase: "plan", actor: "agent/codex", at: "2026-10-01T03:00:00Z" });
  const decisionStatus: "open" | "approved" | "rejected" | "superseded" = decision.status;
  const decisionPhase: ApprovalPhase = decision.phase;
  const submittedBy: string = decision.submission.completedBy;
  const decidedBy: string | null = decision.decidedBy;
  const origin: "submit" | "import" = decision.origin;
  void [decisionStatus, decisionPhase, submittedBy, decidedBy, origin];
  const { submissionSeq: _seq, ...withoutSubmission } = decision;
  // @ts-expect-error submissionSeq が無い
  const missingSubmission: DecisionRecord = withoutSubmission;
  // @ts-expect-error kind は approval
  const badKind: DecisionRecord = { ...decision, kind: "review" };
  // @ts-expect-error 判断記録の工程は plan / review
  const badDecisionPhase: DecisionRecord = { ...decision, phase: "execute" };
  // @ts-expect-error 判断記録の履歴の出来事に complete は無い
  const badDecisionHistory: DecisionRecord = { ...decision, history: [{ ...decision.history[0], event: "complete" }] };
  void [missingSubmission, badKind, badDecisionPhase, badDecisionHistory];

  // v3 の公開型は弱めていない
  const v3 = initialTaskV3({ id: "T-002", type: "research", date: "2026-10-01", requestedBy: "human/saiki", createdBy: "agent/codex" });
  const v3Status: "open" | "closed" = v3.status;
  // @ts-expect-error v3 に pending (人の確認待ち) は無い
  const v3Pending: TaskV3 = { ...v3, status: "pending" };
  // @ts-expect-error v3 の工程の記録に approval は無い
  const v3Approval: TaskV3 = { ...v3, workflow: { ...v3.workflow, plan: { ...v3.workflow.plan, approval: null } } };
  void [v3Status, v3Pending, v3Approval];
}

function runTsc(files: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [tsc, ...options, ...files], { cwd: root, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test("TaskV4・DecisionRecord の型の契約 (このファイルの contracts) が tsc を通る: 欠落・誤った型を示す @ts-expect-error がすべて型エラーになっている", (t) => {
  if (!existsSync(tsc)) return t.skip("typescript が導入されていない (pnpm install で導入する)");
  const result = runTsc([fileURLToPath(import.meta.url)]);
  assert.equal(result.status, 0, result.output);
});

test("指示なしで書いた欠落・誤った型は型エラーになり、正しい使い方と未知の拡張項目は通る (v4)", (t) => {
  if (!existsSync(tsc)) return t.skip("typescript が導入されていない (pnpm install で導入する)");
  const dir = mkdtempSync(join(tmpdir(), "raprid-task-v4-types-"));
  try {
    const head = `import { initialTaskV4, type TaskV4 } from ${JSON.stringify(workflowPath)};
import { type DecisionRecord } from ${JSON.stringify(decisionPath)};
const full = initialTaskV4({ id: "T-001", type: "implementation", date: "2026-10-01", requestedBy: "human/saiki", createdBy: "agent/codex" });
`;
    const ok = join(dir, "ok.mts");
    writeFileSync(ok, `${head}const status: "open" | "pending" | "closed" = full.status;
const approval: string | null = full.workflow.plan.approval;
const extended: TaskV4 = { ...full, test: [], approvers: { review: null } };
export { status, approval, extended };
`);
    const good = runTsc([ok]);
    assert.equal(good.status, 0, good.output);
    const samples: [string, string, RegExp][] = [
      ["必須の項目が欠けている", `const task: TaskV4 = { workflowVersion: 4, type: "research", phase: "plan", workflow: full.workflow, history: [] };`, /TS2740|TS2739|TS2741/],
      ["status に done", `const task: TaskV4 = { ...full, status: "done" };`, /TS2322/],
      ["工程に acceptance", `const task: TaskV4 = { ...full, phase: "acceptance" };`, /TS2322/],
      ["plan に approval が無い", `const task: TaskV4 = { ...full, workflow: { ...full.workflow, plan: full.workflow.execute } };`, /TS2322|TS2741/],
      ["判断記録の kind が違う", `const task: TaskV4 = full;\nconst record = { id: "plan-1", kind: "review" } as const;\nconst decision: Pick<DecisionRecord, "id" | "kind"> = record;\nexport { decision };`, /TS2322/],
    ];
    for (const [label, line, code] of samples) {
      const file = join(dir, `bad-${samples.findIndex((sample) => sample[0] === label)}.mts`);
      writeFileSync(file, `${head}${line}\nexport { task };\n`);
      const result = runTsc([file]);
      assert.notEqual(result.status, 0, `${label}: 型エラーにならない`);
      assert.match(result.output, code, `${label}\n${result.output}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
