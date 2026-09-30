// workflowVersion 4 (AI 工程 plan / execute / review と人の判断記録) のデータ形式の契約。T-020
// 契約は jobs/project_template/tasks/workflow-v4-contract/03-contract.md の 1〜4・7 と 04-migration-compat.md。
// v2 の契約は workflow.test.ts、v3 は workflow-v3.test.ts のまま保持し、ここでは v4 の追加分と、v2・v3 の結果が変わらないことを確かめる。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type DecisionRecord,
  approvalQueueLinkPath,
  approvalQueueLinkTarget,
  approvalWorkLinkPath,
  checkTaskDecisions,
  decisionEvents,
  decisionKeys,
  decisionOrigins,
  decisionOutcomes,
  decisionStatuses,
  expectedQueueLinks,
  expectedWorkLinkV4,
  initialDecision,
  parseApprovalQueueLinkName,
  parseDecisionId,
  readDecisionFile,
  validateDecision,
} from "../lib/decision.ts";
import { schemaVersion } from "../lib/query.ts";
import { workLinkTarget } from "../lib/workindex.ts";
import {
  type TaskV4,
  approvalPhases,
  closureReasonsV4,
  detectFormat,
  historyEventsV4,
  importedHistoryEvents,
  importedOutcomes,
  importedPhases,
  initialTaskV4,
  outcomesV4,
  phasesV4,
  readTaskFile,
  taskStatusesV4,
  taskTypes,
  validateTaskV2,
  validateTaskV3,
  validateTaskV4,
  waitingOfV4,
} from "../lib/workflow.ts";
import { YamlFrontmatter } from "../lib/yamlfront.ts";
import { cli } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures", "workflow-v4");
const v3fixtures = join(here, "fixtures", "workflow");
const taskSchemaPath = join(here, "..", "lib", "schema", "task-workflow-v4.schema.json");
const decisionSchemaPath = join(here, "..", "lib", "schema", "decision-approval-v1.schema.json");
const scenes = readdirSync(fixtures, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

interface Scene {
  name: string;
  task: string;
  decisions: { id: string; text: string }[];
}
function scene(name: string): Scene {
  const dir = join(fixtures, name);
  const decisionsDir = join(dir, "decisions");
  const decisions = existsSync(decisionsDir) ? readdirSync(decisionsDir).filter((file) => file.endsWith(".md")).sort().map((file) => ({ id: file.slice(0, -3), text: readFileSync(join(decisionsDir, file), "utf8") })) : [];
  return { name, task: readFileSync(join(dir, "index.md"), "utf8"), decisions };
}
type Edit = { set?: [(string | number)[], unknown][]; delete?: (string | number)[][] };
function mutate(text: string, edit: Edit | undefined, source: string): string {
  const frontmatter = YamlFrontmatter.parse(text, source);
  for (const [path, value] of edit?.set ?? []) frontmatter.set(path, value);
  for (const path of edit?.delete ?? []) frontmatter.delete(path);
  return frontmatter.toString();
}
const data = (text: string) => YamlFrontmatter.parse(text).data();
const codesOf = (issues: { code: string; path: string }[]) => issues.map((issue) => `${issue.code} ${issue.path}`);

// ajv は開発時の依存 (workflow.test.ts と同じ扱い)。導入されているのに schema をコンパイルできなければ失敗にする
type Ajv = new (options: object) => { compile: (schema: object) => (data: unknown) => boolean };
async function schemaValidator(path: string): Promise<((data: unknown) => boolean) | undefined> {
  let Ajv2020: Ajv;
  try {
    ({ default: Ajv2020 } = (await import("ajv/dist/2020.js")) as unknown as { default: Ajv });
  } catch {
    return undefined;
  }
  return new Ajv2020({ allErrors: true, strict: true, strictRequired: false }).compile(JSON.parse(readFileSync(path, "utf8")));
}

test("v4 を v2・v3・旧形式・未対応の版と見分け、版ごとの検証器で検証する (P-14-1)", () => {
  assert.deepEqual(detectFormat({ workflowVersion: 4 }), { kind: "v4" });
  assert.deepEqual(detectFormat({ workflowVersion: 3 }), { kind: "v3" });
  assert.deepEqual(detectFormat({ workflowVersion: 2 }), { kind: "v2" });
  assert.deepEqual(detectFormat({ workflowVersion: "4" }), { kind: "unsupported", version: "4" });
  assert.deepEqual(detectFormat({ workflowVersion: 5 }), { kind: "unsupported", version: 5 });
  assert.deepEqual(detectFormat({ status: "todo" }), { kind: "legacy" });
  // v4 の文書を v2・v3 の検証器に、v3 の文書を v4 の検証器に渡しても、読み替えずに版の違いとして報告する
  for (const name of scenes) {
    const task = data(scene(name).task);
    assert.deepEqual(codesOf(validateTaskV3(task)), ["WF_VERSION workflowVersion"], name);
    assert.deepEqual(codesOf(validateTaskV2(task)), ["WF_VERSION workflowVersion"], name);
  }
  for (const name of readdirSync(v3fixtures).filter((file) => /^v[23]-.*\.md$/.test(file))) {
    assert.deepEqual(codesOf(validateTaskV4(data(readFileSync(join(v3fixtures, name), "utf8")))), ["WF_VERSION workflowVersion"], name);
  }
  assert.equal(readTaskFile(readFileSync(join(v3fixtures, "legacy.md"), "utf8")).format.kind, "legacy");
  // タスクの形式の版 (workflowVersion) と、一覧・詳細の JSON の版 (schemaVersion) は別のもの。schemaVersion 3 の配線は T-022
  assert.equal(schemaVersion, 1);
});

test("v4 の正しいフィクスチャは両方の種別・三つの状態を覆い、検証器・判断記録の照合・JSON Schema のすべてを通る (P-14-2)", async () => {
  const validateTask = await schemaValidator(taskSchemaPath);
  const validateDecisionSchema = await schemaValidator(decisionSchemaPath);
  assert.ok(scenes.length >= 18, `場面: ${scenes.length}`);
  const types = new Set<string>();
  const statuses = new Set<string>();
  const decisionStates = new Set<string>();
  let migrated = 0;
  for (const name of scenes) {
    const current = scene(name);
    const read = readTaskFile(current.task, name);
    assert.equal(read.format.kind, "v4", name);
    assert.deepEqual(read.issues, [], `${name}\n${JSON.stringify(read.issues, null, 2)}`);
    const task = read.frontmatter.data() as unknown as TaskV4;
    types.add(task.type);
    statuses.add(task.status);
    if (task.history.some((entry) => entry.event === "migrate" || entry.event === "legacy_import")) migrated++;
    assert.deepEqual(Object.keys(task.workflow), [...phasesV4], `${name}: 工程は plan / execute / review`);
    assert.ok(!("approval" in task.workflow.execute), `${name}: execute に approval は無い`);
    if (validateTask) assert.equal(validateTask(task), true, `${name}: JSON Schema (task)`);
    const decisions = current.decisions.map((file) => {
      const decision = readDecisionFile(file.text, `${name}/decisions/${file.id}.md`);
      assert.deepEqual(decision.issues, [], `${name}/${file.id}\n${JSON.stringify(decision.issues, null, 2)}`);
      const value = decision.frontmatter.data() as unknown as DecisionRecord;
      decisionStates.add(`${value.origin}:${value.status}`);
      if (validateDecisionSchema) assert.equal(validateDecisionSchema(value), true, `${name}/${file.id}: JSON Schema (decision)`);
      return { id: file.id, data: value };
    });
    assert.deepEqual(checkTaskDecisions(task, decisions), [], `${name}: 照合`);
    // タスクが指す判断記録は open で、pending のタスクにだけある
    if (task.status === "pending") assert.ok(decisions.some((d) => d.data.status === "open" && `${d.data.phase}-${d.data.attempt}` === task.workflow[task.phase as "plan" | "review"].approval), `${name}: 確認待ちの記録`);
  }
  assert.deepEqual([...types].sort(), [...taskTypes].sort(), "両方の種別のフィクスチャがある");
  assert.deepEqual([...statuses].sort(), [...taskStatusesV4].sort(), "open / pending / closed のフィクスチャがある");
  for (const state of ["submit:open", "submit:approved", "submit:rejected", "submit:superseded", "import:open", "import:approved"]) assert.ok(decisionStates.has(state), `判断記録 ${state} のフィクスチャがある`);
  assert.ok(migrated >= 4, "移行したタスク (legacy_done・v3 の closed・受入確認の途中・execute ready) のフィクスチャがある");
});

test("人の確認待ちと外部の待ちを別の値で示し、作業索引と確認待ちの索引の場所が分かれる (P-14-3)", () => {
  const jobDir = "/repo/jobs/PROJ";
  const pending = data(scene("implementation-plan-pending").task) as unknown as TaskV4;
  const external = data(scene("research-execute-pending-qa").task) as unknown as TaskV4;
  const ready = data(scene("implementation-execute-ready").task) as unknown as TaskV4;
  const closed = data(scene("research-closed-approved").task) as unknown as TaskV4;
  const reviewPending = data(scene("research-review-pending").task) as unknown as TaskV4;
  assert.deepEqual(waitingOfV4(pending), { kind: "approval", phase: "plan", approval: "plan-1" });
  assert.deepEqual(waitingOfV4(reviewPending), { kind: "approval", phase: "review", approval: "review-1" });
  assert.deepEqual(waitingOfV4(external), { kind: "external", phase: "execute", blockedBy: ["qa/Q-001"] });
  assert.equal(waitingOfV4(ready), null);
  assert.equal(waitingOfV4(closed), null);
  // 作業索引: open は status/<工程>/<工程の状態>/、pending は status/approval/<工程>/、closed は無し。リンク先は同じ深さ
  assert.equal(expectedWorkLinkV4(jobDir, "a-task", pending), `${jobDir}/status/approval/plan/a-task`);
  assert.equal(expectedWorkLinkV4(jobDir, "a-task", reviewPending), `${jobDir}/status/approval/review/a-task`);
  assert.equal(expectedWorkLinkV4(jobDir, "a-task", external), `${jobDir}/status/execute/pending/a-task`);
  assert.equal(expectedWorkLinkV4(jobDir, "a-task", ready), `${jobDir}/status/execute/ready/a-task`);
  assert.equal(expectedWorkLinkV4(jobDir, "a-task", closed), null);
  assert.equal(approvalWorkLinkPath(jobDir, "plan", "a-task"), `${jobDir}/status/approval/plan/a-task`);
  assert.equal(workLinkTarget("a-task"), "../../../tasks/a-task");
  // 確認待ちの索引: open の記録ごとに approvals/open/<タスク名>--<工程>-<試行> → ../../tasks/<タスク名>/decisions/<工程>-<試行>.md。閉じた記録は 0 件
  const openDecisions = scene("research-review-pending").decisions.map((file) => data(file.text) as unknown as DecisionRecord);
  assert.deepEqual(openDecisions.map((decision) => `${decision.id}:${decision.status}`), ["plan-1:approved", "review-1:open"]);
  assert.deepEqual(expectedQueueLinks(jobDir, "a-task", openDecisions), [`${jobDir}/approvals/open/a-task--review-1`]);
  assert.deepEqual(expectedQueueLinks(jobDir, "a-task", scene("research-closed-approved").decisions.map((file) => data(file.text) as unknown as DecisionRecord)), []);
  assert.equal(approvalQueueLinkPath(jobDir, "a-task", "review-1"), `${jobDir}/approvals/open/a-task--review-1`);
  assert.equal(approvalQueueLinkTarget("a-task", "review-1"), "../../tasks/a-task/decisions/review-1.md");
  assert.deepEqual(parseApprovalQueueLinkName("my-long-task-name--plan-12"), { name: "my-long-task-name", id: "plan-12" });
  for (const bad of ["a-task", "a-task--", "--plan-1", "a-task--acceptance-1", "a-task--plan-0", "A-task--plan-1"]) assert.equal(parseApprovalQueueLinkName(bad), null, bad);
  assert.deepEqual(parseDecisionId("review-3"), { phase: "review", attempt: 3 });
  for (const bad of ["execute-1", "plan-0", "plan-01", "plan", "plan-1.md"]) assert.equal(parseDecisionId(bad), null, bad);
});

test("v4 の不正な例は code と項目を示して拒否し、構造の規則は JSON Schema とも一致する (P-14-4)", async () => {
  const validate = await schemaValidator(taskSchemaPath);
  const cases = (JSON.parse(readFileSync(join(fixtures, "invalid-v4.json"), "utf8")) as { cases: ({ name: string; base: string; schema: boolean; codes: [string, string][] } & Edit)[] }).cases;
  assert.ok(cases.length >= 50, `不正な例: ${cases.length}`);
  const seen = new Set<string>();
  for (const item of cases) {
    const text = mutate(scene(item.base).task, item, item.name);
    const read = readTaskFile(text, item.name);
    const found = codesOf(read.issues);
    assert.ok(read.issues.length > 0, `${item.name}: 拒否されない`);
    for (const [code, path] of item.codes) {
      assert.ok(found.includes(`${code} ${path}`), `${item.name}: ${code} ${path} が無い\n${found.join("\n")}`);
      seen.add(code);
    }
    assert.ok(read.issues.every((issue) => issue.message.length > 0));
    if (validate && read.format.kind === "v4") {
      assert.equal(validate(read.frontmatter.data()), item.schema, `${item.name}: JSON Schema だけで${item.schema ? "受け付ける (項目をまたぐ規則)" : "拒否する (構造の規則)"}`);
    }
  }
  for (const code of ["WF_APPROVAL", "WF_BLOCKED", "WF_PHASE_REMOVED", "WF_HUMAN", "WF_SEPARATION", "WF_LEGACY", "WF_REASON", "WF_CLOSED", "WF_HISTORY_EVENT", "WF_HISTORY_REF"]) assert.ok(seen.has(code), `${code} の例がある`);
});

test("判断記録の不正な例と、タスクとの照合の不正な例 (古い版・提出の不一致・孤立・閉じた記録) を拒否する (P-14-5)", async () => {
  const validate = await schemaValidator(decisionSchemaPath);
  interface DecisionCase {
    name: string;
    base: string;
    decision?: { id: string } & Edit;
    task?: Edit;
    extra?: ({ id: string; from: string } & Edit)[];
    remove?: string[];
    schema?: boolean;
    codes: [string, string][];
  }
  const cases = (JSON.parse(readFileSync(join(fixtures, "invalid-decision.json"), "utf8")) as { cases: DecisionCase[] }).cases;
  assert.ok(cases.length >= 40, `不正な例: ${cases.length}`);
  const seen = new Set<string>();
  for (const item of cases) {
    const base = scene(item.base);
    const taskText = mutate(base.task, item.task, `${item.name}: index.md`);
    const read = readTaskFile(taskText, item.name);
    assert.equal(read.format.kind, "v4");
    const files = base.decisions
      .filter((file) => !(item.remove ?? []).includes(file.id))
      .map((file) => ({ id: file.id, text: item.decision?.id === file.id ? mutate(file.text, item.decision, `${item.name}: ${file.id}`) : file.text }));
    for (const extra of item.extra ?? []) {
      const [from, id] = extra.from.split("/");
      const source = scene(from).decisions.find((file) => file.id === id)!;
      files.push({ id: extra.id, text: mutate(source.text, extra, `${item.name}: ${extra.id}`) });
    }
    const issues = [...read.issues];
    const decisions = files.map((file) => {
      const decision = readDecisionFile(file.text, file.id);
      if (item.decision?.id === file.id) {
        issues.push(...decision.issues);
        if (validate && item.schema !== undefined) assert.equal(validate(decision.frontmatter.data()), item.schema, `${item.name}: JSON Schema だけで${item.schema ? "受け付ける" : "拒否する"}`);
      }
      return { id: file.id, data: decision.frontmatter.data() };
    });
    if (read.issues.length === 0) issues.push(...checkTaskDecisions(read.frontmatter.data() as unknown as TaskV4, decisions));
    const found = codesOf(issues);
    assert.ok(issues.length > 0, `${item.name}: 拒否されない`);
    for (const [code, path] of item.codes) {
      assert.ok(found.includes(`${code} ${path}`), `${item.name}: ${code} ${path} が無い\n${found.join("\n")}`);
      seen.add(code);
    }
  }
  for (const code of ["WF_DECISION", "WF_APPROVAL_STALE", "WF_APPROVAL_ORPHAN", "WF_APPROVAL_CLOSED", "WF_APPROVAL", "WF_HUMAN", "WF_NOT_APPROVER"]) assert.ok(seen.has(code), `${code} の例がある`);
  // 読めない記録・ID でないファイル名・同じ ID の重複は照合で報告する
  const task = data(scene("implementation-plan-pending").task) as unknown as TaskV4;
  const good = data(scene("implementation-plan-pending").decisions[0].text);
  assert.deepEqual(codesOf(checkTaskDecisions(task, [{ id: "plan-1", data: undefined }])), ["WF_DECISION decisions/plan-1.md"]);
  assert.deepEqual(codesOf(checkTaskDecisions(task, [{ id: "plan-1", data: good }, { id: "notes", data: good }])), ["WF_DECISION decisions/notes.md"]);
  assert.deepEqual(codesOf(checkTaskDecisions(task, [{ id: "plan-1", data: good }, { id: "plan-1", data: good }])), ["WF_DECISION decisions/plan-1.md"]);
});

test("判断者の変更後は新しい担当本人だけが承認・見送りできる (R20-1 / P-14-5)", () => {
  for (const [name, id, event] of [
    ["research-closed-approved", "review-1", "approve"],
    ["implementation-plan-rejected", "plan-1", "reject"],
  ] as const) {
    const current = scene(name);
    const task = structuredClone(data(current.task)) as TaskV4;
    const record = structuredClone(data(current.decisions.find((file) => file.id === id)!.text)) as DecisionRecord;
    const closing = record.history.at(-1)!;
    const previous = record.history.at(-2)!;
    assert.equal(previous.event, "claim", name);
    record.history.splice(record.history.length - 1, 0, {
      seq: closing.seq, at: new Date(Date.parse(previous.at) + 30 * 60 * 1000).toISOString(), actor: "human/saiki", event: "assign",
      from: "human/saiki", to: "human/other", reason: "代理を依頼",
    });
    closing.seq++;
    closing.actor = "human/other";
    record.assignee = "human/other";
    record.decidedBy = "human/other";
    const taskClosing = task.history.find((entry) => entry.seq === record.decisionSeq)!;
    assert.equal(taskClosing.event, event, name);
    taskClosing.actor = "human/other";
    assert.deepEqual(validateDecision(record), [], `${name}: 新しい担当による判断`);
    assert.deepEqual(checkTaskDecisions(task, current.decisions.map((file) => ({ id: file.id, data: file.id === id ? record : data(file.text) }))), [], `${name}: タスクとの照合`);
    closing.actor = "human/saiki";
    record.decidedBy = "human/saiki";
    taskClosing.actor = "human/saiki";
    assert.ok(codesOf(validateDecision(record)).includes(`WF_NOT_APPROVER history[${record.history.length - 1}].actor`), `${name}: 前の担当による判断を拒否`);
    assert.ok(codesOf(checkTaskDecisions(task, current.decisions.map((file) => ({ id: file.id, data: file.id === id ? record : data(file.text) })))).includes(`WF_NOT_APPROVER decisions/${id}.md: history[${record.history.length - 1}].actor`), `${name}: タスクとの照合でも拒否`);
  }
});

test("承認済みで import した記録は追記を拒否し、open で import した記録は担当変更後に承認・見送りできる (R20-2 / P-14-5)", () => {
  const closed = scene("implementation-migrated-closed-accepted");
  const closedTask = data(closed.task) as unknown as TaskV4;
  const importedApproval = data(closed.decisions[0].text) as unknown as DecisionRecord;
  assert.deepEqual(validateDecision(importedApproval), [], "移行元で承認済みの記録");
  assert.deepEqual(checkTaskDecisions(closedTask, [{ id: "review-1", data: importedApproval }]), [], "移行元の承認履歴との照合");
  for (const event of ["assign", "claim"] as const) {
    const changed = structuredClone(importedApproval);
    if (event === "claim") changed.history[0].to = null;
    changed.history.push({
      seq: 2, at: "2026-10-07T01:00:00Z", actor: event === "claim" ? "human/other" : "human/saiki", event,
      from: event === "claim" ? null : "human/saiki", to: "human/other", reason: event === "assign" ? "承認済み記録の担当変更" : null,
    });
    changed.assignee = "human/other";
    assert.ok(codesOf(validateDecision(changed)).includes("WF_HISTORY_ORDER history"), `${event}: 単体検証で閉鎖後の追記を拒否`);
    assert.ok(codesOf(checkTaskDecisions(closedTask, [{ id: "review-1", data: changed }])).includes("WF_HISTORY_ORDER decisions/review-1.md: history"), `${event}: タスクとの照合でも拒否`);
  }

  // open のまま import した記録に、判断後の項目だけを後付けしても approve の履歴は省けない。
  const openedWithoutDecisionHistory = structuredClone(data(scene("research-migrated-acceptance-progress").decisions[0].text)) as DecisionRecord;
  openedWithoutDecisionHistory.status = "approved";
  openedWithoutDecisionHistory.decidedBy = "human/saiki";
  openedWithoutDecisionHistory.decidedAt = "2026-10-07T02:00:00Z";
  openedWithoutDecisionHistory.decisionSeq = 7;
  openedWithoutDecisionHistory.outcome = "approved";
  assert.ok(codesOf(validateDecision(openedWithoutDecisionHistory)).includes("WF_DECISION status"), "import 後の承認には approve の履歴が必要");

  // 同じ origin: import でも、移行時点で open ならその後の判断を認める。
  for (const event of ["approve", "reject"] as const) {
    const opened = scene("research-migrated-acceptance-progress");
    const task = structuredClone(data(opened.task)) as TaskV4;
    const record = structuredClone(data(opened.decisions[0].text)) as DecisionRecord;
    record.history.push({ seq: 2, at: "2026-10-07T01:00:00Z", actor: "human/saiki", event: "assign", from: "human/saiki", to: "human/other", reason: "判断者の変更" });
    record.history.push({ seq: 3, at: "2026-10-07T02:00:00Z", actor: "human/other", event, from: "open", to: event === "approve" ? "approved" : "review", reason: event === "reject" ? "再確認が必要" : null });
    record.status = event === "approve" ? "approved" : "rejected";
    record.assignee = "human/other";
    record.decidedBy = "human/other";
    record.decidedAt = "2026-10-07T02:00:00Z";
    record.decisionSeq = 7;
    record.outcome = event === "approve" ? "approved" : "rejected";
    record.returnTo = event === "reject" ? "review" : null;
    record.reason = event === "reject" ? "再確認が必要" : null;
    task.history.push({ ...task.history.at(-1)!, seq: 7, at: record.decidedAt, actor: "human/other", event, phase: "review", attempt: 1, inputRevision: 1, outcome: null, from: "pending", to: event === "approve" ? "closed" : "review", reason: record.reason, refersTo: null, refs: [{ path: "decisions/review-1.md" }] });
    task.updatedAt = "2026-10-07";
    task.blockedBy = [];
    if (event === "approve") {
      task.status = "closed";
      task.phase = null;
      task.completedAt = "2026-10-07";
      task.closureReason = "approved";
    } else {
      task.status = "open";
      task.workflow.review.status = "ready";
      task.workflow.review.attempt = 2;
      task.workflow.review.completedBy = null;
      task.workflow.review.completedAt = null;
      task.workflow.review.outcome = null;
      task.workflow.review.artifactRefs = [];
      task.workflow.review.approval = null;
    }
    assert.deepEqual(validateDecision(record), [], `${event}: open で import 後の判断記録`);
    assert.deepEqual(validateTaskV4(task), [], `${event}: 判断後のタスク`);
    assert.deepEqual(checkTaskDecisions(task, [{ id: "review-1", data: record }]), [], `${event}: 移行元の提出との照合`);
  }
});

test("移行と同時刻でも移行後の判断を受理し、approve 履歴の欠落はタスクとの照合で拒否する (R20-3 / P-14-5)", () => {
  const at = "2026-10-06T01:00:00Z";
  const afterImport = (event: "approve" | "reject", assign: boolean) => {
    const opened = scene("research-migrated-acceptance-progress");
    const task = structuredClone(data(opened.task)) as TaskV4;
    const record = structuredClone(data(opened.decisions[0].text)) as DecisionRecord;
    const actor = assign ? "human/other" : "human/saiki";
    if (assign) record.history.push({ seq: 2, at, actor: "human/saiki", event: "assign", from: "human/saiki", to: actor, reason: "同時刻の担当変更" });
    record.history.push({ seq: record.history.length + 1, at, actor, event, from: "open", to: event === "approve" ? "approved" : "review", reason: event === "reject" ? "再確認が必要" : null });
    record.status = event === "approve" ? "approved" : "rejected";
    record.assignee = actor;
    record.decidedBy = actor;
    record.decidedAt = at;
    record.decisionSeq = 7;
    record.outcome = event === "approve" ? "approved" : "rejected";
    record.returnTo = event === "reject" ? "review" : null;
    record.reason = event === "reject" ? "再確認が必要" : null;
    task.history.push({ ...task.history.at(-1)!, seq: 7, at, actor, event, phase: "review", attempt: 1, inputRevision: 1, outcome: null, from: "pending", to: event === "approve" ? "closed" : "review", reason: record.reason, refersTo: null, refs: [{ path: "decisions/review-1.md" }] });
    task.blockedBy = [];
    if (event === "approve") {
      task.status = "closed";
      task.phase = null;
      task.completedAt = "2026-10-06";
      task.closureReason = "approved";
    } else {
      task.status = "open";
      task.workflow.review.status = "ready";
      task.workflow.review.attempt = 2;
      task.workflow.review.completedBy = null;
      task.workflow.review.completedAt = null;
      task.workflow.review.outcome = null;
      task.workflow.review.artifactRefs = [];
      task.workflow.review.approval = null;
    }
    return { task, record };
  };

  for (const event of ["approve", "reject"] as const) {
    const { task, record } = afterImport(event, true);
    assert.deepEqual(record.history.map((entry) => entry.seq), [1, 2, 3]);
    assert.deepEqual(validateTaskV4(task), [], `${event}: 同時刻のタスク`);
    assert.deepEqual(validateDecision(record), [], `${event}: 同時刻の判断記録`);
    assert.deepEqual(checkTaskDecisions(task, [{ id: "review-1", data: record }]), [], `${event}: migrate 後の判断`);
  }

  const missing = afterImport("approve", false);
  missing.record.history.pop();
  assert.deepEqual(validateTaskV4(missing.task), [], "履歴欠落のタスク自体は有効");
  assert.ok(codesOf(checkTaskDecisions(missing.task, [{ id: "review-1", data: missing.record }])).includes("WF_DECISION decisions/review-1.md: history"), "単体では区別できない同時刻の履歴欠落をタスク側の seq で拒否");

  const migrated = scene("implementation-migrated-closed-accepted");
  const task = structuredClone(data(migrated.task)) as TaskV4;
  const record = structuredClone(data(migrated.decisions[0].text)) as DecisionRecord;
  const decisionAt = record.decidedAt!;
  task.history.find((entry) => entry.event === "migrate")!.at = decisionAt;
  record.createdAt = decisionAt;
  record.history[0].at = decisionAt;
  assert.deepEqual(validateTaskV4(task), [], "移行元の承認と migrate が同時刻でも有効");
  assert.deepEqual(validateDecision(record), [], "移行元で承認済みの記録");
  assert.deepEqual(checkTaskDecisions(task, [{ id: "review-1", data: record }]), [], "migrate より前の判断の seq を受理");
});

test("新しいタスクの初期値は種別が必須で、計画が ready・後続が waiting、書き出して読み直しても同じ。判断記録の担当 (approvers) は人だけ (P-14-6)", async () => {
  const validate = await schemaValidator(taskSchemaPath);
  for (const type of taskTypes) {
    const task = initialTaskV4({ id: "T-030", type, date: "2026-10-01", at: "2026-10-01T01:02:03.000Z", requestedBy: "human/saiki", createdBy: "agent/claude" });
    assert.deepEqual(validateTaskV4(task), [], type);
    assert.equal(task.workflowVersion, 4);
    assert.deepEqual(Object.fromEntries(Object.entries(task.workflow).map(([phase, record]) => [phase, record.status])), { plan: "ready", execute: "waiting", review: "waiting" });
    assert.deepEqual([task.workflow.plan.approval, task.workflow.review.approval], [null, null]);
    assert.ok(!("approvers" in task) && !("migratedFrom" in task), "任意の項目は指定しなければ書かない");
    const frontmatter = YamlFrontmatter.parse("---\n---\n\n# 概要\n");
    for (const [key, value] of Object.entries(task)) frontmatter.set([key], value);
    const text = frontmatter.toString();
    assert.match(text, new RegExp(`^---\\nid: T-030\\nworkflowVersion: 4\\ntype: ${type}\\nstatus: open\\nphase: plan\\n`));
    assert.match(text, /\n  execute:\n    status: waiting\n/);
    assert.doesNotMatch(text, /acceptance:|implement:/);
    const again = readTaskFile(text);
    assert.equal(again.format.kind, "v4");
    assert.deepEqual(again.issues, []);
    assert.deepEqual(again.frontmatter.data(), JSON.parse(JSON.stringify(task)));
    if (validate) assert.equal(validate(task), true);
  }
  const withApprovers = initialTaskV4({ id: "T-031", type: "research", date: "2026-10-01", at: "2026-10-01T00:00:00Z", requestedBy: "human/saiki", createdBy: "agent/claude", approvers: { plan: "human/saiki", review: null } });
  assert.deepEqual(validateTaskV4(withApprovers), []);
  assert.deepEqual(Object.keys(withApprovers).slice(13, 16), ["relatedTasks", "approvers", "workflow"], "approvers は relatedTasks と workflow の間");
  if (validate) assert.equal(validate(withApprovers), true);
  for (const type of [undefined, "", "search", "implement", "Research"]) {
    assert.throws(() => initialTaskV4({ id: "T-032", type: type as "research", date: "2026-10-01", requestedBy: "human/saiki", createdBy: "agent/claude" }), TypeError, String(type));
  }
  for (const approvers of [{ plan: "agent/codex" }, { execute: "human/saiki" }, { review: "saiki" }]) {
    assert.throws(() => initialTaskV4({ id: "T-033", type: "research", date: "2026-10-01", requestedBy: "human/saiki", createdBy: "agent/claude", approvers: approvers as never }), TypeError, JSON.stringify(approvers));
  }
});

test("提出の直後のタスクから作る判断記録は open で照合に合い、移行元の提出からは import、提出の無い工程からは作れない (P-14-6)", () => {
  const pending = scene("implementation-plan-pending");
  const task = data(pending.task) as unknown as TaskV4;
  const made = initialDecision({ task, phase: "plan", actor: "agent/codex", at: "2026-10-01T03:00:00Z" });
  assert.deepEqual(made, data(pending.decisions[0].text), "フィクスチャの plan-1 と同じ");
  assert.deepEqual(validateDecision(made), []);
  assert.deepEqual(checkTaskDecisions(task, [{ id: made.id, data: made }]), []);
  // approvers の担当を初期の担当にする。明示した担当が優先
  const assigned = data(scene("research-plan-pending-assigned").task) as unknown as TaskV4;
  assert.equal(initialDecision({ task: assigned, phase: "plan", actor: "agent/codex", at: "2026-10-01T03:00:00Z" }).assignee, "human/saiki");
  assert.equal(initialDecision({ task: assigned, phase: "plan", actor: "agent/codex", at: "2026-10-01T03:00:00Z", assignee: null }).assignee, null);
  assert.throws(() => initialDecision({ task: assigned, phase: "plan", actor: "agent/codex", at: "2026-10-01T03:00:00Z", assignee: "agent/claude" }), TypeError);
  // 移行元の提出 (migrate より前の complete) から作ると origin は import、履歴は import
  const migrated = data(scene("implementation-migrated-plan-require").task) as unknown as TaskV4;
  const imported = initialDecision({ task: migrated, phase: "plan", actor: "human/saiki", at: "2026-10-06T01:00:00Z", reason: "v3 の plan の提出 (seq 2) から (planApproval: require)" });
  assert.equal(imported.origin, "import");
  assert.deepEqual(imported.history.map((entry) => entry.event), ["import"]);
  assert.deepEqual(checkTaskDecisions(migrated, [{ id: imported.id, data: imported }]), []);
  // legacy_import の工程 (提出者も成果物も無い) には作れない
  const legacy = data(scene("implementation-closed-legacy").task) as unknown as TaskV4;
  assert.throws(() => initialDecision({ task: legacy, phase: "plan", actor: "human/saiki", at: "2026-10-06T01:00:00Z" }), TypeError);
  assert.throws(() => initialDecision({ task, phase: "review", actor: "agent/codex", at: "2026-10-01T03:00:00Z" }), TypeError, "未提出の review");
});

test("v4 と判断記録の JSON Schema は正しい 2020-12 の schema で、必須項目・工程・列挙が検証器と揃っている (P-14-6)", async (t) => {
  const schema = JSON.parse(readFileSync(taskSchemaPath, "utf8")) as {
    required: string[];
    properties: { workflowVersion: { const: number }; type: { enum: string[] }; status: { enum: string[] }; phase: { enum: (string | null)[] }; closureReason: { enum: (string | null)[] }; workflow: { required: string[] }; approvers: { properties: Record<string, unknown> } };
    $defs: { phase: { required: string[] }; approvalPhase: { required: string[] }; historyEntry: { required: string[]; properties: { event: { enum: string[] }; phase: { enum: (string | null)[] }; outcome: { enum: (string | null)[] } } }; phaseName: { enum: string[] }; outcome: { enum: (string | null)[] } };
  };
  const task = initialTaskV4({ id: "T-001", type: "research", date: "2026-10-01", at: "2026-10-01T00:00:00Z", requestedBy: "human/saiki", createdBy: "agent/claude" });
  assert.deepEqual(schema.required, Object.keys(task), "必須項目と並び順 (approvers・migratedFrom は任意)");
  assert.equal(schema.properties.workflowVersion.const, 4);
  assert.deepEqual(schema.properties.type.enum, [...taskTypes]);
  assert.deepEqual(schema.properties.status.enum, [...taskStatusesV4]);
  assert.deepEqual(schema.properties.phase.enum, [...phasesV4, null]);
  assert.deepEqual(schema.properties.closureReason.enum, [...closureReasonsV4, null]);
  assert.deepEqual(schema.properties.workflow.required, [...phasesV4]);
  assert.deepEqual(Object.keys(schema.properties.approvers.properties), [...approvalPhases]);
  assert.deepEqual(schema.$defs.phaseName.enum, [...phasesV4]);
  assert.deepEqual(schema.$defs.outcome.enum, [...outcomesV4, null]);
  assert.deepEqual([...schema.$defs.phase.required].sort(), Object.keys(task.workflow.execute).sort());
  assert.deepEqual([...schema.$defs.approvalPhase.required].sort(), Object.keys(task.workflow.plan).sort());
  assert.deepEqual([...schema.$defs.historyEntry.required].sort(), Object.keys(task.history[0]).sort());
  assert.deepEqual(schema.$defs.historyEntry.properties.event.enum, [...historyEventsV4, ...importedHistoryEvents]);
  assert.deepEqual(schema.$defs.historyEntry.properties.phase.enum, [...phasesV4, ...importedPhases, null]);
  assert.deepEqual(schema.$defs.historyEntry.properties.outcome.enum, [...outcomesV4, ...importedOutcomes, null]);
  const decisionSchema = JSON.parse(readFileSync(decisionSchemaPath, "utf8")) as { required: string[]; properties: { kind: { const: string }; status: { enum: string[] }; outcome: { enum: (string | null)[] }; origin: { enum: string[] }; history: { items: { required: string[]; properties: { event: { enum: string[] } } } } } };
  assert.deepEqual(decisionSchema.required, [...decisionKeys]);
  assert.equal(decisionSchema.properties.kind.const, "approval");
  assert.deepEqual(decisionSchema.properties.status.enum, [...decisionStatuses]);
  assert.deepEqual(decisionSchema.properties.outcome.enum, [...decisionOutcomes, null]);
  assert.deepEqual(decisionSchema.properties.origin.enum, [...decisionOrigins]);
  assert.deepEqual(decisionSchema.properties.history.items.properties.event.enum, [...decisionEvents]);
  const made = initialDecision({ task: data(scene("implementation-plan-pending").task) as unknown as TaskV4, phase: "plan", actor: "agent/codex", at: "2026-10-01T03:00:00Z" });
  assert.deepEqual(Object.keys(made), [...decisionKeys], "判断記録の項目と並び順");
  assert.deepEqual([...decisionSchema.properties.history.items.required].sort(), Object.keys(made.history[0]).sort());
  if (!(await schemaValidator(taskSchemaPath))) t.skip("ajv が導入されていない (pnpm install で導入する)");
});

test("v4 の読み書きは未知の項目・コメント・本文を保ち、書き換えた行だけを変える (P-14-6)", () => {
  for (const name of scenes) {
    const current = scene(name);
    assert.equal(YamlFrontmatter.parse(current.task, name).toString(), current.task, `${name}: 変更が無ければ元と同じ`);
    for (const file of current.decisions) assert.equal(YamlFrontmatter.parse(file.text, file.id).toString(), file.text, `${name}/${file.id}: 変更が無ければ元と同じ`);
  }
  const text = scene("implementation-plan-pending").decisions[0].text;
  const frontmatter = YamlFrontmatter.parse(text);
  frontmatter.set(["assignee"], "human/saiki");
  const before = text.split("\n");
  const after = frontmatter.toString().split("\n");
  assert.equal(after.length, before.length);
  assert.deepEqual(after.filter((line, index) => line !== before[index]), ["assignee: human/saiki"]);
  assert.match(frontmatter.toString(), /\n# 判断のメモ\n/, "本文は残る");
  // 未知の項目 (test など) は検証を通り、保持される
  const withTest = YamlFrontmatter.parse(scene("implementation-new").task);
  withTest.set(["test"], ["docs/feature/raprid/workflow-v4-data-model.feature"]);
  const read = readTaskFile(withTest.toString());
  assert.deepEqual(read.issues, []);
  assert.deepEqual(read.frontmatter.data().test, ["docs/feature/raprid/workflow-v4-data-model.feature"]);
});

test("v2・v3 の検証結果 (フィクスチャと不正な例) は v4 を足す前の基準と同じ (P-14-7)", () => {
  const baseline = JSON.parse(readFileSync(join(fixtures, "v2v3-baseline.json"), "utf8")) as { fixtures: Record<string, unknown>; cases: Record<string, unknown> };
  const result: { fixtures: Record<string, unknown>; cases: Record<string, unknown> } = { fixtures: {}, cases: {} };
  for (const name of readdirSync(v3fixtures).filter((file) => file.endsWith(".md")).sort()) {
    const read = readTaskFile(readFileSync(join(v3fixtures, name), "utf8"), name);
    result.fixtures[name] = { format: read.format, issues: read.issues };
  }
  for (const file of ["invalid.json", "invalid-v3.json"]) {
    const cases = (JSON.parse(readFileSync(join(v3fixtures, file), "utf8")) as { cases: ({ name: string; base: string } & Edit)[] }).cases;
    for (const item of cases) {
      const read = readTaskFile(mutate(readFileSync(join(v3fixtures, item.base), "utf8"), item, item.base), item.name);
      result.cases[`${file}: ${item.name}`] = { format: read.format, issues: read.issues };
    }
  }
  assert.equal(Object.keys(baseline.fixtures).length, 21);
  assert.equal(Object.keys(baseline.cases).length, 107);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { fixtures: baseline.fixtures, cases: baseline.cases });
});

test("node_modules の無い場所へ複製した scripts/ でも v4 と判断記録を読んで検証できる (P-14-6)", () => {
  const root = mkdtempSync(join(tmpdir(), "raprid-workflow-v4-bare-"));
  try {
    cpSync(dirname(cli), join(root, "scripts"), { recursive: true, filter: (source) => !source.includes("node_modules") });
    const dir = join(fixtures, "implementation-plan-pending");
    const code = `import { readTaskFile } from ${JSON.stringify(join(root, "scripts", "lib", "workflow.ts"))};
import { checkTaskDecisions, readDecisionFile } from ${JSON.stringify(join(root, "scripts", "lib", "decision.ts"))};
import { readFileSync } from "node:fs";
const task = readTaskFile(readFileSync(${JSON.stringify(join(dir, "index.md"))}, "utf8"));
const decision = readDecisionFile(readFileSync(${JSON.stringify(join(dir, "decisions", "plan-1.md"))}, "utf8"));
const cross = checkTaskDecisions(task.frontmatter.data(), [{ id: "plan-1", data: decision.frontmatter.data() }]);
const stale = checkTaskDecisions(task.frontmatter.data(), [{ id: "plan-1", data: { ...decision.frontmatter.data(), requirementRevision: 2 } }]);
console.log(JSON.stringify({ format: task.format.kind, task: task.issues.length, decision: decision.issues.length, cross: cross.length, stale: [...new Set(stale.map((issue) => issue.code))] }));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { format: "v4", task: 0, decision: 0, cross: 0, stale: ["WF_APPROVAL_STALE"] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
