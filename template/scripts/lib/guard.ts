// 更新の前提を確かめる処理 (guarded-write-v1)。
//   --if-match: ロック内で読み取った index.md の revision (SHA-256) が一致しなければ何も変えずに止める
//   --answer-file: 複数行の回答を検証して読み込む

import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { CliError, UsageError } from "./errors.ts";

export function revisionOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseIfMatch(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9a-f]{64}$/.test(value)) throw new UsageError(`--if-match には revision (64 桁の小文字 16 進数) を指定してください: ${value}`);
  return value;
}

export function assertRevision(expected: string | undefined, bytes: Buffer, path: string): void {
  if (expected === undefined) return;
  const actual = revisionOf(bytes);
  if (actual !== expected) {
    throw new CliError(`他の変更と競合したため更新しませんでした (revision が一致しません): ${path}\n再読み込みして内容を確認してください (現在: ${actual})`, 1, "REVISION_CONFLICT");
  }
}

export const answerLimit = 1024 * 1024;
export const answerBegin = "<!-- raprid:answer:begin -->";
export const answerEnd = "<!-- raprid:answer:end -->";

function invalid(message: string): CliError {
  return new CliError(message, 2, "INVALID_ANSWER");
}

// path が "-" なら標準入力。上限を超えたら読み切らずに止める
function readLimited(path: string): Buffer {
  const fd = path === "-" ? 0 : openSync(path, "r");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = Buffer.alloc(64 * 1024);
      let read: number;
      try {
        read = readSync(fd, chunk, 0, chunk.length, null);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EAGAIN") continue;
        if ((error as NodeJS.ErrnoException).code === "EOF") break;
        throw error;
      }
      if (read === 0) break;
      total += read;
      if (total > answerLimit) throw invalid(`回答が大きすぎます (上限 ${answerLimit} バイト)`);
      chunks.push(chunk.subarray(0, read));
    }
  } finally {
    if (fd !== 0) closeSync(fd);
  }
  return Buffer.concat(chunks);
}

// 最後まで閉じられていないフェンス (``` / ~~~) があるか。markdown.ts の fencedLines と同じ規則
function unclosedFence(lines: string[]): boolean {
  let fence: { char: string; length: number } | undefined;
  for (const line of lines) {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (match && match[1][0] === fence.char && match[1].length >= fence.length && line.trim() === match[1]) fence = undefined;
    } else if (match) {
      fence = { char: match[1][0], length: match[1].length };
    }
  }
  return fence !== undefined;
}

// 回答を読み、UTF-8・空でない・閉じたコードブロック・区切り行を含まないことを確かめ、改行を LF にする
export function readAnswer(path: string): string {
  let bytes: Buffer;
  try {
    bytes = readLimited(path);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw invalid(`回答を読み取れません: ${path} (${(error as NodeJS.ErrnoException).code ?? String(error)})`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid("回答が UTF-8 ではありません");
  }
  text = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  if (text.trim() === "") throw invalid("回答が空です");
  const lines = text.split("\n");
  if (lines.some((line) => line.trim() === answerBegin || line.trim() === answerEnd)) throw invalid("回答に区切りの行 (raprid:answer) は使えません");
  if (unclosedFence(lines)) throw invalid("回答のコードブロックが閉じていません");
  return text;
}
