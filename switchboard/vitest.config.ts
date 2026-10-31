import { defineConfig } from "vitest/config";

// The tests talk to the server over real HTTP, against the fake `claude` in `tests/fakes/`.
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], testTimeout: 30_000 },
});
