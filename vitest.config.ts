import { defineConfig } from "vitest/config";

// The repo checks of agent-workflow. The loop's own tests run from `loop/`.
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], globalSetup: ["tests/checkout.ts"] },
});
