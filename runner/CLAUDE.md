# The runner

`docs/adr/` holds the decisions this code follows. It runs on t14 as a timer, and a merged change reaches it within two minutes. `docs/agents/runner.md` gives how, and how to read a failed pull.

- A tick is `src/read.ts`, which writes nothing, the pure `src/decide.ts`, `src/act.ts`, and `src/today.ts`, which writes the Today file. `--dry-run` skips `act`.
- `src/*.ts` is the runner and `bin/runner` its command. Node runs the `.ts` files as they are, so the code uses only syntax that Node can strip: no enums, no parameter properties.
- `runner install` writes the repo's user systemd timer and oneshot service and the shared `runner-update` pair, `src/install.ts`, and `runner uninstall` removes them. The fake `systemctl` keeps the tests off the real user units.
- `runner tasks` registers the prompts of `tasks/` as T3 scheduled tasks, `src/tasks.ts`. `tests/tasks.test.ts` at the repo's root checks it.
- Each repo's settings are its `runner.toml`, read from the current folder. A new key gets a default, so every repo's existing file still loads.
- It reads the Jira email and token and the repo's Slack webhook from its env. By hand, in the repo: `set -a; . ~/.config/bws/token.env; set +a; bws run -- 'runner tick --dry-run'`.
- A skill the runner names in a message must be model-invocable, with no `disable-model-invocation` in its frontmatter, or the thread is refused. `tests/skills.test.ts` checks it.
- The scenario tests run `bin/runner` as a subprocess against the fakes in `tests/fakes/`. `tests/world.ts` builds a scenario's world.
- Run `npm run check` here.
