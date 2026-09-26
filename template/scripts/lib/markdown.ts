// コードブロックを考慮して Markdown の見出しと節を扱う。
// コードブロック内の "## " は見出しとして扱わない。

export interface Heading {
  line: number;
  level: number;
  text: string;
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

// 各行がコードブロック内 (開始・終了のフェンス行を含む) かどうか
export function fencedLines(lines: string[]): boolean[] {
  const result: boolean[] = [];
  let fence: { char: string; length: number } | undefined;
  for (const line of lines) {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      result.push(true);
      if (match && match[1][0] === fence.char && match[1].length >= fence.length && line.trim() === match[1]) {
        fence = undefined;
      }
    } else if (match) {
      result.push(true);
      fence = { char: match[1][0], length: match[1].length };
    } else {
      result.push(false);
    }
  }
  return result;
}

export function headings(lines: string[]): Heading[] {
  const fenced = fencedLines(lines);
  const result: Heading[] = [];
  lines.forEach((line, index) => {
    if (fenced[index]) return;
    const match = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (match) result.push({ line: index, level: match[1].length, text: match[2].replace(/\s+#+$/, "") });
  });
  return result;
}

// 見出しから次の同階層以上の見出しの手前まで。[見出し行, 終端) を返す
export function findSection(lines: string[], level: number, text: string): { start: number; end: number } | undefined {
  const all = headings(lines);
  const index = all.findIndex((heading) => heading.level === level && heading.text === text);
  if (index < 0) return undefined;
  const next = all.slice(index + 1).find((heading) => heading.level <= level);
  return { start: all[index].line, end: next ? next.line : lines.length };
}

// 節の最初の空でない行 (コードブロック外)
export function firstLine(text: string, level: number, heading: string): string | undefined {
  const lines = splitLines(text);
  const section = findSection(lines, level, heading);
  if (!section) return undefined;
  const fenced = fencedLines(lines);
  for (let i = section.start + 1; i < section.end; i++) {
    if (!fenced[i] && lines[i].trim() !== "") return lines[i].trim();
  }
  return undefined;
}

// 節の末尾 (後続の空行の手前) に行を追加する。節が無ければ文書の末尾に節を作る
export function appendToSection(text: string, level: number, heading: string, added: string[]): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = splitLines(text);
  const section = findSection(lines, level, heading);
  if (!section) {
    while (lines.length > 0 && lines.at(-1) === "") lines.pop();
    return [...lines, "", `${"#".repeat(level)} ${heading}`, "", ...added, ""].join(eol);
  }
  let insertAt = section.end;
  while (insertAt > section.start + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  // 見出しの直後なら空行を1つ挟む
  const lead = insertAt === section.start + 1 ? [""] : [];
  const trail = after.length > 0 && after[0].trim() !== "" ? [""] : after.length === 0 ? [""] : [];
  return [...before, ...lead, ...added, ...trail, ...after].join(eol);
}
