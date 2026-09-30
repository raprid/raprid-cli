---
id: T-206
workflowVersion: 4
type: research
status: open
phase: execute
requirementRevision: 1
createdAt: 2026-10-01
updatedAt: 2026-10-02
completedAt:
closureReason:
requestedBy: human/saiki
createdBy: agent/codex
blockedBy:
  - qa/Q-001
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
    approval: plan-1
  execute:
    status: pending
    attempt: 1
    assignee: agent/claude
    completedBy:
    completedAt:
    outcome:
    inputRevision: 1
    inputSeq: 3
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
    at: 2026-10-01T02:00:00Z
    actor: agent/codex
    event: claim
    phase: plan
    attempt: 1
    inputRevision: 1
    outcome:
    from: ready
    to: progress
    reason:
    refersTo:
    refs: []
  - seq: 3
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
  - seq: 4
    at: 2026-10-01T05:00:00Z
    actor: human/saiki
    event: approve
    phase: plan
    attempt: 1
    inputRevision: 1
    outcome:
    from: pending
    to: open
    reason:
    refersTo:
    refs:
      - path: decisions/plan-1.md
  - seq: 5
    at: 2026-10-02T01:00:00Z
    actor: agent/claude
    event: claim
    phase: execute
    attempt: 1
    inputRevision: 1
    outcome:
    from: ready
    to: progress
    reason:
    refersTo:
    refs: []
  - seq: 6
    at: 2026-10-02T02:00:00Z
    actor: agent/claude
    event: block
    phase: execute
    attempt: 1
    inputRevision: 1
    outcome:
    from: progress
    to: pending
    reason: qa/Q-001 の回答待ち
    refersTo:
    refs: []
---

# 概要

## タイトル

research-execute-pending-qa のフィクスチャ (workflowVersion 4)
