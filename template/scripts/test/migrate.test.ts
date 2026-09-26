import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { raprid, read, snapshot, write } from "./helpers.ts";

const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let work: string;
let root: string;

const phaseTask = `---
id: T-001
status: progress
createdAt: 2026-09-01
updatedAt: 2026-09-02
completedAt:
blockedBy:
  - qa/Q-001
test:
  - docs/feature/admin/
owner: someone
---

# 計画

## タイトル

API を用意する

## 内容

成果物は [結果](../assets/api-setup/2026-09-02/result.md)、仕様は [docs](../../../docs/unofficial/spec.md)。

## 完了条件

* [ ] 作る

## ログ

### フェーズ1：調査

#### 計画

1. 既存を調べる

\`\`\`md
### コードブロック内の見出し
\`\`\`

#### 実施内容

[前の記録](../../../daily/2026-09/01/note.md#メモ)

### フェーズ2：空

#### 計画

#### 実施内容

### Phase 3: Build API

#### 計画

実装する

## 結果

完了。
`;

const plainTask = `---
id: T-002
status: done
createdAt: 2026-09-01
updatedAt: 2026-09-03
completedAt: 2026-09-03
blockedBy: []
test: []
---

# 計画

## タイトル

ログの無いタスク

## 結果

なし
`;

const qa = `---
id: Q-001
status: unresolved
createdAt: 2026-09-01
updatedAt: 2026-09-01
resolvedAt:
job: PROJ-1
askTo: customer
blockedBy: []
---

# Q&A

## 質問内容

どうするか

## 回答内容
`;

function oldProject(dir: string): void {
  for (const script of ["add-task.sh", "add-qa.sh", "list-task.sh", "list-qa.sh", "task-transition.sh", "qa-transition.sh"]) {
    write(dir, `job/${script}`, "#!/usr/bin/env bash\n");
    chmodSync(join(dir, "job", script), 0o755);
  }
  write(dir, "job/template/list/template.md", "---\nid:\n---\n");
  write(dir, "job/template/status/todo/.gitkeep", "");
  write(dir, "job/other/list/template.md", "---\nid:\n---\n");
  write(dir, "job/other/assets/.gitkeep", "");
  write(dir, "job/other/MEMORY.md", "# other\n");
  for (const status of ["todo", "pending", "progress", "done"]) write(dir, `job/other/status/${status}/.gitkeep`, "");
  write(dir, "job/PROJ-1/MEMORY.md", "- [T-001](list/api-setup.md) / [成果物](assets/api-setup/2026-09-02/result.md)\n");
  write(dir, "job/PROJ-1/list/template.md", "---\nid:\n---\n");
  write(dir, "job/PROJ-1/list/api-setup.md", phaseTask);
  write(dir, "job/PROJ-1/list/plain.md", plainTask);
  write(dir, "job/PROJ-1/qa/list/deploy-policy.md", qa);
  write(dir, "job/PROJ-1/assets/api-setup/2026-09-02/result.md", "[タスク](../../../list/api-setup.md)\n![](shot.gif)\n");
  write(dir, "job/PROJ-1/assets/api-setup/2026-09-02/shot.gif", "GIF89a");
  write(dir, "job/PROJ-1/assets/e2e/run.sh", "#!/bin/sh\n");
  chmodSync(join(dir, "job/PROJ-1/assets/e2e/run.sh"), 0o755);
  for (const status of ["todo", "pending", "progress", "done"]) mkdirSync(join(dir, `job/PROJ-1/status/${status}`), { recursive: true });
  // 旧索引の不一致 (plain は done だが todo に置かれている)
  symlinkSync("../../list/api-setup.md", join(dir, "job/PROJ-1/status/progress/api-setup.md"));
  symlinkSync("../../list/plain.md", join(dir, "job/PROJ-1/status/todo/plain.md"));
  mkdirSync(join(dir, "job/PROJ-1/qa/status/unresolved"), { recursive: true });
  mkdirSync(join(dir, "job/PROJ-1/qa/status/resolved"), { recursive: true });
  symlinkSync("../../list/deploy-policy.md", join(dir, "job/PROJ-1/qa/status/unresolved/deploy-policy.md"));
  write(dir, "docs/unofficial/spec.md", "- [タスク](../../job/PROJ-1/list/api-setup.md#フェーズ1調査)\n- `./job/add-task.sh PROJ-1 x todo` はコマンド例\n");
  write(dir, "daily/2026-09/01/note.md", "[成果物](../../../job/PROJ-1/assets/api-setup/2026-09-02/shot.gif) [雛形](../../../job/template/list/template.md)\n");
  write(dir, "README.md", "# old\n\n[案件](job/PROJ-1/) の説明。\n\n```sh\ncp -R job/template job/x\n```\n");
  write(dir, ".gitignore", "node_modules/\njob/*/assets/e2e/node_modules/\n");
}

const skipWork = (rel: string) => rel === ".raprid-migrate";

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "raprid-migrate-"));
  root = join(work, "project");
  mkdirSync(root);
  oldProject(root);
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function migrate(...args: string[]) {
  return raprid(root, ["job", "migrate", ...args]);
}

function planHash(stdout: string): string {
  return /計画ハッシュ: ([0-9a-f]+)/.exec(stdout)![1];
}

test("dry-run は計画だけを表示して何も変えない", () => {
  const before = snapshot(root);
  const result = migrate("--dry-run");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(snapshot(root), before);
  assert.match(result.stdout, /案件: 2 \/ タスク: 2 \(詳細 md 2 件に分割\) \/ QA: 1/);
  assert.match(result.stdout, /job\/PROJ-1\/list\/api-setup\.md -> jobs\/PROJ-1\/tasks\/api-setup\/index\.md/);
  assert.match(result.stdout, /job\/PROJ-1\/assets\/api-setup\/ -> jobs\/PROJ-1\/tasks\/api-setup\/assets\//);
  assert.match(result.stdout, /旧索引の不一致 \(status を正とする\): job\/PROJ-1\/list\/plain\.md \(索引: todo, status: done\)/);
  assert.match(result.stdout, /案件共通の assets に残す: job\/PROJ-1\/assets\/e2e/);
  assert.match(result.stdout, /空のフェーズを省略: .*フェーズ2：空/);
  assert.match(result.stdout, /アンカー要確認/);
  assert.match(result.stdout, /移行しない旧ファイルへのリンク: daily\/2026-09\/01\/note\.md/);
  assert.match(result.stdout, /旧パス \(job\/\) への言及が残る文書/);
  assert.match(result.stdout, /作成: package\.json/);
  assert.equal(migrate().status, 0, "既定も dry-run");
  assert.deepEqual(snapshot(root), before);
});

test("移行するとタスク・QA・成果物・索引・リンクを新構成へ移し、元の値を保つ", () => {
  const hash = planHash(migrate("--dry-run").stdout);
  const result = migrate("--apply", "--plan", hash);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(root, "job")), false);

  // frontmatter と本文
  const index = read(root, "jobs/PROJ-1/tasks/api-setup/index.md");
  assert.ok(index.startsWith(phaseTask.slice(0, phaseTask.indexOf("\n---\n", 4) + 5)), "frontmatter は変えない");
  assert.match(index, /成果物は \[結果\]\(assets\/2026-09-02\/result\.md\)、仕様は \[docs\]\(\.\.\/\.\.\/\.\.\/\.\.\/docs\/unofficial\/spec\.md\)。/);
  assert.match(index, /## 詳細\n\n\* \[フェーズ1：調査\]\(01-phase1\.md\)\n\* \[Phase 3: Build API\]\(02-phase-3-build-api\.md\)\n\n## 結果\n\n完了。\n$/);
  assert.doesNotMatch(index, /## ログ/);
  const phase1 = read(root, "jobs/PROJ-1/tasks/api-setup/01-phase1.md");
  assert.equal(
    phase1,
    "# フェーズ1：調査\n\n## 計画\n\n1. 既存を調べる\n\n```md\n### コードブロック内の見出し\n```\n\n## 実施内容\n\n[前の記録](../../../../daily/2026-09/01/note.md#メモ)\n",
  );
  assert.equal(read(root, "jobs/PROJ-1/tasks/api-setup/02-phase-3-build-api.md"), "# Phase 3: Build API\n\n## 計画\n\n実装する\n");
  assert.equal(read(root, "jobs/PROJ-1/tasks/plain/index.md"), plainTask);
  assert.equal(read(root, "jobs/PROJ-1/qa/deploy-policy/index.md"), qa);

  // 成果物・案件共通の資料・案件直下のファイル
  assert.equal(read(root, "jobs/PROJ-1/tasks/api-setup/assets/2026-09-02/result.md"), "[タスク](../../index.md)\n![](shot.gif)\n");
  assert.equal(read(root, "jobs/PROJ-1/tasks/api-setup/assets/2026-09-02/shot.gif"), "GIF89a");
  assert.ok((readdirSync(join(root, "jobs/PROJ-1/assets/e2e")).includes("run.sh")));
  assert.equal(snapshot(root)["jobs/PROJ-1/assets/e2e/run.sh"].split(":")[0], "755");
  assert.equal(read(root, "jobs/PROJ-1/MEMORY.md"), "- [T-001](tasks/api-setup/index.md) / [成果物](tasks/api-setup/assets/2026-09-02/result.md)\n");
  assert.equal(read(root, "jobs/other/MEMORY.md"), "# other\n");

  // 状態索引は frontmatter から作り直す
  assert.equal(readlinkSync(join(root, "jobs/PROJ-1/status/progress/api-setup")), "../../tasks/api-setup");
  assert.equal(readlinkSync(join(root, "jobs/PROJ-1/status/done/plain")), "../../tasks/plain");
  assert.equal(existsSync(join(root, "jobs/PROJ-1/status/todo/plain")), false);
  assert.equal(readlinkSync(join(root, "jobs/PROJ-1/qa/status/unresolved/deploy-policy")), "../../deploy-policy");
  for (const dir of ["status/todo", "qa/status/resolved", "tasks", "assets"]) assert.ok(existsSync(join(root, "jobs/other", dir, ".gitkeep")), dir);

  // job/ の外のリンクは書き換え、コマンド例は残す
  assert.equal(read(root, "docs/unofficial/spec.md"), "- [タスク](../../jobs/PROJ-1/tasks/api-setup/index.md#フェーズ1調査)\n- `./job/add-task.sh PROJ-1 x todo` はコマンド例\n");
  assert.equal(
    read(root, "daily/2026-09/01/note.md"),
    "[成果物](../../../jobs/PROJ-1/tasks/api-setup/assets/2026-09-02/shot.gif) [雛形](../../../job/template/list/template.md)\n",
  );
  assert.equal(read(root, "README.md"), "# old\n\n[案件](jobs/PROJ-1/) の説明。\n\n```sh\ncp -R job/template job/x\n```\n");

  // scripts/・package.json・.gitignore
  assert.deepEqual(snapshot(join(root, "scripts"), (rel) => rel === "node_modules"), snapshot(scriptsDir, (rel) => rel === "node_modules"));
  assert.deepEqual(JSON.parse(read(root, "package.json")).scripts, { raprid: "node scripts/cli.ts" });
  assert.equal(read(root, ".gitignore"), "node_modules/\njobs/*/assets/e2e/node_modules/\n\n# raprid (案件操作のロックと移行時の退避先)\njobs/.locks/\n.raprid-migrate/\n");

  // すべての Markdown リンクが実在するものを指す (移さない旧雛形へのリンクを除く)
  for (const [rel] of Object.entries(snapshot(root, (path) => path === ".raprid-migrate" || path === "scripts"))) {
    if (!rel.endsWith(".md")) continue;
    for (const match of read(root, rel).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      if (match[1].includes("job/template")) continue;
      assert.ok(existsSync(join(root, posix.dirname(rel), match[1])), `${rel} -> ${match[1]}`);
    }
  }

  // 導入した scripts/ で操作できる
  const list = raprid(root, ["task", "list", "PROJ-1"], { script: join(root, "scripts", "cli.ts") });
  assert.equal(list.status, 0, list.stderr);
  assert.doesNotMatch(list.stdout, /要確認/);
  assert.match(list.stdout, /progress \(1\)\n    T-001 +api-setup +API を用意する/);
  const add = raprid(root, ["task", "add", "PROJ-1", "next", "todo", "次"], { script: join(root, "scripts", "cli.ts") });
  assert.match(add.stdout, /T-003/);
});

test("移行後の再実行は何も変更しない", () => {
  assert.equal(migrate("--apply").status, 0);
  const before = snapshot(root);
  const again = migrate("--apply");
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /移行済み/);
  assert.equal(migrate("--dry-run").status, 0);
  assert.deepEqual(snapshot(root), before);
});

test("--restore で移行前に戻せる。移行後に変更があれば戻さない", () => {
  const before = snapshot(root, skipWork);
  const applied = migrate("--apply");
  const id = /移行ID: ([0-9a-f-]+)/.exec(applied.stdout)![1];

  write(root, "jobs/PROJ-1/tasks/plain/index.md", "手で更新\n");
  const refused = migrate("--restore", id);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /移行後に変更されたファイル/);
  write(root, "jobs/PROJ-1/tasks/plain/index.md", plainTask);

  const restored = migrate("--restore", id);
  assert.equal(restored.status, 0, restored.stderr);
  assert.deepEqual(snapshot(root, skipWork), before);
  assert.match(migrate("--restore", id).stdout, /既に戻されています/);
});

test("途中で失敗したらこの実行で変えたものを戻し、再実行できる", () => {
  const before = snapshot(root, skipWork);
  const hook = join(work, "fail-rename.cjs");
  // 最後の手順 (旧 job/ の退避) で失敗させる
  writeFileSync(hook, `
    const fs = require("node:fs");
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (String(to).endsWith("/backup/job")) throw new Error("退避失敗の模擬");
      return rename(from, to);
    };
    require("node:module").syncBuiltinESMExports();
  `);
  const failed = raprid(root, ["job", "migrate", "--apply"], { require: hook });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /移行に失敗したため、この実行で変えたものを戻しました: 退避失敗の模擬/);
  assert.deepEqual(snapshot(root, skipWork), before);
  assert.equal(migrate("--apply").status, 0);
});

test("計画の作成後に変更があれば実行しない", () => {
  const hash = planHash(migrate("--dry-run").stdout);
  write(root, "job/PROJ-1/list/plain.md", plainTask.replace("なし", "追記"));
  const before = snapshot(root, skipWork);
  const result = migrate("--apply", "--plan", hash);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /一致しない/);
  assert.deepEqual(snapshot(root, skipWork), before);
});

test("重複ID・分類できないファイル・既存の scripts/・混在状態では何も変えずに中止する", () => {
  const cases: [string, (dir: string) => void, RegExp][] = [
    ["重複ID", (dir) => write(dir, "job/PROJ-1/list/dup.md", plainTask.replace("T-002", "T-001")), /ID重複: T-001/],
    ["分類できない", (dir) => write(dir, "job/PROJ-1/list/memo.txt", "x"), /分類できないファイル: job\/PROJ-1\/list\/memo\.txt/],
    ["frontmatter", (dir) => write(dir, "job/PROJ-1/list/bad.md", "本文だけ\n"), /frontmatter がありません/],
    ["scripts", (dir) => write(dir, "scripts/build.sh", "echo\n"), /既存の scripts\/ が管理リポジトリの scripts\/ ではない/],
    ["混在", (dir) => mkdirSync(join(dir, "jobs")), /job\/ と jobs\/ が両方ある/],
    ["package.json", (dir) => write(dir, "package.json", '{"scripts":{"raprid":"echo"}}'), /scripts\.raprid が既にある/],
  ];
  for (const [label, setup, message] of cases) {
    const dir = join(work, label);
    mkdirSync(dir);
    oldProject(dir);
    setup(dir);
    const before = snapshot(dir);
    const result = raprid(dir, ["job", "migrate", "--apply"]);
    assert.equal(result.status, 1, `${label}: ${result.stdout}`);
    assert.match(result.stderr, message, label);
    assert.deepEqual(snapshot(dir), before, label);
  }
});

test("既存の package.json は raprid スクリプトだけを追加する", () => {
  write(root, "package.json", JSON.stringify({ name: "old", scripts: { test: "x" }, private: true }));
  assert.equal(migrate("--apply").status, 0);
  assert.deepEqual(JSON.parse(read(root, "package.json")), { name: "old", scripts: { test: "x", raprid: "node scripts/cli.ts" }, private: true });
});

test("新構成の scripts/ を持つプロジェクトではローカルの移行処理がそのまま使われる", () => {
  cpSync(scriptsDir, join(root, "scripts"), { recursive: true });
  const result = raprid(root, ["job", "migrate", "--apply"], { script: join(root, "scripts", "cli.ts") });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(root, "jobs/PROJ-1/tasks/api-setup/index.md")));
});

test("同時に 2 回実行しても片方だけが移行し、job/ と jobs/ を失わない", async () => {
  const { spawn } = await import("node:child_process");
  const cli = join(scriptsDir, "cli.ts");
  const runs = Array.from({ length: 3 }, () =>
    new Promise<{ status: number | null; stdout: string }>((resolvePromise) => {
      const child = spawn(process.execPath, [cli, "job", "migrate", "--apply"], { env: { ...process.env, RAPRID_ROOT: root } });
      let stdout = "";
      child.stdout.on("data", (data) => (stdout += data));
      child.on("close", (status) => resolvePromise({ status, stdout }));
    }),
  );
  const results = await Promise.all(runs);
  for (const result of results) assert.equal(result.status, 0, result.stdout);
  assert.equal(results.filter((result) => result.stdout.includes("移行しました")).length, 1);
  assert.ok(existsSync(join(root, "jobs/PROJ-1/tasks/api-setup/index.md")));
  assert.equal(existsSync(join(root, "job")), false);
  assert.equal(existsSync(join(root, ".raprid-migrate/.lock")), false);
});

test("記録が途中 (started) のままでも、移行後の変更があれば復元しない", () => {
  const applied = migrate("--apply");
  const id = /移行ID: ([0-9a-f-]+)/.exec(applied.stdout)![1];
  const journalPath = join(root, ".raprid-migrate", id, "journal.json");
  writeFileSync(journalPath, read(root, `.raprid-migrate/${id}/journal.json`).replace('"completed"', '"started"'));
  const added = raprid(root, ["task", "add", "PROJ-1", "later", "todo", "移行後の追加"], { script: join(root, "scripts", "cli.ts") });
  assert.equal(added.status, 0, added.stderr);
  const before = snapshot(root);
  const result = migrate("--restore", id);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /移行後に変更されたファイル: jobs\/PROJ-1\/tasks\/later\/index\.md/);
  assert.deepEqual(snapshot(root), before);
});

test("脚注・実在しないパス・見出しだけのフェーズ・HTML の参照を壊さない", () => {
  const path = "job/PROJ-1/list/plain.md";
  write(
    root,
    path,
    plainTask.replace(
      "## 結果",
      "## ログ\n\n### 準備\n\n#### 2026-09-01 本番リリース完了\n\n### 空\n\n#### 計画\n\n## 結果\n\n脚注[^1]、[手順](URL)、<img src=\"../assets/plain/x.png\">\n\n[^1]: 補足説明\n",
    ),
  );
  const result = migrate("--apply");
  assert.equal(result.status, 0, result.stderr);
  const index = read(root, "jobs/PROJ-1/tasks/plain/index.md");
  assert.match(index, /\[\^1\]: 補足説明/);
  assert.match(index, /\[手順\]\(URL\)/);
  assert.match(index, /\* \[準備\]\(01-phase1\.md\)\n\n## 結果/, "骨組みだけのフェーズ「空」は省く");
  assert.equal(read(root, "jobs/PROJ-1/tasks/plain/01-phase1.md"), "# 準備\n\n## 2026-09-01 本番リリース完了\n");
});

test("HTML の参照と分割後のアンカーは保留に出す", () => {
  write(root, "job/PROJ-1/list/plain.md", plainTask.replace("なし", "<img src=\"../assets/plain/x.png\"> [上](#タイトル)\n\n## ログ\n\n### 記録\n\n本文"));
  const result = migrate("--dry-run");
  assert.match(result.stdout, /HTML の src\/href は書き換えない .*plain\/index\.md/);
  assert.match(result.stdout, /同じファイル内のアンカー/);
});

test("qa/ の下の未知のディレクトリがあれば中止する", () => {
  write(root, "job/PROJ-1/qa/assets/shot.png", "png");
  const before = snapshot(root);
  const result = migrate("--apply");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /分類できないファイル: job\/PROJ-1\/qa\/assets/);
  assert.deepEqual(snapshot(root), before);
});

test("CRLF の .gitignore とタブで整形した package.json の書式を保つ", () => {
  write(root, ".gitignore", "node_modules/\r\njob/*/assets/e2e/node_modules/\r\n");
  write(root, "package.json", '{\n\t"name": "old"\n}\n');
  assert.equal(migrate("--apply").status, 0);
  assert.equal(read(root, ".gitignore"), "node_modules/\r\njobs/*/assets/e2e/node_modules/\r\n\r\n# raprid (案件操作のロックと移行時の退避先)\r\njobs/.locks/\r\n.raprid-migrate/\r\n");
  assert.equal(read(root, "package.json"), '{\n\t"name": "old",\n\t"scripts": {\n\t\t"raprid": "node scripts/cli.ts"\n\t}\n}\n');
});

test("別の移行が完了した後に古い記録で restore しても何も消さない", () => {
  // 移行 A: jobs/ を置く前に止まった記録を再現する (失敗時の自動の巻き戻しより前に強制終了した状態)
  const hook = join(work, "crash.cjs");
  writeFileSync(hook, `
    const fs = require("node:fs");
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (String(to).endsWith("/jobs") && String(from).includes("/stage/")) process.exit(9);
      return rename(from, to);
    };
    require("node:module").syncBuiltinESMExports();
  `);
  const crashed = raprid(root, ["job", "migrate", "--apply"], { require: hook });
  assert.equal(crashed.status, 9);
  const stale = readdirSync(join(root, ".raprid-migrate")).find((name) => /^\d{8}-/.test(name))!;
  assert.match(read(root, `.raprid-migrate/${stale}/journal.json`), /"started"/);
  assert.equal(migrate("--apply").status, 0, "移行 B");
  const before = snapshot(root, skipWork);
  const result = migrate("--restore", stale);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /別の移行が完了している可能性があります/);
  assert.deepEqual(snapshot(root, skipWork), before);
});

test("作成予定のファイルが実行前に現れたら何も変えずに中止する", () => {
  const hook = join(work, "race.cjs");
  // 計画の作成後、最初の rename の前に package.json を作る
  writeFileSync(hook, `
    const fs = require("node:fs");
    const cp = fs.cpSync;
    let done = false;
    fs.cpSync = (...args) => {
      if (!done) { done = true; fs.writeFileSync(${JSON.stringify(join(root, "package.json"))}, "{}"); }
      return cp(...args);
    };
    require("node:module").syncBuiltinESMExports();
  `);
  const result = raprid(root, ["job", "migrate", "--apply"], { require: hook });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /計画の作成後に変更されたファイル[\s\S]*package\.json/);
  assert.ok(existsSync(join(root, "job")));
  assert.equal(existsSync(join(root, "jobs")), false);
  assert.equal(read(root, "package.json"), "{}");
});
