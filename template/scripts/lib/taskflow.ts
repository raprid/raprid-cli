// 工程型タスク (workflowVersion 3) の遷移を、ファイルへ安全に反映するサービス。CLI への接続は T-014 で行う。
//
// 1 回の操作は次の順で行い、どこで失敗しても index.md を変えない (書き込みは最後の 1 回だけ、一時ファイルからの置き換え):
//   1. revision (--if-match) を必須にする。無ければ REVISION_REQUIRED
//   2. 案件のロックを取る (再開では待っている QA の案件も名前順にロックする)。ロックの中で、この案件に残った v4 の操作の
//      journal を先に復旧する (lib/journal.ts。不整合な journal があれば何も変えずに止まる。契約 7、R21-2)
//   3. ロックの中で index.md を読み直し、revision を照合する。違えば REVISION_CONFLICT
//   4. v3 で、記録に不整合が無いことを確かめる (旧形式・v2 は移行の案内で止める)
//   5. 引継資料・判定の記録・成果物の参照・待っている QA を確かめる
//   6. lib/transitions.ts で遷移を計算し、変わった値だけを YamlFrontmatter で書き換える (未知の項目・コメント・本文は残す)
//   7. 書き換えた結果を読み直し、形式の規則を満たして計算した値と同じなら、index.md と作業索引
//      (status/<工程>/<工程の状態>/<名前>、lib/workindex.ts) を一緒に書き換える。索引の更新に失敗したら index.md も元のまま (T-014)
//
// 引継資料 (complete の最初の参照・progress 中の担当交代) は、タスクのディレクトリの中の Markdown で、
// 「対象・成果物」「実施・検証」「未確認・制約」「次の担当への依頼」の 4 つの節を、それぞれ別の (重ならない) 見出しに持ち、
// どの節にも空行・HTML コメント (複数行を含む)・下位の見出しの行以外の中身があること。HTML コメントの中の見出しは見出しにしない。種別ごとの項目 (採用設計の表) は
// その節の中のチェックリストで、機械は節と参照の存在・範囲だけを確かめる (内容の十分さはレビューで判断する)。
// 成果物の参照はタスクの中の通常のファイル (ディレクトリ・タスクの index.md は不可) か repos/<名前> の commit。
// 実装 (implementation) の実行 (execute) の完了には、引継資料のほかに対象の参照 (repo+commit か、引継資料そのものではない
// タスクの中のファイル) が 1 件以上必要。調査 (research) は資料だけで完了できる (repo/commit を求めない)。

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { assertQaResolved, qaJobs } from "./blockers.ts";
import { CliError, UsageError } from "./errors.ts";
import { FrontmatterError } from "./frontmatter.ts";
import { isDirectory, isFile, localDate } from "./fsutil.ts";
import { assertRevision, parseIfMatch, revisionOf } from "./guard.ts";
import { type Heading, splitLines } from "./markdown.ts";
import { isSelector, Item, Job, withJobWriteLocks } from "./jobs.ts";
import { type Clock, type Operation, TransitionError, transition } from "./transitions.ts";
import { commitWithIndex, expectedLink, type IndexFs } from "./workindex.ts";
import { type ArtifactRef, type HistoryEntryV3, isSafeRelativePath, readTaskFile, type TaskV3 } from "./workflow.ts";
import { YamlEditError, YamlFrontmatter, type YamlPath } from "./yamlfront.ts";

export interface TransitionResult {
  item: Item;
  task: TaskV3;
  revision: string; // 書き込んだ index.md の revision (次の操作の --if-match に使う)
  appended: HistoryEntryV3[]; // この操作で追記した履歴
}

export interface TaskflowOptions {
  clock?: Clock; // 試験で時刻を固定する
  indexFs?: IndexFs; // 実体と作業索引の書き込み (試験で失敗を注入する。既定は node:fs)
  // ロックの中で、遷移の前に行う準備 (task ask の QA の作成など)。操作を返し、後の手順で失敗したら undo で戻す
  prepare?: (context: { job: Job; item: Item; task: TaskV3 }) => { operation: Operation; undo: () => void };
}

const documentLimit = 1024 * 1024;
export const handoffSections: readonly { label: string; keywords: readonly string[] }[] = [
  { label: "対象・成果物", keywords: ["対象", "成果物"] },
  { label: "実施・検証", keywords: ["実施", "検証"] },
  { label: "未確認・制約", keywords: ["未確認", "制約"] },
  { label: "次の担当への依頼", keywords: ["依頼"] },
];

function now(): Clock {
  return { date: localDate(), at: new Date().toISOString() };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// 変わった値だけを書き換える。配列の末尾への追加 (履歴) は追加として、それ以外の配列は置き換えとして書く
export function patch(frontmatter: YamlFrontmatter, before: unknown, after: unknown, path: YamlPath): void {
  if (same(before, after)) return;
  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of Object.keys(after)) {
      if (key in before) patch(frontmatter, before[key], after[key], [...path, key]);
      else frontmatter.set([...path, key], after[key]);
    }
    for (const key of Object.keys(before)) if (!(key in after)) frontmatter.delete([...path, key]);
    return;
  }
  if (Array.isArray(before) && Array.isArray(after) && after.length >= before.length && before.every((value, index) => same(value, after[index]))) {
    for (let index = before.length; index < after.length; index++) frontmatter.set([...path, index], after[index]);
    return;
  }
  frontmatter.set(path, after);
}

// タスクを名前か ID で探す。新形式の frontmatter は入れ子なので YamlFrontmatter で ID を読む
export function findTask(job: Job, selector: string): Item {
  if (!isSelector("task", selector)) throw new UsageError(`タスクのIDまたは名前の形式が不正です: ${selector}`);
  if (!/^T-\d{3,}$/.test(selector)) {
    const item = new Item(job, "task", selector);
    if (!isFile(item.index)) throw new CliError(`タスクが見つかりません: ${job.display(item.index)}`, 1, "TASK_NOT_FOUND");
    return item;
  }
  const matches = job.items("task").filter((item) => {
    if (!isFile(item.index)) return false;
    try {
      return YamlFrontmatter.parse(item.read(), job.display(item.index)).get(["id"]) === selector;
    } catch {
      return item.idOrEmpty() === selector; // 入れ子として読めない旧形式
    }
  });
  if (matches.length === 0) throw new CliError(`タスクのIDが見つかりません: ${selector}`, 1, "TASK_NOT_FOUND");
  if (matches.length > 1) throw new CliError(`タスクのIDが重複しています: ${selector}`, 1, "TASK_ID_DUPLICATE");
  return matches[0];
}

function refError(message: string): CliError {
  return new CliError(message, 1, "WF_REF");
}

// タスクのディレクトリの中の Markdown を読む (.. やリンクで外へ出るもの・index.md・大きすぎるもの・UTF-8 でないものを拒否)
export function readDocument(taskDir: string, path: string | undefined, label: string, code: string): string {
  if (path === undefined || !isSafeRelativePath(path)) throw new CliError(`${label}はタスクのディレクトリからの相対パスで指定してください: ${path ?? "未指定"}`, 1, code);
  if (!path.endsWith(".md") || path === "index.md") throw new CliError(`${label}はタスクのディレクトリの Markdown (index.md 以外) です: ${path}`, 1, code);
  const full = join(taskDir, path);
  let real: string;
  try {
    real = realpathSync(full);
  } catch {
    throw new CliError(`${label}が見つかりません: ${path}`, 1, code);
  }
  const inside = relative(realpathSync(taskDir), real);
  if (inside === "" || inside.startsWith("..") || inside.startsWith(sep)) throw new CliError(`${label}がタスクのディレクトリの外を指しています: ${path}`, 1, code);
  const stat = lstatSync(real);
  if (!stat.isFile()) throw new CliError(`${label}がファイルではありません: ${path}`, 1, code);
  if (stat.size > documentLimit) throw new CliError(`${label}が大きすぎます (上限 ${documentLimit} バイト): ${path}`, 1, code);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(real));
  } catch {
    throw new CliError(`${label}が UTF-8 ではありません: ${path}`, 1, code);
  }
  if (text.trim() === "") throw new CliError(`${label}が空です: ${path}`, 1, code);
  return text;
}

// Markdown を 1 回だけ先頭から読み、各行の「見える部分」を求める。コードブロックの中はそのまま (コメントを始めない)、
// HTML コメントの中 (複数行・節の境界をまたぐものを含む) は消す。コメントの中の見出しは見出しにしない (R13-3)
interface VisibleLine {
  text: string; // コメントを除いた部分
  fenced: boolean; // コードブロックの中 (フェンスの行を含む)
}

function visibleLines(lines: string[]): VisibleLine[] {
  const result: VisibleLine[] = [];
  let fence: { char: string; length: number } | undefined;
  let comment = false;
  for (const line of lines) {
    if (fence) {
      const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (match && match[1][0] === fence.char && match[1].length >= fence.length) fence = undefined;
      result.push({ text: line, fenced: true });
      continue;
    }
    if (!comment) {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (open) {
        fence = { char: open[1][0], length: open[1].length };
        result.push({ text: line, fenced: true });
        continue;
      }
    }
    let rest = line;
    let text = "";
    while (rest !== "") {
      if (comment) {
        const close = rest.indexOf("-->");
        if (close < 0) rest = "";
        else [comment, rest] = [false, rest.slice(close + 3)];
      } else {
        const open = rest.indexOf("<!--");
        if (open < 0) [text, rest] = [text + rest, ""];
        else [text, rest, comment] = [text + rest.slice(0, open), rest.slice(open + 4), true];
      }
    }
    result.push({ text, fenced: false });
  }
  return result;
}

// 見える部分の見出し (コードブロック・コメントの中は除く)
function visibleHeadings(visible: VisibleLine[]): Heading[] {
  const found: Heading[] = [];
  visible.forEach((line, index) => {
    if (line.fenced) return;
    const match = /^ {0,3}(#{1,6})\s+(.*?)\s*$/.exec(line.text);
    if (match) found.push({ line: index, level: match[1].length, text: match[2].replace(/\s+#+$/, "") });
  });
  return found;
}

// 見出しの節の範囲 [見出しの行, 同じか上の階層の次の見出しの手前)
function sectionEnd(found: Heading[], heading: Heading, total: number): number {
  const next = found.find((other) => other.line > heading.line && other.level <= heading.level);
  return next ? next.line : total;
}

// 節に中身があるか。見える部分が空行・下位の見出しの行だけなら空 (コメントの中は見える部分に含まれない)
function sectionFilled(visible: VisibleLine[], headingLines: Set<number>, heading: Heading, end: number): boolean {
  for (let index = heading.line + 1; index < end; index++) {
    if (headingLines.has(index)) continue;
    if (visible[index].text.trim() !== "") return true;
  }
  return false;
}

// 4 つの節を、それぞれ別の見出しに割り当てる。1 つの見出しが 2 つの節を兼ねたり、節が別の節の中にあったりしてはいけない
function assignSections(lines: string[]): { missing: string[]; empty: string[] } {
  const visible = visibleLines(lines);
  const found = visibleHeadings(visible);
  const headingLines = new Set(found.map((heading) => heading.line));
  const candidates = handoffSections.map((section) =>
    found.filter((heading) => section.keywords.some((keyword) => heading.text.includes(keyword))).map((heading) => ({ heading, end: sectionEnd(found, heading, lines.length) })),
  );
  const filled = candidates.map((list) => list.filter((item) => sectionFilled(visible, headingLines, item.heading, item.end)));
  const overlaps = (a: { heading: Heading; end: number }, b: { heading: Heading; end: number }) => a.heading.line < b.end && b.heading.line < a.end;
  const chosen: { heading: Heading; end: number }[] = [];
  const search = (index: number): boolean => {
    if (index === handoffSections.length) return true;
    for (const item of filled[index]) {
      if (chosen.some((other) => overlaps(other, item))) continue;
      chosen.push(item);
      if (search(index + 1)) return true;
      chosen.pop();
    }
    return false;
  };
  if (search(0)) return { missing: [], empty: [] };
  // 割り当てられないとき、節ごとに理由を示す (見出しが無い・中身が無い・ほかの節と見出しを共有している)
  const missing: string[] = [];
  const empty: string[] = [];
  handoffSections.forEach((section, index) => {
    if (candidates[index].length === 0) missing.push(section.label);
    else if (filled[index].length === 0) empty.push(section.label);
  });
  if (missing.length === 0 && empty.length === 0) missing.push("4 つの節を別々の見出しに (1 つの見出しで 2 つの節を兼ねたり、節を別の節の中に置いたりしない)");
  return { missing, empty };
}

export function checkHandoff(taskDir: string, path: string | undefined, label = "引継資料"): void {
  const text = readDocument(taskDir, path, label, "WF_HANDOFF");
  const lines = splitLines(text);
  const { missing, empty } = assignSections(lines);
  if (missing.length > 0 || empty.length > 0) {
    const problems = [...missing.map((item) => (item.startsWith("4 つ") ? item : `「${item}」の節がありません`)), ...empty.map((item) => `「${item}」の節が空です`)];
    throw new CliError(`${label}の構造が足りません (${path}): ${problems.join("、")}\n必要な節: ${handoffSections.map((section) => section.label).join(" / ")} (それぞれ別の見出しで、空行・HTML コメント以外の中身がある)`, 1, "WF_HANDOFF");
  }
}

// 成果物の参照 (最初の引継資料・判定の記録以外)。資料はタスクの中の通常のファイル (タスクの index.md は除く)、repo は repos/<名前> にあること。
// 資料の実際のパス (リンクをたどった後) を返す
export function checkRef(root: string, taskDir: string, ref: ArtifactRef): string | undefined {
  let real: string | undefined;
  if (ref.path !== undefined) real = taskFile(taskDir, ref.path);
  if (ref.commit !== undefined || ref.repo !== undefined) {
    if (ref.repo === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ref.repo)) throw refError(`commit にはどの repo か (repos/<名前>) が必要です: ${JSON.stringify(ref)}`);
    if (ref.commit === undefined || !/^[0-9a-f]{7,40}$/.test(ref.commit)) throw refError(`repo ${ref.repo} には 7〜40 桁の小文字 16 進数の commit が必要です: ${JSON.stringify(ref)}`);
    if (!isDirectory(join(root, "repos", ref.repo))) throw refError(`repos/${ref.repo} が見つかりません (成果物の repo は repos/ 配下の名前です)`);
  }
  return real;
}

// 成果物の資料は Markdown 以外 (画像・ログ) でもよいが、タスクの中の通常のファイルで、タスクの index.md (管理ファイル) ではないこと
function taskFile(taskDir: string, path: string): string {
  if (!isSafeRelativePath(path)) throw refError(`成果物のパスはタスクのディレクトリからの相対パスです (. や .. は使わない): ${path}`);
  let real: string;
  try {
    real = realpathSync(join(taskDir, path));
  } catch {
    throw refError(`成果物が見つかりません: ${path}`);
  }
  const base = realpathSync(taskDir);
  const inside = relative(base, real);
  if (inside === "" || inside.startsWith("..") || inside.startsWith(sep)) throw refError(`成果物がタスクのディレクトリの外を指しています: ${path}`);
  if (!lstatSync(real).isFile()) throw refError(`成果物は通常のファイルです (ディレクトリは指せない): ${path}`);
  if (inside === "index.md") throw refError(`タスクの index.md (管理ファイル) は成果物として参照できません: ${path}`);
  return real;
}

function checkOperation(root: string, taskDir: string, task: TaskV3, operation: Operation): void {
  switch (operation.kind) {
    case "complete": {
      checkHandoff(taskDir, operation.refs[0]?.path);
      const handoffPath = realpathSync(join(taskDir, operation.refs[0].path!));
      // 実装の対象として数えるのは、repo+commit か、引継資料そのものではない通常のファイル
      const targets = operation.refs.slice(1).filter((ref) => {
        const real = checkRef(root, taskDir, ref);
        return ref.commit !== undefined || (real !== undefined && real !== handoffPath);
      });
      if (task.type === "implementation" && task.phase === "execute" && targets.length === 0) {
        throw new CliError("実装 (implementation) の実行を完了するには、引継資料のほかに対象の参照 (repo と commit、または引継資料以外のタスクの中のファイル) が必要です", 1, "WF_TARGET");
      }
      break;
    }
    case "decide": {
      readDocument(taskDir, operation.refs[0]?.path, task.phase === "acceptance" ? "受入確認の記録" : "レビューの記録", "WF_REPORT");
      for (const ref of operation.refs.slice(1)) checkRef(root, taskDir, ref);
      break;
    }
    case "assign":
      if (operation.handoff) checkHandoff(taskDir, operation.handoff.path);
      break;
    default:
      break;
  }
}

function formatError(kind: string, source: string): CliError {
  if (kind === "legacy") return new CliError(`旧形式のタスクは工程の操作では変更できません。workflowVersion 3 へ移行してから使ってください (移行までは task move を使う): ${source}`, 1, "WF_NOT_V3");
  if (kind === "v2") return new CliError(`workflowVersion 2 のタスクは工程の操作では変更できません。workflowVersion 3 へ移行してから使ってください: ${source}`, 1, "WF_NOT_V3");
  return new CliError(`対応していない workflowVersion のタスクです: ${source}`, 1, "WF_VERSION");
}

// 操作を 1 件反映する。失敗したら index.md と作業索引は変わらない
export function runTransition(root: string, jobName: string, selector: string, ifMatch: string | undefined, operation: Operation, options: TaskflowOptions = {}): TransitionResult {
  if (ifMatch === undefined) throw new CliError("工程型タスクを変更するには --if-match に revision (task show の revision) を指定してください", 2, "REVISION_REQUIRED");
  const expected = parseIfMatch(ifMatch)!;
  const job = Job.existing(root, jobName);
  const clock = options.clock ?? now();
  // 再開では待っている QA の案件もロックする。ロックの中で待ちが変わっていたら取り直す
  for (let attempt = 0; attempt < 3; attempt++) {
    let planned: string[] = [];
    if (operation.kind === "resume") {
      try {
        const data = YamlFrontmatter.parse(findTask(job, selector).read()).data();
        if (Array.isArray(data.blockedBy)) planned = qaJobs(job.name, data.blockedBy.filter((value): value is string => typeof value === "string"));
      } catch {
        // 見つからない・読めない場合はロックの中で同じ確認をして報告する
      }
    }
    const locked = new Set([job.name, ...planned.filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))]);
    // 案件の書き込みのロック: ロックの中で、この案件の残った journal を先に復旧する (契約 7、R21-2。lib/journal.ts)
    const result = withJobWriteLocks(root, [...locked], [job.name], () => applyLocked({ root, job, selector, expected, operation, options, clock, locked }));
    if (result) return result;
  }
  throw new CliError("待っているQAの参照が変わり続けたため中止しました。再度実行してください", 1, "DEPENDENCY_CHANGED");
}

interface LockedContext {
  root: string;
  job: Job;
  selector: string;
  expected: string;
  operation: Operation;
  options: TaskflowOptions;
  clock: Clock;
  locked: Set<string>;
}

// ロックの中の処理。待っている QA の案件が変わっていたら undefined (ロックを取り直す)
function applyLocked({ root, job, selector, expected, operation, options, clock, locked }: LockedContext): TransitionResult | undefined {
  const item = findTask(job, selector);
  const source = job.display(item.index);
  const bytes = readFileSync(item.index);
  assertRevision(expected, bytes, source);
  let read: ReturnType<typeof readTaskFile>;
  try {
    read = readTaskFile(bytes.toString("utf8"), source);
  } catch (error) {
    if (error instanceof FrontmatterError) throw new CliError(error.message, 1, "WF_READ");
    throw error;
  }
  if (read.format.kind !== "v3") throw formatError(read.format.kind, source);
  if (read.issues.length > 0) {
    throw new CliError(`タスクの記録に不整合があるため変更しません (${source}):\n${read.issues.map((issue) => `  ${issue.code} ${issue.path}: ${issue.message}`).join("\n")}`, 1, "WF_INVALID");
  }
  const task = read.frontmatter.data() as TaskV3;
  if (operation.kind === "resume") {
    if (!qaJobs(job.name, task.blockedBy).every((name) => locked.has(name))) return undefined; // 待ちが変わった
    assertQaResolved(root, job, task.blockedBy);
  }
  // 準備 (QA の作成など) は、ここから後で失敗したら戻す
  const prepared = options.prepare?.({ job, item, task });
  try {
    const op = prepared?.operation ?? operation;
    checkOperation(root, item.dir, task, op);
    let next: TaskV3;
    try {
      next = transition(task, op, clock);
    } catch (error) {
      if (error instanceof TransitionError) throw new CliError(error.message, 1, error.code);
      throw error;
    }
    const frontmatter = read.frontmatter;
    try {
      patch(frontmatter, task, next, []);
    } catch (error) {
      if (error instanceof YamlEditError) throw new CliError(`frontmatter を書き換えられないため変更しません (${source}): ${error.message}`, 1, "WF_WRITE");
      throw error;
    }
    const text = frontmatter.toString();
    const check = readTaskFile(text, source);
    if (check.issues.length > 0 || !same(check.frontmatter.data(), next)) {
      throw new CliError(`書き換えた結果が遷移の結果と一致しないため変更しません (内部の誤り): ${source}`, 1, "WF_INTERNAL");
    }
    commitWithIndex(item.index, text, item.name, job.dir, expectedLink(job.dir, item.name, next), options.indexFs);
    return { item, task: next, revision: revisionOf(Buffer.from(text)), appended: next.history.slice(task.history.length) };
  } catch (error) {
    prepared?.undo();
    throw error;
  }
}

// index.md の revision (task show と同じ値)。試験と T-014 の show で使う
export function taskRevision(path: string): string {
  return revisionOf(readFileSync(path));
}
