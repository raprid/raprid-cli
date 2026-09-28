// 一覧・詳細の端末表示。罫線はヘッダーの下だけに引き、行ごとの囲みは付けない。
//
//   幅 80 以上 (と非 TTY): 表 / 40〜79: ID・状態の行とタイトルの行 / 40 未満: 最小限の縦配置
//   非 TTY は省略・折返しをせず、既定で罫線と ANSI を出さない (機械利用は --json)。

import { UsageError } from "./errors.ts";
import type { Kind } from "./jobs.ts";
import type { ListGroup } from "./query.ts";
import { type Collected, type Issue, isKnownStatus, type ItemRecord, statusOrder } from "./records.ts";
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

const styles = { bold: [1, 22], dim: [2, 22], red: [31, 39], green: [32, 39], yellow: [33, 39], cyan: [36, 39] } as const;
type Style = keyof typeof styles;

function paint(display: Display, text: string, style: Style | undefined): string {
  if (!display.color || style === undefined || text === "") return text;
  const [open, close] = styles[style];
  return `\u001B[${open}m${text}\u001B[${close}m`;
}

const statusStyles: Record<string, Style> = { progress: "cyan", todo: "green", pending: "yellow", done: "dim", unresolved: "yellow", resolved: "dim" };

function statusStyle(record: ItemRecord): Style {
  return isKnownStatus(record.kind, record.status) ? statusStyles[record.status!] : "red";
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

function statusText(record: ItemRecord): string {
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
  if (record.kind === "task" && record.status === "pending") {
    lines.push(`待ち: ${record.blockedBy.length > 0 ? record.blockedBy.map((value) => sanitize(value)).join(", ") : "（未記入）"}`);
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

function statusGroups(kind: Kind, records: ItemRecord[]): ItemRecord[][] {
  const groups = statusOrder[kind].map((status) => records.filter((record) => record.status === status));
  groups.push(records.filter((record) => !isKnownStatus(kind, record.status)));
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
  const idWidth = Math.max(width("ID"), ...records.map((record) => width(idText(record))));
  const statusWidth = Math.max(width("状態"), ...records.map((record) => width(statusText(record))));
  const askText = (record: ItemRecord) => (record.kind === "qa" ? sanitize(record.askTo ?? "未設定") : "");
  const askWidth = kind === "qa" ? Math.max(width("確認先"), ...records.map((record) => width(askText(record)))) : 0;
  const prefix = idWidth + 2 + statusWidth + 2 + (kind === "qa" ? askWidth + 2 : 0);
  const titleWidth = display.width === undefined ? undefined : Math.max(10, display.width - prefix);
  const maxLines = display.long ? undefined : 2;

  const header = [padEnd("ID", idWidth), padEnd("状態", statusWidth), ...(kind === "qa" ? [padEnd("確認先", askWidth)] : []), "タイトル"].join("  ");
  const titleBorder = titleWidth ?? Math.max(width("タイトル"), ...records.map((record) => width(titleText(record))));
  const border = borderLine(display, [idWidth, statusWidth, ...(kind === "qa" ? [askWidth] : []), titleBorder]);
  const lines = [header.trimEnd(), ...(border ? [border] : [])];

  statusGroups(kind, records).forEach((group, index) => {
    if (index > 0) lines.push("");
    for (const record of group) {
      const titles = clampLines(titleText(record), titleWidth, maxLines, display.ellipsis);
      const cells = [
        padEnd(idText(record), idWidth),
        paint(display, padEnd(statusText(record), statusWidth), statusStyle(record)),
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
  if (!minimal) {
    lines.push(...packSegments([{ text: padEnd("ID", idWidth) }, { text: "状態" }, ...(kind === "qa" ? [{ text: "確認先" }] : [])], "  ", lineWidth, display), "  タイトル");
    const border = borderLine(display, [lineWidth]);
    if (border) lines.push(border);
  }
  const maxLines = display.long ? undefined : 2;
  statusGroups(kind, records).forEach((group, index) => {
    if (index > 0 || minimal) lines.push("");
    for (const record of group) {
      const head: { text: string; style?: Style }[] = [{ text: minimal ? idText(record) : padEnd(idText(record), idWidth) }, { text: statusText(record), style: statusStyle(record) }];
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
