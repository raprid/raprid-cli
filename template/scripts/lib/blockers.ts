// 待っている相手 (blockedBy) のうち QA を指すものの扱い。旧形式の task move と新形式の resume で共有する

import { CliError } from "./errors.ts";
import type { Job } from "./jobs.ts";
import { Collector } from "./records.ts";

// blockedBy のうち QA を指すものの案件名 (qa/Q-001 は同じ案件、qa/<案件名>/Q-001 は別案件)
export function qaJobs(jobName: string, blockedBy: string[]): string[] {
  return blockedBy
    .map((reference) => reference.split("/"))
    .filter((parts) => parts[0] === "qa" && (parts.length === 2 || parts.length === 3))
    .map((parts) => (parts.length === 3 ? parts[1] : jobName));
}

// pending から離れるとき、待っている QA がすべて解決済みか確かめる (ロック内で読み直す)
export function assertQaResolved(root: string, job: Job, blockedBy: string[]): void {
  const collector = new Collector(root);
  const problems: string[] = [];
  for (const reference of blockedBy) {
    const result = collector.resolveQa(job, reference);
    if (result.state === "not-qa" || result.state === "resolved") continue;
    const reason = { unresolved: "未解決", "invalid-status": "状態が不正", ambiguous: "特定できない (ID が重複)", "not-found": "見つからない" }[result.state];
    problems.push(`${reference} (${reason})`);
  }
  if (problems.length > 0) {
    throw new CliError(`待っているQAが解決していないため pending を解除できません: ${problems.join(", ")}\nQAを解決してから再度実行してください`, 1, "BLOCKED_BY_QA");
  }
}

