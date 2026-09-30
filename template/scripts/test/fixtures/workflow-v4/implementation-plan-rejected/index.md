---
id: T-210
workflowVersion: 4
type: implementation
status: open
phase: plan
requirementRevision: 2
createdAt: 2026-10-01
updatedAt: 2026-10-01
completedAt:
closureReason:
requestedBy: human/saiki
createdBy: agent/codex
blockedBy: []
relatedTasks: []
workflow:
  plan:
    status: progress
    attempt: 2
    assignee: agent/codex
    completedBy:
    completedAt:
    outcome:
    inputRevision: 2
    inputSeq:
    artifactRefs: []
    approval:
  execute:
    status: waiting
    attempt: 1
    assignee:
    completedBy:
    completedAt:
    outcome:
    inputRevision:
    inputSeq:
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
    event: reject
    phase: plan
    attempt: 1
    inputRevision: 1
    outcome:
    from: pending
    to: plan
    reason: 対象の範囲が曖昧
    refersTo:
    refs:
      - path: decisions/plan-1.md
  - seq: 5
    at: 2026-10-01T06:00:00Z
    actor: agent/codex
    event: claim
    phase: plan
    attempt: 2
    inputRevision: 2
    outcome:
    from: ready
    to: progress
    reason:
    refersTo:
    refs: []
---

# 概要

## タイトル

implementation-plan-rejected のフィクスチャ (workflowVersion 4)
