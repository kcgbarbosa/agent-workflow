// The docs, skills and templates describe the per-ticket loop, so an agent that trusts them makes no change for the
// Epic run. `docs/specs/per-ticket-loop.md` and `skills/setup-loop/loop.md` are the source of truth.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const docs = execFileSync(
  "git",
  ["ls-files", "*.md", "*.yaml", "*.yml", "*.toml", "*.sh", "*.py"],
  { cwd: root, encoding: "utf8" },
)
  .split("\n")
  .filter(
    (path) =>
      path &&
      !/^(docs\/specs|docs\/research|loop\/(src|tests)|switchboard|tests|licenses)\//.test(
        path,
      ),
  );

const hits = (stale: RegExp) => docs.filter((path) => stale.test(read(path)));

test.each([
  [
    "an Epic run",
    /tickets? of an Epic\b|an Epic's tickets|the loop builds an Epic|builds one Epic|<Epic key>\/|loop-<name>-<Epic key>|for each Epic\b|the frontier starts/i,
  ],
  ["stacking", /\bstack(s|ed|ing)? on\b|\bunless it stacks\b|\bA stacked\b/],
  ["the respond step", /\brespond step\b/],
  ["/retro", /\/retro\b|`retro`/],
  ["a manual ticket", /`manual`/],
  ["a human-step ticket", /a human step|human ticket/i],
  ["the old run folder", /<name>-loop\/<run>|`filter-<hash>`\./],
])("no doc describes %s", (_name, stale) => {
  expect(hits(stale)).toEqual([]);
});

test("the review is named only where a repo moves off it", () => {
  expect(hits(/gate \/ review|\[review\]/).sort()).toEqual(
    [
      "actions/fuzz/fuzz.py",
      "skills/setup-loop/SKILL.md",
      "skills/setup-loop/loop.md",
      "skills/setup-loop/values.md",
      "skills/setup-repo/SKILL.md",
      "skills/setup-repo/gate.sh",
    ].filter((path) => docs.includes(path)),
  );
  expect(hits(/turns the review on/)).toEqual([]);
});

test.each([
  "docs/agents/issue-tracker.md",
  "skills/setup-repo/issue-tracker.md",
])("%s says what Jira holds", (path) => {
  const tracker = read(path);
  expect(tracker).toContain("## What Jira holds");
  expect(tracker).toContain("Jira holds only work an agent does");
  expect(tracker).toContain("gets no ticket");
  expect(tracker).toContain(
    "moves to Done with the label `wont-do` and a comment that gives the reason",
  );
  expect(tracker).toContain("a Bug with no parent");
  expect(tracker).toContain("Flagged means the ticket waits on the owner");
  expect(tracker).toMatch(/\| Component +\| The repo the ticket changes/);
  expect(tracker).toContain("once every Epic whose Spec line links it is Done");
});

test("/setup-repo and /setup-loop write the per-ticket docs on a new repo", () => {
  for (const path of [
    "docs/agents/workflow.md",
    "skills/setup-repo/workflow.md",
  ]) {
    const workflow = read(path);
    expect(workflow).toContain("`[fuzz] enabled`");
    expect(workflow).toContain("Each ready ticket of the queue");
    expect(workflow).toContain("the component decides");
  }
  const setup = read("skills/setup-loop/SKILL.md");
  expect(setup).toContain(
    "the loop builds each ready ticket of the queue, with no stacking",
  );
  expect(setup).toContain("What Jira holds");
  expect(read("skills/setup-repo/SKILL.md")).toContain(
    "build the repo's ready tickets unattended",
  );
  // `/setup-loop` writes `docs/agents/loop.md` from the headings of the design file and the rules of values.md.
  const values = read("skills/setup-loop/values.md");
  expect(values).toContain("gets no ticket");
  expect(values).toContain("loop-<name>-dispatch` or `loop-<name>-<KEY>`");
  expect(read("skills/setup-loop/loop.md")).toContain(
    "A step only a person can do gets no ticket",
  );
});
