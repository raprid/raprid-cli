// タスク・QA の frontmatter を読み書きする。
//
// 完全な YAML ではなく、雛形が使う構文だけに対応する。
//   key: 値 / key: (空) / key: [] / key: [a, b] / key: の後に "  - 項目" を並べる配列
// 空行とコメント行はそのまま残す。対応外の行があれば推測で変換せずに停止する。
// 書き換えるのは指定した項目の行だけで、未知の項目や並び順、本文は変更しない。

export class FrontmatterError extends Error {}

interface Entry {
  key: string;
  start: number;
  end: number; // 続く配列項目を含む (exclusive)
}

const keyLine = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/;
const itemLine = /^\s+-(?:\s+(.*))?$/;

function stripComment(value: string): string {
  // 引用符の外にある " #" 以降をコメントとして除く
  let quote = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "#" && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i);
    }
  }
  return value;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.at(-1) === trimmed[0]) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export class Frontmatter {
  private lines: string[];
  private body: string;
  private eol: string;

  private constructor(lines: string[], body: string, eol: string) {
    this.lines = lines;
    this.body = body;
    this.eol = eol;
    this.entries(); // 構文を最初に検証する
  }

  static parse(text: string, source = "frontmatter"): Frontmatter {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const all = text.split(/\r?\n/);
    if (all[0] !== "---") throw new FrontmatterError(`frontmatter がありません: ${source}`);
    const close = all.indexOf("---", 1);
    if (close < 0) throw new FrontmatterError(`frontmatter が閉じていません: ${source}`);
    try {
      return new Frontmatter(all.slice(1, close), all.slice(close + 1).join(eol), eol);
    } catch (error) {
      if (error instanceof FrontmatterError) throw new FrontmatterError(`${error.message}: ${source}`);
      throw error;
    }
  }

  private entries(): Entry[] {
    const entries: Entry[] = [];
    let current: Entry | undefined;
    let listOpen = false;
    this.lines.forEach((line, index) => {
      const key = keyLine.exec(line);
      if (key) {
        if (entries.some((entry) => entry.key === key[1])) throw new FrontmatterError(`項目が重複しています (${key[1]})`);
        current = { key: key[1], start: index, end: index + 1 };
        entries.push(current);
        listOpen = stripComment(key[2]).trim() === "";
        return;
      }
      if (itemLine.test(line)) {
        if (!current || !listOpen) throw new FrontmatterError(`対応していない frontmatter の行です (${line})`);
        current.end = index + 1;
        return;
      }
      if (line.trim() === "" || /^\s*#/.test(line)) {
        listOpen = false;
        return;
      }
      throw new FrontmatterError(`対応していない frontmatter の行です (${line})`);
    });
    return entries;
  }

  private find(key: string): Entry | undefined {
    return this.entries().find((entry) => entry.key === key);
  }

  has(key: string): boolean {
    return this.find(key) !== undefined;
  }

  keys(): string[] {
    return this.entries().map((entry) => entry.key);
  }

  // 配列の項目は扱わず、値の文字列だけを返す。未定義なら undefined、空なら ""
  get(key: string): string | undefined {
    const entry = this.find(key);
    if (!entry) return undefined;
    const value = keyLine.exec(this.lines[entry.start])![2];
    return unquote(stripComment(value));
  }

  getList(key: string): string[] | undefined {
    const entry = this.find(key);
    if (!entry) return undefined;
    const inline = stripComment(keyLine.exec(this.lines[entry.start])![2]).trim();
    if (inline.startsWith("[")) {
      if (!inline.endsWith("]")) throw new FrontmatterError(`配列の書式が不正です (${key})`);
      const inner = inline.slice(1, -1).trim();
      return inner === "" ? [] : inner.split(",").map(unquote);
    }
    if (inline !== "") return [unquote(inline)];
    return this.lines
      .slice(entry.start + 1, entry.end)
      .map((line) => unquote(stripComment(itemLine.exec(line)![1] ?? "")))
      .filter((value) => value !== "");
  }

  set(key: string, value: string | string[]): void {
    let rendered: string[];
    if (Array.isArray(value)) {
      rendered = value.length === 0 ? [`${key}: []`] : [`${key}:`, ...value.map((item) => `  - ${item}`)];
    } else {
      rendered = [value === "" ? `${key}:` : `${key}: ${value}`];
    }
    const entry = this.find(key);
    if (entry) this.lines.splice(entry.start, entry.end - entry.start, ...rendered);
    else this.lines.push(...rendered);
  }

  toString(): string {
    return ["---", ...this.lines, "---"].join(this.eol) + this.eol + this.body;
  }
}
