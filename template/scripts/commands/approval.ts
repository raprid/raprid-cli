// 人の判断記録 (workflowVersion 4 の decisions/<工程>-<試行>.md) の approval サブコマンド。T-022
// 契約: jobs/project_template/tasks/workflow-v4-contract/03-contract.md の 4 (判断記録と照合)・5 (T10〜T15)・6 (権限)・7 (整合性)
//
// list・show は読むだけ (ロック・復旧をしない)。正は各記録の frontmatter で、approvals/open/ の索引は ls 用。
// claim・assign・approve・reject は lib/taskflow-v4.ts の runTransitionV4 に渡す。案件のロックの中で残った journal を先に復旧し、
// タスクの revision (--if-match) と判断記録の revision (--record-match。ファイルのバイト列の SHA-256) の両方を照合してから、
// 判断記録 → 索引 → タスクの順に書き換える。人 (human/…) だけが操作でき (WF_HUMAN)、承認・見送りは判断記録の担当本人だけ (WF_NOT_APPROVER)。
// 失敗したら何も変えず、自動で送り直さない。--json はすべて schemaVersion 3 (失敗も)。

import { parse, singleLine } from "../lib/args.ts";
import { actor } from "../lib/actor.ts";
import { CliError, UsageError } from "../lib/errors.ts";
import { Job } from "../lib/jobs.ts";
import { type ApprovalEntry, approvalEntries, approvalIssues, approvalJson, approvalListJson, findItem, matchesApproval, printJson, response, scopeJobs } from "../lib/query.ts";
import { Collector, isWorkflow, type TaskRecord, type WorkflowInfo } from "../lib/records.ts";
import { projectRoot } from "../lib/root.ts";
import { runTransitionV4 } from "../lib/taskflow-v4.ts";
import type { OperationV4 } from "../lib/transitions-v4.ts";
import { sanitize, width } from "../lib/text.ts";
import { type ArtifactRef, approvalIdPattern, type PhaseV4, phasesV4 } from "../lib/workflow.ts";
import { reportV4 } from "./task-workflow-v4.ts";

export const usage = `使い方:
  raprid approval list [<案件名>] [--unassigned | --assignee <human/…>] [--all] [--json]
  raprid approval show <案件名> <タスクIDまたは名前> <工程>-<試行> [--json]
  raprid approval claim <案件名> <タスクIDまたは名前> <工程>-<試行> --actor <human/…> --if-match <revision> --record-match <recordRevision> [--json]
  raprid approval assign <案件名> <タスクIDまたは名前> <工程>-<試行> --to <human/…|none> --reason <理由> --actor <human/…> --if-match <revision> --record-match <recordRevision> [--json]
  raprid approval approve <案件名> <タスクIDまたは名前> <工程>-<試行> --actor <human/…> [--report <md> ...] --if-match <revision> --record-match <recordRevision> [--json]
  raprid approval reject <案件名> <タスクIDまたは名前> <工程>-<試行> --reason <理由> [--return-to plan|execute|review] --actor <human/…> [--report <md> ...] --if-match <revision> --record-match <recordRevision> [--json]

workflowVersion 4 のタスクの plan・review の提出 (task complete) で作られた判断記録を、人が確かめて承認・見送りする。
list は確認待ち (open の判断記録) の一覧。--unassigned は未割当、--assignee は判断者で絞る。--all は閉じた記録 (approved・rejected・superseded) も出す
show は提出の写し・成果物の参照・履歴・判断の内容・本文のメモと、操作に使う revision (taskRevision・recordRevision) を返す
claim は未割当の記録を自分に割り当てる。assign は判断者を替える (今の判断者本人か、人であるタスクの依頼元だけ。none で未割当に戻す)
approve は判断者本人だけ。plan なら execute が ready に、review ならタスクが closed (approved) になる
reject は判断者本人だけで理由が必須。plan は plan へ戻す (要件の版 +1)。review は --return-to で戻す工程が必須
--if-match は approval show の taskRevision (task show --json --schema-version 3 の revision と同じ)、--record-match は recordRevision
actor は --actor で必ず明示する (環境変数から補わない)。人 (human/…) だけが操作できる`;

const commonOptions = { actor: { type: "string" }, "if-match": { type: "string" }, "record-match": { type: "string" }, json: { type: "boolean" } } as const;
type Spec = Record<string, { type: "string" | "boolean"; multiple?: boolean }>;

function requireActor(value: string | undefined): string {
  if (value === undefined) throw new UsageError("--actor で actor を指定してください (判断記録の操作では環境変数から補わない)");
  return actor(value, "--actor");
}

function requireReason(value: string | undefined): string {
  return singleLine(value, "--reason", true)!;
}

function decisionIdOf(value: string): string {
  if (!approvalIdPattern.test(value)) throw new UsageError(`判断記録の ID は <工程>-<試行> (plan-1・review-3 など) です: ${value}`);
  return value;
}

function reports(values: Record<string, unknown>): ArtifactRef[] | undefined {
  const list = (values.report as string[] | undefined) ?? [];
  return list.length === 0 ? undefined : list.map((path) => ({ path: singleLine(path, "--report", true)! }));
}

// ---- 読み取り ---------------------------------------------------------------------------------------------------------

function list(argv: string[]): void {
  const { positionals, values } = parse(argv, { json: { type: "boolean" }, unassigned: { type: "boolean" }, assignee: { type: "string" }, all: { type: "boolean" } }, usage);
  if (positionals.length > 1) throw new UsageError(usage);
  if (values.unassigned && values.assignee !== undefined) throw new UsageError("--unassigned と --assignee は同時に指定できません");
  const assignee = values.assignee === undefined ? undefined : actor(values.assignee, "--assignee");
  const collector = new Collector(projectRoot());
  const datas = scopeJobs(collector, positionals[0]).map((job) => collector.job(job));
  const entries = approvalEntries(datas, values.all);
  const shown = entries.filter((entry) => matchesApproval(entry, { unassigned: values.unassigned, assignee }));
  const issues = [...approvalIssues(datas, entries), ...(positionals[0] === undefined ? collector.rootIssues : [])];
  if (values.json) {
    printJson(approvalListJson(entries, shown, issues));
    return;
  }
  console.log(renderList(entries, shown, issues, values.all ?? false));
}

function pad(text: string, size: number): string {
  return text + " ".repeat(Math.max(0, size - width(text)));
}

function assigneeText(value: unknown): string {
  return typeof value === "string" ? sanitize(value) : value === null ? "未割当" : "不明";
}

function renderList(entries: ApprovalEntry[], shown: ApprovalEntry[], issues: { code: string; path: string; message: string }[], all: boolean): string {
  const unassigned = entries.filter((entry) => (entry.decision.data?.assignee ?? null) === null).length;
  const lines = [`${all ? "判断記録" : "確認待ち"}: ${shown.length} 件 (全 ${entries.length} 件、未割当 ${unassigned} 件)`];
  if (shown.length > 0) {
    const rows = shown.map((entry) => {
      const data = entry.decision.data ?? {};
      const submission = (data.submission ?? {}) as Record<string, unknown>;
      return [
        sanitize(`${entry.task.job}/${entry.task.id ?? entry.task.name}`),
        sanitize(entry.decision.id),
        sanitize(String(data.status ?? "読めない")),
        assigneeText(data.assignee),
        sanitize(`${String(submission.completedBy ?? "-")} ${String(submission.completedAt ?? "")}`.trim()),
        `${sanitize(entry.task.title ?? entry.task.name)}${entry.decision.valid ? "" : " [要確認]"}`,
      ];
    });
    const heads = ["タスク", "記録", "状態", "判断者", "提出", "タイトル"];
    const sizes = heads.map((head, index) => Math.max(width(head), ...rows.map((row) => width(row[index]))));
    lines.push(heads.map((head, index) => (index === heads.length - 1 ? head : pad(head, sizes[index]))).join("  "));
    for (const row of rows) lines.push(row.map((cell, index) => (index === row.length - 1 ? cell : pad(cell, sizes[index]))).join("  "));
  }
  if (issues.length > 0) {
    lines.push("", `要確認: ${issues.length} 件`);
    for (const issue of issues) lines.push(`  ${issue.code} ${sanitize(issue.path)}: ${sanitize(issue.message)}`);
  }
  return lines.join("\n");
}

function findEntry(jobName: string, selector: string, id: string): { entry: ApprovalEntry; issues: ReturnType<typeof approvalIssues> } {
  const collector = new Collector(projectRoot());
  const job = Job.existing(collector.root, jobName);
  const data = collector.job(job);
  const found = findItem(data, "task", selector);
  const record = found.record;
  if (!isWorkflow(record) || record.kind !== "task" || record.workflow.version !== 4) {
    throw new CliError(`workflowVersion 4 のタスクではないので判断記録がありません: ${record.path}\n人の承認を判断記録で行うには workflowVersion 4 へ移行してください`, 1, "WF_NOT_V4");
  }
  const task = record as TaskRecord & { workflow: WorkflowInfo };
  const decision = task.workflow.decisions.find((each) => each.id === id);
  if (!decision) throw new CliError(`判断記録が見つかりません: ${task.path.replace(/index\.md$/, "")}decisions/${id}.md`, 1, "APPROVAL_NOT_FOUND");
  const entry = { task, decision };
  return { entry, issues: approvalIssues([data], [entry]) };
}

function show(argv: string[]): void {
  const { positionals, values } = parse(argv, { json: { type: "boolean" } }, usage);
  if (positionals.length !== 3) throw new UsageError(usage);
  const id = decisionIdOf(positionals[2]);
  const { entry, issues } = findEntry(positionals[0], positionals[1], id);
  if (values.json) {
    printJson({ schemaVersion: 3, kind: "approval", item: approvalJson(entry, true), issues });
    return;
  }
  const item = approvalJson(entry, true);
  const submission = (item.submission ?? {}) as Record<string, unknown>;
  const refs = Array.isArray(submission.artifactRefs) ? (submission.artifactRefs as Record<string, unknown>[]) : [];
  const refText = (ref: Record<string, unknown>) => sanitize(ref.path !== undefined ? String(ref.path) : `${String(ref.repo)}@${String(ref.commit)}`);
  const fields: [string, string][] = [
    ["タスク", sanitize(`${entry.task.job}/${entry.task.id ?? entry.task.name} ${entry.task.title ?? ""}`.trim())],
    ["タスクの状態", sanitize(`${entry.task.status ?? "-"} / ${entry.task.workflow.phase ?? "-"}`)],
    ["依頼元", sanitize(entry.task.requestedBy ?? "-")],
    ["状態", `${sanitize(String(item.status ?? "読めない"))}${entry.decision.current ? " (タスクが待っている)" : ""}${entry.decision.valid ? "" : " 要確認"}`],
    ["判断者", assigneeText(item.assignee)],
    ["要件の版", String(item.requirementRevision ?? "-")],
    ["提出", sanitize(`${String(submission.completedBy ?? "-")} ${String(submission.completedAt ?? "")} (seq ${String(item.submissionSeq ?? "-")})`)],
    ["成果物", refs.length > 0 ? refs.map(refText).join(", ") : "-"],
  ];
  if (item.outcome !== null) fields.push(["判断", sanitize(`${String(item.outcome)} ${String(item.decidedBy ?? "")} ${String(item.decidedAt ?? "")}`.trim())]);
  if (item.returnTo !== null) fields.push(["戻す工程", sanitize(String(item.returnTo))]);
  if (item.reason !== null) fields.push(["理由", sanitize(String(item.reason))]);
  for (const entry of (item.history as Record<string, unknown>[]) ?? []) {
    fields.push(["履歴", [entry.seq, entry.at, entry.actor, entry.event, entry.from === null ? "未割当" : entry.from, "→", entry.to === null ? "未割当" : entry.to, entry.reason].filter((value) => value !== null && value !== undefined).map((value) => sanitize(String(value))).join(" ")]);
  }
  fields.push(["パス", sanitize(String(item.path))], ["taskRevision", String(item.taskRevision ?? "-")], ["recordRevision", String(item.recordRevision ?? "-")]);
  const labelWidth = Math.max(...fields.map(([label]) => width(label)));
  const out = fields.map(([label, value]) => `${pad(label, labelWidth)}  ${value}`);
  if (typeof item.rawMarkdown === "string" && item.rawMarkdown.trim() !== "") out.push("", sanitize(item.rawMarkdown, true).replace(/\n+$/, ""));
  if (issues.length > 0) {
    out.push("", `要確認: ${issues.length} 件`);
    for (const issue of issues) out.push(`  ${issue.code} ${sanitize(issue.path)}: ${sanitize(issue.message)}`);
  }
  console.log(out.join("\n"));
}

// ---- 操作 ---------------------------------------------------------------------------------------------------------------

function operationCommand(argv: string[], extra: Spec, build: (values: Record<string, unknown>, id: string) => OperationV4): void {
  const { positionals, values } = parse(argv, { ...commonOptions, ...extra }, usage);
  if (positionals.length !== 3) throw new UsageError(usage);
  const id = decisionIdOf(positionals[2]);
  const operation = build(values as Record<string, unknown>, id);
  const root = projectRoot();
  const job = Job.existing(root, positionals[0]);
  const result = runTransitionV4(root, job.name, positionals[1], { ifMatch: values["if-match"] as string | undefined, recordMatch: values["record-match"] as string | undefined }, operation);
  reportV4(root, job, result, values.json as boolean | undefined);
}

function claim(argv: string[]): void {
  operationCommand(argv, {}, (values, id) => ({ kind: "approval-claim", actor: requireActor(values.actor as string | undefined), id }));
}

function assign(argv: string[]): void {
  operationCommand(argv, { to: { type: "string" }, reason: { type: "string" } }, (values, id) => {
    const to = values.to as string | undefined;
    if (to === undefined) throw new UsageError("--to に新しい判断者 (human/<識別子>) か none (未割当に戻す) を指定してください");
    return { kind: "approval-assign", actor: requireActor(values.actor as string | undefined), id, to: to === "none" ? null : actor(to, "--to"), reason: requireReason(values.reason as string | undefined) };
  });
}

function approve(argv: string[]): void {
  operationCommand(argv, { report: { type: "string", multiple: true } }, (values, id) => ({ kind: "approve", actor: requireActor(values.actor as string | undefined), id, reportRefs: reports(values) }));
}

function reject(argv: string[]): void {
  operationCommand(argv, { reason: { type: "string" }, "return-to": { type: "string" }, report: { type: "string", multiple: true } }, (values, id) => {
    const returnTo = values["return-to"] as string | undefined;
    if (returnTo !== undefined && !(phasesV4 as readonly string[]).includes(returnTo)) throw new UsageError(`--return-to は ${phasesV4.join(" / ")} のいずれかです: ${returnTo}`);
    return { kind: "reject", actor: requireActor(values.actor as string | undefined), id, reason: requireReason(values.reason as string | undefined), returnTo: returnTo as PhaseV4 | undefined, reportRefs: reports(values) };
  });
}

export function run(argv: string[]): void {
  response.version = 3;
  const [command, ...rest] = argv;
  const commands: Record<string, (args: string[]) => void> = { list, show, claim, assign, approve, reject };
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    console.log(usage);
    if (command === undefined) process.exitCode = 2;
    return;
  }
  if (!commands[command]) throw new UsageError(`不明なコマンド: approval ${command}\n${usage}`);
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(usage);
    return;
  }
  commands[command](rest);
}
