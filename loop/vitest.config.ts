import { defineConfig } from "vitest/config";

// Each scenario runs the loop as a subprocess, which spends most of its time waiting.
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 60_000 },
});
