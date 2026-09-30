// workflowVersion 4 の CLI・JSON (schemaVersion 3)・承認キューの試験。T-022
// Gherkin: docs/feature/raprid/workflow-v4-cli.feature (章 17、管理リポジトリ)。契約: workflow-v4-contract/03-contract.md
// 一時プロジェクトで CLI (scripts/cli.ts) を別プロセスとして実行する。異常終了は --require の前処理で fs を差し替えて再現する。

import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { raprid, rapridAsync, snapshot } from "./helpers.ts";

const job = "PROJ";
const handoff = (title: string) => `# ${title}\n\n## 対象・成果物\n\n- x\n\n## 実施・検証\n\n- y\n\n## 未確認・制約\n\n- なし\n\n## 次の担当への依頼\n\n- z\n`;

type Json = Record<string, any>;

class Project {
  readonly root = mkdtempSync(join(tmpdir(), "raprid-v4-cli-"));

  constructor() {
    mkdirSync(join(this.root, "jobs"));
    this.ok(["job", "create", job]);
    mkdirSync(join(this.root, "repos", "project_template"), { recursive: true });
  }

  run(args: string[], options: { require?: string; env?: NodeJS.ProcessEnv } = {}) {
    return raprid(this.root, args, options);
  }

  ok(args: string[]): string {
    const result = this.run(args);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
    return result.stdout;
  }

  json(args: string[]): Json {
    const result = this.run([...args, "--json"]);
    return JSON.parse(result.stdout) as Json;
  }

  // 失敗して code・schemaVersion が一致し、プロジェクト全体 (ロックを除く) が変わらないこと
  fails(args: string[], code: string, options: { status?: number; version?: number } = {}): Json {
    const before = this.snapshot();
    const result = this.run([...args, "--json"]);
    const body = JSON.parse(result.stdout) as Json;
    assert.equal(result.status, options.status ?? 1, `${args.join(" ")}\n${result.stdout}`);
    assert.equal(body.error?.code, code, `${args.join(" ")}\n${result.stdout}`);
    assert.equal(body.schemaVersion, options.version ?? 3, `${args.join(" ")}: 失敗の schemaVersion`);
    assert.deepEqual(this.snapshot(), before, `${args.join(" ")}: 失敗したら何も変えない`);
    return body;
  }

  // --json の無いコマンドの失敗: 終了コードとメッセージを確かめ、何も変えないこと
  failsText(args: string[], status: number, message: RegExp): void {
    const before = this.snapshot();
    const result = this.run(args);
    assert.equal(result.status, status, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, message, args.join(" "));
    assert.deepEqual(this.snapshot(), before, `${args.join(" ")}: 失敗したら何も変えない`);
  }

  snapshot() {
    return snapshot(this.root, (rel) => rel === "jobs/.locks");
  }

  dir(name: string): string {
    return join(this.root, "jobs", job, "tasks", name);
  }

  write(name: string, file: string, content: string): void {
    writeFileSync(join(this.dir(name), file), content);
  }

  item(selector: string): Json {
    const body = this.json(["task", "show", job, selector, "--schema-version", "3"]);
    assert.equal(body.schemaVersion, 3, JSON.stringify(body));
    return body.item as Json;
  }

  revision(selector: string): string {
    return this.item(selector).revision as string;
  }

  record(selector: string, id: string): Json {
    const body = this.json(["approval", "show", job, selector, id]);
    assert.equal(body.schemaVersion, 3, JSON.stringify(body));
    return body.item as Json;
  }

  // v4 のタスクを作る
  add(name: string, type: "research" | "implementation", extra: string[] = []): Json {
    const body = this.json(["task", "add", job, name, "--type", type, `${name} のタイトル`, "--workflow-version", "4", ...extra, "--requested-by", "human/saiki", "--created-by", "agent/codex"]);
    assert.equal(body.ok, true, JSON.stringify(body));
    return body;
  }

  // 工程の操作を --if-match つきで行い、schemaVersion 3 の結果を返す
  step(args: string[], selector: string): Json {
    const [command, ...rest] = args;
    const result = this.run(["task", command, job, selector, ...rest, "--if-match", this.revision(selector), "--json"]);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
    const body = JSON.parse(result.stdout) as Json;
    assert.equal(body.schemaVersion, 3);
    assert.equal(body.ok, true);
    return body;
  }

  // 判断記録の操作を --if-match・--record-match つきで行う
  decide(args: string[], selector: string): Json {
    const [command, id, ...rest] = args;
    const record = this.record(selector, id);
    const result = this.run(["approval", command, job, selector, id, ...rest, "--if-match", record.taskRevision, "--record-match", record.recordRevision, "--json"]);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
    const body = JSON.parse(result.stdout) as Json;
    assert.equal(body.schemaVersion, 3);
    assert.equal(body.ok, true);
    return body;
  }

  // 判断記録の操作の引数 (今の revision つき)
  approvalArgs(command: string, selector: string, id: string, rest: string[]): string[] {
    const record = this.record(selector, id);
    return ["approval", command, job, selector, id, ...rest, "--if-match", record.taskRevision, "--record-match", record.recordRevision];
  }

  taskArgs(command: string, selector: string, rest: string[]): string[] {
    return ["task", command, job, selector, ...rest, "--if-match", this.revision(selector)];
  }

  // plan を進めて提出する (plan-<試行> ができる)
  submitPlan(name: string, actor = "agent/codex"): Json {
    this.step(["claim", "--actor", actor], name);
    this.write(name, "01-plan.md", handoff("計画"));
    return this.step(["complete", "--actor", actor, "--handoff", "01-plan.md"], name);
  }

  // 作業索引と確認待ちの索引 (このタスクの分)
  links(name: string): string[] {
    const found: string[] = [];
    const status = join(this.root, "jobs", job, "status");
    for (const phase of readdirSync(status)) {
      const dir = join(status, phase);
      if (!lstatSync(dir).isDirectory()) continue;
      for (const state of readdirSync(dir)) {
        const path = join(dir, state, name);
        if (isLink(path)) found.push(`status/${phase}/${state} -> ${readlinkSync(path)}`);
      }
    }
    const queue = join(this.root, "jobs", job, "approvals", "open");
    if (existsSync(queue)) for (const entry of readdirSync(queue).filter((each) => each.startsWith(`${name}--`))) found.push(`approvals/open/${entry} -> ${readlinkSync(join(queue, entry))}`);
    return found.sort();
  }

  close(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function withProject(fn: (project: Project) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const project = new Project();
    try {
      await fn(project);
    } finally {
      project.close();
    }
  };
}

const target = (name: string) => `../../../tasks/${name}`;

// ---- P-17-1 作成と JSON の二つの軸 ------------------------------------------------------------------------------------

test("P-17-1 task add --workflow-version 4 で両方の種別の v4 のタスクを作り、JSON は AI 工程とタスクの軸を分けて返す", withProject((project) => {
  const research = project.add("research-a", "research");
  assert.deepEqual([research.item.id, research.item.workflowVersion, research.item.type, research.item.status, research.item.phase, research.item.phaseStatus, research.item.waiting, research.item.approval, research.item.approvals], ["T-001", 4, "research", "open", "plan", "ready", null, null, []]);
  assert.deepEqual([research.decisions, research.recovered], [[], []]);
  const impl = project.add("impl-a", "implementation", ["--plan-approver", "human/saiki", "--review-approver", "human/lead"]);
  assert.deepEqual(impl.item.approvers, { plan: "human/saiki", review: "human/lead" });
  assert.deepEqual(project.links("impl-a"), [`status/plan/ready -> ${target("impl-a")}`]);
  assert.match(readFileSync(join(project.dir("impl-a"), "index.md"), "utf8"), /^---\nid: T-002\nworkflowVersion: 4\ntype: implementation\n/);
  // 判断者の初期値は人だけ。v4 の項目を v3 の作成に付けない・--workflow-version は 3 か 4
  project.fails(["task", "add", job, "x", "--type", "research", "t", "--workflow-version", "4", "--plan-approver", "agent/codex", "--requested-by", "human/saiki", "--created-by", "agent/codex"], "USAGE", { status: 2, version: 3 });
  project.fails(["task", "add", job, "x", "--type", "research", "t", "--plan-approver", "human/saiki", "--requested-by", "human/saiki", "--created-by", "agent/codex"], "USAGE", { status: 2, version: 1 });
  project.fails(["task", "add", job, "x", "--type", "research", "t", "--workflow-version", "5", "--requested-by", "human/saiki", "--created-by", "agent/codex"], "USAGE", { status: 2, version: 1 });
  // 版の交渉: capability に query-v3・workflow-v4 を足す
  assert.deepEqual(JSON.parse(project.ok(["--capabilities"])).capabilities.slice(-2), ["query-v3", "workflow-v4"]);
}));

// ---- P-17-2 両方の種別の一連の流れ ----------------------------------------------------------------------------------------

for (const type of ["implementation", "research"] as const) {
  test(`P-17-2 ${type}: plan の提出 → 人の承認 → execute → review の提出 → 人の承認 → closed を CLI で進め、AI 工程の完了だけでは承認にならない`, withProject((project) => {
    project.add("t", type, ["--review-approver", "human/lead"]);
    const submitted = project.submitPlan("t");
    // AI 工程は done、タスクは pending (人の確認待ち)。execute は waiting のまま
    assert.deepEqual([submitted.item.status, submitted.item.phase, submitted.item.phaseStatus, submitted.item.blockedBy], ["pending", "plan", "done", ["approval/plan-1"]]);
    assert.deepEqual(submitted.item.waiting, { kind: "approval", phase: "plan", approval: "plan-1" });
    assert.equal(submitted.item.workflow.execute.status, "waiting");
    assert.deepEqual([submitted.item.approval.id, submitted.item.approval.status, submitted.item.approval.assignee, submitted.item.approval.current, submitted.item.approval.valid], ["plan-1", "open", null, true, true]);
    assert.deepEqual([submitted.decisions.length, submitted.decisions[0].id, submitted.decisions[0].status, submitted.decisions[0].origin, submitted.decisions[0].submission.completedBy], [1, "plan-1", "open", "submit", "agent/codex"]);
    assert.equal(submitted.decisions[0].recordRevision, project.record("t", "plan-1").recordRevision, "返した recordRevision は show と同じ");
    assert.deepEqual(project.links("t"), [`approvals/open/t--plan-1 -> ../../tasks/t/decisions/plan-1.md`, `status/approval/plan -> ${target("t")}`]);
    // 確認待ちの一覧に未割当として出る
    const queue = project.json(["approval", "list", job]);
    assert.deepEqual([queue.schemaVersion, queue.kind, queue.counts], [3, "approval", { total: 1, shown: 1, unassigned: 1, assigned: 0 }]);
    assert.deepEqual([queue.items[0].task, queue.items[0].id, queue.items[0].assignee, queue.items[0].taskRevision], ["T-001", "plan-1", null, project.revision("t")]);
    // 人の確認待ちの間は工程を進められない
    project.fails(project.taskArgs("claim", "t", ["--actor", "agent/codex"]), "WF_STATE");
    project.fails(project.taskArgs("complete", "t", ["--actor", "agent/codex", "--handoff", "01-plan.md"]), "WF_STATE");
    // 人が claim して承認すると execute が ready
    project.decide(["claim", "plan-1", "--actor", "human/saiki"], "t");
    const approved = project.decide(["approve", "plan-1", "--actor", "human/saiki"], "t");
    assert.deepEqual([approved.item.status, approved.item.phase, approved.item.phaseStatus, approved.item.blockedBy, approved.item.workflow.plan.status], ["open", "execute", "ready", [], "done"]);
    assert.deepEqual([approved.decisions[0].status, approved.decisions[0].decidedBy, approved.decisions[0].decisionSeq], ["approved", "human/saiki", approved.appended.at(-1).seq]);
    assert.deepEqual(project.links("t"), [`status/execute/ready -> ${target("t")}`]);
    // execute の完了は承認を挟まずに review へ
    project.step(["claim", "--actor", "agent/claude"], "t");
    project.write("t", "02-execute.md", handoff("実行"));
    const executeRefs = type === "implementation" ? ["--commit", "project_template:abcdef1"] : [];
    const executed = project.step(["complete", "--actor", "agent/claude", "--handoff", "02-execute.md", ...executeRefs], "t");
    assert.deepEqual([executed.item.status, executed.item.phase, executed.item.phaseStatus, executed.decisions], ["open", "review", "ready", []]);
    // execute の完了者は review を claim できない (職務分離)
    project.fails(project.taskArgs("claim", "t", ["--actor", "agent/claude"]), "WF_SEPARATION");
    project.step(["claim", "--actor", "agent/codex"], "t");
    project.write("t", "03-review.md", "# レビュー\n\n合格\n");
    // review の資料は --report (--handoff は引数の誤り)
    project.fails(project.taskArgs("complete", "t", ["--actor", "agent/codex", "--handoff", "03-review.md"]), "USAGE", { status: 2 });
    const reviewed = project.step(["complete", "--actor", "agent/codex", "--report", "03-review.md"], "t");
    assert.deepEqual([reviewed.item.status, reviewed.item.phase, reviewed.item.phaseStatus, reviewed.item.blockedBy], ["pending", "review", "done", ["approval/review-1"]]);
    assert.deepEqual([reviewed.decisions[0].id, reviewed.decisions[0].assignee], ["review-1", "human/lead"], "approvers.review が初期の判断者");
    // 判断者本人だけが承認できる (依頼元でも判断者でなければ不可)
    project.fails(project.approvalArgs("approve", "t", "review-1", ["--actor", "human/saiki"]), "WF_NOT_APPROVER");
    const closed = project.decide(["approve", "review-1", "--actor", "human/lead"], "t");
    assert.deepEqual([closed.item.status, closed.item.phase, closed.item.closureReason, closed.item.blockedBy, closed.item.waiting], ["closed", null, "approved", [], null]);
    assert.deepEqual(project.links("t"), [], "closed は作業索引も確認待ちの索引も 0 件");
    assert.equal(project.json(["approval", "list", job]).counts.total, 0);
    assert.deepEqual(project.json(["approval", "list", job, "--all"]).items.map((item: Json) => [item.id, item.status]), [["plan-1", "approved"], ["review-1", "approved"]]);
    assert.deepEqual(project.json(["task", "list", job, "--schema-version", "3"]).issues, []);
  }));
}

// ---- P-17-3 差戻し・見送り・revise・reopen ---------------------------------------------------------------------------------

test("P-17-3 AI の差戻し、人の見送り (戻す工程)、revise、reopen を CLI で行い、新しい試行と新しい判断記録で受ける", withProject((project) => {
  project.add("t", "research", ["--plan-approver", "human/saiki", "--review-approver", "human/saiki"]);
  project.submitPlan("t");
  // plan の見送り: 理由が必須、plan 以外へは戻せない
  project.fails(project.approvalArgs("reject", "t", "plan-1", ["--actor", "human/saiki"]), "USAGE", { status: 2 });
  project.fails(project.approvalArgs("reject", "t", "plan-1", ["--actor", "human/saiki", "--reason", "範囲", "--return-to", "execute"]), "WF_USAGE");
  const rejected = project.decide(["reject", "plan-1", "--actor", "human/saiki", "--reason", "範囲が広い"], "t");
  assert.deepEqual([rejected.item.status, rejected.item.phase, rejected.item.phaseStatus, rejected.item.requirementRevision, rejected.item.workflow.plan.attempt], ["open", "plan", "ready", 2, 2]);
  assert.deepEqual([rejected.decisions[0].status, rejected.decisions[0].returnTo, rejected.decisions[0].reason], ["rejected", "plan", "範囲が広い"]);
  // 再提出は plan-2。plan-1 は rejected のまま (閉じた記録は操作できない)
  project.step(["claim", "--actor", "agent/codex"], "t");
  project.step(["complete", "--actor", "agent/codex", "--handoff", "01-plan.md"], "t");
  assert.equal(project.item("t").approval.id, "plan-2");
  project.fails(project.approvalArgs("approve", "t", "plan-1", ["--actor", "human/saiki"]), "WF_APPROVAL_CLOSED");
  project.decide(["approve", "plan-2", "--actor", "human/saiki"], "t");
  // execute → plan の差戻し (AI の担当、理由が必須、版 +1)
  project.step(["claim", "--actor", "agent/claude"], "t");
  project.fails(project.taskArgs("send-back", "t", ["--actor", "agent/claude"]), "USAGE", { status: 2 });
  project.fails(project.taskArgs("send-back", "t", ["--actor", "agent/codex", "--reason", "前提"]), "WF_NOT_ASSIGNEE");
  const sentBack = project.step(["send-back", "--actor", "agent/claude", "--reason", "前提が違う"], "t");
  assert.deepEqual([sentBack.item.phase, sentBack.item.phaseStatus, sentBack.item.requirementRevision, sentBack.item.workflow.plan.attempt, sentBack.item.workflow.plan.assignee], ["plan", "ready", 3, 3, "agent/codex"]);
  assert.equal(project.record("t", "plan-2").status, "approved", "前の承認は履歴として残る");
  // plan から差し戻せない
  project.step(["claim", "--actor", "agent/codex"], "t");
  project.fails(project.taskArgs("send-back", "t", ["--actor", "agent/codex", "--reason", "x"]), "WF_PHASE");
  project.step(["complete", "--actor", "agent/codex", "--handoff", "01-plan.md"], "t");
  project.decide(["approve", "plan-3", "--actor", "human/saiki"], "t");
  project.step(["claim", "--actor", "agent/claude"], "t");
  project.write("t", "02-execute.md", handoff("実行"));
  project.step(["complete", "--actor", "agent/claude", "--handoff", "02-execute.md"], "t");
  // review → execute の差戻し (版は変わらない)
  project.step(["claim", "--actor", "agent/codex"], "t");
  const toExecute = project.step(["send-back", "--actor", "agent/codex", "--reason", "検証不足"], "t");
  // execute は試行 1 (plan への差戻しで 2) の後、review からの差戻しで 3 になる
  assert.deepEqual([toExecute.item.phase, toExecute.item.phaseStatus, toExecute.item.requirementRevision, toExecute.item.workflow.execute.attempt, toExecute.item.workflow.review.status], ["execute", "ready", 3, 3, "waiting"]);
  project.step(["claim", "--actor", "agent/claude"], "t");
  project.step(["complete", "--actor", "agent/claude", "--handoff", "02-execute.md"], "t");
  project.step(["claim", "--actor", "agent/codex"], "t");
  project.write("t", "03-review.md", "# レビュー\n");
  project.step(["complete", "--actor", "agent/codex", "--report", "03-review.md"], "t");
  // review も差戻しで試行が進んでいるので、記録はタスクが待っている ID (review-2) を使う
  const firstReview = project.item("t").approval.id as string;
  assert.equal(firstReview, "review-2");
  // review の見送りは戻す工程が必須。review へ戻すと review の新しい試行
  project.fails(project.approvalArgs("reject", "t", firstReview, ["--actor", "human/saiki", "--reason", "x"]), "WF_USAGE");
  project.fails(project.approvalArgs("reject", "t", firstReview, ["--actor", "human/saiki", "--reason", "x", "--return-to", "acceptance"]), "USAGE", { status: 2 });
  const toReview = project.decide(["reject", firstReview, "--actor", "human/saiki", "--reason", "観点不足", "--return-to", "review"], "t");
  assert.deepEqual([toReview.item.phase, toReview.item.phaseStatus, toReview.item.workflow.review.attempt, toReview.decisions[0].returnTo], ["review", "ready", 3, "review"]);
  project.step(["claim", "--actor", "agent/codex"], "t");
  project.step(["complete", "--actor", "agent/codex", "--report", "03-review.md"], "t");
  // 確認待ちの間の revise は open の記録を superseded にして plan から (人だけ)
  project.fails(project.taskArgs("revise", "t", ["--actor", "agent/codex", "--reason", "x"]), "WF_HUMAN");
  const revised = project.step(["revise", "--actor", "human/saiki", "--reason", "要件の追加"], "t");
  assert.deepEqual([revised.item.status, revised.item.phase, revised.item.requirementRevision, revised.decisions[0].id, revised.decisions[0].status], ["open", "plan", 4, "review-3", "superseded"]);
  assert.deepEqual(project.links("t"), [`status/plan/ready -> ${target("t")}`], "superseded の確認待ちの索引は外れる");
  // 閉じるまで進めて reopen (人だけ、戻す工程が必須、閉じた記録は変えない)
  project.step(["claim", "--actor", "agent/codex"], "t");
  project.step(["complete", "--actor", "agent/codex", "--handoff", "01-plan.md"], "t");
  project.decide(["approve", "plan-4", "--actor", "human/saiki"], "t");
  project.step(["claim", "--actor", "agent/claude"], "t");
  project.step(["complete", "--actor", "agent/claude", "--handoff", "02-execute.md"], "t");
  project.step(["claim", "--actor", "agent/codex"], "t");
  project.step(["complete", "--actor", "agent/codex", "--report", "03-review.md"], "t");
  project.decide(["approve", project.item("t").approval.id, "--actor", "human/saiki"], "t");
  const closedRecords = project.json(["approval", "list", job, "--all"]).items.map((item: Json) => [item.id, item.status, item.recordRevision]);
  project.fails(project.taskArgs("reopen", "t", ["--actor", "agent/codex", "--return-to", "execute", "--reason", "x"]), "WF_HUMAN");
  project.fails(project.taskArgs("reopen", "t", ["--actor", "human/saiki", "--reason", "x"]), "USAGE", { status: 2 });
  const reopened = project.step(["reopen", "--actor", "human/saiki", "--return-to", "execute", "--reason", "不具合"], "t");
  assert.deepEqual([reopened.item.status, reopened.item.phase, reopened.item.phaseStatus, reopened.item.requirementRevision], ["open", "execute", "ready", 4]);
  assert.deepEqual(project.json(["approval", "list", job, "--all"]).items.map((item: Json) => [item.id, item.status, item.recordRevision]), closedRecords, "閉じた記録は reopen で変わらない");
}));

// ---- P-17-4 権限 ----------------------------------------------------------------------------------------------------------

test("P-17-4 判断記録の操作は人だけ。未割当は claim、判断者の変更は本人か人の依頼元だけで理由が必須、承認は判断者本人だけ", withProject((project) => {
  project.add("t", "implementation");
  project.submitPlan("t");
  for (const [command, rest] of [["claim", []], ["approve", []], ["reject", ["--reason", "x"]], ["assign", ["--to", "human/other", "--reason", "x"]]] as const) {
    project.fails(project.approvalArgs(command, "t", "plan-1", ["--actor", "agent/codex", ...rest]), "WF_HUMAN");
  }
  // 未割当の記録は承認できない (先に claim)。actor は環境変数から補わない
  project.fails(project.approvalArgs("approve", "t", "plan-1", ["--actor", "human/saiki"]), "WF_NOT_APPROVER");
  project.fails(project.approvalArgs("claim", "t", "plan-1", []), "USAGE", { status: 2 });
  project.decide(["claim", "plan-1", "--actor", "human/saiki"], "t");
  // 割当済みの記録は別の人が claim できない。判断者でも依頼元でもない人は付け替えられず、承認もできない
  project.fails(project.approvalArgs("claim", "t", "plan-1", ["--actor", "human/other"]), "WF_NOT_APPROVER");
  project.fails(project.approvalArgs("assign", "t", "plan-1", ["--actor", "human/other", "--to", "human/other", "--reason", "代わる"]), "WF_NOT_APPROVER");
  project.fails(project.approvalArgs("approve", "t", "plan-1", ["--actor", "human/other"]), "WF_NOT_APPROVER");
  project.fails(project.approvalArgs("assign", "t", "plan-1", ["--actor", "agent/codex", "--to", "human/other", "--reason", "x"]), "WF_HUMAN");
  // 判断者本人の変更は理由が必須。AI を判断者にできない
  project.fails(project.approvalArgs("assign", "t", "plan-1", ["--actor", "human/saiki", "--to", "human/other"]), "USAGE", { status: 2 });
  project.fails(project.approvalArgs("assign", "t", "plan-1", ["--actor", "human/saiki", "--to", "agent/codex", "--reason", "x"]), "WF_HUMAN");
  const assigned = project.decide(["assign", "plan-1", "--actor", "human/saiki", "--to", "human/other", "--reason", "休暇"], "t");
  assert.deepEqual([assigned.decisions[0].assignee, assigned.decisions[0].history.at(-1).event, assigned.decisions[0].history.at(-1).reason], ["human/other", "assign", "休暇"]);
  assert.deepEqual(assigned.appended, [], "判断者の変更はタスクの history を変えない");
  project.fails(project.approvalArgs("approve", "t", "plan-1", ["--actor", "human/saiki"]), "WF_NOT_APPROVER");
  // 依頼元 (requestedBy: human/saiki) の人は判断者を替えられる。none で未割当に戻す
  const back = project.decide(["assign", "plan-1", "--actor", "human/saiki", "--to", "none", "--reason", "割り当て直し"], "t");
  assert.equal(back.decisions[0].assignee, null);
  assert.deepEqual(project.json(["approval", "list", job, "--unassigned"]).items.map((item: Json) => item.id), ["plan-1"]);
  project.decide(["claim", "plan-1", "--actor", "human/other"], "t");
  assert.deepEqual(project.json(["approval", "list", job, "--assignee", "human/other"]).counts, { total: 1, shown: 1, unassigned: 0, assigned: 1 });
  assert.deepEqual(project.json(["approval", "list", job, "--unassigned"]).items, []);
  project.decide(["approve", "plan-1", "--actor", "human/other"], "t");
}));

// ---- P-17-5 revision・古い記録・同時操作 ------------------------------------------------------------------------------------

test("P-17-5 revision の指定漏れ・不一致、古い記録・閉じた記録は何も変えずに拒否し、二重 claim・二重承認は一方だけが成功する", withProject(async (project) => {
  project.add("t", "research");
  project.submitPlan("t");
  const record = project.record("t", "plan-1");
  const base = ["approval", "claim", job, "t", "plan-1", "--actor", "human/saiki"];
  project.fails([...base, "--record-match", record.recordRevision], "REVISION_REQUIRED", { status: 2 });
  project.fails([...base, "--if-match", record.taskRevision], "RECORD_MATCH_REQUIRED", { status: 2 });
  project.fails([...base, "--if-match", record.taskRevision, "--record-match", "0".repeat(64)], "REVISION_CONFLICT");
  project.fails([...base, "--if-match", "0".repeat(64), "--record-match", record.recordRevision], "REVISION_CONFLICT");
  project.fails([...base, "--if-match", record.taskRevision, "--record-match", "xyz"], "USAGE", { status: 2 });
  project.fails(["task", "claim", job, "t", "--actor", "agent/codex"], "REVISION_REQUIRED", { status: 2 });
  project.fails(["approval", "show", job, "t", "plan-9"], "APPROVAL_NOT_FOUND");
  project.fails(["approval", "show", job, "t", "acceptance-1"], "USAGE", { status: 2 });
  // 二重 claim: 同じ revision から 2 つのプロセスで。一方だけが成功し、もう一方は REVISION_CONFLICT
  const claims = await Promise.all(["human/saiki", "human/other"].map((actor) => rapridAsync(project.root, ["approval", "claim", job, "t", "plan-1", "--actor", actor, "--if-match", record.taskRevision, "--record-match", record.recordRevision, "--json"])));
  const claimCodes = claims.map((result) => (JSON.parse(result.stdout) as Json).error?.code ?? "ok").sort();
  assert.deepEqual(claimCodes, ["REVISION_CONFLICT", "ok"], JSON.stringify(claims));
  const claimer = project.record("t", "plan-1").assignee as string;
  // 二重承認: 一方だけが成功する
  const current = project.record("t", "plan-1");
  const approvals = await Promise.all([0, 1].map(() => rapridAsync(project.root, ["approval", "approve", job, "t", "plan-1", "--actor", claimer, "--if-match", current.taskRevision, "--record-match", current.recordRevision, "--json"])));
  assert.deepEqual(approvals.map((result) => (JSON.parse(result.stdout) as Json).error?.code ?? "ok").sort(), ["REVISION_CONFLICT", "ok"], JSON.stringify(approvals));
  assert.equal(project.item("t").workflow.execute.status, "ready");
  const history = project.record("t", "plan-1").history.map((entry: Json) => entry.event);
  assert.deepEqual(history, ["create", "claim", "approve"], "承認は 1 回だけ記録される");
  // 承認済みの記録への操作は WF_APPROVAL_CLOSED
  project.fails(project.approvalArgs("approve", "t", "plan-1", ["--actor", claimer]), "WF_APPROVAL_CLOSED");
  // 古い試行: 見送り後に残る plan-2 の前の記録。タスクが指していない open の記録 (手で置いた残り物) は STALE か INVALID で止まる
  project.step(["claim", "--actor", "agent/claude"], "t");
  project.write("t", "02-execute.md", handoff("実行"));
  project.step(["complete", "--actor", "agent/claude", "--handoff", "02-execute.md"], "t");
  project.step(["claim", "--actor", "agent/codex"], "t");
  project.write("t", "03-review.md", "# レビュー\n");
  project.step(["complete", "--actor", "agent/codex", "--report", "03-review.md"], "t");
  const stale = project.record("t", "review-1");
  project.step(["revise", "--actor", "human/saiki", "--reason", "変更"], "t");
  // superseded の記録に古い revision で操作する (読んだ後に変わった) → REVISION_CONFLICT。今の revision でも閉じているので CLOSED
  project.fails(["approval", "approve", job, "t", "review-1", "--actor", "human/saiki", "--if-match", stale.taskRevision, "--record-match", stale.recordRevision], "REVISION_CONFLICT");
  project.fails(project.approvalArgs("approve", "t", "review-1", ["--actor", "human/saiki"]), "WF_APPROVAL_CLOSED");
}));

// ---- P-17-6 版の混在 ------------------------------------------------------------------------------------------------------

test("P-17-6 旧形式・v3・v4 が混在する案件で、版ごとに操作を振り分け、版の違う操作は案内付きで拒否し、JSON の版を分ける", withProject((project) => {
  project.ok(["task", "add", job, "old", "todo", "旧形式", "--requested-by", "human/saiki", "--created-by", "agent/codex"]);
  project.ok(["task", "add", job, "v3", "--type", "research", "v3 のタスク", "--requested-by", "human/saiki", "--created-by", "agent/codex"]);
  project.add("v4", "research");
  // schemaVersion 1・2 は v4 のタスクがあると止まり、3 を案内する。3 では全部読める
  for (const args of [["task", "list", job], ["task", "list"], ["ui", "snapshot"], ["job", "list"], ["task", "show", job, "v4"]]) {
    for (const version of ["1", "2"]) {
      const body = project.fails([...args, ...(version === "1" ? [] : ["--schema-version", version])], "SCHEMA_V3_REQUIRED", { version: Number(version) });
      assert.match(body.error.message, /--schema-version 3/);
    }
  }
  assert.equal(project.json(["task", "show", job, "v3", "--schema-version", "2"]).item.workflowVersion, 3, "v4 のタスクを含まない show は schemaVersion 2 で読める");
  const all = project.json(["task", "list", job, "--schema-version", "3"]);
  assert.deepEqual(all.items.map((item: Json) => [item.name, item.workflowVersion]).sort(), [["old", null], ["v3", 3], ["v4", 4]]);
  const snap = project.json(["ui", "snapshot", "--schema-version", "3"]);
  assert.deepEqual([snap.schemaVersion, snap.approvals], [3, []]);
  // 同じ名前の操作は版で振り分ける。v3 の操作の JSON は schemaVersion 2、v4 は 3
  const v3 = project.json(project.taskArgs("claim", "v3", ["--actor", "agent/codex"]));
  assert.deepEqual([v3.schemaVersion, v3.item.workflowVersion, v3.item.phaseStatus], [2, 3, "progress"]);
  const v4 = project.json(project.taskArgs("claim", "v4", ["--actor", "agent/codex"]));
  assert.deepEqual([v4.schemaVersion, v4.item.workflowVersion, v4.item.phaseStatus], [3, 4, "progress"]);
  // 版の違う操作
  project.fails(project.taskArgs("decide", "v4", ["approved", "--actor", "agent/codex", "--report", "x.md"]), "WF_NOT_V3");
  project.fails(project.taskArgs("send-back", "v3", ["--actor", "agent/codex", "--reason", "x"]), "WF_NOT_V4");
  project.fails(project.taskArgs("revise", "old", ["--actor", "human/saiki", "--reason", "x"]), "WF_NOT_V4");
  project.fails(["approval", "show", job, "v3", "plan-1"], "WF_NOT_V4");
  project.fails(["task", "move", job, "v4", "done"], "WF_NOT_V3", { version: 1 });
  project.failsText(["task", "ask", job, "v4", "q", "internal", "質問", "--actor", "agent/codex", "--requested-by", "agent/codex", "--created-by", "agent/codex"], 1, /task ask を使えません[\s\S]*raprid qa add[\s\S]*task block/);
  project.fails(project.taskArgs("reopen", "v4", ["--actor", "human/saiki", "--return-to", "acceptance", "--reason", "x"]), "USAGE", { status: 2 });
  project.fails(project.taskArgs("assign", "v4", ["acceptance", "agent/claude", "--by", "human/saiki", "--reason", "x"]), "USAGE", { status: 2 });
  // v3 の工程の操作は v3 のまま (v4 の --report は v3 の complete に無い)
  project.fails(project.taskArgs("complete", "v3", ["--actor", "agent/codex", "--report", "x.md"]), "USAGE", { status: 2, version: 2 });
  // task note は本文だけを変えるので v4 のタスクにも使え、frontmatter は 1 バイトも変えない
  const before = readFileSync(join(project.dir("v4"), "index.md"), "utf8");
  project.ok(["task", "note", job, "v4", "memo", "メモ", "--if-match", project.revision("v4")]);
  const after = readFileSync(join(project.dir("v4"), "index.md"), "utf8");
  assert.equal(after.slice(0, after.indexOf("\n---\n", 4)), before.slice(0, before.indexOf("\n---\n", 4)));
  assert.match(after, /\* \[メモ\]\(01-memo\.md\)/);
  // v4 の QA 待ちは qa add と block の 2 つの操作で行い、未解決のまま resume できない
  project.ok(["qa", "add", job, "q1", "internal", "確認したい", "--requested-by", "agent/codex", "--created-by", "agent/codex"]);
  const blocked = project.step(["block", "--actor", "agent/codex", "--blocked-by", "qa/Q-001"], "v4");
  assert.deepEqual([blocked.item.status, blocked.item.phaseStatus, blocked.item.waiting], ["open", "pending", { kind: "external", phase: "plan", blockedBy: ["qa/Q-001"] }]);
  project.fails(project.taskArgs("block", "v4", ["--actor", "agent/codex", "--blocked-by", "approval/plan-1"]), "WF_STATE");
  project.fails(project.taskArgs("resume", "v4", ["--actor", "agent/codex"]), "BLOCKED_BY_QA");
  project.write("v4", "02-plan.md", handoff("計画"));
  project.fails(project.taskArgs("complete", "v4", ["--actor", "agent/codex", "--handoff", "02-plan.md"]), "WF_STATE");
}));

// ---- P-17-7 一覧・表示・索引の診断 ----------------------------------------------------------------------------------------

test("P-17-7 一覧と表示で人の確認待ちと外部の待ちを別の語で示し、確認待ちの索引の不整合を推測せずに報告する", withProject((project) => {
  project.add("wait", "implementation", ["--plan-approver", "human/saiki"]);
  project.submitPlan("wait");
  project.add("ext", "research");
  project.ok(["qa", "add", job, "q1", "internal", "確認", "--requested-by", "agent/codex", "--created-by", "agent/codex"]);
  project.step(["claim", "--actor", "agent/codex"], "ext");
  project.step(["block", "--actor", "agent/codex", "--blocked-by", "qa/Q-001"], "ext");
  // --status approval は人の確認待ちだけ、pending は外部の待ちだけ
  assert.deepEqual(project.json(["task", "list", job, "--schema-version", "3", "--status", "approval"]).items.map((item: Json) => item.name), ["wait"]);
  assert.deepEqual(project.json(["task", "list", job, "--schema-version", "3", "--status", "pending"]).items.map((item: Json) => item.name), ["ext"]);
  const text = project.ok(["task", "list", job, "--long"]);
  assert.match(text, /T-001 .*確認待ち/);
  assert.match(text, /確認待ち: plan-1 \(判断者: human\/saiki\)/);
  assert.match(text, /外部待ち: qa\/Q-001/);
  const shown = project.ok(["task", "show", job, "wait"]);
  assert.match(shown, /判断記録 plan-1 +open \/ 判断者 human\/saiki \/ タスクが待っている/);
  const detail = project.ok(["approval", "show", job, "wait", "plan-1"]);
  assert.match(detail, /成果物 +01-plan\.md/);
  assert.match(detail, /recordRevision +[0-9a-f]{64}/);
  assert.match(project.ok(["approval", "list"]), /PROJ\/T-001 +plan-1 +open +human\/saiki/);
  // TUI 用の snapshot (schemaVersion 3) は確認待ちを approval list と同じ形で返す
  const snap = project.json(["ui", "snapshot", job, "--schema-version", "3"]);
  assert.deepEqual(snap.approvals, project.json(["approval", "list", job]).items);
  assert.deepEqual(snap.tasks.map((item: Json) => [item.name, item.status, item.waiting?.kind ?? null]), [["wait", "pending", "approval"], ["ext", "open", "external"]]);
  // show の JSON は提出の写し・履歴・本文を返す (本文の資料そのものは返さない)
  const record = project.record("wait", "plan-1");
  assert.deepEqual([record.submission.artifactRefs, record.history.map((entry: Json) => entry.event), record.rawMarkdown], [[{ path: "01-plan.md" }], ["create"], "# 判断のメモ\n"]);
  // 確認待ちの索引を消す・余分に置くと、一覧が要確認に出す (推測で直さない)
  const queue = join(project.root, "jobs", job, "approvals", "open");
  rmSync(join(queue, "wait--plan-1"));
  writeFileSync(join(queue, "gone--plan-1"), "");
  const listed = project.json(["approval", "list", job]);
  assert.deepEqual(listed.issues.map((issue: Json) => issue.code).sort(), ["LINK_MISSING", "LINK_ORPHAN"]);
  assert.equal(listed.items[0].id, "plan-1", "正は記録の frontmatter なので、索引が無くても一覧に出る");
  // このタスクの索引の置き場所にリンク以外があれば、書き込みは推測で直さずに止まる (WF_INDEX)
  writeFileSync(join(queue, "wait--plan-1"), "");
  assert.ok(project.json(["approval", "list", job]).issues.some((issue: Json) => issue.code === "LINK_NOT_SYMLINK"));
  project.fails(project.approvalArgs("approve", "wait", "plan-1", ["--actor", "human/saiki"]), "WF_INDEX");
  // 索引が無いだけなら、承認で記録が閉じて正しい状態 (0 件) になる。無関係の残り物は消さずに報告し続ける
  rmSync(join(queue, "wait--plan-1"));
  project.decide(["approve", "plan-1", "--actor", "human/saiki"], "wait");
  assert.deepEqual(project.json(["approval", "list", job]).issues.map((issue: Json) => issue.code), ["LINK_ORPHAN"]);
  // 判断記録の置き場所がリンクなら辿って読まず、黙って空とせずに報告する
  const outside = join(project.root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(project.dir("ext"), "decisions"));
  const issues = project.json(["task", "list", job, "--schema-version", "3"]).issues.filter((issue: Json) => issue.code === "WF_DECISION");
  assert.deepEqual(issues.map((issue: Json) => [issue.id, issue.path]), [["T-002", `jobs/${job}/tasks/ext/decisions`]]);
}));

// ---- P-17-8 残った journal の要確認と復旧 ----------------------------------------------------------------------------------

// symlinkSync の n 回目で異常終了させる前処理 (finally も走らない)。ESM の node:fs の名前付き輸出にも反映する
function crashPreload(dir: string): string {
  const path = join(dir, "crash-symlink.cjs");
  writeFileSync(
    path,
    `const fs = require("node:fs");
const original = fs.symlinkSync;
let count = 0;
fs.symlinkSync = (...args) => {
  count += 1;
  if (count === Number(process.env.RAPRID_CRASH_AT)) process.exit(137);
  return original(...args);
};
require("node:module").syncBuiltinESMExports();
`,
  );
  return path;
}

test("P-17-8 異常終了で残った journal を一覧で要確認に出し、次の CLI の書き込みで戻すか、食い違えば WF_APPROVAL_ORPHAN で止める", withProject((project) => {
  const preload = crashPreload(project.root);
  project.add("a", "research");
  project.add("b", "research");
  for (const name of ["a", "b"]) {
    project.step(["claim", "--actor", "agent/codex"], name);
    project.write(name, "01-plan.md", handoff("計画"));
  }
  // a の提出が、判断記録と journal を書き、作業索引を外した後、新しい索引を張る前に異常終了する
  const crashed = project.run(["task", "complete", job, "a", "--actor", "agent/codex", "--handoff", "01-plan.md", "--if-match", project.revision("a"), "--json"], { require: preload, env: { RAPRID_CRASH_AT: "1" } });
  assert.equal(crashed.status, 137, crashed.stdout + crashed.stderr);
  const journals = readdirSync(join(project.root, "jobs", job, ".raprid-ops"));
  assert.equal(journals.length, 1);
  // 一覧 (読むだけ) は片付けずに要確認を出す
  const listed = project.json(["task", "list", job, "--schema-version", "3"]);
  const pending = listed.issues.filter((issue: Json) => issue.code === "WF_JOURNAL_PENDING");
  assert.deepEqual([pending.length, pending[0].id, pending[0].path], [1, "T-001", `jobs/${job}/.raprid-ops/${journals[0]}`]);
  assert.ok(project.json(["approval", "list", job]).issues.some((issue: Json) => issue.code === "WF_JOURNAL_PENDING"));
  assert.match(project.ok(["task", "list", job]), /中断した操作の記録が残っています: jobs\/PROJ\/\.raprid-ops\//);
  assert.equal(readdirSync(join(project.root, "jobs", job, ".raprid-ops")).length, 1, "読み取りは journal を消さない");
  // 次の書き込み (別のタスクの操作) の前に、journal の前の状態へ戻す
  const next = project.step(["complete", "--actor", "agent/codex", "--handoff", "01-plan.md"], "b");
  assert.deepEqual(next.recovered, [`jobs/${job}/.raprid-ops/${journals[0]}`]);
  assert.deepEqual(project.links("a"), [`status/plan/progress -> ${target("a")}`], "外した作業索引を作り直す");
  assert.equal(existsSync(join(project.dir("a"), "decisions", "plan-1.md")), false, "journal の内容のままの判断記録は消える");
  assert.deepEqual(project.json(["task", "list", job, "--schema-version", "3"]).issues, []);
  // もう一度異常終了させ、判断記録に人が追記してから書き込むと、何も変えずに止まる
  const again = project.run(["task", "complete", job, "a", "--actor", "agent/codex", "--handoff", "01-plan.md", "--if-match", project.revision("a"), "--json"], { require: preload, env: { RAPRID_CRASH_AT: "1" } });
  assert.equal(again.status, 137);
  writeFileSync(join(project.dir("a"), "decisions", "plan-1.md"), `${readFileSync(join(project.dir("a"), "decisions", "plan-1.md"), "utf8")}\n人のメモ\n`);
  const bRecord = project.record("b", "plan-1");
  const body = project.fails(["approval", "claim", job, "b", "plan-1", "--actor", "human/saiki", "--if-match", bRecord.taskRevision, "--record-match", bRecord.recordRevision], "WF_APPROVAL_ORPHAN");
  assert.match(body.error.message, /\.raprid-ops/);
  // v3・旧形式の書き込みも同じ案件なら止まる
  project.fails(["task", "add", job, "c", "--type", "research", "v3", "--requested-by", "human/saiki", "--created-by", "agent/codex"], "WF_APPROVAL_ORPHAN", { version: 1 });
  project.failsText(["task", "add", job, "d", "todo", "旧形式", "--requested-by", "human/saiki", "--created-by", "agent/codex"], 1, /WF_APPROVAL_ORPHAN|journal/);
  const issues = project.json(["task", "list", job, "--schema-version", "3"]).issues.map((issue: Json) => issue.code);
  assert.ok(issues.includes("WF_JOURNAL_PENDING") && issues.includes("WF_APPROVAL_ORPHAN"), JSON.stringify(issues));
}));
