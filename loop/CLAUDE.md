# The loop

`skills/setup-loop/loop.md` is the design this code follows, and the one place it is written down.

- A change to what the loop does updates `loop.md` in the same pull request. `tests/test_docs.py` fails when a `loop.toml` key is missing from it.
- A new `loop.toml` key gets a default, so every repo's existing file still loads.
- Run `uv run pytest` here.

## The TypeScript loop

`src/*.ts`, `bin/loop`, and `tests/*.test.ts` are the TypeScript loop of `docs/specs/shared-merge-gate.md`, beside the Python loop until the cutover ticket.

- Node runs the `.ts` files as they are, so the code uses only syntax that Node can strip: no enums, no parameter properties.
- The scenario tests run `bin/loop` as a subprocess against the fakes in `tests/fakes/`. `tests/world.ts` builds a scenario's world.
- Run `npm run check` here.
