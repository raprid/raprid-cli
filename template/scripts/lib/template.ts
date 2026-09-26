import { readFileSync } from "node:fs";
import { join } from "node:path";
import { yamlScalar } from "./frontmatter.ts";
import { templatesDir } from "./root.ts";

// {{name}} を一度だけ置き換える。値の中の {{...}} は再展開しない
export function render(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{([A-Za-z]+)\}\}/g, (match, key: string) => {
    if (!(key in values)) throw new Error(`雛形の値がありません: ${key}`);
    return values[key];
  });
}

export function renderTemplate(path: string, values: Record<string, string>): string {
  return render(readFileSync(join(templatesDir, path), "utf8"), values);
}

export function blockedByLines(blockedBy: string | undefined): string {
  return blockedBy ? `blockedBy:\n  - ${yamlScalar(blockedBy)}` : "blockedBy: []";
}
