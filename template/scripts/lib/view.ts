// 一覧・詳細の端末表示。罫線はヘッダーの下だけに引き、行ごとの囲みは付けない。
//
//   幅 80 以上 (と非 TTY): 表 / 40〜79: ID・状態の行とタイトルの行 / 40 未満: 最小限の縦配置
//   非 TTY は省略・折返しをせず、既定で罫線と ANSI を出さない (機械利用は --json)。

import { UsageError } from "./errors.ts";
import type { Kind } from "./jobs.ts";
import type { ListGroup } from "./query.ts";
import { type Collected, type Issue, isAwaitingApproval, isKnownStatus, isWorkflow, type ItemRecord, statusOrder, type TaskRecord, type WorkflowInfo } from "./records.ts";
import { clampLines, padEnd, sanitize, width, wrap } from "./text.ts";

export type Border = "none" | "ascii" | "unicode";

export interface Display {
  width: number | undefined; // undefined は非 TTY (折り返さない)
  border: Border;
  color: boolean;
  ellipsis: string;
  long: boolean;
}

export interface DisplayOptions {
  width?: string;
  border?: string;
  color?: string;
  long?: boolean;
}

export const displayOptionSpec = {
  width: { type: "string" },
  border: { type: "string" },
  color: { type: "string" },
} as const;

export const displayUsage = `表示: --width <40〜240> (TTY の幅を上書き) --border auto|none|ascii|unicode --color auto|always|never
非 TTY (パイプ・リダイレクト) では省略・折返し・色を行わない。機械的に読むときは --json を使う`;

export function validateDisplay(options: DisplayOptions): void {
  if (options.width !== undefined) {
    const value = Number(options.width);
    if (!/^\d+$/.test(options.width) || value < 40 || value > 240) throw new UsageError(`--width は 40〜240 の整数で指定してください: ${options.width}`);
  }
  if (options.border !== undefined && !["auto", "none", "ascii", "unicode"].includes(options.border)) {
    throw new UsageError(`--border は auto、none、ascii、unicode のいずれかです: ${options.border}`);
  }
  if (options.color !== undefined && !["auto", "always", "never"].includes(options.color)) {
    throw new UsageError(`--color は auto、always、never のいずれかです: ${options.color}`);
  }
}

// --json と表示専用のオプションは同時に使えない
export function rejectDisplayWithJson(json: boolean | undefined, options: DisplayOptions): void {
  if (!json) return;
  const used = (["width", "border", "color", "long"] as const).filter((key) => options[key] !== undefined && options[key] !== false);
  if (used.length > 0) throw new UsageError(`--json と ${used.map((key) => `--${key}`).join("、")} は同時に指定できません`);
}

function isUtf8(env: NodeJS.ProcessEnv): boolean {
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  return /utf-?8/i.test(locale);
}

export function resolveDisplay(options: DisplayOptions, stream: { isTTY?: boolean; columns?: number } = process.stdout, env: NodeJS.ProcessEnv = process.env): Display {
  validateDisplay(options);
  const tty = stream.isTTY === true;
  const dumb = env.TERM === "dumb";
  const utf8 = isUtf8(env);
  const lineWidth = tty ? (options.width !== undefined ? Number(options.width) : Math.min(stream.columns || 80, 120)) : undefined;
  const border: Border =
    options.border !== undefined && options.border !== "auto" ? (options.border as Border) : !tty || dumb ? "none" : utf8 ? "unicode" : "ascii";
  const noColor = env.NO_COLOR !== undefined && env.NO_COLOR !== "";
  const color = options.color === "always" ? true : options.color === "never" ? false : tty && !noColor && !dumb;
  return { width: lineWidth, border, color, ellipsis: utf8 ? "…" : "...", long: options.long ?? false };
}

const styles = { bold: [1, 22], dim: [2, 22], red: [31, 39], green: [32, 39], yellow: [33, 39], magenta: [35, 39], cyan: [36, 39] } as const;
type Style = keyof typeof styles;

function paint(display: Display, text: string, style: Style | undefined): string {
  if (!display.color || style === undefined || text === "") return text;
  const [open, close] = styles[style];
  return `\u001B[${open}m${text}\u001B[${close}m`;
}

const statusStyles: Record<string, Style> = { progress: "cyan", todo: "green", pending: "yellow", done: "dim", unresolved: "yellow", resolved: "dim" };

const phaseStatusStyles: Record<string, Style> = { progress: "cyan", ready: "green", pending: "yellow" };

function statusStyle(record: ItemRecord): Style {
  if (isWorkflow(record)) {
    if (!record.workflow.valid) return "red";
    if (record.status === "closed") return "dim";
    if (isAwaitingApproval(record)) return "magenta"; // 人の確認待ち (外部の待ちの黄色と分ける)
    return phaseStatusStyles[record.workflow.phaseStatus ?? ""] ?? "red";
  }
  return isKnownStatus(record.kind, record.status) ? statusStyles[record.status!] : "red";
}

const typeLabels: Record<string, string> = { research: "調査", implementation: "実装" };

// 工程型のタスクの列 (種別・工程・担当)。旧形式は種別・担当が「-」、工程が「未移行」
function typeText(record: ItemRecord): string {
  if (!isWorkflow(record)) return "-";
  if (!record.workflow.readable) return "読めない";
  return record.workflow.type === null ? `v${record.workflow.version}` : (typeLabels[record.workflow.type] ?? sanitize(record.workflow.type));
}

function phaseText(record: ItemRecord): string {
  if (!isWorkflow(record)) return "未移行";
  return record.status === "closed" ? "-" : sanitize(record.workflow.phase ?? "未設定");
}

function assigneeText(record: ItemRecord): string {
  if (!isWorkflow(record) || record.status === "closed") return "-";
  return record.workflow.assignee === null ? "未割当" : sanitize(record.workflow.assignee);
}

// 同じ一覧に工程型のタスクがあるか (あれば種別・工程・担当の列を足す。旧形式だけなら表示を変えない)
function hasWorkflowRecords(records: ItemRecord[]): boolean {
  return records.some(isWorkflow);
}

export function actorText(value: string | null): string {
  return value === null ? "不明（旧記録）" : sanitize(value);
}

function dateText(value: string | null): string {
  return value === null ? "-" : sanitize(value);
}

function idText(record: ItemRecord): string {
  return record.id === null ? "ID未設定" : sanitize(record.id);
}

// v4 は人の確認待ち (タスクの pending) を「確認待ち」、外部の待ち (工程の pending) を「外部待ち」と別の語で示す (v3 以前の表示は変えない)
function statusText(record: ItemRecord): string {
  if (isWorkflow(record) && record.workflow.version === 4 && record.status !== "closed") {
    if (isAwaitingApproval(record)) return "確認待ち";
    if (record.workflow.phaseStatus === "pending") return "外部待ち";
  }
  if (isWorkflow(record)) return record.status === "closed" ? "closed" : sanitize(record.workflow.phaseStatus ?? "未設定");
  return record.status === null ? "未設定" : sanitize(record.status);
}

function titleText(record: ItemRecord): string {
  return sanitize(record.title ?? record.name);
}

function borderLine(display: Display, sizes: number[]): string | undefined {
  if (display.border === "none") return undefined;
  const char = display.border === "unicode" ? "─" : "-";
  return sizes.map((size) => char.repeat(Math.max(1, size))).join("  ");
}

// indent を付けて limit に収める (limit が無ければ折り返さない)。字下げが幅を超える狭い端末では字下げを減らす
function indented(text: string, indent: number, limit: number | undefined): string[] {
  const pad = limit === undefined ? indent : Math.min(indent, Math.max(0, limit - 1));
  const room = limit === undefined ? undefined : Math.max(1, limit - pad);
  return wrap(text, room).map((line) => " ".repeat(pad) + line);
}

// ID・状態・確認先などの短い要素を 1 行に並べ、幅を超えるなら次の行へ送る。
// 要素は省略しない (1 つで幅を超えるときだけ折り返す)。色は並べた後に付けるので幅の計算に入らない
function packSegments(segments: { text: string; style?: Style }[], gap: string, limit: number, display: Display): string[] {
  const lines: string[] = [];
  let current = "";
  let used = 0;
  const flush = () => {
    if (used > 0) lines.push(current);
    current = "";
    used = 0;
  };
  for (const segment of segments) {
    const size = width(segment.text);
    if (used > 0 && used + width(gap) + size > limit) flush();
    if (size > limit) {
      flush();
      for (const part of wrap(segment.text, limit)) lines.push(paint(display, part, segment.style));
      continue;
    }
    current += (used > 0 ? gap : "") + paint(display, segment.text, segment.style);
    used += (used > 0 ? width(gap) : 0) + size;
  }
  flush();
  return lines;
}

function detailLines(record: ItemRecord, display: Display): string[] {
  const lines: string[] = [];
  const pending = isWorkflow(record) ? record.workflow.phaseStatus === "pending" && record.status === "open" : record.kind === "task" && record.status === "pending";
  if (isAwaitingApproval(record) && isWorkflow(record)) lines.push(approvalLine(record));
  else if (record.kind === "task" && pending) {
    const label = isWorkflow(record) && record.workflow.version === 4 ? "外部待ち" : "待ち";
    lines.push(`${label}: ${record.blockedBy.length > 0 ? record.blockedBy.map((value) => sanitize(value)).join(", ") : "（未記入）"}`);
  }
  if (display.long) {
    if (record.kind === "task") {
      lines.push(`依頼: ${actorText(record.requestedBy)} / 記録: ${actorText(record.createdBy)}`);
      lines.push(`作成: ${dateText(record.createdAt)} / 更新: ${dateText(record.updatedAt)} / 完了: ${dateText(record.completedAt)}`);
    } else {
      lines.push(`依頼: ${actorText(record.requestedBy)} / 記録: ${actorText(record.createdBy)} / 回答: ${record.answeredBy === null ? "-" : actorText(record.answeredBy)}`);
      lines.push(`作成: ${dateText(record.createdAt)} / 更新: ${dateText(record.updatedAt)} / 解決: ${dateText(record.resolvedAt)}`);
    }
    lines.push(`パス: ${sanitize(record.path)}`);
  }
  return lines;
}

// v4 の人の確認待ちの行: 待っている判断記録と判断者
function approvalLine(record: TaskRecord & { workflow: WorkflowInfo }): string {
  const waiting = record.workflow.waiting;
  const id = waiting?.kind === "approval" ? waiting.approval : (record.blockedBy[0] ?? "").replace(/^approval\//, "");
  const decision = record.workflow.decisions.find((each) => each.id === id);
  const assignee = decision?.data?.assignee;
  const who = typeof assignee === "string" ? sanitize(assignee) : assignee === null ? "未割当" : "不明";
  return `確認待ち: ${sanitize(id || "（未記入）")} (判断者: ${who})${decision?.valid === false ? " 要確認" : ""}`;
}

// 表の区切り。工程型は今の工程の状態を旧形式の状態の順に当てはめる (progress → ready → pending → closed)
function groupStatus(record: ItemRecord): string | null {
  if (!isWorkflow(record)) return record.status;
  if (!record.workflow.valid) return null;
  if (record.status === "closed") return "done";
  if (isAwaitingApproval(record)) return "pending";
  return { progress: "progress", ready: "todo", pending: "pending" }[record.workflow.phaseStatus ?? ""] ?? null;
}

function statusGroups(kind: Kind, records: ItemRecord[]): ItemRecord[][] {
  const groups = statusOrder[kind].map((status) => records.filter((record) => groupStatus(record) === status));
  groups.push(records.filter((record) => !isKnownStatus(kind, groupStatus(record))));
  return groups.filter((group) => group.length > 0);
}

function issueLines(issues: Issue[], display: Display): string[] {
  if (issues.length === 0) return [];
  const lines = ["", paint(display, `要確認 (${issues.length})`, "yellow")];
  for (const issue of issues) {
    lines.push(...indented(sanitize(issue.message), 2, display.width));
    lines.push(...indented([issue.id === null ? undefined : sanitize(issue.id), sanitize(issue.path)].filter((value) => value !== undefined).join("  "), 4, display.width));
  }
  return lines;
}

function tableRows(kind: Kind, records: ItemRecord[], display: Display): string[] {
  const workflow = kind === "task" && hasWorkflowRecords(records);
  const idWidth = Math.max(width("ID"), ...records.map((record) => width(idText(record))));
  const statusWidth = Math.max(width("状態"), ...records.map((record) => width(statusText(record))));
  const askText = (record: ItemRecord) => (record.kind === "qa" ? sanitize(record.askTo ?? "未設定") : "");
  const askWidth = kind === "qa" ? Math.max(width("確認先"), ...records.map((record) => width(askText(record)))) : 0;
  // 工程型のタスクがあるときだけ、種別・工程・担当の列を足す
  const typeWidth = workflow ? Math.max(width("種別"), ...records.map((record) => width(typeText(record)))) : 0;
  const phaseWidth = workflow ? Math.max(width("工程"), ...records.map((record) => width(phaseText(record)))) : 0;
  const assigneeWidth = workflow ? Math.max(width("担当"), ...records.map((record) => width(assigneeText(record)))) : 0;
  const workflowPrefix = workflow ? typeWidth + 2 + phaseWidth + 2 + assigneeWidth + 2 : 0;
  const prefix = idWidth + 2 + statusWidth + 2 + (kind === "qa" ? askWidth + 2 : 0) + workflowPrefix;
  const titleWidth = display.width === undefined ? undefined : Math.max(10, display.width - prefix);
  const maxLines = display.long ? undefined : 2;

  const header = [
    padEnd("ID", idWidth),
    ...(workflow ? [padEnd("種別", typeWidth), padEnd("工程", phaseWidth)] : []),
    padEnd("状態", statusWidth),
    ...(workflow ? [padEnd("担当", assigneeWidth)] : []),
    ...(kind === "qa" ? [padEnd("確認先", askWidth)] : []),
    "タイトル",
  ].join("  ");
  const titleBorder = titleWidth ?? Math.max(width("タイトル"), ...records.map((record) => width(titleText(record))));
  const border = borderLine(display, [idWidth, ...(workflow ? [typeWidth, phaseWidth] : []), statusWidth, ...(workflow ? [assigneeWidth] : []), ...(kind === "qa" ? [askWidth] : []), titleBorder]);
  const lines = [header.trimEnd(), ...(border ? [border] : [])];

  statusGroups(kind, records).forEach((group, index) => {
    if (index > 0) lines.push("");
    for (const record of group) {
      const titles = clampLines(titleText(record), titleWidth, maxLines, display.ellipsis);
      const cells = [
        padEnd(idText(record), idWidth),
        ...(workflow ? [padEnd(typeText(record), typeWidth), padEnd(phaseText(record), phaseWidth)] : []),
        paint(display, padEnd(statusText(record), statusWidth), statusStyle(record)),
        ...(workflow ? [padEnd(assigneeText(record), assigneeWidth)] : []),
        ...(kind === "qa" ? [padEnd(askText(record), askWidth)] : []),
        titles[0],
      ];
      lines.push(cells.join("  ").trimEnd());
      for (const line of titles.slice(1)) lines.push(" ".repeat(prefix) + line);
      for (const detail of detailLines(record, display)) lines.push(...indented(detail, 2, display.width));
    }
  });
  return lines;
}

function stackedRows(kind: Kind, records: ItemRecord[], display: Display, minimal: boolean): string[] {
  const lineWidth = display.width!;
  const idWidth = Math.max(width("ID"), ...records.map((record) => width(idText(record))));
  const gap = minimal ? " " : "  ";
  const indent = minimal ? 0 : 2;
  const lines: string[] = [];
  const workflow = kind === "task" && hasWorkflowRecords(records);
  if (!minimal) {
    lines.push(...packSegments([{ text: padEnd("ID", idWidth) }, ...(workflow ? [{ text: "種別" }, { text: "工程" }] : []), { text: "状態" }, ...(workflow ? [{ text: "担当" }] : []), ...(kind === "qa" ? [{ text: "確認先" }] : [])], "  ", lineWidth, display), "  タイトル");
    const border = borderLine(display, [lineWidth]);
    if (border) lines.push(border);
  }
  const maxLines = display.long ? undefined : 2;
  statusGroups(kind, records).forEach((group, index) => {
    if (index > 0 || minimal) lines.push("");
    for (const record of group) {
      const head: { text: string; style?: Style }[] = [{ text: minimal ? idText(record) : padEnd(idText(record), idWidth) }];
      if (workflow) head.push({ text: typeText(record) }, { text: phaseText(record) });
      head.push({ text: statusText(record), style: statusStyle(record) });
      if (workflow) head.push({ text: assigneeText(record) });
      if (record.kind === "qa") head.push({ text: sanitize(record.askTo ?? "未設定") });
      lines.push(...packSegments(head, gap, lineWidth, display));
      for (const line of clampLines(titleText(record), Math.max(1, lineWidth - indent), maxLines, display.ellipsis)) lines.push(" ".repeat(indent) + line);
      for (const detail of detailLines(record, display)) lines.push(...indented(detail, indent, lineWidth));
    }
  });
  if (minimal && lines[0] === "") lines.shift();
  return lines;
}

export function renderList(kind: Kind, groups: ListGroup[], display: Display, extra: Issue[] = []): string {
  const out: string[] = [];
  groups.forEach((group, index) => {
    if (index > 0) out.push("");
    const heading = `${sanitize(group.job.job.name)}${kind === "qa" ? " QA" : ""}  ${group.shown.length}件表示 / 全${group.all.length}件`;
    for (const line of wrap(heading, display.width)) out.push(paint(display, line, "bold"));
    if (group.shown.length === 0) out.push("  該当なし");
    else if (display.width === undefined || display.width >= 80) out.push(...tableRows(kind, group.shown, display));
    else out.push(...stackedRows(kind, group.shown, display, display.width < 40));
    out.push(...issueLines(group.issues, display));
  });
  // 案件に属さない診断は最後にまとめる
  out.push(...issueLines(extra, display));
  if (out[0] === "") out.shift();
  return out.join("\n");
}

// frontmatter を除いた本文
export function bodyOf(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return text;
  const close = lines.indexOf("---", 1);
  return close < 0 ? text : lines.slice(close + 1).join("\n").replace(/^\n+/, "");
}

// 工程型のタスクの詳細: 種別・今の工程・要件の版・工程ごとの状態・担当・試行・成果物・直近の履歴
function workflowFields(record: TaskRecord & { workflow: WorkflowInfo }): [string, string][] {
  const { workflow } = record;
  const phases = (workflow.data.workflow ?? {}) as Record<string, Record<string, unknown>>;
  const history = (Array.isArray(workflow.data.history) ? workflow.data.history : []) as Record<string, unknown>[];
  const refText = (refs: unknown) =>
    Array.isArray(refs) && refs.length > 0
      ? refs.map((ref: Record<string, unknown>) => sanitize([ref.path, ref.repo !== undefined ? `${String(ref.repo)}@${String(ref.commit)}` : undefined].filter((value) => value !== undefined).join(" "))).join(", ")
      : "-";
  const fields: [string, string][] = [
    ["形式", `workflowVersion ${workflow.version}${workflow.valid ? "" : " (不整合あり)"}`],
    ["種別", typeText(record)],
    ["工程", record.status === "closed" ? `closed (${sanitize(workflow.closureReason ?? "理由なし")})` : `${phaseText(record)} ${statusText(record)} / 担当 ${assigneeText(record)}`],
    ["要件の版", workflow.requirementRevision === null ? "-" : String(workflow.requirementRevision)],
  ];
  for (const [phase, value] of Object.entries(phases)) {
    if (value === null || typeof value !== "object") continue;
    const parts = [sanitize(String(value.status ?? "未設定")), `試行 ${String(value.attempt ?? "-")}`, `担当 ${value.assignee === null || value.assignee === undefined ? "未割当" : sanitize(String(value.assignee))}`];
    if (value.completedBy) parts.push(`完了 ${sanitize(String(value.completedBy))} ${sanitize(String(value.completedAt ?? ""))} ${sanitize(String(value.outcome ?? ""))}`.trimEnd());
    parts.push(`成果物 ${refText(value.artifactRefs)}`);
    fields.push([`  ${phase}`, parts.join(" / ")]);
  }
  if (workflow.version === 4) {
    if (isAwaitingApproval(record)) fields.push(["待ち", approvalLine(record).replace(/^確認待ち: /, "確認待ち ")]);
    else if (workflow.waiting?.kind === "external") fields.push(["待ち", `外部待ち ${workflow.waiting.blockedBy.map((value) => sanitize(value)).join(", ")}`]);
    const approvers = workflow.approvers;
    fields.push(["判断者の初期値", approvers ? ["plan", "review"].map((phase) => `${phase} ${typeof approvers[phase] === "string" ? sanitize(approvers[phase] as string) : "未割当"}`).join(" / ") : "未割当"]);
    for (const decision of workflow.decisions) {
      const data = decision.data ?? {};
      const parts = [sanitize(String(data.status ?? "読めない")), `判断者 ${data.assignee === null ? "未割当" : sanitize(String(data.assignee ?? "-"))}`];
      if (data.outcome) parts.push(`${sanitize(String(data.outcome))} ${sanitize(String(data.decidedBy ?? ""))} ${sanitize(String(data.decidedAt ?? ""))}`.trimEnd());
      if (data.returnTo) parts.push(`戻す工程 ${sanitize(String(data.returnTo))}`);
      if (decision.current) parts.push("タスクが待っている");
      if (!decision.valid) parts.push("要確認");
      fields.push([`判断記録 ${sanitize(decision.id)}`, parts.join(" / ")]);
    }
  }
  for (const entry of history.slice(-5)) {
    const text = [entry.seq, entry.at, entry.actor, entry.event, entry.phase, entry.outcome, entry.reason].filter((value) => value !== null && value !== undefined).map((value) => sanitize(String(value))).join(" ");
    fields.push(["履歴", text]);
  }
  if (history.length > 5) fields.push(["履歴", `(ほか ${history.length - 5} 件は --json --schema-version ${workflow.version === 4 ? 3 : 2} で見る)`]);
  return fields;
}

export function renderShow(entry: Collected, issues: Issue[], display: Display): string {
  const record = entry.record;
  const out: string[] = [];
  out.push(`${paint(display, idText(record), "bold")}  ${paint(display, statusText(record), statusStyle(record))}`);
  out.push(...wrap(titleText(record), display.width));
  const border = borderLine(display, [display.width ?? Math.max(10, width(titleText(record)))]);
  if (border) out.push(border);
  const fields: [string, string][] = [
    ["案件", sanitize(record.job)],
    ["パス", sanitize(record.path)],
    ["依頼", actorText(record.requestedBy)],
    ["記録", actorText(record.createdBy)],
  ];
  if (isWorkflow(record)) fields.push(...workflowFields(record));
  if (record.kind === "task") {
    fields.push(["日付", `作成 ${dateText(record.createdAt)} / 更新 ${dateText(record.updatedAt)} / 完了 ${dateText(record.completedAt)}`]);
    fields.push(["待ち", record.blockedBy.length > 0 ? record.blockedBy.map((value) => sanitize(value)).join(", ") : "-"]);
  } else {
    fields.push(["確認先", sanitize(record.askTo ?? "未設定")]);
    fields.push(["回答者", record.answeredBy === null ? "-" : actorText(record.answeredBy)]);
    fields.push(["日付", `作成 ${dateText(record.createdAt)} / 更新 ${dateText(record.updatedAt)} / 解決 ${dateText(record.resolvedAt)}`]);
  }
  fields.push(["revision", record.revision ?? "-"]);
  const labelWidth = Math.max(...fields.map(([label]) => width(label)));
  for (const [label, value] of fields) {
    const lines = wrap(value, display.width === undefined ? undefined : Math.max(10, display.width - labelWidth - 2));
    out.push(`${padEnd(label, labelWidth)}  ${lines[0]}`);
    for (const line of lines.slice(1)) out.push(`${" ".repeat(labelWidth + 2)}${line}`);
  }
  out.push("");
  if (entry.text === undefined) out.push("(index.md を読み取れません)");
  else out.push(...wrap(sanitize(bodyOf(entry.text), true).replace(/\n+$/, ""), display.width));
  out.push(...issueLines(issues, display));
  return out.join("\n");
}
