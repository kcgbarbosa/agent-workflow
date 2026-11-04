import { defineConfig } from "vitest/config";

// Each scenario runs the runner as a subprocess.
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], testTimeout: 60_000 },
});
