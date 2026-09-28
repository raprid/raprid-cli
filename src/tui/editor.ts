// 複数行の入力欄 (QA の回答用)。カーソルは論理行と grapheme の位置で持ち、表示は幅で折り返す。

import { graphemes, width } from "./text.js";

export interface EditorState {
  lines: string[];
  row: number;
  col: number; // grapheme 単位
}

export const emptyEditor: EditorState = { lines: [""], row: 0, col: 0 };

export function editorText(state: EditorState): string {
  return state.lines.join("\n");
}

export function editorIsBlank(state: EditorState): boolean {
  return editorText(state).trim() === "";
}

// 端末から来た文字を入れる。改行は LF にそろえ、改行とタブ以外の制御文字・エスケープシーケンスは入れない
export function normalizeInput(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\t/g, "  ")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/g, "");
}

export function insertText(state: EditorState, input: string): EditorState {
  const text = normalizeInput(input);
  if (text === "") return state;
  const line = graphemes(state.lines[state.row]);
  const before = line.slice(0, state.col).join("");
  const after = line.slice(state.col).join("");
  const pieces = text.split("\n");
  const lines = [...state.lines];
  if (pieces.length === 1) {
    lines[state.row] = before + pieces[0] + after;
    return { lines, row: state.row, col: state.col + graphemes(pieces[0]).length };
  }
  const last = pieces.at(-1)!;
  lines.splice(state.row, 1, before + pieces[0], ...pieces.slice(1, -1), last + after);
  return { lines, row: state.row + pieces.length - 1, col: graphemes(last).length };
}

export function newline(state: EditorState): EditorState {
  return insertText(state, "\n");
}

export function backspace(state: EditorState): EditorState {
  if (state.col > 0) {
    const line = graphemes(state.lines[state.row]);
    line.splice(state.col - 1, 1);
    const lines = [...state.lines];
    lines[state.row] = line.join("");
    return { lines, row: state.row, col: state.col - 1 };
  }
  if (state.row === 0) return state;
  const lines = [...state.lines];
  const previous = lines[state.row - 1];
  lines.splice(state.row - 1, 2, previous + lines[state.row]);
  return { lines, row: state.row - 1, col: graphemes(previous).length };
}

export type Direction = "left" | "right" | "up" | "down" | "home" | "end";

export function moveCursor(state: EditorState, direction: Direction): EditorState {
  const length = (row: number) => graphemes(state.lines[row]).length;
  switch (direction) {
    case "left":
      if (state.col > 0) return { ...state, col: state.col - 1 };
      return state.row > 0 ? { ...state, row: state.row - 1, col: length(state.row - 1) } : state;
    case "right":
      if (state.col < length(state.row)) return { ...state, col: state.col + 1 };
      return state.row < state.lines.length - 1 ? { ...state, row: state.row + 1, col: 0 } : state;
    case "up":
      return state.row > 0 ? { ...state, row: state.row - 1, col: Math.min(state.col, length(state.row - 1)) } : { ...state, col: 0 };
    case "down":
      return state.row < state.lines.length - 1 ? { ...state, row: state.row + 1, col: Math.min(state.col, length(state.row + 1)) } : { ...state, col: length(state.row) };
    case "home":
      return { ...state, col: 0 };
    case "end":
      return { ...state, col: length(state.row) };
  }
}

export interface VisualRow {
  before: string; // カーソルより前
  cursor: string | undefined; // カーソル位置の文字 (行末なら空白、カーソルの無い行は undefined)
  after: string;
}

// 幅で折り返し、カーソルが見える範囲の height 行を返す
export function layoutEditor(state: EditorState, limit: number, height: number): VisualRow[] {
  const size = Math.max(2, limit);
  const rows: { parts: string[]; row: number; start: number }[] = [];
  state.lines.forEach((line, row) => {
    const parts = graphemes(line);
    let start = 0;
    let used = 0;
    let current: string[] = [];
    parts.forEach((part, index) => {
      const cell = width(part);
      if (used + cell > size - 1 && current.length > 0) {
        rows.push({ parts: current, row, start });
        start = index;
        current = [];
        used = 0;
      }
      current.push(part);
      used += cell;
    });
    rows.push({ parts: current, row, start });
  });
  // カーソルのある表示行: 同じ論理行で start <= col の最後の行
  let cursorRow = 0;
  rows.forEach((visual, index) => {
    if (visual.row === state.row && visual.start <= state.col) cursorRow = index;
  });
  const top = Math.max(0, Math.min(cursorRow - height + 1, rows.length - height));
  return rows.slice(Math.max(0, top), Math.max(0, top) + Math.max(1, height)).map((visual, offset) => {
    const index = Math.max(0, top) + offset;
    if (index !== cursorRow) return { before: visual.parts.join(""), cursor: undefined, after: "" };
    const at = state.col - visual.start;
    return { before: visual.parts.slice(0, at).join(""), cursor: visual.parts[at] ?? " ", after: visual.parts.slice(at + 1).join("") };
  });
}
