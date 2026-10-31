#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// The Claude Code PostToolUse hook on Edit and Write. Runs Prettier on the Markdown file the agent changed, from the file's folder, so the repo's own Prettier pin and config apply.
// A Prettier failure exits 2, which Claude Code sends to the agent.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const input = JSON.parse(readFileSync(0, "utf8"));
const path: unknown = input.tool_input?.file_path;
if (typeof path !== "string" || !path.endsWith(".md")) process.exit(0);

const file = resolve(input.cwd ?? ".", path);
const prettier = spawnSync("mise", ["exec", "--", "prettier", "--write", file], { cwd: dirname(file), encoding: "utf8" });
if (prettier.error) {
  // mise did not start, which the agent cannot fix, so the error goes to KC and not to the agent.
  console.error(`format-markdown: ${prettier.error.message}`);
  process.exit(1);
}
if (prettier.status !== 0) {
  process.stderr.write(prettier.stderr || prettier.stdout);
  process.exit(2);
}
