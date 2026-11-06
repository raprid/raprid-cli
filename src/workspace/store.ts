import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { randomUUID, createHash } from "node:crypto";

export interface Config {
  schemaVersion: 1;
  repository: string;
  host: string;
  apiVersion: string;
  layout?: "services-v1";
}
export interface Issue {
  schemaVersion: 1;
  title: string;
  state: "open" | "closed";
  stateReason: string | null;
  labels: string[];
  assignees: string[];
  milestone: number | null;
  type?: string | null;
}
export interface Remote {
  id: number;
  node_id: string;
  number: number;
  html_url: string;
  [key: string]: unknown;
}
export interface Document {
  issue: Issue;
  body: string;
}
export const equal = (a: unknown, b: unknown): boolean =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function canonical(v: any): any {
  return Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
}
export function hash(v: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(v)))
    .digest("hex");
}
export function safe(root: string, path: string): string {
  // 旧ワークスペースはそのまま利用し、新形式だけ GitHub データを移す。
  const configPath = join(root, ".raprid/config.json");
  if (/^(issues|wiki)(\/|$)/.test(path) && existsSync(configPath)) {
    const c = JSON.parse(readFileSync(configPath, "utf8"));
    if (c.layout === "services-v1") path = `github/${path}`;
  }
  const base = resolve(root),
    target = resolve(root, path),
    rel = relative(base, target);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error("保存先がワークスペース外です");
  let current = base;
  for (const part of ["", ...rel.split("/").filter(Boolean)]) {
    current = part ? join(current, part) : current;
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error(`リンクは管理対象にできません: ${current}`);
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  return target;
}
export function read<T>(root: string, path: string, fallback?: T): T {
  const p = safe(root, path);
  if (!existsSync(p) && fallback !== undefined) return fallback;
  return JSON.parse(readFileSync(p, "utf8"));
}
export function write(root: string, path: string, value: unknown): void {
  atomic(root, path, JSON.stringify(value, null, 2) + "\n");
}
export function atomic(root: string, path: string, value: string): void {
  const p = safe(root, path);
  mkdirSync(dirname(p), { recursive: true });
  const temp = `${p}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, value, { flag: "wx", mode: 0o600 });
    renameSync(temp, p);
  } finally {
    rmSync(temp, { force: true });
  }
}
export function textFile(root: string, path: string): string {
  return readFileSync(safe(root, path), "utf8");
}
export function config(root: string): Config {
  const c = read<Config>(root, ".raprid/config.json");
  if (
    c.schemaVersion !== 1 ||
    !/^[\w.-]+\/[\w.-]+$/.test(c.repository) ||
    !/^[\w.-]+$/.test(c.host) ||
    (c.layout !== undefined && c.layout !== "services-v1")
  )
    throw new Error("ワークスペース設定が不正または非対応です");
  return c;
}
export function findRoot(start = process.cwd()): string {
  let p = resolve(start);
  while (true) {
    if (existsSync(join(p, ".raprid/config.json"))) {
      config(p);
      return p;
    }
    if (existsSync(join(p, ".git")) || dirname(p) === p)
      throw new Error(
        "v2ワークスペースがありません。raprid init --repo owner/repo を実行してください",
      );
    p = dirname(p);
  }
}
export function validate(v: any): asserts v is Issue {
  if (
    !v ||
    v.schemaVersion !== 1 ||
    typeof v.title !== "string" ||
    !v.title.trim() ||
    !["open", "closed"].includes(v.state) ||
    ![null, "completed", "not_planned", "reopened", "duplicate"].includes(
      v.stateReason,
    )
  )
    throw new Error("issue.jsonのタイトル・状態・保存形式が不正です");
  for (const k of ["labels", "assignees"])
    if (
      !Array.isArray(v[k]) ||
      v[k].some((x: any) => typeof x !== "string" || !x.trim()) ||
      new Set(v[k]).size !== v[k].length
    )
      throw new Error(`${k}は重複のない文字列配列が必要です`);
  if (
    v.milestone !== null &&
    (!Number.isInteger(v.milestone) || v.milestone < 1)
  )
    throw new Error("milestoneは番号またはnullです");
  if (v.type !== undefined && v.type !== null && typeof v.type !== "string")
    throw new Error("typeは文字列またはnullです");
  const allowed = [
    "schemaVersion",
    "title",
    "state",
    "stateReason",
    "labels",
    "assignees",
    "milestone",
    "type",
  ];
  if (Object.keys(v).some((k) => !allowed.includes(k)))
    throw new Error("issue.jsonに未知の編集属性があります");
}
export function ids(root: string): string[] {
  const p = safe(root, "issues");
  return existsSync(p)
    ? readdirSync(p)
        .filter((x) => !x.startsWith("."))
        .sort()
    : [];
}
export function issuePath(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("不正なローカルIDです");
  return `issues/${id}`;
}
export function select(root: string, id: string): string {
  if (ids(root).includes(id)) return id;
  const matches = ids(root).filter(
    (x) =>
      String(read<any>(root, `${issuePath(x)}/remote.json`, null)?.number) ===
      id.replace(/^#/, ""),
  );
  if (matches.length !== 1)
    throw new Error(`Issueを一意に特定できません: ${id}`);
  return matches[0];
}
export function document(root: string, id: string): Document {
  const path = issuePath(id),
    issue = read<Issue>(root, `${path}/issue.json`);
  validate(issue);
  return { issue, body: textFile(root, `${path}/index.md`) };
}
export function saveDocument(root: string, id: string, doc: Document): void {
  validate(doc.issue);
  writeBatch(root, {
    [`${issuePath(id)}/issue.json`]: JSON.stringify(doc.issue, null, 2) + "\n",
    [`${issuePath(id)}/index.md`]: doc.body,
  });
}
export function add(root: string, title: string, body = ""): string {
  const id = randomUUID();
  const doc: Document = {
    body,
    issue: {
      schemaVersion: 1,
      title,
      state: "open",
      stateReason: null,
      labels: [],
      assignees: [],
      milestone: null,
      type: null,
    },
  };
  validate(doc.issue);
  saveDocument(root, id, doc);
  write(root, `${issuePath(id)}/remote.json`, null);
  return id;
}
export async function locked<T>(
  root: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const p = safe(root, ".raprid/locks/workspace");
  mkdirSync(dirname(p), { recursive: true });
  try {
    mkdirSync(p);
  } catch {
    throw new Error(
      "別の操作が実行中です。中断した場合はプロセス停止を確認して.raprid/locks/workspaceを取り除いてください",
    );
  }
  try {
    write(root, ".raprid/locks/workspace/owner.json", {
      pid: process.pid,
      at: new Date().toISOString(),
    });
    recoverWrites(root);
    return await fn();
  } finally {
    rmSync(p, { recursive: true, force: true });
  }
}
export function initialize(
  root: string,
  repository: string,
  host = "github.com",
  dryRun = false,
): void {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[\w.-]+$/.test(host))
    throw new Error("--repo owner/repo と有効な --host が必要です");
  const dirs = [".raprid", "github", "slack", "logs", "repos"];
  const files: Record<string, string> = {
    "README.md":
      "# raprid ワークスペース\n\nGitHub は github/、Slack は slack/ で扱います。\n",
    "AGENTS.md":
      "# エージェント向け操作\n\nindex.mdは本文、issue.jsonは編集属性、remote.jsonは取得情報です。未取得を空として送信しないこと。送信は利用者が許可した範囲で実行してください。同期ジャーナルは削除しないこと。\n",
    "CLAUDE.md":
      "# 作業手順\n\nAGENTS.mdを読み、raprid --helpで操作を確認してください。\n",
    ".gitignore": ".env\n.raprid/cache/\n.raprid/locks/\ngithub/wiki/\nrepos/\n",
    ".env.example": "SLACK_USER_OAUTH_TOKEN=\nSLACK_WORKSPACE_ID=\nSLACK_CHANNEL_ID=\n",
  };
  for (const p of [...dirs, ...Object.keys(files)])
    if (existsSync(safe(root, p)))
      throw new Error(`既存のパスがあります: ${p}`);
  if (dryRun) return;
  mkdirSync(root, { recursive: true });
  const created: string[] = [];
  try {
    for (const dir of dirs) {
      mkdirSync(safe(root, dir));
      created.push(dir);
    }
    write(root, ".raprid/config.json", {
      schemaVersion: 1,
      repository,
      host,
      apiVersion: "2026-03-10",
      layout: "services-v1",
    });
    mkdirSync(safe(root, "issues"), { recursive: true });
    mkdirSync(safe(root, "wiki"), { recursive: true });
    for (const dir of [
      "catalog",
      "sync/issues",
      "sync/operations",
      "cache",
      "locks",
    ])
      mkdirSync(safe(root, `.raprid/${dir}`), { recursive: true });
    for (const [path, content] of Object.entries(files)) {
      atomic(root, path, content);
      created.push(path);
    }
  } catch (e) {
    for (const p of created.reverse())
      rmSync(safe(root, p), { recursive: true, force: true });
    throw e;
  }
}

// 複数ファイルの保存途中で停止しても、変更前/変更後との照合で再開する。
export function writeBatch(root: string, files: Record<string, string>): void {
  const journal = `.raprid/sync/writes/${randomUUID()}.json`;
  const entries = Object.entries(files).map(([path, next]) => ({
    path,
    next,
    before: existsSync(safe(root, path)) ? textFile(root, path) : null,
  }));
  write(root, journal, entries);
  applyWrite(root, journal, entries);
}
function applyWrite(
  root: string,
  journal: string,
  entries: { path: string; next: string; before: string | null }[],
): void {
  for (const entry of entries) {
    const current = existsSync(safe(root, entry.path))
      ? textFile(root, entry.path)
      : null;
    if (current !== entry.before && current !== entry.next)
      throw new Error(`中断した保存と外部編集が競合しています: ${journal}`);
  }
  for (const entry of entries) atomic(root, entry.path, entry.next);
  rmSync(safe(root, journal));
}
export function recoverWrites(root: string): void {
  const dir = ".raprid/sync/writes";
  if (!existsSync(safe(root, dir))) return;
  for (const name of readdirSync(safe(root, dir)).filter((x) =>
    x.endsWith(".json"),
  ))
    applyWrite(root, `${dir}/${name}`, read(root, `${dir}/${name}`));
}
