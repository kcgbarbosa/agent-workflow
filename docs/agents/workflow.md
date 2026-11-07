# The build workflow

[`skills/setup-repo/workflow.md`](../../skills/setup-repo/workflow.md) is this repo's workflow, with `docs/specs` as `<spec folder>`. Read it there, and change a shared rule there.

Only this repo:

- Pitchridge requires only `gate / check`, and its fuzz findings reach the owner through `bots/chief.md`.
- machines is on the gate and the runner too, so nobody merges there by hand.
