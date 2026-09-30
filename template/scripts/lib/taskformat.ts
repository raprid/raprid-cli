// index.md が工程型 (workflowVersion のある) タスクかの判定。一覧 (records.ts)・ID の読み取り (jobs.ts)・書き込みの入口 (task-workflow.ts) で共有する

import { Frontmatter } from "./frontmatter.ts";
import { splitLines } from "./markdown.ts";
import { YamlFrontmatter } from "./yamlfront.ts";

// 工程型 (workflowVersion のある) タスクか。旧形式と取り違えないよう、形式を決められないものは工程型として扱う (R14-2〜R14-4)。
// 文字列の検索では判定しない (引用符・字下げ・エスケープ (\u0056 など) のキーを見落とすため)。パーサが読んだキーで決める。
//   1. 旧形式のパーサで読めれば、そのキーで決める (旧形式のキーは引用符もエスケープも無い名前だけなので、書いたとおりのキーになる)
//   2. 読めなければ YAML として読み、最上位のキー (エスケープを解いた後) で決める
//   3. どちらでも読めなければ、frontmatter に "workflow" (大文字小文字を問わない) かエスケープ (\) があれば、
//      工程型の可能性を除けないので工程型 (読めない) として扱う。YAML のキーが workflowVersion になるには、
//      その綴りか、エスケープで書くしかない (複数行の引用符・折り返しは空白を挟むので綴りにならない)。
//      どちらも無い壊れた frontmatter は、従来どおり旧形式の読み取りの誤り (PARSE_ERROR) として扱う
export function hasWorkflowVersion(text: string): boolean {
  if (splitLines(text)[0] !== "---") return false;
  try {
    return Frontmatter.parse(text, "index.md").has("workflowVersion");
  } catch {
    // 旧形式として読めない (工程型の入れ子・壊れた frontmatter)
  }
  try {
    return Object.prototype.hasOwnProperty.call(YamlFrontmatter.parse(text).data(), "workflowVersion");
  } catch {
    const lines = splitLines(text);
    const close = lines.indexOf("---", 1);
    const block = lines.slice(1, close < 0 ? lines.length : close).join("\n");
    return /workflow/i.test(block) || block.includes("\\");
  }
}
