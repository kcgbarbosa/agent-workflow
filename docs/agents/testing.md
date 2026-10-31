# Testing

No acceptance suite. Each skill skips its acceptance steps.

The tests are the repo checks' Vitest suite in `tests/`, the pytest suite of the gate's Python scripts beside it, the switchboard's Vitest suite in `switchboard/`, and the TypeScript loop's Vitest suite in `loop/`. The checks of `lefthook.yml` run at each commit and first in `make check`. The `Makefile` gives the command of each, such as `cd loop && npx vitest run tests/run.test.ts` for one Vitest file. The gate runs them all with `make check` on each pull request, so an agent runs the tests that cover its change, not the full `make check`. A ticket proves its change with a test at the seam that the spec names, through `/tdd`.
