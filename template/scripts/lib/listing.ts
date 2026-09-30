// task / qa の list・show サブコマンドの共通処理

import { parse } from "./args.ts";
import { UsageError } from "./errors.ts";
import type { Kind } from "./jobs.ts";
import { findItem, listGroups, listJson, ownIssues, parseFilter, parseSchemaVersion, printJson, scopeJobs, showJson } from "./query.ts";
import { Collector } from "./records.ts";
import { projectRoot } from "./root.ts";
import { displayOptionSpec, rejectDisplayWithJson, renderList, renderShow, resolveDisplay } from "./view.ts";

const listOptions = {
  json: { type: "boolean" },
  search: { type: "string" },
  status: { type: "string" },
  all: { type: "boolean" },
  long: { type: "boolean" },
  closed: { type: "boolean" },
  type: { type: "string" },
  phase: { type: "string" },
  assignee: { type: "string" },
  "schema-version": { type: "string" },
  ...displayOptionSpec,
} as const;

const showOptions = { json: { type: "boolean" }, "schema-version": { type: "string" }, ...displayOptionSpec } as const;

export function listCommand(kind: Kind, argv: string[], usage: string): void {
  const { positionals, values } = parse(argv, listOptions, usage);
  if (positionals.length > 1) throw new UsageError(usage);
  rejectDisplayWithJson(values.json, values);
  const version = parseSchemaVersion(values["schema-version"]);
  if (kind === "qa" && (values.closed || values.type !== undefined || values.phase !== undefined || values.assignee !== undefined)) {
    throw new UsageError("--closed・--type・--phase・--assignee はタスクの一覧だけで使えます");
  }
  const filter = parseFilter(kind, values);
  const display = values.json ? undefined : resolveDisplay(values);
  const collector = new Collector(projectRoot());
  const datas = scopeJobs(collector, positionals[0]).map((job) => collector.job(job));
  const groups = listGroups(kind, datas, filter);
  const extra = positionals[0] === undefined ? collector.rootIssues : [];
  if (display) console.log(renderList(kind, groups, display, extra));
  else printJson(listJson(kind, groups, extra, version));
}

export function showCommand(kind: Kind, argv: string[], usage: string): void {
  const { positionals, values } = parse(argv, showOptions, usage);
  if (positionals.length !== 2) throw new UsageError(usage);
  rejectDisplayWithJson(values.json, values);
  const version = parseSchemaVersion(values["schema-version"]);
  const display = values.json ? undefined : resolveDisplay(values);
  const collector = new Collector(projectRoot());
  const [job] = scopeJobs(collector, positionals[0]);
  const data = collector.job(job);
  const entry = findItem(data, kind, positionals[1]);
  const issues = ownIssues(data, entry);
  if (display) console.log(renderShow(entry, issues, display));
  else printJson(showJson(entry, issues, version));
}
