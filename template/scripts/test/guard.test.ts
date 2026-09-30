import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { cli, raprid, read, snapshot, today, write } from "./helpers.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "raprid-guard-"));
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

// 標準入力を渡して実行する
function withInput(args: string[], input: string | Buffer, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, RAPRID_ROOT: root, RAPRID_ACTOR: "agent/test", ...env }, input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runAsync(args: string[]): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, RAPRID_ROOT: root, RAPRID_ACTOR: "agent/test" } });
    let stdout = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.on("close", (status) => resolve({ status, stdout }));
  });
}

const revision = (kind: "task" | "qa", selector: string, job = "PROJ-1") => JSON.parse(ok([kind, "show", job, selector, "--json"]).stdout).item.revision as string;
const unchanged = () => snapshot(root, (rel) => rel === "jobs/.locks");

const multiline = "方針は次のとおり。\n\n## 手順\n\n1. 確認環境で実行する\n2. 結果を貼る\n\n```sh\n## コード内の見出し\nraprid task list\n```\n\n以上。";

test("--capabilities に guarded-write-v1 を含む", () => {
  assert.deepEqual(JSON.parse(ok(["--capabilities"]).stdout).capabilities, ["query-v1", "guarded-write-v1", "query-v2", "workflow-v3", "query-v3", "workflow-v4"]);
});

test("複数行の回答を標準入力から受け取り、見出しやコードブロックを含んでも次の読み取りで失わない", () => {
  ok(["qa", "add", "PROJ-1", "policy", "customer", "方針はこれでよいか", "--requested-by", "agent/codex", "--created-by", "agent/codex"]);
  const path = "jobs/PROJ-1/qa/policy/index.md";
  write(root, path, read(root, path).replace("answeredBy:\n", "answeredBy:\nowner: someone # 未知の項目\n") + "\n## メモ\n\n残す節\n");
  const result = withInput(["qa", "resolve", "PROJ-1", "Q-001", "--answer-file", "-", "--answered-by", "human/saiki", "--if-match", revision("qa", "Q-001"), "--json"], multiline.replace(/\n/g, "\r\n") + "\r\n");
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(body), ["schemaVersion", "ok", "item", "issues"]);
  assert.equal(body.ok, true);
  assert.equal(body.item.answer, multiline, "CRLF を LF にし、見出しとコードブロックを含めて保持する");
  assert.deepEqual([body.item.status, body.item.answeredBy, body.item.resolvedAt, body.item.requestedBy, body.item.createdBy], ["resolved", "human/saiki", today(), "agent/codex", "agent/codex"]);
  const text = read(root, path);
  assert.match(text, /owner: someone # 未知の項目\n/, "未知の frontmatter を残す");
  assert.match(text, /\n## メモ\n\n残す節\n$/, "他の節を残す");
  assert.match(text, /## 回答内容\n\n<!-- raprid:answer:begin -->\n方針は次のとおり。\n[\s\S]*以上。\n<!-- raprid:answer:end -->\n/);
  assert.equal(JSON.parse(ok(["qa", "list", "--all", "--json"]).stdout).items[0].answer, multiline, "一覧でも同じ回答を読む");

  // 再オープンして回答し直すと、新しい回答を読む
  ok(["qa", "move", "PROJ-1", "Q-001", "unresolved"]);
  writeFileSync(join(root, "second.md"), "二回目の回答\n\n### 補足\n\n追記");
  ok(["qa", "resolve", "PROJ-1", "Q-001", "--answer-file", join(root, "second.md"), "--answered-by", "human/saiki"]);
  assert.equal(JSON.parse(ok(["qa", "show", "PROJ-1", "Q-001", "--json"]).stdout).item.answer, "二回目の回答\n\n### 補足\n\n追記");
  assert.ok(read(root, path).includes("以上。"), "前の回答も残す");
});

test("空・過大・UTF-8 でない・閉じていないコードブロック・位置引数との併用は、何も変えずに拒否する", () => {
  ok(["qa", "add", "PROJ-1", "policy", "customer", "質問"]);
  const before = unchanged();
  const resolve = (input: string | Buffer, extra: string[] = []) => withInput(["qa", "resolve", "PROJ-1", "Q-001", ...extra, "--answer-file", "-", "--answered-by", "human/saiki", "--json"], input);
  for (const [input, message] of [
    ["  \n\t\n", /回答が空です/],
    [Buffer.alloc(1024 * 1024 + 1, 0x61), /大きすぎます/],
    [Buffer.from([0xe3, 0x81]), /UTF-8 ではありません/],
    ["```sh\n閉じていない", /コードブロックが閉じていません/],
    ["<!-- raprid:answer:end -->", /区切りの行/],
  ] as const) {
    const result = resolve(input);
    assert.equal(result.status, 2, String(message));
    assert.equal(JSON.parse(result.stdout).error.code, "INVALID_ANSWER");
    assert.match(JSON.parse(result.stdout).error.message, message);
  }
  assert.equal(withInput(["qa", "resolve", "PROJ-1", "Q-001", "一行", "--answer-file", "-", "--answered-by", "human/saiki"], "x").status, 2);
  assert.equal(raprid(root, ["qa", "resolve", "PROJ-1", "Q-001", "一行", "--answered-by", "human/saiki", "--if-match", "abc"]).status, 2, "revision の形式");
  assert.equal(withInput(["qa", "resolve", "PROJ-1", "Q-001", "--answer-file", "-"], "x", { RAPRID_ACTOR: "" }).status, 2, "--answered-by も RAPRID_ACTOR も無い");
  assert.deepEqual(unchanged(), before);
  assert.equal(resolve(Buffer.alloc(1024 * 1024, 0x61)).status, 0, "ちょうど 1 MiB は受け付ける");
});

test("revision が一致しなければ REVISION_CONFLICT で何も変えない", () => {
  ok(["qa", "add", "PROJ-1", "policy", "customer", "質問"]);
  ok(["task", "add", "PROJ-1", "a", "todo", "A"]);
  const qaRevision = revision("qa", "Q-001");
  const taskRevision = revision("task", "T-001");
  write(root, "jobs/PROJ-1/qa/policy/index.md", read(root, "jobs/PROJ-1/qa/policy/index.md") + "\n他の人の追記\n");
  write(root, "jobs/PROJ-1/tasks/a/index.md", read(root, "jobs/PROJ-1/tasks/a/index.md") + "\n他の人の追記\n");
  const before = unchanged();
  const qaResult = withInput(["qa", "resolve", "PROJ-1", "Q-001", "--answer-file", "-", "--answered-by", "human/saiki", "--if-match", qaRevision, "--json"], "回答");
  assert.equal(qaResult.status, 1);
  assert.equal(JSON.parse(qaResult.stdout).error.code, "REVISION_CONFLICT");
  const taskResult = raprid(root, ["task", "move", "PROJ-1", "T-001", "progress", "--if-match", taskRevision, "--json"]);
  assert.equal(taskResult.status, 1);
  assert.equal(JSON.parse(taskResult.stdout).error.code, "REVISION_CONFLICT");
  assert.match(raprid(root, ["task", "move", "PROJ-1", "T-001", "progress", "--if-match", taskRevision]).stderr, /競合したため更新しませんでした/);
  assert.deepEqual(unchanged(), before);

  const moved = JSON.parse(ok(["task", "move", "PROJ-1", "T-001", "progress", "--if-match", revision("task", "T-001"), "--json"]).stdout);
  assert.deepEqual([moved.ok, moved.item.status, moved.item.revision === revision("task", "T-001")], [true, "progress", true]);
  assert.equal(moved.item.requestedBy, "agent/test");
});

test("同じ revision から 2 つのプロセスで保存すると、一方だけが成功する", async () => {
  ok(["qa", "add", "PROJ-1", "policy", "customer", "質問"]);
  ok(["task", "add", "PROJ-1", "a", "todo", "A"]);
  writeFileSync(join(root, "one.md"), "一つ目の回答");
  writeFileSync(join(root, "two.md"), "二つ目の回答");
  const qaRevision = revision("qa", "Q-001");
  const answers = await Promise.all(
    ["one.md", "two.md"].map((file) => runAsync(["qa", "resolve", "PROJ-1", "Q-001", "--answer-file", join(root, file), "--answered-by", "human/saiki", "--if-match", qaRevision, "--json"])),
  );
  assert.deepEqual(answers.map((result) => result.status).sort(), [0, 1]);
  const loser = answers.find((result) => result.status === 1)!;
  assert.equal(JSON.parse(loser.stdout).error.code, "REVISION_CONFLICT");
  const winner = JSON.parse(answers.find((result) => result.status === 0)!.stdout).item.answer;
  assert.equal(JSON.parse(ok(["qa", "show", "PROJ-1", "Q-001", "--json"]).stdout).item.answer, winner, "勝った回答だけが残る");

  const taskRevision = revision("task", "T-001");
  const moves = await Promise.all(["progress", "done"].map((status) => runAsync(["task", "move", "PROJ-1", "T-001", status, "--if-match", taskRevision, "--json"])));
  assert.deepEqual(moves.map((result) => result.status).sort(), [0, 1]);
  const status = JSON.parse(moves.find((result) => result.status === 0)!.stdout).item.status;
  assert.equal(JSON.parse(ok(["task", "show", "PROJ-1", "T-001", "--json"]).stdout).item.status, status);
});

test("pending から離れるときは待っている QA を確かめ、未解決・不存在・特定できない・別案件の未解決なら拒否する", () => {
  ok(["job", "create", "other"]);
  ok(["qa", "add", "PROJ-1", "local", "internal", "案件内の質問"]);
  ok(["qa", "add", "other", "remote", "internal", "別案件の質問"]);
  ok(["task", "add", "PROJ-1", "wait-local", "pending", "案件内待ち", "qa/Q-001"]);
  ok(["task", "add", "PROJ-1", "wait-remote", "pending", "別案件待ち", "qa/other/Q-001"]);
  ok(["task", "add", "PROJ-1", "wait-missing", "pending", "存在しない", "qa/Q-099"]);
  ok(["task", "add", "PROJ-1", "wait-other", "pending", "QA 以外", "other: 承認"]);
  ok(["task", "add", "PROJ-1", "wait-task", "pending", "タスク待ち", "task/T-001"]);
  const before = unchanged();
  for (const [selector, message] of [
    ["T-001", /qa\/Q-001 \(未解決\)/],
    ["T-002", /qa\/other\/Q-001 \(未解決\)/],
    ["T-003", /qa\/Q-099 \(見つからない\)/],
  ] as const) {
    const result = raprid(root, ["task", "move", "PROJ-1", selector, "progress", "--json"]);
    assert.equal(result.status, 1, selector);
    assert.equal(JSON.parse(result.stdout).error.code, "BLOCKED_BY_QA");
    assert.match(JSON.parse(result.stdout).error.message, message);
  }
  assert.deepEqual(unchanged(), before, "拒否したときは何も変えない");
  ok(["task", "move", "PROJ-1", "T-004", "todo"]);
  ok(["task", "move", "PROJ-1", "T-005", "todo"]);
  assert.match(read(root, "jobs/PROJ-1/tasks/wait-other/index.md"), /status: todo\n[\s\S]*blockedBy: \[\]/, "QA 以外の待ちは利用者の判断で解除できる");

  // pending のまま待ち先を変えるのは確かめない
  ok(["task", "move", "PROJ-1", "T-003", "pending", "qa/Q-001"]);

  // 解決すると再開待ちとして案内され、明示的に再開できる (自動では再開しない)
  const resolved = ok(["qa", "resolve", "other", "Q-001", "進めてよい", "--answered-by", "human/saiki"]);
  assert.match(resolved.stdout, /再開待ち: T-002 \/ wait-remote \(案件: PROJ-1\) \(raprid task move PROJ-1 T-002 progress\)/);
  assert.match(read(root, "jobs/PROJ-1/tasks/wait-remote/index.md"), /status: pending/);
  ok(["task", "move", "PROJ-1", "T-002", "progress"]);

  // 同じ ID の QA が重複していると特定できない
  ok(["qa", "add", "PROJ-1", "copy", "internal", "重複"]);
  write(root, "jobs/PROJ-1/qa/copy/index.md", read(root, "jobs/PROJ-1/qa/copy/index.md").replace("id: Q-002", "id: Q-001"));
  const ambiguous = raprid(root, ["task", "move", "PROJ-1", "T-001", "todo", "--json"]);
  assert.equal(JSON.parse(ambiguous.stdout).error.code, "BLOCKED_BY_QA");
  assert.match(JSON.parse(ambiguous.stdout).error.message, /特定できない/);

  // 読めない blockedBy のうち QA を指すものは確かめられないので止める
  write(root, "jobs/PROJ-1/tasks/wait-task/index.md", read(root, "jobs/PROJ-1/tasks/wait-task/index.md").replace("status: todo", "status: pending").replace(/blockedBy: \[\]\n/, 'blockedBy: ["qa/Q-001, x"]\n'));
  assert.equal(JSON.parse(raprid(root, ["task", "move", "PROJ-1", "T-005", "todo", "--json"]).stdout).error.code, "BLOCKED_BY_UNREADABLE");
});

test("待っている QA の案件もロックし、同時に更新しても止まらない", async () => {
  ok(["job", "create", "other"]);
  ok(["qa", "add", "other", "remote", "internal", "別案件の質問"]);
  ok(["qa", "resolve", "other", "Q-001", "よい", "--answered-by", "human/saiki"]);
  for (let index = 0; index < 4; index++) ok(["task", "add", "PROJ-1", `t${index}`, "pending", `待ち${index}`, "qa/other/Q-001"]);
  const results = await Promise.all([
    ...[0, 1, 2, 3].map((index) => runAsync(["task", "move", "PROJ-1", `T-00${index + 1}`, "progress", "--json"])),
    ...[0, 1, 2].map((index) => runAsync(["qa", "add", "other", `more-${index}`, "internal", `追加${index}`])),
  ]);
  for (const result of results) assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(JSON.parse(ok(["task", "list", "PROJ-1", "--json"]).stdout).counts.byStatus.progress, 4);
  assert.equal(JSON.parse(ok(["qa", "list", "other", "--json"]).stdout).items.length, 3);
});

test("複数の待ち理由は --blocked-by を繰り返して無損失で保存し、カンマを区切りとみなさない", () => {
  ok(["job", "create", "other"]);
  ok(["qa", "add", "PROJ-1", "first", "internal", "一つ目"]);
  ok(["qa", "add", "PROJ-1", "second", "internal", "二つ目"]);
  ok(["qa", "add", "other", "remote", "internal", "別案件"]);
  ok(["task", "add", "PROJ-1", "a", "pending", "複数待ち", "--blocked-by", "qa/Q-001", "--blocked-by", "qa/Q-002"]);
  const path = "jobs/PROJ-1/tasks/a/index.md";
  assert.match(read(root, path), /blockedBy:\n  - qa\/Q-001\n  - qa\/Q-002\n/);
  const reasons = ["qa/Q-001", "qa/other/Q-001", "other: 承認 (部長, 課長)", "task/T-009"];
  const moved = JSON.parse(ok(["task", "move", "PROJ-1", "T-001", "pending", ...reasons.flatMap((value) => ["--blocked-by", value]), "--if-match", revision("task", "T-001"), "--json"]).stdout);
  assert.deepEqual(moved.item.blockedBy, reasons, "QA・別案件の QA・カンマを含む other・task を 1 件ずつ保つ");
  assert.deepEqual(JSON.parse(ok(["task", "list", "PROJ-1", "--json"]).stdout).issues, [], "QA の参照が壊れない");
  // 同じ一覧で保存し直しても変わらない
  const again = JSON.parse(ok(["task", "move", "PROJ-1", "T-001", "pending", ...reasons.flatMap((value) => ["--blocked-by", value]), "--json"]).stdout);
  assert.deepEqual(again.item.blockedBy, reasons);
  // 従来の位置引数は 1 件として扱い、カンマで分けない
  ok(["task", "move", "PROJ-1", "T-001", "pending", "other: A, B"]);
  assert.deepEqual(JSON.parse(ok(["task", "show", "PROJ-1", "T-001", "--json"]).stdout).item.blockedBy, ["other: A, B"]);
  const before = unchanged();
  assert.equal(raprid(root, ["task", "move", "PROJ-1", "T-001", "pending", "qa/Q-001", "--blocked-by", "qa/Q-002"]).status, 2, "位置引数と --blocked-by は併用できない");
  assert.equal(raprid(root, ["task", "move", "PROJ-1", "T-001", "todo", "--blocked-by", "qa/Q-001"]).status, 2, "pending 以外には指定できない");
  assert.equal(raprid(root, ["task", "move", "PROJ-1", "T-001", "pending", "--blocked-by", ""]).status, 2, "空の値は指定できない");
  assert.equal(raprid(root, ["task", "move", "PROJ-1", "T-001", "pending", "--blocked-by", "a\nb"]).status, 2, "改行を含む値は指定できない");
  assert.deepEqual(unchanged(), before);
  // 複数の QA を待つ pending は、すべて解決するまで解除できない
  ok(["task", "move", "PROJ-1", "T-001", "pending", "--blocked-by", "qa/Q-001", "--blocked-by", "qa/other/Q-001"]);
  ok(["qa", "resolve", "PROJ-1", "Q-001", "よい", "--answered-by", "human/saiki"]);
  assert.match(JSON.parse(raprid(root, ["task", "move", "PROJ-1", "T-001", "progress", "--json"]).stdout).error.message, /qa\/other\/Q-001 \(未解決\)/);
  ok(["qa", "resolve", "other", "Q-001", "よい", "--answered-by", "human/saiki"]);
  ok(["task", "move", "PROJ-1", "T-001", "progress"]);
});
