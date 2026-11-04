// The prompt and the skills of intake, which no test can run: each holds the rules the spec gives.
import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the Chief's prompt holds each rule of the spec", () => {
  const chief = read("bots/chief.md");
  for (const rule of [
    "Tickets, not code",
    "Never merge",
    "The owner's asks come in the DM",
    "the runner's messages come in the repo's channel",
    "Find a duplicate in Jira first",
    "Never post a root message",
    "What waits on the owner",
    "Retried by the Chief: <fingerprint>",
    "a timeout, a setup failure, a usage limit, a runner or Docker failure in the gate's log, or a `FLAKY` line",
    "suggested answer",
    "touch nothing",
    "sticks twice in seven days",
    "with the fingerprint in its title",
    "no Technical checks and no proposed fix",
    "at most ten tickets a day",
    "Never split one report",
    "no `to-tickets`",
    "file count and line count",
    "`#pitchridge`",
    "`#agent-workflow`",
    "by an edit right after the create",
    "starts with `Chief:`",
    "pull request, merge, deploy, and runner status messages",
    "7 AM to 11 PM ET",
    "the label `agents` and without the label `triaged`",
    "one root message",
    "a step only the owner can do",
    "the label `wont-do`",
    "Slack, Gmail, Jira, and GitHub",
  ]) {
    expect(chief).toContain(rule);
  }
});

test("to-bug writes a Flagged Bug with no parent, its trace as text, and the intake comment", () => {
  const skill = read("skills/to-bug/SKILL.md");
  for (const rule of ["with no parent", "**Reproduce.**", "pasted in as text", "states the correct behaviour", "Set the component", "Flagged", "Move it from Awaiting Approval to To Do", "`Proposed by intake`"]) {
    expect(skill).toContain(rule);
  }
});

test("implement has its Bug paragraph, and the issue tracker doc its two lines", () => {
  expect(read("skills/implement/SKILL.md")).toContain("For a Bug, reproduce it first");
  const tracker = read("docs/agents/issue-tracker.md");
  expect(tracker).toContain("a Bug with no parent");
  expect(tracker).toContain("Flagged means the ticket waits on the owner");
});

test("correct is carried from pstack at the pinned commit, and retro is gone with each pointer", () => {
  expect(read("skills/correct/SKILL.md")).toContain("`pstack/skills/correct` of `cursor/plugins` at `ae5650febf4320793844c12c4adaa937f417f8da`");
  expect(existsSync(new URL("../skills/retro", import.meta.url))).toBe(false);
  for (const path of ["docs/agents/workflow.md", "docs/project-skills.md", "skills/setup-repo/workflow.md"]) expect(read(path)).not.toMatch(/\bretro\b/);
});
