// No tracked file has an em dash, except the global rule that bans them.
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test } from "vitest";
import { REPO, tracked } from "./repo.ts";

const EM_DASH = "\u2014";
const RULE = `Never use em dashes (${EM_DASH}) in any writing.`;
const INSTRUCTIONS = join(REPO, "config", "CLAUDE.md");

function emDashLines(path: string): number[] {
  const bytes = readFileSync(path);
  if (bytes.includes(0)) return [];
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return [];
  }
  if (path === INSTRUCTIONS) text = text.replace(RULE, "");
  return text.split("\n").flatMap((line, index) => (line.includes(EM_DASH) ? [index + 1] : []));
}

test("no tracked file has an em dash", () => {
  const found = tracked()
    .map((path) => relative(REPO, path))
    .filter((name) => name.split(sep)[0] !== "licenses")
    .flatMap((name) => emDashLines(join(REPO, name)).map((line) => `${name}:${line}`));
  expect(found).toEqual([]);
});

test("the rule is still in the global instructions", () => {
  expect(readFileSync(INSTRUCTIONS, "utf8")).toContain(RULE);
});
