import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FrontmatterError } from "../lib/frontmatter.ts";
import { detectFormat, initialTaskV2, readTaskFile, validateTaskV2 } from "../lib/workflow.ts";
import { YamlEditError, YamlFrontmatter } from "../lib/yamlfront.ts";
import { cli, raprid, read, snapshot, write } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures", "workflow");
const schemaPath = join(here, "..", "lib", "schema", "task-workflow-v2.schema.json");
const fixture = (name: string) => readFileSync(join(fixtures, name), "utf8");
const validFixtures = readdirSync(fixtures).filter((name) => name.startsWith("v2-") && name.endsWith(".md")).sort();

interface Case {
  name: string;
  base: string;
  set?: [(string | number)[], unknown][];
  delete?: (string | number)[][];
  schema: boolean;
  codes: [string, string][];
}
const cases = (JSON.parse(readFileSync(join(fixtures, "invalid.json"), "utf8")) as { cases: Case[] }).cases;

// JSON Schema の検証器 (ajv は開発時の依存。導入されていなければ schema との照合だけを飛ばす)。
// 導入されているのに schema をコンパイルできないときは失敗にする (照合を黙って飛ばさない)。
// strictRequired は外す: artifactRef の「path か commit の少なくとも一方」を anyOf + required で書いているため
type Ajv = new (options: object) => { compile: (schema: object) => (data: unknown) => boolean };
async function schemaValidator(): Promise<((data: unknown) => boolean) | undefined> {
  let Ajv2020: Ajv;
  try {
    ({ default: Ajv2020 } = (await import("ajv/dist/2020.js")) as unknown as { default: Ajv });
  } catch {
    return undefined;
  }
  return new Ajv2020({ allErrors: true, strict: true, strictRequired: false }).compile(JSON.parse(readFileSync(schemaPath, "utf8")));
}

function mutate(item: Case): string {
  const frontmatter = YamlFrontmatter.parse(fixture(item.base), item.base);
  for (const [path, value] of item.set ?? []) frontmatter.set(path, value);
  for (const path of item.delete ?? []) frontmatter.delete(path);
  return frontmatter.toString();
}

test("旧形式と新形式を見分け、対応していない版は扱わない", () => {
  assert.deepEqual(detectFormat(YamlFrontmatter.parse(fixture("legacy.md")).data()), { kind: "legacy" });
  assert.deepEqual(detectFormat({ workflowVersion: 2 }), { kind: "v2" });
  assert.deepEqual(detectFormat({ workflowVersion: "2" }), { kind: "unsupported", version: "2" });
  assert.deepEqual(detectFormat({ workflowVersion: 3 }), { kind: "v3" }, "v3 は T-018 で追加した別の形式");
  assert.deepEqual(detectFormat({ workflowVersion: 5 }), { kind: "unsupported", version: 5 }, "v4 は T-020 で追加した別の形式。未対応の版の例は 5");
  const legacy = readTaskFile(fixture("legacy.md"));
  assert.equal(legacy.format.kind, "legacy");
  assert.deepEqual(legacy.issues, [], "旧形式は新形式の規則で検証しない");
});

test("正しいフィクスチャは validateTaskV2 と JSON Schema の両方で受け付ける", async () => {
  const validate = await schemaValidator();
  assert.ok(validFixtures.length >= 9);
  for (const name of validFixtures) {
    const { format, frontmatter, issues } = readTaskFile(fixture(name), name);
    assert.equal(format.kind, "v2", name);
    assert.deepEqual(issues, [], `${name}\n${JSON.stringify(issues, null, 2)}`);
    if (validate) assert.equal(validate(frontmatter.data()), true, `${name}: JSON Schema`);
  }
});

test("不正な例は code と項目を示して拒否し、構造の規則は JSON Schema とも一致する", async () => {
  const validate = await schemaValidator();
  for (const item of cases) {
    const text = mutate(item);
    const { issues, frontmatter } = readTaskFile(text, item.name);
    const found = issues.map((issue) => `${issue.code} ${issue.path}`);
    for (const [code, path] of item.codes) assert.ok(found.includes(`${code} ${path}`), `${item.name}: ${code} ${path} が無い\n${found.join("\n")}`);
    assert.ok(issues.every((issue) => issue.message.length > 0));
    if (validate) assert.equal(validate(frontmatter.data()), item.schema, `${item.name}: JSON Schema だけで${item.schema ? "受け付ける (項目をまたぐ規則)" : "拒否する (構造の規則)"}`);
  }
});

test("新しいタスクの初期値は計画が ready で後続が waiting になり、書き出して読み直しても同じ", async () => {
  const task = initialTaskV2({ id: "T-020", date: "2026-10-01", at: "2026-10-01T01:02:03.000Z", requestedBy: "human/saiki", createdBy: "agent/claude" });
  assert.deepEqual(validateTaskV2(task), []);
  assert.deepEqual(
    Object.fromEntries(Object.entries(task.workflow).map(([phase, record]) => [phase, record.status])),
    { plan: "ready", implement: "waiting", review: "waiting", acceptance: "waiting" },
  );
  const frontmatter = YamlFrontmatter.parse("---\n---\n\n# 概要\n");
  for (const [key, value] of Object.entries(task)) frontmatter.set([key], value);
  const text = frontmatter.toString();
  assert.match(text, /^---\nid: T-020\nworkflowVersion: 2\n/);
  assert.match(text, /\ncompletedAt:\n/, "null は空欄で書く");
  assert.match(text, /\n  plan:\n    status: ready\n    attempt: 1\n    assignee:\n/);
  assert.match(text, /\n    at: 2026-10-01T01:02:03.000Z\n/, "履歴の時刻はタイムゾーン付き");
  assert.match(initialTaskV2({ id: "T-021", date: "2026-10-01", requestedBy: "human/saiki", createdBy: "agent/claude" }).history[0].at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "指定しなければ今の時刻を UTC で書く");
  assert.ok(text.endsWith("---\n\n# 概要\n"));
  const again = readTaskFile(text);
  assert.deepEqual(again.issues, []);
  assert.deepEqual(again.frontmatter.data(), JSON.parse(JSON.stringify(task)));
  const validate = await schemaValidator();
  if (validate) assert.equal(validate(task), true);
});

test("読み書きは未知の項目・コメント・引用符・本文を保ち、書き換えた行だけを変える", () => {
  for (const name of [...validFixtures, "legacy.md"]) {
    const text = fixture(name);
    assert.equal(YamlFrontmatter.parse(text, name).toString(), text, `${name}: 変更が無ければ元と同じ`);
  }
  const text = fixture("v2-implement-progress.md");
  const frontmatter = YamlFrontmatter.parse(text);
  frontmatter.set(["workflow", "implement", "status"], "pending");
  frontmatter.set(["blockedBy"], ["qa/Q-001", "other: 部長, 課長 # の承認"]);
  const updated = frontmatter.toString();
  const before = text.split("\n");
  const after = updated.split("\n");
  const changed = after.filter((line) => !before.includes(line));
  assert.deepEqual(changed, ["blockedBy:", "  - qa/Q-001", '  - "other: 部長, 課長 # の承認"', "    status: pending"]);
  assert.ok(updated.includes("# 工程ごとの記録\n"), "コメント行を残す");
  assert.ok(updated.includes("test:\n  - docs/feature/raprid/workflow-data-model.feature\n"), "未知の項目を残す");
  assert.ok(updated.endsWith("```yaml\nstatus: todo # 本文のコードブロックは frontmatter ではない\n```\n"), "本文を残す");
  assert.deepEqual(YamlFrontmatter.parse(updated).get(["blockedBy"]), ["qa/Q-001", "other: 部長, 課長 # の承認"]);
  // CRLF の文書は CRLF のまま
  const crlf = text.replace(/\n/g, "\r\n");
  const crlfFrontmatter = YamlFrontmatter.parse(crlf);
  assert.equal(crlfFrontmatter.toString(), crlf);
  crlfFrontmatter.set(["updatedAt"], "2026-10-01");
  assert.ok(!/[^\r]\n/.test(crlfFrontmatter.toString()), "書き換えても改行は CRLF");
});

test("いろいろな YAML の書き方 (フロー形式・ブロック文字列・引用符・キーの引用・行末コメント) の未知の項目を保つ", () => {
  const extra = [
    "owner: { name: 担当者, team: 'core' } # フロー形式の対応表",
    "labels: [ui, \"a, b\", 'x # y']",
    "note: |",
    "  1 行目",
    "    字下げした 2 行目",
    "",
    "  空行の後の 3 行目",
    "summary: >-",
    "  折り返す",
    "  文章",
    "\"quoted key\": 'it''s'",
    "empty: ~",
    "number: 0012",
  ].join("\n");
  const base = fixture("v2-implement-progress.md");
  const text = base.replace("# 工程ごとの記録\n", `${extra}\n# 工程ごとの記録\n`);
  const frontmatter = YamlFrontmatter.parse(text);
  assert.equal(frontmatter.toString(), text, "変更が無ければ元と同じ");
  const data = frontmatter.data();
  assert.deepEqual(data.owner, { name: "担当者", team: "core" });
  assert.deepEqual(data.labels, ["ui", "a, b", "x # y"]);
  assert.equal(data.note, "1 行目\n  字下げした 2 行目\n\n空行の後の 3 行目\n");
  assert.equal(data.summary, "折り返す 文章");
  assert.equal(data["quoted key"], "it's");
  assert.equal(data.empty, null);
  assert.deepEqual(readTaskFile(text).issues, [], "未知の項目があっても新形式として正しい");
  frontmatter.set(["workflow", "implement", "status"], "pending");
  frontmatter.set(["blockedBy"], ["qa/Q-001"]);
  const updated = frontmatter.toString();
  assert.ok(updated.includes(`${extra}\n# 工程ごとの記録\n`), "書き換えても未知の項目の書き方はそのまま");
});

test("書き換えは対象の値の範囲だけを差し替え、周りの行は 1 文字も変えない", () => {
  const text = [
    "---",
    "id: T-001",
    "number: 0012",
    "completedAt: 2026-09-28",
    "blockedBy: [] # 待ちの相手",
    "test:",
    "  - a.feature",
    "  - b.feature",
    "workflow:",
    "  plan:",
    "    status: ready # 状態",
    "    refs:",
    "      - path: x.md",
    "    note: keep",
    "  # 工程のコメント",
    "history:",
    "  - seq: 1",
    "    actor: agent/codex",
    "    reason:",
    "tail: end",
    "---",
    "",
    "本文",
    "",
  ].join("\n");
  const frontmatter = YamlFrontmatter.parse(text);
  frontmatter.set(["completedAt"], null);
  frontmatter.set(["blockedBy"], ["qa/Q-001", "other: A, B # c"]);
  frontmatter.set(["test"], []);
  frontmatter.set(["workflow", "plan", "status"], "progress");
  frontmatter.set(["workflow", "plan", "refs"], [{ path: "y.md" }, { repo: "project_template", commit: "abcdef0" }]);
  frontmatter.set(["workflow", "plan", "assignee"], "agent/claude");
  frontmatter.set(["workflow", "implement"], { status: "waiting", attempt: 1 });
  frontmatter.set(["history", 0, "actor"], "agent/claude");
  frontmatter.set(["history", 0, "reason"], "一行目\n二行目");
  frontmatter.set(["added", "nested"], 1);
  frontmatter.delete(["tail"]);
  assert.equal(
    frontmatter.toString(),
    [
      "---",
      "id: T-001",
      "number: 0012",
      "completedAt:",
      "blockedBy: # 待ちの相手",
      "  - qa/Q-001",
      '  - "other: A, B # c"',
      "test: []",
      "workflow:",
      "  plan:",
      "    status: progress # 状態",
      "    refs:",
      "      - path: y.md",
      "      - repo: project_template",
      "        commit: abcdef0",
      "    note: keep",
      "    assignee: agent/claude",
      "  implement:",
      "    status: waiting",
      "    attempt: 1",
      "  # 工程のコメント",
      "history:",
      "  - seq: 1",
      "    actor: agent/claude",
      "    reason: |-",
      "      一行目",
      "      二行目",
      "added:",
      "  nested: 1",
      "---",
      "",
      "本文",
      "",
    ].join("\n"),
  );
  const data = frontmatter.data();
  assert.equal(data.number, 12, "数値の書き方 0012 は触っていないので残る (値は YAML の読み方どおり)");
  assert.deepEqual((data.history as { reason: string }[])[0].reason, "一行目\n二行目");
  assert.equal(frontmatter.changed, true);
  const untouched = YamlFrontmatter.parse(text);
  untouched.set(["id"], "T-001");
  assert.equal(untouched.changed, false, "同じ値の書き込みでは変えない");
  assert.equal(untouched.toString(), text);
});

// 書き換えを 1 つ行い、結果の文字列を丸ごと比べる
function edited(yaml: string[], edit: (frontmatter: YamlFrontmatter) => void): string[] {
  const frontmatter = YamlFrontmatter.parse(["---", ...yaml, "---", "本文", ""].join("\n"));
  edit(frontmatter);
  const lines = frontmatter.toString().split("\n");
  assert.deepEqual(lines.slice(-3), ["---", "本文", ""], "本文は変えない");
  return lines.slice(1, -3);
}

test("配列の末尾に追加しても既存の要素と配列の型を保つ (R12-4)", () => {
  // 再レビューの再現手順: 履歴に 2 件目を足す
  const frontmatter = YamlFrontmatter.parse("---\nhistory:\n  - seq: 1\n    event: create\nkeep: value\n---\n本文\n");
  frontmatter.set(["history", 1], { seq: 2, event: "claim" });
  assert.deepEqual(frontmatter.data(), { history: [{ seq: 1, event: "create" }, { seq: 2, event: "claim" }], keep: "value" });
  assert.equal(frontmatter.toString(), "---\nhistory:\n  - seq: 1\n    event: create\n  - seq: 2\n    event: claim\nkeep: value\n---\n本文\n");

  assert.deepEqual(edited(["list:", "  - a # 先頭", "  - 0012", "tail: 1"], (f) => f.set(["list", 2], "c")), ["list:", "  - a # 先頭", "  - 0012", "  - c", "tail: 1"]);
  assert.deepEqual(edited(["list: [a, 0012] # コメント", "tail: 1"], (f) => f.set(["list", 2], "b, c")), ['list: [a, 0012, "b, c"] # コメント', "tail: 1"]);
  assert.deepEqual(edited(["list: []", "tail: 1"], (f) => f.set(["list", 0], { path: "a.md" })), ["list:", "  - path: a.md", "tail: 1"]);
  assert.deepEqual(edited(["list:", "  - x", "tail: 1"], (f) => f.set(["list", 1], "一行目\n二行目")), ["list:", "  - x", "  - |-", "    一行目", "    二行目", "tail: 1"]);
  // 実際の履歴に 1 件足しても、新形式として正しいまま (T-013 が使う形)
  const task = YamlFrontmatter.parse(fixture("v2-implement-progress.md"));
  const before = task.get(["history"]) as unknown[];
  task.set(["history", before.length], { seq: 4, at: "2026-09-29T02:00:00Z", actor: "agent/claude", event: "block", phase: "implement", attempt: 1, inputRevision: 1, outcome: null, from: "progress", to: "pending", reason: "qa/Q-001 の回答待ち", refersTo: null, refs: [] });
  task.set(["workflow", "implement", "status"], "pending");
  task.set(["blockedBy"], ["qa/Q-001"]);
  assert.deepEqual(readTaskFile(task.toString()).issues, []);
  assert.equal((task.get(["history"]) as unknown[]).length, before.length + 1);
  assert.ok(task.toString().includes("    sessionId: 3c712208-c6af-4379-b601-6bed97590ba9\n  - seq: 4\n    at: 2026-09-29T02:00:00Z\n"), "前の履歴の未知の項目を残して後ろに足す");
});

test("フロー形式の項目・要素を消しても兄弟を保つ (R12-5)", () => {
  // 再レビューの再現手順: {a: 1, b: 2} から a を消す
  const frontmatter = YamlFrontmatter.parse("---\ncustom: {a: 1, b: 2}\nkeep: value\n---\n本文\n");
  frontmatter.delete(["custom", "a"]);
  assert.deepEqual(frontmatter.data(), { custom: { b: 2 }, keep: "value" });
  assert.equal(frontmatter.toString(), "---\ncustom: {b: 2}\nkeep: value\n---\n本文\n");

  assert.deepEqual(edited(["m: { a: 1, b: 0012, c: 3 } # c", "k: v"], (f) => f.delete(["m", "b"])), ["m: { a: 1, c: 3 } # c", "k: v"]);
  assert.deepEqual(edited(["m: { a: 1, b: 2 }", "k: v"], (f) => f.delete(["m", "b"])), ["m: { a: 1 }", "k: v"]);
  assert.deepEqual(edited(["m: {a: 1}", "k: v"], (f) => f.delete(["m", "a"])), ["m: {}", "k: v"]);
  assert.deepEqual(edited(["s: [x, 'y, z', w]", "k: v"], (f) => f.delete(["s", 1])), ["s: [x, w]", "k: v"]);
  assert.deepEqual(edited(["s: [x, y]", "k: v"], (f) => f.delete(["s", 1])), ["s: [x]", "k: v"]);
  assert.deepEqual(edited(["m: {a: 1}", "k: v"], (f) => f.set(["m", "b"], [1, "x, y"])), ['m: {a: 1, b: [1,"x, y"]}', "k: v"]);
  assert.deepEqual(edited(["m: {a: 1, b: 2}", "k: v"], (f) => f.set(["m", "b"], null)), ["m: {a: 1, b: null}", "k: v"]);
});

test("フロー形式に null を書いても要素の数・順番・null を保つ (R12-6)", () => {
  // 再々レビューの再現手順: a: [1, 2] の 1 番目を null にする
  const values = (yaml: string, edit: (f: YamlFrontmatter) => void) => {
    const frontmatter = YamlFrontmatter.parse(`---\n${yaml}\nkeep: value\n---\n本文\n`);
    edit(frontmatter);
    const reread = YamlFrontmatter.parse(frontmatter.toString()).data();
    assert.equal(reread.keep, "value");
    return reread.a;
  };
  assert.deepEqual(values("a: [1, 2]", (f) => f.set(["a", 1], null)), [1, null], "末尾の置換");
  assert.deepEqual(values("a: [1, 2]", (f) => f.set(["a", 2], null)), [1, 2, null], "末尾への追加");
  assert.deepEqual(values("a: [1]", (f) => f.set(["a", 0], null)), [null], "唯一の要素");
  assert.deepEqual(values("a: [1, 2, 3]", (f) => f.set(["a", 0], null)), [null, 2, 3], "先頭");
  assert.deepEqual(values("a: [1, 2, 3]", (f) => f.set(["a", 1], null)), [1, null, 3], "中間");
  assert.deepEqual(values("a: [1, 2]", (f) => f.set(["a", 1], [null, 2, null])), [1, [null, 2, null]], "null を含む配列");
  assert.deepEqual(values("a: [1]", (f) => f.set(["a", 1], { x: null, y: [null] })), [1, { x: null, y: [null] }], "null を含む対応表");
  assert.deepEqual(values("a: {x: 1}", (f) => f.set(["a", "y"], null)), { x: 1, y: null }, "フロー形式の対応表への追加");
  assert.deepEqual(values("a:\n  - 1", (f) => f.set(["a", 1], [null, { b: null }])), [1, [null, { b: null }]], "ブロック形式の中の null");
  assert.deepEqual(edited(["a: [1, 2]"], (f) => f.set(["a", 1], null)), ["a: [1, null]"]);
});

test("配列の要素の最初の項目を消しても、次の項目・その上のコメント・空行を保つ (R12-7)", () => {
  // 再々レビューの再現手順: x の後ろのコメントを消さない
  assert.deepEqual(edited(["a:", "  - x: 1", "    # yの説明", "    y: 2"], (f) => f.delete(["a", 0, "x"])), ["a:", "  -", "    # yの説明", "    y: 2"]);
  assert.deepEqual(edited(["a:", "  - x: 1 # xの説明", "", "    # yの説明", "    y: 2", "  - z: 3"], (f) => f.delete(["a", 0, "x"])), ["a:", "  -", "", "    # yの説明", "    y: 2", "  - z: 3"]);
  assert.deepEqual(edited(["a:", "  - x:", "      n: 1", "    # yの説明", "    y: 2"], (f) => f.delete(["a", 0, "x"])), ["a:", "  -", "    # yの説明", "    y: 2"], "値が入れ子でも");
  assert.deepEqual(edited(["a:", "  - x: 1", "    y: 2"], (f) => f.delete(["a", 0, "x"])), ["a:", "  - y: 2"], "間に何も無ければ詰める");
  // 最後の項目を消して {} にするときも、親の中の他のコメントは残す
  assert.deepEqual(edited(["k:", "  # 説明", "  a: 1", "b: 2"], (f) => f.delete(["k", "a"])), ["k: {}", "  # 説明", "b: 2"]);
  assert.deepEqual(edited(["k:", "  # 説明", "  - 1", "b: 2"], (f) => f.delete(["k", 0])), ["k: []", "  # 説明", "b: 2"]);
});

test("「-」だけの行の配列・最上位の {}・深い字下げのコメントの後ろにも追加できる", () => {
  assert.deepEqual(edited(["a:", "  -", "    x: 1"], (f) => f.set(["a", 1], { x: 2 })), ["a:", "  -", "    x: 1", "  - x: 2"]);
  assert.deepEqual(edited(["a:", "  - 1", "  -"], (f) => f.set(["a", 2], [3, 4])), ["a:", "  - 1", "  -", "  - - 3", "    - 4"], "空の要素の後ろ");
  assert.deepEqual(edited(["a:", "  -"], (f) => f.set(["a", 0], "v")), ["a:", "  - v"], "空の要素の置換");
  assert.deepEqual(edited(["{}"], (f) => f.set(["k"], 1)), ["k: 1"]);
  assert.deepEqual(edited(["# 先頭", "{} # 空"], (f) => f.set(["k"], { a: 1 })), ["# 先頭", "k:", "  a: 1 # 空"]);
  // 深い字下げのコメントの手前に複数行の文字列を足すと、コメントが文字列の中身になる。コメントの後ろに足す
  assert.deepEqual(edited(["k:", "  a:", "    - 1", "    # 説明", "b: 2"], (f) => f.set(["k", "c"], "一行目\n二行目")), ["k:", "  a:", "    - 1", "    # 説明", "  c: |-", "    一行目", "    二行目", "b: 2"]);
  // 置き換えではコメントの後ろに書けないので、その値だけ 1 行で書く
  assert.deepEqual(edited(["k:", "  a: 1", "  # 説明", "b: 2"], (f) => f.set(["k"], "一行目\n二行目")), ['k: "一行目\\n二行目"', "  # 説明", "b: 2"]);
});

test("ブロック形式の配列・入れ子の置換と削除は対象だけを変え、空になったら null ではなく空にする", () => {
  const yaml = ["h:", "  - seq: 1 # 最初", "    x: 0012", "  - seq: 2", "    x: 2", "  - seq: 3", "w:", "  a:", "    b: 1 # 残す", "  c: 2", "k: v"];
  assert.deepEqual(edited(yaml, (f) => f.delete(["h", 1])), ["h:", "  - seq: 1 # 最初", "    x: 0012", "  - seq: 3", "w:", "  a:", "    b: 1 # 残す", "  c: 2", "k: v"]);
  assert.deepEqual(edited(yaml, (f) => f.delete(["h", 0, "seq"])), ["h:", "  - x: 0012", "  - seq: 2", "    x: 2", "  - seq: 3", "w:", "  a:", "    b: 1 # 残す", "  c: 2", "k: v"]);
  assert.deepEqual(edited(yaml, (f) => f.delete(["h", 2, "seq"])), ["h:", "  - seq: 1 # 最初", "    x: 0012", "  - seq: 2", "    x: 2", "  - {}", "w:", "  a:", "    b: 1 # 残す", "  c: 2", "k: v"]);
  assert.deepEqual(edited(yaml, (f) => f.set(["h", 1], { seq: 9 })), ["h:", "  - seq: 1 # 最初", "    x: 0012", "  - seq: 9", "  - seq: 3", "w:", "  a:", "    b: 1 # 残す", "  c: 2", "k: v"]);
  assert.deepEqual(edited(yaml, (f) => f.set(["h", 2, "seq"], 4)), ["h:", "  - seq: 1 # 最初", "    x: 0012", "  - seq: 2", "    x: 2", "  - seq: 4", "w:", "  a:", "    b: 1 # 残す", "  c: 2", "k: v"]);
  assert.deepEqual(edited(yaml, (f) => f.delete(["w", "a", "b"])), ["h:", "  - seq: 1 # 最初", "    x: 0012", "  - seq: 2", "    x: 2", "  - seq: 3", "w:", "  a: {}", "  c: 2", "k: v"]);
  assert.deepEqual(edited(yaml, (f) => f.set(["w", "a", "new"], "n")), ["h:", "  - seq: 1 # 最初", "    x: 0012", "  - seq: 2", "    x: 2", "  - seq: 3", "w:", "  a:", "    b: 1 # 残す", "    new: n", "  c: 2", "k: v"]);
  assert.deepEqual(edited(["one:", "  - x", "k: v"], (f) => f.delete(["one", 0])), ["one: []", "k: v"]);
  assert.deepEqual(edited(["e:", "k: v"], (f) => f.set(["e", "a"], 1)), ["e:", "  a: 1", "k: v"]);
  assert.deepEqual(edited(["k: v"], (f) => f.set(["n", 0, "a"], 1)), ["k: v", "n:", "  - a: 1"]);
  const data = YamlFrontmatter.parse(["---", ...yaml, "---", ""].join("\n"));
  data.delete(["h", 1]);
  assert.deepEqual(data.data().h, [{ seq: 1, x: 12 }, { seq: 3 }], "消していない要素の値は同じ");
});

test("扱えない書き換えは何も変えずに YamlEditError にする", () => {
  const text = "---\nlist:\n  - a\nflow: [x]\nscalar: 1\nmap:\n  a: 1\n---\n本文\n";
  for (const [label, edit] of [
    ["配列の途中を飛ばした番号", (f: YamlFrontmatter) => f.set(["list", 5], "z")],
    ["フロー形式の配列の途中を飛ばした番号", (f: YamlFrontmatter) => f.set(["flow", 3], "z")],
    ["対応表に番号", (f: YamlFrontmatter) => f.set(["map", 0], "z")],
    ["値の下に項目", (f: YamlFrontmatter) => f.set(["scalar", "a"], "z")],
    ["存在しない配列の 1 番目", (f: YamlFrontmatter) => f.set(["none", 1], "z")],
    ["空の path", (f: YamlFrontmatter) => f.set([], "z")],
  ] as const) {
    const frontmatter = YamlFrontmatter.parse(text);
    assert.throws(() => edit(frontmatter), YamlEditError, label);
    assert.equal(frontmatter.toString(), text, `${label}: 失敗したら何も変えない`);
    assert.equal(frontmatter.changed, false);
  }
});

test("フロー形式の中にコメントがあるときの削除は YamlEditError にし、置換・追加はコメントを保って行う", () => {
  for (const [yaml, path] of [
    ["a: {x: 1,\n # yの説明\n y: 2}", ["a", "x"]],
    ["a: [1, # 次要素の説明\n 2]", ["a", 0]],
  ] as const) {
    const text = `---\n${yaml}\n---\n本文\n`;
    const frontmatter = YamlFrontmatter.parse(text);
    assert.throws(() => frontmatter.delete([...path]), YamlEditError, yaml);
    assert.equal(frontmatter.toString(), text, "失敗したら何も変えない");
  }
  assert.deepEqual(edited(["a: [1, # 次要素の説明", " 2]"], (f) => f.set(["a", 0], 5)), ["a: [5, # 次要素の説明", " 2]"]);
  assert.deepEqual(edited(["a: [1, # 次要素の説明", " 2]"], (f) => f.set(["a", 2], 3)), ["a: [1, # 次要素の説明", " 2, 3]"]);
  // 文字列の中の # はコメントではないので消せる
  assert.deepEqual(edited(["a: ['#x', \"b #c\", 3]"], (f) => f.delete(["a", 0])), ['a: ["b #c", 3]']);
});

test("コメントのある空の {} / [] への追加はコメントを残して中へ足す (R12-8)", () => {
  // 第4回レビューの再現手順: 空の対応表・配列・最上位の対応表
  const check = (yaml: string[], edit: (f: YamlFrontmatter) => void, expected: string[], value: Record<string, unknown>) => {
    const lines = edited(yaml, edit);
    assert.deepEqual(lines, expected);
    assert.deepEqual(YamlFrontmatter.parse(["---", ...lines, "---", ""].join("\n")).data(), value, "読み直した値");
  };
  check(["a: { # 保持するコメント", "}", "b: 2"], (f) => f.set(["a", "x"], 1), ["a: { # 保持するコメント", "  x: 1", "}", "b: 2"], { a: { x: 1 }, b: 2 });
  check(["a: [ # 保持するコメント", "]", "b: 2"], (f) => f.set(["a", 0], 1), ["a: [ # 保持するコメント", "  1", "]", "b: 2"], { a: [1], b: 2 });
  check(["{ # 最上位のコメント", "}"], (f) => f.set(["x"], 1), ["{ # 最上位のコメント", "  x: 1", "}"], { x: 1 });
  check(["m:", "  a: [ # c", "    ]"], (f) => f.set(["m", "a", 0], "x\ny"), ["m:", "  a: [ # c", '    "x\\ny"', "    ]"], { m: { a: ["x\ny"] } });
  check(["a: { # c", "}"], (f) => f.set(["a", "x", 0], null), ["a: { # c", '  x: [null]', "}"], { a: { x: [null] } });
  // 2 件目以降は通常のフロー形式への追加
  check(["a: { # c", "}"], (f) => { f.set(["a", "x"], 1); f.set(["a", "y"], 2); }, ["a: { # c", "  x: 1, y: 2", "}"], { a: { x: 1, y: 2 } });
  // コメントの無い空の {} / [] は従来どおりブロック形式で書き直す
  check(["a: {}", "b: []"], (f) => { f.set(["a", "x"], 1); f.set(["b", 0], 2); }, ["a:", "  x: 1", "b:", "  - 2"], { a: { x: 1 }, b: [2] });
});

test("置換では key の行のコメントを新しい値の行へ移して残す", () => {
  assert.deepEqual(edited(["a: # 親の説明", "  x: 1", "b: 2"], (f) => f.set(["a"], 5)), ["a: 5 # 親の説明", "b: 2"]);
  assert.deepEqual(edited(["a: 1 # 説明", "b: 2"], (f) => f.set(["a"], { x: 1 })), ["a: # 説明", "  x: 1", "b: 2"]);
  assert.deepEqual(edited(["a: 1 # 説明", "b: 2"], (f) => f.set(["a"], "x\ny")), ["a: |- # 説明", "  x", "  y", "b: 2"]);
  assert.deepEqual(edited(["a: |- # 説明", "  x", "  y", "b: 2"], (f) => f.set(["a"], 3)), ["a: 3 # 説明", "b: 2"]);
  assert.deepEqual(edited(["a: 'x # y' # 説明"], (f) => f.set(["a"], 3)), ["a: 3 # 説明"]);
  assert.deepEqual(edited(["a: # 説明", "b: 2"], (f) => f.set(["a"], { c: 1 })), ["a: # 説明", "  c: 1", "b: 2"]);
  // 値の中のコメントは値と一緒に置き換わる
  assert.deepEqual(edited(["a:", "  # 中", "  x: 1", "b: 2"], (f) => f.set(["a"], 5)), ["a: 5", "b: 2"]);
  assert.deepEqual(edited(["a:", "  x: 1 # 中", "b: 2"], (f) => f.set(["a"], 5)), ["a: 5", "b: 2"], "最後の項目の行末のコメントも値の中");
  // 配列の要素の行末のコメントは要素のもの。新しい値がコレクションなら「- # …」の行の次に書く
  assert.deepEqual(edited(["s:", "  - 1 # 要素", "  - 2"], (f) => f.set(["s", 0], { a: 1, b: 2 })), ["s:", "  - # 要素", "    a: 1", "    b: 2", "  - 2"]);
  assert.deepEqual(edited(["s:", "  - 1 # 要素", "  - 2"], (f) => f.set(["s", 0], "x\ny")), ["s:", "  - |- # 要素", "    x", "    y", "  - 2"]);
  assert.deepEqual(edited(["s:", "  - - x # 要素", "    - y"], (f) => f.set(["s", 0], 5)), ["s:", "  - 5 # 要素"]);
  assert.deepEqual(edited(["s:", "  - |- # 要素", "    x", "    y"], (f) => f.set(["s", 0], 5)), ["s:", "  - 5 # 要素"]);
  assert.deepEqual(edited(["s:", "  -   # 空の要素", "  - 2"], (f) => f.set(["s", 0], 1)), ["s:", "  - 1 # 空の要素", "  - 2"]);
});

test("削除では、消す項目・要素の後ろの深い字下げのコメントも一緒に消し、前のブロック文字列に取り込ませない", () => {
  const yaml = ["m:", "  s: |-", "    一行目", "  x:", "    - 1", "    # x の中", "  y: 2"];
  const lines = edited(yaml, (f) => f.delete(["m", "x"]));
  assert.deepEqual(lines, ["m:", "  s: |-", "    一行目", "  y: 2"]);
  assert.deepEqual(YamlFrontmatter.parse(["---", ...lines, "---", ""].join("\n")).data(), { m: { s: "一行目", y: 2 } });
  assert.deepEqual(edited(["l:", "  - |-", "    一行目", "  - a: 1", "      # 要素の中", "  - 3"], (f) => f.delete(["l", 1])), ["l:", "  - |-", "    一行目", "  - 3"]);
  // 深くないコメント (次の項目の前のもの) は残す
  assert.deepEqual(edited(["m:", "  x: 1", "  # y の説明", "  y: 2"], (f) => f.delete(["m", "x"])), ["m:", "  # y の説明", "  y: 2"]);
});

test("JSON で表せない値は読み書きの入口で拒否し、null と取り違えない (R12-9)", () => {
  // 第4回レビューの再現手順: .inf を null にする、Infinity を追加する
  for (const yaml of ["a: .inf", "a: -.inf", "a: .nan", "a: [1, .NaN]", "a: {b: 1e400}"]) {
    assert.throws(() => YamlFrontmatter.parse(`---\n${yaml}\n---\n`), FrontmatterError, yaml);
  }
  const text = "---\na: [1]\nb: null\n---\n本文\n";
  for (const [label, value] of [
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["NaN", NaN],
    ["undefined", undefined],
    ["入れ子の Infinity", { x: [1, Infinity] }],
    ["入れ子の undefined", { x: undefined }],
    ["Date", new Date(0)],
    ["配列の空き要素", [1, , 3]],
    ["関数", () => 1],
  ] as const) {
    for (const path of [["a", 1], ["b"], ["c", "d"]]) {
      const frontmatter = YamlFrontmatter.parse(text);
      assert.throws(() => frontmatter.set(path, value), YamlEditError, `${label} → ${path.join(".")}`);
      assert.equal(frontmatter.toString(), text, `${label}: 失敗したら何も変えない`);
    }
  }
  const frontmatter = YamlFrontmatter.parse(text);
  frontmatter.set(["b"], null);
  assert.equal(frontmatter.changed, false, "null を null にするのは変更なし");
  frontmatter.set(["a", 1], null);
  assert.deepEqual(frontmatter.data(), { a: [1, null], b: null });
  frontmatter.set(["a", 2], -0);
  assert.equal((frontmatter.data().a as number[])[2] === 0, true, "-0 は 0 と同じ値");
});

test("YAML として曖昧な書式 (重複・アンカー・エイリアス・タグ・壊れた書式) は推測せずに拒否する", () => {
  for (const [yaml, message] of [
    ["id: T-001\nid: T-002\n", /DUPLICATE_KEY/],
    ["a: &x 1\nb: *x\n", /アンカー|エイリアス/],
    ["a: !!binary aGVsbG8=\n", /タグ/],
    ["a: !custom 1\n", /タグ/],
    ["a: [1\n", /YAML として読めません/],
    ["- a\n- b\n", /key: 値 の形ではありません/],
  ] as const) {
    assert.throws(() => YamlFrontmatter.parse(`---\n${yaml}---\n`), (error: Error) => error instanceof FrontmatterError && message.test(error.message), yaml);
  }
  assert.throws(() => YamlFrontmatter.parse("id: T-001\n"), /frontmatter がありません/);
  assert.throws(() => YamlFrontmatter.parse("---\nid: T-001\n"), /frontmatter が閉じていません/);
});

test("JSON Schema は正しい 2020-12 の schema で、必須項目の一覧が検証器と揃っている", async (t) => {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as { required: string[]; $defs: { phase: { required: string[] }; historyEntry: { required: string[] } } };
  const task = initialTaskV2({ id: "T-001", date: "2026-10-01", at: "2026-10-01T00:00:00Z", requestedBy: "human/saiki", createdBy: "agent/claude" });
  assert.deepEqual([...schema.required].sort(), Object.keys(task).sort());
  assert.deepEqual([...schema.$defs.phase.required].sort(), Object.keys(task.workflow.plan).sort());
  assert.deepEqual([...schema.$defs.historyEntry.required].sort(), Object.keys(task.history[0]).sort());
  if (!(await schemaValidator())) t.skip("ajv が導入されていない (pnpm install で導入する)");
});

test("node_modules の無い場所へ複製した scripts/ でも新形式を読んで検証できる", () => {
  const root = mkdtempSync(join(tmpdir(), "raprid-workflow-bare-"));
  try {
    cpSync(dirname(cli), join(root, "scripts"), { recursive: true, filter: (source) => !source.includes("node_modules") });
    const code = `import { readTaskFile } from ${JSON.stringify(join(root, "scripts", "lib", "workflow.ts"))};
import { readFileSync } from "node:fs";
const ok = readTaskFile(readFileSync(${JSON.stringify(join(fixtures, "v2-review-returned.md"))}, "utf8"));
const bad = readTaskFile(readFileSync(${JSON.stringify(join(fixtures, "v2-new.md"))}, "utf8").replace("phase: plan", "phase: review"));
console.log(JSON.stringify({ format: ok.format.kind, ok: ok.issues.length, bad: bad.issues.map((issue) => issue.code) }));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { format: "v2", ok: 0, bad: ["WF_ORDER", "WF_ORDER", "WF_ORDER"] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("従来のタスク操作は新形式のタスクを書き換えずに止まる", () => {
  const root = mkdtempSync(join(tmpdir(), "raprid-workflow-legacy-"));
  try {
    mkdirSync(join(root, "jobs"));
    assert.equal(raprid(root, ["job", "create", "PROJ-1"]).status, 0);
    write(root, "jobs/PROJ-1/tasks/new-style/index.md", fixture("v2-implement-progress.md"));
    const before = snapshot(root, (rel) => rel === "jobs/.locks");
    for (const args of [
      ["task", "move", "PROJ-1", "new-style", "done"],
      ["task", "note", "PROJ-1", "new-style", "memo"],
      ["task", "ask", "PROJ-1", "new-style", "q", "internal", "質問", "--requested-by", "agent/test", "--created-by", "agent/test"],
    ]) {
      const result = raprid(root, args);
      assert.equal(result.status, 1, `${args.join(" ")}\n${result.stdout}`);
    }
    assert.deepEqual(snapshot(root, (rel) => rel === "jobs/.locks"), before, "新形式のタスクは従来の操作で変わらない");
    assert.equal(read(root, "jobs/PROJ-1/tasks/new-style/index.md"), fixture("v2-implement-progress.md"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
