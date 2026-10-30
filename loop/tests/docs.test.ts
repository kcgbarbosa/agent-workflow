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
