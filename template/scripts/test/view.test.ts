import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { listGroups, parseFilter } from "../lib/query.ts";
import { Collector } from "../lib/records.ts";
import { clampLines, sanitize, width, wrap } from "../lib/text.ts";
import { type Display, renderList, resolveDisplay } from "../lib/view.ts";
import { cli, raprid, read, write } from "./helpers.ts";

let root: string;

const longTitle = "日本語と絵文字👨‍👩‍👧‍👦と結合文字é（e+U+0301）を含み、端末の幅を超えるほど長いタイトルを、途中で切らずに読みやすく折り返して表示する";

before(() => {
  root = mkdtempSync(join(tmpdir(), "raprid-view-"));
  mkdirSync(join(root, "jobs"));
  const run = (args: string[]) => assert.equal(raprid(root, args).status, 0, args.join(" "));
  run(["job", "create", "PROJ-1"]);
  run(["task", "add", "PROJ-1", "long-title", "progress", longTitle]);
  run(["task", "add", "PROJ-1", "short", "todo", "短い"]);
  run(["task", "add", "PROJ-1", "waiting", "pending", "待つ", "other: 権限の付与と、とても長い待ち理由の説明をここに書く"]);
  run(["task", "add", "PROJ-1", "finished", "todo", "完了済み"]);
  run(["task", "move", "PROJ-1", "T-004", "done"]);
  run(["qa", "add", "PROJ-1", "ask", "customer", "確認先の列を持つ質問"]);
  // 旧記録: actor が無い
  const path = "jobs/PROJ-1/tasks/short/index.md";
  write(root, path, read(root, path).replace("requestedBy: agent/test\ncreatedBy: agent/test\n", ""));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function display(overrides: Partial<Display>): Display {
  return { width: 80, border: "unicode", color: false, ellipsis: "…", long: false, ...overrides };
}

function render(kind: "task" | "qa", shown: Display, filter: { all?: boolean } = {}): string {
  const collector = new Collector(root);
  const datas = collector.jobs().map((job) => collector.job(job));
  return renderList(kind, listGroups(kind, datas, parseFilter(kind, filter)), shown);
}

test("端末幅 20・40・79・80・120 で各行が幅に収まり、ID と状態は省略しない", () => {
  for (const size of [20, 40, 79, 80, 120]) {
    const text = render("task", display({ width: size }));
    for (const line of text.split("\n")) assert.ok(width(line) <= size, `${size}: ${line} (${width(line)})`);
    assert.match(text, /T-001/);
    assert.match(text, /progress/);
    assert.match(text, /pending/);
    if (size <= 40) assert.match(text, /…/, `${size}: 収まらないタイトルは 2 行で省略する`);
  }
});

test("QA と長い状態も、端末幅 20・40・79・80・120 の各行が幅に収まり、ID・状態・確認先を省略しない", () => {
  for (const size of [12, 20, 40, 79, 80, 120]) {
    for (const [kind, filter] of [["qa", {}], ["task", { all: true }]] as const) {
      const text = render(kind, display({ width: size, long: true }), filter);
      for (const line of text.split("\n")) assert.ok(width(line) <= size, `${kind} ${size}: ${line} (${width(line)})`);
    }
    const qaText = render("qa", display({ width: size }));
    for (const value of ["Q-001", "unresolved", "customer"]) assert.ok(qaText.includes(value), `${size}: ${value} を省略しない`);
  }
  // 20 桁: ID と状態の後ろに確認先が入らないので、確認先を次の行へ送る
  assert.match(render("qa", display({ width: 20 })), /\nQ-001 unresolved\ncustomer\n確認先の列を持つ質問/);
  // 状態の値が幅より長い古い記録も、折り返して全部出す
  const path = "jobs/PROJ-1/tasks/short/index.md";
  const original = read(root, path);
  write(root, path, original.replace("status: todo", "status: waiting-for-a-very-long-external-approval"));
  try {
    for (const size of [20, 40]) {
      const text = render("task", display({ width: size }));
      for (const line of text.split("\n")) assert.ok(width(line) <= size, `${size}: ${line}`);
      assert.ok(text.replace(/\n/g, "").includes("waiting-for-a-very-long-external-approval"), `${size}: 状態を省略しない`);
    }
  } finally {
    write(root, path, original);
  }
});

test("幅 80 以上は表、40〜79 は ID・状態とタイトルの行、40 未満は縦配置にする", () => {
  const table = render("task", display({ width: 80 }));
  assert.match(table, /^PROJ-1  3件表示 \/ 全4件\nID     状態      タイトル\n─────  ────────  ─+\nT-001  progress  日本語/);
  assert.match(table, /\n\nT-002  todo      短い\n\nT-003  pending   待つ\n  待ち: other: 権限の付与/, "状態の間に空行を置き、待ち理由は 1 段下げる");
  const titleLines = table.split("\n").filter((line) => line.startsWith(" ".repeat(17)));
  assert.equal(titleLines.length, 1, "タイトルは最大 2 行");

  const stacked = render("task", display({ width: 60 }));
  assert.match(stacked, /\nT-001  progress\n  日本語/);
  assert.match(stacked, /\nT-003  pending\n  待つ\n  待ち: /);

  const minimal = render("task", display({ width: 30 }));
  assert.match(minimal, /^PROJ-1  3件表示 \/ 全4件\nT-001 progress\n日本語/);
  assert.doesNotMatch(minimal, /─/, "縦配置では罫線を省く");

  const qa = render("qa", display({ width: 100 }));
  assert.match(qa, /^PROJ-1 QA  1件表示 \/ 全1件\nID     状態        確認先    タイトル\n/);
  assert.match(qa, /\nQ-001  unresolved  customer  確認先の列を持つ質問$/m);
});

test("--long と非 TTY は全文を出し、--long では作成者と日付を添える", () => {
  const long = render("task", display({ width: 80, long: true }));
  const joined = long.replace(/\n {17}/g, "");
  assert.ok(joined.includes(longTitle), "--long は全文を折り返す");
  assert.doesNotMatch(long, /…/);
  assert.match(long, /T-002  todo      短い\n  依頼: 不明（旧記録） \/ 記録: 不明（旧記録）\n  作成: \d{4}-\d{2}-\d{2} \/ 更新: .* \/ 完了: -\n  パス: jobs\/PROJ-1\/tasks\/short\/index\.md/);

  const piped = render("task", display({ width: undefined, border: "none" }));
  assert.ok(piped.includes(`T-001  progress  ${longTitle}`), "非 TTY は省略・折返ししない");
  assert.doesNotMatch(piped, /─/);
  assert.doesNotMatch(piped, /T-004/, "done は既定で隠す");
  assert.match(render("task", display({ width: undefined, border: "none" }), { all: true }), /T-004  done      完了済み/);
});

test("TTY・パイプ・NO_COLOR・TERM=dumb・ロケールから表示方法を決め、明示指定を優先する", () => {
  const utf8 = { LANG: "ja_JP.UTF-8" };
  assert.deepEqual(resolveDisplay({}, { isTTY: false }, utf8), { width: undefined, border: "none", color: false, ellipsis: "…", long: false });
  assert.deepEqual(resolveDisplay({}, { isTTY: true, columns: 200 }, utf8), { width: 120, border: "unicode", color: true, ellipsis: "…", long: false });
  assert.equal(resolveDisplay({}, { isTTY: true, columns: 0 }, utf8).width, 80);
  assert.equal(resolveDisplay({ width: "200" }, { isTTY: true, columns: 100 }, utf8).width, 200, "--width は TTY の幅を上書き");
  assert.equal(resolveDisplay({ width: "200" }, { isTTY: false }, utf8).width, undefined, "--width は非 TTY に影響しない");
  assert.equal(resolveDisplay({}, { isTTY: true, columns: 100 }, { LANG: "C" }).border, "ascii");
  assert.equal(resolveDisplay({}, { isTTY: true, columns: 100 }, { LANG: "C" }).ellipsis, "...");
  assert.deepEqual(resolveDisplay({}, { isTTY: true, columns: 100 }, { ...utf8, TERM: "dumb" }).border, "none");
  assert.equal(resolveDisplay({}, { isTTY: true, columns: 100 }, { ...utf8, TERM: "dumb" }).color, false);
  assert.equal(resolveDisplay({}, { isTTY: true, columns: 100 }, { ...utf8, NO_COLOR: "1" }).color, false);
  assert.equal(resolveDisplay({}, { isTTY: true, columns: 100 }, { ...utf8, NO_COLOR: "" }).color, true, "空の NO_COLOR は未指定と同じ");
  assert.equal(resolveDisplay({ border: "ascii" }, { isTTY: false }, utf8).border, "ascii", "明示指定は罫線種を上書き");
  assert.equal(resolveDisplay({ border: "none" }, { isTTY: true, columns: 100 }, utf8).border, "none");
  assert.equal(resolveDisplay({ color: "always" }, { isTTY: false }, utf8).color, true);
  assert.equal(resolveDisplay({ color: "never" }, { isTTY: true, columns: 100 }, utf8).color, false);
  const ascii = render("task", display({ width: 80, border: "ascii" }));
  assert.match(ascii, /\n-----  --------  -+\n/);
});

test("色は状態の文字を置き換えず、幅の計算に ANSI を含めない", () => {
  const colored = render("task", display({ width: 80, color: true }));
  assert.match(colored, /\u001b\[36mprogress\u001b\[39m/);
  for (const line of colored.split("\n")) assert.ok(width(line) <= 80, line);
  assert.equal(colored.replace(/\u001b\[\d+m/g, ""), render("task", display({ width: 80 })));
});

test("文字列処理: 制御文字の除去と grapheme 境界での折返し・省略", () => {
  assert.equal(sanitize("\u001b[31m赤\u001b[0m\u0007\u001b]8;;http://x\u0007リンク\u001b]8;;\u0007‮\n改行\tタブ"), "赤リンク 改行  タブ");
  assert.equal(sanitize("一\r\n二", true), "一\n二");
  assert.equal(width("日本語👨‍👩‍👧‍👦é"), 6 + 2 + 1);
  assert.deepEqual(wrap("👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦", 5), ["👨‍👩‍👧‍👦👨‍👩‍👧‍👦", "👨‍👩‍👧‍👦"], "ZWJ の絵文字を分けない");
  assert.deepEqual(wrap("éééé", 2), ["éé", "éé"], "結合文字を基底文字から離さない");
  assert.deepEqual(wrap("あいうえお", 3), ["あ", "い", "う", "え", "お"], "全角 1 文字は幅 2");
  assert.deepEqual(clampLines("あいうえおかきくけこ", 6, 2, "…"), ["あいう", "えお…"]);
  assert.deepEqual(clampLines("短い", 6, 2, "…"), ["短い"]);
  assert.deepEqual(clampLines("abcdefghij", undefined, 1, "…"), ["abcdefghij"], "幅の制限が無ければ折り返さない");
});

test("同梱の text-width.mjs は固定した版から再生成したものと一致する", async (t) => {
  let bundle: () => Promise<{ code: string; licenses: string }>;
  try {
    ({ bundleTextWidth: bundle } = await import("../vendor/build.ts"));
  } catch {
    t.skip("esbuild が導入されていない (pnpm install で導入する)");
    return;
  }
  const vendor = join(dirname(cli), "vendor");
  const { code, licenses } = await bundle();
  assert.equal(readFileSync(join(vendor, "text-width.mjs"), "utf8"), code, "pnpm vendor:build で作り直す");
  assert.equal(readFileSync(join(vendor, "THIRD_PARTY_LICENSES.txt"), "utf8"), licenses);
});
