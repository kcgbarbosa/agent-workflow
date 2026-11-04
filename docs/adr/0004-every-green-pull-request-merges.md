# Every green pull request merges

The runner has no blast levels, holds or path globs. Every pull request merges when the gate is green, so code reaches staging as soon as possible. The guardrails exist to give the owner confidence to merge: the gate blocks a red pull request, staging uses no production service, and production changes only on the owner's release tag, which an earlier tag rolls back. Dangerous work is Flagged before it builds. A migration gets its scrutiny before the tag, because a rollback may not undo it (inference, not verified).

## Considered Options

- Keeping only the red level, as drafts for auth, roles, release, retention, presign and migrations. Rejected because a draft holds code back from staging, where the owner wants to see it.
- Keeping green, yellow and red. Rejected for the same reason, and because it needs path globs and labels.

## Consequences

A merge also deploys the apex and the `.co` redirect, so a merge is not limited to staging.
