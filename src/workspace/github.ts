import { execFileSync } from "node:child_process";
import type { Config, Document, Remote } from "./store.js";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface Api {
  request(method: string, path: string, body?: unknown): Promise<any>;
  list(path: string): Promise<any[]>;
}
export class GitHub implements Api {
  private token: string;
  private base: string;
  private lastWrite = 0;
  constructor(
    private settings: Config,
    options?: { base: string; token: string },
  ) {
    this.base =
      options?.base ??
      (settings.host === "github.com"
        ? "https://api.github.com"
        : `https://${settings.host}/api/v3`);
    this.token =
      options?.token ??
      process.env.GH_TOKEN ??
      process.env.GITHUB_TOKEN ??
      execFileSync("gh", ["auth", "token", "--hostname", settings.host], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
  }
  private async response(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const url = new URL(
      path.startsWith("http")
        ? path
        : `${this.base}/${path.replace(/^\//, "")}`,
    );
    if (url.origin !== new URL(this.base).origin)
      throw new Error("別ホストへの認証情報送信を拒否しました");
    if (method !== "GET") {
      const wait = 1100 - (Date.now() - this.lastWrite);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastWrite = Date.now();
    }
    const response = await fetch(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": this.settings.apiVersion,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok)
      throw new ApiError(
        response.status,
        `GitHub API ${method} ${url.pathname}: HTTP ${response.status}`,
      );
    return response;
  }
  async request(method: string, path: string, body?: unknown): Promise<any> {
    const r = await this.response(method, path, body);
    return r.status === 204 ? null : r.json();
  }
  async list(path: string): Promise<any[]> {
    let next: string | undefined =
      `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    const values: any[] = [],
      seen = new Set<string>();
    while (next) {
      if (seen.has(next)) throw new Error("APIページングが循環しています");
      seen.add(next);
      const r = await this.response("GET", next);
      const data = await r.json();
      if (!Array.isArray(data)) throw new Error("APIの一覧形式が不正です");
      values.push(...data);
      next = r.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    }
    return values;
  }
}
export function endpoint(c: Config): string {
  return `repos/${c.repository}`;
}
export function normalize(raw: any): Document {
  if (
    !raw ||
    !Number.isInteger(raw.id) ||
    !Number.isInteger(raw.number) ||
    raw.pull_request
  )
    throw new Error("IssueのAPI応答が不正です");
  return {
    body: raw.body ?? "",
    issue: {
      schemaVersion: 1,
      title: raw.title,
      state: raw.state,
      stateReason: raw.state_reason ?? null,
      labels: (raw.labels ?? [])
        .map((x: any) => (typeof x === "string" ? x : x.name))
        .sort(),
      assignees: (raw.assignees ?? []).map((x: any) => x.login).sort(),
      milestone: raw.milestone?.number ?? null,
      type: raw.type?.name ?? null,
    },
  };
}
export function remoteInfo(c: Config, raw: any): Remote {
  return { ...raw, repository: c.repository, host: c.host };
}
export function patch(
  base: Document | null,
  local: Document,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(local.issue)) {
    if (key === "schemaVersion") continue;
    if (
      !base ||
      JSON.stringify((base.issue as any)[key]) !== JSON.stringify(value)
    )
      result[key === "stateReason" ? "state_reason" : key] = value;
  }
  if (!base || base.body !== local.body) result.body = local.body;
  if (Object.hasOwn(result, "state_reason")) result.state = local.issue.state;
  return result;
}
