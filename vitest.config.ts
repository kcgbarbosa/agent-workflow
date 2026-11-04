import { defineConfig } from "vitest/config";

// The repo checks of agent-workflow. The runner's own tests run from `runner/`.
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], globalSetup: ["tests/checkout.ts"] },
});
