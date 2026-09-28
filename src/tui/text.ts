// 端末へ出す文字列の処理。制御文字を流さず、セル幅と grapheme 境界で折り返す。

import stringWidth from "string-width";

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const escapeSequence = /(?:\u001B\][^\u0007\u001B\u009C]*(?:\u0007|\u001B\\|\u009C)?|\u009D[^\u0007\u001B\u009C]*(?:\u0007|\u001B\\|\u009C)?|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]|\u001B[@-Z\\-_])/g;
const controlChars = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/g;

export function sanitize(value: string, multiline = false): string {
  let text = value.replace(/\r\n?/g, "\n").replace(escapeSequence, "").replace(/\t/g, "  ").replace(controlChars, "");
  if (!multiline) text = text.replace(/\n+/g, " ");
  return text;
}

export function width(value: string): number {
  return stringWidth(value);
}

export function graphemes(value: string): string[] {
  return Array.from(segmenter.segment(value), (part) => part.segment);
}

export function wrap(value: string, limit: number): string[] {
  const out: string[] = [];
  const size = Math.max(1, limit);
  for (const line of value.split("\n")) {
    if (width(line) <= size) {
      out.push(line);
      continue;
    }
    let current = "";
    let used = 0;
    for (const part of graphemes(line)) {
      const cell = width(part);
      if (used + cell > size && current !== "") {
        out.push(current);
        current = "";
        used = 0;
      }
      current += part;
      used += cell;
    }
    out.push(current);
  }
  return out;
}

export function truncate(value: string, limit: number, ellipsis = "…"): string {
  if (width(value) <= limit) return value;
  const room = Math.max(0, limit - width(ellipsis));
  let current = "";
  let used = 0;
  for (const part of graphemes(value)) {
    const cell = width(part);
    if (used + cell > room) break;
    current += part;
    used += cell;
  }
  return current + ellipsis;
}

export function padEnd(value: string, size: number): string {
  return value + " ".repeat(Math.max(0, size - width(value)));
}

export interface Line {
  text: string;
  bold?: boolean;
  dim?: boolean;
  color?: string;
}

// Markdown を読みやすい平文の行にする。見出しは記号を外して太字、コードブロックは淡色でそのまま
export function markdownLines(markdown: string): Line[] {
  const lines: Line[] = [];
  let fence: string | undefined;
  for (const raw of sanitize(markdown, true).split("\n")) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
    if (fence) {
      lines.push({ text: raw, dim: true });
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && raw.trim() === fenceMatch[1]) fence = undefined;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      lines.push({ text: raw, dim: true });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
    if (heading) {
      lines.push({ text: inline(heading[2]), bold: true });
      continue;
    }
    lines.push({ text: inline(raw) });
  }
  while (lines.length > 0 && lines.at(-1)!.text.trim() === "") lines.pop();
  return lines;
}

function inline(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\(([^)\s]*)\)/g, (_, label: string, url: string) => (label && label !== url ? `${label} <${url}>` : `<${url}>`))
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1");
}

export function bodyOf(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  if (lines[0] !== "---") return markdown;
  const close = lines.indexOf("---", 1);
  return close < 0 ? markdown : lines.slice(close + 1).join("\n").replace(/^\n+/, "");
}

// 行を幅に合わせて折り返す (書式は折り返した各行に引き継ぐ)
export function wrapLines(lines: Line[], limit: number): Line[] {
  return lines.flatMap((line) => wrap(line.text, limit).map((text) => ({ ...line, text })));
}
