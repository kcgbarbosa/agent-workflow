// A rule that `/setup-repo` seeds lives in its template, and this repo's doc holds only this repo's values, so no change has two copies to keep equal.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { REPO } from "./repo.ts";

const DOCS = ["domain.md", "issue-tracker.md", "testing.md", "workflow.md"];

// Shorter lines are headings and table rules, which two docs can share by chance.
const SENTENCE = 40;

function copied(doc: string, template: string): string[] {
  const own = new Set(doc.split("\n"));
  return template
    .split("\n")
    .filter((line) => line.length >= SENTENCE && own.has(line));
}

test("no doc of docs/agents copies a line of its setup-repo template", () => {
  const found = DOCS.flatMap((name) =>
    copied(
      readFileSync(join(REPO, "docs/agents", name), "utf8"),
      readFileSync(join(REPO, "skills/setup-repo", name), "utf8"),
    ).map(
      (line) =>
        `docs/agents/${name} copies "${line}". Keep it in skills/setup-repo/${name}, and only this repo's values in the doc.`,
    ),
  );
  expect(found).toEqual([]);
});

test("a line finds its copy only when the whole line matches and is a sentence long", () => {
  const rule =
    "A new issue starts as Awaiting Approval, and the owner moves it.";
  expect(copied(`# Title\n${rule}\n`, `${rule}\n`)).toEqual([rule]);
  expect(copied(`${rule} More.\n`, `${rule}\n`)).toEqual([]);
  expect(copied("## The board\n", "## The board\n")).toEqual([]);
});
