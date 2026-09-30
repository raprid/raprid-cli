// 旧形式・workflowVersion 2 から workflowVersion 3 への移行 (raprid job migrate-workflow) の試験。T-016
// 一時プロジェクトで CLI を別プロセスとして実行する。途中の失敗の注入だけは applyPlan を直接呼ぶ。

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { applyPlan, buildPlan, markerName, parseMap, restorePlan } from "../commands/migrate-workflow.ts";
import { CliError } from "../lib/errors.ts";
import { defaultIndexFs, type IndexFs } from "../lib/workindex.ts";
import { readTaskFile } from "../lib/workflow.ts";
import { YamlFrontmatter } from "../lib/yamlfront.ts";
import { raprid, snapshot } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures", "workflow");
const job = "PROJ";
const migrator = "human/saiki";

class Project {
  readonly root = mkdtempSync(join(tmpdir(), "raprid-migrate-workflow-"));
  readonly outside = mkdtempSync(join(tmpdir(), "raprid-migrate-workflow-map-")); // 対応表はプロジェクトの外に置く

  constructor() {
    mkdirSync(join(this.root, "jobs"));
    this.ok(["job", "create", job]);
  }

  run(args: string[]) {
    return raprid(this.root, args);
  }

  ok(args: string[]): string {
    const result = this.run(args);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
    return result.stdout;
  }

  // ロックを除くプロジェクト全体
  snapshot(): Record<string, string> {
    return snapshot(this.root, (rel) => rel === "jobs/.locks");
  }

  map(value: unknown): string {
    const path = join(this.outside, "map.json");
    writeFileSync(path, JSON.stringify(value));
    return path;
  }

  dryRun(map: unknown): { stdout: string; hash: string } {
    const stdout = this.ok(["job", "migrate-workflow", "--map", this.map(map), "--actor", migrator]);
    const hash = /計画ハッシュ: ([0-9a-f]{16})/.exec(stdout)?.[1];
    assert.ok(hash, stdout);
    return { stdout, hash };
  }

  apply(map: unknown): string {
    const { hash } = this.dryRun(map);
    const stdout = this.ok(["job", "migrate-workflow", "--map", this.map(map), "--actor", migrator, "--apply", "--plan", hash]);
    const id = /移行ID: (wf-[0-9]{8}-[0-9]{6}-[0-9a-f]{4})/.exec(stdout)?.[1];
    assert.ok(id, stdout);
    return id;
  }

  // 工程の操作 (revision を取ってから --if-match で渡す)
  step(args: string[], selector: string): void {
    const [command, ...rest] = args;
    const revision = (JSON.parse(this.ok(["task", "show", job, selector, "--schema-version", "2", "--json"])) as { item: { revision: string } }).item.revision;
    this.ok(["task", command, job, selector, ...rest, "--if-match", revision]);
  }

  task(name: string): Record<string, any> {
    return YamlFrontmatter.parse(this.read(name)).data() as Record<string, any>;
  }

  read(name: string): string {
    return readFileSync(join(this.root, "jobs", job, "tasks", name, "index.md"), "utf8");
  }

  body(name: string): string {
    const text = this.read(name);
    return text.slice(text.indexOf("\n---\n", 4) + 5);
  }

  // jobs/PROJ/status/ の下のリンク (パス → リンク先)
  links(): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (rel: string) => {
      const full = join(this.root, rel);
      for (const name of readdirSync(full)) {
        const child = `${rel}/${name}`;
        const stat = lstatSync(join(this.root, child));
        if (stat.isSymbolicLink()) out[child.replace(`jobs/${job}/status/`, "")] = readlinkSync(join(this.root, child));
        else if (stat.isDirectory()) walk(child);
      }
    };
    walk(`jobs/${job}/status`);
    return out;
  }

  // 旧形式のタスクを 4 件 (todo・progress・pending・done) と、本文に「implement」を含むものを作る
  legacySet(): void {
    this.ok(["task", "add", job, "todo-task", "todo", "未着手"]);
    this.ok(["task", "add", job, "progress-task", "progress", "作業中"]);
    this.ok(["task", "add", job, "pending-task", "pending", "待ち", "--blocked-by", "other: 外部の回答"]);
    this.ok(["task", "add", job, "done-task", "todo", "完了済み"]);
    this.ok(["task", "move", job, "T-004", "done"]);
  }

  // v2 のフィクスチャをタスクとして置き、作業索引を張る
  placeV2(name: string, fixture: string): void {
    const dir = join(this.root, "jobs", job, "tasks", name);
    mkdirSync(dir, { recursive: true });
    let text = readFileSync(join(fixtures, fixture), "utf8");
    const id = `T-${String(100 + readdirSync(join(this.root, "jobs", job, "tasks")).length).padStart(3, "0")}`;
    const frontmatter = YamlFrontmatter.parse(text);
    frontmatter.set(["id"], id);
    text = `${frontmatter.toString()}\n本文の implement はそのまま残す (\`workflow.implement\` も)。\n`;
    writeFileSync(join(dir, "index.md"), text);
    const data = frontmatter.data() as Record<string, any>;
    if (data.status === "open") {
      const link = join(this.root, "jobs", job, "status", data.phase, data.workflow[data.phase].status, name);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(`../../../tasks/${name}`, link);
    }
  }
}

const fullMap = {
  type: "research",
  tasks: {
    [`${job}/T-001`]: { phase: "plan" },
    [`${job}/progress-task`]: { phase: "execute", assignee: "agent/claude", type: "implementation" },
    [`${job}/T-003`]: { phase: "review", assignee: "agent/codex" },
  },
};

test("dry-run は何も変えず、タスクごとの変換と計画ハッシュを示す", () => {
  const project = new Project();
  project.legacySet();
  const before = project.snapshot();
  const { stdout } = project.dryRun(fullMap);
  assert.deepEqual(project.snapshot(), before, "dry-run は何も変えない");
  assert.match(stdout, /旧形式 4 件 \(done 1 \/ 未完了 3\)/);
  assert.match(stdout, /PROJ\/T-001 todo-task: 旧 todo → 調査 plan ready \(担当 未割当\)/);
  assert.match(stdout, /PROJ\/T-002 progress-task: 旧 progress → 実装 execute progress \(担当 agent\/claude\)/);
  assert.match(stdout, /PROJ\/T-003 pending-task: 旧 pending → 調査 review pending \(担当 agent\/codex\)/);
  assert.match(stdout, /PROJ\/T-004 done-task: 旧 done → 調査 closed \(legacy_done\)/);
  assert.match(stdout, /--apply --plan [0-9a-f]{16}/);
});

test("種別・工程・担当が足りないと、apply せずにすべてを示す (種別を推測しない)", () => {
  const project = new Project();
  project.legacySet();
  const before = project.snapshot();
  const result = project.run(["job", "migrate-workflow", "--map", project.map({ tasks: { [`${job}/T-002`]: { type: "research" }, [`${job}/nothing`]: { type: "research" } } }), "--actor", migrator]);
  assert.equal(result.status, 1, result.stdout);
  for (const line of [
    /PROJ\/todo-task: 種別 \(type\) の指定がありません/,
    /PROJ\/todo-task: 旧形式の todo には今の工程 \(phase\) の指定が必要です/,
    /PROJ\/progress-task: 旧形式の progress には今の工程/,
    /PROJ\/progress-task: 旧形式の progress には担当 \(assignee\) の指定が必要です/,
    /PROJ\/pending-task: 旧形式の pending には担当/,
    /PROJ\/done-task: 種別 \(type\) の指定がありません/,
    /対応表の PROJ\/nothing に当たるタスクがありません/,
  ]) assert.match(result.stdout, line);
  assert.match(result.stderr, /移行できないものが \d+ 件あります/);
  // 診断があるときは、計画ハッシュを付けても apply しない
  const hash = /計画ハッシュ: ([0-9a-f]{16})/.exec(result.stdout)![1];
  const applied = project.run(["job", "migrate-workflow", "--map", join(project.outside, "map.json"), "--actor", migrator, "--apply", "--plan", hash]);
  assert.equal(applied.status, 1);
  assert.match(applied.stderr, /移行できないものがあるため、何も変更せずに中止しました/);
  assert.deepEqual(project.snapshot(), before);
  // 対応表の書式の誤り (別名・v2 の工程名・担当の書式・未知の項目)
  for (const [map, message] of [
    [{ type: "search" }, /search・implement などの別名は受け付けない/],
    [{ tasks: { [`${job}/T-001`]: { phase: "implement" } } }, /implement は workflowVersion 2 の名前です/],
    [{ tasks: { [`${job}/T-001`]: { assignee: "claude" } } }, /assignee は human\/<識別子> か agent\/<識別子> です/],
    [{ tasks: { [`${job}/T-001`]: { status: "done" } } }, /使えない項目があります: status/],
    [{ types: "research" }, /使えない項目があります: types/],
  ] as const) {
    const bad = project.run(["job", "migrate-workflow", "--map", project.map(map), "--actor", migrator]);
    assert.equal(bad.status, 1, JSON.stringify(map));
    assert.match(bad.stderr, message);
  }
  // done・v2 には工程・担当を指定しない、受入確認の担当は人
  const done = project.run(["job", "migrate-workflow", "--map", project.map({ type: "research", tasks: { ...fullMap.tasks, [`${job}/T-004`]: { phase: "acceptance" }, [`${job}/T-001`]: { phase: "acceptance", assignee: "agent/claude" } } }), "--actor", migrator]);
  assert.equal(done.status, 1);
  assert.match(done.stdout, /done-task: done のタスクには工程・担当を指定しません/);
  assert.match(done.stdout, /todo-task: 移行後の形式が規則に合いません \(WF_HUMAN workflow\.acceptance\.assignee/);
  assert.deepEqual(project.snapshot(), before);
  // 受入確認の担当を割り当てる移行は人が行う (通常の assign と同じ)
  const byAgent = project.run(["job", "migrate-workflow", "--map", project.map({ type: "research", tasks: { ...fullMap.tasks, [`${job}/T-001`]: { phase: "acceptance", assignee: "human/saiki" } } }), "--actor", "agent/claude"]);
  assert.equal(byAgent.status, 1);
  assert.match(byAgent.stdout, /todo-task: 受入確認の担当を割り当てる移行は人 \(--actor human\/…\) が行います/);
  assert.deepEqual(project.snapshot(), before);
});

test("旧 done は closed (legacy_done) にし、人が承認したとは記録しない", () => {
  const project = new Project();
  project.legacySet();
  const bodyBefore = project.body("done-task");
  const completedAt = project.task("done-task").completedAt;
  project.apply(fullMap);
  const task = project.task("done-task");
  assert.deepEqual(readTaskFile(project.read("done-task")).issues, []);
  assert.equal(task.workflowVersion, 3);
  assert.equal(task.type, "research");
  assert.equal(task.status, "closed");
  assert.equal(task.closureReason, "legacy_done", "accepted にしない");
  assert.equal(task.completedAt, completedAt, "閉じた日は旧 completedAt");
  assert.equal(task.phase, null);
  for (const phase of ["plan", "execute", "review", "acceptance"]) {
    assert.equal(task.workflow[phase].status, "done");
    assert.equal(task.workflow[phase].outcome, "legacy_import", `${phase} は approved・completed にしない`);
    assert.equal(task.workflow[phase].completedBy, null, `${phase} の完了者を作らない`);
  }
  assert.deepEqual(task.history.map((entry: any) => [entry.event, entry.phase, entry.actor, entry.outcome]), [
    ["legacy_import", "plan", migrator, "legacy_import"],
    ["legacy_import", "execute", migrator, "legacy_import"],
    ["legacy_import", "review", migrator, "legacy_import"],
    ["legacy_import", "acceptance", migrator, "legacy_import"],
  ]);
  assert.match(task.history[0].reason, /証跡未確認/);
  assert.equal(project.body("done-task"), bodyBefore, "本文は変えない");
  const links = project.links();
  assert.ok(!Object.keys(links).some((path) => path.endsWith("/done-task")), `closed の作業索引は 0 件、旧 done の索引も消える: ${JSON.stringify(links)}`);
});

test("旧形式の未完了は open にし、指定した工程・担当・待ちを保ち、前の工程を証跡未確認にする", () => {
  const project = new Project();
  project.legacySet();
  const created = project.task("pending-task").createdAt;
  project.apply(fullMap);
  const todo = project.task("todo-task");
  assert.deepEqual([todo.status, todo.phase, todo.workflow.plan.status, todo.workflow.plan.assignee, todo.workflow.execute.status], ["open", "plan", "ready", null, "waiting"]);
  assert.deepEqual(todo.history.map((entry: any) => entry.event), ["create"]);
  const progress = project.task("progress-task");
  assert.equal(progress.type, "implementation", "個別の種別が一括指定より優先");
  assert.deepEqual([progress.phase, progress.workflow.plan.outcome, progress.workflow.execute.status, progress.workflow.execute.assignee, progress.workflow.execute.inputSeq], ["execute", "legacy_import", "progress", "agent/claude", 1]);
  assert.deepEqual(progress.history.map((entry: any) => [entry.event, entry.phase, entry.actor, entry.to]), [
    ["legacy_import", "plan", migrator, "done"],
    ["assign", "execute", migrator, "agent/claude"],
  ], "担当本人の claim は作らず、移行を行う人の割り当てにする");
  const pending = project.task("pending-task");
  assert.deepEqual([pending.phase, pending.workflow.review.status, pending.workflow.review.assignee, pending.blockedBy, pending.workflow.review.inputSeq, pending.createdAt], ["review", "pending", "agent/codex", ["other: 外部の回答"], 2, created]);
  for (const name of ["todo-task", "progress-task", "pending-task"]) assert.deepEqual(readTaskFile(project.read(name)).issues, [], name);
  assert.deepEqual(project.links(), {
    "plan/ready/todo-task": "../../../tasks/todo-task",
    "execute/progress/progress-task": "../../../tasks/progress-task",
    "review/pending/pending-task": "../../../tasks/pending-task",
  }, "旧形式の状態索引を外し、作業索引を張る");
  // 移行した後のタスクは工程の操作で進められる (作業索引と CLI の結合)
  const json = JSON.parse(project.ok(["task", "list", job, "--json", "--schema-version", "2"])) as { items: Record<string, any>[] };
  assert.deepEqual(json.items.map((item) => [item.id, item.phase, item.phaseStatus]).sort(), [["T-001", "plan", "ready"], ["T-002", "execute", "progress"], ["T-003", "review", "pending"]]);
  project.step(["claim", "--actor", "agent/claude"], "T-001");
  assert.ok(project.links()["plan/progress/todo-task"]);
});

test("v2 は implement を execute に意味で変え、seq・inputSeq・試行・actor・結果・成果物・日時を保つ", () => {
  const project = new Project();
  project.placeV2("returned", "v2-review-returned.md");
  project.placeV2("working", "v2-implement-progress.md");
  project.placeV2("closed", "v2-closed-accepted.md");
  const before = Object.fromEntries(["returned", "working", "closed"].map((name) => [name, project.task(name)]));
  const bodies = Object.fromEntries(["returned", "working", "closed"].map((name) => [name, project.body(name)]));
  project.apply({ type: "implementation" });
  for (const name of ["returned", "working", "closed"]) {
    const after = project.task(name);
    const old = before[name];
    assert.deepEqual(readTaskFile(project.read(name)).issues, [], name);
    assert.equal(after.workflowVersion, 3);
    assert.equal(after.type, "implementation");
    assert.equal(after.phase, old.phase === "implement" ? "execute" : old.phase, name);
    assert.deepEqual(Object.keys(after.workflow), ["plan", "execute", "review", "acceptance"], name);
    assert.deepEqual(after.workflow.execute, old.workflow.implement, `${name}: 工程の記録は名前だけ変わる`);
    for (const phase of ["plan", "review", "acceptance"]) assert.deepEqual(after.workflow[phase], old.workflow[phase], `${name} ${phase}`);
    assert.deepEqual(after.history, old.history.map((entry: any) => ({ ...entry, phase: entry.phase === "implement" ? "execute" : entry.phase })), `${name}: 履歴は工程の名前だけ変わる`);
    for (const key of ["id", "status", "requirementRevision", "createdAt", "updatedAt", "completedAt", "closureReason", "requestedBy", "createdBy", "blockedBy", "relatedTasks"]) assert.deepEqual(after[key], old[key], `${name} ${key}`);
    assert.equal(project.body(name), bodies[name], `${name}: 本文の implement は置き換えない`);
    assert.match(project.body(name), /本文の implement はそのまま残す/);
  }
  assert.deepEqual(project.links(), {
    "execute/ready/returned": "../../../tasks/returned",
    "execute/progress/working": "../../../tasks/working",
  }, "v2 の status/implement/… は status/execute/… に移り、closed は 0 件");
  assert.ok(!existsSync(join(project.root, "jobs", job, "status", "implement")), "空になった status/implement/ は消す");
});

test("移行後の形式が v3 の規則に合わなければ apply しない", () => {
  const project = new Project();
  project.ok(["task", "add", job, "odd", "todo", "おかしな待ち"]);
  // todo なのに blockedBy がある (旧形式では書けてしまう)
  const path = join(project.root, "jobs", job, "tasks", "odd", "index.md");
  writeFileSync(path, readFileSync(path, "utf8").replace("blockedBy: []", "blockedBy:\n  - other: x"));
  const before = project.snapshot();
  const result = project.run(["job", "migrate-workflow", "--map", project.map({ type: "research", tasks: { [`${job}/odd`]: { phase: "plan" } } }), "--actor", migrator]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /odd: 移行後の形式が規則に合いません \(WF_BLOCKED blockedBy/);
  assert.deepEqual(project.snapshot(), before);
});

test("apply は計画ハッシュが一致するときだけ実行する (dry-run の後の変更で止まる)", () => {
  const project = new Project();
  project.legacySet();
  const { hash } = project.dryRun(fullMap);
  const missing = project.run(["job", "migrate-workflow", "--map", join(project.outside, "map.json"), "--actor", migrator, "--apply"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--plan <計画ハッシュ> が必要です/);
  // dry-run の後にタスクを書き換える
  const path = join(project.root, "jobs", job, "tasks", "todo-task", "index.md");
  writeFileSync(path, readFileSync(path, "utf8") + "\n追記\n");
  const before = project.snapshot();
  const changed = project.run(["job", "migrate-workflow", "--map", join(project.outside, "map.json"), "--actor", migrator, "--apply", "--plan", hash]);
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /表示した計画 \([0-9a-f]+\) と現在の計画 \([0-9a-f]+\) が一致しない/);
  assert.deepEqual(project.snapshot(), before);
  // actor が違っても別の計画
  const other = project.run(["job", "migrate-workflow", "--map", join(project.outside, "map.json"), "--actor", "human/other", "--apply", "--plan", project.dryRun(fullMap).hash]);
  assert.equal(other.status, 1);
});

test("途中で失敗したら、この実行で変えた index.md と索引だけを戻す", () => {
  for (const failAt of ["symlink", "rename", "unlink"] as const) {
    const project = new Project();
    project.legacySet();
    project.placeV2("working", "v2-implement-progress.md");
    const before = project.snapshot();
    const plan = buildPlan(project.root, parseMap(JSON.stringify({ ...fullMap, tasks: { ...fullMap.tasks, [`${job}/working`]: { type: "implementation" } } })), migrator);
    assert.deepEqual(plan.diagnostics, []);
    let calls = 0;
    // 2 件目のタスクの操作で失敗させる (1 件目は書き換え済み)
    const fs: IndexFs = {
      ...defaultIndexFs,
      [failAt]: (...args: [string, string]) => {
        calls++;
        if (calls >= 2) throw new Error(`注入した失敗 (${failAt})`);
        return (defaultIndexFs[failAt] as (...a: [string, string]) => void)(...args);
      },
    };
    assert.throws(() => applyPlan(plan, plan.hash, fs), (error: unknown) => error instanceof CliError && /この実行で変えたものを戻しました/.test(error.message) && error.code === "MIGRATE_FAILED");
    const after = project.snapshot();
    const journalDir = Object.keys(after).find((rel) => rel.startsWith(".raprid-migrate/wf-") && rel.endsWith("/journal.json"));
    assert.ok(journalDir, "記録は残る");
    const journal = JSON.parse(readFileSync(join(project.root, journalDir), "utf8"));
    assert.equal(journal.state, "rolled-back");
    const withoutRecord = (value: Record<string, string>) => Object.fromEntries(Object.entries(value).filter(([rel]) => !rel.startsWith(".raprid-migrate")));
    assert.deepEqual(withoutRecord(after), before, `${failAt}: 作業ツリーは移行前のまま`);
  }
});

test("restore は移行前に戻し、移行後に変えたものがあれば戻さない", () => {
  const project = new Project();
  project.legacySet();
  project.placeV2("working", "v2-implement-progress.md");
  const map = { ...fullMap, tasks: { ...fullMap.tasks, [`${job}/working`]: { type: "implementation" } } };
  const id = project.apply(map);
  assert.ok(existsSync(join(project.root, "jobs", markerName)));
  // 移行後に工程を進めると戻さない
  project.step(["claim", "--actor", "agent/claude"], "T-001");
  const changed = project.snapshot();
  const blocked = project.run(["job", "migrate-workflow", "--restore", id]);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /移行後に変更されたタスク: jobs\/PROJ\/tasks\/todo-task\/index\.md/);
  assert.match(blocked.stderr, /移行後に作られた作業索引: jobs\/PROJ\/status\/plan\/progress\/todo-task/);
  assert.deepEqual(project.snapshot(), changed, "戻さないときは何も変えない");
  // 移行後に作ったタスクがあっても戻さない
  const other = new Project();
  other.legacySet();
  const otherId = other.apply(fullMap);
  other.ok(["task", "add", job, "new-task", "--type", "research", "新しいタスク"]);
  const added = other.run(["job", "migrate-workflow", "--restore", otherId]);
  assert.equal(added.status, 1);
  assert.match(added.stderr, /移行後に作られたタスク: jobs\/PROJ\/tasks\/new-task/);
  // 変えていなければ戻せる。2 回目は何もしない
  const clean = new Project();
  clean.legacySet();
  clean.placeV2("working", "v2-implement-progress.md");
  const cleanBefore = clean.snapshot();
  const cleanId = clean.apply(map);
  assert.notDeepEqual(clean.snapshot(), cleanBefore);
  assert.match(clean.ok(["job", "migrate-workflow", "--restore", cleanId]), /前の状態に戻しました/);
  const withoutRecord = (value: Record<string, string>) => Object.fromEntries(Object.entries(value).filter(([rel]) => !rel.startsWith(".raprid-migrate")));
  assert.deepEqual(withoutRecord(clean.snapshot()), cleanBefore, "index.md・状態索引・作業索引・印が移行前と同じ");
  assert.match(clean.ok(["job", "migrate-workflow", "--restore", cleanId]), /既に戻されています/);
  // 別の形式の移行 ID は受け付けない
  const wrong = clean.run(["job", "migrate-workflow", "--restore", "20260929-000000-abcd"]);
  assert.equal(wrong.status, 2);
});

test("移行後の再実行は何も変えず、旧形式の task add は拒否して --type を案内する", () => {
  const project = new Project();
  project.legacySet();
  project.apply(fullMap);
  const after = project.snapshot();
  assert.match(project.ok(["job", "migrate-workflow", "--map", join(project.outside, "map.json"), "--actor", migrator]), /移行済みです.*変更はありません/);
  assert.match(project.ok(["job", "migrate-workflow", "--actor", migrator]), /移行済みです/, "対応表が無くても再実行できる");
  assert.deepEqual(project.snapshot(), after);
  const legacy = project.run(["task", "add", job, "old-style", "todo", "旧形式"]);
  assert.equal(legacy.status, 1);
  assert.match(legacy.stderr, /移行済みのため、旧形式のタスクは作れません.*--type research\|implementation/);
  assert.deepEqual(project.snapshot(), after);
  project.ok(["task", "add", job, "new-style", "--type", "implementation", "新形式"]);
  // 移行前のプロジェクトでは旧形式の task add を続けて使える (移行前の互換)
  const before = new Project();
  before.ok(["task", "add", job, "old-style", "todo", "旧形式"]);
});

test("QA・詳細 md・成果物は変えない", () => {
  const project = new Project();
  project.legacySet();
  project.ok(["qa", "add", job, "question", "internal", "質問", "--requested-by", "agent/test", "--created-by", "agent/test"]);
  project.ok(["task", "note", job, "T-002", "detail", "詳細"]);
  mkdirSync(join(project.root, "jobs", job, "tasks", "progress-task", "assets"), { recursive: true });
  writeFileSync(join(project.root, "jobs", job, "tasks", "progress-task", "assets", "result.txt"), "成果物");
  const keep = (value: Record<string, string>) => Object.fromEntries(Object.entries(value).filter(([rel]) => rel.startsWith(`jobs/${job}/qa`) || /^jobs\/PROJ\/tasks\/[^/]+\/(?!index\.md)/.test(rel)));
  const before = keep(project.snapshot());
  project.apply(fullMap);
  assert.deepEqual(keep(project.snapshot()), before);
});

test("移行はすべての案件のロックを取り、ロックの中で計画を作り直す", async () => {
  const project = new Project();
  project.legacySet();
  const { hash } = project.dryRun(fullMap);
  // 別のプロセスが案件のロックを持ったまま、タスクを書き換える
  const lockScript = join(project.root, "hold.ts");
  const path = join(project.root, "jobs", job, "tasks", "todo-task", "index.md");
  writeFileSync(lockScript, `
import { appendFileSync, writeFileSync } from "node:fs";
import { withJobLocks } from ${JSON.stringify(join(here, "..", "lib", "jobs.ts"))};
withJobLocks(${JSON.stringify(project.root)}, [${JSON.stringify(job)}], () => {
  writeFileSync(${JSON.stringify(join(project.root, "held"))}, "");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
  appendFileSync(${JSON.stringify(path)}, "\\nロック中の追記\\n");
});
`);
  const holder = spawn(process.execPath, [lockScript], { stdio: "inherit" });
  const done = new Promise<void>((resolve) => holder.on("close", () => resolve()));
  while (!existsSync(join(project.root, "held"))) await new Promise((resolve) => setTimeout(resolve, 10));
  const result = project.run(["job", "migrate-workflow", "--map", join(project.outside, "map.json"), "--actor", migrator, "--apply", "--plan", hash]);
  await done;
  assert.equal(result.status, 1, "ロックを待ってから計画を作り直すので、待っている間の変更で計画が変わる");
  assert.match(result.stderr, /一致しないため中止しました/);
  assert.match(project.read("todo-task"), /ロック中の追記/);
  assert.equal(project.task("todo-task").workflowVersion, undefined, "移行していない");
});

test("読めない版・別のものを指す索引は止め、索引の張り替え漏れ・completedAt の欠けは注意して移す", () => {
  const project = new Project();
  project.ok(["task", "add", job, "future", "todo", "未来の版"]);
  project.ok(["task", "add", job, "wrong-link", "todo", "索引が別を指す"]);
  project.ok(["task", "add", job, "no-link", "todo", "索引が無い"]);
  project.ok(["task", "add", job, "old-done", "todo", "completedAt の無い done"]);
  project.ok(["task", "move", job, "T-004", "done"]);
  const tasks = join(project.root, "jobs", job, "tasks");
  const status = join(project.root, "jobs", job, "status");
  writeFileSync(join(tasks, "future", "index.md"), readFileSync(join(tasks, "future", "index.md"), "utf8").replace("status: todo", "workflowVersion: 4\nstatus: todo"));
  rmSync(join(status, "todo", "wrong-link"));
  symlinkSync("../../tasks/future", join(status, "todo", "wrong-link"));
  rmSync(join(status, "todo", "no-link"));
  writeFileSync(join(tasks, "old-done", "index.md"), readFileSync(join(tasks, "old-done", "index.md"), "utf8").replace(/^completedAt: .*$/m, "completedAt:"));
  const map = { type: "research", tasks: { [`${job}/future`]: { phase: "plan" }, [`${job}/wrong-link`]: { phase: "plan" }, [`${job}/no-link`]: { phase: "plan" } } };
  const before = project.snapshot();
  const blocked = project.run(["job", "migrate-workflow", "--map", project.map(map), "--actor", migrator]);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /future: 対応していない、または読めない workflowVersion です: 4/);
  assert.match(blocked.stdout, /wrong-link: 索引のリンク先が別のものです: jobs\/PROJ\/status\/todo\/wrong-link -> \.\.\/\.\.\/tasks\/future/);
  assert.match(blocked.stdout, /no-link: 旧形式の状態索引がありません \(索引の張り替え漏れ/);
  assert.match(blocked.stdout, /old-done: completedAt が無いので閉じた日を移行日/);
  assert.deepEqual(project.snapshot(), before);
  // 止める原因を取り除けば、注意のあるものは移せる
  rmSync(join(tasks, "future"), { recursive: true });
  rmSync(join(status, "todo", "future"));
  rmSync(join(status, "todo", "wrong-link"));
  symlinkSync("../../tasks/wrong-link", join(status, "todo", "wrong-link"));
  delete (map.tasks as Record<string, unknown>)[`${job}/future`];
  project.apply(map);
  assert.ok(project.links()["plan/ready/no-link"], "索引の無かったタスクにも作業索引を張る");
  const done = project.task("old-done");
  assert.equal(done.completedAt, done.updatedAt);
  assert.match(done.history[0].reason, /旧 completedAt 不明/);
});

test("restore は移行後の索引の削除・外した旧索引の作り直し・印の削除も変更とみなし、何も戻さずに止める (R16-1)", () => {
  const cases: [string, (project: Project, id?: string) => void, RegExp][] = [
    ["作業索引の削除", (project) => rmSync(join(project.root, "jobs", job, "status", "plan", "ready", "todo-task")), /移行後に削除された索引: jobs\/PROJ\/status\/plan\/ready\/todo-task/],
    ["作業索引の差し替え", (project) => { const path = join(project.root, "jobs", job, "status", "plan", "ready", "todo-task"); rmSync(path); symlinkSync("../../../tasks/progress-task", path); }, /移行後に変更された索引: jobs\/PROJ\/status\/plan\/ready\/todo-task/],
    ["外した旧索引の作り直し", (project) => symlinkSync("../../tasks/done-task", join(project.root, "jobs", job, "status", "done", "done-task")), /移行後に作られた索引: jobs\/PROJ\/status\/done\/done-task/],
    ["印の削除", (project) => rmSync(join(project.root, "jobs", markerName)), /移行後に削除された印: jobs\/\.raprid-workflow/],
    ["タスクの削除", (project) => rmSync(join(project.root, "jobs", job, "tasks", "todo-task", "index.md")), /移行後に削除されたタスク: jobs\/PROJ\/tasks\/todo-task\/index\.md/],
    ["旧索引のディレクトリの削除", (project) => rmSync(join(project.root, "jobs", job, "status", "done"), { recursive: true }), /移行後に削除された索引のディレクトリ: jobs\/PROJ\/status\/done/],
    ["退避の書き換え", (project, id) => writeFileSync(join(project.root, ".raprid-migrate", id!, "backup", "jobs", job, "tasks", "todo-task", "index.md"), "書き換えた退避\n"), /退避が移行後に変更されています: jobs\/PROJ\/tasks\/todo-task\/index\.md/],
  ];
  for (const [label, change, message] of cases) {
    const project = new Project();
    project.legacySet();
    const id = project.apply(fullMap);
    change(project, id);
    const before = project.snapshot();
    const result = project.run(["job", "migrate-workflow", "--restore", id]);
    assert.equal(result.status, 1, `${label}: ${result.stdout}`);
    assert.match(result.stderr, /移行後に変更されたものがあるため、戻さずに中止しました \(退避は残っています\)/, label);
    assert.match(result.stderr, message, label);
    assert.deepEqual(project.snapshot(), before, `${label}: 何も戻さない (退避・journal もそのまま)`);
    const journal = JSON.parse(readFileSync(join(project.root, ".raprid-migrate", id, "journal.json"), "utf8"));
    assert.equal(journal.state, "completed", label);
    assert.ok(existsSync(join(project.root, ".raprid-migrate", id, "backup", "jobs", job, "tasks", "todo-task", "index.md")), `${label}: 退避が残る`);
  }
});

test("途中で失敗して戻しきれなかった移行 (started) は、書けた範囲だけを戻す", () => {
  const project = new Project();
  project.legacySet();
  project.placeV2("working", "v2-implement-progress.md");
  const before = project.snapshot();
  const plan = buildPlan(project.root, parseMap(JSON.stringify({ ...fullMap, tasks: { ...fullMap.tasks, [`${job}/working`]: { type: "implementation" } } })), migrator);
  // apply は 3 件目の rename で失敗し、失敗の後の戻しも 1 件目の index.md の書き戻しで失敗する (書けた範囲がタスクごとに違う状態)
  let applied = 0;
  const fs: IndexFs = { ...defaultIndexFs, rename: (from, to) => { applied++; if (applied === 3) throw new Error("注入した失敗 (apply)"); defaultIndexFs.rename(from, to); } };
  let rolled = 0;
  const rollbackFs: IndexFs = { ...defaultIndexFs, rename: (from, to) => { rolled++; if (rolled === 2) throw new Error("注入した失敗 (戻し)"); defaultIndexFs.rename(from, to); } };
  assert.throws(() => applyPlan(plan, plan.hash, fs, rollbackFs), (error: unknown) => error instanceof CliError && /一部を戻せませんでした/.test(error.message));
  const id = readdirSync(join(project.root, ".raprid-migrate")).find((name) => name.startsWith("wf-"))!;
  assert.equal(JSON.parse(readFileSync(join(project.root, ".raprid-migrate", id, "journal.json"), "utf8")).state, "started");
  const withoutRecord = (value: Record<string, string>) => Object.fromEntries(Object.entries(value).filter(([rel]) => !rel.startsWith(".raprid-migrate")));
  assert.notDeepEqual(withoutRecord(project.snapshot()), withoutRecord(before), "まだ戻しきれていない");
  assert.match(project.ok(["job", "migrate-workflow", "--restore", id]), /前の状態に戻しました/);
  assert.deepEqual(withoutRecord(project.snapshot()), withoutRecord(before), "書けていた分も戻り、移行前と同じ (空になった作業索引のディレクトリも残らない)");
});

test("restore は index.md の権限の変更も移行後の変更とみなし、移行・restore は元の権限を保つ (R16-2)", () => {
  // 権限の変更で止まる (内容は移行した時のまま)
  const project = new Project();
  project.legacySet();
  const id = project.apply(fullMap);
  chmodSync(join(project.root, "jobs", job, "tasks", "todo-task", "index.md"), 0o600);
  const before = project.snapshot();
  const result = project.run(["job", "migrate-workflow", "--restore", id]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /移行後に権限が変更されたタスク: jobs\/PROJ\/tasks\/todo-task\/index\.md \(644 → 600\)/);
  assert.deepEqual(project.snapshot(), before, "何も戻さない (退避・journal もそのまま)");
  assert.equal(JSON.parse(readFileSync(join(project.root, ".raprid-migrate", id, "journal.json"), "utf8")).state, "completed");
  // umask より広い権限 (664) も、移行・restore で元のまま
  const wide = new Project();
  wide.legacySet();
  const path = join(wide.root, "jobs", job, "tasks", "progress-task", "index.md");
  chmodSync(path, 0o664);
  const original = wide.snapshot();
  const previous = process.umask(0o077); // 子プロセスに引き継がれる。chmod しなければ 600 になる
  try {
    const wideId = wide.apply(fullMap);
    assert.equal(lstatSync(path).mode & 0o777, 0o664, "移行後も 664");
    assert.equal(lstatSync(join(wide.root, ".raprid-migrate", wideId, "backup", "jobs", job, "tasks", "progress-task", "index.md")).mode & 0o777, 0o664, "退避も 664");
    wide.ok(["job", "migrate-workflow", "--restore", wideId]);
  } finally {
    process.umask(previous);
  }
  const withoutRecord = (value: Record<string, string>) => Object.fromEntries(Object.entries(value).filter(([rel]) => !rel.startsWith(".raprid-migrate")));
  assert.deepEqual(withoutRecord(wide.snapshot()), withoutRecord(original), "restore 後は権限も移行前と同じ");
});

test("restore は書く場所の親がリンク・作り直したディレクトリ・リンクに置き換えた index.md なら、何も戻さずに止める (R16-3)", () => {
  const outsideDir = () => mkdtempSync(join(tmpdir(), "raprid-migrate-outside-"));
  const replaceWithLink = (path: string) => {
    const target = outsideDir();
    cpSync(path, target, { recursive: true, verbatimSymlinks: true });
    rmSync(path, { recursive: true });
    symlinkSync(target, path);
    return target;
  };
  const cases: [string, (project: Project) => string | undefined, RegExp][] = [
    ["旧索引のディレクトリをリンクに置き換える", (project) => replaceWithLink(join(project.root, "jobs", job, "status", "todo")), /移行後にディレクトリ以外へ置き換えられた: jobs\/PROJ\/status\/todo/],
    ["タスクのディレクトリをリンクに置き換える", (project) => replaceWithLink(join(project.root, "jobs", job, "tasks", "todo-task")), /移行後にディレクトリ以外へ置き換えられた: jobs\/PROJ\/tasks\/todo-task/],
    ["作業索引のディレクトリをリンクに置き換える", (project) => replaceWithLink(join(project.root, "jobs", job, "status", "plan")), /移行後にディレクトリ以外へ置き換えられた: jobs\/PROJ\/status\/plan/],
    ["旧索引のディレクトリを作り直す", (project) => { const path = join(project.root, "jobs", job, "status", "todo"); renameSync(path, `${path}.aside`); mkdirSync(path); writeFileSync(join(path, ".gitkeep"), ""); rmSync(`${path}.aside`, { recursive: true }); return undefined; }, /移行後に作り直されたディレクトリ: jobs\/PROJ\/status\/todo/],
    ["index.md を同じ内容のファイルへのリンクに置き換える", (project) => { const path = join(project.root, "jobs", job, "tasks", "todo-task", "index.md"); const copy = join(outsideDir(), "index.md"); cpSync(path, copy); rmSync(path); symlinkSync(copy, path); return dirname(copy); }, /移行後にファイル以外へ置き換えられたタスク: jobs\/PROJ\/tasks\/todo-task\/index\.md/],
  ];
  for (const [label, change, message] of cases) {
    const project = new Project();
    project.legacySet();
    const id = project.apply(fullMap);
    const outside = change(project);
    const before = project.snapshot();
    const outsideBefore = outside ? snapshot(outside) : undefined;
    const result = project.run(["job", "migrate-workflow", "--restore", id]);
    assert.equal(result.status, 1, `${label}: ${result.stdout}`);
    assert.match(result.stderr, message, label);
    assert.deepEqual(project.snapshot(), before, `${label}: 何も戻さない`);
    if (outside) assert.deepEqual(snapshot(outside), outsideBefore, `${label}: リンクの先にも書かない`);
    assert.equal(JSON.parse(readFileSync(join(project.root, ".raprid-migrate", id, "journal.json"), "utf8")).state, "completed", label);
  }
  // 途中で失敗した移行 (started) でも、親がリンクなら戻さない
  const started = new Project();
  started.legacySet();
  const id = started.apply(fullMap);
  const journalPath = join(started.root, ".raprid-migrate", id, "journal.json");
  writeFileSync(journalPath, JSON.stringify({ ...JSON.parse(readFileSync(journalPath, "utf8")), state: "started" }));
  const outside = replaceWithLink(join(started.root, "jobs", job, "status", "todo"));
  const before = started.snapshot();
  const result = started.run(["job", "migrate-workflow", "--restore", id]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /移行後にディレクトリ以外へ置き換えられた: jobs\/PROJ\/status\/todo/);
  assert.deepEqual(started.snapshot(), before);
  assert.deepEqual(readdirSync(outside).sort(), [".gitkeep"], "リンクの先に旧索引を作らない");
});

test("移行する場所の親にリンクがあれば、計画で止めて何も変えない", () => {
  const project = new Project();
  project.legacySet();
  const path = join(project.root, "jobs", job, "status", "todo");
  const target = mkdtempSync(join(tmpdir(), "raprid-migrate-outside-"));
  cpSync(path, target, { recursive: true, verbatimSymlinks: true });
  rmSync(path, { recursive: true });
  symlinkSync(target, path);
  const before = project.snapshot();
  const outside = snapshot(target);
  const result = project.run(["job", "migrate-workflow", "--map", project.map(fullMap), "--actor", migrator]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /todo-task: ディレクトリ以外 \(リンクなど\) があるため移しません: jobs\/PROJ\/status\/todo/);
  assert.deepEqual(project.snapshot(), before);
  assert.deepEqual(snapshot(target), outside);
});

test("apply・restore は移行の記録・ロックの置き場所がリンクなら、たどった先に書かずに止める (R16-4)", () => {
  const outside = () => mkdtempSync(join(tmpdir(), "raprid-migrate-outside-"));
  const linkTo = (path: string, copyFrom?: string) => {
    const target = outside();
    if (copyFrom) cpSync(copyFrom, target, { recursive: true, verbatimSymlinks: true });
    if (existsSync(path)) rmSync(path, { recursive: true });
    symlinkSync(target, path);
    return target;
  };
  // apply: dry-run の後に .raprid-migrate・jobs/.locks をリンクにする
  for (const place of [".raprid-migrate", "jobs/.locks"]) {
    const project = new Project();
    project.legacySet();
    const { hash } = project.dryRun(fullMap);
    mkdirSync(join(project.root, "jobs", ".locks"), { recursive: true });
    const target = linkTo(join(project.root, place));
    const before = project.snapshot();
    const result = project.run(["job", "migrate-workflow", "--map", join(project.outside, "map.json"), "--actor", migrator, "--apply", "--plan", hash]);
    assert.equal(result.status, 1, `${place}: ${result.stdout}`);
    assert.match(result.stderr, new RegExp(`ディレクトリ以外 \\(リンクなど\\) があるため、何も書かずに中止しました:\\n  ${place.replace(".", "\\.")}`), place);
    assert.deepEqual(readdirSync(target), [], `${place}: リンクの先に何も書かない`);
    assert.deepEqual(project.snapshot(), before, `${place}: 何も変えない`);
  }
  // 同じ内容の複製へのリンクでも拒否する (前の移行の記録がある .raprid-migrate を複製に置き換える)
  const again = new Project();
  again.legacySet();
  const first = again.apply(fullMap);
  again.ok(["job", "migrate-workflow", "--restore", first]);
  const { hash } = again.dryRun(fullMap);
  const copy = linkTo(join(again.root, ".raprid-migrate"), join(again.root, ".raprid-migrate"));
  const copyBefore = snapshot(copy);
  const applied = again.run(["job", "migrate-workflow", "--map", join(again.outside, "map.json"), "--actor", migrator, "--apply", "--plan", hash]);
  assert.equal(applied.status, 1);
  assert.deepEqual(snapshot(copy), copyBefore, "複製の先にも書かない");
  // restore: 記録のディレクトリ・退避のディレクトリ・.raprid-migrate を同じ内容の複製へのリンクに置き換える
  for (const place of ["record", "backup-task", "base"] as const) {
    const project = new Project();
    project.legacySet();
    const id = project.apply(fullMap);
    const path = place === "record" ? join(project.root, ".raprid-migrate", id) : place === "base" ? join(project.root, ".raprid-migrate") : join(project.root, ".raprid-migrate", id, "backup", "jobs", job, "tasks", "todo-task");
    const target = linkTo(path, path);
    const targetBefore = snapshot(target);
    const before = project.snapshot();
    const result = project.run(["job", "migrate-workflow", "--restore", id]);
    assert.equal(result.status, 1, `${place}: ${result.stdout}`);
    assert.match(result.stderr, place === "base" ? /移行の記録・ロックの置き場所にディレクトリ以外/ : /移行後にディレクトリ以外へ置き換えられた: \.raprid-migrate\//, place);
    assert.deepEqual(project.snapshot(), before, `${place}: 何も戻さない`);
    assert.deepEqual(snapshot(target), targetBefore, `${place}: 複製の先の記録も変えない`);
  }
});

test("restore は移行が作った作業索引のディレクトリを同名で作り直したものも変更とみなす (R16-5)", () => {
  const project = new Project();
  project.legacySet();
  const id = project.apply(fullMap);
  const dir = join(project.root, "jobs", job, "status", "plan", "ready");
  const inode = lstatSync(dir).ino;
  // 元のディレクトリを脇に置いたまま作り直す (消してすぐ作ると、同じ inode が使い回されることがある)
  const aside = join(project.root, "jobs", job, "status", "plan", "aside");
  renameSync(dir, aside);
  mkdirSync(dir);
  symlinkSync("../../../tasks/todo-task", join(dir, "todo-task"));
  rmSync(aside, { recursive: true });
  assert.notEqual(lstatSync(dir).ino, inode, "作り直した");
  const before = project.snapshot();
  const result = project.run(["job", "migrate-workflow", "--restore", id]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /移行後に作り直されたディレクトリ: jobs\/PROJ\/status\/plan\/ready/);
  assert.deepEqual(project.snapshot(), before, "何も戻さない");
  assert.equal(JSON.parse(readFileSync(join(project.root, ".raprid-migrate", id, "journal.json"), "utf8")).state, "completed");
});

test("restore は記録・退避のディレクトリ、journal.json、退避のファイルを同じ内容で作り直したものも変更とみなす (R16-6)", () => {
  // 同じ内容の複製で置き換える (inode だけが変わる)
  const recreate = (path: string) => {
    const aside = `${path}.aside`;
    renameSync(path, aside);
    cpSync(aside, path, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    rmSync(aside, { recursive: true });
  };
  const cases: [string, (project: Project, id: string) => string, RegExp][] = [
    ["記録のディレクトリ", (project, id) => join(project.root, ".raprid-migrate", id), /移行後に作り直されたディレクトリ: \.raprid-migrate\/wf-/],
    ["退避のディレクトリ", (project, id) => join(project.root, ".raprid-migrate", id, "backup"), /移行後に作り直されたディレクトリ: \.raprid-migrate\/wf-[0-9a-f-]+\/backup/],
    ["タスクの退避のディレクトリ", (project, id) => join(project.root, ".raprid-migrate", id, "backup", "jobs", job, "tasks", "todo-task"), /移行後に作り直されたディレクトリ: \.raprid-migrate\/wf-[0-9a-f-]+\/backup\/jobs\/PROJ\/tasks\/todo-task/],
    ["journal.json", (project, id) => join(project.root, ".raprid-migrate", id, "journal.json"), /移行後に作り直された記録: \.raprid-migrate\/wf-[0-9a-f-]+\/journal\.json/],
    ["退避のファイル", (project, id) => join(project.root, ".raprid-migrate", id, "backup", "jobs", job, "tasks", "todo-task", "index.md"), /退避が移行後に作り直されています: jobs\/PROJ\/tasks\/todo-task\/index\.md/],
  ];
  for (const state of ["completed", "started"] as const) {
    for (const [label, pathOf, message] of cases) {
      const project = new Project();
      project.legacySet();
      const id = project.apply(fullMap);
      if (state === "started") {
        // journal を同じ実体のまま started にする (書き換えは実体を変えない)
        const journalPath = join(project.root, ".raprid-migrate", id, "journal.json");
        writeFileSync(journalPath, JSON.stringify({ ...JSON.parse(readFileSync(journalPath, "utf8")), state: "started" }));
      }
      const path = pathOf(project, id);
      const inode = lstatSync(path).ino;
      recreate(path);
      assert.notEqual(lstatSync(path).ino, inode, `${label}: 作り直した`);
      const before = project.snapshot();
      const result = project.run(["job", "migrate-workflow", "--restore", id]);
      assert.equal(result.status, 1, `${state} ${label}: ${result.stdout}`);
      assert.match(result.stderr, message, `${state} ${label}`);
      assert.deepEqual(project.snapshot(), before, `${state} ${label}: 何も戻さない (記録も変えない)`);
    }
  }
});

test("restore は移行した index.md・置いた作業索引・印を同じ内容で作り直したものも変更とみなす", () => {
  const cases: [string, (project: Project) => void, RegExp][] = [
    // 元のものを脇に置いたまま作り直す (消してすぐ作ると、ファイルシステムによっては同じ inode が使い回される)
    ["index.md", (project) => { const path = join(project.root, "jobs", job, "tasks", "todo-task", "index.md"); const mode = lstatSync(path).mode & 0o777; renameSync(path, `${path}.aside`); writeFileSync(path, readFileSync(`${path}.aside`)); chmodSync(path, mode); rmSync(`${path}.aside`); }, /移行後に作り直されたタスク: jobs\/PROJ\/tasks\/todo-task\/index\.md/],
    ["作業索引", (project) => { const path = join(project.root, "jobs", job, "status", "plan", "ready", "todo-task"); const aside = join(project.root, "jobs", job, "aside-link"); renameSync(path, aside); symlinkSync(readlinkSync(aside), path); rmSync(aside); }, /移行後に作り直された索引: jobs\/PROJ\/status\/plan\/ready\/todo-task/],
    ["印", (project) => { const path = join(project.root, "jobs", markerName); renameSync(path, `${path}.aside`); writeFileSync(path, readFileSync(`${path}.aside`)); rmSync(`${path}.aside`); }, /移行後に作り直された印: jobs\/\.raprid-workflow/],
  ];
  for (const [label, change, message] of cases) {
    const project = new Project();
    project.legacySet();
    const id = project.apply(fullMap);
    change(project);
    const before = project.snapshot();
    const result = project.run(["job", "migrate-workflow", "--restore", id]);
    assert.equal(result.status, 1, `${label}: ${result.stdout}`);
    assert.match(result.stderr, message, label);
    assert.deepEqual(project.snapshot(), before, `${label}: 何も戻さない`);
  }
});

test("restore は journal.json と journal.id を同じ内容で作り直したもの (対で作り直して辻褄を合わせたものを含む) も変更とみなす (R16-7)", () => {
  const identity = (path: string) => { const stat = lstatSync(path, { bigint: true }); return `${stat.dev}:${stat.ino}\n`; };
  const recreate = (path: string) => { renameSync(path, `${path}.aside`); writeFileSync(path, readFileSync(`${path}.aside`)); rmSync(`${path}.aside`); };
  const cases: [string, (dir: string) => void][] = [
    ["journal.json だけ", (dir) => recreate(join(dir, "journal.json"))],
    ["journal.id だけ", (dir) => recreate(join(dir, "journal.id"))],
    // 両方を作り直し、journal.id に新しい journal.json の実体を書いて辻褄を合わせる (内容は変えない)
    ["journal.json と journal.id の対", (dir) => { recreate(join(dir, "journal.json")); recreate(join(dir, "journal.id")); writeFileSync(join(dir, "journal.id"), identity(join(dir, "journal.json"))); }],
  ];
  for (const state of ["completed", "started"] as const) {
    for (const [label, change] of cases) {
      const project = new Project();
      project.legacySet();
      const id = project.apply(fullMap);
      const dir = join(project.root, ".raprid-migrate", id);
      assert.equal(readFileSync(join(dir, "journal.id"), "utf8"), identity(join(dir, "journal.json")), "journal.id は今の journal.json の実体を指す");
      if (state === "started") {
        const path = join(dir, "journal.json");
        writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), state: "started" })); // その場で書き換える (実体は変わらない)
      }
      change(dir);
      const before = project.snapshot();
      const result = project.run(["job", "migrate-workflow", "--restore", id]);
      assert.equal(result.status, 1, `${state} ${label}: ${result.stdout}`);
      assert.match(result.stderr, /移行後に作り直された記録: \.raprid-migrate\/wf-[0-9a-f-]+\/journal\.json \(journal\.id と合わない\)/, `${state} ${label}`);
      assert.deepEqual(project.snapshot(), before, `${state} ${label}: 何も戻さない`);
    }
  }
});

test("restore が途中で失敗したら restoring を記録し、再実行で残りだけを戻して移行前にそろえる (R16-8)", () => {
  const withoutRecord = (value: Record<string, string>) => Object.fromEntries(Object.entries(value).filter(([rel]) => !rel.startsWith(".raprid-migrate")));
  for (const failAt of ["unlink", "symlink", "rename"] as const) {
    const project = new Project();
    project.legacySet();
    project.placeV2("working", "v2-implement-progress.md");
    const before = project.snapshot();
    const id = project.apply({ ...fullMap, tasks: { ...fullMap.tasks, [`${job}/working`]: { type: "implementation" } } });
    let calls = 0;
    const fs: IndexFs = {
      ...defaultIndexFs,
      [failAt]: (...args: [string, string]) => {
        calls++;
        if (calls === 2) throw new Error(`注入した失敗 (${failAt})`);
        return (defaultIndexFs[failAt] as (...a: [string, string]) => void)(...args);
      },
    };
    assert.throws(() => restorePlan(project.root, id, fs), (error: unknown) => error instanceof CliError && error.code === "MIGRATE_FAILED" && /一部を戻せませんでした/.test(error.message), failAt);
    const journalPath = join(project.root, ".raprid-migrate", id, "journal.json");
    assert.equal(JSON.parse(readFileSync(journalPath, "utf8")).state, "restoring", `${failAt}: restore の途中と記録する`);
    assert.notDeepEqual(withoutRecord(project.snapshot()), withoutRecord(before), `${failAt}: まだ戻しきれていない`);
    // 通常の再実行で、残りだけを戻す
    assert.match(project.ok(["job", "migrate-workflow", "--restore", id]), /前の状態に戻しました/, failAt);
    assert.deepEqual(withoutRecord(project.snapshot()), withoutRecord(before), `${failAt}: 再実行で移行前にそろう`);
    assert.equal(JSON.parse(readFileSync(journalPath, "utf8")).state, "restored");
  }
  // 途中で失敗した後に利用者が変えたもの (移行前でも移行後でもない内容) があれば、再実行でも止める
  const project = new Project();
  project.legacySet();
  const id = project.apply(fullMap);
  let calls = 0;
  const fs: IndexFs = { ...defaultIndexFs, rename: (from, to) => { calls++; if (calls === 2) throw new Error("注入した失敗 (rename)"); defaultIndexFs.rename(from, to); } };
  assert.throws(() => restorePlan(project.root, id, fs), (error: unknown) => error instanceof CliError && error.code === "MIGRATE_FAILED");
  const restored = join(project.root, "jobs", job, "tasks", "todo-task", "index.md");
  writeFileSync(restored, readFileSync(restored, "utf8") + "\n利用者の追記\n");
  const changed = project.snapshot();
  const result = project.run(["job", "migrate-workflow", "--restore", id]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /移行後に変更されたタスク: jobs\/PROJ\/tasks\/todo-task\/index\.md/);
  assert.deepEqual(project.snapshot(), changed, "何も戻さない");
});

test("restore の途中 (restoring) でも、まだ移行後のもの・もう戻したものを同じ内容で作り直せば止める (R16-9)", () => {
  // restore の 2 件目の index.md の書き戻しで失敗させる (逆順なので、todo-task だけが戻り、ほかは移行後のまま)
  const failed = () => {
    const project = new Project();
    project.legacySet();
    const id = project.apply(fullMap);
    let calls = 0;
    const fs: IndexFs = { ...defaultIndexFs, rename: (from, to) => { calls++; if (calls === 2) throw new Error("注入した失敗 (rename)"); defaultIndexFs.rename(from, to); } };
    assert.throws(() => restorePlan(project.root, id, fs), (error: unknown) => error instanceof CliError && error.code === "MIGRATE_FAILED");
    assert.equal(JSON.parse(readFileSync(join(project.root, ".raprid-migrate", id, "journal.json"), "utf8")).state, "restoring");
    return { project, id };
  };
  const recreateFile = (path: string) => { renameSync(path, `${path}.aside`); writeFileSync(path, readFileSync(`${path}.aside`)); chmodSync(path, lstatSync(`${path}.aside`).mode & 0o777); rmSync(`${path}.aside`); };
  const recreateLink = (path: string) => { renameSync(path, `${path}.aside`); symlinkSync(readlinkSync(`${path}.aside`), path); rmSync(`${path}.aside`); };
  const states = (project: Project) => Object.fromEntries(["todo-task", "progress-task", "pending-task", "done-task"].map((name) => [name, project.task(name).workflowVersion ?? "legacy"]));
  const probe = failed();
  const mixed = states(probe.project);
  assert.ok(Object.values(mixed).includes(3) && Object.values(mixed).includes("legacy"), `戻したものと移行後のものが混ざる: ${JSON.stringify(mixed)}`);
  const migrated = Object.keys(mixed).find((name) => mixed[name] === 3)!;
  const restored = Object.keys(mixed).find((name) => mixed[name] === "legacy")!;
  const cases: [string, (project: Project) => void, RegExp][] = [
    ["まだ移行後の index.md", (project) => recreateFile(join(project.root, "jobs", job, "tasks", migrated, "index.md")), new RegExp(`移行後に作り直されたタスク: jobs/PROJ/tasks/${migrated}/index\\.md`)],
    ["戻した index.md", (project) => recreateFile(join(project.root, "jobs", job, "tasks", restored, "index.md")), new RegExp(`移行後に作り直されたタスク: jobs/PROJ/tasks/${restored}/index\\.md`)],
    ["戻した旧索引", (project) => { const link = readdirSync(join(project.root, "jobs", job, "status")).map((status) => join(project.root, "jobs", job, "status", status, restored)).find((path) => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())!; recreateLink(link); }, new RegExp(`移行後に作り直された索引: jobs/PROJ/status/[a-z]+/${restored}`)],
  ];
  for (const [label, change, message] of cases) {
    const { project, id } = failed();
    assert.deepEqual(states(project), mixed, label);
    change(project);
    const before = project.snapshot();
    const result = project.run(["job", "migrate-workflow", "--restore", id]);
    assert.equal(result.status, 1, `${label}: ${result.stdout}`);
    assert.match(result.stderr, message, label);
    assert.deepEqual(project.snapshot(), before, `${label}: 何も戻さない`);
  }
  // 何も変えていなければ、再実行で移行前にそろう
  assert.match(probe.project.ok(["job", "migrate-workflow", "--restore", probe.id]), /前の状態に戻しました/);
});

test("restore の途中 (restoring) で、戻したタスクの退避の作り直し・戻した索引の削除・残っている作業索引の削除も止める (R16-10)", () => {
  // failAt の 2 回目で失敗させる (unlink なら 2 件目のタスクは作業索引も index.md も移行後のまま残る)
  const failed = (failAt: "rename" | "unlink" = "rename") => {
    const project = new Project();
    project.legacySet();
    const id = project.apply(fullMap);
    let calls = 0;
    const fs: IndexFs = { ...defaultIndexFs, [failAt]: (...args: [string, string]) => { calls++; if (calls === 2) throw new Error(`注入した失敗 (${failAt})`); (defaultIndexFs[failAt] as (...a: [string, string]) => void)(...args); } };
    assert.throws(() => restorePlan(project.root, id, fs), (error: unknown) => error instanceof CliError && error.code === "MIGRATE_FAILED");
    const version = (name: string) => project.task(name).workflowVersion ?? "legacy";
    const names = ["todo-task", "progress-task", "pending-task", "done-task"];
    return { project, id, restored: names.filter((name) => version(name) === "legacy" && name !== "done-task"), migrated: names.filter((name) => version(name) === 3) };
  };
  const probe = failed();
  assert.ok(probe.restored.length > 0 && probe.migrated.length > 0, JSON.stringify(probe));
  const restored = probe.restored[0];
  const untouched = failed("unlink").migrated[0]; // 作業索引が残っている移行後のタスク
  const legacyLink = (project: Project, name: string) => readdirSync(join(project.root, "jobs", job, "status")).map((status) => join(project.root, "jobs", job, "status", status, name)).find((path) => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())!;
  const workLink = (project: Project, name: string) => Object.keys(project.links()).find((path) => path.endsWith(`/${name}`) && path.split("/").length === 3)!;
  const cases: [string, (project: Project, id: string) => void, RegExp, ("rename" | "unlink")?][] = [
    ["戻したタスクの退避を作り直す", (project, id) => { const path = join(project.root, ".raprid-migrate", id, "backup", "jobs", job, "tasks", restored, "index.md"); renameSync(path, `${path}.aside`); writeFileSync(path, readFileSync(`${path}.aside`)); chmodSync(path, lstatSync(`${path}.aside`).mode & 0o777); rmSync(`${path}.aside`); }, new RegExp(`退避が移行後に作り直されています: jobs/PROJ/tasks/${restored}/index\\.md`)],
    ["戻した旧索引を消す", (project) => rmSync(legacyLink(project, restored)), new RegExp(`移行後に削除された索引: jobs/PROJ/status/[a-z]+/${restored}`)],
    ["残っている作業索引を消す", (project) => rmSync(join(project.root, "jobs", job, "status", workLink(project, untouched))), new RegExp(`移行後に削除された索引: jobs/PROJ/status/[a-z]+/[a-z]+/${untouched}`), "unlink"],
  ];
  for (const [label, change, message, failAt] of cases) {
    const { project, id } = failed(failAt);
    change(project, id);
    const before = project.snapshot();
    const result = project.run(["job", "migrate-workflow", "--restore", id]);
    assert.equal(result.status, 1, `${label}: ${result.stdout}`);
    assert.match(result.stderr, message, label);
    assert.deepEqual(project.snapshot(), before, `${label}: 何も戻さない`);
  }
  // 変えていなければ再実行で移行前にそろう
  assert.match(probe.project.ok(["job", "migrate-workflow", "--restore", probe.id]), /前の状態に戻しました/);
});

test("戻しきれない間は印を残して旧形式の add を拒否し、利用者が消した印は restore で止める (R16-11)", () => {
  const marker = (project: Project) => join(project.root, "jobs", markerName);
  const legacyAdd = (project: Project) => project.run(["task", "add", job, `old-${Math.random().toString(36).slice(2, 8)}`, "todo", "旧形式"]);
  const failedRestore = () => {
    const project = new Project();
    project.legacySet();
    const id = project.apply(fullMap);
    let calls = 0;
    const fs: IndexFs = { ...defaultIndexFs, unlink: (path) => { calls++; if (calls === 2) throw new Error("注入した失敗 (unlink)"); defaultIndexFs.unlink(path); } };
    assert.throws(() => restorePlan(project.root, id, fs), (error: unknown) => error instanceof CliError && error.code === "MIGRATE_FAILED");
    assert.equal(JSON.parse(readFileSync(join(project.root, ".raprid-migrate", id, "journal.json"), "utf8")).state, "restoring");
    return { project, id };
  };
  // restore の途中: 印は残り、旧形式の add は拒否。変えずに再実行すると印も消え、旧形式の add が使える
  {
    const { project, id } = failedRestore();
    assert.ok(existsSync(marker(project)), "工程型のタスクが残る間は印を残す");
    const refused = legacyAdd(project);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /移行済みのため、旧形式のタスクは作れません/);
    project.ok(["job", "migrate-workflow", "--restore", id]);
    assert.ok(!existsSync(marker(project)), "戻しきったら印を消す");
    assert.equal(legacyAdd(project).status, 0, "移行前に戻れば旧形式の add を使える");
  }
  // restore の途中で利用者が印を消す: 旧形式の add は記録から拒否し、restore の再実行は止める
  {
    const { project, id } = failedRestore();
    rmSync(marker(project));
    const refused = legacyAdd(project);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /移行の記録 \(\.raprid-migrate\/wf-[0-9a-f-]+\/\) があり、移行か復元が途中です/);
    const before = project.snapshot();
    const result = project.run(["job", "migrate-workflow", "--restore", id]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /移行後に削除された印: jobs\/\.raprid-workflow/);
    assert.deepEqual(project.snapshot(), before);
  }
  // apply の途中 (started。印を置く前に失敗して戻しきれない): 旧形式の add は記録から拒否し、restore の後は使える
  {
    const project = new Project();
    project.legacySet();
    const plan = buildPlan(project.root, parseMap(JSON.stringify(fullMap)), migrator);
    let applied = 0;
    const fs: IndexFs = { ...defaultIndexFs, rename: (from, to) => { applied++; if (applied === 3) throw new Error("注入した失敗 (apply)"); defaultIndexFs.rename(from, to); } };
    let rolled = 0;
    const rollbackFs: IndexFs = { ...defaultIndexFs, rename: (from, to) => { rolled++; if (rolled === 1) throw new Error("注入した失敗 (戻し)"); defaultIndexFs.rename(from, to); } };
    assert.throws(() => applyPlan(plan, plan.hash, fs, rollbackFs), (error: unknown) => error instanceof CliError && /一部を戻せませんでした/.test(error.message));
    assert.ok(!existsSync(marker(project)), "印を置く前に失敗した");
    const refused = legacyAdd(project);
    assert.equal(refused.status, 1, "印が無くても、途中の移行の記録があれば拒否する");
    const id = readdirSync(join(project.root, ".raprid-migrate")).find((name) => name.startsWith("wf-"))!;
    project.ok(["job", "migrate-workflow", "--restore", id]);
    assert.equal(legacyAdd(project).status, 0);
  }
  // 移行済み (completed) で利用者が印を消しても、旧形式の add は拒否する
  {
    const project = new Project();
    project.legacySet();
    project.apply(fullMap);
    rmSync(marker(project));
    const refused = legacyAdd(project);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /移行済みです。旧形式のタスクは作れません/);
  }
});
