// A name the repo has retired stays in no tracked file, so a pull request's own grep cannot miss one. Retire a name by adding it here.
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";
import { REPO, tracked } from "./repo.ts";

// `except` holds the folders where the word means something else.
const RETIRED: { name: RegExp; instead: string; except?: string[] }[] = [
  // The carried skills mean a feedback loop, and `calm` an animation's.
  { name: /\bloop\b/i, instead: "the runner, `runner/CLAUDE.md`", except: ["skills/calm/", "skills/diagnosing-bugs/", "skills/tdd/", "skills/teach/", "skills/writing-for-agents/"] },
  { name: /\bdispatcher\b/i, instead: "the runner, `GLOSSARY.md`" },
  { name: /\bBacklog\b/, instead: "Awaiting Approval, ADR-0009" },
  { name: /\bproposed bug\b/i, instead: "a Bug, ADR-0009" },
  // The runner's tests prove that it refuses the old key.
  { name: /\bntfy\b/i, instead: "Slack, `docs/agents/runner.md`", except: ["runner/tests/"] },
  { name: /\bretro\b/i, instead: "`/correct`" },
];

// These may name the old things: the glossary's `_Avoid_`, a spec's history, the licenses, and the fixtures of `tests/`, this table among them.
const OUT_OF_SCOPE = ["GLOSSARY.md", "docs/specs/", "licenses/", "tests/"];

// `retired-name-ok until <YYYY-MM-DD>, approved <who>: <reason>` on the line.
const EXCEPTION = /retired-name-ok until (\d{4}-\d{2}-\d{2}), approved \w+: \S/;

// An ADR's Amendments hold the old decision, so that no agent proposes it again.
const current = (name: string, text: string) => (name.startsWith("docs/adr/") ? text.split("## Amendments")[0] : text);

function offencesInLine(name: string, line: string, today: string): string[] {
  const until = EXCEPTION.exec(line)?.[1];
  if (until && until >= today) return [];
  return RETIRED.filter(({ name: retired, except }) => retired.test(line) && !except?.some((scope) => name.startsWith(scope))).map(
    ({ name: retired, instead }) => `${name} says ${retired.source.replaceAll("\\b", "")}. Use ${instead}.`,
  );
}

test("no tracked file names a retired name", () => {
  const today = new Date().toISOString().slice(0, 10);
  const found = tracked()
    .map((path) => relative(REPO, path))
    .filter((name) => !OUT_OF_SCOPE.some((scope) => name.startsWith(scope)))
    .flatMap((name) => {
      const bytes = readFileSync(join(REPO, name));
      if (bytes.includes(0)) return [];
      return current(name, bytes.toString("utf8"))
        .split("\n")
        .flatMap((line, index) => offencesInLine(`${name}:${index + 1}`, line, today));
    });
  expect(found).toEqual([]);
});

test("an exception counts until its date, and needs a date, an approval and a reason", () => {
  const named = (comment: string) => offencesInLine("a.md", `the dispatcher ${comment}`, "2027-01-01");
  expect(named("")).toEqual(["a.md says dispatcher. Use the runner, `GLOSSARY.md`."]);
  expect(named("retired-name-ok until 2027-01-01, approved KC: a reason")).toEqual([]);
  expect(named("retired-name-ok until 2026-12-31, approved KC: a reason")).toHaveLength(1);
  expect(named("retired-name-ok until 2027-01-01, approved KC:")).toHaveLength(1);
  expect(named("retired-name-ok until 2027-01-01: a reason")).toHaveLength(1);
});

test("a folder where the word means something else keeps it, and only that folder", () => {
  expect(offencesInLine("skills/tdd/SKILL.md", "the loop", "2027-01-01")).toEqual([]);
  expect(offencesInLine("skills/correct/SKILL.md", "the loop", "2027-01-01")).toHaveLength(1);
});
