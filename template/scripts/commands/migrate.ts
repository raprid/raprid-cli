// 旧構成 (job/<案件名>/list/<タスク名>.md など) を jobs/ の構成へ移す。
//
//   raprid job migrate [--dry-run]              変換計画を表示するだけ (既定)
//   raprid job migrate --apply [--plan <hash>]  計画を実行する
//   raprid job migrate --restore <移行ID>       移行前の状態に戻す
//
// 作業ツリーの内容 (未コミットの変更を含む) を入力にする。実行時は変更する既存ファイルと旧 job/ を
// .raprid-migrate/<移行ID>/backup/ に退避し、手順ごとに journal.json へ記録する。
// 途中で失敗したらこの実行で変えたものだけを戻す。移行後の再実行は何も変更しない。

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, posix } from "node:path";
import { parse } from "../lib/args.ts";
import { CliError, UsageError } from "../lib/errors.ts";
import { Frontmatter } from "../lib/frontmatter.ts";
import { exists, isDirectory, isFile, lstatOrUndefined } from "../lib/fsutil.ts";
import { qaStatuses, taskStatuses, validateJobName } from "../lib/jobs.ts";
import { fencedLines, findSection, headings, splitLines } from "../lib/markdown.ts";
import { projectRoot, scriptsDir, scriptsInfo, templatesDir } from "../lib/root.ts";

export const usage = `使い方:
  raprid job migrate [--dry-run]               変換計画を表示する (既定。何も変更しない)
  raprid job migrate --apply [--plan <hash>]   計画を実行する。--plan を付けると表示した計画と一致する場合だけ実行する
  raprid job migrate --restore <移行ID>        .raprid-migrate/<移行ID>/ の退避から移行前の状態に戻す

旧構成:  job/<案件>/list/<タスク>.md、job/<案件>/qa/list/<QA>.md、job/<案件>/assets/<タスク>/、job/*.sh
新構成:  jobs/<案件>/tasks/<タスク>/{index.md,NN-<詳細>.md,assets/}、jobs/<案件>/qa/<QA>/index.md、scripts/

タスクの「## ログ」はフェーズ (###) ごとの詳細 md に分け、index.md の「## 詳細」からリンクする。
Markdown のリンクは移動先に合わせて書き換える。本文中のコマンド例や引用の旧パスは書き換えず、一覧だけ表示する。
移行前の状態は .raprid-migrate/<移行ID>/ に残る。確認が済んだら削除してよい。`;

const oldScripts = new Set(["add-task.sh", "add-qa.sh", "list-task.sh", "list-qa.sh", "task-transition.sh", "qa-transition.sh"]);
const ignorable = new Set([".DS_Store"]);
const namePattern = /^[a-z0-9][a-z0-9-]*$/;
const skipDirs = new Set([".git", "node_modules", ".raprid-migrate", ".obsidian", ".trash"]);

type Op =
  | { kind: "file"; to: string; content: Buffer; mode: number }
  | { kind: "link"; to: string; target: string };

interface Rewrite {
  path: string; // root からの相対パス (job/ の外)
  content: string;
  mode: number;
  created: boolean;
}

interface Plan {
  root: string;
  ops: Op[]; // jobs/ 配下に作るもの
  installScripts: boolean;
  rewrites: Rewrite[];
  mappings: string[];
  drops: string[];
  warnings: string[];
  pending: string[];
  counts: Record<string, number>;
  sources: Record<string, string>;
  hash: string;
}

interface Journal {
  id: string;
  state: "started" | "completed" | "rolled-back" | "restored";
  jobsCreated: boolean;
  scriptsCreated: boolean;
  jobMoved: boolean;
  rewritten: { path: string; created: boolean }[];
  after: Record<string, string>;
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

interface Entry {
  rel: string;
  type: "file" | "symlink" | "dir";
}

function walk(root: string, rel: string, options: { skip?: (rel: string) => boolean } = {}): Entry[] {
  const out: Entry[] = [];
  const dir = join(root, rel);
  for (const name of readdirSync(dir).sort()) {
    const childRel = rel ? `${rel}/${name}` : name;
    if (options.skip?.(childRel)) continue;
    const stat = lstatSync(join(root, childRel));
    if (stat.isSymbolicLink()) out.push({ rel: childRel, type: "symlink" });
    else if (stat.isDirectory()) {
      out.push({ rel: childRel, type: "dir" });
      out.push(...walk(root, childRel, options));
    } else if (stat.isFile()) out.push({ rel: childRel, type: "file" });
    else throw new CliError(`扱えない種類のファイルです: ${childRel}`);
  }
  return out;
}

// ---------------------------------------------------------------- パスの対応

type Mapped = { to: string } | { dropped: true } | undefined;

class PathMap {
  private files = new Map<string, string>();
  private prefixes: [string, string][] = [];
  private dropped: string[] = [];

  file(from: string, to: string): void {
    this.files.set(from, to);
  }

  prefix(from: string, to: string): void {
    this.prefixes.push([from, to]);
    this.prefixes.sort((a, b) => b[0].length - a[0].length);
  }

  drop(from: string): void {
    this.dropped.push(from);
  }

  map(path: string): Mapped {
    const exact = this.files.get(path);
    if (exact) return { to: exact };
    if (this.dropped.some((drop) => path === drop || path.startsWith(`${drop}/`))) return { dropped: true };
    for (const [from, to] of this.prefixes) {
      if (path === from) return { to };
      if (path.startsWith(`${from}/`)) return { to: to + path.slice(from.length) };
    }
    return undefined;
  }
}

// ---------------------------------------------------------------- Markdown の変換

function asciiSlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function trimBlank(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end);
}

function shiftHeadings(lines: string[], by: number): string[] {
  const fenced = fencedLines(lines);
  return lines.map((line, index) => {
    if (fenced[index]) return line;
    const match = /^(#{1,6})(\s.*)$/.exec(line);
    if (!match) return line;
    return "#".repeat(Math.max(2, match[1].length - by)) + match[2];
  });
}

interface Split {
  index: string;
  details: { file: string; content: string }[];
  notes: string[];
}

// 「## ログ」をフェーズ (###) ごとの詳細 md に分け、index には「## 詳細」とリンクを置く
export function splitTask(text: string, label: string): Split {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = splitLines(text);
  const section = findSection(lines, 2, "ログ");
  if (!section) return { index: text, details: [], notes: [] };
  if (findSection(lines, 2, "詳細")) {
    return { index: text, details: [], notes: [`手動確認: 「## ログ」と「## 詳細」が両方あるため分割しない: ${label}`] };
  }
  const notes: string[] = [];
  const inner = lines.slice(section.start + 1, section.end);
  const phases = headings(inner).filter((heading) => heading.level === 3);
  const details: Split["details"] = [];
  const links: string[] = [];
  let preamble = trimBlank(inner);
  if (phases.length === 0) {
    if (preamble.length > 0) {
      details.push({ file: "01-log.md", content: ["# ログ", "", ...preamble, ""].join(eol) });
      links.push("* [ログ](01-log.md)");
      notes.push(`手動確認: フェーズ見出しの無いログを 01-log.md に保存: ${label}`);
    }
    preamble = [];
  } else {
    preamble = trimBlank(inner.slice(0, phases[0].line));
    const used = new Set<string>();
    phases.forEach((phase, index) => {
      const end = index + 1 < phases.length ? phases[index + 1].line : inner.length;
      const body = trimBlank(inner.slice(phase.line + 1, end));
      const meaningful = body.some((line) => line.trim() !== "" && !/^#{1,6}(\s|$)/.test(line));
      if (!meaningful) {
        notes.push(`空のフェーズを省略: ${label} (${phase.text})`);
        return;
      }
      const number = details.length + 1;
      let slug = asciiSlug(phase.text);
      if (!/[a-z]/.test(slug)) slug = `phase${number}`;
      if (used.has(slug)) slug = `${slug}-${number}`;
      used.add(slug);
      const file = `${String(number).padStart(2, "0")}-${slug}.md`;
      details.push({ file, content: [`# ${phase.text}`, "", ...shiftHeadings(body, 2), ""].join(eol) });
      links.push(`* [${phase.text.replace(/[[\]]/g, "\\$&")}](${file})`);
    });
  }
  const replacement = ["## 詳細", "", ...(preamble.length > 0 ? [...preamble, ""] : []), ...(links.length > 0 ? [...links, ""] : [])];
  const after = lines.slice(section.end);
  const index = [...lines.slice(0, section.start), ...replacement, ...after].join(eol);
  return { index, details, notes };
}

const linkPattern = /(\]\()(<[^>\n]*>|[^)\s]+)((?:\s+"[^"\n]*")?\))/g;
const referencePattern = /^(\s{0,3}\[[^\]\n]+\]:\s*)(<[^>\n]*>|\S+)(.*)$/;

interface LinkContext {
  map: PathMap;
  oldLocation: string; // このファイルの移行前の場所 (root からの相対)
  newLocation: string;
  splitTargets: Set<string>;
  warnings: string[];
  count: { value: number };
}

function rewriteTarget(raw: string, context: LinkContext): string {
  const bracketed = raw.startsWith("<") && raw.endsWith(">");
  const target = bracketed ? raw.slice(1, -1) : raw;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith("#") || target.startsWith("/") || target === "") return raw;
  const hashAt = target.search(/[#?]/);
  const pathPart = hashAt >= 0 ? target.slice(0, hashAt) : target;
  const suffix = hashAt >= 0 ? target.slice(hashAt) : "";
  if (pathPart === "") return raw;
  let decoded = pathPart;
  const encoded = /%[0-9A-Fa-f]{2}/.test(pathPart);
  if (encoded) {
    try {
      decoded = decodeURI(pathPart);
    } catch {
      return raw;
    }
  }
  const oldTarget = posix.normalize(posix.join(posix.dirname(context.oldLocation), decoded));
  if (oldTarget.startsWith("../") || oldTarget === "..") return raw;
  const mapped = context.map.map(oldTarget.replace(/\/$/, ""));
  if (mapped && "dropped" in mapped) {
    context.warnings.push(`移行しない旧ファイルへのリンク: ${context.newLocation} -> ${target}`);
    return raw;
  }
  const newTarget = mapped ? mapped.to : oldTarget.replace(/\/$/, "");
  if (!mapped && context.oldLocation === context.newLocation) return raw;
  let relativePath = posix.relative(posix.dirname(context.newLocation), newTarget) || ".";
  if (decoded.endsWith("/") && !relativePath.endsWith("/")) relativePath += "/";
  if (relativePath === decoded) return raw;
  if (suffix.startsWith("#") && context.splitTargets.has(oldTarget)) {
    context.warnings.push(`アンカー要確認 (ログを分割したタスク): ${context.newLocation} -> ${target}`);
  }
  const rendered = (encoded ? encodeURI(relativePath) : relativePath) + suffix;
  context.count.value++;
  return bracketed || /\s/.test(rendered) ? `<${rendered}>` : rendered;
}

export function rewriteLinks(text: string, context: LinkContext): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = splitLines(text);
  const fenced = fencedLines(lines);
  // frontmatter は書き換えない
  let frontmatterEnd = -1;
  if (lines[0] === "---") frontmatterEnd = lines.indexOf("---", 1);
  return lines
    .map((line, index) => {
      if (fenced[index] || index <= frontmatterEnd) return line;
      const reference = referencePattern.exec(line);
      if (reference) return reference[1] + rewriteTarget(reference[2], context) + reference[3];
      return line.replace(linkPattern, (_match, open: string, target: string, close: string) => open + rewriteTarget(target, context) + close);
    })
    .join(eol);
}

// ---------------------------------------------------------------- 計画

function markdownFiles(root: string): string[] {
  const skip = (rel: string) => {
    const name = rel.split("/").at(-1)!;
    if (skipDirs.has(name)) return true;
    if (/^repos\/[^/]+\/(repo|\.worktrees)$/.test(rel)) return true;
    return false;
  };
  return walk(root, "", { skip })
    .filter((entry) => entry.type === "file" && entry.rel.endsWith(".md") && !entry.rel.startsWith("job/"))
    .map((entry) => entry.rel);
}

function fileMode(path: string): number {
  return lstatSync(path).mode & 0o777;
}

export function buildPlan(root: string, sourceScripts = scriptsDir): Plan {
  const jobRoot = join(root, "job");
  const ops: Op[] = [];
  const map = new PathMap();
  const warnings: string[] = [];
  const pending: string[] = [];
  const errors: string[] = [];
  const mappings: string[] = [];
  const drops: string[] = [];
  const counts: Record<string, number> = { jobs: 0, tasks: 0, details: 0, qa: 0, assetDirs: 0, links: 0, linkFiles: 0 };
  const sources: Record<string, string> = {};
  const splitTargets = new Set<string>();
  // job/ 内の Markdown は移動先を決めてからリンクを書き換える
  const deferred: { from: string; to: string; content: string; mode: number; split?: boolean }[] = [];

  const entries = walk(root, "job");
  for (const entry of entries) {
    const full = join(root, entry.rel);
    if (entry.type === "file") sources[entry.rel] = sha256(readFileSync(full));
    if (entry.type === "symlink") sources[entry.rel] = `link:${readlinkSync(full)}`;
  }

  const addFile = (to: string, from: string) => {
    ops.push({ kind: "file", to, content: readFileSync(join(root, from)), mode: fileMode(join(root, from)) });
  };

  map.prefix("job", "jobs");
  for (const name of readdirSync(jobRoot).sort()) {
    const rel = `job/${name}`;
    const stat = lstatSync(join(root, rel));
    if (ignorable.has(name)) {
      drops.push(rel);
      map.drop(rel);
    } else if (stat.isFile() && oldScripts.has(name)) {
      drops.push(rel);
      map.drop(rel);
    } else if (name === "template" && stat.isDirectory()) {
      drops.push(`${rel}/`);
      map.drop(rel);
    } else if (stat.isDirectory() && !stat.isSymbolicLink()) {
      try {
        validateJobName(name);
      } catch (error) {
        errors.push(`案件名として扱えないディレクトリ: ${rel} (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }
      planJob(name);
    } else if (stat.isFile()) {
      map.file(rel, `jobs/${name}`);
      if (name.endsWith(".md")) deferred.push({ from: rel, to: `jobs/${name}`, content: readFileSync(join(root, rel), "utf8"), mode: fileMode(join(root, rel)) });
      else addFile(`jobs/${name}`, rel);
      warnings.push(`案件外のファイルをそのまま移す: ${rel} -> jobs/${name}`);
    } else {
      errors.push(`扱えない種類のファイル: ${rel}`);
    }
  }

  function planJob(job: string): void {
    counts.jobs++;
    const base = `job/${job}`;
    const target = `jobs/${job}`;
    map.prefix(base, target);
    const children = walk(root, base);
    const taskNames = new Set<string>();
    const qaNames = new Set<string>();
    const linksFound: { kind: "task" | "qa"; status: string; name: string; target: string; rel: string }[] = [];

    // タスクと QA の実体
    const collect = (kind: "task" | "qa", listRel: string) => {
      const names = kind === "task" ? taskNames : qaNames;
      if (!isDirectory(join(root, listRel))) return;
      for (const name of readdirSync(join(root, listRel)).sort()) {
        const rel = `${listRel}/${name}`;
        const stat = lstatSync(join(root, rel));
        if (ignorable.has(name)) continue;
        if (name === "template.md" && stat.isFile()) {
          drops.push(rel);
          map.drop(rel);
          continue;
        }
        const itemName = name.replace(/\.md$/, "");
        if (!stat.isFile() || !name.endsWith(".md")) errors.push(`分類できないファイル: ${rel}`);
        else if (!namePattern.test(itemName) || (kind === "qa" && itemName === "status")) errors.push(`${kind === "task" ? "タスク" : "QA"}名として扱えないファイル: ${rel}`);
        else names.add(itemName);
      }
    };
    collect("task", `${base}/list`);
    collect("qa", `${base}/qa/list`);

    // 固定 ID・状態・frontmatter を検証する
    const validate = (kind: "task" | "qa", names: Set<string>, listRel: string) => {
      const pattern = kind === "task" ? /^T-\d{3,}$/ : /^Q-\d{3,}$/;
      const statuses: readonly string[] = kind === "task" ? taskStatuses : qaStatuses;
      const ids = new Map<string, string>();
      const status = new Map<string, string>();
      for (const name of names) {
        const rel = `${listRel}/${name}.md`;
        try {
          const fm = Frontmatter.parse(readFileSync(join(root, rel), "utf8"), rel);
          const id = fm.get("id") ?? "";
          const state = fm.get("status") ?? "";
          if (!pattern.test(id)) errors.push(`IDが未設定または不正: ${rel} (${id || "未設定"})`);
          else if (ids.has(id)) errors.push(`ID重複: ${id} (${ids.get(id)}, ${rel})`);
          else ids.set(id, rel);
          if (!statuses.includes(state)) errors.push(`statusが不正: ${rel} (${state || "未設定"})`);
          status.set(name, state);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      return status;
    };
    const taskStatus = validate("task", taskNames, `${base}/list`);
    const qaStatus = validate("qa", qaNames, `${base}/qa/list`);

    // 旧索引は検査だけ行い、新しい索引は frontmatter から作り直す
    const scanLinks = (kind: "task" | "qa", statusRel: string, statuses: readonly string[]) => {
      if (!isDirectory(join(root, statusRel))) return;
      for (const name of readdirSync(join(root, statusRel)).sort()) {
        const dirRel = `${statusRel}/${name}`;
        if (ignorable.has(name)) continue;
        if (!statuses.includes(name) || !lstatSync(join(root, dirRel)).isDirectory()) {
          errors.push(`分類できないファイル: ${dirRel}`);
          continue;
        }
        for (const file of readdirSync(join(root, dirRel)).sort()) {
          const rel = `${dirRel}/${file}`;
          if (file === ".gitkeep" || ignorable.has(file)) continue;
          const stat = lstatSync(join(root, rel));
          if (!stat.isSymbolicLink()) {
            errors.push(`状態索引にリンク以外があります: ${rel}`);
            continue;
          }
          const itemName = file.replace(/\.md$/, "");
          linksFound.push({ kind, status: name, name: itemName, target: readlinkSync(join(root, rel)), rel });
          map.file(rel, kind === "task" ? `${target}/tasks/${itemName}/index.md` : `${target}/qa/${itemName}/index.md`);
        }
      }
    };
    scanLinks("task", `${base}/status`, taskStatuses);
    scanLinks("qa", `${base}/qa/status`, qaStatuses);

    const report = (kind: "task" | "qa", names: Set<string>, status: Map<string, string>) => {
      for (const name of names) {
        const found = linksFound.filter((link) => link.kind === kind && link.name === name);
        const label = `${base}/${kind === "task" ? "list" : "qa/list"}/${name}.md`;
        if (found.length === 0) warnings.push(`旧索引なし (新しい索引は status から作る): ${label} (status: ${status.get(name) || "未設定"})`);
        if (found.length > 1) warnings.push(`旧索引が複数: ${label} (${found.map((link) => link.status).join(", ")})`);
        for (const link of found) {
          if (link.status !== status.get(name)) warnings.push(`旧索引の不一致 (status を正とする): ${label} (索引: ${link.status}, status: ${status.get(name) || "未設定"})`);
          if (link.target !== `../../list/${name}.md`) warnings.push(`旧索引のリンク先が不正: ${link.rel} -> ${link.target}`);
        }
      }
      for (const link of linksFound.filter((candidate) => candidate.kind === kind && !names.has(candidate.name))) {
        warnings.push(`実体のない旧索引 (移さない): ${link.rel} -> ${link.target}`);
      }
    };
    report("task", taskNames, taskStatus);
    report("qa", qaNames, qaStatus);

    // 対応表
    for (const name of taskNames) {
      map.file(`${base}/list/${name}.md`, `${target}/tasks/${name}/index.md`);
      splitTargets.add(`${base}/list/${name}.md`);
      mappings.push(`${base}/list/${name}.md -> ${target}/tasks/${name}/index.md`);
    }
    for (const name of qaNames) {
      map.file(`${base}/qa/list/${name}.md`, `${target}/qa/${name}/index.md`);
      mappings.push(`${base}/qa/list/${name}.md -> ${target}/qa/${name}/index.md`);
    }
    map.prefix(`${base}/list`, `${target}/tasks`);
    map.prefix(`${base}/qa/list`, `${target}/qa`);
    counts.tasks += taskNames.size;
    counts.qa += qaNames.size;

    // 成果物: タスク名と一致するものはタスク内へ、それ以外は案件共通に残す
    const assetsRel = `${base}/assets`;
    if (isDirectory(join(root, assetsRel))) {
      for (const name of readdirSync(join(root, assetsRel)).sort()) {
        const rel = `${assetsRel}/${name}`;
        if (ignorable.has(name)) continue;
        const stat = lstatSync(join(root, rel));
        if (taskNames.has(name) && stat.isDirectory() && !stat.isSymbolicLink()) {
          map.prefix(rel, `${target}/tasks/${name}/assets`);
          mappings.push(`${rel}/ -> ${target}/tasks/${name}/assets/`);
          counts.assetDirs++;
        } else if (name !== ".gitkeep") {
          warnings.push(`案件共通の assets に残す: ${rel} -> ${target}/assets/${name}`);
        }
      }
    }

    // job/<案件>/ 内のファイルを移動先へ
    for (const entry of children) {
      if (entry.type === "dir") continue;
      const rel = entry.rel;
      const name = basename(rel);
      if (ignorable.has(name)) continue;
      if (rel.startsWith(`${base}/status/`) || rel.startsWith(`${base}/qa/status/`)) continue;
      if (rel === `${base}/list/template.md` || rel === `${base}/qa/list/template.md`) continue;
      const mapped = map.map(rel);
      if (!mapped || "dropped" in mapped) continue;
      if (rel.startsWith(`${base}/list/`) || rel.startsWith(`${base}/qa/list/`)) {
        const kind = rel.startsWith(`${base}/list/`) ? "task" : "qa";
        const itemName = name.replace(/\.md$/, "");
        if (!(kind === "task" ? taskNames : qaNames).has(itemName)) continue;
        const text = readFileSync(join(root, rel), "utf8");
        // タスクはリンクを書き換えてから分割する (詳細 md は index.md と同じディレクトリに置く)
        deferred.push({ from: rel, to: mapped.to, content: text, mode: fileMode(join(root, rel)), split: kind === "task" });
        continue;
      }
      if (entry.type === "symlink") {
        const linkTarget = readlinkSync(join(root, rel));
        ops.push({ kind: "link", to: mapped.to, target: linkTarget });
        warnings.push(`シンボリックリンクはリンク先を変えずに移す: ${rel} -> ${linkTarget}`);
      } else if (rel.endsWith(".md")) {
        deferred.push({ from: rel, to: mapped.to, content: readFileSync(join(root, rel), "utf8"), mode: fileMode(join(root, rel)) });
      } else {
        addFile(mapped.to, rel);
      }
    }

    // 新しい状態索引と空ディレクトリの .gitkeep
    for (const [name, status] of taskStatus) {
      if (taskStatuses.includes(status as (typeof taskStatuses)[number])) ops.push({ kind: "link", to: `${target}/status/${status}/${name}`, target: `../../tasks/${name}` });
    }
    for (const [name, status] of qaStatus) {
      if (qaStatuses.includes(status as (typeof qaStatuses)[number])) ops.push({ kind: "link", to: `${target}/qa/status/${status}/${name}`, target: `../../${name}` });
    }
    for (const entry of walk(join(templatesDir, "job"), "")) {
      if (entry.type !== "file") continue;
      const to = `${target}/${entry.rel}`;
      if (!ops.some((op) => op.to === to)) ops.push({ kind: "file", to, content: readFileSync(join(templatesDir, "job", entry.rel)), mode: 0o644 });
    }
  }

  if (errors.length > 0) {
    throw new CliError(["移行できない内容があるため、何も変更せずに中止しました:", ...errors.map((error) => `  - ${error}`)].join("\n"));
  }

  // job/ 内の Markdown のリンクを移動先に合わせる
  const count = { value: 0 };
  for (const item of deferred) {
    const before = count.value;
    const content = rewriteLinks(item.content, { map, oldLocation: item.from, newLocation: item.to, splitTargets, warnings, count });
    if (count.value > before) counts.linkFiles++;
    if (!item.split) {
      ops.push({ kind: "file", to: item.to, content: Buffer.from(content), mode: item.mode });
      continue;
    }
    const split = splitTask(content, item.from);
    warnings.push(...split.notes.filter((note) => note.startsWith("手動確認")));
    pending.push(...split.notes.filter((note) => !note.startsWith("手動確認")));
    ops.push({ kind: "file", to: item.to, content: Buffer.from(split.index), mode: item.mode });
    for (const detail of split.details) {
      ops.push({ kind: "file", to: posix.join(posix.dirname(item.to), detail.file), content: Buffer.from(detail.content), mode: item.mode });
      counts.details++;
    }
  }

  // job/ の外の Markdown
  const rewrites: Rewrite[] = [];
  const mentions: string[] = [];
  for (const rel of markdownFiles(root)) {
    const text = readFileSync(join(root, rel), "utf8");
    const before = count.value;
    const content = rewriteLinks(text, { map, oldLocation: rel, newLocation: rel, splitTargets, warnings, count });
    if (content !== text) {
      sources[rel] = sha256(text);
      rewrites.push({ path: rel, content, mode: fileMode(join(root, rel)), created: false });
      if (count.value > before) counts.linkFiles++;
    }
    if (/(^|[^A-Za-z0-9_-])job\//m.test(content)) mentions.push(rel);
  }
  counts.links = count.value;
  if (mentions.length > 0) {
    pending.push(`旧パス (job/) への言及が残る文書 ${mentions.length} 件 (コマンド例・履歴は機械的に置換しない。必要なものは手で直す):`);
    pending.push(...mentions.map((rel) => `  ${rel}`));
  }

  // scripts/ の導入
  const scriptsTarget = join(root, "scripts");
  let installScripts = false;
  const scriptsStat = lstatOrUndefined(scriptsTarget);
  if (!scriptsStat) {
    installScripts = true;
  } else if (realpathSync(scriptsTarget) !== realpathSync(sourceScripts)) {
    let info;
    try {
      info = scriptsInfo(scriptsTarget);
    } catch {
      throw new CliError("既存の scripts/ が管理リポジトリの scripts/ ではないため中止しました。名前を変えるか移動してから再実行してください");
    }
    if (info.protocol !== scriptsInfo(sourceScripts).protocol) {
      throw new CliError(`既存の scripts/ の版 (protocol ${info.protocol}) が移行処理 (protocol ${scriptsInfo(sourceScripts).protocol}) と異なるため中止しました`);
    }
    pending.push("既存の scripts/ をそのまま使う (上書きしない)");
  }

  // package.json: raprid スクリプトだけを追加する
  const pkgPath = join(root, "package.json");
  const command = "node scripts/cli.ts";
  if (isFile(pkgPath)) {
    const text = readFileSync(pkgPath, "utf8");
    let pkg: { scripts?: Record<string, string> };
    try {
      pkg = JSON.parse(text);
    } catch {
      throw new CliError("package.json を JSON として読めないため中止しました");
    }
    const current = pkg.scripts?.raprid;
    if (current !== undefined && current !== command) throw new CliError(`package.json の scripts.raprid が既にあるため中止しました: ${current}`);
    if (current === undefined) {
      pkg.scripts = { ...(pkg.scripts ?? {}), raprid: command };
      sources["package.json"] = sha256(text);
      rewrites.push({ path: "package.json", content: `${JSON.stringify(pkg, null, 2)}\n`, mode: fileMode(pkgPath), created: false });
    }
  } else if (exists(pkgPath)) {
    throw new CliError("package.json がファイルではないため中止しました");
  } else {
    const pkg = { private: true, engines: { node: ">=24" }, scripts: { raprid: command } };
    rewrites.push({ path: "package.json", content: `${JSON.stringify(pkg, null, 2)}\n`, mode: 0o644, created: true });
  }

  // .gitignore: 旧 job/ の除外を jobs/ に読み替え、ロックと退避先を除外する
  const ignorePath = join(root, ".gitignore");
  const ignoreText = isFile(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
  const ignoreLines = ignoreText === "" ? [] : ignoreText.replace(/\n$/, "").split("\n");
  const updatedIgnore = ignoreLines.map((line) => line.replace(/^(!?\/?)job\//, "$1jobs/"));
  const additions = ["jobs/.locks/", ".raprid-migrate/"].filter((line) => !updatedIgnore.includes(line));
  if (additions.length > 0) updatedIgnore.push(...(updatedIgnore.length > 0 ? [""] : []), "# raprid (案件操作のロックと移行時の退避先)", ...additions);
  const newIgnore = `${updatedIgnore.join("\n")}\n`;
  if (newIgnore !== ignoreText) {
    if (ignoreText !== "") sources[".gitignore"] = sha256(ignoreText);
    rewrites.push({ path: ".gitignore", content: newIgnore, mode: ignoreText !== "" ? fileMode(ignorePath) : 0o644, created: ignoreText === "" && !exists(ignorePath) });
  }

  ops.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  const duplicate = ops.find((op, index) => index > 0 && ops[index - 1].to === op.to);
  if (duplicate) throw new CliError(`移動先が重複するため中止しました: ${duplicate.to}`);

  const digest = createHash("sha256");
  digest.update(JSON.stringify({ sources, installScripts, scripts: installScripts ? scriptsInfo(sourceScripts) : null }));
  for (const op of ops) digest.update(op.kind === "file" ? `${op.to}\0${op.mode}\0${sha256(op.content)}` : `${op.to}\0->${op.target}`);
  for (const rewrite of rewrites) digest.update(`${rewrite.path}\0${sha256(rewrite.content)}`);

  return {
    root,
    ops,
    installScripts,
    rewrites,
    mappings,
    drops,
    warnings: [...new Set(warnings)],
    pending,
    counts,
    sources,
    hash: digest.digest("hex").slice(0, 16),
  };
}

function printPlan(plan: Plan): void {
  const { counts } = plan;
  console.log(`移行計画: ${plan.root}`);
  console.log(`  案件: ${counts.jobs} / タスク: ${counts.tasks} (詳細 md ${counts.details} 件に分割) / QA: ${counts.qa}`);
  console.log(`  タスクへ移す成果物: ${counts.assetDirs} ディレクトリ / 作成するファイル・リンク: ${plan.ops.length} 件`);
  console.log(`  リンクの書き換え: ${counts.links} 件 (${counts.linkFiles} ファイル) / 更新する job/ 外のファイル: ${plan.rewrites.length} 件`);
  console.log(`  scripts/: ${plan.installScripts ? "導入する" : "既存を使う"}`);
  if (plan.mappings.length > 0) {
    console.log("パスの対応:");
    for (const mapping of plan.mappings) console.log(`  ${mapping}`);
  }
  if (plan.rewrites.length > 0) {
    console.log("更新・作成するファイル:");
    for (const rewrite of plan.rewrites) console.log(`  ${rewrite.created ? "作成" : "更新"}: ${rewrite.path}`);
  }
  if (plan.drops.length > 0) {
    console.log("新構成へ移さないもの (旧操作スクリプト・旧雛形。退避先にだけ残す):");
    for (const drop of plan.drops) console.log(`  ${drop}`);
  }
  if (plan.warnings.length > 0) {
    console.log("注意:");
    for (const warning of plan.warnings) console.log(`  - ${warning}`);
  }
  if (plan.pending.length > 0) {
    console.log("保留 (移行後に確認する):");
    for (const line of plan.pending) console.log(line.startsWith("  ") ? `  ${line}` : `  - ${line}`);
  }
  console.log(`計画ハッシュ: ${plan.hash}`);
}

// ---------------------------------------------------------------- 実行と復元

function workDir(root: string, id: string): string {
  return join(root, ".raprid-migrate", id);
}

function saveJournal(root: string, journal: Journal): void {
  const path = join(workDir(root, journal.id), "journal.json");
  writeFileSync(`${path}.tmp`, `${JSON.stringify(journal, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

function stage(plan: Plan, dir: string): void {
  mkdirSync(join(dir, "jobs"), { recursive: true });
  for (const op of plan.ops) {
    const path = join(dir, op.to);
    mkdirSync(join(path, ".."), { recursive: true });
    if (op.kind === "file") {
      writeFileSync(path, op.content, { flag: "wx", mode: op.mode });
      chmodSync(path, op.mode);
    } else {
      symlinkSync(op.target, path);
    }
  }
}

function hashTree(root: string, rel: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!exists(join(root, rel))) return out;
  for (const entry of walk(root, rel)) {
    const full = join(root, entry.rel);
    if (entry.type === "file") out[entry.rel] = sha256(readFileSync(full));
    if (entry.type === "symlink") out[entry.rel] = `link:${readlinkSync(full)}`;
  }
  return out;
}

function currentSources(root: string, plan: Plan): string[] {
  const changed: string[] = [];
  const now: Record<string, string> = { ...hashTree(root, "job") };
  for (const rel of Object.keys(plan.sources)) {
    if (rel.startsWith("job/")) continue;
    if (isFile(join(root, rel))) now[rel] = sha256(readFileSync(join(root, rel)));
  }
  for (const rel of new Set([...Object.keys(plan.sources), ...Object.keys(now)])) {
    if (plan.sources[rel] !== now[rel]) changed.push(rel);
  }
  return changed;
}

function rollback(root: string, journal: Journal): string[] {
  const failures: string[] = [];
  const dir = workDir(root, journal.id);
  const attempt = (label: string, fn: () => void) => {
    try {
      fn();
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  // 各フラグは操作の直前に記録している。実際に操作が済んでいるかは存在で確かめる
  if (journal.jobMoved) {
    if (exists(join(dir, "backup", "job")) && !exists(join(root, "job"))) {
      attempt("job/ を戻す", () => renameSync(join(dir, "backup", "job"), join(root, "job")));
    }
    if (failures.length === 0) journal.jobMoved = false;
  }
  for (const rewrite of [...journal.rewritten].reverse()) {
    attempt(`${rewrite.path} を戻す`, () => {
      if (rewrite.created) rmSync(join(root, rewrite.path), { force: true });
      else {
        const temp = join(root, `${rewrite.path}.raprid-restore`);
        cpSync(join(dir, "backup", rewrite.path), temp, { preserveTimestamps: true });
        renameSync(temp, join(root, rewrite.path));
      }
    });
  }
  if (failures.length === 0) journal.rewritten = [];
  if (journal.scriptsCreated) {
    // 計画時に scripts/ が無かった場合だけ立つフラグなので、残っているものはこの移行で作ったもの
    attempt("scripts/ を削除する", () => rmSync(join(root, "scripts"), { recursive: true, force: true }));
    if (failures.length === 0) journal.scriptsCreated = false;
  }
  if (journal.jobsCreated) {
    attempt("jobs/ を削除する", () => rmSync(join(root, "jobs"), { recursive: true, force: true }));
    if (failures.length === 0) journal.jobsCreated = false;
  }
  return failures;
}

function newId(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${randomBytes(2).toString("hex")}`;
}

function apply(plan: Plan, expected: string | undefined): void {
  const root = plan.root;
  if (expected !== undefined && expected !== plan.hash) {
    throw new CliError(`表示した計画 (${expected}) と現在の計画 (${plan.hash}) が一致しないため中止しました。--dry-run で確認し直してください`);
  }
  const id = newId();
  const dir = workDir(root, id);
  mkdirSync(join(dir, "backup"), { recursive: true });
  writeFileSync(join(dir, "plan.txt"), [`hash: ${plan.hash}`, ...plan.mappings, ...plan.warnings.map((warning) => `注意: ${warning}`)].join("\n") + "\n");
  const journal: Journal = { id, state: "started", jobsCreated: false, scriptsCreated: false, jobMoved: false, rewritten: [], after: {} };
  saveJournal(root, journal);

  // 退避と準備はすべて一時領域で行い、ここまでで失敗しても作業ツリーは変わらない
  const stageDir = join(dir, "stage");
  stage(plan, stageDir);
  if (plan.installScripts) {
    cpSync(scriptsDir, join(stageDir, "scripts"), { recursive: true, verbatimSymlinks: true, filter: (source) => !source.split(/[\\/]/).includes("node_modules") });
  }
  for (const rewrite of plan.rewrites) {
    const staged = join(stageDir, "files", rewrite.path);
    mkdirSync(join(staged, ".."), { recursive: true });
    writeFileSync(staged, rewrite.content, { mode: rewrite.mode });
    chmodSync(staged, rewrite.mode);
    if (!rewrite.created) {
      const backup = join(dir, "backup", rewrite.path);
      mkdirSync(join(backup, ".."), { recursive: true });
      cpSync(join(root, rewrite.path), backup, { preserveTimestamps: true });
    }
  }
  const changed = currentSources(root, plan);
  if (changed.length > 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new CliError(["計画の作成後に変更されたファイルがあるため、何も変更せずに中止しました:", ...changed.map((rel) => `  ${rel}`)].join("\n"));
  }

  try {
    journal.jobsCreated = true;
    saveJournal(root, journal);
    renameSync(join(stageDir, "jobs"), join(root, "jobs"));
    if (plan.installScripts) {
      journal.scriptsCreated = true;
      saveJournal(root, journal);
      renameSync(join(stageDir, "scripts"), join(root, "scripts"));
    }
    for (const rewrite of plan.rewrites) {
      if (rewrite.created && exists(join(root, rewrite.path))) throw new Error(`作成するファイルが既にあります: ${rewrite.path}`);
      journal.rewritten.push({ path: rewrite.path, created: rewrite.created });
      saveJournal(root, journal);
      renameSync(join(stageDir, "files", rewrite.path), join(root, rewrite.path));
    }
    journal.jobMoved = true;
    saveJournal(root, journal);
    renameSync(join(root, "job"), join(dir, "backup", "job"));
  } catch (error) {
    const failures = rollback(root, journal);
    journal.state = failures.length === 0 ? "rolled-back" : "started";
    saveJournal(root, journal);
    const message = error instanceof Error ? error.message : String(error);
    if (failures.length > 0) {
      throw new CliError([`移行に失敗し、一部を戻せませんでした: ${message}`, ...failures.map((failure) => `  ${failure}`), `raprid job migrate --restore ${id} で再度戻せます`].join("\n"));
    }
    throw new CliError(`移行に失敗したため、この実行で変えたものを戻しました: ${message}`);
  }

  journal.after = { ...hashTree(root, "jobs"), ...(plan.installScripts ? hashTree(root, "scripts") : {}) };
  for (const rewrite of plan.rewrites) journal.after[rewrite.path] = sha256(readFileSync(join(root, rewrite.path)));
  journal.state = "completed";
  saveJournal(root, journal);
  rmSync(stageDir, { recursive: true, force: true });
  console.log(`移行しました (移行ID: ${id})`);
  console.log(`  移行前の job/ と更新前のファイル: .raprid-migrate/${id}/backup/`);
  console.log(`  戻す場合: raprid job migrate --restore ${id}`);
  console.log("  確認後は raprid task list で一覧を確かめ、.raprid-migrate/ を削除してよい");
}

function restore(root: string, id: string): void {
  if (!/^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/.test(id)) throw new UsageError(`移行IDの形式が不正です: ${id}`);
  const dir = workDir(root, id);
  const journalPath = join(dir, "journal.json");
  if (!isFile(journalPath)) throw new CliError(`移行の記録が見つかりません: .raprid-migrate/${id}/journal.json`);
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
  if (journal.state === "restored" || journal.state === "rolled-back") {
    console.log(`移行 ${id} は既に戻されています。変更はありません。`);
    return;
  }
  if (journal.state === "completed") {
    const now = { ...hashTree(root, "jobs"), ...(journal.scriptsCreated ? hashTree(root, "scripts") : {}) };
    for (const rewrite of journal.rewritten) if (isFile(join(root, rewrite.path))) now[rewrite.path] = sha256(readFileSync(join(root, rewrite.path)));
    const changed = [...new Set([...Object.keys(now), ...Object.keys(journal.after)])].filter((rel) => now[rel] !== journal.after[rel]);
    if (changed.length > 0) {
      throw new CliError(["移行後に変更されたファイルがあるため、戻さずに中止しました (退避は残っています):", ...changed.map((rel) => `  ${rel}`)].join("\n"));
    }
    if (exists(join(root, "job"))) throw new CliError("job/ が既にあるため、戻さずに中止しました");
  }
  const failures = rollback(root, journal);
  journal.state = failures.length === 0 ? "restored" : journal.state;
  saveJournal(root, journal);
  if (failures.length > 0) throw new CliError(["一部を戻せませんでした:", ...failures.map((failure) => `  ${failure}`)].join("\n"));
  console.log(`移行 ${id} の前の状態に戻しました。退避の記録は .raprid-migrate/${id}/ に残っています。`);
}

export function migrate(argv: string[]): void {
  const { values, positionals } = parse(
    argv,
    { "dry-run": { type: "boolean" }, apply: { type: "boolean" }, plan: { type: "string" }, restore: { type: "string" } },
    usage,
  );
  if (positionals.length > 0) throw new UsageError(usage);
  const modes = [values["dry-run"], values.apply, values.restore !== undefined].filter(Boolean).length;
  if (modes > 1) throw new UsageError(`--dry-run・--apply・--restore は同時に指定できません\n${usage}`);
  if (values.plan !== undefined && !values.apply) throw new UsageError("--plan は --apply と一緒に指定してください");
  const root = projectRoot();
  if (values.restore !== undefined) {
    restore(root, values.restore);
    return;
  }
  const hasOld = isDirectory(join(root, "job"));
  const hasNew = exists(join(root, "jobs"));
  if (!hasOld && hasNew) {
    console.log("移行済みです (jobs/ があり、job/ はありません)。変更はありません。");
    return;
  }
  if (!hasOld) throw new CliError(`旧構成の job/ が見つかりません: ${root}`);
  if (hasNew) {
    throw new CliError(
      "job/ と jobs/ が両方あるため中止しました。途中まで移行した状態か、手で作った jobs/ があります。\n" +
        "  .raprid-migrate/ に記録があれば raprid job migrate --restore <移行ID> で戻し、無ければ jobs/ を確認して整理してください",
    );
  }
  const plan = buildPlan(root);
  if (values.apply) {
    apply(plan, values.plan);
  } else {
    printPlan(plan);
    console.log(`実行: raprid job migrate --apply --plan ${plan.hash}  (何も変更していません)`);
  }
}
