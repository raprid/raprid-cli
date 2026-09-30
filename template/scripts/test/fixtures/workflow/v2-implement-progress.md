---
id: T-012
workflowVersion: 2
status: open
phase: implement
requirementRevision: 1
createdAt: 2026-09-28
updatedAt: 2026-09-29
completedAt:
closureReason:
requestedBy: human/saiki
createdBy: agent/codex
blockedBy: []
relatedTasks:
  - task/T-011
  - task/other/T-003
test:
  - docs/feature/raprid/workflow-data-model.feature
# 工程ごとの記録
workflow:
  plan:
    status: done
    attempt: 1
    assignee: agent/codex
    completedBy: agent/codex
    completedAt: 2026-09-28
    outcome: completed
    inputRevision: 1
    inputSeq:
    artifactRefs:
      - path: 01-implementation-plan.md
  implement:
    status: progress
    attempt: 1
    assignee: agent/claude
    completedBy:
    completedAt:
    outcome:
    inputRevision: 1
    inputSeq: 2
    artifactRefs:
      - repo: project_template
        commit: 11354a7
        path: 02-implementation.md
  review:
    status: waiting
    attempt: 1
    assignee: agent/codex
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
    at: 2026-09-28T01:00:00Z
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
    at: 2026-09-28T03:00:00Z
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
      - path: 01-implementation-plan.md
  - seq: 3
    at: 2026-09-29T00:30:00+09:00
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
    sessionId: 3c712208-c6af-4379-b601-6bed97590ba9
---

# 概要

本文はそのまま残る。

```yaml
status: todo # 本文のコードブロックは frontmatter ではない
```
