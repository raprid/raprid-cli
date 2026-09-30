// TaskV3 の公開型の契約 (R18-1)。実行時の検証 (validateTaskV3) とは別に、型が T-017 のデータ契約を表しているかを確かめる。
//
// (1) このファイルの contracts() は pnpm typecheck の対象。@ts-expect-error を付けた行が型エラーにならなければ
//     (欠落・誤った型を型が許したら) 「使われていない @ts-expect-error」として型検査が失敗する
// (2) 下の試験は pnpm test からも tsc を実行し、(1) が通ることと、指示なしの欠落・誤った型が実際に型エラーになることを確かめる
//     (typescript は開発時の依存。導入されていなければ飛ばす)

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type HistoryEntry, type HistoryEntryV3, initialTaskV2, initialTaskV3, type PhaseStatus, type PhaseV3, type TaskType, type TaskV2, type TaskV3 } from "../lib/workflow.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const workflowPath = join(root, "scripts", "lib", "workflow.ts");
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
const options = ["--noEmit", "--strict", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--allowImportingTsExtensions", "--verbatimModuleSyntax", "--skipLibCheck", "--types", "node"];

// 型が同じか (片方だけに広い型・unknown が混ざっていたら false)
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
// 明示した項目の名前 (未知の項目のための index signature を除く)
type KnownKeys<T> = keyof { [K in keyof T as string extends K ? never : K]: T[K] };
// 明示した項目のうち型が unknown になっているもの (無ければ never)。任意の項目 (sessionId?) で undefined が混ざらないよう -? を付ける
type UnknownFields<T> = { [K in KnownKeys<T>]-?: unknown extends T[K] ? K : never }[KnownKeys<T>];
// v2 と v3 で意味も型も同じ項目
type Shared = "id" | "status" | "requirementRevision" | "createdAt" | "updatedAt" | "completedAt" | "closureReason" | "requestedBy" | "createdBy" | "blockedBy" | "relatedTasks";

export function contracts(): void {
  const full = initialTaskV3({ id: "T-001", type: "research", date: "2026-09-29", requestedBy: "human/saiki", createdBy: "agent/codex" });

  // 正しい TaskV3 の項目は、キャストなしで具体的な型として使える
  const id: string = full.id;
  const type: TaskType = full.type;
  const status: "open" | "closed" = full.status;
  const phase: PhaseV3 | null = full.phase;
  const revision: number = full.requirementRevision;
  const blockedBy: string[] = full.blockedBy;
  const relatedTasks: string[] = full.relatedTasks;
  const completedAt: string | null = full.completedAt;
  const closureReason: "accepted" | "legacy_done" | null = full.closureReason;
  const requestedBy: string | null = full.requestedBy;
  const executeStatus: PhaseStatus = full.workflow.execute.status;
  const historyPhase: PhaseV3 | null = full.history[0].phase;
  void [id, type, status, phase, revision, blockedBy, relatedTasks, completedAt, closureReason, requestedBy, executeStatus, historyPhase];

  // 未知の拡張項目 (test など) は許す
  const extended: TaskV3 = { ...full, test: ["docs/feature/raprid/workflow-v3-task-types.feature"], custom: { note: 1 } };
  void extended;

  // 明示した項目に unknown が無く、項目の一覧が契約どおり。v2 と共通の項目の型は v2 と同じ
  const noUnknownV3: Equal<UnknownFields<TaskV3>, never> = true;
  const noUnknownV2: Equal<UnknownFields<TaskV2>, never> = true;
  const noUnknownHistory: Equal<UnknownFields<HistoryEntryV3>, never> = true;
  const keysV3: Equal<KnownKeys<TaskV3>, Shared | "workflowVersion" | "type" | "phase" | "workflow" | "history"> = true;
  const sharedSame: Equal<Pick<TaskV2, Shared>, Pick<TaskV3, Shared>> = true;
  const historySame: Equal<Omit<HistoryEntryV3, "phase">, Omit<HistoryEntry, "phase">> = true;
  void [noUnknownV3, noUnknownV2, noUnknownHistory, keysV3, sharedSame, historySame];

  // 必須の項目が欠けていたら型エラー
  const { id: _id, ...withoutId } = full;
  const { status: _status, ...withoutStatus } = full;
  const { requirementRevision: _revision, ...withoutRevision } = full;
  const { blockedBy: _blockedBy, ...withoutBlockedBy } = full;
  const { type: _type, ...withoutType } = full;
  const { history: _history, ...withoutHistory } = full;
  // @ts-expect-error id が無い
  const missingId: TaskV3 = withoutId;
  // @ts-expect-error status が無い
  const missingStatus: TaskV3 = withoutStatus;
  // @ts-expect-error requirementRevision が無い
  const missingRevision: TaskV3 = withoutRevision;
  // @ts-expect-error blockedBy が無い
  const missingBlockedBy: TaskV3 = withoutBlockedBy;
  // @ts-expect-error 種別 type が無い
  const missingType: TaskV3 = withoutType;
  // @ts-expect-error history が無い
  const missingHistory: TaskV3 = withoutHistory;
  // @ts-expect-error レビューで示された再現例: id・status・requirementRevision などが無い
  const reviewExample: TaskV3 = { workflowVersion: 3, type: "research", phase: "plan", workflow: full.workflow, history: [] };
  void [missingId, missingStatus, missingRevision, missingBlockedBy, missingType, missingHistory, reviewExample];

  // 既知の項目の型が違えば型エラー
  // @ts-expect-error status は open / closed
  const badStatus: TaskV3 = { ...full, status: "done" };
  // @ts-expect-error requirementRevision は数
  const badRevision: TaskV3 = { ...full, requirementRevision: "1" };
  // @ts-expect-error 種別の別名 search は受け付けない
  const badType: TaskV3 = { ...full, type: "search" };
  // @ts-expect-error v3 の工程に implement は無い
  const badPhase: TaskV3 = { ...full, phase: "implement" };
  // @ts-expect-error blockedBy は配列
  const badBlockedBy: TaskV3 = { ...full, blockedBy: "qa/Q-001" };
  // @ts-expect-error workflowVersion は 3
  const badVersion: TaskV3 = { ...full, workflowVersion: 2 };
  // @ts-expect-error workflow は execute を持つ (implement ではない)
  const badWorkflow: TaskV3 = { ...full, workflow: { plan: full.workflow.plan, implement: full.workflow.execute, review: full.workflow.review, acceptance: full.workflow.acceptance } };
  // @ts-expect-error 履歴の工程に implement は無い
  const badHistory: TaskV3 = { ...full, history: [{ ...full.history[0], phase: "implement" }] };
  void [badStatus, badRevision, badType, badPhase, badBlockedBy, badVersion, badWorkflow, badHistory];

  // v2 の公開型は弱めていない
  const v2 = initialTaskV2({ id: "T-002", date: "2026-09-29", requestedBy: "human/saiki", createdBy: "agent/codex" });
  const v2Status: "open" | "closed" = v2.status;
  const v2Revision: number = v2.requirementRevision;
  const { id: _v2id, ...v2WithoutId } = v2;
  // @ts-expect-error v2 でも id が無ければ型エラー
  const v2Missing: TaskV2 = v2WithoutId;
  // @ts-expect-error v2 の工程は implement で、execute は無い
  const v2Phase: TaskV2 = { ...v2, phase: "execute" };
  void [v2Status, v2Revision, v2Missing, v2Phase];
}

function runTsc(files: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [tsc, ...options, ...files], { cwd: root, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test("TaskV3 の型の契約 (このファイルの contracts) が tsc を通る: 欠落・誤った型を示す @ts-expect-error がすべて型エラーになっている", (t) => {
  if (!existsSync(tsc)) return t.skip("typescript が導入されていない (pnpm install で導入する)");
  const result = runTsc([fileURLToPath(import.meta.url)]);
  assert.equal(result.status, 0, result.output);
});

test("指示なしで書いた欠落・誤った型は型エラーになり、正しい使い方と未知の拡張項目は通る", (t) => {
  if (!existsSync(tsc)) return t.skip("typescript が導入されていない (pnpm install で導入する)");
  const dir = mkdtempSync(join(tmpdir(), "raprid-task-v3-types-"));
  try {
    const head = `import { initialTaskV3, type TaskV3 } from ${JSON.stringify(workflowPath)};
const full = initialTaskV3({ id: "T-001", type: "implementation", date: "2026-09-29", requestedBy: "human/saiki", createdBy: "agent/codex" });
`;
    const ok = join(dir, "ok.mts");
    writeFileSync(ok, `${head}const id: string = full.id;
const status: "open" | "closed" = full.status;
const revision: number = full.requirementRevision;
const blockedBy: string[] = full.blockedBy;
const extended: TaskV3 = { ...full, test: [] };
export { id, status, revision, blockedBy, extended };
`);
    const good = runTsc([ok]);
    assert.equal(good.status, 0, good.output);

    const samples: [string, string, RegExp][] = [
      ["必須の項目が欠けている (レビューの再現例)", `const task: TaskV3 = { workflowVersion: 3, type: "research", phase: "plan", workflow: full.workflow, history: [] };`, /TS2740|TS2739|TS2741/],
      ["status の型が違う", `const task: TaskV3 = { ...full, status: "done" };`, /TS2322/],
      ["種別の別名", `const task: TaskV3 = { ...full, type: "search" };`, /TS2322|TS2820/],
      ["v3 の工程に implement", `const task: TaskV3 = { ...full, phase: "implement" };`, /TS2322/],
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
