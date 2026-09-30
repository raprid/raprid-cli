// workflowVersion 3 (種別 type と共通工程 plan / execute / review / acceptance) の契約。T-018
// v2 の契約は workflow.test.ts のまま保持し、ここでは v3 の追加分と、v2 と取り違えないことを確かめる。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { schemaVersion } from "../lib/query.ts";
import { detectFormat, initialTaskV3, phasesV3, readTaskFile, type TaskType, taskTypes, validateTaskV2, validateTaskV3 } from "../lib/workflow.ts";
import { YamlFrontmatter } from "../lib/yamlfront.ts";
import { cli } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures", "workflow");
const schemaPath = join(here, "..", "lib", "schema", "task-workflow-v3.schema.json");
const fixture = (name: string) => readFileSync(join(fixtures, name), "utf8");
const v3Fixtures = readdirSync(fixtures).filter((name) => name.startsWith("v3-") && name.endsWith(".md")).sort();
const v2Fixtures = readdirSync(fixtures).filter((name) => name.startsWith("v2-") && name.endsWith(".md")).sort();

interface Case {
  name: string;
  base: string;
  set?: [(string | number)[], unknown][];
  delete?: (string | number)[][];
  schema: boolean;
  codes: [string, string][];
}
const cases = (JSON.parse(readFileSync(join(fixtures, "invalid-v3.json"), "utf8")) as { cases: Case[] }).cases;

// workflow.test.ts と同じく、ajv は開発時の依存。導入されているのに schema をコンパイルできなければ失敗にする
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

test("v3 を v2・旧形式・未対応の版と見分け、版ごとの検証器で検証する", () => {
  assert.deepEqual(detectFormat({ workflowVersion: 3 }), { kind: "v3" });
  assert.deepEqual(detectFormat({ workflowVersion: 2 }), { kind: "v2" });
  assert.deepEqual(detectFormat({ workflowVersion: "3" }), { kind: "unsupported", version: "3" });
  assert.deepEqual(detectFormat({ workflowVersion: 5 }), { kind: "unsupported", version: 5 }, "v4 は T-020 で追加した別の形式。未対応の版の例は 5");
  assert.deepEqual(detectFormat({ status: "todo" }), { kind: "legacy" });
  // v3 の文書を v2 の検証器に、v2 の文書を v3 の検証器に渡しても、読み替えずに版の違いとして報告する
  for (const name of v3Fixtures) {
    const data = YamlFrontmatter.parse(fixture(name)).data();
    assert.deepEqual(validateTaskV2(data).map((issue) => issue.code), ["WF_VERSION"], name);
  }
  for (const name of v2Fixtures) {
    const data = YamlFrontmatter.parse(fixture(name)).data();
    assert.deepEqual(validateTaskV3(data).map((issue) => issue.code), ["WF_VERSION"], name);
  }
  // タスクの形式の版 (workflowVersion) と、一覧・詳細の JSON の版 (schemaVersion) は別のもの
  assert.equal(schemaVersion, 1, "query の schemaVersion は T-018 では変えない (v3 を載せる schemaVersion 2 は T-014)");
});

test("v3 の正しいフィクスチャは両方の種別で validateTaskV3 と JSON Schema の両方が受け付ける", async () => {
  const validate = await schemaValidator();
  const types = new Set<string>();
  assert.ok(v3Fixtures.length >= 11);
  for (const name of v3Fixtures) {
    const { format, frontmatter, issues } = readTaskFile(fixture(name), name);
    assert.equal(format.kind, "v3", name);
    assert.deepEqual(issues, [], `${name}\n${JSON.stringify(issues, null, 2)}`);
    const data = frontmatter.data();
    types.add(String(data.type));
    assert.deepEqual(Object.keys(data.workflow as object), [...phasesV3], `${name}: 工程は種別によらず共通`);
    if (validate) assert.equal(validate(data), true, `${name}: JSON Schema`);
  }
  assert.deepEqual([...types].sort(), [...taskTypes].sort(), "両方の種別のフィクスチャがある");
});

test("調査は資料だけで完了でき、実装は repo/commit を成果物として記録できる。どちらもレビューと人の受入を通る", () => {
  const research = YamlFrontmatter.parse(fixture("v3-research-closed.md")).data() as Record<string, any>;
  assert.equal(research.type, "research");
  assert.equal(research.closureReason, "accepted");
  for (const phase of phasesV3) {
    assert.ok((research.workflow[phase].artifactRefs as object[]).every((ref) => !("commit" in ref)), `${phase}: 調査には commit を求めない`);
  }
  assert.equal(research.workflow.review.completedBy, "agent/codex");
  assert.notEqual(research.workflow.review.completedBy, research.workflow.execute.completedBy, "調査も独立レビュー");
  assert.match(research.workflow.acceptance.completedBy, /^human\//, "調査も人が受け入れる");

  const implementation = YamlFrontmatter.parse(fixture("v3-implementation-closed.md")).data() as Record<string, any>;
  assert.equal(implementation.type, "implementation");
  assert.deepEqual(implementation.workflow.execute.artifactRefs, [{ repo: "project_template", commit: "7ccc366" }, { path: "02-handoff.md" }]);
  assert.match(implementation.workflow.acceptance.completedBy, /^human\//);

  // 調査の実験にコードを使ったときは、その版を資料と一緒に記録できる
  const experiment = YamlFrontmatter.parse(fixture("v3-research-review-progress.md")).data() as Record<string, any>;
  assert.deepEqual(experiment.workflow.execute.artifactRefs, [{ path: "02-findings.md" }, { repo: "raprid-cli", commit: "230ad56" }]);
});

test("v3 の不正な例は code と項目を示して拒否し、構造の規則は JSON Schema とも一致する", async () => {
  const validate = await schemaValidator();
  assert.ok(cases.length >= 30);
  for (const item of cases) {
    const text = mutate(item);
    const { format, issues, frontmatter } = readTaskFile(text, item.name);
    const found = issues.map((issue) => `${issue.code} ${issue.path}`);
    assert.ok(issues.length > 0, `${item.name}: 拒否されない`);
    for (const [code, path] of item.codes) assert.ok(found.includes(`${code} ${path}`), `${item.name}: ${code} ${path} が無い\n${found.join("\n")}`);
    assert.ok(issues.every((issue) => issue.message.length > 0));
    if (validate && format.kind === "v3") {
      assert.equal(validate(frontmatter.data()), item.schema, `${item.name}: JSON Schema だけで${item.schema ? "受け付ける (項目をまたぐ規則)" : "拒否する (構造の規則)"}`);
    }
  }
});

test("種別によらない規則の不正な例は、種別を入れ替えても同じ code と項目で拒否する", () => {
  // 種別そのものを変える例と v2 の文書を元にした例を除き、research と implementation の両方で確かめる (レビューの推奨)
  const common = cases.filter((item) => item.base.startsWith("v3-") && ![...(item.set ?? []).map(([path]) => path), ...(item.delete ?? [])].some((path) => path[0] === "type"));
  assert.ok(common.length >= 20, `対象: ${common.length}`);
  for (const item of common) {
    const original = YamlFrontmatter.parse(mutate(item));
    const swapped = original.data().type === "research" ? "implementation" : "research";
    const expected = readTaskFile(original.toString()).issues.map((issue) => `${issue.code} ${issue.path}`);
    original.set(["type"], swapped);
    const actual = readTaskFile(original.toString()).issues.map((issue) => `${issue.code} ${issue.path}`);
    assert.deepEqual(actual, expected, `${item.name} (${swapped} にした)`);
  }
});

test("v3 に implement が混ざっていたら、別名として受け付けずに移行を案内する", () => {
  const renamed = cases.find((item) => item.name === "v3 の現在の工程に implement")!;
  const issue = readTaskFile(mutate(renamed)).issues.find((item) => item.code === "WF_PHASE_RENAMED")!;
  assert.match(issue.message, /execute/);
  assert.match(issue.message, /移行/);
  // v2 では implement が正しい工程名のまま (v2 の契約を変えない)
  assert.deepEqual(readTaskFile(fixture("v2-implement-progress.md")).issues, []);
});

test("新しいタスクの初期値は種別が必須で、計画が ready・後続が waiting、書き出して読み直しても同じ", async () => {
  const validate = await schemaValidator();
  for (const type of taskTypes) {
    const task = initialTaskV3({ id: "T-030", type, date: "2026-10-01", at: "2026-10-01T01:02:03.000Z", requestedBy: "human/saiki", createdBy: "agent/claude" });
    assert.deepEqual(validateTaskV3(task), [], type);
    assert.equal(task.type, type);
    assert.deepEqual(Object.fromEntries(Object.entries(task.workflow).map(([phase, record]) => [phase, record.status])), { plan: "ready", execute: "waiting", review: "waiting", acceptance: "waiting" });
    const frontmatter = YamlFrontmatter.parse("---\n---\n\n# 概要\n");
    for (const [key, value] of Object.entries(task)) frontmatter.set([key], value);
    const text = frontmatter.toString();
    assert.match(text, new RegExp(`^---\\nid: T-030\\nworkflowVersion: 3\\ntype: ${type}\\nstatus: open\\nphase: plan\\n`));
    assert.match(text, /\n  execute:\n    status: waiting\n/);
    assert.doesNotMatch(text, /implement:/);
    const again = readTaskFile(text);
    assert.equal(again.format.kind, "v3");
    assert.deepEqual(again.issues, []);
    assert.deepEqual(again.frontmatter.data(), JSON.parse(JSON.stringify(task)));
    if (validate) assert.equal(validate(task), true);
  }
  // 種別の省略・未知の値・別名は作成時の入力の誤り
  for (const type of [undefined, "", "search", "implement", "bugfix", "Research"]) {
    assert.throws(() => initialTaskV3({ id: "T-031", type: type as TaskType, date: "2026-10-01", requestedBy: "human/saiki", createdBy: "agent/claude" }), TypeError, String(type));
  }
});

test("v3 の JSON Schema は正しい 2020-12 の schema で、必須項目・工程・種別の一覧が検証器と揃っている", async (t) => {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
    required: string[];
    properties: { workflowVersion: { const: number }; type: { enum: string[] }; phase: { enum: (string | null)[] }; workflow: { required: string[] } };
    $defs: { phase: { required: string[] }; historyEntry: { required: string[] }; phaseName: { enum: string[] } };
  };
  const task = initialTaskV3({ id: "T-001", type: "research", date: "2026-10-01", at: "2026-10-01T00:00:00Z", requestedBy: "human/saiki", createdBy: "agent/claude" });
  assert.deepEqual(schema.required, Object.keys(task), "必須項目と並び順");
  assert.equal(schema.properties.workflowVersion.const, 3);
  assert.deepEqual(schema.properties.type.enum, [...taskTypes]);
  assert.deepEqual(schema.properties.phase.enum, [...phasesV3, null]);
  assert.deepEqual(schema.properties.workflow.required, [...phasesV3]);
  assert.deepEqual(schema.$defs.phaseName.enum, [...phasesV3]);
  assert.deepEqual([...schema.$defs.phase.required].sort(), Object.keys(task.workflow.plan).sort());
  assert.deepEqual([...schema.$defs.historyEntry.required].sort(), Object.keys(task.history[0]).sort());
  if (!(await schemaValidator())) t.skip("ajv が導入されていない (pnpm install で導入する)");
});

test("v3 の読み書きは未知の項目・コメント・本文を保ち、書き換えた行だけを変える", () => {
  for (const name of v3Fixtures) {
    const text = fixture(name);
    assert.equal(YamlFrontmatter.parse(text, name).toString(), text, `${name}: 変更が無ければ元と同じ`);
  }
  const text = fixture("v3-research-execute-progress.md");
  const frontmatter = YamlFrontmatter.parse(text);
  frontmatter.set(["workflow", "execute", "assignee"], "agent/other");
  const before = text.split("\n");
  const after = frontmatter.toString().split("\n");
  assert.equal(after.length, before.length);
  assert.deepEqual(after.filter((line, index) => line !== before[index]), ["    assignee: agent/other"]);
  assert.match(frontmatter.toString(), /# 工程ごとの記録\n/);
  assert.match(frontmatter.toString(), /phase: implement # 本文のコードブロックは frontmatter ではない/, "本文の implement は書き換えない");
});

test("node_modules の無い場所へ複製した scripts/ でも v3 を読んで検証できる", () => {
  const root = mkdtempSync(join(tmpdir(), "raprid-workflow-v3-bare-"));
  try {
    cpSync(dirname(cli), join(root, "scripts"), { recursive: true, filter: (source) => !source.includes("node_modules") });
    const code = `import { readTaskFile } from ${JSON.stringify(join(root, "scripts", "lib", "workflow.ts"))};
import { readFileSync } from "node:fs";
const ok = readTaskFile(readFileSync(${JSON.stringify(join(fixtures, "v3-research-closed.md"))}, "utf8"));
const bad = readTaskFile(readFileSync(${JSON.stringify(join(fixtures, "v3-research-new.md"))}, "utf8").replace("type: research", "type: search"));
console.log(JSON.stringify({ format: ok.format.kind, ok: ok.issues.length, bad: bad.issues.map((issue) => issue.code) }));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { format: "v3", ok: 0, bad: ["WF_ENUM"] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
