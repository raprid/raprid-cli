import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { raprid, rapridAsync, read, snapshot, today, write } from "./helpers.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "raprid-items-"));
  mkdirSync(join(root, "jobs"));
  assert.equal(raprid(root, ["job", "create", "PROJ-1"]).status, 0);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ok(args: string[]) {
  const result = raprid(root, args);
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return result;
}

test("案件を雛形から作り、同名や不正な名前は拒否する", () => {
  for (const dir of ["tasks", "assets", "status/todo", "status/pending", "status/progress", "status/done", "qa/status/unresolved", "qa/status/resolved"]) {
    assert.ok(existsSync(join(root, "jobs", "PROJ-1", dir, ".gitkeep")), dir);
  }
  assert.equal(raprid(root, ["job", "create", "PROJ-1"]).status, 1);
  assert.equal(raprid(root, ["job", "create", "../x"]).status, 2);
  assert.equal(raprid(root, ["job", "create", ".hidden"]).status, 2);
  assert.deepEqual(readdirSync(join(root, "jobs")).filter((name) => !name.startsWith(".")), ["PROJ-1"]);
});

test("タスクを追加すると固定IDの実体と状態索引を作る", () => {
  const result = ok(["task", "add", "PROJ-1", "api-setup", "todo", "API を用意する"]);
  assert.match(result.stdout, /作成: T-001 \/ jobs\/PROJ-1\/tasks\/api-setup\/index\.md/);
  const text = read(root, "jobs/PROJ-1/tasks/api-setup/index.md");
  assert.match(text, /^---\nid: T-001\nstatus: todo\ncreatedAt: \d{4}-\d{2}-\d{2}\n/);
  assert.match(text, /\nblockedBy: \[\]\ntest: \[\]\n---\n/);
  assert.match(text, /## タイトル\n\nAPI を用意する\n/);
  assert.match(text, /## 詳細\n/);
  assert.equal(readlinkSync(join(root, "jobs/PROJ-1/status/todo/api-setup")), "../../tasks/api-setup");
  assert.ok(existsSync(join(root, "jobs/PROJ-1/status/todo/api-setup/index.md")), "索引からディレクトリをたどれる");

  ok(["task", "add", "PROJ-1", "await-answer", "pending", "回答後に決める", "qa/Q-001"]);
  assert.match(read(root, "jobs/PROJ-1/tasks/await-answer/index.md"), /id: T-002\nstatus: pending\n[\s\S]*blockedBy:\n  - qa\/Q-001\n/);
});

test("タスク追加の引数誤りは 2、既存との衝突は 1 で何も作らない", () => {
  ok(["task", "add", "PROJ-1", "a", "todo", "A"]);
  const before = snapshot(root, (rel) => rel === "jobs/.locks");
  assert.equal(raprid(root, ["task", "add", "PROJ-1", "b", "pending", "B"]).status, 2);
  assert.equal(raprid(root, ["task", "add", "PROJ-1", "b", "todo", "B", "qa/Q-001"]).status, 2);
  assert.equal(raprid(root, ["task", "add", "PROJ-1", "B", "todo", "B"]).status, 2);
  assert.equal(raprid(root, ["task", "add", "PROJ-1", "b", "done", "B"]).status, 2);
  assert.equal(raprid(root, ["task", "add", "PROJ-1", "b", "todo", "1行目\n2行目"]).status, 2);
  assert.equal(raprid(root, ["task", "add", "PROJ-1", "a", "todo", "A"]).status, 1);
  assert.equal(raprid(root, ["task", "add", "NOPE", "b", "todo", "B"]).status, 1);
  assert.deepEqual(snapshot(root, (rel) => rel === "jobs/.locks"), before);
});

test("同時に追加しても ID は重複しない", async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) => rapridAsync(root, ["task", "add", "PROJ-1", `task-${index}`, "todo", `タスク${index}`])),
  );
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  const ids = readdirSync(join(root, "jobs/PROJ-1/tasks"))
    .filter((name) => name !== ".gitkeep")
    .map((name) => /id: (T-\d+)/.exec(read(root, `jobs/PROJ-1/tasks/${name}/index.md`))![1])
    .sort();
  assert.deepEqual(ids, ["T-001", "T-002", "T-003", "T-004", "T-005", "T-006", "T-007", "T-008"]);
  assert.deepEqual(readdirSync(join(root, "jobs/.locks")), []);
});

test("状態変更は日付・依存関係・索引を一緒に更新し、未知の項目と本文を残す", () => {
  ok(["task", "add", "PROJ-1", "api-setup", "todo", "API"]);
  const path = "jobs/PROJ-1/tasks/api-setup/index.md";
  const custom = read(root, path)
    .replace("test: []", "test:\n  - docs/feature/admin/\nowner: someone # 担当\n# コメント行")
    .replace("## 結果", "## 結果\n\n```md\n## 詳細\nstatus: todo\n```");
  write(root, path, custom);

  ok(["task", "move", "PROJ-1", "T-001", "pending", "other: 権限の付与"]);
  let text = read(root, path);
  assert.match(text, /status: pending\n/);
  assert.match(text, /blockedBy:\n  - other: 権限の付与\n/);
  assert.equal(readlinkSync(join(root, "jobs/PROJ-1/status/pending/api-setup")), "../../tasks/api-setup");
  assert.equal(existsSync(join(root, "jobs/PROJ-1/status/todo/api-setup")), false);

  ok(["task", "move", "PROJ-1", "api-setup", "done"]);
  text = read(root, path);
  assert.match(text, new RegExp(`status: done\\ncreatedAt: .*\\nupdatedAt: ${today()}\\ncompletedAt: ${today()}\\nblockedBy: \\[\\]\\n`));
  assert.match(text, /test:\n  - docs\/feature\/admin\/\nowner: someone # 担当\n# コメント行\n---\n/);
  assert.ok(text.endsWith("## 結果\n\n```md\n## 詳細\nstatus: todo\n```\n"));

  ok(["task", "move", "PROJ-1", "T-001", "todo"]);
  assert.match(read(root, path), /status: todo\n[\s\S]*completedAt:\n/);
});

test("状態変更の異常系は何も変えずに失敗する", () => {
  ok(["task", "add", "PROJ-1", "a", "todo", "A"]);
  ok(["task", "add", "PROJ-1", "b", "todo", "B"]);
  const path = "jobs/PROJ-1/tasks/b/index.md";
  write(root, path, read(root, path).replace("id: T-002", "id: T-001"));
  let before = snapshot(root, (rel) => rel === "jobs/.locks");
  assert.equal(raprid(root, ["task", "move", "PROJ-1", "T-001", "progress"]).status, 1);
  assert.equal(raprid(root, ["task", "move", "PROJ-1", "T-009", "progress"]).status, 1);
  assert.equal(raprid(root, ["task", "move", "PROJ-1", "a", "doing"]).status, 2);
  assert.equal(raprid(root, ["task", "move", "PROJ-1", "a", "done", "qa/Q-001"]).status, 2);
  assert.deepEqual(snapshot(root, (rel) => rel === "jobs/.locks"), before);

  write(root, path, read(root, path).replace("id: T-001", "id: T-002").replace("test: []", "test:\n  nested: value"));
  before = snapshot(root, (rel) => rel === "jobs/.locks");
  const result = raprid(root, ["task", "move", "PROJ-1", "b", "progress"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /対応していない frontmatter/);
  assert.deepEqual(snapshot(root, (rel) => rel === "jobs/.locks"), before);
});

test("索引の張り替えに失敗したら実体も元のままにする", { skip: process.getuid?.() === 0 }, () => {
  ok(["task", "add", "PROJ-1", "a", "todo", "A"]);
  const before = snapshot(root, (rel) => rel === "jobs/.locks");
  chmodSync(join(root, "jobs/PROJ-1/status/done"), 0o555);
  try {
    assert.equal(raprid(root, ["task", "move", "PROJ-1", "a", "done"]).status, 1);
  } finally {
    chmodSync(join(root, "jobs/PROJ-1/status/done"), 0o755);
  }
  assert.deepEqual(snapshot(root, (rel) => rel === "jobs/.locks"), before);
});

test("詳細を追加すると連番の md を作り、index の「## 詳細」からリンクする", () => {
  ok(["task", "add", "PROJ-1", "api-setup", "todo", "API"]);
  const path = "jobs/PROJ-1/tasks/api-setup/index.md";
  write(root, path, read(root, path).replace("## 内容", "```md\n## 詳細\n```\n\n## 内容"));
  ok(["task", "note", "PROJ-1", "T-001", "investigation", "原因の調査"]);
  ok(["task", "note", "PROJ-1", "api-setup", "fix"]);
  assert.match(read(root, "jobs/PROJ-1/tasks/api-setup/01-investigation.md"), /^# 原因の調査\n\n## 計画\n/);
  assert.match(read(root, "jobs/PROJ-1/tasks/api-setup/02-fix.md"), /^# fix\n/);
  const text = read(root, path);
  assert.match(text, /## 詳細\n\n\* \[原因の調査\]\(01-investigation\.md\)\n\* \[fix\]\(02-fix\.md\)\n\n## 結果/);
  assert.match(text, /```md\n## 詳細\n```/, "コードブロック内の見出しは変えない");
  const before = snapshot(root, (rel) => rel === "jobs/.locks");
  assert.equal(raprid(root, ["task", "note", "PROJ-1", "T-001", "fix"]).status, 1);
  assert.equal(raprid(root, ["task", "note", "PROJ-1", "T-001", "Bad Name"]).status, 2);
  assert.deepEqual(snapshot(root, (rel) => rel === "jobs/.locks"), before);
});

test("一覧は frontmatter を正として並べ、索引の不一致を報告する", () => {
  ok(["task", "add", "PROJ-1", "a", "todo", "A を作る"]);
  ok(["task", "add", "PROJ-1", "b", "pending", "B を待つ", "qa/Q-001"]);
  ok(["job", "create", "other"]);
  let result = ok(["task", "list", "PROJ-1"]);
  assert.match(result.stdout, /PROJ-1 \(jobs\/PROJ-1\/\)\n  progress \(0\)\n  todo \(1\)\n    T-001 +a +A を作る\n  pending \(1\)\n    T-002 +b +B を待つ \(待ち: qa\/Q-001\)\n  done \(0\)\n  合計: 2$/m);
  assert.doesNotMatch(result.stdout, /要確認/);
  result = ok(["task", "list"]);
  assert.match(result.stdout, /^other \(jobs\/other\/\)/m);

  unlinkSync(join(root, "jobs/PROJ-1/status/todo/a"));
  symlinkSync("../../tasks/a", join(root, "jobs/PROJ-1/status/done/a"));
  symlinkSync("../../tasks/zzz", join(root, "jobs/PROJ-1/status/done/zzz"));
  result = ok(["task", "list", "PROJ-1"]);
  assert.match(result.stdout, /要確認:\n/);
  assert.match(result.stdout, /索引の不一致: a \(索引: done, status: todo\)/);
  assert.match(result.stdout, /実体のない索引: jobs\/PROJ-1\/status\/done\/zzz/);
});

test("QA の追加・解決・再オープン", () => {
  ok(["qa", "add", "PROJ-1", "deploy-policy", "customer", "本番反映の手順はこれでよいか"]);
  const path = "jobs/PROJ-1/qa/deploy-policy/index.md";
  assert.match(read(root, path), /^---\nid: Q-001\nstatus: unresolved\n[\s\S]*job: PROJ-1\naskTo: customer\nblockedBy: \[\]\n---\n\n# Q&A\n\n## 質問内容\n\n本番反映の手順はこれでよいか\n\n## 回答内容\n$/);
  assert.equal(readlinkSync(join(root, "jobs/PROJ-1/qa/status/unresolved/deploy-policy")), "../../deploy-policy");
  write(root, path, `${read(root, path)}\n未回答\n\n検討メモ\n`);

  ok(["qa", "resolve", "PROJ-1", "Q-001", "確認環境から実行する"]);
  let text = read(root, path);
  assert.match(text, new RegExp(`status: resolved\\n[\\s\\S]*resolvedAt: ${today()}\\n`));
  assert.ok(text.endsWith("## 回答内容\n\n確認環境から実行する\n\n検討メモ\n"), text);
  assert.ok(lstatSync(join(root, "jobs/PROJ-1/qa/status/resolved/deploy-policy")).isSymbolicLink());

  ok(["qa", "move", "PROJ-1", "deploy-policy", "unresolved"]);
  text = read(root, path);
  assert.match(text, /status: unresolved\n[\s\S]*resolvedAt:\n/);
  assert.ok(text.includes("確認環境から実行する"), "回答は残す");
  assert.ok(lstatSync(join(root, "jobs/PROJ-1/qa/status/unresolved/deploy-policy")).isSymbolicLink());

  assert.equal(raprid(root, ["qa", "add", "PROJ-1", "status", "internal", "予約名"]).status, 2);
  assert.equal(raprid(root, ["qa", "add", "PROJ-1", "x", "boss", "確認先の誤り"]).status, 2);
  assert.equal(raprid(root, ["qa", "move", "PROJ-1", "Q-001", "resolved"]).status, 2);
  assert.equal(raprid(root, ["qa", "move", "PROJ-1", "Q-001", "unresolved", "余計な回答"]).status, 2);
  ok(["qa", "add", "PROJ-1", "second", "internal", "二つ目"]);
  const result = ok(["qa", "list", "PROJ-1"]);
  assert.match(result.stdout, /unresolved \(2\)\n    Q-001 +deploy-policy +本番反映の手順はこれでよいか \(customer\)\n    Q-002 +second +二つ目 \(internal\)/);
});

test("入口の使い方と終了コード", () => {
  assert.equal(raprid(root, ["--help"]).status, 0);
  assert.equal(raprid(root, []).status, 2);
  assert.equal(raprid(root, ["nope"]).status, 2);
  assert.equal(raprid(root, ["task", "nope"]).status, 2);
  assert.equal(raprid(root, ["task", "add", "--help"]).status, 0);
  const protocol = raprid(root, ["--protocol"]);
  assert.deepEqual(JSON.parse(protocol.stdout), { format: 1, protocol: 1 });
});

test("行末コメント・引用符・特殊文字を含む値を保つ", () => {
  ok(["task", "add", "PROJ-1", "a", "todo", "A"]);
  const path = "jobs/PROJ-1/tasks/a/index.md";
  write(root, path, read(root, path).replace("status: todo", "status: todo # 状態"));
  ok(["task", "move", "PROJ-1", "T-001", "pending", "other: #123 の回答"]);
  const text = read(root, path);
  assert.match(text, /status: pending # 状態\n/);
  assert.match(text, /blockedBy:\n  - "other: #123 の回答"\n/);
  assert.match(ok(["task", "list", "PROJ-1"]).stdout, /待ち: other: #123 の回答/);

  write(root, path, read(root, path).replace('blockedBy:\n  - "other: #123 の回答"', 'blockedBy: ["a, b"]'));
  const quoted = raprid(root, ["task", "move", "PROJ-1", "T-001", "todo"]);
  assert.equal(quoted.status, 0, "blockedBy は置き換えるだけなので読めなくても進める");
  write(root, path, read(root, path).replace("test: []", "test:x"));
  assert.equal(raprid(root, ["task", "move", "PROJ-1", "T-001", "progress"]).status, 1, "key:値 は対応外");
});

test("見出しに角括弧を含む詳細のリンクを壊さない", () => {
  ok(["task", "add", "PROJ-1", "a", "todo", "A"]);
  ok(["task", "note", "PROJ-1", "T-001", "fix", "[重要] 修正"]);
  assert.match(read(root, "jobs/PROJ-1/tasks/a/index.md"), /\* \[\\\[重要\\\] 修正\]\(01-fix\.md\)/);
});

test("index.md の無いディレクトリは採番前に報告する", () => {
  mkdirSync(join(root, "jobs/PROJ-1/qa/assets"));
  const result = raprid(root, ["qa", "add", "PROJ-1", "q", "internal", "質問"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /index\.md の無いディレクトリがあります: jobs\/PROJ-1\/qa\/assets/);
  assert.match(ok(["qa", "list", "PROJ-1"]).stdout, /index\.md が無い: jobs\/PROJ-1\/qa\/assets/);
});
