// 工程型タスク (workflowVersion 3) の遷移サービス (lib/taskflow.ts・lib/transitions.ts) の試験。T-013
// CLI への接続は T-014 なので、サービスを直接呼ぶ。別プロセスからの同時操作は node で子プロセスを起こして確かめる。

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CliError } from "../lib/errors.ts";
import { runTransition, taskRevision } from "../lib/taskflow.ts";
import { defaultIndexFs } from "../lib/workindex.ts";
import type { Clock, Operation } from "../lib/transitions.ts";
import { initialTaskV3, readTaskFile, type TaskType, type TaskV3 } from "../lib/workflow.ts";
import { YamlEditError, YamlFrontmatter } from "../lib/yamlfront.ts";
import { raprid } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const taskflowPath = join(here, "..", "lib", "taskflow.ts");
const jobsPath = join(here, "..", "lib", "jobs.ts");
const fixtures = join(here, "fixtures", "workflow");
const job = "PROJ";
const name = "task-a";

const handoff = (title = "引継ぎ") => `# ${title}\n\n## 対象・成果物\n\n- 成果物\n\n## 実施・検証\n\n- 実施した検証\n\n## 未確認・制約\n\n- なし\n\n## 次の担当への依頼\n\n- 確認してほしい点\n`;

class Project {
  readonly root = mkdtempSync(join(tmpdir(), "raprid-taskflow-"));
  private minute = 0;

  constructor() {
    mkdirSync(join(this.root, "jobs"));
    const created = raprid(this.root, ["job", "create", job]);
    assert.equal(created.status, 0, created.stderr);
    mkdirSync(join(this.root, "repos", "project_template"), { recursive: true });
  }

  dir(task = name): string {
    return join(this.root, "jobs", job, "tasks", task);
  }

  index(task = name): string {
    return join(this.dir(task), "index.md");
  }

  // 新しい v3 のタスクを置く (未知の項目 test と本文を持つ)
  create(type: TaskType, task = name, id = "T-001"): void {
    const data = initialTaskV3({ id, type, date: "2026-10-01", at: "2026-10-01T00:00:00Z", requestedBy: "human/saiki", createdBy: "agent/codex" });
    const frontmatter = YamlFrontmatter.parse("---\n---\n\n# 概要\n\n本文は変えない。\n");
    for (const [key, value] of Object.entries(data)) frontmatter.set([key], value);
    frontmatter.set(["test"], ["docs/feature/raprid/workflow-handoff.feature"]);
    mkdirSync(this.dir(task), { recursive: true });
    writeFileSync(this.index(task), frontmatter.toString());
  }

  write(file: string, content: string, task = name): void {
    mkdirSync(dirname(join(this.dir(task), file)), { recursive: true });
    writeFileSync(join(this.dir(task), file), content);
  }

  read(task = name): string {
    return readFileSync(this.index(task), "utf8");
  }

  data(task = name): TaskV3 {
    return YamlFrontmatter.parse(this.read(task)).data() as TaskV3;
  }

  clock(): Clock {
    this.minute += 1;
    return { date: "2026-10-01", at: `2026-10-01T01:${String(this.minute).padStart(2, "0")}:00Z` };
  }

  run(operation: Operation, task = name): TaskV3 {
    return runTransition(this.root, job, task, taskRevision(this.index(task)), operation, { clock: this.clock() }).task;
  }

  // 失敗し、code が一致し、index.md が 1 バイトも変わらないこと
  rejects(operation: Operation, code: string, task = name, revision?: string): CliError {
    const before = this.read(task);
    let caught: unknown;
    try {
      runTransition(this.root, job, task, revision ?? taskRevision(this.index(task)), operation, { clock: this.clock() });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof CliError, `${operation.kind}: 失敗しない (${code} を期待)`);
    assert.equal(caught.code, code, `${operation.kind}: ${caught.message}`);
    assert.equal(this.read(task), before, `${operation.kind} (${code}): 失敗したら index.md は変わらない`);
    return caught;
  }

  close(): void {
    rmSync(this.root, { recursive: true, force: true });
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

// 計画 (agent/codex) → 実行 (agent/claude) の完了まで進める
function throughExecute(project: Project, type: TaskType): void {
  project.write("01-plan.md", handoff("計画"));
  project.run({ kind: "claim", actor: "agent/codex" });
  project.run({ kind: "complete", actor: "agent/codex", refs: [{ path: "01-plan.md" }] });
  project.write("02-handoff.md", handoff("実行"));
  project.run({ kind: "claim", actor: "agent/claude" });
  const refs = type === "research" ? [{ path: "02-handoff.md" }] : [{ path: "02-handoff.md" }, { repo: "project_template", commit: "873ca38" }];
  project.run({ kind: "complete", actor: "agent/claude", refs });
}

for (const type of ["research", "implementation"] as const) {
  test(`${type}: 計画 → 実行 → 独立レビュー → 人の受入確認で closed になり、各工程の結果と履歴が残る`, withProject((project) => {
    project.create(type);
    throughExecute(project, type);
    let task = project.data();
    assert.equal(task.phase, "review");
    assert.equal(task.workflow.execute.status, "done");
    assert.equal(task.workflow.review.status, "ready", "前の担当の完了で次の工程が ready になる (AI は起動しない)");
    assert.equal(task.workflow.review.inputSeq, task.history.at(-1)!.seq, "レビューは実行の完了を受け取る");
    if (type === "research") assert.deepEqual(task.workflow.execute.artifactRefs, [{ path: "02-handoff.md" }], "調査は資料だけで完了できる");

    project.write("03-review.md", "# レビュー\n\n合格\n");
    project.run({ kind: "claim", actor: "agent/codex" });
    project.run({ kind: "decide", actor: "agent/codex", outcome: "approved", refs: [{ path: "03-review.md" }] });
    task = project.data();
    assert.equal(task.phase, "acceptance");
    assert.equal(task.status, "open", "レビューの合格では閉じない");

    project.write("04-acceptance.md", "# 受入確認\n\n受け入れる\n");
    project.run({ kind: "claim", actor: "human/saiki" });
    task = project.run({ kind: "decide", actor: "human/saiki", outcome: "approved", refs: [{ path: "04-acceptance.md" }], reason: "受け入れる" });
    assert.equal(task.status, "closed");
    assert.equal(task.phase, null);
    assert.equal(task.closureReason, "accepted");
    assert.equal(task.completedAt, "2026-10-01");
    assert.deepEqual(task.history.map((entry) => `${entry.event}:${entry.phase}`), [
      "create:plan", "claim:plan", "complete:plan", "claim:execute", "complete:execute", "claim:review", "decide:review", "claim:acceptance", "decide:acceptance",
    ]);
    const text = project.read();
    assert.deepEqual(readTaskFile(text).issues, []);
    assert.match(text, /\ntest:\n  - docs\/feature\/raprid\/workflow-handoff.feature\n/, "未知の項目は残る");
    assert.ok(text.endsWith("---\n\n# 概要\n\n本文は変えない。\n"), "本文は変わらない");
    // 閉じたタスクは操作できない
    project.rejects({ kind: "claim", actor: "agent/codex" }, "WF_CLOSED");
  }));
}

test("実装の実行の完了には対象の参照が必要で、調査は資料だけでよい。引継資料は必要な節が揃っていないと拒否する", withProject((project) => {
  project.create("implementation");
  project.write("01-plan.md", handoff("計画"));
  project.run({ kind: "claim", actor: "agent/codex" });
  // 引継資料の構造
  project.write("bad-missing.md", "# 引継ぎ\n\n## 対象・成果物\n\n- x\n\n## 実施・検証\n\n- y\n\n## 次の担当への依頼\n\n- z\n");
  const missing = project.rejects({ kind: "complete", actor: "agent/codex", refs: [{ path: "bad-missing.md" }] }, "WF_HANDOFF");
  assert.match(missing.message, /「未確認・制約」の節がありません/);
  project.write("bad-empty.md", "# 引継ぎ\n\n## 対象・成果物\n\n- x\n\n## 実施・検証\n\n<!-- 未記入 -->\n\n## 未確認・制約\n\n- なし\n\n## 次の担当への依頼\n\n- z\n");
  assert.match(project.rejects({ kind: "complete", actor: "agent/codex", refs: [{ path: "bad-empty.md" }] }, "WF_HANDOFF").message, /「実施・検証」の節が空です/);
  project.write("fenced.md", "# 引継ぎ\n\n```\n## 対象・成果物\n## 実施・検証\n## 未確認・制約\n## 次の担当への依頼\n```\n");
  project.rejects({ kind: "complete", actor: "agent/codex", refs: [{ path: "fenced.md" }] }, "WF_HANDOFF"); // コードブロックの中は見出しではない
  project.write("empty.md", "\n");
  project.rejects({ kind: "complete", actor: "agent/codex", refs: [{ path: "empty.md" }] }, "WF_HANDOFF");
  project.rejects({ kind: "complete", actor: "agent/codex", refs: [{ path: "none.md" }] }, "WF_HANDOFF");
  project.rejects({ kind: "complete", actor: "agent/codex", refs: [{ path: "../other/01-plan.md" }] }, "WF_HANDOFF");
  project.rejects({ kind: "complete", actor: "agent/codex", refs: [{ path: "index.md" }] }, "WF_HANDOFF");
  project.rejects({ kind: "complete", actor: "agent/codex", refs: [] }, "WF_HANDOFF");
  writeFileSync(join(project.root, "outside.md"), handoff());
  symlinkSync(join(project.root, "outside.md"), join(project.dir(), "link.md"));
  assert.match(project.rejects({ kind: "complete", actor: "agent/codex", refs: [{ path: "link.md" }] }, "WF_HANDOFF").message, /外/);
  project.run({ kind: "complete", actor: "agent/codex", refs: [{ path: "01-plan.md" }] });

  project.write("02-handoff.md", handoff("実行"));
  project.run({ kind: "claim", actor: "agent/claude" });
  project.rejects({ kind: "complete", actor: "agent/claude", refs: [{ path: "02-handoff.md" }] }, "WF_TARGET");
  project.rejects({ kind: "complete", actor: "agent/claude", refs: [{ path: "02-handoff.md" }, { repo: "missing-repo", commit: "873ca38" }] }, "WF_REF");
  project.rejects({ kind: "complete", actor: "agent/claude", refs: [{ path: "02-handoff.md" }, { repo: "project_template", commit: "XYZ" }] }, "WF_REF");
  project.rejects({ kind: "complete", actor: "agent/claude", refs: [{ path: "02-handoff.md" }, { path: "absent.png" }] }, "WF_REF");
  // 資料だけを変える実装は、タスクの中の資料を対象として参照できる
  project.write("changed/README.md", "# 変更した資料\n");
  const task = project.run({ kind: "complete", actor: "agent/claude", refs: [{ path: "02-handoff.md" }, { path: "changed/README.md" }] });
  assert.deepEqual(task.workflow.execute.artifactRefs, [{ path: "02-handoff.md" }, { path: "changed/README.md" }]);
}));

test("引継資料の 4 つの節は別々の見出しで満たし、複数行の HTML コメントだけの節は空とみなす (R13-1)", withProject((project) => {
  project.create("research");
  project.run({ kind: "claim", actor: "agent/codex" });
  const complete = (file: string) => ({ kind: "complete" as const, actor: "agent/codex", refs: [{ path: file }] });
  // レビューの再現例: 1 つの見出しに全部のキーワードを入れても、4 つの節にはならない
  project.write("one-heading.md", "# 引継ぎ\n## 対象・成果物・実施・検証・未確認・制約・次の担当への依頼\n- 何か\n");
  project.rejects(complete("one-heading.md"), "WF_HANDOFF");
  // 2 つの節を 1 つの見出しで兼ねる
  project.write("shared.md", "# 引継ぎ\n\n## 対象・成果物と実施・検証\n\n- x\n\n## 未確認・制約\n\n- y\n\n## 次の担当への依頼\n\n- z\n");
  project.rejects(complete("shared.md"), "WF_HANDOFF");
  // レビューの再現例: 複数行の HTML コメントだけの節
  project.write("multiline-comment.md", "# 引継ぎ\n\n## 対象・成果物\n\n<!--\n未記入\n-->\n\n## 実施・検証\n\n- y\n\n## 未確認・制約\n\n- なし\n\n## 次の担当への依頼\n\n- z\n");
  assert.match(project.rejects(complete("multiline-comment.md"), "WF_HANDOFF").message, /対象・成果物/);
  project.write("inline-comment.md", "# 引継ぎ\n\n## 対象・成果物\n\n<!-- a --> <!-- b -->\n\n## 実施・検証\n\n- y\n\n## 未確認・制約\n\n- なし\n\n## 次の担当への依頼\n\n- z\n");
  project.rejects(complete("inline-comment.md"), "WF_HANDOFF");
  // 節の本文が下位の見出しだけ (中身が無い)
  project.write("only-subheading.md", "# 引継ぎ\n\n## 対象・成果物\n\n### 詳細\n\n## 実施・検証\n\n- y\n\n## 未確認・制約\n\n- なし\n\n## 次の担当への依頼\n\n- z\n");
  project.rejects(complete("only-subheading.md"), "WF_HANDOFF");
  // 必要な節が別の必要な節の下にある (節が重なる) 場合は別々とみなさない
  project.write("nested.md", "# 引継ぎ\n\n## 対象・成果物\n\n- x\n\n### 実施・検証\n\n- y\n\n## 未確認・制約\n\n- なし\n\n## 次の担当への依頼\n\n- z\n");
  project.rejects(complete("nested.md"), "WF_HANDOFF");
  // 再レビューの再現例 (R13-3): 資料全体を HTML コメントで囲んだ見出しと本文
  project.write("all-commented.md", "# 引継ぎ\n<!--\n## 対象・成果物\n- 未記入\n## 実施・検証\n- 未記入\n## 未確認・制約\n- 未記入\n## 次の担当への依頼\n- 未記入\n-->\n");
  project.rejects(complete("all-commented.md"), "WF_HANDOFF");
  // コメントが節の境界をまたぐ (1 つ目の節の途中から 2 つ目の節の本文までコメント)
  project.write("across.md", "# 引継ぎ\n\n## 対象・成果物\n\n- x\n<!-- ここから\n\n## 実施・検証\n\n- 未記入\n-->\n\n## 未確認・制約\n\n- なし\n\n## 次の担当への依頼\n\n- z\n");
  assert.match(project.rejects(complete("across.md"), "WF_HANDOFF").message, /実施・検証/);
  // コメントの中の見出しは見出しにならないので、その後ろの本文は前の節の本文になる (ここでは「実施・検証」の節が無い)
  project.write("heading-in-comment.md", "# 引継ぎ\n\n## 対象・成果物\n\n- x\n\n<!-- ## 実施・検証 -->\n- y\n\n## 未確認・制約\n\n- なし\n\n## 次の担当への依頼\n\n- z\n");
  assert.match(project.rejects(complete("heading-in-comment.md"), "WF_HANDOFF").message, /「実施・検証」の節がありません/);
  // コードブロックの中の <!-- はコメントを始めない (後ろの見出しは見出しのまま)
  project.write("fence-comment.md", "# 引継ぎ\n\n## 対象・成果物\n\n```\n<!--\n```\n\n## 実施・検証\n\n- y\n\n## 未確認・制約\n\n- なし\n\n## 次の担当への依頼\n\n- z\n");
  assert.equal(project.run(complete("fence-comment.md")).phase, "execute");
}));

test("引継資料の節の判定: コメントの後ろに本文がある節・下位の見出しの中の本文・コードブロックの中のコメントは満たす", withProject((project) => {
  project.create("research");
  project.run({ kind: "claim", actor: "agent/codex" });
  const complete = (file: string) => ({ kind: "complete" as const, actor: "agent/codex", refs: [{ path: file }] });
  project.write("ok.md", "# 引継ぎ\n\n## 対象・成果物\n\n<!-- 種別ごとの表を見て書く -->\n- 成果物\n\n## 実施・検証\n\n### 試験\n\n- 131/131\n\n## 未確認・制約\n\n```html\n<!-- コードの中のコメント -->\n```\n\n## 次の担当への依頼\n\n- z\n");
  assert.equal(project.run(complete("ok.md")).phase, "execute");
}));

test("実装の対象の参照は通常のファイルか repo+commit で、ディレクトリ・index.md・引継資料そのものでは足りない (R13-2)", withProject((project) => {
  project.create("implementation");
  project.write("01-plan.md", handoff());
  project.run({ kind: "claim", actor: "agent/codex" });
  project.run({ kind: "complete", actor: "agent/codex", refs: [{ path: "01-plan.md" }] });
  project.write("handoff.md", handoff("実行"));
  project.run({ kind: "claim", actor: "agent/claude" });
  const complete = (...refs: { path?: string; repo?: string; commit?: string }[]) => ({ kind: "complete" as const, actor: "agent/claude", refs: [{ path: "handoff.md" }, ...refs] });
  // レビューの再現例: 空のディレクトリ
  mkdirSync(join(project.dir(), "assets"));
  project.rejects(complete({ path: "assets" }), "WF_REF");
  project.rejects(complete({ path: "index.md" }), "WF_REF");
  project.rejects(complete({ path: "handoff.md" }), "WF_TARGET"); // 引継資料を対象として数えない
  project.rejects(complete({ path: "./handoff.md" }), "WF_REF"); // 同じ資料を別の書き方で指す
  mkdirSync(join(project.dir(), "sub"));
  project.write("sub/index.md", "# 下の index\n");
  assert.equal(project.run(complete({ path: "sub/index.md" })).phase, "review", "タスクの index.md 以外の index.md は通常の資料");
}));

test("自己レビュー・AI の受入確認・工程の飛ばし・担当でない actor の操作を拒否する", withProject((project) => {
  project.create("research");
  // 工程の飛ばし
  project.write("01-plan.md", handoff());
  project.rejects({ kind: "complete", actor: "agent/codex", refs: [{ path: "01-plan.md" }] }, "WF_STATE"); // 引き受ける前の完了
  project.rejects({ kind: "decide", actor: "agent/codex", outcome: "approved", refs: [{ path: "01-plan.md" }] }, "WF_PHASE"); // 計画を判定で終える
  project.rejects({ kind: "resume", actor: "agent/codex" }, "WF_STATE");
  project.rejects({ kind: "reopen", actor: "agent/codex", returnTo: "execute", reason: "やり直す" }, "WF_PHASE"); // 後ろの工程へ
  project.run({ kind: "claim", actor: "agent/codex" });
  project.rejects({ kind: "claim", actor: "agent/other" }, "WF_STATE"); // 引受済みを横取りしない
  project.rejects({ kind: "complete", actor: "agent/other", refs: [{ path: "01-plan.md" }] }, "WF_NOT_ASSIGNEE");
  project.run({ kind: "complete", actor: "agent/codex", refs: [{ path: "01-plan.md" }] });
  project.write("02-handoff.md", handoff());
  project.run({ kind: "claim", actor: "agent/claude" });
  project.run({ kind: "complete", actor: "agent/claude", refs: [{ path: "02-handoff.md" }] });
  project.write("03-review.md", "# レビュー\n");
  // 自己レビュー: 引受・担当の割当・判定のどれでも拒否する
  project.rejects({ kind: "claim", actor: "agent/claude" }, "WF_SEPARATION");
  project.rejects({ kind: "assign", phase: "review", assignee: "agent/claude", by: "human/saiki", reason: "頼む" }, "WF_SEPARATION");
  project.rejects({ kind: "complete", actor: "agent/claude", refs: [{ path: "02-handoff.md" }] }, "WF_PHASE"); // レビューを complete で終えない
  project.run({ kind: "claim", actor: "agent/codex" });
  project.run({ kind: "decide", actor: "agent/codex", outcome: "approved", refs: [{ path: "03-review.md" }] });
  // AI の受入確認
  project.write("04-acceptance.md", "# 受入確認\n");
  project.rejects({ kind: "claim", actor: "agent/codex" }, "WF_HUMAN");
  project.rejects({ kind: "assign", phase: "acceptance", assignee: "agent/codex", by: "human/saiki", reason: "代理" }, "WF_HUMAN");
  project.rejects({ kind: "assign", phase: "acceptance", assignee: "human/other", by: "agent/codex", reason: "代理" }, "WF_HUMAN");
  project.run({ kind: "claim", actor: "human/saiki" });
  project.rejects({ kind: "decide", actor: "agent/codex", outcome: "approved", refs: [{ path: "04-acceptance.md" }] }, "WF_NOT_ASSIGNEE");
  project.rejects({ kind: "decide", actor: "human/saiki", outcome: "approved", refs: [{ path: "none.md" }] }, "WF_REPORT");
  project.rejects({ kind: "decide", actor: "human/saiki", outcome: "changes_requested", refs: [{ path: "04-acceptance.md" }] }, "WF_USAGE"); // 戻す工程が無い
  project.rejects({ kind: "decide", actor: "human/saiki", outcome: "approved", refs: [{ path: "04-acceptance.md" }], returnTo: "execute" }, "WF_USAGE");
  // 形式の誤り
  project.rejects({ kind: "claim", actor: "codex" }, "WF_ACTOR");
}));

test("レビューの差戻しで実行の新しい試行になり、古い承認は流用できない。計画へ戻すと要件の版が上がる", withProject((project) => {
  project.create("implementation");
  throughExecute(project, "implementation");
  project.write("03-review.md", "# レビュー\n\nR-1\n");
  project.run({ kind: "claim", actor: "agent/codex" });
  let task = project.run({ kind: "decide", actor: "agent/codex", outcome: "changes_requested", refs: [{ path: "03-review.md" }], returnTo: "execute", reason: "R-1 の修正" });
  assert.equal(task.phase, "execute");
  assert.deepEqual([task.workflow.execute.status, task.workflow.execute.attempt, task.workflow.execute.assignee], ["ready", 2, "agent/claude"], "担当は保つ");
  assert.deepEqual([task.workflow.review.status, task.workflow.review.attempt], ["waiting", 2]);
  assert.equal(task.workflow.acceptance.attempt, 1, "動いていない工程の試行は上げない");
  assert.deepEqual(task.history.slice(-2).map((entry) => [entry.event, entry.phase, entry.outcome, entry.refersTo]), [
    ["decide", "review", "changes_requested", null],
    ["reopen", "execute", null, task.history.at(-2)!.seq],
  ]);
  const firstComplete = task.history.find((entry) => entry.event === "complete" && entry.phase === "execute")!;
  assert.equal(firstComplete.attempt, 1, "前の試行の完了は履歴に残る");
  // 古いレビューを再利用できない (レビューは waiting)
  project.rejects({ kind: "decide", actor: "agent/codex", outcome: "approved", refs: [{ path: "03-review.md" }] }, "WF_PHASE");
  project.run({ kind: "claim", actor: "agent/claude" });
  project.write("05-fix.md", handoff("修正"));
  task = project.run({ kind: "complete", actor: "agent/claude", refs: [{ path: "05-fix.md" }, { repo: "project_template", commit: "abcdef0" }] });
  assert.equal(task.workflow.review.inputSeq, task.history.at(-1)!.seq, "新しいレビューは新しい実行の完了を受け取る");
  // 計画へ戻す (人から要件の変更)
  task = project.run({ kind: "reopen", actor: "human/saiki", returnTo: "plan", reason: "受入基準を追加" });
  assert.equal(task.requirementRevision, 2);
  assert.equal(task.phase, "plan");
  assert.deepEqual([task.workflow.plan.status, task.workflow.plan.attempt, task.workflow.plan.inputRevision], ["ready", 2, 2]);
  assert.deepEqual([task.workflow.execute.status, task.workflow.execute.attempt], ["waiting", 3]);
  assert.deepEqual(task.history.slice(-2).map((entry) => entry.event), ["revise", "reopen"]);
  assert.deepEqual(readTaskFile(project.read()).issues, []);
}));

test("担当の交代は履歴に残り、作業中の交代は引継資料が必要で ready に戻って次の担当が引き受ける", withProject((project) => {
  project.create("research");
  project.write("01-plan.md", handoff());
  project.run({ kind: "assign", phase: "review", assignee: "agent/codex", by: "human/saiki", reason: "レビュー担当を先に決める" });
  project.run({ kind: "claim", actor: "agent/one" });
  project.rejects({ kind: "assign", phase: "plan", assignee: "agent/two", by: "human/saiki", reason: "交代" }, "WF_HANDOFF");
  project.rejects({ kind: "assign", phase: "plan", assignee: "agent/one", by: "human/saiki", reason: "同じ" }, "WF_NOOP");
  project.rejects({ kind: "assign", phase: "plan", assignee: "agent/two", by: "human/saiki", reason: "" }, "WF_REASON");
  project.write("handover.md", handoff("交代の引継ぎ"));
  let task = project.run({ kind: "assign", phase: "plan", assignee: "agent/two", by: "human/saiki", reason: "担当の交代", handoff: { path: "handover.md" } });
  assert.deepEqual([task.workflow.plan.status, task.workflow.plan.assignee], ["ready", "agent/two"]);
  const assign = task.history.at(-1)!;
  assert.deepEqual([assign.event, assign.from, assign.to, assign.reason, assign.refs], ["assign", "agent/one", "agent/two", "担当の交代", [{ path: "handover.md" }]]);
  project.rejects({ kind: "claim", actor: "agent/one" }, "WF_NOT_ASSIGNEE", undefined);
  task = project.run({ kind: "claim", actor: "agent/two" });
  assert.equal(task.workflow.plan.status, "progress");
  assert.equal(task.history.filter((entry) => entry.event === "claim").length, 2, "前の担当の引受も残る");
}));

test("QA 待ちは blockedBy が必要で、QA が解決するまで再開できない", withProject((project) => {
  project.create("implementation");
  project.write("01-plan.md", handoff());
  project.run({ kind: "claim", actor: "agent/codex" });
  const added = raprid(project.root, ["qa", "add", job, "scope", "internal", "範囲はこれでよいか", "--requested-by", "agent/codex", "--created-by", "agent/codex"]);
  assert.equal(added.status, 0, added.stderr);
  project.rejects({ kind: "block", actor: "agent/codex", blockedBy: [] }, "WF_BLOCKED_BY");
  project.rejects({ kind: "block", actor: "agent/other", blockedBy: ["qa/Q-001"] }, "WF_NOT_ASSIGNEE");
  let task = project.run({ kind: "block", actor: "agent/codex", blockedBy: ["qa/Q-001", "other: 権限の付与, 予算"] });
  assert.equal(task.workflow.plan.status, "pending");
  assert.deepEqual(task.blockedBy, ["qa/Q-001", "other: 権限の付与, 予算"]);
  project.rejects({ kind: "complete", actor: "agent/codex", refs: [{ path: "01-plan.md" }] }, "WF_STATE");
  project.rejects({ kind: "resume", actor: "agent/codex" }, "BLOCKED_BY_QA");
  const resolved = raprid(project.root, ["qa", "resolve", job, "Q-001", "この範囲でよい", "--answered-by", "human/saiki"]);
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(project.data().workflow.plan.status, "pending", "QA の解決で自動的には再開しない");
  task = project.run({ kind: "resume", actor: "agent/codex" });
  assert.deepEqual([task.workflow.plan.status, task.blockedBy], ["progress", []]);
  assert.deepEqual(task.history.slice(-2).map((entry) => entry.event), ["block", "resume"]);
}));

test("closed のタスクを開き直せるのは人だけで、実行からやり直すと計画の版を保つ", withProject((project) => {
  project.create("research");
  throughExecute(project, "research");
  project.write("03-review.md", "# レビュー\n");
  project.write("04-acceptance.md", "# 受入確認\n");
  project.run({ kind: "claim", actor: "agent/codex" });
  project.run({ kind: "decide", actor: "agent/codex", outcome: "approved", refs: [{ path: "03-review.md" }] });
  project.run({ kind: "claim", actor: "human/saiki" });
  project.run({ kind: "decide", actor: "human/saiki", outcome: "approved", refs: [{ path: "04-acceptance.md" }] });
  project.rejects({ kind: "reopen", actor: "agent/codex", returnTo: "execute", reason: "追加調査" }, "WF_HUMAN");
  project.rejects({ kind: "assign", phase: "execute", assignee: "agent/x", by: "human/saiki", reason: "x" }, "WF_CLOSED");
  const task = project.run({ kind: "reopen", actor: "human/saiki", returnTo: "execute", reason: "追加の比較が必要" });
  assert.deepEqual([task.status, task.phase, task.completedAt, task.closureReason, task.requirementRevision], ["open", "execute", null, null, 1]);
  assert.deepEqual([task.workflow.execute.status, task.workflow.execute.attempt, task.workflow.review.attempt, task.workflow.acceptance.attempt], ["ready", 2, 2, 2]);
  assert.deepEqual(readTaskFile(project.read()).issues, []);
}));

test("revision を必須にし、古い revision では何も変えない。旧形式・v2・不整合のあるタスクは変更しない", withProject((project) => {
  project.create("research");
  const before = project.read();
  assert.throws(() => runTransition(project.root, job, name, undefined, { kind: "claim", actor: "agent/codex" }), (error: unknown) => error instanceof CliError && error.code === "REVISION_REQUIRED");
  assert.throws(() => runTransition(project.root, job, name, "abc", { kind: "claim", actor: "agent/codex" }), (error: unknown) => error instanceof CliError && error.code === "USAGE");
  const old = taskRevision(project.index());
  project.run({ kind: "claim", actor: "agent/codex" });
  assert.notEqual(project.read(), before);
  project.rejects({ kind: "claim", actor: "agent/other" }, "REVISION_CONFLICT", name, old);
  // ID でも探せる
  const byId = runTransition(project.root, job, "T-001", taskRevision(project.index()), { kind: "block", actor: "agent/codex", blockedBy: ["other: 確認待ち"] }, { clock: project.clock() });
  assert.equal(byId.task.workflow.plan.status, "pending");
  assert.equal(byId.revision, taskRevision(project.index()), "返す revision は書き込んだ index.md のもの");
  assert.deepEqual(byId.appended.map((entry) => entry.event), ["block"]);

  // v2 と旧形式は移行を案内して止める
  mkdirSync(project.dir("v2-task"), { recursive: true });
  writeFileSync(project.index("v2-task"), readFileSync(join(fixtures, "v2-new.md")));
  assert.match(project.rejects({ kind: "claim", actor: "agent/codex" }, "WF_NOT_V3", "v2-task").message, /移行/);
  // 旧形式のタスク (同じ案件に新形式のタスクがあると旧形式の task add は採番で止まるので、フィクスチャを置く。T-014 で扱う)
  mkdirSync(project.dir("old-task"), { recursive: true });
  writeFileSync(project.index("old-task"), readFileSync(join(fixtures, "legacy.md")));
  project.rejects({ kind: "claim", actor: "agent/codex" }, "WF_NOT_V3", "old-task");
  // 記録に不整合があるタスク
  project.create("research", "broken", "T-009");
  writeFileSync(project.index("broken"), project.read("broken").replace("phase: plan", "phase: review"));
  project.rejects({ kind: "claim", actor: "agent/codex" }, "WF_INVALID", "broken");
  assert.throws(() => runTransition(project.root, job, "missing", "0".repeat(64), { kind: "claim", actor: "agent/codex" }), (error: unknown) => error instanceof CliError && error.code === "TASK_NOT_FOUND");
}));

test("書き換えの途中で失敗 (YamlEditError・書き込みの失敗・遷移の結果の誤り) しても、状態・履歴に部分更新を残さない", withProject((project) => {
  project.create("implementation");
  project.run({ kind: "claim", actor: "agent/codex" });
  project.write("01-plan.md", handoff());
  // 状態を書いた後、履歴の追記で YamlEditError になる場合
  const original = YamlFrontmatter.prototype.set;
  YamlFrontmatter.prototype.set = function (path, value) {
    if (path[0] === "history") throw new YamlEditError("試験のための失敗");
    return original.call(this, path, value);
  };
  try {
    assert.match(project.rejects({ kind: "complete", actor: "agent/codex", refs: [{ path: "01-plan.md" }] }, "WF_WRITE").message, /試験のための失敗/);
  } finally {
    YamlFrontmatter.prototype.set = original;
  }
  // 遷移の結果が形式の規則を満たさない場合 (時計が壊れている)
  const before = project.read();
  assert.throws(
    () => runTransition(project.root, job, name, taskRevision(project.index()), { kind: "complete", actor: "agent/codex", refs: [{ path: "01-plan.md" }] }, { clock: { date: "2026-10-01", at: "not-a-date" } }),
    (error: unknown) => error instanceof CliError && error.code === "WF_INTERNAL",
  );
  assert.equal(project.read(), before);
  // 書き込みが失敗する場合 (権限に頼らずに失敗を注入する)
  assert.throws(
    () => runTransition(project.root, job, name, taskRevision(project.index()), { kind: "complete", actor: "agent/codex", refs: [{ path: "01-plan.md" }] }, { clock: project.clock(), indexFs: { ...defaultIndexFs, writeTemp: () => { throw new Error("ディスクがいっぱい (試験)"); } } }),
    /ディスクがいっぱい/,
  );
  assert.equal(project.read(), before);
  // 書き込めない場合 (実際の権限。root では権限で止まらないので飛ばす)
  if (process.getuid?.() !== 0) {
    chmodSync(project.dir(), 0o555);
    try {
      assert.throws(() => runTransition(project.root, job, name, taskRevision(project.index()), { kind: "complete", actor: "agent/codex", refs: [{ path: "01-plan.md" }] }, { clock: project.clock() }));
    } finally {
      chmodSync(project.dir(), 0o755);
    }
    assert.equal(project.read(), before);
  }
  // 失敗の後も通常どおり操作できる
  assert.equal(project.run({ kind: "complete", actor: "agent/codex", refs: [{ path: "01-plan.md" }] }).phase, "execute");
}));

function node(code: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const claimScript = (root: string, revision: string, actor: string) => `
import { runTransition } from ${JSON.stringify(taskflowPath)};
try {
  runTransition(${JSON.stringify(root)}, ${JSON.stringify(job)}, ${JSON.stringify(name)}, ${JSON.stringify(revision)}, { kind: "claim", actor: ${JSON.stringify(actor)} });
  console.log("ok");
} catch (error) {
  console.log(error.code ?? String(error));
}`;

test("同じ ready を 2 つの担当が同時に引き受けると、一方だけが成功する", withProject(async (project) => {
  for (let round = 0; round < 4; round++) {
    project.create("research");
    const revision = taskRevision(project.index());
    const results = await Promise.all([node(claimScript(project.root, revision, "agent/one")), node(claimScript(project.root, revision, "agent/two"))]);
    for (const result of results) assert.equal(result.stderr, "");
    const outcomes = results.map((result) => result.stdout.trim()).sort();
    assert.deepEqual(outcomes, ["REVISION_CONFLICT", "ok"], `round ${round}`);
    const task = project.data();
    assert.equal(task.workflow.plan.status, "progress");
    assert.equal(task.history.filter((entry) => entry.event === "claim").length, 1, "引受の履歴は 1 件");
    assert.equal(task.workflow.plan.assignee, results[0].stdout.trim() === "ok" ? "agent/one" : "agent/two", "成功した方が担当になる");
  }
}));

test("操作はロックの中で読み直す: 他のプロセスがロック中に変えた内容を、古い revision で上書きしない", withProject(async (project) => {
  project.create("research");
  const revision = taskRevision(project.index());
  const signal = join(project.root, "held");
  const holder = node(`
import { withJobLocks } from ${JSON.stringify(jobsPath)};
import { appendFileSync, writeFileSync } from "node:fs";
withJobLocks(${JSON.stringify(project.root)}, [${JSON.stringify(job)}], () => {
  writeFileSync(${JSON.stringify(signal)}, "held");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
  appendFileSync(${JSON.stringify(project.index())}, "\\n追記\\n");
});
console.log("released");`);
  for (let waited = 0; !existsSync(signal) && waited < 5000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(existsSync(signal), "ロックを持つプロセスが始まらない");
  const started = Date.now();
  const claim = await node(claimScript(project.root, revision, "agent/one"));
  assert.equal(claim.stdout.trim(), "REVISION_CONFLICT", claim.stderr);
  assert.ok(Date.now() - started >= 300, "ロックが外れるまで待つ");
  assert.equal((await holder).stdout.trim(), "released");
  assert.equal(project.data().workflow.plan.status, "ready");
  assert.match(project.read(), /\n追記\n$/, "ロック中の変更は残る");
}));
