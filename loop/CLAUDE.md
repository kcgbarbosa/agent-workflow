# The loop

`skills/setup-loop/loop.md` is the design this code follows, and the one place it is written down.

- A change to what the loop does updates `loop.md` in the same pull request. `tests/test_docs.py` fails when a `loop.toml` key is missing from it.
- A new `loop.toml` key gets a default, so every repo's existing file still loads.
- Run `uv run pytest` here. The tests need GNU `timeout` on PATH.
