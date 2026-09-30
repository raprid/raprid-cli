// 案件の書き込みの操作の journal (jobs/<案件>/.raprid-ops/<操作ID>.json) と、残った journal の復旧。T-021
// 契約: jobs/project_template/tasks/workflow-v4-contract/03-contract.md の 7 (操作の記録・孤立した記録の復旧、R19-3・R19-5)
//
// journal を書くのは判断記録を新しく作る v4 の操作 (T5・T7、lib/taskflow-v4.ts) だけ。復旧は「次にその案件の書き込みの操作を
// するとき、ロックの中で」行うので、v4 に限らず案件を書き換える操作 (v3 の工程の操作・旧形式の task・QA・移行) はすべて
// jobs.ts の withJobWriteLocks / Job.writeLock を通し、書き込む前にここで復旧する (R21-2)。読み取りの操作は復旧しない。
//
// 復旧は journal の前か後の状態だけを受け入れ、前の状態へ戻す。削除・作り直しを始める前に、案件のすべての journal について
//   1. journal の置き場所 (.raprid-ops) と journal そのものが、リンクではない実際のディレクトリ・ファイルであること
//   2. journal の形 (同じタスクの index.md・decisions/<ID>.md・作業索引・確認待ちの索引と、その正しいリンク先だけを指す)
//   3. 対象 (タスク・判断記録・索引) のパスの親ディレクトリが、リンク・ファイルではない実際のディレクトリか、まだ無いこと (R21-1)
//   4. 対象が journal の前か後の状態であること (末端の種別を含む。判断記録・タスクは通常のファイル、索引は無いかリンク)
//   5. 複数の journal が同じ対象を指していないこと (どちらの前後か決められない)
// を確かめる。一つでも合わなければ、どの journal の対象も変えずに WF_APPROVAL_ORPHAN (置き場所そのものの不正は WF_INVALID) で止める。

import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { approvalQueueLinkTarget, parseApprovalQueueLinkName, parseDecisionId } from "./decision.ts";
import { CliError } from "./errors.ts";
import { isDirectory, lstatOrUndefined } from "./fsutil.ts";
import { revisionOf } from "./guard.ts";
import { workLinkTarget } from "./workindex.ts";
import { isSafeRelativePath } from "./workflow.ts";

export const journalDirName = ".raprid-ops";
export const journalVersion = 1;

export interface Journal {
  version: number;
  id: string;
  operation: string;
  createdAt: string;
  task: { path: string; before: string; after: string }; // 案件のディレクトリからの相対パスと、前後の内容の SHA-256
  decisions: { path: string; after: string }[]; // 作る判断記録 (操作の前は無い) と、書く内容の SHA-256
  links: { path: string; before: string | null; after: string | null }[]; // 触る索引ごとの前後のリンク先
}

// 復旧で使うファイル操作 (試験で失敗・異常終了を注入する。lib/taskflow-v4.ts の OpsFs はこれを含む)
export interface RecoveryFs {
  symlink(target: string, path: string): void;
  unlink(path: string): void;
  removeJournal(path: string): void;
}

export const defaultRecoveryFs: RecoveryFs = {
  symlink: (target, path) => symlinkSync(target, path),
  unlink: (path) => rmSync(path),
  removeJournal: (path) => rmSync(path, { force: true }),
};

export const sha256 = (bytes: Buffer | string) => revisionOf(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));

// リンクの今の状態: 無い・リンク (リンク先)・リンク以外
export type LinkState = { kind: "none" } | { kind: "link"; target: string } | { kind: "other" };

export function linkState(path: string): LinkState {
  const stat = lstatOrUndefined(path);
  if (!stat) return { kind: "none" };
  if (!stat.isSymbolicLink()) return { kind: "other" };
  return { kind: "link", target: readlinkSync(path) };
}

export function journalDir(jobDir: string): string {
  return join(jobDir, journalDirName);
}

// 残っている journal (異常終了した操作の記録)。一覧・診断 (T-022) でも使う。置き場所がリンクなら辿らない (空とみなす)
export function pendingJournals(jobDir: string): string[] {
  const dir = journalDir(jobDir);
  if (!isDirectory(dir)) return [];
  return readdirSync(dir).filter((entry) => entry.endsWith(".json") && !entry.startsWith(".")).sort().map((entry) => join(dir, entry));
}

// 書き込む先の置き場所 (journal・判断記録) は実際のディレクトリであること。リンクで外を指していたら、推測で辿らずに止める
export function assertRealDir(path: string, label: string, display: string): void {
  const stat = lstatOrUndefined(path);
  if (stat && !stat.isDirectory()) throw new CliError(`${label}がディレクトリではありません (リンクやファイルは辿らない): ${display}`, 1, "WF_INVALID");
}

function orphanError(journal: string, jobDir: string, reason: string): CliError {
  return new CliError(
    `途中で止まった操作の記録 (${relative(dirname(jobDir), journal)}) と今の状態が合わないため、何も変えずに止めました: ${reason}\n判断記録・索引・タスクを人が確かめて片付けてから journal を消してください`,
    1,
    "WF_APPROVAL_ORPHAN",
  );
}

// ---- journal の形 ------------------------------------------------------------------------------------------------------

type Target = { kind: "task"; name: string } | { kind: "decision"; name: string; id: string } | { kind: "work"; name: string } | { kind: "queue"; name: string; id: string };

// journal が指してよいパス (案件のディレクトリからの相対パス) の種類。それ以外は null
function targetOf(path: unknown): Target | null {
  if (typeof path !== "string" || !isSafeRelativePath(path)) return null;
  let match = /^tasks\/([a-z0-9][a-z0-9-]*)\/index\.md$/.exec(path);
  if (match) return { kind: "task", name: match[1] };
  match = /^tasks\/([a-z0-9][a-z0-9-]*)\/decisions\/([^/]+)\.md$/.exec(path);
  if (match && parseDecisionId(match[2])) return { kind: "decision", name: match[1], id: match[2] };
  match = /^status\/[^/]+\/[^/]+\/([a-z0-9][a-z0-9-]*)$/.exec(path);
  if (match) return { kind: "work", name: match[1] };
  match = /^approvals\/open\/([^/]+)$/.exec(path);
  const queue = match ? parseApprovalQueueLinkName(match[1]) : null;
  if (queue) return { kind: "queue", name: queue.name, id: queue.id };
  return null;
}

// 索引のリンク先として正しいもの (作業索引はタスク、確認待ちの索引は同じ ID の判断記録)
function linkTargetOk(target: Target, value: unknown): boolean {
  if (value === null) return true;
  if (target.kind === "work") return value === workLinkTarget(target.name);
  if (target.kind === "queue") return value === approvalQueueLinkTarget(target.name, target.id);
  return false;
}

// journal を読み、形を確かめる。止めるべきなら理由の文字列
function parseJournal(file: string): Journal | string {
  const stat = lstatSync(file);
  if (!stat.isFile()) return "journal が通常のファイルではありません (リンクやディレクトリは辿らない)";
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return "journal を読めません";
  }
  const journal = data as Journal;
  if (data === null || typeof data !== "object" || journal.version !== journalVersion || typeof journal.task !== "object" || journal.task === null) return "journal の形が不正です";
  const task = targetOf(journal.task.path);
  if (task?.kind !== "task" || typeof journal.task.before !== "string" || typeof journal.task.after !== "string") return "journal の形が不正です";
  if (!Array.isArray(journal.decisions) || !Array.isArray(journal.links)) return "journal の形が不正です";
  for (const item of journal.decisions) {
    const target = targetOf(item?.path);
    if (target?.kind !== "decision" || typeof item.after !== "string") return "journal の形が不正です";
    if (target.name !== task.name) return `journal の判断記録 ${item.path} が journal のタスクのものではありません`;
  }
  for (const item of journal.links) {
    const target = targetOf(item?.path);
    if ((target?.kind !== "work" && target?.kind !== "queue") || (item.before !== null && typeof item.before !== "string") || (item.after !== null && typeof item.after !== "string")) return "journal の形が不正です";
    if (target.name !== task.name) return `journal の索引 ${item.path} が journal のタスクのものではありません`;
    if (!linkTargetOk(target, item.before) || !linkTargetOk(target, item.after)) return `journal の索引 ${item.path} のリンク先が索引の規則と合いません`;
  }
  const paths = [journal.task.path, ...journal.decisions.map((item) => item.path), ...journal.links.map((item) => item.path)];
  if (new Set(paths).size !== paths.length) return "journal が同じ対象を 2 回指しています";
  return journal;
}

// 親ディレクトリ (案件のディレクトリから末端の手前まで) のうち、リンク・ファイルなど実際のディレクトリではないもの。
// 途中が無ければ、その下も無いので問題ない (復旧で作り直すときは実際のディレクトリを作る)
function unsafeParent(jobDir: string, rel: string): string | undefined {
  let current = jobDir;
  for (const part of rel.split("/").slice(0, -1)) {
    current = join(current, part);
    const stat = lstatOrUndefined(current);
    if (!stat) return undefined;
    if (!stat.isDirectory()) return relative(jobDir, current);
  }
  return undefined;
}

// ---- 復旧 --------------------------------------------------------------------------------------------------------------

type RecoveryPlan = { journal: string; removeDecisions: string[]; removeLinks: string[]; restoreLinks: { path: string; target: string }[] };

// journal 1 件の復旧の計画。止めるべきなら理由の文字列。この関数は何も変えない
function planRecovery(jobDir: string, file: string): { plan: RecoveryPlan; paths: string[] } | string {
  const journal = parseJournal(file);
  if (typeof journal === "string") return journal;
  const paths = [journal.task.path, ...journal.decisions.map((item) => item.path), ...journal.links.map((item) => item.path)];
  // 末端を調べる前に、すべての対象の親ディレクトリを確かめる (リンクを辿って外のファイルを読んだり消したりしない)
  for (const path of paths) {
    const parent = unsafeParent(jobDir, path);
    if (parent !== undefined) return `${path} の親 ${parent} が実際のディレクトリではありません (リンクやファイルは辿らない)`;
  }
  const taskPath = join(jobDir, journal.task.path);
  const taskStat = lstatOrUndefined(taskPath);
  const taskHash = taskStat?.isFile() ? sha256(readFileSync(taskPath)) : undefined;
  const taskState = taskHash === undefined ? "other" : taskHash === journal.task.before ? "before" : taskHash === journal.task.after ? "after" : "other";
  if (taskState === "other") return `タスク ${journal.task.path} が journal の前とも後とも違います`;
  const decisions = journal.decisions.map((item) => {
    const path = join(jobDir, item.path);
    const stat = lstatOrUndefined(path);
    if (!stat) return { path, rel: item.path, state: "none" as const };
    if (stat.isFile() && sha256(readFileSync(path)) === item.after) return { path, rel: item.path, state: "after" as const };
    return { path, rel: item.path, state: "other" as const };
  });
  const other = decisions.find((item) => item.state === "other");
  if (other) return `判断記録 ${other.rel} が journal の内容と違います (人の追記・由来の分からない記録は消さない)`;
  const links = journal.links.map((item) => {
    const path = join(jobDir, item.path);
    const state = linkState(path);
    const now = state.kind === "none" ? null : state.kind === "link" ? state.target : undefined;
    const kind = now === undefined ? "other" : now === item.before ? "before" : now === item.after ? "after" : "other";
    return { path, rel: item.path, before: item.before, after: item.after, kind };
  });
  const bad = links.find((item) => item.kind === "other");
  if (bad) return `索引 ${bad.rel} が journal の前とも後とも違います`;
  if (taskState === "after") {
    // 操作は最後まで書けていて、journal を消す前に止まった。すべて「後」なら journal だけを消す
    const notAfter = [...decisions.filter((item) => item.state !== "after").map((item) => item.rel), ...links.filter((item) => item.before !== item.after && item.kind !== "after").map((item) => item.rel)];
    if (notAfter.length > 0) return `タスクは書き込み後なのに、判断記録・索引が後の状態ではありません: ${notAfter.join(", ")}`;
    return { plan: { journal: file, removeDecisions: [], removeLinks: [], restoreLinks: [] }, paths };
  }
  // タスクが「前」: 前の状態へ戻す。「前」のままの索引は残し (操作の前からある正しい索引)、
  // 「後」の索引は、前が無ければ消し (この操作が作った)、前にリンクがあれば前のリンク先で作り直す (この操作が外した)
  const changed = links.filter((item) => item.before !== item.after && item.kind === "after");
  return {
    plan: {
      journal: file,
      removeDecisions: decisions.filter((item) => item.state === "after").map((item) => item.path),
      removeLinks: changed.filter((item) => item.before === null).map((item) => item.path),
      restoreLinks: changed.filter((item) => item.before !== null).map((item) => ({ path: item.path, target: item.before! })),
    },
    paths,
  };
}

// この実行で作ったディレクトリを、中が空 (空のディレクトリだけ) なら下から消す。ファイル・リンクがあれば残す
function removeEmptyTree(dir: string): boolean {
  let empty = true;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) empty = removeEmptyTree(join(dir, entry.name)) && empty;
    else empty = false;
  }
  if (empty) rmdirSync(dir);
  return empty;
}

export function removeEmptyDirs(dirs: string[]): void {
  for (const dir of [...dirs].reverse()) {
    try {
      if (isDirectory(dir)) removeEmptyTree(dir);
    } catch {
      // 消せなければ残す (空のディレクトリは状態に影響しない)
    }
  }
}

// 書き込む案件 (複数可) の残った journal をすべて調べ、どれか一つでも止めるべきなら何も変えずに止める。
// すべて受け入れられるなら前の状態へ戻す。案件のロックの中で呼ぶ (ロックは取らない)。復旧した journal のパスを返す
export function recoverJournals(jobDirs: string | string[], fs: RecoveryFs = defaultRecoveryFs): string[] {
  const dirs = typeof jobDirs === "string" ? [jobDirs] : jobDirs;
  const plans: { jobDir: string; plan: RecoveryPlan }[] = [];
  for (const jobDir of dirs) {
    assertRealDir(journalDir(jobDir), "操作の記録の置き場所 (.raprid-ops)", relative(dirname(dirname(jobDir)), journalDir(jobDir)));
    const seen = new Map<string, string>();
    for (const file of pendingJournals(jobDir)) {
      const result = planRecovery(jobDir, file);
      if (typeof result === "string") throw orphanError(file, jobDir, result);
      for (const path of result.paths) {
        const other = seen.get(path);
        if (other !== undefined) throw orphanError(file, jobDir, `${path} を別の journal (${relative(dirname(jobDir), other)}) も指しています (どちらの前後か決められない)`);
        seen.set(path, file);
      }
      plans.push({ jobDir, plan: result.plan });
    }
  }
  // ここから先は、すべての journal を確かめた後にだけ変える
  for (const { plan } of plans) {
    for (const path of plan.removeDecisions) fs.unlink(path);
    for (const path of plan.removeLinks) fs.unlink(path);
    for (const link of plan.restoreLinks) {
      if (lstatOrUndefined(link.path)) fs.unlink(link.path);
      mkdirSync(dirname(link.path), { recursive: true });
      fs.symlink(link.target, link.path);
    }
    fs.removeJournal(plan.journal);
  }
  for (const jobDir of new Set(plans.map((item) => item.jobDir))) removeEmptyDirs([journalDir(jobDir)]);
  return plans.map((item) => item.plan.journal);
}
