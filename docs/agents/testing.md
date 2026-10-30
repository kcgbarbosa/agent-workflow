# Testing

No acceptance suite. Each skill skips its acceptance steps.

The tests are pytest suites and the TypeScript loop's Vitest suite in `loop/`. `make check` runs them all, and the `Makefile` gives the command of each. A ticket proves its change with a test at the seam that the spec names, through `/tdd`.
