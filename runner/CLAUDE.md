# The runner

`docs/specs/t3-runner.md` is the design this code follows. Nothing calls it until the switch-over ticket.

- A tick is `src/read.ts`, which writes nothing, the pure `src/decide.ts`, and `src/act.ts`. `--dry-run` stops before `act`.
- `src/*.ts` is the runner and `bin/runner` its command. Node runs the `.ts` files as they are, so the code uses only syntax that Node can strip: no enums, no parameter properties.
- `runner install` writes the repo's user systemd timer and oneshot service, `src/install.ts`, and `runner uninstall` removes them. The fake `systemctl` keeps the tests off the real user units.
- Each repo's settings are its `runner.toml`, read from the current folder. A new key gets a default, so every repo's existing file still loads.
- It reads the Jira email and token and the ntfy topic from its env. By hand, in the repo: `set -a; . ~/.config/bws/token.env; set +a; bws run -- 'runner tick --dry-run'`.
- The scenario tests run `bin/runner` as a subprocess against the fakes in `tests/fakes/`. `tests/world.ts` builds a scenario's world.
- Run `npm run check` here.
