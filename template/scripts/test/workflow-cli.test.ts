// 工程型タスク (workflowVersion 3) の CLI・JSON・作業索引の試験。T-014
// 一時プロジェクトで CLI (scripts/cli.ts) を別プロセスとして実行する。索引の更新の失敗の注入だけはサービスを直接呼ぶ。

import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CliError } from "../lib/errors.ts";
import { runTransition, taskRevision } from "../lib/taskflow.ts";
import { defaultIndexFs, workIndexPhases, workIndexStatuses } from "../lib/workindex.ts";
import { raprid, rapridAsync, snapshot } from "./helpers.ts";

const job = "PROJ";
const handoff = (title: string) => `# ${title}\n\n## 対象・成果物\n\n- x\n\n## 実施・検証\n\n- y\n\n## 未確認・制約\n\n- なし\n\n## 次の担当への依頼\n\n- z\n`;

class Project {
  readonly root = mkdtempSync(join(tmpdir(), "raprid-workflow-cli-"));

  constructor() {
    mkdirSync(join(this.root, "jobs"));
    this.ok(["job", "create", job]);
    mkdirSync(join(this.root, "repos", "project_template"), { recursive: true });
  }

  run(args: string[]) {
    return raprid(this.root, args);
  }

  ok(args: string[]): string {
    const result = this.run(args);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
    return result.stdout;
  }

  json(args: string[]): Record<string, any> {
    const result = this.run([...args, "--json"]);
    return JSON.parse(result.stdout) as Record<string, any>;
  }

  // 失敗して code が一致し、プロジェクト全体 (ロックを除く) が変わらないこと
  fails(args: string[], code: string, status = 1): Record<string, any> {
    const before = this.snapshot();
    const result = this.run([...args, "--json"]);
    const body = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(result.status, status, `${args.join(" ")}\n${result.stdout}`);
    assert.equal(body.error?.code, code, `${args.join(" ")}\n${result.stdout}`);
    assert.deepEqual(this.snapshot(), before, `${args.join(" ")}: 失敗したら何も変えない`);
    return body;
  }

  // --json の無い旧形式のコマンドの失敗: 終了コードとメッセージを確かめ、何も変えないこと
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

  revision(selector: string): string {
    return this.json(["task", "show", job, selector, "--schema-version", "2"]).item.revision as string;
  }

  item(selector: string): Record<string, any> {
    return this.json(["task", "show", job, selector, "--schema-version", "2"]).item as Record<string, any>;
  }

  // 工程の操作を --if-match つきで行い、schemaVersion 2 の結果を返す
  step(args: string[], selector: string): Record<string, any> {
    const [command, ...rest] = args;
    const result = this.run(["task", command, job, selector, ...rest, "--if-match", this.revision(selector), "--json"]);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
    const body = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(body.schemaVersion, 2);
    assert.equal(body.ok, true);
    return body;
  }

  // 作業索引に置かれているこのタスクのリンク
  links(name: string): { path: string; target: string }[] {
    const found: { path: string; target: string }[] = [];
    for (const phase of workIndexPhases) {
      for (const status of workIndexStatuses) {
        const path = join(this.root, "jobs", job, "status", phase, status, name);
        if (existsSync(path) || isLink(path)) found.push({ path: `${phase}/${status}`, target: readlinkSync(path) });
      }
    }
    return found;
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

function oneLink(project: Project, name: string, where: string): void {
  assert.deepEqual(project.links(name), [{ path: where, target: `../../../tasks/${name}` }], `${name} の作業索引は ${where} の 1 件`);
}

test("task add --type で種別つきの v3 のタスクを作り、status/plan/ready に索引を張る。種別の誤り・別名は何も作らない", withProject((project) => {
  project.ok(["task", "add", job, "old", "todo", "旧形式", "--requested-by", "human/saiki", "--created-by", "agent/codex"]);
  const created = project.json(["task", "add", job, "research-a", "--type", "research", "調査する", "--requested-by", "human/saiki", "--created-by", "agent/codex"]);
  assert.equal(created.schemaVersion, 2);
  assert.deepEqual([created.item.id, created.item.workflowVersion, created.item.type, created.item.status, created.item.phase, created.item.phaseStatus], ["T-002", 3, "research", "open", "plan", "ready"]);
  oneLink(project, "research-a", "plan/ready");
  const text = readFileSync(join(project.dir("research-a"), "index.md"), "utf8");
  assert.match(text, /^---\nid: T-002\nworkflowVersion: 3\ntype: research\n/);
  assert.match(text, /\n## タイトル\n\n調査する\n/);
  assert.equal(created.item.revision, taskRevision(join(project.dir("research-a"), "index.md")));
  project.ok(["task", "add", job, "impl-b", "--type", "implementation", "実装する", "--requested-by", "human/saiki", "--created-by", "agent/codex"]);
  // 採番は旧形式と v3 の ID を両方数える
  assert.match(project.ok(["task", "add", job, "old-2", "todo", "旧形式 2", "--requested-by", "human/saiki", "--created-by", "agent/codex"]), /T-004/);
  for (const type of ["search", "implement", "Research", ""]) project.fails(["task", "add", job, "bad", "--type", type, "x", "--requested-by", "human/saiki", "--created-by", "agent/codex"], "USAGE", 2);
  project.fails(["task", "add", job, "bad", "todo", "x", "--type", "research", "--requested-by", "human/saiki", "--created-by", "agent/codex"], "USAGE", 2); // 状態の引数は取らない
  project.fails(["task", "add", job, "research-a", "--type", "research", "x", "--requested-by", "human/saiki", "--created-by", "agent/codex"], "FAILED"); // 同名
}));

test("CLI から計画 → 実行 → レビュー → 受入確認まで進め、差戻し・閉じる・開き直すで作業索引が常に 1 件 (closed は 0 件)", withProject((project) => {
  project.ok(["task", "add", job, "impl", "--type", "implementation", "実装する", "--requested-by", "human/saiki", "--created-by", "agent/codex"]);
  const name = "impl";
  project.write(name, "01-plan.md", handoff("計画"));
  project.step(["claim", "--actor", "agent/codex"], "T-001");
  oneLink(project, name, "plan/progress");
  project.step(["complete", "--actor", "agent/codex", "--handoff", "01-plan.md"], "T-001");
  oneLink(project, name, "execute/ready");
  project.write(name, "02-handoff.md", handoff("実行"));
  project.step(["assign", "execute", "agent/claude", "--by", "human/saiki", "--reason", "実装を頼む"], "T-001");
  project.step(["claim", "--actor", "agent/claude"], "T-001");
  const done = project.step(["complete", "--actor", "agent/claude", "--handoff", "02-handoff.md", "--commit", "project_template:873ca38"], "T-001");
  assert.deepEqual(done.item.workflow.execute.artifactRefs, [{ path: "02-handoff.md" }, { repo: "project_template", commit: "873ca38" }]);
  oneLink(project, name, "review/ready");
  // レビューで差し戻す
  project.write(name, "03-review.md", "# レビュー\n\nR-1\n");
  project.step(["claim", "--actor", "agent/codex"], "T-001");
  const returned = project.step(["decide", "changes_requested", "--actor", "agent/codex", "--report", "03-review.md", "--return-to", "execute", "--reason", "R-1"], "T-001");
  assert.deepEqual(returned.appended.map((entry: { event: string }) => entry.event), ["decide", "reopen"]);
  oneLink(project, name, "execute/ready");
  project.step(["claim", "--actor", "agent/claude"], "T-001");
  project.step(["block", "--actor", "agent/claude", "--blocked-by", "other: 環境の準備"], "T-001");
  oneLink(project, name, "execute/pending");
  project.step(["resume", "--actor", "agent/claude"], "T-001");
  project.write(name, "04-fix.md", handoff("修正"));
  project.step(["complete", "--actor", "agent/claude", "--handoff", "04-fix.md", "--artifact", "03-review.md"], "T-001");
  project.step(["claim", "--actor", "agent/codex"], "T-001");
  project.step(["decide", "approved", "--actor", "agent/codex", "--report", "03-review.md"], "T-001");
  oneLink(project, name, "acceptance/ready");
  // AI は受入確認できない
  project.fails(["task", "claim", job, "T-001", "--actor", "agent/codex", "--if-match", project.revision("T-001")], "WF_HUMAN");
  project.write(name, "05-acceptance.md", "# 受入確認\n\n受け入れる\n");
  project.step(["claim", "--actor", "human/saiki"], "T-001");
  const closed = project.step(["decide", "approved", "--actor", "human/saiki", "--report", "05-acceptance.md"], "T-001");
  assert.deepEqual([closed.item.status, closed.item.phase, closed.item.closureReason], ["closed", null, "accepted"]);
  assert.deepEqual(project.links(name), [], "closed のタスクは作業索引が 0 件");
  assert.deepEqual(closed.issues, []);
  // 人が開き直すと、戻す工程の ready に索引が戻る
  project.step(["reopen", "--return-to", "execute", "--actor", "human/saiki", "--reason", "追加の修正"], "T-001");
  oneLink(project, name, "execute/ready");
  assert.deepEqual(project.json(["task", "list", job, "--schema-version", "2"]).issues, []);
}));

test("工程の操作はすべて --if-match と --actor が必要で、古い revision・JSON の失敗は schemaVersion 2 で何も変えない", withProject(async (project) => {
  project.ok(["task", "add", job, "a", "--type", "research", "調査", "--requested-by", "human/saiki", "--created-by", "agent/codex"]);
  const revision = project.revision("T-001");
  for (const args of [
    ["claim", "--actor", "agent/codex"],
    ["assign", "plan", "agent/x", "--by", "human/saiki", "--reason", "r"],
    ["complete", "--actor", "agent/codex", "--handoff", "x.md"],
    ["decide", "approved", "--actor", "agent/codex", "--report", "x.md"],
    ["block", "--actor", "agent/codex", "--blocked-by", "other: x"],
    ["resume", "--actor", "agent/codex"],
    ["reopen", "--return-to", "plan", "--actor", "human/saiki", "--reason", "r"],
  ]) {
    const body = project.fails(["task", args[0], job, "T-001", ...args.slice(1)], "REVISION_REQUIRED", 2);
    assert.equal(body.schemaVersion, 2, `${args[0]} の失敗も schemaVersion 2`);
  }
  // --actor を環境変数から補わない
  project.fails(["task", "claim", job, "T-001", "--if-match", revision], "USAGE", 2);
  project.ok(["task", "claim", job, "T-001", "--actor", "agent/codex", "--if-match", revision]);
  project.fails(["task", "block", job, "T-001", "--actor", "agent/codex", "--blocked-by", "other: x", "--if-match", revision], "REVISION_CONFLICT");
  // 同じ ready を 2 つのプロセスの CLI から同時に引き受けると一方だけが成功する
  project.ok(["task", "add", job, "b", "--type", "research", "調査 2", "--requested-by", "human/saiki", "--created-by", "agent/codex"]);
  const shared = project.revision("T-002");
  const results = await Promise.all(["agent/one", "agent/two"].map((actor) => rapridAsync(project.root, ["task", "claim", job, "T-002", "--actor", actor, "--if-match", shared, "--json"])));
  const codes = results.map((result) => (JSON.parse(result.stdout) as { ok?: boolean; error?: { code: string } })).map((body) => (body.ok ? "ok" : body.error!.code)).sort();
  assert.deepEqual(codes, ["REVISION_CONFLICT", "ok"]);
  oneLink(project, "b", "plan/progress");
}));

test("作業索引の更新に失敗したら index.md と索引の両方を戻し、索引の衝突・重複は何も変えずに止める", withProject((project) => {
  project.ok(["task", "add", job, "a", "--type", "research", "調査", "--requested-by", "human/saiki", "--created-by", "agent/codex"]);
  const index = join(project.dir("a"), "index.md");
  const attempt = (fs = defaultIndexFs) => runTransition(project.root, job, "a", taskRevision(index), { kind: "claim", actor: "agent/codex" }, { indexFs: fs });
  const before = project.snapshot();
  // リンクを移した後、index.md の置き換えで失敗する
  let renames = 0;
  assert.throws(() => attempt({ ...defaultIndexFs, rename: (from, to) => (++renames === 2 ? (() => { throw new Error("置き換えの失敗 (試験)"); })() : defaultIndexFs.rename(from, to)) }), /置き換えの失敗/);
  assert.deepEqual(project.snapshot(), before, "index.md とリンクの両方が元のまま");
  // リンクの移動そのものが失敗する
  assert.throws(() => attempt({ ...defaultIndexFs, rename: () => { throw new Error("リンクの移動の失敗 (試験)"); } }), /リンクの移動の失敗/);
  assert.deepEqual(project.snapshot(), before);
  // 移し先に別のものがある (衝突)
  mkdirSync(join(project.root, "jobs", job, "status", "plan", "progress"), { recursive: true });
  writeFileSync(join(project.root, "jobs", job, "status", "plan", "progress", "a"), "別のファイル");
  const collision = project.snapshot();
  assert.throws(attempt, (error: unknown) => error instanceof CliError && error.code === "WF_INDEX");
  assert.deepEqual(project.snapshot(), collision);
  unlinkSync(join(project.root, "jobs", job, "status", "plan", "progress", "a"));
  // 索引が重複している
  symlinkSync("../../../tasks/a", join(project.root, "jobs", job, "status", "plan", "progress", "a"));
  const duplicate = project.snapshot();
  assert.throws(attempt, (error: unknown) => error instanceof CliError && error.code === "WF_INDEX");
  assert.deepEqual(project.snapshot(), duplicate);
  unlinkSync(join(project.root, "jobs", job, "status", "plan", "progress", "a"));
  // 索引が無ければ作り直す (実体が正)
  unlinkSync(join(project.root, "jobs", job, "status", "plan", "ready", "a"));
  attempt();
  oneLink(project, "a", "plan/progress");
}));

test("一覧・診断: 作業索引の不整合を推測せずに報告する", withProject((project) => {
  project.ok(["task", "add", job, "a", "--type", "research", "調査", "--requested-by", "human/saiki", "--created-by", "agent/codex"]);
  project.ok(["task", "add", job, "old", "todo", "旧形式", "--requested-by", "human/saiki", "--created-by", "agent/codex"]);
  const codes = () => (project.json(["task", "list", job, "--schema-version", "2"]).issues as { code: string; path: string }[]).map((issue) => `${issue.code} ${issue.path}`).sort();
  assert.deepEqual(codes(), []);
  const status = join(project.root, "jobs", job, "status");
  unlinkSync(join(status, "plan", "ready", "a"));
  assert.deepEqual(codes(), ["LINK_MISSING jobs/PROJ/tasks/a/index.md"]);
  mkdirSync(join(status, "execute", "ready"), { recursive: true });
  symlinkSync("../../../tasks/a", join(status, "execute", "ready", "a"));
  assert.deepEqual(codes(), ["LINK_MISMATCH jobs/PROJ/status/execute/ready/a"], "工程の違うリンク");
  unlinkSync(join(status, "execute", "ready", "a"));
  symlinkSync("../../tasks/a", join(status, "plan", "ready", "a"));
  assert.deepEqual(codes(), ["LINK_TARGET_INVALID jobs/PROJ/status/plan/ready/a"]);
  unlinkSync(join(status, "plan", "ready", "a"));
  symlinkSync("../../../tasks/a", join(status, "plan", "ready", "a"));
  symlinkSync("../../tasks/a", join(status, "todo", "a"));
  assert.deepEqual(codes(), ["LINK_MISMATCH jobs/PROJ/status/todo/a"], "v3 が旧形式の状態索引にある");
  unlinkSync(join(status, "todo", "a"));
  symlinkSync("../../../tasks/old", join(status, "plan", "ready", "old"));
  assert.ok(codes().includes("LINK_MISMATCH jobs/PROJ/status/plan/ready/old"), "旧形式が作業索引にある");
  unlinkSync(join(status, "plan", "ready", "old"));
  symlinkSync("../../../tasks/none", join(status, "plan", "ready", "none"));
  assert.deepEqual(codes(), ["LINK_ORPHAN jobs/PROJ/status/plan/ready/none"]);
}));

test("task add --type は作業索引・旧形式の索引のどこかに同名の残りがあれば、実体を作らずに止める (R14-1)", withProject((project) => {
  const status = join(project.root, "jobs", job, "status");
  const add = () => project.fails(["task", "add", job, "dup", "--type", "research", "重複索引", "--requested-by", "human/saiki", "--created-by", "agent/codex"], "FAILED");
  // レビューの再現例: status/plan/done/dup に同名の孤立リンク
  for (const [phase, state] of [["plan", "done"], ["implement", "waiting"], ["execute", "ready"], ["acceptance", "progress"]]) {
    mkdirSync(join(status, phase, state), { recursive: true });
    symlinkSync("../../../tasks/dup", join(status, phase, state, "dup"));
    assert.match(add().error.message, /同名/);
    unlinkSync(join(status, phase, state, "dup"));
  }
  // 通常のファイル
  mkdirSync(join(status, "review", "pending"), { recursive: true });
  writeFileSync(join(status, "review", "pending", "dup"), "ファイル");
  add();
  unlinkSync(join(status, "review", "pending", "dup"));
  // 旧形式の索引
  symlinkSync("../../tasks/dup", join(status, "todo", "dup"));
  add();
  unlinkSync(join(status, "todo", "dup"));
  project.ok(["task", "add", job, "dup", "--type", "research", "重複索引", "--requested-by", "human/saiki", "--created-by", "agent/codex"]);
  oneLink(project, "dup", "plan/ready");
}));

test("読めない工程型タスク (壊れた v2・v3) も schemaVersion 1 の出力を止める (R14-2)", withProject((project) => {
  project.ok(["task", "add", job, "old", "todo", "旧形式", "--requested-by", "human/saiki", "--created-by", "agent/codex"]);
  project.ok(["task", "add", job, "new", "--type", "research", "工程型", "--requested-by", "human/saiki", "--created-by", "agent/codex"]);
  const index = join(project.dir("new"), "index.md");
  // レビューの再現例: 2 つ目の workflowVersion を入れて YAML として読めなくする
  writeFileSync(index, readFileSync(index, "utf8").replace("workflowVersion: 3\n", "workflowVersion: 3\nworkflowVersion: 3\n"));
  for (const args of [["task", "list", job, "--all"], ["task", "show", job, "new"], ["ui", "snapshot", job], ["job", "list"]]) project.fails(args, "SCHEMA_V2_REQUIRED");
  const listed = project.json(["task", "list", job, "--all", "--schema-version", "2"]);
  const broken = (listed.items as { name: string; workflowVersion: unknown; valid?: boolean; readable?: boolean }[]).find((item) => item.name === "new")!;
  assert.deepEqual([broken.workflowVersion, broken.valid, broken.readable], [3, false, false], "読めない工程型は版を保ったまま不整合として出す");
  assert.ok((listed.issues as { code: string }[]).some((issue) => issue.code === "PARSE_ERROR"));
  // 壊れた v2 も同じ
  mkdirSync(project.dir("v2-broken"));
  writeFileSync(join(project.dir("v2-broken"), "index.md"), "---\nid: T-099\nworkflowVersion: 2\nworkflow: [\n---\n");
  writeFileSync(index, readFileSync(index, "utf8").replace("workflowVersion: 3\nworkflowVersion: 3\n", "workflowVersion: 3\n"));
  project.fails(["task", "list", job, "--all"], "SCHEMA_V2_REQUIRED");
  // 工程型の表示で、読めないものは形式の不整合として止まらずに出る
  assert.match(project.ok(["task", "list", job, "--all", "--width", "100"]), /v2-broken|T-099/);
}));

test("引用符付き・字下げ付きの workflowVersion のキーや構文の誤りがあっても、工程型を旧形式として扱わない (R14-3)", withProject((project) => {
  project.ok(["task", "add", job, "old", "todo", "旧形式", "--requested-by", "human/saiki", "--created-by", "agent/codex"]);
  project.ok(["task", "add", job, "quoted", "--type", "research", "確認", "--requested-by", "human/saiki", "--created-by", "agent/codex"]);
  const index = join(project.dir("quoted"), "index.md");
  const original = readFileSync(index, "utf8");
  const v1 = [["task", "list", job, "--all"], ["task", "show", job, "quoted"], ["ui", "snapshot", job], ["job", "list"]];
  for (const [label, text, readable] of [
    ["引用符付きのキー (レビューの再現例)", original.replace("workflowVersion: 3\n", '"workflowVersion": 3\n'), true],
    ["単一引用符のキー", original.replace("workflowVersion: 3\n", "'workflowVersion': 3\n"), true],
    ["字下げ付きのキー", original.replace("workflowVersion: 3\n", "  workflowVersion: 3\n"), false],
    ["引用符付きのキーと構文の誤り", original.replace("workflowVersion: 3\n", '"workflowVersion": 3\nstatus: [\n'), false],
    ["フロー形式の対応表の中", original.replace("workflowVersion: 3\n", "{ workflowVersion: 3 }\n"), false],
    ["値が空の workflowVersion", original.replace("workflowVersion: 3\n", "workflowVersion:\n"), true],
    ["Unicode エスケープのキー (R14-4 の再現例)", original.replace("workflowVersion: 3\n", '"workflow\\u0056ersion": 3\n'), true],
    ["アンカーを付けたキー (YAML として読まない書式)", original.replace("workflowVersion: 3\n", "&k workflowVersion: 3\n"), false],
    ["16 進エスケープのキーと構文の誤り", original.replace("workflowVersion: 3\n", '"workflow\\x56ersion": 3\nstatus: [\n'), false],
  ] as const) {
    writeFileSync(index, text);
    for (const args of v1) project.fails(args, "SCHEMA_V2_REQUIRED");
    const item = (project.json(["task", "list", job, "--all", "--schema-version", "2"]).items as { name: string; workflowVersion: unknown; readable?: boolean }[]).find((entry) => entry.name === "quoted")!;
    assert.equal(item.readable, readable, label);
    if (readable && !label.startsWith("値が空")) assert.equal(item.workflowVersion, 3, label);
    // 書き込みの入口も旧形式として扱わない (move は工程型として拒否、読めないものは不整合で止まる)
    const moved = project.run(["task", "move", job, "quoted", "done", "--json"]);
    assert.equal(moved.status, 1, label);
    assert.ok(["WF_USE_WORKFLOW_COMMANDS", "WF_VERSION", "WF_READ"].includes((JSON.parse(moved.stdout) as { error: { code: string } }).error.code), `${label}: ${moved.stdout}`);
    assert.equal(readFileSync(index, "utf8"), text, `${label}: 書き換えない`);
  }
  writeFileSync(index, original);
  // 旧形式だけの案件は、frontmatter の値や本文に workflowVersion という文字があっても旧形式のまま (schemaVersion 1 で出る)
  project.ok(["job", "create", "ONLY-OLD"]);
  project.ok(["task", "add", "ONLY-OLD", "x", "todo", "workflowVersion の調査", "--requested-by", "human/saiki", "--created-by", "agent/codex"]);
  const legacy = join(project.root, "jobs", "ONLY-OLD", "tasks", "x", "index.md");
  writeFileSync(legacy, readFileSync(legacy, "utf8").replace("test: []", 'test: ["docs/workflowVersion.feature"]') + "\nworkflowVersion: 3 と本文に書いてある\n");
  const listed = project.json(["task", "list", "ONLY-OLD"]);
  assert.equal(listed.schemaVersion, 1);
  assert.equal(listed.items[0].status, "todo");
  project.ok(["task", "move", "ONLY-OLD", "T-001", "progress"]);
}));

test("一覧で種別・工程・状態・担当を表示・絞り込みでき、closed は --closed / --all で見える", withProject((project) => {
  project.ok(["task", "add", job, "old-done", "todo", "旧形式の完了", "--requested-by", "human/saiki", "--created-by", "agent/codex"]);
  project.ok(["task", "move", job, "T-001", "done"]);
  project.ok(["task", "add", job, "old-todo", "todo", "旧形式の未着手", "--requested-by", "human/saiki", "--created-by", "agent/codex"]);
  project.ok(["task", "add", job, "research", "--type", "research", "調査の実行中", "--requested-by", "human/saiki", "--created-by", "agent/codex"]);
  project.ok(["task", "add", job, "impl", "--type", "implementation", "実装の計画", "--requested-by", "human/saiki", "--created-by", "agent/codex"]);
  project.write("research", "01.md", handoff("計画"));
  project.step(["claim", "--actor", "agent/codex"], "T-003");
  project.step(["complete", "--actor", "agent/codex", "--handoff", "01.md"], "T-003");
  project.step(["claim", "--actor", "agent/claude"], "T-003");
  const ids = (args: string[]) => (project.json(["task", "list", job, "--schema-version", "2", ...args]).items as { id: string }[]).map((item) => item.id);
  assert.deepEqual(ids([]), ["T-003", "T-002", "T-004"], "既定は旧形式の done を隠す (工程型は今の工程の状態の順)");
  assert.deepEqual(ids(["--type", "research"]), ["T-003"]);
  assert.deepEqual(ids(["--phase", "plan"]), ["T-004"]);
  assert.deepEqual(ids(["--assignee", "agent/claude"]), ["T-003"]);
  assert.deepEqual(ids(["--status", "ready"]), ["T-004"]);
  assert.deepEqual(ids(["--status", "todo"]), ["T-002"]);
  assert.deepEqual(ids(["--closed"]), ["T-001"]);
  assert.deepEqual(ids(["--all"]), ["T-003", "T-002", "T-004", "T-001"]);
  const text = project.ok(["task", "list", job, "--width", "100"]);
  assert.match(text, /ID\s+種別\s+工程\s+状態\s+担当\s+タイトル/);
  assert.match(text, /T-002\s+-\s+未移行\s+todo\s+-\s+旧形式の未着手/);
  assert.match(text, /T-003\s+調査\s+execute\s+progress\s+agent\/claude\s+調査の実行中/);
  // 狭い幅・非 TTY でも列が落ちない
  const narrow = project.ok(["task", "list", job, "--width", "50"]);
  assert.match(narrow, /T-003\s+調査\s+execute\s+progress\s+agent\/claude/);
  const show = project.ok(["task", "show", job, "T-003", "--width", "100"]);
  assert.match(show, /種別\s+調査/);
  assert.match(show, /工程\s+execute progress \/ 担当 agent\/claude/);
  assert.match(show, / {2}plan\s+done \/ 試行 1 \/ 担当 agent\/codex \/ 完了 agent\/codex/);
  // 旧形式だけの案件の一覧は列を変えない
  project.ok(["job", "create", "ONLY-OLD"]);
  project.ok(["task", "add", "ONLY-OLD", "x", "todo", "旧形式", "--requested-by", "human/saiki", "--created-by", "agent/codex"]);
  assert.match(project.ok(["task", "list", "ONLY-OLD", "--width", "100"]), /^ONLY-OLD {2}1件表示 \/ 全1件\nID\s+状態\s+タイトル\n/);
  project.fails(["qa", "list", job, "--type", "research"], "USAGE", 2);
}));

test("既存の task move / ask / note は旧形式で従来どおり動き、工程型には安全に接続する", withProject((project) => {
  project.ok(["task", "add", job, "old", "todo", "旧形式", "--requested-by", "human/saiki", "--created-by", "agent/codex"]);
  project.ok(["task", "add", job, "new", "--type", "implementation", "工程型", "--requested-by", "human/saiki", "--created-by", "agent/codex"]);
  const v3Files = () => snapshot(project.root, (rel) => !rel.startsWith("jobs") || rel === "jobs/.locks" || (rel.startsWith("jobs/PROJ/tasks/") && !rel.startsWith("jobs/PROJ/tasks/new")) || rel.startsWith("jobs/PROJ/qa") || rel.startsWith("jobs/PROJ/status/todo") || rel.startsWith("jobs/PROJ/status/progress") || rel.startsWith("jobs/PROJ/status/pending") || rel.startsWith("jobs/PROJ/status/done"));
  const v3Before = v3Files();
  // 旧形式の操作
  project.ok(["task", "move", job, "T-001", "progress"]);
  project.ok(["task", "ask", job, "T-001", "old-q", "internal", "旧形式の質問", "--requested-by", "agent/codex", "--created-by", "agent/codex"]);
  project.ok(["task", "note", job, "T-001", "memo"]);
  assert.deepEqual(v3Files(), v3Before, "旧形式の操作で工程型のタスクと索引は変わらない");
  // 工程型への move は案内つきで拒否する
  const moved = project.fails(["task", "move", job, "T-002", "progress"], "WF_USE_WORKFLOW_COMMANDS");
  assert.match(moved.error.message, /task claim/);
  // 工程型への note は --if-match が必要で、frontmatter を変えない
  project.failsText(["task", "note", job, "T-002", "memo"], 2, /--if-match/);
  const index = join(project.dir("new"), "index.md");
  const stale = "0".repeat(64);
  project.failsText(["task", "note", job, "T-002", "memo", "--if-match", stale], 1, /競合/);
  const text = readFileSync(index, "utf8");
  project.ok(["task", "note", job, "T-002", "memo", "調べたこと", "--if-match", project.revision("T-002")]);
  const noted = readFileSync(index, "utf8");
  const frontmatter = (value: string) => value.slice(0, value.indexOf("\n---\n", 4) + 5);
  assert.equal(frontmatter(noted), frontmatter(text), "frontmatter は 1 バイトも変わらない");
  assert.match(noted, /## 詳細\n\n\* \[調べたこと\]\(01-memo\.md\)\n/);
  assert.ok(existsSync(join(project.dir("new"), "01-memo.md")));
  // 工程型への ask は QA を作って今の工程を待ちにする。--if-match が無い・古いときは QA を作らない
  project.write("new", "01-plan.md", handoff("計画"));
  project.step(["claim", "--actor", "agent/codex"], "T-002");
  project.failsText(["task", "ask", job, "T-002", "new-q", "internal", "範囲は", "--actor", "agent/codex", "--requested-by", "agent/codex", "--created-by", "agent/codex"], 2, /--if-match/);
  project.failsText(["task", "ask", job, "T-002", "new-q", "internal", "範囲は", "--actor", "agent/codex", "--requested-by", "agent/codex", "--created-by", "agent/codex", "--if-match", stale], 1, /競合/);
  project.failsText(["task", "ask", job, "T-002", "new-q", "internal", "範囲は", "--actor", "agent/other", "--requested-by", "agent/codex", "--created-by", "agent/codex", "--if-match", project.revision("T-002")], 1, /担当/);
  project.ok(["task", "ask", job, "T-002", "new-q", "internal", "範囲は", "--actor", "agent/codex", "--requested-by", "agent/codex", "--created-by", "agent/codex", "--if-match", project.revision("T-002")]);
  const asked = project.item("T-002");
  assert.deepEqual([asked.phaseStatus, asked.blockedBy], ["pending", ["qa/Q-002"]]);
  oneLink(project, "new", "plan/pending");
  assert.equal(project.json(["qa", "show", job, "Q-002"]).item.status, "unresolved");
  // v2 のタスクは読めるが、どの操作でも書き換えない
  mkdirSync(project.dir("v2-task"));
  writeFileSync(join(project.dir("v2-task"), "index.md"), readFileSync(join(import.meta.dirname, "fixtures", "workflow", "v2-new.md"), "utf8").replace("id: T-001", "id: T-099"));
  project.fails(["task", "move", job, "v2-task", "done"], "WF_NOT_V3");
  for (const args of [["task", "note", job, "v2-task", "memo"], ["task", "ask", job, "v2-task", "q3", "internal", "x", "--requested-by", "agent/codex", "--created-by", "agent/codex"]]) {
    project.failsText(args, 1, /workflowVersion 3 へ移行/);
  }
}));

test("版の交渉: capability を足し、protocol は 1 のまま。schemaVersion 1 の JSON は工程型のタスクがあると止まる", withProject((project) => {
  const capabilities = JSON.parse(project.ok(["--capabilities"])) as { schemaVersion: number; capabilities: string[] };
  assert.deepEqual(capabilities, { schemaVersion: 1, capabilities: ["query-v1", "guarded-write-v1", "query-v2", "workflow-v3", "query-v3", "workflow-v4"] });
  assert.equal((JSON.parse(project.ok(["--protocol"])) as { protocol: number }).protocol, 1, "委譲の約束は変えない");
  project.ok(["task", "add", job, "old", "todo", "旧形式", "--requested-by", "human/saiki", "--created-by", "agent/codex"]);
  const v1Only = project.json(["task", "list", job]);
  assert.equal(v1Only.schemaVersion, 1);
  assert.equal("workflowVersion" in v1Only.items[0], false, "旧形式だけなら schemaVersion 1 の項目は変わらない");
  project.ok(["task", "add", job, "new", "--type", "research", "工程型", "--requested-by", "human/saiki", "--created-by", "agent/codex"]);
  for (const args of [["task", "list", job], ["task", "show", job, "T-002"], ["ui", "snapshot"], ["job", "list"], ["task", "list"]]) {
    const body = project.fails(args, "SCHEMA_V2_REQUIRED");
    assert.equal(body.schemaVersion, 1);
    assert.match(body.error.message, /raprid を更新し、--schema-version 2/);
  }
  // 旧形式のタスクの show は schemaVersion 1 のまま使える
  assert.equal(project.json(["task", "show", job, "T-001"]).schemaVersion, 1);
  const snap = project.json(["ui", "snapshot", "--schema-version", "2"]);
  assert.equal(snap.schemaVersion, 2);
  assert.deepEqual(snap.tasks.map((item: { id: string; workflowVersion: number | null }) => [item.id, item.workflowVersion]), [["T-001", null], ["T-002", 3]]);
  assert.equal(project.json(["job", "list", "--schema-version", "2"]).schemaVersion, 2);
  // T-022: schemaVersion 3 (query-v3) は v2・v3・旧形式のタスクも読める。未知の版は引数の誤り
  assert.deepEqual(project.json(["task", "list", job, "--schema-version", "3"]).items.map((item: { id: string; workflowVersion: number | null; waiting: unknown }) => [item.id, item.workflowVersion, item.waiting]), [["T-001", null, null], ["T-002", 3, null]]);
  project.fails(["task", "list", job, "--schema-version", "4"], "USAGE", 2);
}));
