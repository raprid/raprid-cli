---
id: T-215
workflowVersion: 4
type: implementation
status: closed
phase:
requirementRevision: 1
createdAt: 2026-10-01
updatedAt: 2026-10-06
completedAt: 2026-10-04
closureReason: approved
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
    status: done
    attempt: 1
    assignee: agent/claude
    completedBy: agent/claude
    completedAt: 2026-10-02
    outcome: completed
    inputRevision: 1
    inputSeq: 2
    artifactRefs:
      - repo: project_template
        commit: 873ca38
      - path: 02-handoff.md
  review:
    status: done
    attempt: 1
    assignee: agent/codex
    completedBy: agent/codex
    completedAt: 2026-10-03
    outcome: completed
    inputRevision: 1
    inputSeq: 3
    artifactRefs:
      - path: 03-review.md
    approval: review-1
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
    at: 2026-10-02T05:00:00Z
    actor: agent/claude
    event: complete
    phase: execute
    attempt: 1
    inputRevision: 1
    outcome: completed
    from: progress
    to: done
    reason:
    refersTo:
    refs:
      - repo: project_template
        commit: 873ca38
      - path: 02-handoff.md
  - seq: 4
    at: 2026-10-03T03:00:00Z
    actor: agent/codex
    event: decide
    phase: review
    attempt: 1
    inputRevision: 1
    outcome: approved
    from: progress
    to: done
    reason:
    refersTo:
    refs:
      - path: 03-review.md
  - seq: 5
    at: 2026-10-04T01:00:00Z
    actor: human/saiki
    event: decide
    phase: acceptance
    attempt: 1
    inputRevision: 1
    outcome: approved
    from: progress
    to: done
    reason:
    refersTo:
    refs:
      - path: 04-acceptance.md
  - seq: 6
    at: 2026-10-06T01:00:00Z
    actor: human/saiki
    event: migrate
    phase:
    attempt:
    inputRevision:
    outcome:
    from: "3"
    to: "4"
    reason: workflowVersion 3 から 4 へ移行 (受入確認 seq 5 を review-1 の承認に写す)
    refersTo:
    refs: []
migratedFrom:
  workflowVersion: 3
  acceptance:
    status: done
    attempt: 1
    assignee: human/saiki
    completedBy: human/saiki
    completedAt: 2026-10-04
    outcome: approved
    inputRevision: 1
    inputSeq: 4
    artifactRefs:
      - path: 04-acceptance.md
---

# 概要

## タイトル

implementation-migrated-closed-accepted のフィクスチャ (workflowVersion 4)
