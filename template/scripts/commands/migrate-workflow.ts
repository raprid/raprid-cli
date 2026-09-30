// 旧形式 (status: todo/progress/pending/done) と workflowVersion 2 のタスクを workflowVersion 3 へ移す。T-016
//
//   raprid job migrate-workflow --map <対応表> [--dry-run]              変換計画を表示するだけ (既定)
//   raprid job migrate-workflow --map <対応表> --apply --plan <hash>    表示した計画と一致するときだけ実行する
//   raprid job migrate-workflow --restore <移行ID>                       移行前の index.md と索引に戻す
//
// 自動推測で種別・工程・担当・完了を作らない (T-011「既存タスクの移行」・T-017「互換性・移行」)。
//   * すべての対象に種別 (type) の指定が必要。旧形式の未完了には今の工程、progress・pending には担当も必要。
//     足りないものが 1 つでもあれば、すべてを示して何も変えない
//   * 旧 done は closed (closureReason: legacy_done) にし、全工程を legacy_import (証跡未確認) にする。人が承認したとは記録しない
//   * 旧形式の未完了は open にし、指定した工程より前を legacy_import、指定した工程を ready・progress・pending にする
//   * v2 は工程の参照 (phase・workflow.implement・history[].phase) を意味で execute に変え、ほかの値は保つ
//   * 変換した frontmatter は v3 の検証器で検証する。本文 (frontmatter の後ろ) は 1 文字も変えない
// 実行時は変える index.md を .raprid-migrate/<移行ID>/backup/ に退避し、索引の前後を journal.json に記録する。
// 途中で失敗したらこの実行で変えたものだけを戻す。移行後の再実行は何も変えない。

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { actor as actorOption } from "../lib/actor.ts";
import { parse } from "../lib/args.ts";
import { CliError, UsageError } from "../lib/errors.ts";
import { exists, isDirectory, isFile, localDate, lstatOrUndefined, tempPath } from "../lib/fsutil.ts";
import { Job, withJobWriteLocks } from "../lib/jobs.ts";
import { withLock } from "../lib/lock.ts";
import { projectRoot } from "../lib/root.ts";
import { hasWorkflowVersion } from "../lib/taskformat.ts";
import { currentLinks, defaultIndexFs, expectedLink, type IndexFs, workIndexPhases, workLinkTarget } from "../lib/workindex.ts";
import { actorPattern, type HistoryEntryV3, type PhaseRecord, type PhaseV3, phasesV3, readTaskFile, type TaskType, taskTypes } from "../lib/workflow.ts";
import { YamlFrontmatter } from "../lib/yamlfront.ts";

export const usage = `使い方:
  raprid job migrate-workflow --map <対応表.json> [--actor <actor>] [--dry-run]   変換計画を表示する (既定。何も変更しない)
  raprid job migrate-workflow --map <対応表.json> [--actor <actor>] --apply --plan <hash>
                                                    表示した計画と一致するときだけ実行する
  raprid job migrate-workflow --restore <移行ID>     .raprid-migrate/<移行ID>/ の退避から移行前の状態に戻す

旧形式 (status: todo/progress/pending/done) と workflowVersion 2 のタスクを workflowVersion 3 へ移す。
対応表 (JSON):
  {
    "type": "research | implementation",        すべてのタスクの種別 (任意。個別の指定が優先)
    "tasks": {
      "<案件名>/<ID か名前>": { "type": "…", "phase": "plan | execute | review | acceptance", "assignee": "<actor>" }
    }
  }
  * すべての対象に種別が必要 (推測しない)。旧形式の todo・progress・pending には今の工程 (phase)、
    progress・pending には担当 (assignee) が必要。todo の担当は任意 (無ければ未割当)
  * 旧形式の done は closed (legacy_done) にし、全工程を legacy_import (証跡未確認) にする。人が承認したとは記録しない
  * v2 は工程 implement を execute に意味で変える (phase・workflow・history)。v2 と done には工程・担当を指定しない
  * 移行済み (workflowVersion 3) のタスクは変えない (対応表にあっても無視する)
--actor は移行を行う人 (履歴の actor)。省略時は RAPRID_ACTOR。
移行した後は、旧形式の task add (--type なし) を拒否する (jobs/.raprid-workflow を置く)。
移行前の状態は .raprid-migrate/<移行ID>/ に残る。確認が済んだら削除してよい。`;

export const markerName = ".raprid-workflow";
const markerContent = "workflowVersion: 3\n";
const legacyStatuses = ["todo", "progress", "pending", "done"] as const;
type LegacyStatus = (typeof legacyStatuses)[number];
const legacyKeys = new Set(["id", "status", "createdAt", "updatedAt", "completedAt", "requestedBy", "createdBy", "blockedBy"]);
const v3Keys = new Set(["workflowVersion", "type", "phase", "requirementRevision", "closureReason", "relatedTasks", "workflow", "history"]);
const typeLabels: Record<TaskType, string> = { research: "調査", implementation: "実装" };

// ---------------------------------------------------------------- 対応表

interface MapEntry {
  type?: TaskType;
  phase?: PhaseV3;
  assignee?: string | null;
}

export interface MigrationMap {
  type?: TaskType;
  tasks: Record<string, MapEntry>;
}

function mapError(message: string): CliError {
  return new CliError(`対応表が不正です: ${message}`, 1, "MIGRATE_MAP");
}

// 対応表を読み、書式だけを確かめる (タスクとの突き合わせは計画で行う)
export function parseMap(text: string): MigrationMap {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw mapError(`JSON として読めません (${error instanceof Error ? error.message : String(error)})`);
  }
  const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(data)) throw mapError("最上位は { \"type\": …, \"tasks\": { … } } の形にしてください");
  const unknown = Object.keys(data).filter((key) => key !== "type" && key !== "tasks");
  if (unknown.length > 0) throw mapError(`使えない項目があります: ${unknown.join(", ")} (type・tasks だけ)`);
  const type = (value: unknown, path: string): TaskType | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !(taskTypes as readonly string[]).includes(value)) throw mapError(`${path} は ${taskTypes.join(" / ")} のいずれかです (search・implement などの別名は受け付けない): ${JSON.stringify(value)}`);
    return value as TaskType;
  };
  const map: MigrationMap = { type: type(data.type, "type"), tasks: {} };
  if (data.tasks !== undefined && !isObject(data.tasks)) throw mapError("tasks は { \"<案件名>/<ID か名前>\": { … } } の形にしてください");
  for (const [selector, raw] of Object.entries((data.tasks as Record<string, unknown> | undefined) ?? {})) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(selector)) throw mapError(`tasks のキーは <案件名>/<ID か名前> です: ${JSON.stringify(selector)}`);
    if (!isObject(raw)) throw mapError(`tasks.${selector} は { "type": …, "phase": …, "assignee": … } の形にしてください`);
    const extra = Object.keys(raw).filter((key) => !["type", "phase", "assignee"].includes(key));
    if (extra.length > 0) throw mapError(`tasks.${selector} に使えない項目があります: ${extra.join(", ")} (type・phase・assignee だけ)`);
    const entry: MapEntry = {};
    if (raw.type !== undefined) entry.type = type(raw.type, `tasks.${selector}.type`);
    if (raw.phase !== undefined) {
      if (raw.phase === "implement") throw mapError(`tasks.${selector}.phase の implement は workflowVersion 2 の名前です。v3 の工程は execute です`);
      if (typeof raw.phase !== "string" || !(phasesV3 as readonly string[]).includes(raw.phase)) throw mapError(`tasks.${selector}.phase は ${phasesV3.join(" / ")} のいずれかです: ${JSON.stringify(raw.phase)}`);
      entry.phase = raw.phase as PhaseV3;
    }
    if (raw.assignee !== undefined) {
      if (raw.assignee !== null && (typeof raw.assignee !== "string" || !actorPattern.test(raw.assignee))) throw mapError(`tasks.${selector}.assignee は human/<識別子> か agent/<識別子> です: ${JSON.stringify(raw.assignee)}`);
      entry.assignee = raw.assignee as string | null;
    }
    map.tasks[selector] = entry;
  }
  return map;
}

// ---------------------------------------------------------------- 計画

export interface LinkState {
  path: string; // root からの相対パス
  target: string;
}

export interface TaskChange {
  job: string;
  name: string;
  id: string;
  index: string; // root からの相対パス
  from: string; // 旧形式の状態 (legacy:todo など) か v2
  summary: string;
  original: string;
  content: string;
  mode: number;
  linksBefore: LinkState[];
  linksAfter: LinkState[];
}

export interface Plan {
  root: string;
  actor: string;
  changes: TaskChange[];
  unchanged: number; // 移行済み (v3) のタスク
  jobs: Record<string, string[]>; // 案件ごとのタスクのディレクトリ (移行後に増えていないかを restore で確かめる)
  markerExists: boolean;
  diagnostics: string[];
  warnings: string[];
  hash: string;
}

export interface Clock {
  date: string; // YYYY-MM-DD (updatedAt・閉じた日の代わり)
  at: string; // 履歴の日時 (UTC)
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function now(): Clock {
  return { date: localDate(), at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };
}

// frontmatter の後ろ (本文) を、改行を含めて元のまま取り出す。YamlFrontmatter の toString と同じ区切り方
function splitBody(text: string): { eol: string; body: string } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const close = lines.indexOf("---", 1);
  return { eol, body: lines.slice(close + 1).join(eol) };
}

function frontmatterBlock(text: string): string {
  const lines = text.split(/\r?\n/);
  const close = lines.indexOf("---", 1);
  return lines.slice(1, close < 0 ? lines.length : close).join("\n");
}

// 項目を並べた順に書いた frontmatter と、元の本文
function render(text: string, fields: [string, unknown][]): string {
  const { eol, body } = splitBody(text);
  const frontmatter = YamlFrontmatter.parse(`---${eol}---${eol}${body}`);
  for (const [key, value] of fields) frontmatter.set([key], value);
  return frontmatter.toString();
}

const phaseRecord = (fields: Partial<PhaseRecord>): PhaseRecord => ({
  status: "waiting",
  attempt: 1,
  assignee: null,
  completedBy: null,
  completedAt: null,
  outcome: null,
  inputRevision: null,
  inputSeq: null,
  artifactRefs: [],
  ...fields,
});

// 履歴の項目は通常の操作 (transitions.ts) と同じ順に並べる
const entry = (fields: Partial<HistoryEntryV3> & Pick<HistoryEntryV3, "seq" | "at" | "actor" | "event">): HistoryEntryV3 => ({
  seq: fields.seq,
  at: fields.at,
  actor: fields.actor,
  event: fields.event,
  phase: fields.phase ?? null,
  attempt: fields.attempt ?? null,
  inputRevision: fields.inputRevision ?? null,
  outcome: fields.outcome ?? null,
  from: fields.from ?? null,
  to: fields.to ?? null,
  reason: fields.reason ?? null,
  refersTo: fields.refersTo ?? null,
  refs: fields.refs ?? [],
});

interface LegacyInput {
  status: LegacyStatus;
  data: Record<string, unknown>;
  keys: string[];
  type: TaskType;
  phase?: PhaseV3;
  assignee: string | null;
}

// 旧形式の frontmatter から v3 の項目を作る。規則の確かめは v3 の検証器に任せる (ここでは作るだけ)
function fromLegacy(input: LegacyInput, actor: string, clock: Clock): { fields: [string, unknown][]; notes: string[] } {
  const { status, data } = input;
  const notes: string[] = [];
  const text = (key: string): string | null => (typeof data[key] === "string" && data[key] !== "" ? (data[key] as string) : null);
  const list = (key: string): string[] => (Array.isArray(data[key]) ? (data[key] as unknown[]).map(String) : typeof data[key] === "string" && data[key] !== "" ? [data[key] as string] : []);
  let createdAt = text("createdAt");
  if (createdAt === null) {
    createdAt = clock.date;
    notes.push(`createdAt が無いので移行日 (${clock.date}) にします`);
  }
  const history: HistoryEntryV3[] = [];
  const workflow = {} as Record<PhaseV3, PhaseRecord>;
  const log = (fields: Omit<Parameters<typeof entry>[0], "seq" | "at" | "actor">) => {
    history.push(entry({ seq: history.length + 1, at: clock.at, actor, ...fields }));
    return history.length;
  };
  const imported = (count: number, reason: string) => {
    // 指定した工程より前 (done なら全工程) は、証跡を確かめていない移行の完了にする。完了者・日時・版は空 (捏造しない)
    let previous: number | null = null;
    for (const phase of phasesV3.slice(0, count)) {
      const seq = log({ event: "legacy_import", phase, attempt: 1, outcome: "legacy_import", from: status, to: "done", reason });
      workflow[phase] = phaseRecord({ status: "done", outcome: "legacy_import", inputSeq: previous });
      previous = seq;
    }
    return previous;
  };
  let top: [string, unknown][];
  if (status === "done") {
    let completedAt = text("completedAt");
    const reason = `旧形式 (done) から移行。証跡未確認${completedAt === null ? "。旧 completedAt 不明" : ""}`;
    if (completedAt === null) {
      completedAt = clock.date;
      notes.push(`completedAt が無いので閉じた日を移行日 (${clock.date}) にします`);
    }
    imported(phasesV3.length, reason);
    top = [["status", "closed"], ["phase", null], ["requirementRevision", 1], ["createdAt", createdAt], ["updatedAt", clock.date], ["completedAt", completedAt], ["closureReason", "legacy_done"]];
  } else {
    const phase = input.phase!;
    const position = phasesV3.indexOf(phase);
    const previous = imported(position, `旧形式 (${status}) から移行。${phase} より前の工程は証跡未確認`);
    if (position === 0) log({ event: "create", phase: "plan", attempt: 1, inputRevision: 1, to: "ready", reason: `旧形式 (${status}) から移行` });
    const phaseStatus = status === "todo" ? "ready" : status;
    workflow[phase] = phaseRecord({ status: phaseStatus, assignee: input.assignee, inputRevision: 1, inputSeq: previous });
    // 担当は移行を行う人が割り当てた記録にする (担当本人の引受 claim は作らない)
    if (input.assignee !== null) log({ event: "assign", phase, attempt: 1, inputRevision: 1, from: null, to: input.assignee, reason: `旧形式 (${status}) から移行` });
    for (const later of phasesV3.slice(position + 1)) workflow[later] = phaseRecord({});
    top = [["status", "open"], ["phase", phase], ["requirementRevision", 1], ["createdAt", createdAt], ["updatedAt", clock.date], ["completedAt", null], ["closureReason", null]];
  }
  const ordered: [string, unknown][] = [
    ["id", data.id],
    ["workflowVersion", 3],
    ["type", input.type],
    ...top,
    ["requestedBy", text("requestedBy")],
    ["createdBy", text("createdBy")],
    ["blockedBy", list("blockedBy")],
    ["relatedTasks", []],
    ["workflow", Object.fromEntries(phasesV3.map((phase) => [phase, workflow[phase]]))],
    ["history", history],
  ];
  // 旧形式に無い項目 (test など) は、元の順で後ろに残す
  for (const key of input.keys) if (!legacyKeys.has(key)) ordered.push([key, data[key]]);
  return { fields: ordered, notes };
}

// v2 → v3。工程の参照だけを implement から execute に変え、ほかの値 (seq・inputSeq・attempt・actor・outcome・成果物・日時・理由) は保つ
function fromV2(data: Record<string, unknown>, keys: string[], type: TaskType): [string, unknown][] {
  const rename = (phase: unknown) => (phase === "implement" ? "execute" : phase);
  const fields: [string, unknown][] = [["id", data.id], ["workflowVersion", 3], ["type", type]];
  for (const key of keys) {
    if (key === "id" || key === "workflowVersion" || key === "type") continue;
    let value = data[key];
    if (key === "phase") value = rename(value);
    if (key === "workflow" && value !== null && typeof value === "object" && !Array.isArray(value)) {
      value = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([phase, record]) => [rename(phase), record]));
    }
    if (key === "history" && Array.isArray(value)) {
      value = value.map((item) => (item !== null && typeof item === "object" && !Array.isArray(item) && "phase" in item ? { ...(item as Record<string, unknown>), phase: rename((item as Record<string, unknown>).phase) } : item));
    }
    fields.push([key, value]);
  }
  return fields;
}

function describe(fields: [string, unknown][]): string {
  const get = (key: string) => fields.find(([name]) => name === key)?.[1];
  const type = typeLabels[get("type") as TaskType] ?? String(get("type"));
  if (get("status") === "closed") return `${type} closed (legacy_done)`;
  const phase = get("phase") as string;
  const record = (get("workflow") as Record<string, PhaseRecord> | undefined)?.[phase];
  return `${type} ${phase} ${record?.status ?? "?"} (担当 ${record?.assignee ?? "未割当"})`;
}

export function buildPlan(root: string, map: MigrationMap | undefined, actor: string, clock: Clock = now()): Plan {
  const diagnostics: string[] = [];
  const warnings: string[] = [];
  const changes: TaskChange[] = [];
  const jobs: Record<string, string[]> = {};
  const used = new Set<string>();
  const sources: unknown[] = [];
  let unchanged = 0;
  const rel = (path: string) => relative(root, path);

  for (const job of Job.all(root)) {
    const items = job.items("task");
    jobs[job.name] = items.map((item) => item.name);
    for (const item of items) {
      const label = `${job.name}/${item.name}`;
      if (!isFile(item.index)) {
        diagnostics.push(`${label}: index.md がありません`);
        continue;
      }
      const original = readFileSync(item.index, "utf8");
      const mode = statSync(item.index).mode & 0o777;
      const legacyLinks = (() => {
        try {
          return item.links();
        } catch (error) {
          diagnostics.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
          return undefined;
        }
      })();
      const workLinks = currentLinks(job.dir, item.name);
      sources.push([label, sha256(original), mode, legacyLinks?.map((link) => [rel(link.path), link.target]) ?? null, workLinks.map((link) => [rel(link.path), link.target ?? null])]);
      if (!legacyLinks) continue;

      let data: Record<string, unknown>;
      let keys: string[];
      try {
        const frontmatter = YamlFrontmatter.parse(original, rel(item.index));
        data = frontmatter.data();
        keys = Object.keys(data);
      } catch (error) {
        diagnostics.push(`${label}: frontmatter を読めません (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }
      const id = typeof data.id === "string" ? data.id : "";
      // 対応表の指定 (ID と名前のどちらでも。両方あれば誤り)
      const selectors = [`${job.name}/${item.name}`, ...(id !== "" && id !== item.name ? [`${job.name}/${id}`] : [])].filter((key) => map?.tasks[key] !== undefined);
      selectors.forEach((key) => used.add(key));
      if (selectors.length > 1) diagnostics.push(`${label}: 対応表に同じタスクの指定が 2 つあります (${selectors.join("・")})`);
      const specified = selectors.length > 0 ? map!.tasks[selectors[0]] : undefined;
      const version = hasWorkflowVersion(original) ? data.workflowVersion : undefined;

      if (version === 3) {
        unchanged++;
        continue;
      }
      const type = specified?.type ?? map?.type;
      const problems: string[] = [];
      if (type === undefined) problems.push("種別 (type) の指定がありません (推測しません。対応表の type か tasks の type で指定する)");
      const linkProblems = (links: { path: string; target: string | undefined }[], expected: string) => {
        for (const link of links) {
          if (link.target === undefined) problems.push(`索引にリンク以外があります: ${rel(link.path)}`);
          else if (link.target !== expected) problems.push(`索引のリンク先が別のものです: ${rel(link.path)} -> ${link.target}`);
        }
      };

      let fields: [string, unknown][] | undefined;
      let from: string;
      let notes: string[] = [];
      if (version === undefined) {
        const status = data.status;
        from = `legacy:${String(status)}`;
        if (typeof status !== "string" || !(legacyStatuses as readonly string[]).includes(status)) {
          problems.push(`旧形式の status が todo / progress / pending / done のいずれでもありません: ${JSON.stringify(status ?? null)}`);
        }
        const clash = keys.filter((key) => v3Keys.has(key));
        if (clash.length > 0) problems.push(`旧形式のタスクに workflowVersion 3 の項目があります (上書きしません): ${clash.join(", ")}`);
        if (status === "done") {
          if (specified?.phase !== undefined || specified?.assignee !== undefined) problems.push("done のタスクには工程・担当を指定しません (closed にします)");
        } else if (typeof status === "string") {
          if (specified?.phase === undefined) problems.push(`旧形式の ${status} には今の工程 (phase) の指定が必要です`);
          if ((status === "progress" || status === "pending") && (specified?.assignee === undefined || specified.assignee === null)) problems.push(`旧形式の ${status} には担当 (assignee) の指定が必要です`);
          // 受入確認の担当を決められるのは人だけ (通常の assign と同じ)
          if (specified?.phase === "acceptance" && specified.assignee && !actor.startsWith("human/")) problems.push("受入確認の担当を割り当てる移行は人 (--actor human/…) が行います");
        }
        linkProblems(legacyLinks.map((link) => ({ path: link.path, target: link.target })), job.linkTarget("task", item.name));
        if (legacyLinks.length === 0) warnings.push(`${label}: 旧形式の状態索引がありません (索引の張り替え漏れ。移行で作業索引を張ります)`);
        else if (legacyLinks.some((link) => link.status !== status)) warnings.push(`${label}: 旧形式の状態索引が frontmatter の status (${String(status)}) と違います (frontmatter を正として移行します)`);
        if (workLinks.length > 0) problems.push(`旧形式のタスクに作業索引があります: ${workLinks.map((link) => rel(link.path)).join(", ")}`);
        if (problems.length === 0) {
          ({ fields, notes } = fromLegacy({ status: status as LegacyStatus, data, keys, type: type!, phase: specified?.phase, assignee: specified?.assignee ?? null }, actor, clock));
        }
      } else if (version === 2) {
        from = "v2";
        if (specified?.phase !== undefined || specified?.assignee !== undefined) problems.push("workflowVersion 2 のタスクには工程・担当を指定しません (今の工程と担当を保ちます)");
        const v2Issues = readTaskFile(original, rel(item.index)).issues;
        if (v2Issues.length > 0) problems.push(`workflowVersion 2 として不正です (先に直す): ${v2Issues.map((issue) => `${issue.code} ${issue.path}`).join(", ")}`);
        if (legacyLinks.length > 0) problems.push(`workflowVersion 2 のタスクに旧形式の状態索引があります: ${legacyLinks.map((link) => rel(link.path)).join(", ")}`);
        linkProblems(workLinks, workLinkTarget(item.name));
        if (problems.length === 0) fields = fromV2(data, keys, type!);
      } else {
        from = `workflowVersion ${JSON.stringify(version)}`;
        problems.push(`対応していない、または読めない workflowVersion です: ${JSON.stringify(version)}`);
      }
      if (fields === undefined) {
        diagnostics.push(...problems.map((problem) => `${label}: ${problem}`));
        continue;
      }
      if (/(^|\s)#/m.test(frontmatterBlock(original))) warnings.push(`${label}: frontmatter のコメントは移行後に残りません (本文は変えません)`);
      warnings.push(...notes.map((note) => `${label}: ${note}`));

      const content = render(original, fields);
      const issues = readTaskFile(content, rel(item.index)).issues;
      if (issues.length > 0) {
        diagnostics.push(...issues.map((issue) => `${label}: 移行後の形式が規則に合いません (${issue.code} ${issue.path}: ${issue.message})`));
        continue;
      }
      const converted = readTaskFile(content).frontmatter.data();
      const after = expectedLink(job.dir, item.name, { status: converted.status, phase: converted.phase, workflow: converted.workflow });
      const linksBefore = [...legacyLinks.map((link) => ({ path: rel(link.path), target: link.target })), ...workLinks.map((link) => ({ path: rel(link.path), target: link.target! }))];
      const linksAfter = after === null ? [] : [{ path: rel(after), target: workLinkTarget(item.name) }];
      for (const link of linksAfter) {
        if (lstatOrUndefined(join(root, link.path)) && !linksBefore.some((before) => before.path === link.path)) diagnostics.push(`${label}: 作業索引の置き場所に別のものがあります: ${link.path}`);
      }
      // 書く場所の親にリンク・ファイルがあると、たどった先に書いてしまう (restore と同じ条件)
      for (const dir of new Set([rel(item.index), ...linksBefore.map((link) => link.path), ...linksAfter.map((link) => link.path)].flatMap(ancestors))) {
        const stat = lstatOrUndefined(join(root, dir));
        if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) diagnostics.push(`${label}: ディレクトリ以外 (リンクなど) があるため移しません: ${dir}`);
      }
      changes.push({ job: job.name, name: item.name, id, index: rel(item.index), from, summary: `${from.replace("legacy:", "旧 ")} → ${describe(fields)}`, original, content, mode, linksBefore, linksAfter });
    }
  }
  for (const selector of Object.keys(map?.tasks ?? {})) {
    if (!used.has(selector)) diagnostics.push(`対応表の ${selector} に当たるタスクがありません`);
  }
  const markerExists = exists(join(root, "jobs", markerName));
  // 計画ハッシュは入力 (対応表・actor・各タスクの内容と索引・印の有無) から作る。日時は含めない (dry-run と apply の間で変わるため)
  const hash = sha256(JSON.stringify({ actor, map: map ?? null, sources, markerExists })).slice(0, 16);
  return { root, actor, changes, unchanged, jobs, markerExists, diagnostics, warnings, hash };
}

function printPlan(plan: Plan): void {
  const legacy = plan.changes.filter((change) => change.from.startsWith("legacy:"));
  const done = legacy.filter((change) => change.from === "legacy:done").length;
  console.log(`移行計画 (workflowVersion 3): ${plan.root}`);
  console.log(`  旧形式 ${legacy.length} 件 (done ${done} / 未完了 ${legacy.length - done})・workflowVersion 2 ${plan.changes.length - legacy.length} 件を移す。移行済み ${plan.unchanged} 件は変えない`);
  console.log(`  移行を行う人: ${plan.actor}`);
  for (const change of plan.changes) console.log(`  ${change.job}/${change.id || "?"} ${change.name}: ${change.summary}`);
  if (!plan.markerExists) console.log(`  jobs/${markerName} を置く (旧形式の task add を拒否する)`);
  if (plan.warnings.length > 0) {
    console.log("注意:");
    for (const warning of plan.warnings) console.log(`  - ${warning}`);
  }
  if (plan.diagnostics.length > 0) {
    console.log("移行できないもの (すべて直すまで apply できません):");
    for (const diagnostic of plan.diagnostics) console.log(`  - ${diagnostic}`);
  }
  console.log(`計画ハッシュ: ${plan.hash}`);
}

// ---------------------------------------------------------------- 実行と復元

interface JournalTask {
  index: string;
  original: string; // 移行前の index.md のハッシュ
  staged: string; // 移行後の index.md のハッシュ
  mode: number; // index.md の権限 (移行の前後で同じ。umask に依らず元の権限で書く)
  dirs: DirIdentity[]; // restore が書く場所の親ディレクトリ (移行の前からあるもの) の同一性 (R16-3)
  dirsAfter?: DirIdentity[]; // 移行が完了した時の作業索引の親ディレクトリ (移行が作ったものを含む) の同一性 (R16-5)
  backup: FileIdentity; // 退避のファイルの同一性 (同じ内容で作り直したものを区別する R16-6)
  // index.md と索引の実体を、移行の前・移行した後・restore で戻した後の 3 つの時点で記録する。途中の状態 (started・restoring) でも、
  // 各対象がどの時点のものかを内容と実体で確かめ、同じ内容で作り直したものを区別する (R16-9)。記録の無い実体は止める側に倒す
  before: EntityIds; // apply を始める前
  after?: EntityIds; // apply がこのタスクを書いた直後 (タスクごとに journal へ保存する)
  restored?: { index?: FileIdentity; links: Record<string, FileIdentity>; removed?: string[] }; // restore (と apply の失敗の戻し) が書いた直後・消した索引
  applied?: { placed: Record<string, FileIdentity>; removed: string[] }; // apply が置いた索引の実体・消した索引 (操作ごとに記録する R16-10)
  linksBefore: LinkState[];
  linksAfter: LinkState[];
}

// ディレクトリの同一性。削除して作り直したもの・リンクに置き換えたものを、移行した時のものと区別する
interface DirIdentity {
  path: string; // root からの相対パス
  dev: string;
  ino: string;
}

interface FileIdentity {
  dev: string;
  ino: string;
}

interface EntityIds {
  index: FileIdentity;
  links: Record<string, FileIdentity>; // 索引のパス → 実体
}

interface Journal {
  kind: "workflow-v3";
  id: string;
  // started: apply の途中 (戻しきれなかった)、completed: 移行済み、restoring: restore の途中 (戻しきれなかった)、
  // rolled-back: apply の失敗を戻した、restored: restore が終わった
  state: "started" | "completed" | "restoring" | "rolled-back" | "restored";
  actor: string;
  hash: string;
  marker: { created: boolean };
  jobs: Record<string, string[]>;
  record: DirIdentity[]; // 記録と退避のディレクトリ (.raprid-migrate/・<移行ID>/・backup/ から下) の同一性 (R16-6)
  markerAfter?: FileIdentity; // 移行が置いた印の同一性 (置いた直後に保存する)
  markerBefore?: FileIdentity; // 移行の前からあった印の同一性
  markerRemoved?: boolean; // すべてのタスクを戻した後に、移行が置いた印を消した (R16-11)
  idFile: FileIdentity; // journal.id (journal.json の今の実体を書く、置き換えない小さなファイル) の同一性 (R16-7)
  tasks: JournalTask[];
}

const idPattern = /^wf-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/;

function workDir(root: string, id: string): string {
  return join(root, ".raprid-migrate", id);
}

// journal.json は途中で壊れないよう書くたびに置き換える (rename) ので、実体が保存のたびに変わり、自分の同一性を中に書けない。
// そこで、移行の始めに一度だけ作って以後はその場で書き換える小さなファイル journal.id に「今の journal.json の実体」を書き、
// journal.id 自身の実体は journal.json の中 (idFile) に書く。journal.json・journal.id のどちらか、または両方を
// 同じ内容で作り直すと、どちらかの照合が合わなくなる (R16-6・R16-7)。保存の途中で止まって合わなくなった記録は、戻さずに止める側に倒れる
function saveJournal(root: string, journal: Journal): void {
  const path = join(workDir(root, journal.id), "journal.json");
  const idPath = join(workDir(root, journal.id), "journal.id");
  writeFileSync(`${path}.tmp`, `${JSON.stringify(journal, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
  if (!sameFile(idPath, journal.idFile)) throw new CliError(`移行の記録 (journal.id) が作り直されています: ${idPath}`, 1, "MIGRATE_UNSAFE_PATH");
  const now = fileIdentity(path);
  writeFileSync(idPath, `${now.dev}:${now.ino}\n`); // その場で書き換える (実体は変わらない)
}

// journal.json と journal.id が、移行が書いたときのままの実体か
function journalBlockers(dir: string, journal: Journal): string[] {
  const path = join(dir, "journal.json");
  const idPath = join(dir, "journal.id");
  const current = lstatOrUndefined(path);
  if (!journal.idFile || !sameFile(idPath, journal.idFile) || !current?.isFile() || current.isSymbolicLink()) return [`移行後に作り直された記録: ${relative(dirname(dirname(dir)), path)} (journal.id と合わない)`];
  const now = fileIdentity(path);
  if (readFileSync(idPath, "utf8") !== `${now.dev}:${now.ino}\n`) return [`移行後に作り直された記録: ${relative(dirname(dirname(dir)), path)} (journal.id と合わない)`];
  return [];
}

function fileIdentity(path: string): FileIdentity {
  const stat = lstatSync(path, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameEntry(path: string, identity: FileIdentity): boolean {
  if (!lstatOrUndefined(path)) return false;
  const now = fileIdentity(path);
  return now.dev === identity.dev && now.ino === identity.ino;
}

function sameFile(path: string, identity: FileIdentity): boolean {
  const stat = lstatOrUndefined(path);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) return false;
  const now = fileIdentity(path);
  return now.dev === identity.dev && now.ino === identity.ino;
}

function newId(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `wf-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${randomBytes(2).toString("hex")}`;
}

function linkAt(root: string, path: string): string | undefined | null {
  const stat = lstatOrUndefined(join(root, path));
  if (!stat) return undefined; // 無い
  return stat.isSymbolicLink() ? readlinkSync(join(root, path)) : null; // null はリンク以外
}

function fileHash(root: string, path: string): string | undefined {
  return isFile(join(root, path)) ? sha256(readFileSync(join(root, path))) : undefined;
}

// パスの親ディレクトリ (jobs/ から下) を上から順に返す
function ancestors(rel: string): string[] {
  const parts = rel.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

// ディレクトリとその親 (root から下) に、リンク・ファイルなどディレクトリ以外があれば理由を返す (無いものは対象外)。
// 移行の記録 (.raprid-migrate/)・ロック (jobs/.locks/) をたどって作業ツリーの外に書かないために使う (R16-4)
function unsafeDirs(root: string, dirs: string[]): string[] {
  const found: string[] = [];
  for (const dir of new Set(dirs.flatMap((path) => [...ancestors(`${path}/x`)]))) {
    const stat = lstatOrUndefined(join(root, dir));
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) found.push(dir);
  }
  return found;
}

function assertSafeDirs(root: string, dirs: string[]): void {
  const unsafe = unsafeDirs(root, dirs);
  if (unsafe.length > 0) {
    throw new CliError(["移行の記録・ロックの置き場所にディレクトリ以外 (リンクなど) があるため、何も書かずに中止しました:", ...unsafe.map((dir) => `  ${dir}`)].join("\n"), 1, "MIGRATE_UNSAFE_PATH");
  }
}

function identitiesOf(root: string, dirs: string[]): DirIdentity[] {
  return [...new Set(dirs)]
    .filter((dir) => { const stat = lstatOrUndefined(join(root, dir)); return stat !== undefined && stat.isDirectory() && !stat.isSymbolicLink(); })
    .map((dir) => {
      const stat = lstatSync(join(root, dir), { bigint: true });
      return { path: dir, dev: String(stat.dev), ino: String(stat.ino) };
    });
}

// 記録した同一性と今のディレクトリを比べる
function identityBlockers(root: string, dirs: DirIdentity[]): string[] {
  const blockers: string[] = [];
  for (const dir of dirs) {
    const stat = lstatOrUndefined(join(root, dir.path));
    if (!stat) blockers.push(`移行後に削除されたディレクトリ: ${dir.path}`);
    else if (stat.isDirectory() && !stat.isSymbolicLink()) {
      const now = lstatSync(join(root, dir.path), { bigint: true });
      if (String(now.dev) !== dir.dev || String(now.ino) !== dir.ino) blockers.push(`移行後に作り直されたディレクトリ: ${dir.path}`);
    }
  }
  return blockers;
}

// restore が書く場所の親ディレクトリのうち、移行の前からあるものの同一性を記録する
function identities(root: string, paths: string[]): DirIdentity[] {
  // 作業索引のディレクトリ (status/<工程>/…。v2 の status/implement/… は移行で消す) は対象外
  const isWorkIndexDir = (dir: string) => {
    const parts = dir.split("/");
    return parts.length >= 4 && parts[2] === "status" && (workIndexPhases as readonly string[]).includes(parts[3]);
  };
  return identitiesOf(root, [...new Set(paths.flatMap(ancestors))].filter((dir) => !isWorkIndexDir(dir)));
}

// restore が触る場所 (index.md・旧索引・作業索引) の親に、ディレクトリ以外 (リンク・ファイル) が無いか。
// リンクがあると、たどった先 (作業ツリーの外を含む) に書いたり消したりしてしまう (R16-3)。
// 移行の前からあるディレクトリは、移行した時と同じもの (削除して作り直していない) かも確かめる
function pathBlockers(root: string, task: JournalTask): string[] {
  const blockers: string[] = [];
  const paths = [task.index, ...task.linksBefore.map((link) => link.path), ...task.linksAfter.map((link) => link.path)];
  for (const dir of new Set(paths.flatMap(ancestors))) {
    const stat = lstatOrUndefined(join(root, dir));
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) blockers.push(`移行後にディレクトリ以外へ置き換えられた: ${dir}`);
  }
  blockers.push(...identityBlockers(root, task.dirs ?? []));
  // index.md 自身もリンクに置き換えられていないこと (内容が同じでも、リンク先を読んで照合してしまう)
  const index = lstatOrUndefined(join(root, task.index));
  if (index && (index.isSymbolicLink() || !index.isFile())) blockers.push(`移行後にファイル以外へ置き換えられたタスク: ${task.index}`);
  return blockers;
}

// 権限が移行した時と違えば理由を返す (内容が同じでも、権限の変更は移行後の変更 R16-2)
function modeBlocker(root: string, task: JournalTask): string[] {
  if (!isFile(join(root, task.index))) return [];
  const mode = statSync(join(root, task.index)).mode & 0o777;
  return mode === task.mode ? [] : [`移行後に権限が変更されたタスク: ${task.index} (${task.mode.toString(8)} → ${mode.toString(8)})`];
}

function placeLink(root: string, link: LinkState, fs: IndexFs): void {
  mkdirSync(dirname(join(root, link.path)), { recursive: true });
  fs.symlink(link.target, join(root, link.path));
}

// 作業索引 (jobs/<案件>/status/<工程>/<状態>/<名前>) のリンクを外した後、空になった <状態>/・<工程>/ を消す。
// 旧形式の状態索引のディレクトリ (status/todo など) は残す
function cleanWorkDirs(root: string, path: string): void {
  const parts = path.split("/");
  if (parts.length !== 6 || parts[0] !== "jobs" || parts[2] !== "status" || !(workIndexPhases as readonly string[]).includes(parts[3])) return;
  for (const dir of [parts.slice(0, 5).join("/"), parts.slice(0, 4).join("/")]) {
    try {
      if (readdirSync(join(root, dir)).length > 0) return;
      rmdirSync(join(root, dir));
    } catch {
      return;
    }
  }
}

// 移行後の索引とは別の作業索引 (移行後の操作で動いたもの) があれば、戻すと 2 つになる
function extraLinkBlockers(root: string, task: JournalTask): string[] {
  const [, job, , name] = task.index.split("/");
  return currentLinks(join(root, "jobs", job), name)
    .map((link) => relative(root, link.path))
    .filter((path) => !task.linksAfter.some((after) => after.path === path) && !task.linksBefore.some((before) => before.path === path))
    .map((path) => `移行後に作られた作業索引: ${path}`);
}

// 完了した移行を戻す前の確認。index.md・移行後の索引が移行した時のまま (削除も変更とみなす) で、
// 外した旧索引が作り直されていないときだけ戻す (R16-1)
function completedBlockers(root: string, dir: string, task: JournalTask): string[] {
  // 移行が作った作業索引のディレクトリも、移行した時と同じもの (同名で作り直していない) か確かめる (R16-5)
  const blockers: string[] = [...pathBlockers(root, task), ...identityBlockers(root, task.dirsAfter ?? []), ...backupBlockers(dir, task)];
  if (fileHash(root, task.index) === task.staged && !(task.after && sameFile(join(root, task.index), task.after.index))) blockers.push(`移行後に作り直されたタスク: ${task.index}`);
  for (const link of task.linksAfter) {
    const identity = task.after?.links[link.path];
    if (linkAt(root, link.path) === link.target && !(identity && sameEntry(join(root, link.path), identity))) blockers.push(`移行後に作り直された索引: ${link.path}`);
  }
  const current = fileHash(root, task.index);
  if (current !== task.staged) blockers.push(`移行後に${current === undefined ? "削除" : "変更"}されたタスク: ${task.index}`);
  else blockers.push(...modeBlocker(root, task));
  for (const link of task.linksAfter) {
    const now = linkAt(root, link.path);
    if (now !== link.target) blockers.push(`移行後に${now === undefined ? "削除" : "変更"}された索引: ${link.path}`);
  }
  for (const link of task.linksBefore) {
    if (task.linksAfter.some((after) => after.path === link.path)) continue;
    if (linkAt(root, link.path) !== undefined) blockers.push(`移行後に作られた索引: ${link.path}`);
    // 旧形式の状態索引のディレクトリ (status/todo など) は移行で残している。消えていれば移行後の変更
    // (v2 の作業索引のディレクトリ status/implement/… は移行で消すので対象外)
    else if (isLegacyIndex(link.path) && !exists(dirname(join(root, link.path)))) blockers.push(`移行後に削除された索引のディレクトリ: ${dirname(link.path)}`);
  }
  return [...blockers, ...extraLinkBlockers(root, task)];
}

// 旧形式の状態索引 (jobs/<案件>/status/<todo|progress|pending|done>/<名前>) か
function isLegacyIndex(path: string): boolean {
  const parts = path.split("/");
  return parts.length === 5 && parts[0] === "jobs" && parts[2] === "status" && (legacyStatuses as readonly string[]).includes(parts[3]);
}

// 書き戻す退避が、移行した時に退避した内容・権限のままか (退避を書き換えたものを戻さない)
function backupBlockers(dir: string, task: JournalTask): string[] {
  const path = join(dir, "backup", task.index);
  const stat = lstatOrUndefined(path);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) return [`退避がありません (または通常のファイルではありません): ${relative(dirname(dir), path)}`];
  if (sha256(readFileSync(path)) !== task.original || (statSync(path).mode & 0o777) !== task.mode) return [`退避が移行後に変更されています: ${task.index}`];
  if (task.backup && !sameFile(path, task.backup)) return [`退避が移行後に作り直されています: ${task.index}`];
  return [];
}

// 途中の状態 (apply の途中 started・restore の途中 restoring) を戻す前の確認。書けた範囲はタスク・索引ごとに違うので、
// 各対象が「移行の前」「移行した後」「restore で戻した後」のどれかの内容で、しかもその時点で記録した実体であることを確かめる。
// どれでもないもの (内容の変更・同じ内容での作り直し・記録の無い実体) があれば止める (R16-8・R16-9)
function intermediateBlockers(root: string, dir: string, task: JournalTask): string[] {
  const blockers: string[] = [...pathBlockers(root, task)];
  const indexPath = join(root, task.index);
  const current = fileHash(root, task.index);
  // 退避は、戻す前でも戻した後でも、移行した時の内容・権限・実体のまま (R16-10)
  blockers.push(...backupBlockers(dir, task));
  if (current === task.staged) {
    if (!(task.after && sameFile(indexPath, task.after.index))) blockers.push(`移行後に作り直されたタスク: ${task.index}`);
  } else if (current === task.original) {
    const known = (task.before && sameFile(indexPath, task.before.index)) || (task.restored?.index !== undefined && sameFile(indexPath, task.restored.index));
    if (!known) blockers.push(`移行後に作り直されたタスク: ${task.index}`);
  } else blockers.push(`移行後に${current === undefined ? "削除" : "変更"}されたタスク: ${task.index}`);
  if (current === task.staged || current === task.original) blockers.push(...modeBlocker(root, task));
  const same = (a: LinkState, list: LinkState[]) => list.some((b) => b.path === a.path && b.target === a.target);
  const matches = (path: string, ids: (FileIdentity | undefined)[]) => ids.some((id) => id !== undefined && sameEntry(join(root, path), id));
  for (const link of task.linksAfter) {
    const now = linkAt(root, link.path);
    if (same(link, task.linksBefore)) {
      // 移行で動かさない索引 (v2 の今の工程の作業索引など): 移行の前のまま
      if (now !== link.target || !matches(link.path, [task.before?.links[link.path]])) blockers.push(`移行後に変更された索引: ${link.path}`);
      continue;
    }
    const placed = task.applied?.placed[link.path];
    if (now === undefined) {
      // 無いのは、apply が置く前か、restore が消した後だけ (置いたのに誰かが消したものは止める)
      if (placed !== undefined && !(task.restored?.removed ?? []).includes(link.path)) blockers.push(`移行後に削除された索引: ${link.path}`);
    } else if (now !== link.target) blockers.push(`移行後に変更された索引: ${link.path}`);
    else if (!matches(link.path, [placed, task.after?.links[link.path]])) blockers.push(`移行後に作り直された索引: ${link.path}`);
  }
  for (const link of task.linksBefore) {
    if (same(link, task.linksAfter)) continue;
    const now = linkAt(root, link.path);
    if (now === undefined) {
      // 無いのは、apply が消した後で restore がまだ置いていないときだけ
      const removedByApply = (task.applied?.removed ?? []).includes(link.path);
      if (!removedByApply || task.restored?.links[link.path] !== undefined) blockers.push(`移行後に削除された索引: ${link.path}`);
    } else if (now !== link.target) blockers.push(`移行後に変更された索引: ${link.path}`);
    else if (!matches(link.path, [task.before?.links[link.path], task.restored?.links[link.path]])) blockers.push(`移行後に作り直された索引: ${link.path}`);
  }
  // 残っている作業索引の親ディレクトリは、移行が作った (または使った) ものと同じか
  blockers.push(...identityBlockers(root, (task.dirsAfter ?? []).filter((entry) => lstatOrUndefined(join(root, entry.path)) !== undefined)));
  return [...blockers, ...extraLinkBlockers(root, task)];
}

function restoreTask(root: string, dir: string, task: JournalTask, fs: IndexFs = defaultIndexFs): void {
  task.restored ??= { links: {} };
  task.restored.removed ??= [];
  for (const link of task.linksAfter) {
    if (task.linksBefore.some((before) => before.path === link.path && before.target === link.target)) continue;
    if (linkAt(root, link.path) === link.target) {
      fs.unlink(join(root, link.path));
      task.restored.removed.push(link.path);
    }
    // 途中で失敗したときは、リンクを置く前に作ったディレクトリだけが残っていることがある
    cleanWorkDirs(root, link.path);
  }
  for (const link of task.linksBefore) {
    if (linkAt(root, link.path) === undefined) {
      placeLink(root, link, fs);
      task.restored.links[link.path] = fileIdentity(join(root, link.path));
    }
  }
  if (fileHash(root, task.index) === task.staged) {
    const temp = tempPath(dirname(join(root, task.index)), "index.md");
    try {
      cpSync(join(dir, "backup", task.index), temp, { preserveTimestamps: true });
      chmodSync(temp, task.mode); // 移行前の権限で戻す
      fs.rename(temp, join(root, task.index));
      task.restored.index = fileIdentity(join(root, task.index));
    } finally {
      rmSync(temp, { force: true }); // 置き換えに失敗しても一時ファイルを残さない
    }
  }
}

function rollback(root: string, journal: Journal, fs: IndexFs = defaultIndexFs): string[] {
  const dir = workDir(root, journal.id);
  const failures: string[] = [];
  for (const task of [...journal.tasks].reverse()) {
    try {
      restoreTask(root, dir, task, fs);
    } catch (error) {
      failures.push(`${task.index}: ${error instanceof Error ? error.message : String(error)}`);
    }
    // 戻した実体の記録を、タスクごとに保存する (途中で止まっても、再実行で「restore が戻したもの」と分かるように)
    try {
      saveJournal(root, journal);
    } catch (error) {
      failures.push(`記録の保存: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // 印は、すべてのタスクを戻せたときだけ消す。工程型のタスクが残る間は、旧形式の task add を拒否し続ける (R16-11)
  const marker = join(root, "jobs", markerName);
  if (failures.length === 0 && journal.marker.created && isFile(marker) && readFileSync(marker, "utf8") === markerContent) {
    rmSync(marker);
    journal.markerRemoved = true;
  }
  return failures;
}

function migrationLock<T>(root: string, fn: () => T): T {
  const base = join(root, ".raprid-migrate");
  // ロックと記録を置く場所をたどって作業ツリーの外へ書かない (ロックを取る前と、取った後にも確かめる)
  const places = [".raprid-migrate", "jobs/.locks"];
  assertSafeDirs(root, places);
  const created = !exists(base);
  try {
    // 移行 (job migrate と同じロック) と、すべての案件のロックを取る (移行中にタスクを書き換えさせない)。
    // 移行・戻しはすべての案件を書き換えうるので、ロックの中で各案件の残った journal を先に復旧する (契約 7、R21-2)
    return withLock(join(base, ".lock"), base, () => {
      const names = Job.all(root).map((job) => job.name);
      return withJobWriteLocks(root, names, names, () => {
        assertSafeDirs(root, places);
        return fn();
      });
    });
  } finally {
    if (created) {
      try {
        rmdirSync(base);
      } catch {
        // 移行の記録が残っている
      }
    }
  }
}

// 計画を実行する。fs・rollbackFs は試験で失敗を注入するため (既定は node:fs。rollbackFs は失敗した後の戻し)
export function applyPlan(plan: Plan, expected: string | undefined, fs: IndexFs = defaultIndexFs, rollbackFs: IndexFs = defaultIndexFs): string {
  const root = plan.root;
  if (expected === undefined) throw new UsageError("--apply には --plan <計画ハッシュ> が必要です (先に --dry-run で計画を確かめる)");
  if (plan.diagnostics.length > 0) throw new CliError(["移行できないものがあるため、何も変更せずに中止しました:", ...plan.diagnostics.map((line) => `  - ${line}`)].join("\n"), 1, "MIGRATE_BLOCKED");
  if (expected !== plan.hash) throw new CliError(`表示した計画 (${expected}) と現在の計画 (${plan.hash}) が一致しないため中止しました。--dry-run で確認し直してください`, 1, "MIGRATE_PLAN_CHANGED");
  const id = newId();
  const dir = workDir(root, id);
  assertSafeDirs(root, [".raprid-migrate"]);
  mkdirSync(join(root, ".raprid-migrate"), { recursive: true });
  mkdirSync(dir); // 新しい記録のディレクトリ (既にあれば失敗する)
  mkdirSync(join(dir, "backup"));
  writeFileSync(join(dir, "journal.id"), "", { flag: "wx" });
  for (const change of plan.changes) {
    const backup = join(dir, "backup", change.index);
    mkdirSync(dirname(backup), { recursive: true });
    writeFileSync(backup, change.original, { mode: change.mode });
    chmodSync(backup, change.mode); // umask で狭まらないように (restore はこの権限で戻す)
  }
  writeFileSync(join(dir, "plan.txt"), [`hash: ${plan.hash}`, `actor: ${plan.actor}`, ...plan.changes.map((change) => `${change.job}/${change.id} ${change.name}: ${change.summary}`), ...plan.warnings.map((warning) => `注意: ${warning}`)].join("\n") + "\n");
  const journal: Journal = {
    kind: "workflow-v3",
    id,
    state: "started",
    actor: plan.actor,
    hash: plan.hash,
    marker: { created: !plan.markerExists },
    jobs: plan.jobs,
    tasks: plan.changes.map((change) => ({
      index: change.index,
      original: sha256(change.original),
      staged: sha256(change.content),
      mode: change.mode,
      dirs: identities(root, [change.index, ...change.linksBefore.map((link) => link.path)]),
      backup: fileIdentity(join(dir, "backup", change.index)),
      before: { index: fileIdentity(join(root, change.index)), links: Object.fromEntries(change.linksBefore.map((link) => [link.path, fileIdentity(join(root, link.path))])) },
      linksBefore: change.linksBefore,
      linksAfter: change.linksAfter,
    })),
    idFile: fileIdentity(join(dir, "journal.id")),
    markerBefore: plan.markerExists ? fileIdentity(join(root, "jobs", markerName)) : undefined,
    record: identitiesOf(root, [".raprid-migrate", `.raprid-migrate/${id}`, `.raprid-migrate/${id}/backup`, ...plan.changes.flatMap((change) => ancestors(`.raprid-migrate/${id}/backup/${change.index}`))]),
  };
  saveJournal(root, journal);

  try {
    for (const [position, change] of plan.changes.entries()) {
      const index = join(root, change.index);
      if (readFileSync(index, "utf8") !== change.original) throw new Error(`計画の作成後に変更されたタスクがあります: ${change.index}`);
      const temp = tempPath(dirname(index), "index.md");
      try {
        fs.writeTemp(temp, change.content, change.mode);
        chmodSync(temp, change.mode); // umask に依らず元の権限にする (restore の前の照合に使う)
        const ops: { placed: Record<string, FileIdentity>; removed: string[] } = { placed: {}, removed: [] };
        journal.tasks[position].applied = ops;
        for (const link of change.linksBefore) {
          if (change.linksAfter.some((after) => after.path === link.path && after.target === link.target)) continue;
          fs.unlink(join(root, link.path));
          ops.removed.push(link.path);
          cleanWorkDirs(root, link.path);
        }
        for (const link of change.linksAfter) {
          if (change.linksBefore.some((before) => before.path === link.path && before.target === link.target)) continue;
          placeLink(root, link, fs);
          ops.placed[link.path] = fileIdentity(join(root, link.path));
        }
        fs.rename(temp, index);
      } finally {
        rmSync(temp, { force: true });
      }
      // 書いた直後の実体と、作業索引の親ディレクトリ (この移行で作ったものを含む R16-5) を記録して保存する
      const task = journal.tasks[position];
      task.after = { index: fileIdentity(index), links: Object.fromEntries(task.linksAfter.map((link) => [link.path, fileIdentity(join(root, link.path))])) };
      task.dirsAfter = identitiesOf(root, task.linksAfter.flatMap((link) => ancestors(link.path)));
      saveJournal(root, journal);
    }
    if (!plan.markerExists) {
      writeFileSync(join(root, "jobs", markerName), markerContent, { flag: "wx" });
      journal.markerAfter = fileIdentity(join(root, "jobs", markerName));
      saveJournal(root, journal);
    } else journal.markerAfter = journal.markerBefore;
    journal.state = "completed";
    saveJournal(root, journal);
  } catch (error) {
    const failures = rollback(root, journal, rollbackFs);
    journal.state = failures.length === 0 ? "rolled-back" : "started";
    try {
      saveJournal(root, journal);
    } catch {
      // 記録できなくても、作業ツリーの復元結果を優先して報告する
    }
    const message = error instanceof Error ? error.message : String(error);
    if (failures.length > 0) {
      throw new CliError([`移行に失敗し、一部を戻せませんでした: ${message}`, ...failures.map((failure) => `  ${failure}`), `raprid job migrate-workflow --restore ${id} で再度戻せます`].join("\n"), 1, "MIGRATE_FAILED");
    }
    throw new CliError(`移行に失敗したため、この実行で変えたものを戻しました: ${message}`, 1, "MIGRATE_FAILED");
  }
  return id;
}

export function restorePlan(root: string, id: string, fs: IndexFs = defaultIndexFs): "restored" | "already" {
  if (!idPattern.test(id)) throw new UsageError(`移行IDの形式が不正です: ${id} (wf-YYYYMMDD-HHMMSS-xxxx)`);
  const dir = workDir(root, id);
  const journalPath = join(dir, "journal.json");
  // 記録・退避の置き場所がリンクに置き換えられていれば、読まずに止める (たどった先の記録で戻したり、書いたりしない)
  const unsafe = unsafeDirs(root, [`.raprid-migrate/${id}`, `.raprid-migrate/${id}/backup`]);
  const journalStat = lstatOrUndefined(journalPath);
  if (unsafe.length > 0 || journalStat?.isSymbolicLink() || lstatOrUndefined(join(dir, "journal.id"))?.isSymbolicLink()) {
    throw new CliError(["移行後に変更されたものがあるため、戻さずに中止しました (退避は残っています):", ...unsafe.map((path) => `  移行後にディレクトリ以外へ置き換えられた: ${path}`), ...(journalStat?.isSymbolicLink() ? [`  移行後にファイル以外へ置き換えられた記録: .raprid-migrate/${id}/journal.json`] : [])].join("\n"), 1, "MIGRATE_RESTORE_BLOCKED");
  }
  if (!isFile(journalPath)) throw new CliError(`移行の記録が見つかりません: .raprid-migrate/${id}/journal.json`);
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
  if (journal.kind === "workflow-v3" && journal.state !== "restored" && journal.state !== "rolled-back") {
    // 記録そのものが移行した時の実体か (journal.json と journal.id が移行の書いた実体、記録と退避のディレクトリが同じもの)
    const recordBlockers = [...journalBlockers(dir, journal), ...identityBlockers(root, journal.record ?? [])];
    if (recordBlockers.length > 0) {
      throw new CliError(["移行後に変更されたものがあるため、戻さずに中止しました (退避は残っています):", ...recordBlockers.map((line) => `  ${line}`)].join("\n"), 1, "MIGRATE_RESTORE_BLOCKED");
    }
  }
  if (journal.kind !== "workflow-v3") throw new CliError(`workflowVersion 3 への移行の記録ではありません: .raprid-migrate/${id}/journal.json`);
  if (journal.state === "restored" || journal.state === "rolled-back") return "already";
  const completed = journal.state === "completed";
  const blockers = journal.tasks.flatMap((task) => (completed ? completedBlockers(root, dir, task) : intermediateBlockers(root, dir, task)));
  // 退避のディレクトリ (backup/jobs/<案件>/tasks/<タスク>) もリンクに置き換えられていないこと
  blockers.push(...unsafeDirs(root, journal.tasks.map((task) => dirname(`.raprid-migrate/${id}/backup/${task.index}`))).map((path) => `移行後にディレクトリ以外へ置き換えられた: ${path}`));
  // 移行で置いた印 (旧形式の add を拒否する) も、移行した時のままでなければ止める
  const marker = join(root, "jobs", markerName);
  const markerStat = lstatOrUndefined(marker);
  if (completed && !(markerStat?.isFile() && readFileSync(marker, "utf8") === markerContent)) blockers.push(`移行後に${markerStat ? "変更" : "削除"}された印: jobs/${markerName}`);
  else if (completed && !(journal.markerAfter && sameFile(marker, journal.markerAfter))) blockers.push(`移行後に作り直された印: jobs/${markerName}`);
  // 途中の状態 (started・restoring) では、印は置いたときのものか、移行の前からあったものか、
  // 無いなら apply がまだ置いていないか、戻しがすべて済んで消した後だけ (利用者が消したものは止める R16-11)
  if (!completed && markerStat) {
    if (!(markerStat.isFile() && readFileSync(marker, "utf8") === markerContent)) blockers.push(`移行後に変更された印: jobs/${markerName}`);
    else if (![journal.markerAfter, journal.markerBefore].some((id) => id !== undefined && sameFile(marker, id))) blockers.push(`移行後に作り直された印: jobs/${markerName}`);
  } else if (!completed && !markerStat) {
    const neverPlaced = journal.marker.created && journal.markerAfter === undefined;
    if (!neverPlaced && !journal.markerRemoved) blockers.push(`移行後に削除された印: jobs/${markerName}`);
  }
  // 移行後に作ったタスク (v3) が残ると、戻した後に印の無い状態で工程型のタスクが混ざる
  for (const job of Job.all(root)) {
    const before = new Set(journal.jobs[job.name] ?? []);
    for (const item of job.items("task")) if (!before.has(item.name)) blockers.push(`移行後に作られたタスク: jobs/${job.name}/tasks/${item.name}`);
  }
  if (blockers.length > 0) {
    throw new CliError(["移行後に変更されたものがあるため、戻さずに中止しました (退避は残っています):", ...[...new Set(blockers)].map((blocker) => `  ${blocker}`)].join("\n"), 1, "MIGRATE_RESTORE_BLOCKED");
  }
  // 書き戻す前に restore の途中であることを記録する。途中で失敗したら restoring のまま残り、再実行では
  // started と同じく「移行前か移行後のどちらか」を受け入れて残りだけを戻す (R16-8)
  if (completed) {
    journal.state = "restoring";
    saveJournal(root, journal);
  }
  const failures = rollback(root, journal, fs);
  if (failures.length === 0) journal.state = "restored";
  saveJournal(root, journal);
  if (failures.length > 0) throw new CliError(["一部を戻せませんでした:", ...failures.map((failure) => `  ${failure}`)].join("\n"), 1, "MIGRATE_FAILED");
  return "restored";
}

// 移行した後 (印がある)、または移行の記録が移行済み・途中 (completed・started・restoring) のときは、旧形式のタスクを新しく作らない。
// 印が消えていても、記録から移行を見分ける (R16-11)
export function assertLegacyAddAllowed(root: string): void {
  const guidance = "raprid task add <案件名> <タスク名> <タイトル> --type research|implementation を使ってください";
  if (exists(join(root, "jobs", markerName))) {
    throw new CliError(`workflowVersion 3 へ移行済みのため、旧形式のタスクは作れません (jobs/${markerName})。${guidance}`, 1, "WF_MIGRATED");
  }
  const base = join(root, ".raprid-migrate");
  if (!isDirectory(base)) return;
  for (const name of readdirSync(base).filter((entry) => idPattern.test(entry)).sort()) {
    let state: unknown;
    try {
      state = (JSON.parse(readFileSync(join(base, name, "journal.json"), "utf8")) as { state?: unknown }).state;
    } catch {
      state = "unreadable";
    }
    if (state === "completed" || state === "started" || state === "restoring" || state === "unreadable") {
      const detail = state === "completed" ? "移行済みです" : state === "unreadable" ? "移行の記録を読めません" : "移行か復元が途中です";
      throw new CliError(`workflowVersion 3 への移行の記録 (.raprid-migrate/${name}/) があり、${detail}。旧形式のタスクは作れません (途中なら raprid job migrate-workflow --restore ${name} で戻す)。${guidance}`, 1, "WF_MIGRATED");
    }
  }
}

export function migrateWorkflow(argv: string[]): void {
  const { values, positionals } = parse(
    argv,
    { map: { type: "string" }, actor: { type: "string" }, "dry-run": { type: "boolean" }, apply: { type: "boolean" }, plan: { type: "string" }, restore: { type: "string" } },
    usage,
  );
  if (positionals.length > 0) throw new UsageError(usage);
  const modes = [values["dry-run"], values.apply, values.restore !== undefined].filter(Boolean).length;
  if (modes > 1) throw new UsageError(`--dry-run・--apply・--restore は同時に指定できません\n${usage}`);
  if (values.plan !== undefined && !values.apply) throw new UsageError("--plan は --apply と一緒に指定してください");
  const root = projectRoot();
  if (values.restore !== undefined) {
    if (values.map !== undefined) throw new UsageError("--restore には --map を指定しません");
    const id = values.restore;
    const result = migrationLock(root, () => restorePlan(root, id));
    console.log(result === "already" ? `移行 ${id} は既に戻されています。変更はありません。` : `移行 ${id} の前の状態に戻しました。退避の記録は .raprid-migrate/${id}/ に残っています。`);
    return;
  }
  const actor = actorOption(values.actor ?? process.env.RAPRID_ACTOR, "--actor");
  const map = values.map === undefined ? undefined : parseMap(readFileSync(values.map, "utf8"));
  const run = () => {
    const plan = buildPlan(root, map, actor);
    if (plan.changes.length === 0 && plan.diagnostics.length === 0 && plan.markerExists) {
      console.log(`移行済みです (移す旧形式・workflowVersion 2 のタスクはありません。移行済み ${plan.unchanged} 件)。変更はありません。`);
      return;
    }
    if (!values.apply) {
      printPlan(plan);
      if (plan.diagnostics.length > 0) throw new CliError(`移行できないものが ${plan.diagnostics.length} 件あります (何も変更していません)`, 1, "MIGRATE_BLOCKED");
      console.log(`実行: raprid job migrate-workflow${values.map !== undefined ? ` --map ${values.map}` : ""} --actor ${actor} --apply --plan ${plan.hash}  (何も変更していません)`);
      return;
    }
    const id = applyPlan(plan, values.plan);
    console.log(`移行しました (移行ID: ${id}、${plan.changes.length} 件)`);
    console.log(`  移行前の index.md: .raprid-migrate/${id}/backup/`);
    console.log(`  戻す場合: raprid job migrate-workflow --restore ${id}`);
    console.log("  確認後は raprid task list で一覧を確かめ、.raprid-migrate/ を削除してよい");
  };
  if (values.apply) migrationLock(root, run);
  else run();
}
