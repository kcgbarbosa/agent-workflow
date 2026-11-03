// The design doc names every `loop.toml` key the code reads, so a new key cannot ship undocumented.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const DESIGN = new URL("../../skills/setup-loop/loop.md", import.meta.url);

test("the design doc names every loop.toml key", () => {
  const source = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
  const keys = new Set([...source.matchAll(/\.(?:text|number|texts|tables|table|flag|date)\(\s*"([a-z_]+)"/g)].map((match) => match[1]!));
  const doc = readFileSync(DESIGN, "utf8");

  expect(keys.size, "the key pattern no longer matches config.ts").toBeGreaterThan(10);
  const missing = [...keys].filter((key) => !new RegExp(`\`[^\`\\n]*\\b${key}\\b[^\`\\n]*\``).test(doc)).sort();
  expect(missing, `${DESIGN.pathname} does not name these loop.toml keys`).toEqual([]);
});

test("the design doc's Log rule names every step the code logs", () => {
  const sources = ["run.ts", "dispatch.ts", "epic.ts"].map((file) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8")).join("\n");
  const steps = new Set([...sources.matchAll(/log\.write\([^,]+, "([a-z-]+)"/g)].map((match) => match[1]!));
  const rule = readFileSync(DESIGN, "utf8")
    .split("\n")
    .find((line) => line.startsWith("11. **Log.**"))!;

  expect(steps.size, "the step pattern no longer matches the code").toBeGreaterThan(10);
  expect([...steps].filter((step) => !rule.includes(`\`${step}\``)).sort(), "the Log rule does not name these steps").toEqual([]);
  expect(rule).not.toMatch(/`respond`/);
});

test("dispatch.md names the four principles, the laziness protocol among them", () => {
  const dispatch = readFileSync(new URL("../src/dispatch.md", import.meta.url), "utf8");

  for (const principle of ["Encode lessons in structure", "Prove it works", "Never block on the human", "Laziness protocol"]) expect(dispatch).toContain(principle);
  expect(dispatch).toContain("the smallest change that solves the problem");
  expect(dispatch).toContain("a Bug fix touches the files the reproduction touches");
});
