---
id: T-218
workflowVersion: 4
type: research
status: open
phase: execute
requirementRevision: 1
createdAt: 2026-10-01
updatedAt: 2026-10-06
completedAt:
closureReason:
requestedBy: human/saiki
createdBy: agent/codex
blockedBy: []
relatedTasks: []
workflow:
  plan:
    status: done
    attempt: 1
    assignee: agent/codex
    completedBy: agent/codex
    completedAt: 2026-10-01
    outcome: completed
    inputRevision: 1
    inputSeq:
    artifactRefs:
      - path: 01-plan.md
    approval: legacy_unverified
  execute:
    status: ready
    attempt: 1
    assignee:
    completedBy:
    completedAt:
    outcome:
    inputRevision: 1
    inputSeq: 2
    artifactRefs: []
  review:
    status: waiting
    attempt: 1
    assignee:
    completedBy:
    completedAt:
    outcome:
    inputRevision:
    inputSeq:
    artifactRefs: []
    approval:
history:
  - seq: 1
    at: 2026-10-01T01:00:00Z
    actor: agent/codex
    event: create
    phase: plan
    attempt: 1
    inputRevision: 1
    outcome:
    from:
    to: ready
    reason:
    refersTo:
    refs: []
  - seq: 2
    at: 2026-10-01T03:00:00Z
    actor: agent/codex
    event: complete
    phase: plan
    attempt: 1
    inputRevision: 1
    outcome: completed
    from: progress
    to: done
    reason:
    refersTo:
    refs:
      - path: 01-plan.md
  - seq: 3
    at: 2026-10-06T01:00:00Z
    actor: human/saiki
    event: migrate
    phase:
    attempt:
    inputRevision:
    outcome:
    from: "3"
    to: "4"
    reason: "workflowVersion 3 から 4 へ移行 (planApproval: legacy_unverified)"
    refersTo:
    refs: []
migratedFrom:
  workflowVersion: 3
  acceptance:
    status: waiting
    attempt: 1
    assignee:
    completedBy:
    completedAt:
    outcome:
    inputRevision:
    inputSeq:
    artifactRefs: []
---

# 概要

## タイトル

research-migrated-execute-unverified のフィクスチャ (workflowVersion 4)
