// プロジェクトの scripts/cli.ts を非同期の子プロセスとして実行し、JSON を受け取る。
// shell は使わず argv をそのまま渡す。実行中の子プロセスは dispose で必ず止める。

import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { childEnv } from "../delegate.js";
import type { Issue, ItemRecord, Kind, ShowResult, Snapshot } from "./types.js";
import { stepArgs, type WorkflowStep } from "./workflow.js";

export const readTimeoutMs = 15_000;

export class BackendError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface WriteResult {
  schemaVersion: 1 | 2;
  ok: true;
  item: ItemRecord;
  issues: Issue[];
  revision?: string; // 工程の操作 (schemaVersion 2) だけ
}

// scripts/ が返す JSON の版。query-v2 に対応していれば 2 (工程型タスクを含む)、していなければ 1
export type SchemaVersion = 1 | 2;

export interface Backend {
  capabilities(): Promise<string[]>;
  snapshot(): Promise<Snapshot>;
  show(kind: Kind, job: string, selector: string): Promise<ShowResult>;
  // guarded-write-v1。revision が一致しなければ REVISION_CONFLICT で失敗する
  resolveQa(job: string, selector: string, answer: string, answeredBy: string, revision: string): Promise<WriteResult>;
  // blockedBy は 1 件ずつ --blocked-by で渡す (カンマを区切りに使わない)
  moveTask(job: string, selector: string, status: string, blockedBy: string[] | undefined, revision: string): Promise<WriteResult>;
  // workflow-v3。工程型タスクの工程の操作 (task claim・complete・decide・block・resume・reopen・assign)
  workflowStep(job: string, selector: string, step: WorkflowStep, actor: string, revision: string): Promise<WriteResult>;
  dispose(): void;
}

export interface ScriptBackendOptions {
  timeoutMs?: number;
  script?: string; // 既定は <root>/scripts/cli.ts
}

export class ScriptBackend implements Backend {
  readonly root: string;
  private readonly script: string;
  private readonly timeoutMs: number;
  private readonly children = new Set<ChildProcess>();
  private disposed = false;
  private readonly writers = new Set<ChildProcess>();
  private schema: SchemaVersion = 1;

  constructor(root: string, options: ScriptBackendOptions = {}) {
    this.root = root;
    this.script = options.script ?? join(root, "scripts", "cli.ts");
    this.timeoutMs = options.timeoutMs ?? readTimeoutMs;
  }

  // capability を見て決めた JSON の版 (main.tsx が設定する)
  useSchema(version: SchemaVersion): void {
    this.schema = version;
  }

  get schemaVersion(): SchemaVersion {
    return this.schema;
  }

  private versionArgs(): string[] {
    return this.schema === 2 ? ["--schema-version", "2"] : [];
  }

  // 実行中の子プロセス数 (試験用)
  get running(): number {
    return this.children.size;
  }

  // 書き込み (write) は途中で止めると結果が分からなくなるため、タイムアウトで止めない。
  // scripts/ 側のロック待ちは 10 秒で失敗するので、応答は必ず返る
  run(args: string[], options: { input?: string; write?: boolean } = {}): Promise<unknown> {
    if (this.disposed) return Promise.reject(new BackendError("DISPOSED", "終了処理中です"));
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [this.script, ...args], {
        cwd: this.root,
        env: childEnv({ RAPRID_ROOT: this.root }),
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      if (options.input !== undefined) child.stdin!.end(options.input, "utf8");
      this.children.add(child);
      if (options.write) this.writers.add(child);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      const timer = options.write
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 1000).unref();
          }, this.timeoutMs);
      const settle = () => {
        clearTimeout(timer);
        this.children.delete(child);
        this.writers.delete(child);
      };
      child.on("error", (error) => {
        settle();
        reject(new BackendError("SPAWN_FAILED", `scripts/cli.ts を起動できません: ${error.message}`));
      });
      child.on("close", (code) => {
        settle();
        if (timedOut) {
          reject(new BackendError("TIMEOUT", `${Math.round(this.timeoutMs / 1000)}秒以内に応答がありませんでした`));
          return;
        }
        let parsed: { error?: { code?: string; message?: string } };
        try {
          parsed = JSON.parse(stdout) as typeof parsed;
        } catch {
          const detail = (stderr || stdout).trim().split("\n")[0] ?? "";
          reject(new BackendError("INVALID_RESPONSE", `JSON を読めませんでした (終了コード ${code ?? "不明"})${detail ? `: ${detail}` : ""}`));
          return;
        }
        if (parsed && typeof parsed === "object" && parsed.error) {
          reject(new BackendError(parsed.error.code ?? "FAILED", parsed.error.message ?? "失敗しました"));
          return;
        }
        if (code !== 0) {
          reject(new BackendError("FAILED", `終了コード ${code ?? "不明"} で終了しました`));
          return;
        }
        resolve(parsed);
      });
    });
  }

  async capabilities(): Promise<string[]> {
    try {
      const result = (await this.run(["--capabilities"])) as { capabilities?: unknown };
      return Array.isArray(result.capabilities) ? result.capabilities.filter((value): value is string => typeof value === "string") : [];
    } catch (error) {
      // --capabilities を知らない古い scripts/ は、対応機能なしとして扱う
      if (error instanceof BackendError && error.code === "INVALID_RESPONSE") return [];
      throw error;
    }
  }

  async snapshot(): Promise<Snapshot> {
    const result = (await this.run(["ui", "snapshot", "--json", ...this.versionArgs()])) as Snapshot;
    if (result?.schemaVersion !== this.schema || !Array.isArray(result.tasks) || !Array.isArray(result.qas)) {
      throw new BackendError("INVALID_RESPONSE", "ui snapshot の形式が不正です");
    }
    return result;
  }

  async show(kind: Kind, job: string, selector: string): Promise<ShowResult> {
    const result = (await this.run([kind, "show", job, selector, "--json", ...this.versionArgs()])) as ShowResult;
    if (result?.schemaVersion !== this.schema || !result.item) throw new BackendError("INVALID_RESPONSE", "show の形式が不正です");
    return result;
  }

  async resolveQa(job: string, selector: string, answer: string, answeredBy: string, revision: string): Promise<WriteResult> {
    const args = ["qa", "resolve", job, selector, "--answer-file", "-", "--answered-by", answeredBy, "--if-match", revision, "--json"];
    return (await this.run(args, { input: answer, write: true })) as WriteResult;
  }

  async moveTask(job: string, selector: string, status: string, blockedBy: string[] | undefined, revision: string): Promise<WriteResult> {
    const args = ["task", "move", job, selector, status, ...(blockedBy ?? []).flatMap((value) => ["--blocked-by", value]), "--if-match", revision, "--json"];
    return (await this.run(args, { write: true })) as WriteResult;
  }

  async workflowStep(job: string, selector: string, step: WorkflowStep, actor: string, revision: string): Promise<WriteResult> {
    const [op, ...rest] = stepArgs(step, actor);
    const args = ["task", op, job, selector, ...rest, "--if-match", revision, "--json"];
    const result = (await this.run(args, { write: true })) as WriteResult;
    if (result?.schemaVersion !== 2 || !result.item) throw new BackendError("INVALID_RESPONSE", "工程の操作の結果の形式が不正です");
    return result;
  }

  // 読み取りの子プロセスを止める。書き込みは途中で止めると変更が中途半端になりうるので、止めずに完了させる
  dispose(): void {
    this.disposed = true;
    for (const child of this.children) if (!this.writers.has(child)) child.kill("SIGTERM");
    this.children.clear();
  }
}
