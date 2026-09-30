// workflowVersion 4 の遷移を、タスク・判断記録・索引へ一体で反映するサービス。T-021 (CLI への接続は T-022)
// 契約: jobs/project_template/tasks/workflow-v4-contract/03-contract.md の 4 (照合 1〜5)・7 (一体更新・journal・孤立した記録の復旧・同時操作・索引)
//
// 1 回の操作は次の順で行う:
//   1. revision を必須にする。タスクは --if-match、判断記録の操作 (claim・assign・approve・reject) は加えて --record-match
//      (判断記録のファイルのバイト列の SHA-256)。無ければ REVISION_REQUIRED / RECORD_MATCH_REQUIRED
//   2. 案件のロックを取る (再開では待っている QA の案件も名前順にロックする)
//   3. ロックの中で、残った journal (jobs/<案件>/.raprid-ops/<操作ID>.json) を調べて復旧する (下の「復旧」。lib/journal.ts。
//      v3・旧形式・QA などほかの書き込みの操作も同じ復旧を jobs.ts の withJobWriteLocks で通る)
//   4. タスクと判断記録を読み直し、revision を照合する (REVISION_CONFLICT)。v4 で、記録に不整合が無いことを確かめる
//   5. 判断記録の操作は、対象が open で、タスクが今待っている記録であることを確かめる (WF_APPROVAL_CLOSED・WF_APPROVAL_STALE)。
//      complete (T5・T7) は、同じ ID の判断記録のファイルが既にあれば作らずに止める (WF_APPROVAL_CONFLICT)
//   6. 引継資料・判断の記録・成果物の参照・待っている QA を確かめ、lib/transitions-v4.ts で遷移を計算する
//   7. 変わった値だけを YamlFrontmatter で書き換え (未知の項目・コメント・本文は残す)、読み直して規則と計算結果に一致することを確かめる
//   8. 判断記録 → 索引 (作業索引と approvals/open/) → タスクの順に置き換える。判断記録を新しく作る操作 (T5・T7) は、
//      書き始める前に journal を書き、終わったら消す。途中で失敗したら、この操作で変えたものを戻す
//
// 索引: 作業索引は open なら status/<工程>/<工程の状態>/<名前>、人の確認待ち (タスクの pending) なら status/approval/<工程>/<名前>、
//       closed なら無し (リンク先は ../../../tasks/<名前>)。確認待ちの索引は open の判断記録ごとに
//       approvals/open/<名前>--<工程>-<試行> (リンク先は ../../tasks/<名前>/decisions/<工程>-<試行>.md)。
//
// 復旧 (03 の 7、R19-3・R19-5、lib/journal.ts): journal の前か後の状態だけを受け入れ、前の状態へ戻す。
//   削除・作り直しの前に、案件のすべての journal の対象のパス種別と親ディレクトリ (リンクを辿らない) を確かめる (R21-1)。
//   各対象を「前」「後」「それ以外」に分け、一つでも「それ以外」があれば何も変えずに WF_APPROVAL_ORPHAN で止める。
//   タスクが「後」なら、判断記録と索引がすべて「後」のときだけ journal を消す (何も戻さない)。
//   タスクが「前」なら、journal の内容のままの判断記録を消し、この操作が作った索引を消し、外した索引を作り直し、journal を消す。
//   消してよいのは「操作の前には無く、journal の後の内容・リンク先と一致するもの」だけ。
//
// 判断記録を閉じる・担当を替える操作 (approve・reject・claim・assign・revise) は journal を書かない (契約の 7 は作る操作だけに定める)。
// 途中の失敗 (例外) は同じ実行の中で戻す。異常終了で途中の状態が残った場合は、checkTaskDecisions が不整合を報告し、
// 以後の操作は WF_INVALID で止まる (人が確かめて直す)。

import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { assertQaResolved, qaJobs } from "./blockers.ts";
import {
  type DecisionFile,
  type DecisionRecord,
  approvalQueueDir,
  approvalQueueLinkPath,
  approvalQueueLinkTarget,
  approvalWorkLinkPath,
  checkTaskDecisions,
  decisionKeys,
  decisionPath,
  decisionsDir,
  expectedQueueLinks,
  expectedWorkLinkV4,
  parseApprovalQueueLinkName,
  parseDecisionId,
  readDecisionFile,
  validateDecision,
} from "./decision.ts";
import { CliError, UsageError } from "./errors.ts";
import { FrontmatterError } from "./frontmatter.ts";
import { isDirectory, localDate, lstatOrUndefined, tempPath } from "./fsutil.ts";
import { assertRevision, parseIfMatch, revisionOf } from "./guard.ts";
import { Item, Job, withJobWriteLocks } from "./jobs.ts";
import { type Journal, type LinkState, type RecoveryFs, assertRealDir, defaultRecoveryFs, journalDir, journalVersion, linkState, removeEmptyDirs, sha256 } from "./journal.ts";
import { checkHandoff, checkRef, findTask, patch, readDocument } from "./taskflow.ts";
import { type Clock, TransitionError } from "./transitions.ts";
import { type OperationV4, isApprovalOperation, transitionV4 } from "./transitions-v4.ts";
import { workIndexPhases, workIndexStatuses, workLinkPath, workLinkTarget } from "./workindex.ts";
import { type HistoryEntryV4, type TaskV4, approvalPhases, readTaskFile } from "./workflow.ts";
import { YamlEditError, YamlFrontmatter } from "./yamlfront.ts";

// journal と復旧は lib/journal.ts に置いた (案件の書き込みの操作すべてが使う)。従来の import 先からも使えるように再輸出する
export { type Journal, journalDir, journalDirName, journalVersion, pendingJournals, recoverJournals } from "./journal.ts";

// ---- ファイル操作 (試験で失敗・異常終了を注入する) ----------------------------------------------------------------

export interface OpsFs extends RecoveryFs {
  writeTemp(path: string, text: string, mode: number): void; // 新しい一時ファイル (既にあれば失敗)
  rename(from: string, to: string): void; // 置き換え
  linkNew(from: string, to: string): void; // 置き場所に何も無いときだけ置く (判断記録の作成。上書きしない)
  writeJournal(path: string, text: string): void;
}

export const defaultOpsFs: OpsFs = {
  ...defaultRecoveryFs,
  writeTemp: (path, text, mode) => writeFileSync(path, text, { flag: "wx", mode }),
  rename: (from, to) => renameSync(from, to),
  linkNew: (from, to) => linkSync(from, to),
  writeJournal: (path, text) => {
    const temp = tempPath(dirname(path), "journal");
    try {
      writeFileSync(temp, text, { flag: "wx", mode: 0o644 });
      renameSync(temp, path);
    } finally {
      rmSync(temp, { force: true });
    }
  },
};

// ---- 索引 --------------------------------------------------------------------------------------------------------

function indexError(message: string): CliError {
  return new CliError(`${message}\n索引を直してから再度実行してください (raprid task list で不整合を確認できる)`, 1, "WF_INDEX");
}

// このタスクの作業索引として置かれているもの (v2・v3 の工程と状態、v4 の status/approval/<工程>/ をすべて探す)
export function currentWorkLinksV4(jobDir: string, name: string): { path: string; state: LinkState }[] {
  const found: { path: string; state: LinkState }[] = [];
  const candidates = [...workIndexPhases.flatMap((phase) => workIndexStatuses.map((status) => workLinkPath(jobDir, phase, status, name))), ...approvalPhases.map((phase) => approvalWorkLinkPath(jobDir, phase, name))];
  for (const path of candidates) {
    const state = linkState(path);
    if (state.kind !== "none") found.push({ path, state });
  }
  return found;
}

// このタスクの確認待ちの索引 (approvals/open/<名前>--<ID>)
export function currentQueueLinks(jobDir: string, name: string): { path: string; id: string; state: LinkState }[] {
  const dir = approvalQueueDir(jobDir);
  if (!isDirectory(dir)) return [];
  return readdirSync(dir)
    .map((entry) => ({ entry, parsed: parseApprovalQueueLinkName(entry) }))
    .filter((item) => item.parsed?.name === name)
    .map((item) => ({ path: join(dir, item.entry), id: item.parsed!.id, state: linkState(join(dir, item.entry)) }));
}

interface LinkChange {
  path: string; // 絶対パス
  before: string | null; // 操作の前のリンク先 (無ければ null)
  after: string | null; // 操作の後のリンク先 (無ければ null)
}

// 操作の前後の索引の差分。今の索引が曖昧 (複数・リンク以外・別のリンク先) なら推測で直さずに止める
function planLinks(jobDir: string, name: string, after: { work: string | null; queue: string[] }, afterIds: Map<string, string>): LinkChange[] {
  const target = workLinkTarget(name);
  const work = currentWorkLinksV4(jobDir, name);
  if (work.length > 1) throw indexError(`作業索引が複数あります: ${work.map((link) => link.path).join(", ")}`);
  const current = work[0];
  if (current && current.state.kind !== "link") throw indexError(`作業索引にリンク以外があります: ${current.path}`);
  if (current && current.state.kind === "link" && current.state.target !== target) throw indexError(`作業索引のリンク先が不正です: ${current.path} -> ${current.state.target}`);
  const changes: LinkChange[] = [];
  if (current?.path !== after.work) {
    if (current) changes.push({ path: current.path, before: target, after: null });
    if (after.work !== null) {
      if (lstatOrUndefined(after.work)) throw indexError(`作業索引の移し先に別のものがあります: ${after.work}`);
      changes.push({ path: after.work, before: null, after: target });
    }
  }
  const queue = currentQueueLinks(jobDir, name);
  for (const link of queue) {
    const expected = approvalQueueLinkTarget(name, link.id);
    if (link.state.kind !== "link" || link.state.target !== expected) throw indexError(`確認待ちの索引が不正です: ${link.path}${link.state.kind === "link" ? ` -> ${link.state.target}` : " (リンク以外)"}`);
  }
  const before = new Set(queue.map((link) => link.path));
  for (const link of queue) if (!after.queue.includes(link.path)) changes.push({ path: link.path, before: approvalQueueLinkTarget(name, link.id), after: null });
  for (const path of after.queue) {
    if (before.has(path)) continue;
    if (lstatOrUndefined(path)) throw indexError(`確認待ちの索引の置き場所に別のものがあります: ${path}`);
    changes.push({ path, before: null, after: approvalQueueLinkTarget(name, afterIds.get(path)!) });
  }
  return changes;
}

// ---- 判断記録の読み書き ----------------------------------------------------------------------------------------------

export interface DecisionFileBytes extends DecisionFile {
  path: string;
  bytes: Buffer | undefined; // 通常のファイルとして読めなければ undefined
}

// decisions/ の記録 (<名前>.md) をすべて読む。読めないもの・名前の不正なものも照合に渡して報告させる
export function readDecisionFiles(taskDir: string): DecisionFileBytes[] {
  const dir = join(taskDir, decisionsDir);
  if (!isDirectory(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".md") && !entry.startsWith("."))
    .sort()
    .map((entry) => {
      const path = join(dir, entry);
      const id = entry.slice(0, -3);
      const stat = lstatOrUndefined(path);
      if (!stat?.isFile()) return { id, path, bytes: undefined, data: undefined };
      const bytes = readFileSync(path);
      try {
        return { id, path, bytes, data: YamlFrontmatter.parse(bytes.toString("utf8"), path).data() };
      } catch {
        return { id, path, bytes, data: undefined };
      }
    });
}

// 判断記録の revision (--record-match に使う。ファイルのバイト列の SHA-256)
export function decisionRevision(path: string): string {
  return revisionOf(readFileSync(path));
}

function newDecisionText(record: DecisionRecord): string {
  const frontmatter = YamlFrontmatter.parse("---\n---\n\n# 判断のメモ\n");
  for (const key of decisionKeys) frontmatter.set([key], record[key]);
  for (const key of Object.keys(record)) if (!(decisionKeys as readonly string[]).includes(key)) frontmatter.set([key], record[key]);
  return frontmatter.toString();
}

// ---- 一体更新 ---------------------------------------------------------------------------------------------------------

interface FileWrite {
  path: string;
  before: Buffer | null; // 操作の前の内容 (新しく作るなら null)
  text: string;
}

// 判断記録 → 索引 → タスクの順に置き換える。失敗 (例外) したら、この実行で変えたものを戻す
function commitV4(input: { jobDir: string; task: FileWrite | null; decisions: FileWrite[]; links: LinkChange[]; journal: Journal | null; fs: OpsFs }): void {
  const { jobDir, fs } = input;
  const journalPath = input.journal ? join(journalDir(jobDir), `${input.journal.id}.json`) : undefined;
  const temps: string[] = [];
  const createdDirs: string[] = [];
  const done: { decisions: FileWrite[]; links: ({ path: string; removed: string } | { path: string; created: string })[] } = { decisions: [], links: [] };
  let journalWritten = false;
  let committed = false;
  const mkdirs = (dir: string) => {
    const created = mkdirSync(dir, { recursive: true });
    if (created) createdDirs.push(created);
  };
  try {
    if (input.journal && journalPath) {
      mkdirs(dirname(journalPath));
      fs.writeJournal(journalPath, `${JSON.stringify(input.journal, null, 2)}\n`);
      journalWritten = true;
    }
    const staged = (write: FileWrite) => {
      mkdirs(dirname(write.path));
      const temp = tempPath(dirname(write.path), "raprid");
      temps.push(temp);
      fs.writeTemp(temp, write.text, write.before !== null ? statSync(write.path).mode & 0o777 : 0o644);
      return temp;
    };
    const decisionTemps = input.decisions.map((write) => ({ write, temp: staged(write) }));
    const taskTemp = input.task ? staged(input.task) : undefined;
    for (const { write, temp } of decisionTemps) {
      if (write.before === null) {
        try {
          fs.linkNew(temp, write.path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new CliError(`同じ ID の判断記録が既にあるので作りません: ${write.path}`, 1, "WF_APPROVAL_CONFLICT");
          throw error;
        }
      } else fs.rename(temp, write.path);
      done.decisions.push(write);
    }
    for (const change of input.links) {
      if (change.before !== null) {
        fs.unlink(change.path);
        done.links.push({ path: change.path, removed: change.before });
      }
      if (change.after !== null) {
        mkdirs(dirname(change.path));
        fs.symlink(change.after, change.path);
        done.links.push({ path: change.path, created: change.after });
      }
    }
    if (input.task && taskTemp) fs.rename(taskTemp, input.task.path);
    committed = true;
  } finally {
    for (const temp of temps) rmSync(temp, { force: true });
    if (!committed) {
      // この実行で変えたものだけを戻す (戻せなかったものは journal と照合・一覧で報告される)
      try {
        for (const step of [...done.links].reverse()) {
          if ("created" in step) rmSync(step.path, { force: true });
          else if (!lstatOrUndefined(step.path)) symlinkSync(step.removed, step.path);
        }
        for (const write of [...done.decisions].reverse()) {
          if (write.before === null) {
            if (lstatOrUndefined(write.path)?.isFile() && sha256(readFileSync(write.path)) === sha256(write.text)) rmSync(write.path);
          } else writeFileSync(write.path, write.before);
        }
        if (journalWritten && journalPath) rmSync(journalPath, { force: true });
        removeEmptyDirs(createdDirs);
      } catch {
        // 戻せなかったときは journal が残り、次の操作の復旧か人の確認に回る
      }
    }
  }
  if (committed && journalWritten && journalPath) {
    try {
      fs.removeJournal(journalPath);
      removeEmptyDirs([dirname(journalPath)]);
    } catch {
      // 書き込みは終わっている。次の操作の復旧が「後」の状態を確かめて journal を消す
    }
  }
}

// ---- 操作 ---------------------------------------------------------------------------------------------------------------

export interface TransitionResultV4Service {
  item: Item;
  task: TaskV4;
  revision: string; // タスクの index.md の revision (次の操作の --if-match)
  decisions: { id: string; record: DecisionRecord; revision: string; path: string; created: boolean }[]; // 作った・変えた判断記録 (revision は --record-match)
  appended: HistoryEntryV4[]; // この操作でタスクの history に追記したもの
  recovered: string[]; // この操作の前に復旧した journal
}

export interface TaskflowV4Options {
  clock?: Clock;
  fs?: OpsFs;
  operationId?: string;
}

export interface MatchV4 {
  ifMatch: string | undefined; // タスクの revision
  recordMatch?: string | undefined; // 判断記録の revision (判断記録の操作で必須)
}

function now(): Clock {
  return { date: localDate(), at: new Date().toISOString() };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function formatErrorV4(kind: string, source: string): CliError {
  if (kind === "legacy" || kind === "v2" || kind === "v3") {
    const label = kind === "legacy" ? "旧形式" : `workflowVersion ${kind.slice(1)}`;
    return new CliError(`${label}のタスクは workflowVersion 4 の操作では変更できません。workflowVersion 4 へ移行してから使ってください: ${source}`, 1, "WF_NOT_V4");
  }
  return new CliError(`対応していない workflowVersion のタスクです: ${source}`, 1, "WF_VERSION");
}

function issuesText(issues: { code: string; path: string; message: string }[]): string {
  return issues.map((issue) => `  ${issue.code} ${issue.path}: ${issue.message}`).join("\n");
}

// 引継資料・判断の記録・成果物の参照を確かめる (v3 の taskflow.ts と同じ規則)
function checkOperationV4(root: string, taskDir: string, task: TaskV4, operation: OperationV4): void {
  switch (operation.kind) {
    case "complete": {
      if (task.phase === "review") readDocument(taskDir, operation.refs[0]?.path, "レビューの記録", "WF_REPORT");
      else checkHandoff(taskDir, operation.refs[0]?.path);
      const first = operation.refs[0]?.path;
      const targets = operation.refs.slice(1).filter((ref) => {
        const real = checkRef(root, taskDir, ref);
        return ref.commit !== undefined || (real !== undefined && ref.path !== first);
      });
      if (task.type === "implementation" && task.phase === "execute" && targets.length === 0) {
        throw new CliError("実装 (implementation) の実行を完了するには、引継資料のほかに対象の参照 (repo と commit、または引継資料以外のタスクの中のファイル) が必要です", 1, "WF_TARGET");
      }
      break;
    }
    case "assign":
      if (operation.handoff) checkHandoff(taskDir, operation.handoff.path);
      break;
    case "approve":
    case "reject":
      for (const ref of operation.reportRefs ?? []) readDocument(taskDir, ref.path, "判断の記録", "WF_REPORT");
      break;
    default:
      break;
  }
}

// 操作を 1 件反映する。失敗したらタスク・判断記録・索引は変わらない
export function runTransitionV4(root: string, jobName: string, selector: string, match: MatchV4, operation: OperationV4, options: TaskflowV4Options = {}): TransitionResultV4Service {
  if (match.ifMatch === undefined) throw new CliError("workflowVersion 4 のタスクを変更するには --if-match に revision (task show の revision) を指定してください", 2, "REVISION_REQUIRED");
  const expected = parseIfMatch(match.ifMatch)!;
  let recordExpected: string | undefined;
  if (isApprovalOperation(operation)) {
    if (match.recordMatch === undefined) throw new CliError("判断記録を操作するには --record-match に判断記録の revision (approval show の recordRevision) を指定してください", 2, "RECORD_MATCH_REQUIRED");
    if (!/^[0-9a-f]{64}$/.test(match.recordMatch)) throw new UsageError(`--record-match には revision (64 桁の小文字 16 進数) を指定してください: ${match.recordMatch}`);
    recordExpected = match.recordMatch;
  }
  const job = Job.existing(root, jobName);
  const clock = options.clock ?? now();
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
    // 案件の書き込みのロック: ロックの中で、この案件の残った journal を先に復旧する (R21-1・R21-2。lib/journal.ts)
    const fs = options.fs ?? defaultOpsFs;
    const result = withJobWriteLocks(root, [...locked], [job.name], (recovered) => applyLockedV4({ root, job, selector, expected, recordExpected, operation, options, clock, locked, recovered }), fs);
    if (result) return result;
  }
  throw new CliError("待っているQAの参照が変わり続けたため中止しました。再度実行してください", 1, "DEPENDENCY_CHANGED");
}

interface LockedContextV4 {
  root: string;
  job: Job;
  selector: string;
  expected: string;
  recordExpected: string | undefined;
  operation: OperationV4;
  options: TaskflowV4Options;
  clock: Clock;
  locked: Set<string>;
  recovered: string[]; // ロックを取った直後に復旧した journal (withJobWriteLocks)
}

function applyLockedV4({ root, job, selector, expected, recordExpected, operation, options, clock, locked, recovered }: LockedContextV4): TransitionResultV4Service | undefined {
  const fs = options.fs ?? defaultOpsFs;
  const item = findTask(job, selector);
  assertRealDir(join(item.dir, decisionsDir), "判断記録の置き場所 (decisions)", job.display(join(item.dir, decisionsDir)));
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
  if (read.format.kind !== "v4") throw formatErrorV4(read.format.kind, source);
  if (read.issues.length > 0) throw new CliError(`タスクの記録に不整合があるため変更しません (${source}):\n${issuesText(read.issues)}`, 1, "WF_INVALID");
  const task = read.frontmatter.data() as TaskV4;

  const files = readDecisionFiles(item.dir);
  const byId = new Map(files.map((file) => [file.id, file]));
  // 判断記録の操作の対象: revision (5) を照合し、対象そのものの不整合を先に報告する
  if (isApprovalOperation(operation)) {
    const target = byId.get(operation.id);
    if (!parseDecisionId(operation.id)) throw new UsageError(`判断記録の ID は <工程>-<試行> (plan-1・review-3 など) です: ${operation.id}`);
    if (!target) throw new CliError(`判断記録が見つかりません: ${job.display(decisionPath(item.dir, operation.id))}`, 1, "APPROVAL_NOT_FOUND");
    if (!target.bytes) throw new CliError(`判断記録を読めません: ${job.display(target.path)}`, 1, "WF_READ");
    assertRevision(recordExpected, target.bytes, job.display(target.path));
    const own = target.data === undefined ? [{ code: "WF_READ", path: "frontmatter", message: "frontmatter を読めません" }] : validateDecision(target.data);
    if (own.length > 0) throw new CliError(`判断記録に不整合があるため変更しません (${job.display(target.path)}):\n${issuesText(own)}`, 1, "WF_INVALID");
    const status = (target.data as DecisionRecord).status;
    if (status !== "open") throw new CliError(`判断記録 ${operation.id} は ${status} です (閉じた記録は操作できない)`, 1, "WF_APPROVAL_CLOSED");
  }
  // complete (T5・T7) で作る記録と同じ ID のファイルがあれば、上の復旧で消せたとき以外は作らない
  if (operation.kind === "complete" && task.status === "open" && task.phase !== null && (approvalPhases as readonly string[]).includes(task.phase)) {
    const id = `${task.phase}-${task.workflow[task.phase].attempt}`;
    if (lstatOrUndefined(decisionPath(item.dir, id))) throw new CliError(`同じ ID の判断記録 ${job.display(decisionPath(item.dir, id))} が既にあるので作りません (既存の記録は上書きしない。人が確かめて片付ける)`, 1, "WF_APPROVAL_CONFLICT");
  }
  const issues = checkTaskDecisions(task, files);
  if (issues.length > 0) {
    // 対象の記録がタスクと合わない (古い版・古い提出・タスクが指していない) なら STALE として拒否する
    if (isApprovalOperation(operation) && issues.some((issue) => issue.path.startsWith(`decisions/${operation.id}.md`) && ["WF_APPROVAL_STALE", "WF_APPROVAL_ORPHAN"].includes(issue.code))) {
      throw new CliError(`判断記録 ${operation.id} はタスクが今待っている記録と合わないので操作できません (${source}):\n${issuesText(issues)}`, 1, "WF_APPROVAL_STALE");
    }
    throw new CliError(`タスクと判断記録が食い違っているため変更しません (${source}):\n${issuesText(issues)}`, 1, "WF_INVALID");
  }
  if (operation.kind === "resume") {
    if (!qaJobs(job.name, task.blockedBy).every((name) => locked.has(name))) return undefined; // 待ちが変わった
    assertQaResolved(root, job, task.blockedBy);
  }
  checkOperationV4(root, item.dir, task, operation);

  const decisions = new Map(files.map((file) => [file.id, file.data as DecisionRecord]));
  let next: ReturnType<typeof transitionV4>;
  try {
    next = transitionV4(task, decisions, operation, clock);
  } catch (error) {
    if (error instanceof TransitionError) throw new CliError(error.message, 1, error.code);
    throw error;
  }

  // 書き換える内容を作り、読み直して計算結果と一致することを確かめる
  let taskWrite: FileWrite | null = null;
  let taskText = bytes.toString("utf8");
  if (next.taskChanged) {
    try {
      patch(read.frontmatter, task, next.task, []);
    } catch (error) {
      if (error instanceof YamlEditError) throw new CliError(`frontmatter を書き換えられないため変更しません (${source}): ${error.message}`, 1, "WF_WRITE");
      throw error;
    }
    taskText = read.frontmatter.toString();
    const check = readTaskFile(taskText, source);
    if (check.issues.length > 0 || !same(check.frontmatter.data(), next.task)) throw new CliError(`書き換えた結果が遷移の結果と一致しないため変更しません (内部の誤り): ${source}`, 1, "WF_INTERNAL");
    taskWrite = { path: item.index, before: bytes, text: taskText };
  }
  const decisionWrites: (FileWrite & { id: string; created: boolean; record: DecisionRecord })[] = [];
  for (const change of next.decisions) {
    const path = decisionPath(item.dir, change.id);
    const existing = byId.get(change.id);
    let text: string;
    if (change.created) text = newDecisionText(change.record);
    else {
      const frontmatter = YamlFrontmatter.parse(existing!.bytes!.toString("utf8"), job.display(path));
      try {
        patch(frontmatter, existing!.data, change.record, []);
      } catch (error) {
        if (error instanceof YamlEditError) throw new CliError(`判断記録の frontmatter を書き換えられないため変更しません (${job.display(path)}): ${error.message}`, 1, "WF_WRITE");
        throw error;
      }
      text = frontmatter.toString();
    }
    const check = readDecisionFile(text, job.display(path));
    if (check.issues.length > 0 || !same(check.frontmatter.data(), change.record)) throw new CliError(`書き換えた判断記録が遷移の結果と一致しないため変更しません (内部の誤り): ${job.display(path)}`, 1, "WF_INTERNAL");
    decisionWrites.push({ path, before: change.created ? null : existing!.bytes!, text, id: change.id, created: change.created, record: change.record });
  }

  // 操作の後の索引
  const allAfter = new Map(files.map((file) => [file.id, file.data as DecisionRecord]));
  for (const change of next.decisions) allAfter.set(change.id, change.record);
  const openIds = [...allAfter.values()].filter((record) => record.status === "open").map((record) => record.id);
  const queueAfter = expectedQueueLinks(job.dir, item.name, [...allAfter.values()]);
  const ids = new Map(openIds.map((id) => [approvalQueueLinkPath(job.dir, item.name, id), id]));
  const links = planLinks(job.dir, item.name, { work: expectedWorkLinkV4(job.dir, item.name, next.task), queue: queueAfter }, ids);

  const creates = decisionWrites.filter((write) => write.created);
  const journal: Journal | null =
    creates.length > 0
      ? {
          version: journalVersion,
          id: options.operationId ?? randomUUID(),
          operation: operation.kind,
          createdAt: clock.at,
          task: { path: relative(job.dir, item.index), before: sha256(bytes), after: sha256(taskText) },
          decisions: creates.map((write) => ({ path: relative(job.dir, write.path), after: sha256(write.text) })),
          links: links.map((change) => ({ path: relative(job.dir, change.path), before: change.before, after: change.after })),
        }
      : null;
  commitV4({ jobDir: job.dir, task: taskWrite, decisions: decisionWrites, links, journal, fs });
  return {
    item,
    task: next.task,
    revision: sha256(taskText),
    decisions: decisionWrites.map((write) => ({ id: write.id, record: write.record, revision: sha256(write.text), path: write.path, created: write.created })),
    appended: next.task.history.slice(task.history.length),
    recovered,
  };
}
