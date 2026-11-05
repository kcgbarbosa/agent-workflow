// The prompt and the skills of intake, which no test can run: each holds the rules the spec gives.
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
    "a step only the owner can do",
    "the label `wont-do`",
    "Slack, Jira, and GitHub",
  ]) {
    expect(chief).toContain(rule);
  }
});

test("the Chief's prompt reads the runner's post as a stuck notification and a stuck comment as the runner writes it", () => {
  const chief = read("bots/chief.md");
  for (const rule of ["`<KEY> stuck: <reason>`", "`Stuck: <stage>: <reason>.`", "the thread waits on a question", "| `machines`"]) expect(chief).toContain(rule);
  expect(chief).not.toMatch(/\bdecisions\b/);
  expect(chief).not.toMatch(/\bloop\b/);
});

test("the workflow doc and the runner docs say what the runner does", () => {
  expect(read("docs/agents/workflow.md")).toContain("machines is on the gate and the runner");
  expect(read("docs/agents/workflow.md")).not.toContain("such as machines");
  for (const path of ["docs/agents/runner.md", "runner/CLAUDE.md"]) {
    expect(read(path)).toContain("Slack");
    expect(read(path)).not.toMatch(/ntfy/i);
  }
});

test("the Chief's prompt tells the owner of each Bug and takes a stop in the DM", () => {
  const chief = read("bots/chief.md");
  for (const rule of [
    "DM the owner the key and the summary right after the create",
    "`stop <KEY>` in the DM",
    "move the ticket to Awaiting Approval",
    "reply with what the build had reached",
    "The Bug for a repeated fingerprint is created Flagged",
  ]) {
    expect(chief).toContain(rule);
  }
});

test("the Chief's prompt takes a Sentry alert as a root message of the channel, with no hourly check and no Gmail", () => {
  const chief = read("bots/chief.md");
  expect(chief).toContain("A Sentry alert is a root message in the repo's channel, and channel triage takes it");
  expect(chief).not.toMatch(/hourly/i);
  expect(chief).not.toMatch(/gmail/i);
  expect(chief).not.toContain("exception");
});

test("to-bug writes a To Do Bug that is not Flagged, with no parent, its trace as text, and the intake comment", () => {
  const skill = read("skills/to-bug/SKILL.md");
  for (const rule of ["with no parent", "**Reproduce.**", "pasted in as text", "states the correct behaviour", "`Proposed by intake`", "not Flagged"]) {
    expect(skill).toContain(rule);
  }
  expect(skill).not.toContain("Flagged until the owner unflags it");
  expect(skill).not.toContain("Set the ticket Flagged");
  const steps = ["Set the component", "Move it from Awaiting Approval to To Do", "Comment `Proposed by intake`"].map((step) => skill.indexOf(step));
  expect(steps.every((at) => at >= 0)).toBe(true);
  expect(steps).toEqual([...steps].sort((a, b) => a - b));
});

test("ADR-0009 holds the amendment, and no ADR or runner comment says proposed Bug", () => {
  const adr = read("docs/adr/0009-the-queue-is-opt-in-through-a-status.md");
  for (const rule of ["A Bug that `/to-bug` writes starts unflagged", "turns auto-merge off", "`Runner hold: Awaiting Approval`", "A Bug that `/to-bug` wrote was Flagged"]) expect(adr).toContain(rule);
  for (const folder of ["docs/adr", "runner/src", "runner/tests"]) {
    const files = readdirSync(new URL(`../${folder}`, import.meta.url), { withFileTypes: true }).filter((entry) => entry.isFile());
    for (const file of files) expect(read(`${folder}/${file.name}`), file.name).not.toMatch(/proposed bug/i);
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
