// 端末表示用の文字列処理: 制御文字の除去・セル幅の計測・grapheme 境界での折返し。
// 幅は string-width (scripts/vendor/ の同梱版) で測り、日本語・絵文字・結合文字を 1 文字ずつ数えない。

import { stringWidth } from "../vendor/text-width.mjs";

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

// CSI・OSC などのエスケープシーケンス (ESC / C1 の CSI・OSC から始まるもの)
const escapeSequence = /(?:\u001B\][^\u0007\u001B\u009C]*(?:\u0007|\u001B\\|\u009C)?|\u009D[^\u0007\u001B\u009C]*(?:\u0007|\u001B\\|\u009C)?|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]|\u001B[@-Z\\-_])/g;
// 改行・タブ以外の制御文字と、表示順を入れ替える双方向制御文字
const controlChars = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/g;

// 端末へ流す前に除去する。multiline でなければ改行も空白にする
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

export function padEnd(value: string, size: number): string {
  return value + " ".repeat(Math.max(0, size - width(value)));
}

// 幅 limit ごとに grapheme 境界で分ける。改行は保つ。limit が無ければ行分割だけ
export function wrap(value: string, limit: number | undefined): string[] {
  const out: string[] = [];
  for (const line of value.split("\n")) {
    if (limit === undefined || width(line) <= limit) {
      out.push(line);
      continue;
    }
    let current = "";
    let used = 0;
    for (const part of graphemes(line)) {
      const size = width(part);
      if (used + size > limit && current !== "") {
        out.push(current.replace(/\s+$/, ""));
        current = "";
        used = 0;
        if (part.trim() === "") continue; // 行頭の空白は落とす
      }
      current += part;
      used += size;
    }
    out.push(current);
  }
  return out;
}

// 幅 limit に収まるよう末尾を省略記号に置き換える。force なら収まっていても省略記号を付ける
export function truncate(value: string, limit: number, ellipsis: string, force = false): string {
  if (!force && width(value) <= limit) return value;
  if (force && width(value) + width(ellipsis) <= limit) return value + ellipsis;
  const room = Math.max(0, limit - width(ellipsis));
  let current = "";
  let used = 0;
  for (const part of graphemes(value)) {
    const size = width(part);
    if (used + size > room) break;
    current += part;
    used += size;
  }
  return current.replace(/\s+$/, "") + ellipsis;
}

// 折り返して最大 maxLines 行に収める。超える分は最終行を省略記号で終える
export function clampLines(value: string, limit: number | undefined, maxLines: number | undefined, ellipsis: string): string[] {
  const lines = wrap(value, limit);
  if (maxLines === undefined || lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1];
  kept[maxLines - 1] = limit === undefined ? last + ellipsis : truncate(last, limit, ellipsis, true);
  return kept;
}
