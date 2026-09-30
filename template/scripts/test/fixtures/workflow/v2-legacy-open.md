---
id: T-002
workflowVersion: 2
status: open
phase: implement
requirementRevision: 1
createdAt: 2026-09-28
updatedAt: 2026-10-05
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
    assignee:
    completedBy:
    completedAt:
    outcome: legacy_import
    inputRevision:
    inputSeq:
    artifactRefs: []
  implement:
    status: progress
    attempt: 1
    assignee: agent/claude
    completedBy:
    completedAt:
    outcome:
    inputRevision: 1
    inputSeq: 1
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
  acceptance:
    status: waiting
    attempt: 1
    assignee: human/saiki
    completedBy:
    completedAt:
    outcome:
    inputRevision:
    inputSeq:
    artifactRefs: []
history:
  - seq: 1
    at: 2026-10-05T01:00:00Z
    actor: agent/codex
    event: legacy_import
    phase: plan
    attempt: 1
    inputRevision:
    outcome: legacy_import
    from: todo
    to: done
    reason: 旧形式の todo を実装から移行 (計画の証跡未確認)
    refersTo:
    refs: []
  - seq: 2
    at: 2026-10-05T02:00:00Z
    actor: agent/claude
    event: claim
    phase: implement
    attempt: 1
    inputRevision: 1
    outcome:
    from: ready
    to: progress
    reason:
    refersTo:
    refs: []
---

# 概要
