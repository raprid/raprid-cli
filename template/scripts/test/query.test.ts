import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { cli, raprid, read, write } from "./helpers.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "raprid-query-"));
  mkdirSync(join(root, "jobs"));
  ok(["job", "create", "PROJ-1"]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ok(args: string[]) {
  const result = raprid(root, args);
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return result;
}

// stdout が 1 つの JSON だけであることを確かめて返す
function json(args: string[], status = 0) {
  const result = raprid(root, args);
  assert.equal(result.status, status, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, "", "JSON のときは stderr に出さない");
  assert.ok(result.stdout.endsWith("\n") && result.stdout.trim().split("\n").length === 1, result.stdout);
  return JSON.parse(result.stdout);
}

function setStatus(rel: string, from: string, to: string, kind: "task" | "qa" = "task") {
  write(root, rel, read(root, rel).replace(`status: ${from}`, `status: ${to}`));
  const name = rel.split("/").at(-2)!;
  const statusDir = (status: string) => join(root, dirname(dirname(rel)), kind === "task" ? "../status" : "status", status, name);
  unlinkSync(statusDir(from));
  symlinkSync(kind === "task" ? `../../tasks/${name}` : `../../${name}`, statusDir(to));
}

test("--capabilities は query-v1 を返し、--protocol の形は変えない", () => {
  assert.deepEqual(JSON.parse(ok(["--capabilities"]).stdout), { schemaVersion: 1, capabilities: ["query-v1"] });
  assert.deepEqual(JSON.parse(ok(["--protocol"]).stdout), { format: 1, protocol: 1 });
});

test("task list --json はデータ契約に沿い、既定で done を隠して状態・数値IDの順に並べる", () => {
  for (let index = 1; index <= 10; index++) ok(["task", "add", "PROJ-1", `t${index}`, "todo", `タスク${index}`]);
  ok(["task", "move", "PROJ-1", "T-003", "progress"]);
  ok(["task", "move", "PROJ-1", "T-004", "done"]);
  ok(["task", "move", "PROJ-1", "T-005", "pending", "other: 権限"]);
  const listed = json(["task", "list", "PROJ-1", "--json"]);
  assert.equal(listed.schemaVersion, 1);
  assert.equal(listed.kind, "task");
  assert.deepEqual(listed.items.map((item: { id: string }) => item.id), ["T-003", "T-001", "T-002", "T-006", "T-007", "T-008", "T-009", "T-010", "T-005"]);
  assert.deepEqual(listed.counts, { total: 10, shown: 9, byStatus: { progress: 1, todo: 7, pending: 1, done: 1, unknown: 0 } });
  assert.deepEqual(listed.issues, []);

  const item = listed.items.find((entry: { id: string }) => entry.id === "T-005");
  assert.deepEqual(Object.keys(item), ["job", "kind", "id", "name", "path", "title", "status", "createdAt", "updatedAt", "requestedBy", "createdBy", "revision", "completedAt", "blockedBy"]);
  assert.equal(item.path, "jobs/PROJ-1/tasks/t5/index.md");
  assert.equal(item.title, "タスク5");
  assert.equal(item.completedAt, null, "空の日付は null");
  assert.deepEqual(item.blockedBy, ["other: 権限"]);
  assert.equal(item.revision, createHash("sha256").update(readFileSync(join(root, item.path))).digest("hex"));

  assert.deepEqual(json(["task", "list", "PROJ-1", "--all", "--json"]).items.at(-1).id, "T-004");
  assert.deepEqual(json(["task", "list", "PROJ-1", "--status", "done,pending", "--json"]).items.map((entry: { id: string }) => entry.id), ["T-005", "T-004"]);
  assert.deepEqual(json(["task", "list", "PROJ-1", "--search", "t-01", "--json"]).items.map((entry: { id: string }) => entry.id), ["T-010"]);
  assert.deepEqual(json(["task", "list", "PROJ-1", "--search", "タスク1", "--all", "--json"]).items.map((entry: { id: string }) => entry.id), ["T-001", "T-010"]);
  assert.deepEqual(json(["task", "list", "PROJ-1", "--search", "T5", "--json"]).items.map((entry: { id: string }) => entry.id), ["T-005"], "名前も大文字小文字を区別しない");
});

test("引数の誤りは 2、存在しない案件は 1 で、--json では stdout に error を返す", () => {
  const conflict = json(["task", "list", "--all", "--status", "todo", "--json"], 2);
  assert.equal(conflict.schemaVersion, 1);
  assert.equal(conflict.error.code, "USAGE");
  assert.match(conflict.error.message, /--all と --status/);
  assert.equal(json(["task", "list", "--status", "doing", "--json"], 2).error.code, "USAGE");
  assert.equal(json(["task", "list", "--json", "--long"], 2).error.code, "USAGE");
  assert.equal(json(["qa", "list", "--json", "--width", "80"], 2).error.code, "USAGE");
  assert.equal(json(["task", "list", "--json", "--unknown-option"], 2).error.code, "USAGE");
  const missing = json(["task", "list", "NOPE", "--json"], 1);
  assert.deepEqual(missing.error, { code: "JOB_NOT_FOUND", message: "案件が見つかりません: jobs/NOPE" });
  assert.equal(raprid(root, ["task", "list", "NOPE"]).status, 1);
  assert.equal(raprid(root, ["task", "list", "--width", "39"]).status, 2);
  assert.equal(raprid(root, ["task", "list", "--width", "241"]).status, 2);
  assert.equal(raprid(root, ["task", "list", "--border", "double"]).status, 2);
  assert.equal(raprid(root, ["task", "list", "--color", "yes"]).status, 2);

  // 0 件の案件は成功
  const empty = json(["task", "list", "PROJ-1", "--json"]);
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.counts, { total: 0, shown: 0, byStatus: { progress: 0, todo: 0, pending: 0, done: 0, unknown: 0 } });
  assert.match(ok(["task", "list", "PROJ-1"]).stdout, /^PROJ-1  0件表示 \/ 全0件\n  該当なし\n$/);
});

test("既存の診断を種類ごとの code で返し、隠れた done や未知の状態も報告する", () => {
  ok(["task", "add", "PROJ-1", "a", "todo", "A"]);
  ok(["task", "add", "PROJ-1", "b", "todo", "B"]);
  ok(["task", "add", "PROJ-1", "c", "todo", "C"]);
  ok(["task", "add", "PROJ-1", "d", "todo", "D"]);
  ok(["task", "add", "PROJ-1", "e", "todo", "E"]);
  ok(["task", "add", "PROJ-1", "f", "todo", "F"]);
  ok(["task", "add", "PROJ-1", "g", "todo", "G"]);
  // b: done のまま索引がずれている (既定では隠れる)
  ok(["task", "move", "PROJ-1", "T-002", "done"]);
  unlinkSync(join(root, "jobs/PROJ-1/status/done/b"));
  symlinkSync("../../tasks/b", join(root, "jobs/PROJ-1/status/todo/b"));
  // c と d: ID 重複
  write(root, "jobs/PROJ-1/tasks/d/index.md", read(root, "jobs/PROJ-1/tasks/d/index.md").replace("id: T-004", "id: T-003"));
  // e: 未知の状態
  write(root, "jobs/PROJ-1/tasks/e/index.md", read(root, "jobs/PROJ-1/tasks/e/index.md").replace("status: todo", "status: doing"));
  // f: frontmatter が壊れている
  write(root, "jobs/PROJ-1/tasks/f/index.md", read(root, "jobs/PROJ-1/tasks/f/index.md").replace("test: []", "test:x"));
  // g: pending なのに blockedBy が空・索引なし
  setStatus("jobs/PROJ-1/tasks/g/index.md", "todo", "pending");
  unlinkSync(join(root, "jobs/PROJ-1/status/pending/g"));
  // index.md の無いディレクトリ、実体の無い索引、リンク以外、不正なリンク先、複数の索引
  mkdirSync(join(root, "jobs/PROJ-1/tasks/no-index"));
  symlinkSync("../../tasks/zzz", join(root, "jobs/PROJ-1/status/done/zzz"));
  write(root, "jobs/PROJ-1/status/done/a", "not a link");
  symlinkSync("../../tasks/elsewhere", join(root, "jobs/PROJ-1/status/progress/c"));

  const listed = json(["task", "list", "PROJ-1", "--json"]);
  const codes = listed.issues.map((issue: { code: string; path: string }) => `${issue.code} ${issue.path}`);
  for (const expected of [
    "LINK_MISMATCH jobs/PROJ-1/status/todo/b",
    "ID_DUPLICATE jobs/PROJ-1/tasks/c/index.md",
    "ID_DUPLICATE jobs/PROJ-1/tasks/d/index.md",
    "STATUS_UNKNOWN jobs/PROJ-1/tasks/e/index.md",
    "PARSE_ERROR jobs/PROJ-1/tasks/f/index.md",
    "PENDING_WITHOUT_BLOCKER jobs/PROJ-1/tasks/g/index.md",
    "LINK_MISSING jobs/PROJ-1/tasks/g/index.md",
    "INDEX_MISSING jobs/PROJ-1/tasks/no-index",
    "LINK_ORPHAN jobs/PROJ-1/status/done/zzz",
    "LINK_NOT_SYMLINK jobs/PROJ-1/status/done/a",
    "LINK_TARGET_INVALID jobs/PROJ-1/status/progress/c",
    "LINK_MULTIPLE jobs/PROJ-1/tasks/a/index.md",
  ]) {
    assert.ok(codes.includes(expected), `${expected}\n${codes.join("\n")}`);
  }
  const issue = listed.issues.find((entry: { code: string }) => entry.code === "ID_DUPLICATE");
  assert.deepEqual(Object.keys(issue), ["code", "severity", "job", "kind", "id", "path", "message"]);
  assert.deepEqual([issue.severity, issue.job, issue.kind, issue.id], ["error", "PROJ-1", "task", "T-003"]);
  assert.equal(listed.issues.find((entry: { code: string }) => entry.code === "INDEX_MISSING").id, null);
  assert.ok(!listed.items.some((entry: { id: string }) => entry.id === "T-002"), "done は既定で隠す");
  // 未知の状態・読めないものは除外せずに末尾へ
  assert.deepEqual(listed.items.slice(-3).map((entry: { name: string; status: string | null }) => `${entry.name}:${entry.status}`), ["e:doing", "f:null", "no-index:null"]);
  assert.equal(listed.items.find((entry: { name: string }) => entry.name === "f").title, "F", "frontmatter が壊れてもタイトルは読む");

  const text = ok(["task", "list", "PROJ-1"]).stdout;
  assert.match(text, /\n要確認 \(\d+\)\n/);
  assert.match(text, /  索引の不一致: b \(索引: todo, status: done\)\n    T-002  jobs\/PROJ-1\/status\/todo\/b\n/);
  assert.match(text, /  ID重複: T-003 \(c, d\)\n/);
  assert.match(text, /^ID未設定  未設定 +no-index$/m);
});

test("pending の QA 参照を同じ案件・別案件とも確かめる", () => {
  ok(["job", "create", "other"]);
  ok(["qa", "add", "other", "shared", "internal", "共通の質問"]);
  ok(["qa", "add", "PROJ-1", "local", "internal", "案件内の質問"]);
  ok(["task", "add", "PROJ-1", "wait-other", "pending", "別案件待ち", "qa/other/Q-001"]);
  ok(["task", "add", "PROJ-1", "wait-local", "pending", "案件内待ち", "qa/local"]);
  ok(["task", "add", "PROJ-1", "wait-missing", "pending", "存在しない", "qa/NOPE/Q-001"]);
  let issues = json(["task", "list", "PROJ-1", "--json"]).issues;
  assert.deepEqual(issues.map((issue: { code: string; path: string }) => `${issue.code} ${issue.path}`), ["QA_REF_NOT_FOUND jobs/PROJ-1/tasks/wait-missing/index.md"]);

  ok(["qa", "resolve", "other", "Q-001", "回答", "--answered-by", "human/saiki"]);
  ok(["qa", "resolve", "PROJ-1", "local", "回答", "--answered-by", "human/saiki"]);
  issues = json(["task", "list", "PROJ-1", "--json"]).issues;
  assert.deepEqual(issues.map((issue: { code: string; message: string }) => issue.code).sort(), ["QA_REF_NOT_FOUND", "QA_REF_RESOLVED", "QA_REF_RESOLVED"]);
  assert.ok(issues.some((issue: { message: string }) => issue.message === "解決済みQAを待機中: wait-other (qa/other/Q-001)"));
  // 参照先の案件は読むが、一覧の対象には入れない
  const listed = json(["task", "list", "PROJ-1", "--json"]);
  assert.ok(listed.items.every((item: { job: string }) => item.job === "PROJ-1"));
  assert.ok(listed.issues.every((issue: { job: string }) => issue.job === "PROJ-1"));
});

test("show は ID か名前で 1 件を選び、重複した ID は選ばない", () => {
  ok(["task", "add", "PROJ-1", "api-setup", "pending", "API を用意する", "other: 鍵"]);
  ok(["qa", "add", "PROJ-1", "policy", "customer", "方針はこれでよいか"]);
  const shown = json(["task", "show", "PROJ-1", "T-001", "--json"]);
  assert.deepEqual(Object.keys(shown), ["schemaVersion", "kind", "item", "issues"]);
  assert.equal(shown.item.rawMarkdown, read(root, "jobs/PROJ-1/tasks/api-setup/index.md"));
  assert.equal(shown.item.revision, createHash("sha256").update(read(root, "jobs/PROJ-1/tasks/api-setup/index.md")).digest("hex"));
  assert.equal(json(["task", "show", "PROJ-1", "api-setup", "--json"]).item.id, "T-001");

  const qa = json(["qa", "show", "PROJ-1", "Q-001", "--json"]).item;
  assert.deepEqual(Object.keys(qa).slice(12), ["question", "answer", "askTo", "answeredBy", "resolvedAt", "rawMarkdown"]);
  assert.deepEqual([qa.question, qa.answer, qa.askTo, qa.answeredBy], ["方針はこれでよいか", null, "customer", null]);

  const text = ok(["task", "show", "PROJ-1", "T-001"]).stdout;
  assert.match(text, /^T-001  pending\nAPI を用意する\n案件 +PROJ-1\nパス +jobs\/PROJ-1\/tasks\/api-setup\/index\.md\n/);
  assert.match(text, /待ち +other: 鍵\n/);
  assert.match(text, /\n## タイトル\n\nAPI を用意する\n/);

  ok(["task", "add", "PROJ-1", "copy", "todo", "複製"]);
  write(root, "jobs/PROJ-1/tasks/copy/index.md", read(root, "jobs/PROJ-1/tasks/copy/index.md").replace("id: T-002", "id: T-001"));
  const ambiguous = json(["task", "show", "PROJ-1", "T-001", "--json"], 1);
  assert.equal(ambiguous.error.code, "AMBIGUOUS");
  assert.match(ambiguous.error.message, /jobs\/PROJ-1\/tasks\/api-setup\/index\.md, jobs\/PROJ-1\/tasks\/copy\/index\.md/);
  const byName = json(["task", "show", "PROJ-1", "copy", "--json"]);
  assert.deepEqual(byName.issues.map((issue: { code: string }) => issue.code), ["ID_DUPLICATE"], "名前なら一意に選べ、自分の診断を添える");
  assert.equal(json(["task", "show", "PROJ-1", "T-009", "--json"], 1).error.code, "NOT_FOUND");
  assert.equal(json(["qa", "show", "PROJ-1", "nope", "--json"], 1).error.code, "NOT_FOUND");
  assert.equal(json(["task", "show", "PROJ-1", "Bad Name", "--json"], 2).error.code, "USAGE");
  assert.equal(json(["task", "show", "NOPE", "T-001", "--json"], 1).error.code, "JOB_NOT_FOUND");
  assert.equal(raprid(root, ["task", "show", "PROJ-1"]).status, 2);
});

test("ui snapshot は全状態の案件・タスク・QA・診断を決定的な順で返す", () => {
  ok(["job", "create", "AAA"]);
  ok(["task", "add", "PROJ-1", "a", "todo", "A"]);
  ok(["task", "add", "PROJ-1", "b", "todo", "B"]);
  ok(["task", "move", "PROJ-1", "T-002", "done"]);
  ok(["qa", "add", "PROJ-1", "q", "internal", "質問1\n".trim()]);
  ok(["qa", "resolve", "PROJ-1", "Q-001", "回答する", "--answered-by", "human/saiki"]);
  ok(["task", "add", "AAA", "x", "progress", "X"]);
  symlinkSync("../../tasks/gone", join(root, "jobs/AAA/status/done/gone"));

  const first = json(["ui", "snapshot", "--json"]);
  assert.deepEqual(Object.keys(first), ["schemaVersion", "generatedAt", "scope", "jobs", "tasks", "qas", "issues"]);
  assert.ok(!Number.isNaN(Date.parse(first.generatedAt)) && first.generatedAt.endsWith("Z"));
  assert.deepEqual(first.scope, { job: null });
  assert.deepEqual(first.jobs.map((job: { name: string }) => job.name), ["AAA", "PROJ-1"]);
  assert.deepEqual(first.jobs[1], {
    name: "PROJ-1",
    path: "jobs/PROJ-1",
    title: null,
    counts: {
      task: { total: 2, byStatus: { progress: 0, todo: 1, pending: 0, done: 1, unknown: 0 } },
      qa: { total: 1, byStatus: { unresolved: 0, resolved: 1, unknown: 0 } },
    },
  });
  assert.deepEqual(first.tasks.map((task: { job: string; id: string }) => `${task.job}/${task.id}`), ["AAA/T-001", "PROJ-1/T-001", "PROJ-1/T-002"]);
  assert.deepEqual([first.qas[0].answer, first.qas[0].answeredBy, first.qas[0].status], ["回答する", "human/saiki", "resolved"]);
  assert.deepEqual(first.issues.map((issue: { code: string; job: string }) => `${issue.job} ${issue.code}`), ["AAA LINK_ORPHAN"]);

  const second = json(["ui", "snapshot", "--json"]);
  assert.deepEqual({ ...second, generatedAt: "" }, { ...first, generatedAt: "" }, "生成時刻以外は同じ");

  const scoped = json(["ui", "snapshot", "PROJ-1", "--json"]);
  assert.deepEqual(scoped.scope, { job: "PROJ-1" });
  assert.deepEqual(scoped.jobs.map((job: { name: string }) => job.name), ["PROJ-1"]);
  assert.deepEqual(scoped.issues, []);
  assert.equal(raprid(root, ["ui", "snapshot"]).status, 2, "--json が必要");
  assert.equal(json(["ui", "snapshot", "NOPE", "--json"], 1).error.code, "JOB_NOT_FOUND");
  assert.equal(raprid(root, ["ui", "--help"]).status, 0);

  // 案件名として扱えないディレクトリがあっても止めずに報告する
  mkdirSync(join(root, "jobs", "bad name"));
  const withBad = json(["ui", "snapshot", "--json"]);
  assert.deepEqual(withBad.jobs.map((job: { name: string }) => job.name), ["AAA", "PROJ-1"]);
  assert.deepEqual(withBad.issues.at(-1), { code: "JOB_NAME_INVALID", severity: "warning", job: "bad name", kind: "job", id: null, path: "jobs/bad name", message: "案件名として扱えないディレクトリ: jobs/bad name" });
  assert.match(ok(["task", "list"]).stdout, /\n要確認 \(1\)\n  案件名として扱えないディレクトリ: jobs\/bad name\n/);
  assert.equal(json(["task", "list", "PROJ-1", "--json"]).issues.length, 0, "案件を指定したときは対象外");
});

test("欠落した actor・制御文字・複数行の質問を JSON は原文のまま、表示では安全に扱う", () => {
  ok(["task", "add", "PROJ-1", "legacy", "todo", "旧記録"]);
  const path = "jobs/PROJ-1/tasks/legacy/index.md";
  write(root, path, read(root, path).replace("requestedBy: agent/test\ncreatedBy: agent/test\n", "").replace("## タイトル\n\n旧記録", "## タイトル\n\n\u001b[31m赤\u001b[0m\u0007と‮逆順"));
  const item = json(["task", "list", "--json"]).items[0];
  assert.equal(item.requestedBy, null);
  assert.equal(item.createdBy, null);
  assert.equal(item.title, "\u001b[31m赤\u001b[0m\u0007と‮逆順");
  const raw = raprid(root, ["task", "list", "--json"]).stdout;
  assert.ok(raw.includes("\\u001b[31m") && !raw.includes("\u001b"), "JSON はエスケープで保持する");

  const text = ok(["task", "list", "PROJ-1", "--long", "--color", "always"]).stdout;
  assert.match(text, /T-001  \u001b\[32mtodo\u001b\[39m  赤と逆順\n/, "表示では制御文字と ANSI を除き、色は自分で付ける");
  assert.match(text, /依頼: 不明（旧記録） \/ 記録: 不明（旧記録）/);
  assert.doesNotMatch(ok(["task", "list", "PROJ-1"]).stdout, /\u001b/, "非 TTY は既定で ANSI を出さない");

  ok(["qa", "add", "PROJ-1", "multi", "customer", "一行目"]);
  const qaPath = "jobs/PROJ-1/qa/multi/index.md";
  write(root, qaPath, read(root, qaPath).replace("一行目", "一行目\n\n```sh\n## コード内\n```\n\n二段落目"));
  const qa = json(["qa", "show", "PROJ-1", "Q-001", "--json"]).item;
  assert.equal(qa.question, "一行目\n\n```sh\n## コード内\n```\n\n二段落目");
  assert.equal(qa.title, "一行目");
});

test("job list は検索と JSON に対応し、通常の表示は従来の形を保つ", () => {
  ok(["job", "create", "AAA"]);
  ok(["task", "add", "AAA", "x", "todo", "X"]);
  assert.equal(ok(["job", "list"]).stdout, "案件 (2)\n  AAA\n  PROJ-1\n合計: 2\n");
  assert.equal(ok(["job", "list", "--search", "proj"]).stdout, "案件 (1)\n  PROJ-1\n合計: 1 (全2件中)\n");
  const listed = json(["job", "list", "--json"]);
  assert.equal(listed.kind, "job");
  assert.deepEqual(listed.counts, { total: 2, shown: 2, byStatus: {} });
  assert.equal(listed.items[0].counts.task.byStatus.todo, 1);
  assert.deepEqual(json(["job", "list", "--search", "aa", "--json"]).items.map((job: { name: string }) => job.name), ["AAA"]);
  assert.equal(json(["job", "list", "--search", "", "--json"], 2).error.code, "USAGE");
});

test("node_modules の無い場所へ複製した scripts/ でも直接実行できる", () => {
  ok(["task", "add", "PROJ-1", "a", "todo", "日本語のタイトル👨‍👩‍👧"]);
  cpSync(dirname(cli), join(root, "scripts"), { recursive: true, filter: (source) => !source.includes("node_modules") });
  assert.equal(existsSync(join(root, "node_modules")), false);
  const script = join(root, "scripts", "cli.ts");
  const result = raprid(root, ["task", "list", "--json"], { script });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).items[0].title, "日本語のタイトル👨‍👩‍👧");
  const text = raprid(root, ["task", "list"], { script });
  assert.match(text.stdout, /^T-001  todo  日本語のタイトル👨‍👩‍👧$/m);
});
