// workflowVersion 4 の遷移 (lib/transitions-v4.ts) と一体更新のサービス (lib/taskflow-v4.ts) の試験。T-021 (章 16)
// 契約は jobs/project_template/tasks/workflow-v4-contract/03-contract.md の 4・5・6・7。データの検証は T-020 (章 14) の検証器を使う。
// CLI への接続は T-022 なので、サービスを直接呼ぶ。同時操作と異常終了は node の子プロセスで再現する。

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type DecisionRecord, checkTaskDecisions, expectedWorkLinkV4, readDecisionFile } from "../lib/decision.ts";
import { CliError } from "../lib/errors.ts";
import { type MatchV4, type OpsFs, decisionRevision, defaultOpsFs, pendingJournals, readDecisionFiles, runTransitionV4 } from "../lib/taskflow-v4.ts";
import { runTransition, taskRevision } from "../lib/taskflow.ts";
import type { Clock } from "../lib/transitions.ts";
import { type OperationV4, isApprovalOperation } from "../lib/transitions-v4.ts";
import { type Approvers, type TaskType, type TaskV4, initialTaskV3, initialTaskV4, readTaskFile, validateTaskV4 } from "../lib/workflow.ts";
import { YamlFrontmatter } from "../lib/yamlfront.ts";
import { raprid, snapshot } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const taskflowV4Path = join(here, "..", "lib", "taskflow-v4.ts");
const job = "PROJ";
const name = "task-a";
const body = "\n# 概要\n\n本文は変えない。\n";

const handoff = (title = "引継ぎ") => `# ${title}\n\n## 対象・成果物\n\n- 成果物\n\n## 実施・検証\n\n- 実施した検証\n\n## 未確認・制約\n\n- なし\n\n## 次の担当への依頼\n\n- 確認してほしい点\n`;

class Project {
  readonly root = mkdtempSync(join(tmpdir(), "raprid-taskflow-v4-"));
  private minute = 0;

  constructor() {
    mkdirSync(join(this.root, "jobs"));
    const created = raprid(this.root, ["job", "create", job]);
    assert.equal(created.status, 0, created.stderr);
    mkdirSync(join(this.root, "repos", "project_template"), { recursive: true });
  }

  get jobDir(): string {
    return join(this.root, "jobs", job);
  }

  dir(task = name): string {
    return join(this.jobDir, "tasks", task);
  }

  index(task = name): string {
    return join(this.dir(task), "index.md");
  }

  decisionPath(id: string, task = name): string {
    return join(this.dir(task), "decisions", `${id}.md`);
  }

  // 新しい v4 のタスクを置く (未知の項目 test と本文を持つ)
  create(type: TaskType, options: { task?: string; id?: string; approvers?: Approvers; requestedBy?: string } = {}): void {
    const task = options.task ?? name;
    const data = initialTaskV4({ id: options.id ?? "T-001", type, date: "2026-10-01", at: "2026-10-01T00:00:00Z", requestedBy: options.requestedBy ?? "human/saiki", createdBy: "agent/codex", approvers: options.approvers });
    const frontmatter = YamlFrontmatter.parse(`---\n---\n${body}`);
    for (const [key, value] of Object.entries(data)) frontmatter.set([key], value);
    frontmatter.set(["test"], ["docs/feature/raprid/workflow-v4-transitions.feature"]);
    mkdirSync(this.dir(task), { recursive: true });
    writeFileSync(this.index(task), frontmatter.toString());
    // 作業索引 (plan/ready)
    mkdirSync(join(this.jobDir, "status", "plan", "ready"), { recursive: true });
    symlinkSync(`../../../tasks/${task}`, join(this.jobDir, "status", "plan", "ready", task));
  }

  write(file: string, content: string, task = name): void {
    mkdirSync(dirname(join(this.dir(task), file)), { recursive: true });
    writeFileSync(join(this.dir(task), file), content);
  }

  read(task = name): string {
    return readFileSync(this.index(task), "utf8");
  }

  data(task = name): TaskV4 {
    return YamlFrontmatter.parse(this.read(task)).data() as TaskV4;
  }

  decision(id: string, task = name): DecisionRecord {
    return YamlFrontmatter.parse(readFileSync(this.decisionPath(id, task), "utf8")).data() as DecisionRecord;
  }

  clock(): Clock {
    this.minute += 1;
    return { date: "2026-10-01", at: new Date(Date.parse("2026-10-01T01:00:00Z") + this.minute * 60_000).toISOString().replace(".000Z", "Z") };
  }

  match(operation: OperationV4, task = name): MatchV4 {
    return { ifMatch: taskRevision(this.index(task)), recordMatch: isApprovalOperation(operation) ? decisionRevision(this.decisionPath(operation.id, task)) : undefined };
  }

  run(operation: OperationV4, options: { task?: string; match?: MatchV4; fs?: OpsFs; clock?: Clock } = {}): TaskV4 {
    const task = options.task ?? name;
    return runTransitionV4(this.root, job, task, options.match ?? this.match(operation, task), operation, { clock: options.clock ?? this.clock(), fs: options.fs }).task;
  }

  // 案件のファイル・リンクの一覧 (ロックを除く)
  state(): Record<string, string> {
    return snapshot(this.jobDir, (rel) => rel.startsWith(".locks"));
  }

  // 失敗し、code が一致し、案件のファイル・リンクが 1 バイトも変わらないこと
  rejects(operation: OperationV4, code: string, options: { task?: string; match?: MatchV4; fs?: OpsFs; clock?: Clock } = {}): CliError {
    const before = this.state();
    let caught: unknown;
    try {
      this.run(operation, options);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof CliError, `${operation.kind}: 失敗しない (${code} を期待)`);
    assert.equal(caught.code, code, `${operation.kind}: ${caught.message}`);
    assert.deepEqual(this.state(), before, `${operation.kind} (${code}): 失敗したら何も変わらない`);
    return caught;
  }

  // T-020 のフィクスチャ (fixtures/workflow-v4/<場面>) を案件に置き、作業索引と確認待ちの索引を作る
  importScene(scene: string, task = name): void {
    cpSync(join(here, "fixtures", "workflow-v4", scene), this.dir(task), { recursive: true });
    const data = this.data(task);
    const work = expectedWorkLinkV4(this.jobDir, task, data);
    if (work) {
      mkdirSync(dirname(work), { recursive: true });
      symlinkSync(`../../../tasks/${task}`, work);
    }
    for (const file of readDecisionFiles(this.dir(task))) {
      if ((file.data as DecisionRecord).status !== "open") continue;
      mkdirSync(join(this.jobDir, "approvals", "open"), { recursive: true });
      symlinkSync(`../../tasks/${task}/decisions/${file.id}.md`, join(this.jobDir, "approvals", "open", `${task}--${file.id}`));
    }
  }

  // タスクと判断記録と索引が T-020 の規則に合う (fixture なら本文と未知の項目は確かめない)
  consistent(task = name, fixture = false): void {
    const text = this.read(task);
    assert.deepEqual(readTaskFile(text).issues, [], "タスクが検証を通る");
    const data = this.data(task);
    assert.deepEqual(checkTaskDecisions(data, readDecisionFiles(this.dir(task))), [], "判断記録との照合を通る");
    if (!fixture) {
      assert.ok(text.endsWith(`---\n${body}`), "本文は変わらない");
      assert.match(text, /\ntest:\n  - docs\/feature\/raprid\/workflow-v4-transitions.feature\n/, "未知の項目は残る");
    }
    assert.deepEqual(this.workLinks(task), this.expectedWork(data, task), "作業索引は 1 件 (closed なら 0 件)");
    const open = readDecisionFiles(this.dir(task)).filter((file) => (file.data as DecisionRecord).status === "open").map((file) => `${task}--${file.id}`);
    assert.deepEqual(this.queueLinks(task), open.sort(), "確認待ちの索引は open の記録ごとに 1 件");
    for (const entry of this.queueLinks(task)) assert.equal(readlinkSync(join(this.jobDir, "approvals", "open", entry)), `../../tasks/${task}/decisions/${entry.slice(task.length + 2)}.md`);
    assert.deepEqual(pendingJournals(this.jobDir), [], "journal は残らない");
  }

  expectedWork(data: TaskV4, task = name): string[] {
    if (data.status === "closed") return [];
    if (data.status === "pending") return [`status/approval/${data.phase}/${task}`];
    return [`status/${data.phase}/${data.workflow[data.phase!].status}/${task}`];
  }

  workLinks(task = name): string[] {
    const found: string[] = [];
    const status = join(this.jobDir, "status");
    for (const phase of readdirSync(status)) {
      const phaseDir = join(status, phase);
      if (!lstatSync(phaseDir).isDirectory()) continue;
      for (const sub of readdirSync(phaseDir)) {
        const path = join(phaseDir, sub, task);
        if (existsSync(join(phaseDir, sub)) && lstatSync(join(phaseDir, sub)).isDirectory() && lstatOrNull(path)) {
          assert.equal(readlinkSync(path), `../../../tasks/${task}`);
          found.push(`status/${phase}/${sub}/${task}`);
        }
      }
    }
    return found;
  }

  queueLinks(task = name): string[] {
    const dir = join(this.jobDir, "approvals", "open");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((entry) => entry.startsWith(`${task}--`)).sort();
  }

  close(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
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

// plan を agent/codex が提出する (人の確認待ちになる)
function submitPlan(project: Project, task = name, actor = "agent/codex", file = "01-plan.md"): void {
  project.write(file, handoff("計画"), task);
  project.run({ kind: "claim", actor }, { task });
  project.run({ kind: "complete", actor, refs: [{ path: file }] }, { task });
}

// 判断記録を人が (未割当なら claim してから) 承認する
function approve(project: Project, id: string, actor = "human/saiki", task = name): TaskV4 {
  if (project.decision(id, task).assignee === null) project.run({ kind: "approval-claim", actor, id }, { task });
  return project.run({ kind: "approve", actor, id }, { task });
}

// plan の承認 → execute (agent/claude) の完了まで進める
function throughExecute(project: Project, type: TaskType, task = name): void {
  submitPlan(project, task);
  approve(project, "plan-1", "human/saiki", task);
  project.write("02-handoff.md", handoff("実行"), task);
  project.run({ kind: "claim", actor: "agent/claude" }, { task });
  const refs = type === "research" ? [{ path: "02-handoff.md" }] : [{ path: "02-handoff.md" }, { repo: "project_template", commit: "873ca38" }];
  project.run({ kind: "complete", actor: "agent/claude", refs }, { task });
}

// review を agent/codex が提出する
function submitReview(project: Project, task = name): void {
  project.write("03-review.md", "# レビュー\n\n指摘なし\n", task);
  project.run({ kind: "claim", actor: "agent/codex" }, { task });
  project.run({ kind: "complete", actor: "agent/codex", refs: [{ path: "03-review.md" }] }, { task });
}

for (const type of ["research", "implementation"] as const) {
  test(`P-16-1 ${type}: plan の提出は人の確認待ちになり、判断者の承認で execute が ready になる。AI の承認は拒否する`, withProject((project) => {
    project.create(type, { approvers: { plan: "human/saiki" } });
    project.write("01-plan.md", handoff("計画"));
    project.run({ kind: "claim", actor: "agent/codex" });
    const submitted = project.run({ kind: "complete", actor: "agent/codex", refs: [{ path: "01-plan.md" }] });
    // (3) plan は done に固定、タスクは pending、blockedBy は approval/plan-1 だけ
    assert.equal(submitted.status, "pending");
    assert.equal(submitted.phase, "plan");
    assert.deepEqual(submitted.blockedBy, ["approval/plan-1"]);
    assert.equal(submitted.workflow.plan.status, "done");
    assert.equal(submitted.workflow.plan.approval, "plan-1");
    assert.equal(submitted.workflow.plan.completedBy, "agent/codex");
    assert.deepEqual(submitted.workflow.plan.artifactRefs, [{ path: "01-plan.md" }]);
    assert.equal(submitted.workflow.execute.status, "waiting", "承認まで execute を ready にしない");
    // (4) 判断記録は open、提出はこの complete、担当は approvers.plan
    const created = project.decision("plan-1");
    const complete = submitted.history.at(-1)!;
    assert.equal(created.status, "open");
    assert.equal(created.origin, "submit");
    assert.equal(created.submissionSeq, complete.seq);
    assert.deepEqual(created.submission, { completedBy: "agent/codex", completedAt: complete.at, artifactRefs: [{ path: "01-plan.md" }] });
    assert.equal(created.assignee, "human/saiki");
    assert.deepEqual(project.workLinks(), ["status/approval/plan/task-a"]);
    assert.deepEqual(project.queueLinks(), ["task-a--plan-1"]);
    assert.deepEqual(readDecisionFile(readFileSync(project.decisionPath("plan-1"), "utf8")).issues, []);
    assert.match(readFileSync(project.decisionPath("plan-1"), "utf8"), /\n# 判断のメモ\n$/);
    project.consistent();
    // (5)(6) AI の承認は WF_HUMAN
    project.rejects({ kind: "approve", actor: "agent/codex", id: "plan-1" }, "WF_HUMAN");
    project.rejects({ kind: "approve", actor: "agent/claude", id: "plan-1" }, "WF_HUMAN");
    // (7)(8) 担当の人の承認
    const approved = project.run({ kind: "approve", actor: "human/saiki", id: "plan-1" });
    const entry = approved.history.at(-1)!;
    assert.equal(entry.event, "approve");
    assert.deepEqual(entry.refs, [{ path: "decisions/plan-1.md" }]);
    const record = project.decision("plan-1");
    assert.equal(record.status, "approved");
    assert.equal(record.decidedBy, "human/saiki");
    assert.equal(record.decidedAt, entry.at);
    assert.equal(record.decisionSeq, entry.seq);
    assert.equal(approved.status, "open");
    assert.equal(approved.phase, "execute");
    assert.equal(approved.workflow.plan.status, "done", "plan は done のまま");
    assert.equal(approved.workflow.execute.status, "ready");
    assert.equal(approved.workflow.execute.inputSeq, complete.seq, "execute は plan の完了を受け取る");
    assert.equal(approved.workflow.execute.inputRevision, 1);
    assert.deepEqual(approved.blockedBy, []);
    assert.deepEqual(project.queueLinks(), [], "閉じた記録の確認待ちの索引は 0 件");
    project.consistent();
  }));

  test(`P-16-2 ${type}: execute の完了は承認を挟まずに review へ進み、review の提出の承認でタスクが閉じる`, withProject((project) => {
    project.create(type);
    throughExecute(project, type);
    let task = project.data();
    assert.equal(task.phase, "review");
    assert.equal(task.status, "open");
    assert.equal(task.workflow.review.status, "ready");
    assert.equal(task.workflow.review.inputSeq, task.history.at(-1)!.seq);
    assert.deepEqual(readDecisionFiles(project.dir()).map((file) => file.id), ["plan-1"], "execute の完了では判断記録を作らない");
    // (4)(5) 職務分離
    project.rejects({ kind: "claim", actor: "agent/claude" }, "WF_SEPARATION");
    project.rejects({ kind: "assign", phase: "review", assignee: "agent/claude", by: "human/saiki", reason: "交代" }, "WF_SEPARATION");
    // (6)(7) 別の AI の review
    submitReview(project);
    task = project.data();
    assert.equal(task.status, "pending");
    assert.equal(task.workflow.review.status, "done");
    assert.equal(task.workflow.review.approval, "review-1");
    assert.deepEqual(task.blockedBy, ["approval/review-1"]);
    assert.equal(project.decision("review-1").status, "open");
    assert.equal(project.decision("review-1").assignee, null, "approvers が無ければ未割当");
    project.consistent();
    // (8)(9) 承認で閉じる
    task = approve(project, "review-1");
    assert.equal(task.status, "closed");
    assert.equal(task.closureReason, "approved");
    assert.equal(task.phase, null);
    assert.equal(task.completedAt, "2026-10-01");
    assert.deepEqual(task.blockedBy, []);
    assert.equal(task.workflow.review.status, "done");
    assert.deepEqual(project.workLinks(), [], "closed の作業索引は 0 件");
    assert.deepEqual(project.queueLinks(), []);
    assert.deepEqual(task.history.map((entry) => `${entry.event}:${entry.phase}`), [
      "create:plan", "claim:plan", "complete:plan", "approve:plan", "claim:execute", "complete:execute", "claim:review", "complete:review", "approve:review",
    ]);
    project.consistent();
    // closed のタスクは工程の操作ができない
    project.rejects({ kind: "claim", actor: "agent/codex" }, "WF_CLOSED");
  }));
}

test("P-16-2 review の完了には記録の Markdown が、実装の実行の完了には対象の参照が必要", withProject((project) => {
  project.create("implementation");
  submitPlan(project);
  approve(project, "plan-1");
  project.write("02-handoff.md", handoff("実行"));
  project.run({ kind: "claim", actor: "agent/claude" });
  project.rejects({ kind: "complete", actor: "agent/claude", refs: [{ path: "02-handoff.md" }] }, "WF_TARGET");
  project.rejects({ kind: "complete", actor: "agent/claude", refs: [{ path: "absent.md" }, { repo: "project_template", commit: "873ca38" }] }, "WF_HANDOFF");
  project.run({ kind: "complete", actor: "agent/claude", refs: [{ path: "02-handoff.md" }, { repo: "project_template", commit: "873ca38" }] });
  project.run({ kind: "claim", actor: "agent/codex" });
  project.rejects({ kind: "complete", actor: "agent/codex", refs: [] }, "WF_REPORT");
  project.rejects({ kind: "complete", actor: "agent/codex", refs: [{ path: "none.md" }] }, "WF_REPORT");
  project.rejects({ kind: "complete", actor: "agent/claude", refs: [{ path: "02-handoff.md" }] }, "WF_NOT_ASSIGNEE");
}));

test("P-16-3 AI の担当は理由を付けて直接差し戻せ、人の承認を挟まない", withProject((project) => {
  project.create("implementation");
  submitPlan(project);
  approve(project, "plan-1");
  const planRecord = readFileSync(project.decisionPath("plan-1"));
  project.run({ kind: "claim", actor: "agent/claude" });
  // (8) 理由の無い・担当以外の差戻し
  project.rejects({ kind: "send-back", actor: "agent/claude", reason: " " }, "WF_REASON");
  project.rejects({ kind: "send-back", actor: "agent/codex", reason: "要件が矛盾" }, "WF_NOT_ASSIGNEE");
  project.rejects({ kind: "send-back", actor: "human/saiki", reason: "要件が矛盾" }, "WF_NOT_ASSIGNEE");
  // (2)(3) execute → plan は版 +1、plan は新しい試行で ready (担当は前の plan の担当)
  let task = project.run({ kind: "send-back", actor: "agent/claude", reason: "要件に矛盾がある" });
  assert.equal(task.requirementRevision, 2);
  assert.equal(task.phase, "plan");
  assert.equal(task.status, "open");
  assert.deepEqual([task.workflow.plan.status, task.workflow.plan.attempt, task.workflow.plan.assignee, task.workflow.plan.approval, task.workflow.plan.inputRevision], ["ready", 2, "agent/codex", null, 2]);
  assert.deepEqual([task.workflow.execute.status, task.workflow.execute.attempt], ["waiting", 2]);
  assert.deepEqual([task.workflow.review.status, task.workflow.review.attempt], ["waiting", 1]);
  assert.deepEqual(task.history.at(-1)!.event, "send_back");
  assert.equal(task.history.at(-1)!.to, "plan");
  // (4) 前の plan の完了と plan-1 (approved) は変わらない
  assert.deepEqual(readFileSync(project.decisionPath("plan-1")), planRecord);
  assert.ok(task.history.some((entry) => entry.event === "complete" && entry.phase === "plan" && entry.attempt === 1));
  project.consistent();
  // plan からは差し戻せない
  project.run({ kind: "claim", actor: "agent/codex" });
  project.rejects({ kind: "send-back", actor: "agent/codex", reason: "戻したい" }, "WF_PHASE");
  project.write("01-plan-2.md", handoff("計画 2"));
  project.run({ kind: "complete", actor: "agent/codex", refs: [{ path: "01-plan-2.md" }] });
  assert.equal(project.decision("plan-2").requirementRevision, 2);
  approve(project, "plan-2");
  project.write("02-handoff.md", handoff("実行"));
  project.run({ kind: "claim", actor: "agent/claude" });
  project.run({ kind: "complete", actor: "agent/claude", refs: [{ path: "02-handoff.md" }, { repo: "project_template", commit: "873ca38" }] });
  // (5)(6)(7) review → execute は版を保つ
  project.run({ kind: "claim", actor: "agent/codex" });
  task = project.run({ kind: "send-back", actor: "agent/codex", reason: "試験が足りない" });
  assert.equal(task.requirementRevision, 2);
  assert.equal(task.phase, "execute");
  assert.deepEqual([task.workflow.execute.status, task.workflow.execute.attempt, task.workflow.execute.assignee], ["ready", 3, "agent/claude"]);
  assert.equal(task.workflow.execute.inputSeq, task.history.find((entry) => entry.event === "complete" && entry.phase === "plan" && entry.attempt === 2)!.seq);
  assert.deepEqual([task.workflow.review.status, task.workflow.review.attempt], ["waiting", 2]);
  assert.equal(task.history.at(-1)!.to, "execute");
  project.consistent();
}));

test("P-16-4 人の見送りは理由を判断記録に残して戻し、再提出は新しい判断記録で受ける", withProject((project) => {
  project.create("research");
  submitPlan(project);
  project.run({ kind: "approval-claim", actor: "human/saiki", id: "plan-1" });
  // (9) 理由の無い見送り・plan 以外を指定した plan の見送り
  project.rejects({ kind: "reject", actor: "human/saiki", id: "plan-1", reason: "" }, "WF_REASON");
  project.rejects({ kind: "reject", actor: "human/saiki", id: "plan-1", reason: "曖昧", returnTo: "execute" }, "WF_USAGE");
  project.write("04-decision.md", "# 判断\n\n範囲が曖昧\n");
  project.rejects({ kind: "reject", actor: "human/saiki", id: "plan-1", reason: "曖昧", reportRefs: [{ path: "missing.md" }] }, "WF_REPORT");
  // (2)(3) plan の見送り: rejected・returnTo plan・理由、版 +1、plan は試行 2 で ready
  let task = project.run({ kind: "reject", actor: "human/saiki", id: "plan-1", reason: "対象の範囲が曖昧", reportRefs: [{ path: "04-decision.md" }] });
  let record = project.decision("plan-1");
  assert.deepEqual([record.status, record.outcome, record.returnTo, record.reason], ["rejected", "rejected", "plan", "対象の範囲が曖昧"]);
  assert.deepEqual(record.reportRefs, [{ path: "04-decision.md" }]);
  assert.equal(record.decisionSeq, task.history.at(-1)!.seq);
  assert.deepEqual(task.history.at(-1)!.refs, [{ path: "decisions/plan-1.md" }, { path: "04-decision.md" }]);
  assert.equal(task.requirementRevision, 2);
  assert.deepEqual([task.status, task.phase, task.workflow.plan.status, task.workflow.plan.attempt, task.workflow.plan.approval], ["open", "plan", "ready", 2, null]);
  assert.deepEqual(project.queueLinks(), []);
  assert.deepEqual(project.workLinks(), ["status/plan/ready/task-a"]);
  project.consistent();
  // (4)(5) 再提出は plan-2 (plan-1 は rejected のまま)
  const rejected = readFileSync(project.decisionPath("plan-1"));
  submitPlan(project, name, "agent/codex", "01-plan-2.md");
  assert.equal(project.decision("plan-2").status, "open");
  assert.equal(project.decision("plan-2").requirementRevision, 2);
  assert.deepEqual(readFileSync(project.decisionPath("plan-1")), rejected);
  approve(project, "plan-2");
  project.write("02-findings.md", handoff("実行"));
  project.run({ kind: "claim", actor: "agent/claude" });
  project.run({ kind: "complete", actor: "agent/claude", refs: [{ path: "02-findings.md" }] });
  submitReview(project);
  project.run({ kind: "approval-claim", actor: "human/saiki", id: "review-1" });
  // (9) review の見送りは戻す工程が必要
  project.rejects({ kind: "reject", actor: "human/saiki", id: "review-1", reason: "根拠が足りない" }, "WF_USAGE");
  // (7)(8) review → review: review だけ新しい試行、版は保つ
  task = project.run({ kind: "reject", actor: "human/saiki", id: "review-1", reason: "指摘の根拠が足りない", returnTo: "review" });
  assert.equal(task.requirementRevision, 2);
  assert.deepEqual([task.phase, task.workflow.review.status, task.workflow.review.attempt, task.workflow.review.assignee], ["review", "ready", 2, "agent/codex"]);
  assert.equal(task.workflow.execute.status, "done");
  assert.equal(task.workflow.review.inputSeq, task.history.find((entry) => entry.event === "complete" && entry.phase === "execute")!.seq);
  project.consistent();
  // review → execute: execute から新しい試行
  submitReview(project);
  project.run({ kind: "approval-claim", actor: "human/saiki", id: "review-2" });
  task = project.run({ kind: "reject", actor: "human/saiki", id: "review-2", reason: "調査が足りない", returnTo: "execute" });
  assert.equal(task.requirementRevision, 2);
  assert.deepEqual([task.phase, task.workflow.execute.status, task.workflow.execute.attempt, task.workflow.review.status, task.workflow.review.attempt], ["execute", "ready", 2, "waiting", 3]);
  project.consistent();
  // review → plan: 版 +1 で plan から
  project.run({ kind: "claim", actor: "agent/claude" });
  project.run({ kind: "complete", actor: "agent/claude", refs: [{ path: "02-findings.md" }] });
  submitReview(project);
  project.run({ kind: "approval-claim", actor: "human/saiki", id: "review-3" });
  task = project.run({ kind: "reject", actor: "human/saiki", id: "review-3", reason: "調査の目的から見直す", returnTo: "plan" });
  assert.equal(task.requirementRevision, 3);
  assert.deepEqual([task.phase, task.workflow.plan.status, task.workflow.plan.attempt], ["plan", "ready", 3]);
  record = project.decision("review-3");
  assert.equal(record.returnTo, "plan");
  project.consistent();
}));

test("P-16-5 確認待ちは未割当なら人が claim し、承認できるのは担当本人だけ。判断者の変更は本人か依頼元だけ", withProject((project) => {
  project.create("research");
  submitPlan(project);
  // (3)(4) 未割当の承認は WF_NOT_APPROVER
  project.rejects({ kind: "approve", actor: "human/saiki", id: "plan-1" }, "WF_NOT_APPROVER");
  // AI の claim・判断者の変更・承認・見送りは WF_HUMAN
  project.rejects({ kind: "approval-claim", actor: "agent/codex", id: "plan-1" }, "WF_HUMAN");
  // (5)(6) claim
  const beforeClaim = project.read();
  project.run({ kind: "approval-claim", actor: "human/saiki", id: "plan-1" });
  assert.equal(project.decision("plan-1").assignee, "human/saiki");
  assert.equal(project.read(), beforeClaim, "claim ではタスクと作業索引を変えない");
  project.rejects({ kind: "approval-claim", actor: "human/other", id: "plan-1" }, "WF_NOT_APPROVER");
  project.rejects({ kind: "approval-assign", actor: "agent/codex", id: "plan-1", to: "human/other", reason: "交代" }, "WF_HUMAN");
  project.rejects({ kind: "approve", actor: "agent/codex", id: "plan-1" }, "WF_HUMAN");
  project.rejects({ kind: "reject", actor: "agent/codex", id: "plan-1", reason: "だめ" }, "WF_HUMAN");
  // (7)(8) 判断者でも依頼元でもない人は替えられず、承認もできない
  project.rejects({ kind: "approval-assign", actor: "human/other", id: "plan-1", to: "human/other", reason: "代わる" }, "WF_NOT_APPROVER");
  project.rejects({ kind: "approve", actor: "human/other", id: "plan-1" }, "WF_NOT_APPROVER");
  // (9)(10) 理由の無い変更は拒否、理由のある変更は履歴に残り、以後は新しい判断者だけ
  project.rejects({ kind: "approval-assign", actor: "human/saiki", id: "plan-1", to: "human/other", reason: " " }, "WF_REASON");
  project.rejects({ kind: "approval-assign", actor: "human/saiki", id: "plan-1", to: "agent/codex", reason: "AI へ" }, "WF_HUMAN");
  project.rejects({ kind: "approval-assign", actor: "human/saiki", id: "plan-1", to: "human/saiki", reason: "同じ" }, "WF_NOOP");
  project.run({ kind: "approval-assign", actor: "human/saiki", id: "plan-1", to: "human/other", reason: "不在のため交代" });
  const record = project.decision("plan-1");
  assert.equal(record.assignee, "human/other");
  assert.deepEqual(record.history.at(-1), { ...record.history.at(-1), event: "assign", actor: "human/saiki", from: "human/saiki", to: "human/other", reason: "不在のため交代" });
  project.rejects({ kind: "approve", actor: "human/saiki", id: "plan-1" }, "WF_NOT_APPROVER");
  // (11) 依頼元の人は理由を付けて替えられる (未割当にも戻せる)
  project.run({ kind: "approval-assign", actor: "human/saiki", id: "plan-1", to: null, reason: "依頼元として担当を外す" });
  assert.equal(project.decision("plan-1").assignee, null);
  project.run({ kind: "approval-claim", actor: "human/third", id: "plan-1" });
  const task = project.run({ kind: "approve", actor: "human/third", id: "plan-1" });
  assert.equal(task.workflow.execute.status, "ready");
  project.consistent();
}));

test("P-16-5 依頼元が AI なら、判断者本人以外は判断者を替えられない", withProject((project) => {
  project.create("research", { requestedBy: "agent/codex", approvers: { plan: "human/saiki" } });
  submitPlan(project);
  project.rejects({ kind: "approval-assign", actor: "human/other", id: "plan-1", to: "human/other", reason: "代わる" }, "WF_NOT_APPROVER");
  project.run({ kind: "approval-assign", actor: "human/saiki", id: "plan-1", to: "human/other", reason: "交代" });
  project.consistent();
}));

test("P-16-6 人の revise は確認待ちの記録を superseded にして plan からやり直し、closed の reopen は閉じた記録を変えない", withProject((project) => {
  project.create("implementation");
  submitPlan(project);
  project.rejects({ kind: "revise", actor: "agent/codex", reason: "要件の変更" }, "WF_HUMAN");
  project.rejects({ kind: "revise", actor: "human/saiki", reason: "" }, "WF_REASON");
  let task = project.run({ kind: "revise", actor: "human/saiki", reason: "対象を追加" });
  const record = project.decision("plan-1");
  assert.equal(record.status, "superseded");
  assert.match(record.reason!, /要件の変更 \(revise\) で無効化: 対象を追加/);
  assert.equal(record.decisionSeq, task.history.at(-1)!.seq);
  assert.deepEqual(task.history.slice(-2).map((entry) => entry.event), ["revise", "supersede"]);
  assert.equal(task.requirementRevision, 2);
  assert.deepEqual([task.status, task.phase, task.workflow.plan.status, task.workflow.plan.attempt, task.workflow.plan.approval], ["open", "plan", "ready", 2, null]);
  assert.deepEqual(project.queueLinks(), []);
  project.consistent();
  // superseded の記録は承認できない
  project.rejects({ kind: "approve", actor: "human/saiki", id: "plan-1" }, "WF_APPROVAL_CLOSED");
  // open のタスクの revise (作業中の execute から plan へ)
  submitPlan(project, name, "agent/codex", "01-plan-2.md");
  approve(project, "plan-2");
  project.run({ kind: "claim", actor: "agent/claude" });
  task = project.run({ kind: "revise", actor: "human/saiki", reason: "仕様が変わった" });
  assert.equal(task.requirementRevision, 3);
  assert.deepEqual([task.phase, task.workflow.plan.attempt, task.workflow.execute.status, task.workflow.execute.attempt], ["plan", 3, "waiting", 2]);
  assert.equal(project.decision("plan-2").status, "approved", "承認で閉じた記録は無効化しない");
  project.consistent();
  // closed の reopen
  submitPlan(project, name, "agent/codex", "01-plan-3.md");
  approve(project, "plan-3");
  project.write("02-handoff.md", handoff("実行"));
  project.run({ kind: "claim", actor: "agent/claude" });
  project.run({ kind: "complete", actor: "agent/claude", refs: [{ path: "02-handoff.md" }, { repo: "project_template", commit: "873ca38" }] });
  submitReview(project);
  approve(project, "review-1");
  assert.equal(project.data().status, "closed");
  const closedRecords = Object.fromEntries(readDecisionFiles(project.dir()).map((file) => [file.id, file.bytes!.toString("utf8")]));
  project.rejects({ kind: "reopen", actor: "agent/codex", returnTo: "review", reason: "見直し" }, "WF_HUMAN");
  project.rejects({ kind: "reopen", actor: "human/saiki", returnTo: "review", reason: "" }, "WF_REASON");
  project.rejects({ kind: "revise", actor: "human/saiki", reason: "閉じた後の変更" }, "WF_CLOSED");
  task = project.run({ kind: "reopen", actor: "human/saiki", returnTo: "review", reason: "レビューの観点を追加" });
  assert.equal(task.requirementRevision, 3);
  assert.deepEqual([task.status, task.phase, task.workflow.review.status, task.workflow.review.attempt, task.closureReason, task.completedAt], ["open", "review", "ready", 2, null, null]);
  assert.deepEqual(Object.fromEntries(readDecisionFiles(project.dir()).map((file) => [file.id, file.bytes!.toString("utf8")])), closedRecords, "閉じた記録は変えない");
  project.consistent();
  project.rejects({ kind: "reopen", actor: "human/saiki", returnTo: "plan", reason: "open のタスク" }, "WF_STATE");
  // plan から開き直すと版 +1
  submitReview(project);
  approve(project, "review-2");
  task = project.run({ kind: "reopen", actor: "human/saiki", returnTo: "plan", reason: "要件から見直す" });
  assert.equal(task.requirementRevision, 4);
  assert.deepEqual([task.phase, task.workflow.plan.attempt, task.workflow.execute.attempt, task.workflow.review.attempt], ["plan", 4, 3, 3]);
  project.consistent();
}));

test("P-16-7 人の確認待ちの間は提出した工程・後の工程の操作を拒否し、外部の待ちは resume してから完了する", withProject((project) => {
  project.create("research");
  project.write("01-plan.md", handoff("計画"));
  project.run({ kind: "claim", actor: "agent/codex" });
  // 外部の待ち (工程の pending)
  project.rejects({ kind: "block", actor: "agent/codex", blockedBy: ["approval/plan-1"] }, "WF_BLOCKED_BY");
  project.run({ kind: "block", actor: "agent/codex", blockedBy: ["other: 権限の確保"] });
  assert.deepEqual(project.workLinks(), ["status/plan/pending/task-a"]);
  project.rejects({ kind: "complete", actor: "agent/codex", refs: [{ path: "01-plan.md" }] }, "WF_STATE");
  project.run({ kind: "resume", actor: "agent/codex" });
  project.run({ kind: "complete", actor: "agent/codex", refs: [{ path: "01-plan.md" }] });
  // 人の確認待ち (タスクの pending)
  project.rejects({ kind: "block", actor: "agent/codex", blockedBy: ["qa/Q-001"] }, "WF_STATE");
  project.rejects({ kind: "assign", phase: "plan", assignee: "agent/claude", by: "human/saiki", reason: "交代" }, "WF_STATE");
  project.rejects({ kind: "assign", phase: "execute", assignee: "agent/claude", by: "human/saiki", reason: "先に決める" }, "WF_STATE");
  project.rejects({ kind: "complete", actor: "agent/codex", refs: [{ path: "01-plan.md" }] }, "WF_STATE");
  project.rejects({ kind: "send-back", actor: "agent/codex", reason: "戻す" }, "WF_STATE");
  project.rejects({ kind: "claim", actor: "agent/claude" }, "WF_STATE");
  project.rejects({ kind: "resume", actor: "agent/codex" }, "WF_STATE");
  project.rejects({ kind: "reopen", actor: "human/saiki", returnTo: "plan", reason: "やり直し" }, "WF_STATE");
  const task = project.data();
  assert.equal(validateTaskV4(task).length, 0);
  project.consistent();
}));

test("P-16-7 古い判断記録・古い revision・読んだ後の変更は何も変えずに拒否し、自動で送り直さない", withProject((project) => {
  project.create("research");
  submitPlan(project);
  const oldTask = taskRevision(project.index());
  const oldRecord = decisionRevision(project.decisionPath("plan-1"));
  project.run({ kind: "approval-claim", actor: "human/saiki", id: "plan-1" });
  // 読んだ後に判断記録が変わった
  project.rejects({ kind: "approve", actor: "human/saiki", id: "plan-1" }, "REVISION_CONFLICT", { match: { ifMatch: oldTask, recordMatch: oldRecord } });
  // revision の指定が無い
  project.rejects({ kind: "approve", actor: "human/saiki", id: "plan-1" }, "RECORD_MATCH_REQUIRED", { match: { ifMatch: oldTask } });
  project.rejects({ kind: "approve", actor: "human/saiki", id: "plan-1" }, "REVISION_REQUIRED", { match: { ifMatch: undefined, recordMatch: oldRecord } });
  project.rejects({ kind: "approve", actor: "human/saiki", id: "plan-9" }, "APPROVAL_NOT_FOUND", { match: { ifMatch: oldTask, recordMatch: oldRecord } });
  // 見送った記録は閉じている。再提出の後も古い記録は承認できない
  project.run({ kind: "reject", actor: "human/saiki", id: "plan-1", reason: "やり直し" });
  submitPlan(project, name, "agent/codex", "01-plan-2.md");
  project.rejects({ kind: "approve", actor: "human/saiki", id: "plan-1" }, "WF_APPROVAL_CLOSED");
  // 読んだ後にタスクが変わった (plan-2 の claim の前のタスクの revision で承認しようとする)
  const beforeClaim = taskRevision(project.index());
  project.run({ kind: "approval-claim", actor: "human/saiki", id: "plan-2" });
  project.run({ kind: "approval-assign", actor: "human/saiki", id: "plan-2", to: "human/other", reason: "交代" });
  project.rejects({ kind: "approve", actor: "human/other", id: "plan-2" }, "REVISION_CONFLICT", { match: { ifMatch: "0".repeat(64), recordMatch: decisionRevision(project.decisionPath("plan-2")) } });
  assert.equal(taskRevision(project.index()), beforeClaim, "判断記録の claim・assign ではタスクの revision は変わらない");
  // 要件の版が合わない記録 (タスクが指していても) は STALE
  const text = readFileSync(project.decisionPath("plan-2"), "utf8");
  writeFileSync(project.decisionPath("plan-2"), text.replace("requirementRevision: 2", "requirementRevision: 1"));
  project.rejects({ kind: "approve", actor: "human/other", id: "plan-2" }, "WF_APPROVAL_STALE");
  project.rejects({ kind: "revise", actor: "human/saiki", reason: "変更" }, "WF_INVALID");
  writeFileSync(project.decisionPath("plan-2"), text);
  // タスクが指していない open の記録 (途中で失敗した操作の残りなど) は承認できない
  const orphan = readFileSync(project.decisionPath("plan-2"), "utf8").replaceAll("plan-2", "review-1").replace("phase: plan", "phase: review").replace("attempt: 2", "attempt: 1");
  writeFileSync(project.decisionPath("review-1"), orphan);
  project.rejects({ kind: "approve", actor: "human/other", id: "review-1" }, "WF_APPROVAL_STALE");
  project.rejects({ kind: "approve", actor: "human/other", id: "plan-2" }, "WF_INVALID");
  unlinkSync(project.decisionPath("review-1"));
  const task = project.run({ kind: "approve", actor: "human/other", id: "plan-2" });
  assert.equal(task.workflow.execute.status, "ready");
  project.consistent();
}));

test("P-16-7 v2・v3・旧形式のタスクには v4 の操作をできず、移行を案内する", withProject((project) => {
  const v3 = initialTaskV3({ id: "T-002", type: "research", date: "2026-10-01", at: "2026-10-01T00:00:00Z", requestedBy: "human/saiki", createdBy: "agent/codex" });
  const frontmatter = YamlFrontmatter.parse(`---\n---\n${body}`);
  for (const [key, value] of Object.entries(v3)) frontmatter.set([key], value);
  mkdirSync(project.dir("task-v3"), { recursive: true });
  writeFileSync(project.index("task-v3"), frontmatter.toString());
  const error = project.rejects({ kind: "claim", actor: "agent/codex" }, "WF_NOT_V4", { task: "task-v3" });
  assert.match(error.message, /workflowVersion 4 へ移行/);
  project.write("index.md", "---\nid: T-003\nstatus: todo\ncreatedAt: 2026-10-01\nupdatedAt: 2026-10-01\ncompletedAt:\nblockedBy: []\n---\n", "task-legacy");
  project.rejects({ kind: "claim", actor: "agent/codex" }, "WF_NOT_V4", { task: "task-legacy" });
  // v3 のサービスは v4 のタスクを扱わない (T-013 の規則のまま)
  project.create("research", { task: "task-v4", id: "T-004" });
  assert.throws(() => runTransition(project.root, job, "task-v4", taskRevision(project.index("task-v4")), { kind: "claim", actor: "agent/codex" }), (caught: unknown) => caught instanceof CliError && caught.code === "WF_VERSION");
}));

// ---- 移行した記録 (T-020 の R20-1〜R20-3 の回帰) ----------------------------------------------------------------------

// 移行 (migrate) と同じ日時の時計 (R20-3: 同時刻の出来事は seq で区別する)
const migrateClock: Clock = { date: "2026-10-06", at: "2026-10-06T01:00:00Z" };

test("P-16-10 受入確認の途中で移行した review-1 は、移行と同時刻でも依頼元が判断者を替えて新しい判断者が承認でき、判断記録に approve の履歴が残る", withProject((project) => {
  project.importScene("research-migrated-acceptance-progress");
  project.consistent(name, true);
  // R20-1: 判断者でも依頼元でもない人は替えられず、承認もできない
  project.rejects({ kind: "approval-assign", actor: "human/other", id: "review-1", to: "human/other", reason: "代わる" }, "WF_NOT_APPROVER", { clock: migrateClock });
  project.rejects({ kind: "approve", actor: "human/other", id: "review-1" }, "WF_NOT_APPROVER", { clock: migrateClock });
  project.run({ kind: "approval-assign", actor: "human/saiki", id: "review-1", to: "human/next", reason: "受入確認の担当を交代" }, { clock: migrateClock });
  project.rejects({ kind: "approve", actor: "human/saiki", id: "review-1" }, "WF_NOT_APPROVER", { clock: migrateClock });
  const task = project.run({ kind: "approve", actor: "human/next", id: "review-1" }, { clock: migrateClock });
  assert.equal(task.status, "closed");
  assert.equal(task.closureReason, "approved");
  const record = project.decision("review-1");
  assert.deepEqual(record.history.map((entry) => entry.event), ["import", "assign", "approve"], "移行後の承認は判断記録にも approve の履歴を持つ");
  assert.equal(record.decidedAt, "2026-10-06T01:00:00Z");
  assert.ok(record.decisionSeq! > task.history.find((entry) => entry.event === "migrate")!.seq, "判断の seq は migrate より後");
  project.consistent(name, true);
}));

test("P-16-10 受入確認の途中で移行した review-1 は、移行と同時刻でも見送れ、戻す工程から新しい試行になる", withProject((project) => {
  project.importScene("research-migrated-acceptance-progress");
  const task = project.run({ kind: "reject", actor: "human/saiki", id: "review-1", reason: "調査をやり直す", returnTo: "execute" }, { clock: migrateClock });
  assert.deepEqual([task.status, task.phase, task.workflow.execute.status, task.workflow.execute.attempt], ["open", "execute", "ready", 2]);
  assert.deepEqual(project.decision("review-1").history.map((entry) => entry.event), ["import", "reject"]);
  project.consistent(name, true);
}));

test("P-16-10 移行元で承認済みの review-1 には claim・判断者の変更・承認を追記できず (R20-2)、reopen でも閉じた記録は変わらない", withProject((project) => {
  project.importScene("implementation-migrated-closed-accepted");
  project.consistent(name, true);
  const record = readFileSync(project.decisionPath("review-1"));
  project.rejects({ kind: "approval-claim", actor: "human/other", id: "review-1" }, "WF_APPROVAL_CLOSED", { clock: migrateClock });
  project.rejects({ kind: "approval-assign", actor: "human/saiki", id: "review-1", to: "human/other", reason: "交代" }, "WF_APPROVAL_CLOSED", { clock: migrateClock });
  project.rejects({ kind: "approve", actor: "human/saiki", id: "review-1" }, "WF_APPROVAL_CLOSED", { clock: migrateClock });
  const task = project.run({ kind: "reopen", actor: "human/saiki", returnTo: "review", reason: "移行後に見直す" }, { clock: migrateClock });
  assert.deepEqual([task.status, task.phase, task.workflow.review.attempt], ["open", "review", 2]);
  assert.deepEqual(readFileSync(project.decisionPath("review-1")), record);
  project.consistent(name, true);
}));

test("P-16-10 planApproval require で移行した plan-1 は、人が claim して承認すると execute が移行元の提出を入力に ready になる", withProject((project) => {
  project.importScene("implementation-migrated-plan-require");
  project.rejects({ kind: "approve", actor: "human/saiki", id: "plan-1" }, "WF_NOT_APPROVER", { clock: migrateClock });
  project.run({ kind: "approval-claim", actor: "human/saiki", id: "plan-1" }, { clock: migrateClock });
  const task = project.run({ kind: "approve", actor: "human/saiki", id: "plan-1" }, { clock: migrateClock });
  assert.deepEqual([task.status, task.phase, task.workflow.execute.status, task.workflow.execute.inputSeq], ["open", "execute", "ready", 2]);
  assert.deepEqual(project.decision("plan-1").history.map((entry) => entry.event), ["import", "claim", "approve"]);
  project.consistent(name, true);
}));

// ---- 一体更新・失敗の注入・同時操作・異常終了 -------------------------------------------------------------------------

const methods: (keyof OpsFs)[] = ["writeJournal", "writeTemp", "linkNew", "rename", "unlink", "symlink", "removeJournal"];

// 呼び出しを数え、n 回目で失敗する fs (n が 0 なら数えるだけ)
function counting(fail?: { method: keyof OpsFs; nth: number }): { fs: OpsFs; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  const fs = Object.fromEntries(
    methods.map((method) => [
      method,
      (...args: unknown[]) => {
        counts[method] = (counts[method] ?? 0) + 1;
        if (fail && fail.method === method && counts[method] === fail.nth) throw Object.assign(new Error(`注入した失敗: ${method} #${fail.nth}`), { code: "EIO" });
        (defaultOpsFs[method] as (...values: unknown[]) => void)(...args);
      },
    ]),
  ) as unknown as OpsFs;
  return { fs, counts };
}

// 操作が呼ぶ fs の回数を、案件の複製で数える
function countCalls(project: Project, operation: OperationV4): Record<string, number> {
  const clone = mkdtempSync(join(tmpdir(), "raprid-taskflow-v4-count-"));
  try {
    cpSync(project.root, clone, { recursive: true, verbatimSymlinks: true });
    const { fs, counts } = counting();
    runTransitionV4(clone, job, name, project.match(operation), operation, { clock: project.clock(), fs });
    return counts;
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
}

// 操作が呼ぶすべての fs の呼び出しで 1 回ずつ失敗させ、どれでも何も変わらないことを確かめる。最後に失敗させずに実行する
function injectEverywhere(project: Project, operation: OperationV4, expectJournal: boolean): number {
  const counts = countCalls(project, operation);
  assert.equal((counts.writeJournal ?? 0) > 0, expectJournal, `${operation.kind}: journal を${expectJournal ? "書く" : "書かない"}`);
  let injected = 0;
  for (const method of methods) {
    if (method === "removeJournal") continue; // 書き込みの後の片付け (失敗しても操作は成功し、次の復旧で消える)
    for (let nth = 1; nth <= (counts[method] ?? 0); nth++) {
      const before = project.state();
      const { fs } = counting({ method, nth });
      assert.throws(() => project.run(operation, { fs }), `${operation.kind}: ${method} #${nth} で失敗する`);
      assert.deepEqual(project.state(), before, `${operation.kind} の ${method} #${nth} で失敗したら、この操作で変えたものが戻る`);
      injected += 1;
    }
  }
  project.run(operation);
  project.consistent();
  return injected;
}

test("P-16-8 提出・承認・見送り・判断者の変更・revise の途中で失敗すると、この操作で変えたもの (判断記録・作業索引・確認待ちの索引・タスク・journal) が戻る", withProject((project) => {
  project.create("research");
  project.write("01-plan.md", handoff("計画"));
  project.run({ kind: "claim", actor: "agent/codex" });
  let injected = injectEverywhere(project, { kind: "complete", actor: "agent/codex", refs: [{ path: "01-plan.md" }] }, true);
  injected += injectEverywhere(project, { kind: "approval-claim", actor: "human/saiki", id: "plan-1" }, false);
  injected += injectEverywhere(project, { kind: "approval-assign", actor: "human/saiki", id: "plan-1", to: "human/other", reason: "交代" }, false);
  injected += injectEverywhere(project, { kind: "reject", actor: "human/other", id: "plan-1", reason: "見送り" }, false);
  submitPlan(project, name, "agent/codex", "01-plan-2.md");
  injected += injectEverywhere(project, { kind: "revise", actor: "human/saiki", reason: "変更" }, false);
  submitPlan(project, name, "agent/codex", "01-plan-3.md");
  project.run({ kind: "approval-claim", actor: "human/saiki", id: "plan-3" });
  injected += injectEverywhere(project, { kind: "approve", actor: "human/saiki", id: "plan-3" }, false);
  project.write("02-findings.md", handoff("実行"));
  project.run({ kind: "claim", actor: "agent/claude" });
  injected += injectEverywhere(project, { kind: "complete", actor: "agent/claude", refs: [{ path: "02-findings.md" }] }, false);
  submitReview(project);
  project.run({ kind: "approval-claim", actor: "human/saiki", id: "review-1" });
  injected += injectEverywhere(project, { kind: "approve", actor: "human/saiki", id: "review-1" }, false);
  assert.equal(project.data().status, "closed");
  assert.ok(injected >= 30, `注入した失敗: ${injected}`);
}));

test("P-16-8 書き込みの後の journal の片付けに失敗しても操作は成功し、次の操作の復旧で journal だけが消える", withProject((project) => {
  project.create("research");
  project.write("01-plan.md", handoff("計画"));
  project.run({ kind: "claim", actor: "agent/codex" });
  const { fs } = counting({ method: "removeJournal", nth: 1 });
  const task = project.run({ kind: "complete", actor: "agent/codex", refs: [{ path: "01-plan.md" }] }, { fs });
  assert.equal(task.status, "pending");
  assert.equal(pendingJournals(project.jobDir).length, 1);
  project.run({ kind: "approval-claim", actor: "human/saiki", id: "plan-1" });
  assert.deepEqual(pendingJournals(project.jobDir), []);
  project.consistent();
}));

// 子プロセスで操作する。crash を指定すると、その呼び出しの前 (after なら後) で異常終了する (finally も走らない)
const runner = `
const { runTransitionV4, defaultOpsFs } = await import(process.env.TASKFLOW_V4);
const [root, job, task, input] = process.argv.slice(1);
const { operation, match, crash, clock } = JSON.parse(input);
const fs = { ...defaultOpsFs };
if (crash) {
  let count = 0;
  const original = defaultOpsFs[crash.method];
  fs[crash.method] = (...args) => {
    count += 1;
    if (count === crash.nth) {
      if (crash.after) original(...args);
      process.exit(137);
    }
    return original(...args);
  };
}
try {
  const result = runTransitionV4(root, job, task, match, operation, { fs, clock });
  process.stdout.write(JSON.stringify({ ok: true, revision: result.revision }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }));
}
`;

interface ChildResult {
  status: number | null;
  ok?: boolean;
  code?: string;
  message?: string;
}

type Crash = { method: keyof OpsFs; nth: number; after?: boolean };

function childArgs(project: Project, operation: OperationV4, crash?: Crash, task = name): string[] {
  const input = JSON.stringify({ operation, match: project.match(operation, task), crash, clock: project.clock() });
  return ["--input-type=module", "-e", runner, project.root, job, task, input];
}

const childEnv = () => ({ ...process.env, TASKFLOW_V4: taskflowV4Path });

function runChild(project: Project, operation: OperationV4, crash?: Crash, task = name): ChildResult {
  const result = spawnSync(process.execPath, childArgs(project, operation, crash, task), { env: childEnv(), encoding: "utf8" });
  return { status: result.status, ...(result.stdout ? JSON.parse(result.stdout) : {}) };
}

function runChildAsync(args: string[]): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: childEnv() });
    let stdout = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, ...(stdout ? JSON.parse(stdout) : {}) }));
  });
}

test("P-16-8 2 人が同時に claim・承認すると一方だけが成功し、もう一方は REVISION_CONFLICT で何も変えない", withProject(async (project) => {
  project.create("research");
  submitPlan(project);
  const claimed = await Promise.all(["human/saiki", "human/other"].map((actor) => runChildAsync(childArgs(project, { kind: "approval-claim", actor, id: "plan-1" }))));
  assert.deepEqual(claimed.map((result) => result.ok).sort(), [false, true], JSON.stringify(claimed));
  assert.equal(claimed.find((result) => !result.ok)!.code, "REVISION_CONFLICT");
  const record = project.decision("plan-1");
  assert.equal(record.history.filter((entry) => entry.event === "claim").length, 1, "claim は 1 件だけ");
  const approver = record.assignee!;
  const approved = await Promise.all([0, 1].map(() => runChildAsync(childArgs(project, { kind: "approve", actor: approver, id: "plan-1" }))));
  assert.deepEqual(approved.map((result) => result.ok).sort(), [false, true], JSON.stringify(approved));
  assert.equal(approved.find((result) => !result.ok)!.code, "REVISION_CONFLICT");
  assert.equal(project.data().history.filter((entry) => entry.event === "approve").length, 1, "二重に承認しない");
  project.consistent();
}));

// plan を progress にし、提出の途中で異常終了させる
function crashSubmit(project: Project, crash: Crash): { revision: string; before: Record<string, string> } {
  project.create("research");
  project.create("research", { task: "task-b", id: "T-002" });
  project.write("01-plan.md", handoff("計画"));
  project.run({ kind: "claim", actor: "agent/codex" });
  const before = project.state();
  const revision = taskRevision(project.index());
  const crashed = runChild(project, { kind: "complete", actor: "agent/codex", refs: [{ path: "01-plan.md" }] }, crash);
  assert.equal(crashed.status, 137, JSON.stringify(crashed));
  assert.equal(pendingJournals(project.jobDir).length, 1, "異常終了で journal が残る");
  return { revision, before };
}

// 異常終了の後、別のタスク (task-b) の書き込みの操作で復旧する
function nextWrite(project: Project): void {
  project.run({ kind: "claim", actor: "agent/claude" }, { task: "task-b" });
}

test("P-16-9 journal と判断記録を書いた後・索引を変える前に異常終了したら、次の書き込みの操作で判断記録が消え、前からある作業索引は残る", withProject((project) => {
  const { revision } = crashSubmit(project, { method: "unlink", nth: 1 });
  assert.ok(existsSync(project.decisionPath("plan-1")), "判断記録は書かれている");
  assert.deepEqual(project.workLinks(), ["status/plan/progress/task-a"]);
  nextWrite(project);
  assert.ok(!existsSync(project.decisionPath("plan-1")), "journal の内容のままの判断記録は消える");
  assert.deepEqual(project.workLinks(), ["status/plan/progress/task-a"], "操作の前からある作業索引は残る");
  assert.deepEqual(project.queueLinks(), []);
  assert.equal(taskRevision(project.index()), revision, "タスクは plan progress のまま");
  assert.deepEqual(pendingJournals(project.jobDir), [], "journal は消える");
  project.consistent();
  // もう一度提出できる
  project.run({ kind: "complete", actor: "agent/codex", refs: [{ path: "01-plan.md" }] });
  project.consistent();
}));

test("P-16-9 索引を変えた後・タスクを書く前に異常終了したら、索引は前の状態に戻り、判断記録と journal は消える", withProject((project) => {
  const { revision } = crashSubmit(project, { method: "rename", nth: 1 });
  assert.deepEqual(project.workLinks(), ["status/approval/plan/task-a"], "索引は変えた後");
  assert.deepEqual(project.queueLinks(), ["task-a--plan-1"]);
  nextWrite(project);
  assert.deepEqual(project.workLinks(), ["status/plan/progress/task-a"], "外した作業索引は作り直される");
  assert.deepEqual(project.queueLinks(), [], "新しく作った確認待ちの索引は消える");
  assert.ok(!lstatOrNull(join(project.jobDir, "status", "approval", "plan", name)), "新しく作った作業索引は消える");
  assert.ok(!existsSync(project.decisionPath("plan-1")));
  assert.equal(taskRevision(project.index()), revision);
  project.consistent();
}));

test("P-16-9 索引を変える途中で異常終了しても、journal の前の状態に戻る", withProject((project) => {
  const { revision } = crashSubmit(project, { method: "symlink", nth: 1 });
  assert.deepEqual(project.workLinks(), [], "外した作業索引だけが無い");
  nextWrite(project);
  assert.deepEqual(project.workLinks(), ["status/plan/progress/task-a"]);
  assert.ok(!existsSync(project.decisionPath("plan-1")));
  assert.equal(taskRevision(project.index()), revision);
  project.consistent();
}));

test("P-16-9 タスクを書いた後・journal を消す前に異常終了したら、何も戻さず journal だけが消える", withProject((project) => {
  crashSubmit(project, { method: "removeJournal", nth: 1 });
  const task = project.data();
  assert.equal(task.status, "pending");
  const decision = readFileSync(project.decisionPath("plan-1"));
  nextWrite(project);
  assert.equal(project.data().status, "pending", "タスクは plan の確認待ちのまま");
  assert.deepEqual(readFileSync(project.decisionPath("plan-1")), decision);
  assert.deepEqual(project.workLinks(), ["status/approval/plan/task-a"]);
  assert.deepEqual(project.queueLinks(), ["task-a--plan-1"]);
  project.consistent();
}));

test("P-16-9 異常終了の後に判断記録・索引・タスクのどれかが変わっていたら、何も消さず戻さずに WF_APPROVAL_ORPHAN で止まる", withProject((project) => {
  crashSubmit(project, { method: "rename", nth: 1 });
  const decision = readFileSync(project.decisionPath("plan-1"), "utf8");
  const queue = join(project.jobDir, "approvals", "open", "task-a--plan-1");
  const tampers: { label: string; apply: () => void; undo: () => void }[] = [
    { label: "判断記録への追記", apply: () => writeFileSync(project.decisionPath("plan-1"), `${decision}\n人のメモ\n`), undo: () => writeFileSync(project.decisionPath("plan-1"), decision) },
    { label: "索引の変更", apply: () => (unlinkSync(queue), symlinkSync("../../tasks/task-a/decisions/plan-9.md", queue)), undo: () => (unlinkSync(queue), symlinkSync("../../tasks/task-a/decisions/plan-1.md", queue)) },
    { label: "索引をリンク以外に", apply: () => (unlinkSync(queue), writeFileSync(queue, "x")), undo: () => (unlinkSync(queue), symlinkSync("../../tasks/task-a/decisions/plan-1.md", queue)) },
  ];
  const text = project.read();
  tampers.push({ label: "タスクの変更", apply: () => writeFileSync(project.index(), `${text}追記\n`), undo: () => writeFileSync(project.index(), text) });
  for (const tamper of tampers) {
    tamper.apply();
    const error = project.rejects({ kind: "claim", actor: "agent/claude" }, "WF_APPROVAL_ORPHAN", { task: "task-b" });
    assert.match(error.message, /journal/, tamper.label);
    assert.equal(pendingJournals(project.jobDir).length, 1, `${tamper.label}: journal は残る`);
    tamper.undo();
  }
  // 壊れた journal も消さずに止まる
  const journal = pendingJournals(project.jobDir)[0];
  const saved = readFileSync(journal, "utf8");
  writeFileSync(journal, "{");
  project.rejects({ kind: "claim", actor: "agent/claude" }, "WF_APPROVAL_ORPHAN", { task: "task-b" });
  writeFileSync(journal, saved);
  // 元に戻れば復旧できる
  nextWrite(project);
  project.consistent();
}));

test("P-16-9 同じ ID の判断記録が既にある提出は、復旧で消せたとき以外は WF_APPROVAL_CONFLICT で止まり、既存の記録を上書きしない", withProject((project) => {
  project.create("research");
  project.write("01-plan.md", handoff("計画"));
  project.run({ kind: "claim", actor: "agent/codex" });
  project.write("decisions/plan-1.md", "---\nid: plan-1\n---\n\n人が置いた記録\n");
  project.rejects({ kind: "complete", actor: "agent/codex", refs: [{ path: "01-plan.md" }] }, "WF_APPROVAL_CONFLICT");
  assert.equal(readFileSync(project.decisionPath("plan-1"), "utf8"), "---\nid: plan-1\n---\n\n人が置いた記録\n");
  // 読めない記録があるタスクは他の操作も止まる (要確認)
  project.rejects({ kind: "block", actor: "agent/codex", blockedBy: ["other: 待ち"] }, "WF_INVALID");
  // decisions/ や .raprid-ops/ がリンクなら辿らずに止まる (タスクの外へ書かない・journal を見落とさない)
  rmSync(join(project.dir(), "decisions"), { recursive: true });
  const outside = mkdtempSync(join(tmpdir(), "raprid-outside-"));
  try {
    symlinkSync(outside, join(project.dir(), "decisions"));
    project.rejects({ kind: "complete", actor: "agent/codex", refs: [{ path: "01-plan.md" }] }, "WF_INVALID");
    unlinkSync(join(project.dir(), "decisions"));
    symlinkSync(outside, join(project.jobDir, ".raprid-ops"));
    project.rejects({ kind: "complete", actor: "agent/codex", refs: [{ path: "01-plan.md" }] }, "WF_INVALID");
    assert.deepEqual(readdirSync(outside), [], "外のディレクトリには何も書かない");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}));

// ---- R21-1: 復旧の対象の親ディレクトリ・パス種別を、削除・作り直しの前に案件のすべての journal について確かめる ----------

// 案件の中のディレクトリ (またはファイル) rel を案件の外へ移し、元の場所をそこへのリンクにする。戻す関数を返す
function linkOut(project: Project, rel: string): { outside: string; undo: () => void } {
  const outside = mkdtempSync(join(tmpdir(), "raprid-outside-"));
  const moved = join(outside, "moved");
  const path = join(project.jobDir, rel);
  renameSync(path, moved);
  symlinkSync(moved, path);
  return {
    outside,
    undo: () => {
      unlinkSync(path);
      renameSync(moved, path);
      rmSync(outside, { recursive: true, force: true });
    },
  };
}

const submitOperation: OperationV4 = { kind: "complete", actor: "agent/codex", refs: [{ path: "01-plan.md" }] };

// 異常終了の時点ごとに、journal の対象 (判断記録・タスク・作業索引・確認待ちの索引) の親になりうるディレクトリ
const parentCases: { crash: Crash; parents: string[] }[] = [
  { crash: { method: "unlink", nth: 1 }, parents: ["tasks/task-a/decisions", "tasks/task-a", "tasks", "status/plan/progress", "status/plan"] },
  { crash: { method: "rename", nth: 1 }, parents: ["tasks/task-a/decisions", "status/approval/plan", "status/approval", "approvals/open", "approvals", "status/plan/progress"] },
  { crash: { method: "removeJournal", nth: 1 }, parents: ["tasks/task-a/decisions", "tasks/task-a", "status/approval/plan", "approvals/open"] },
];

for (const { crash, parents } of parentCases) {
  test(`P-16-9 (${crash.method} の異常終了) 残った journal の対象の親がリンクなら、対象のタスクでも別のタスクでも、リンク先・journal を消さずに WF_APPROVAL_ORPHAN で止まる (R21-1)`, withProject((project) => {
    crashSubmit(project, crash);
    const before = project.state();
    for (const parent of parents) {
      const { outside, undo } = linkOut(project, parent);
      try {
        const outsideBefore = snapshot(outside);
        for (const task of [name, "task-b"]) {
          const operation: OperationV4 = task === name ? { kind: "block", actor: "agent/codex", blockedBy: ["other: 待ち"] } : { kind: "claim", actor: "agent/claude" };
          const error = project.rejects(operation, "WF_APPROVAL_ORPHAN", { task });
          assert.match(error.message, /親 .* が実際のディレクトリではありません/, `${parent} (${task})`);
          assert.deepEqual(snapshot(outside), outsideBefore, `${parent} (${task}): リンク先のファイルは 1 バイトも変わらない`);
          assert.equal(pendingJournals(project.jobDir).length, 1, `${parent} (${task}): journal は残る`);
        }
      } finally {
        undo();
      }
      assert.deepEqual(project.state(), before, `${parent}: 戻すと異常終了の直後と同じ`);
    }
    // journal そのものがリンク・ディレクトリなら読まずに止まる
    const journal = pendingJournals(project.jobDir)[0];
    const { outside, undo } = linkOut(project, `.raprid-ops/${journal.split("/").pop()}`);
    try {
      const outsideBefore = snapshot(outside);
      project.rejects({ kind: "claim", actor: "agent/claude" }, "WF_APPROVAL_ORPHAN", { task: "task-b" });
      assert.deepEqual(snapshot(outside), outsideBefore);
    } finally {
      undo();
    }
    // 置き場所 (.raprid-ops) がリンクなら WF_INVALID
    const ops = linkOut(project, ".raprid-ops");
    try {
      const outsideBefore = snapshot(ops.outside);
      project.rejects({ kind: "claim", actor: "agent/claude" }, "WF_INVALID", { task: "task-b" });
      assert.deepEqual(snapshot(ops.outside), outsideBefore);
    } finally {
      ops.undo();
    }
    assert.deepEqual(project.state(), before);
    // 元に戻れば復旧でき、同じ提出をやり直せる
    nextWrite(project);
    project.consistent();
    if (project.data().status === "open") {
      project.run(submitOperation);
      project.consistent();
    }
  }));
}

// task-a と task-b の提出をそれぞれ異常終了させ、journal を 2 件残す (2 件目の操作が 1 件目を復旧しないよう、1 件目を退避しておく)
function twoJournals(project: Project): string[] {
  project.create("research");
  project.create("research", { task: "task-b", id: "T-002" });
  project.create("research", { task: "task-c", id: "T-003" });
  for (const task of [name, "task-b"]) {
    project.write("01-plan.md", handoff("計画"), task);
    project.run({ kind: "claim", actor: "agent/codex" }, { task });
  }
  assert.equal(runChild(project, submitOperation, { method: "rename", nth: 1 }, "task-b").status, 137);
  const [first] = pendingJournals(project.jobDir);
  const saved = join(project.root, "saved-journal.json");
  renameSync(first, saved);
  assert.equal(runChild(project, submitOperation, { method: "rename", nth: 1 }).status, 137);
  renameSync(saved, first);
  const journals = pendingJournals(project.jobDir);
  assert.equal(journals.length, 2);
  return journals;
}

test("P-16-9 journal が複数あり一つでも不正なら、ほかの journal の対象も含めて何も変えずに止まり、直せば全件を復旧する (R21-1)", withProject((project) => {
  const journals = twoJournals(project);
  const before = project.state();
  // どちらの journal が不正でも (名前順の前でも後でも)、もう一方の判断記録・索引は復旧されない
  for (const task of [name, "task-b"]) {
    const { undo } = linkOut(project, `tasks/${task}/decisions`);
    try {
      project.rejects({ kind: "claim", actor: "agent/claude" }, "WF_APPROVAL_ORPHAN", { task: "task-c" });
    } finally {
      undo();
    }
    const decision = project.decisionPath("plan-1", task);
    const text = readFileSync(decision, "utf8");
    writeFileSync(decision, `${text}\n人のメモ\n`);
    project.rejects({ kind: "claim", actor: "agent/claude" }, "WF_APPROVAL_ORPHAN", { task: "task-c" });
    writeFileSync(decision, text);
    assert.deepEqual(project.state(), before, `${task}: 何も変わらない`);
  }
  // 同じ対象を 2 件の journal が指す (どちらの前後か決められない) なら止まる
  const copy = join(project.jobDir, ".raprid-ops", "copy.json");
  cpSync(journals[0], copy);
  const error = project.rejects({ kind: "claim", actor: "agent/claude" }, "WF_APPROVAL_ORPHAN", { task: "task-c" });
  assert.match(error.message, /別の journal/);
  rmSync(copy);
  // 直せば 1 回の書き込みの操作で両方とも前の状態へ戻る
  project.run({ kind: "claim", actor: "agent/claude" }, { task: "task-c" });
  for (const task of [name, "task-b"]) {
    assert.ok(!existsSync(project.decisionPath("plan-1", task)));
    assert.deepEqual(project.workLinks(task), [`status/plan/progress/${task}`]);
    project.consistent(task);
  }
}));

test("P-16-9 journal が別のタスクの記録・規則と違うリンク先・案件の外を指していれば、何も変えずに止まる (R21-1)", withProject((project) => {
  crashSubmit(project, { method: "rename", nth: 1 });
  const [journal] = pendingJournals(project.jobDir);
  const saved = readFileSync(journal, "utf8");
  const edits: { label: string; edit: (data: Record<string, any>) => void }[] = [
    { label: "別のタスクの判断記録", edit: (data) => (data.decisions[0].path = "tasks/task-b/decisions/plan-1.md") },
    { label: "別のタスクの作業索引", edit: (data) => (data.links[0].path = "status/plan/progress/task-b") },
    { label: "作業索引の規則と違うリンク先", edit: (data) => (data.links.find((link: { before: string | null }) => link.before !== null).before = "../../../tasks/task-b") },
    { label: "確認待ちの索引の規則と違うリンク先", edit: (data) => (data.links.find((link: { path: string }) => link.path.startsWith("approvals/")).after = "../../tasks/task-a/decisions/plan-2.md") },
    { label: "案件の外のパス", edit: (data) => (data.task.path = "tasks/task-a/../../../outside/index.md") },
    { label: "同じ対象を 2 回", edit: (data) => data.links.push({ ...data.links[0] }) },
  ];
  for (const { label, edit } of edits) {
    const data = JSON.parse(saved);
    edit(data);
    writeFileSync(journal, JSON.stringify(data));
    project.rejects({ kind: "claim", actor: "agent/claude" }, "WF_APPROVAL_ORPHAN", { task: "task-b" });
    assert.ok(existsSync(project.decisionPath("plan-1")), `${label}: 判断記録は残る`);
  }
  writeFileSync(journal, saved);
  nextWrite(project);
  project.consistent();
}));

test("P-16-9 復旧の途中で失敗・異常終了しても、次の書き込みの操作で復旧をやり直せる (R21-1 の事前検査は再試行を妨げない)", withProject((project) => {
  const { revision } = crashSubmit(project, { method: "rename", nth: 1 });
  // 索引を変えた後の journal の復旧は、判断記録と作った索引 2 件の削除・外した索引の作り直し・journal の削除の順
  const steps: Crash[] = [{ method: "unlink", nth: 1 }, { method: "unlink", nth: 2 }, { method: "unlink", nth: 3 }, { method: "symlink", nth: 1 }, { method: "removeJournal", nth: 1 }];
  for (const step of steps) {
    if (pendingJournals(project.jobDir).length === 0) assert.equal(runChild(project, submitOperation, { method: "rename", nth: 1 }).status, 137);
    // 同じ実行の中の失敗 (例外)
    const { fs } = counting(step);
    assert.throws(() => project.run({ kind: "claim", actor: "agent/claude" }, { task: "task-b", fs }), `${step.method} #${step.nth}`);
    nextWrite(project);
    assert.equal(taskRevision(project.index()), revision, `${step.method} #${step.nth}: タスクは前のまま`);
    project.consistent();
    project.run({ kind: "revise", actor: "human/saiki", reason: "task-b をやり直す" }, { task: "task-b" });
    // 別のプロセスの異常終了 (finally も走らない)
    assert.equal(runChild(project, submitOperation, { method: "rename", nth: 1 }).status, 137);
    const crashed = runChild(project, { kind: "block", actor: "agent/codex", blockedBy: ["other: 待ち"] }, step);
    assert.equal(crashed.status, 137, `${step.method} #${step.nth}: ${JSON.stringify(crashed)}`);
    nextWrite(project);
    assert.equal(taskRevision(project.index()), revision);
    project.consistent();
    project.run({ kind: "revise", actor: "human/saiki", reason: "task-b をやり直す" }, { task: "task-b" });
  }
}));

// ---- R21-2: 案件の書き込みの操作は、v4 に限らず (v3・旧形式・QA・移行)、ロックの中で書き込む前に同じ復旧を通る ----------

const orphanMessage = /途中で止まった操作の記録/;

// v4 の task-a を plan progress にして、v3・旧形式のタスクと QA を CLI で置く
function mixedJob(project: Project): void {
  project.create("research");
  project.write("01-plan.md", handoff("計画"));
  project.run({ kind: "claim", actor: "agent/codex" });
  for (const args of [
    ["task", "add", job, "legacy-a", "todo", "旧形式のタスク", "--requested-by", "human/saiki", "--created-by", "agent/test"],
    ["task", "add", job, "v3-a", "--type", "research", "工程型のタスク", "--requested-by", "human/saiki", "--created-by", "agent/test"],
    ["qa", "add", job, "q-a", "internal", "質問", "--requested-by", "agent/test", "--created-by", "agent/test"],
  ]) {
    const result = raprid(project.root, args);
    assert.equal(result.status, 0, result.stderr);
  }
}

// task-a の提出を、索引を変えた後・タスクを書く前に異常終了させる (正常な journal が 1 件残る)
function crashTaskA(project: Project): void {
  const result = runChild(project, submitOperation, { method: "rename", nth: 1 });
  assert.equal(result.status, 137, JSON.stringify(result));
  assert.equal(pendingJournals(project.jobDir).length, 1);
}

// task-a が異常終了の前の状態 (plan progress、判断記録と確認待ちの索引なし) に戻り、journal が消えた
function assertRecoveredA(project: Project, label: string): void {
  assert.deepEqual(pendingJournals(project.jobDir), [], `${label}: journal は消える`);
  assert.ok(!existsSync(join(project.jobDir, ".raprid-ops")), `${label}: 空になった置き場所も消える`);
  assert.ok(!existsSync(project.decisionPath("plan-1")), `${label}: 孤立した判断記録は消える`);
  assert.deepEqual(project.workLinks(), ["status/plan/progress/task-a"], `${label}: 外した作業索引は作り直される`);
  assert.deepEqual(project.queueLinks(), [], `${label}: 作った確認待ちの索引は消える`);
  project.consistent();
}

const revisionOfTask = (project: Project, task: string) => taskRevision(project.index(task));

const writePaths: { label: string; args: (project: Project) => string[]; check?: (project: Project) => void }[] = [
  { label: "旧形式の task add", args: () => ["task", "add", job, "legacy-b", "todo", "旧形式", "--requested-by", "human/saiki", "--created-by", "agent/test"], check: (project) => assert.ok(existsSync(project.index("legacy-b"))) },
  { label: "旧形式の task move", args: () => ["task", "move", job, "legacy-a", "progress"], check: (project) => assert.match(project.read("legacy-a"), /\nstatus: progress\n/) },
  { label: "旧形式の task note", args: () => ["task", "note", job, "legacy-a", "memo"], check: (project) => assert.ok(existsSync(join(project.dir("legacy-a"), "01-memo.md"))) },
  { label: "旧形式の task ask", args: () => ["task", "ask", job, "legacy-a", "q-legacy", "internal", "質問", "--requested-by", "agent/test", "--created-by", "agent/test"], check: (project) => assert.match(project.read("legacy-a"), /\nstatus: pending\n/) },
  { label: "v3 の task add", args: () => ["task", "add", job, "v3-b", "--type", "research", "工程型", "--requested-by", "human/saiki", "--created-by", "agent/test"], check: (project) => assert.ok(existsSync(project.index("v3-b"))) },
  { label: "v3 の task claim", args: (project) => ["task", "claim", job, "v3-a", "--actor", "agent/test", "--if-match", revisionOfTask(project, "v3-a")], check: (project) => assert.equal((YamlFrontmatter.parse(project.read("v3-a")).data() as { workflow: { plan: { status: string } } }).workflow.plan.status, "progress") },
  { label: "v3 の task note", args: (project) => ["task", "note", job, "v3-a", "memo", "--if-match", revisionOfTask(project, "v3-a")], check: (project) => assert.ok(existsSync(join(project.dir("v3-a"), "01-memo.md"))) },
  { label: "v3 の task ask", args: (project) => ["task", "ask", job, "v3-a", "q-v3", "internal", "質問", "--actor", "agent/test", "--requested-by", "agent/test", "--created-by", "agent/test", "--if-match", revisionOfTask(project, "v3-a")], check: (project) => assert.ok(existsSync(join(project.jobDir, "qa", "q-v3", "index.md"))) },
  { label: "qa add", args: () => ["qa", "add", job, "q-b", "internal", "質問", "--requested-by", "agent/test", "--created-by", "agent/test"], check: (project) => assert.ok(existsSync(join(project.jobDir, "qa", "q-b", "index.md"))) },
  { label: "qa resolve", args: () => ["qa", "resolve", job, "q-a", "回答", "--answered-by", "human/saiki"], check: (project) => assert.match(readFileSync(join(project.jobDir, "qa", "q-a", "index.md"), "utf8"), /\nstatus: resolved\n/) },
  { label: "qa move", args: () => ["qa", "move", job, "q-a", "unresolved"], check: (project) => assert.match(readFileSync(join(project.jobDir, "qa", "q-a", "index.md"), "utf8"), /\nstatus: unresolved\n/) },
];

test("P-16-9 同じ案件の v3・旧形式・QA の書き込みの操作も、書き込む前に正常な journal を復旧し、不整合な journal があれば何も変えずに止まる (R21-2)", withProject((project) => {
  mixedJob(project);
  for (const path of writePaths) {
    crashTaskA(project);
    // 不整合な journal (判断記録に人の追記) があれば、その操作は書き込まずに止まる
    const decision = project.decisionPath("plan-1");
    const text = readFileSync(decision, "utf8");
    writeFileSync(decision, `${text}\n人のメモ\n`);
    const before = project.state();
    const refused = raprid(project.root, path.args(project));
    assert.equal(refused.status, 1, `${path.label}: ${refused.stdout}${refused.stderr}`);
    assert.match(refused.stderr, orphanMessage, path.label);
    assert.deepEqual(project.state(), before, `${path.label}: 止まったら何も変わらない`);
    writeFileSync(decision, text);
    // 正常な journal は、書き込む前に前の状態へ戻してから操作する
    const result = raprid(project.root, path.args(project));
    assert.equal(result.status, 0, `${path.label}: ${result.stderr}`);
    assertRecoveredA(project, path.label);
    path.check?.(project);
  }
}));

test("P-16-9 v3 のサービス (runTransition) は、同じ案件の正常な journal を復旧してから遷移し、不整合なら何も変えずに止まる (R21-2)", withProject((project) => {
  mixedJob(project);
  crashTaskA(project);
  const decision = project.decisionPath("plan-1");
  const text = readFileSync(decision, "utf8");
  writeFileSync(decision, `${text}\n人のメモ\n`);
  const before = project.state();
  assert.throws(() => runTransition(project.root, job, "v3-a", revisionOfTask(project, "v3-a"), { kind: "claim", actor: "agent/claude" }, { clock: project.clock() }), (error: unknown) => error instanceof CliError && error.code === "WF_APPROVAL_ORPHAN");
  assert.deepEqual(project.state(), before);
  writeFileSync(decision, text);
  const result = runTransition(project.root, job, "v3-a", revisionOfTask(project, "v3-a"), { kind: "claim", actor: "agent/claude" }, { clock: project.clock() });
  assert.equal(result.task.workflow.plan.status, "progress");
  assertRecoveredA(project, "runTransition");
}));

test("P-16-9 読み取りの操作 (一覧・表示・snapshot・移行の dry-run) は journal を復旧せず、何も書き換えない (R21-2)", withProject((project) => {
  mixedJob(project);
  crashTaskA(project);
  const before = project.state();
  for (const args of [
    ["task", "list", job],
    ["task", "list", job, "--all", "--long"],
    ["task", "show", job, "task-a"],
    ["task", "show", job, "v3-a", "--json", "--schema-version", "2"],
    ["qa", "list", job],
    ["qa", "show", job, "q-a"],
    ["job", "list"],
    ["ui", "snapshot", job, "--json", "--schema-version", "2"],
    ["job", "migrate-workflow", "--dry-run", "--actor", "human/saiki"],
  ]) {
    raprid(project.root, args);
    assert.deepEqual(project.state(), before, `${args.join(" ")}: 何も変わらない`);
    assert.equal(pendingJournals(project.jobDir).length, 1, `${args.join(" ")}: journal は残る`);
  }
}));

test("P-16-9 別の案件の QA を待つ再開は、書き込む案件の journal だけを復旧し、読むだけの案件の journal には触れない (R21-2)", withProject((project) => {
  mixedJob(project);
  // 別の案件 OTHER の QA を解決しておき、OTHER には読めない journal を置く (復旧の対象にすると止まる)
  assert.equal(raprid(project.root, ["job", "create", "OTHER"]).status, 0);
  assert.equal(raprid(project.root, ["qa", "add", "OTHER", "q-other", "internal", "質問", "--requested-by", "agent/test", "--created-by", "agent/test"]).status, 0);
  assert.equal(raprid(project.root, ["qa", "resolve", "OTHER", "Q-001", "回答", "--answered-by", "human/saiki"]).status, 0);
  const otherJournal = join(project.root, "jobs", "OTHER", ".raprid-ops", "broken.json");
  mkdirSync(dirname(otherJournal), { recursive: true });
  writeFileSync(otherJournal, "{");
  // 旧形式の pending → progress と v3 の resume (どちらも OTHER をロックして QA を読む)
  assert.equal(raprid(project.root, ["task", "move", job, "legacy-a", "pending", "qa/OTHER/Q-001"]).status, 0);
  let result = raprid(project.root, ["task", "claim", job, "v3-a", "--actor", "agent/test", "--if-match", revisionOfTask(project, "v3-a")]);
  assert.equal(result.status, 0, result.stderr);
  result = raprid(project.root, ["task", "block", job, "v3-a", "--actor", "agent/test", "--blocked-by", "qa/OTHER/Q-001", "--if-match", revisionOfTask(project, "v3-a")]);
  assert.equal(result.status, 0, result.stderr);
  for (const args of [
    () => ["task", "move", job, "legacy-a", "progress"],
    () => ["task", "resume", job, "v3-a", "--actor", "agent/test", "--if-match", revisionOfTask(project, "v3-a")],
  ]) {
    crashTaskA(project);
    result = raprid(project.root, args());
    assert.equal(result.status, 0, result.stderr);
    assertRecoveredA(project, args()[1]);
    assert.equal(readFileSync(otherJournal, "utf8"), "{", "読むだけの案件の journal は変えない");
  }
  // OTHER への書き込みは OTHER の journal で止まる
  const before = snapshot(join(project.root, "jobs", "OTHER"));
  result = raprid(project.root, ["qa", "move", "OTHER", "Q-001", "unresolved"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, orphanMessage);
  assert.deepEqual(snapshot(join(project.root, "jobs", "OTHER")), before);
}));

test("P-16-9 移行 (job migrate-workflow の --apply・--restore) は全案件のロックの中で journal を復旧してから進み、不整合な journal があれば何も変えずに止まる (R21-2)", withProject((project) => {
  // v4 のタスクがある案件は workflowVersion 3 への移行の対象外 (MIGRATE_BLOCKED) なので、復旧した後に移行自体は止まる
  project.create("research");
  project.write("01-plan.md", handoff("計画"));
  project.run({ kind: "claim", actor: "agent/codex" });
  const dry = raprid(project.root, ["job", "migrate-workflow", "--dry-run", "--actor", "human/saiki"]);
  const hash = /計画ハッシュ: ([0-9a-f]+)/.exec(dry.stdout)?.[1];
  assert.ok(hash, `${dry.stdout}${dry.stderr}`);
  const commands = [
    { label: "--apply", args: ["job", "migrate-workflow", "--apply", "--plan", hash, "--actor", "human/saiki"], after: /移行できないもの/ },
    { label: "--restore", args: ["job", "migrate-workflow", "--restore", "wf-20261001-000000-abcd"], after: /移行の記録が見つかりません/ },
  ];
  const skip = (rel: string) => rel.startsWith("jobs/.locks");
  for (const command of commands) {
    crashTaskA(project);
    const decision = project.decisionPath("plan-1");
    const text = readFileSync(decision, "utf8");
    writeFileSync(decision, `${text}\n人のメモ\n`);
    const before = snapshot(project.root, skip);
    const refused = raprid(project.root, command.args);
    assert.equal(refused.status, 1, `${command.label}: ${refused.stdout}`);
    assert.match(refused.stderr, orphanMessage, command.label);
    assert.deepEqual(snapshot(project.root, skip), before, `${command.label}: 移行の印・記録も作らない`);
    writeFileSync(decision, text);
    const result = raprid(project.root, command.args);
    assert.match(result.stderr, command.after, `${command.label}: ${result.stderr}`);
    assertRecoveredA(project, command.label);
    assert.ok(!existsSync(join(project.root, "jobs", ".raprid-workflow")), `${command.label}: 移行の印は置かない`);
  }
}));
