import { parseArgs, type ParseArgsConfig } from "node:util";
import { UsageError } from "./errors.ts";

type Options = NonNullable<ParseArgsConfig["options"]>;

// 引数の誤りは UsageError (終了コード 2) にまとめる
export function parse<T extends Options>(argv: string[], options: T, usage: string) {
  try {
    return parseArgs({ args: argv, allowPositionals: true, strict: true, options: { ...options, help: { type: "boolean", short: "h" } } });
  } catch (error) {
    throw new UsageError(`${error instanceof Error ? error.message : String(error)}\n${usage}`);
  }
}

export function singleLine(value: string | undefined, label: string, required: boolean): string | undefined {
  if (value === undefined || value === "") {
    if (required) throw new UsageError(`${label}は空でない1行で指定してください`);
    return undefined;
  }
  if (/[\r\n]/.test(value)) throw new UsageError(`${label}は1行で指定してください`);
  return value;
}
