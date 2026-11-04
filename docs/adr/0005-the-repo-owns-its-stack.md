# The repo owns its stack

A repo with a stack gives each worktree its ports, not the runner. When a stack starts, the repo's `make` target claims a free port set and writes the env file. At the same point it stops any stack whose worktree no longer exists and drops its database, so cleanup needs no hook and no process of its own. This keeps the runner generic, and every thread, from the CLI or by hand, gets the same full environment. A repo with no stack needs none of this.

The port sets are a fixed list, not any free port. Pitchridge's dev bucket allows only 10 web ports in its CORS rule, so a random port would fail browser uploads and downloads on the real stack. A set counts as free only when its ports are free on the host, because another Compose project can hold one.

## Considered Options

- T3's `runOnWorktreeCreate` and `runOnSettle` project scripts. Rejected because only T3's web client runs them: a scratch thread started with `t3 thread start` did not fire the script on 2026-11-04, and T3's source holds them in its web app.
- The runner assigns ports. Rejected because it puts a repo's stack knowledge in a generic runner, and a thread started by hand gets nothing.
- Docker publishes random host ports. Rejected because of the CORS rule.
