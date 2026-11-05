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
});

test("the workflow doc and the runner docs say what the runner does", () => {
  expect(read("docs/agents/workflow.md")).toContain("machines is on the gate and the runner");
  expect(read("docs/agents/workflow.md")).not.toContain("such as machines");
  for (const path of ["docs/agents/runner.md", "runner/CLAUDE.md"]) {
    expect(read(path)).toContain("Slack");
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

test("the Chief's prompt holds the fuzz findings of the morning brief", () => {
  const chief = read("bots/chief.md");
  for (const rule of [
    "at 6 AM ET, once a day",
    "one Slack DM that starts with \"Chief:\"",
    "A `gate / fuzz` review is Status too",
    "in its own chat, not this run",
    "newest fuzz review",
    "`<!-- gate fuzz head=`",
    "`### New findings`",
    "whatever its other checks say",
    "`fuzz could not run on <pull request link>: <reason>`",
    "`fuzz: UNKNOWN, <reason>`",
    "does the brief say nothing of fuzz",
    "Never create a ticket from a finding in this routine",
    "with the label `fuzz`",
    "never raised again",
    "| An approved fuzz finding     | PITCH   | `pitchridge`     |",
  ]) {
    expect(chief).toContain(rule);
  }
});

test("the fuzz review carries what the Chief reads", () => {
  const fuzz = read("actions/fuzz/fuzz.py");
  for (const text of ["<!-- gate fuzz head=", "### New findings", "adversaries finished", "nothing changed outside the skip paths"]) expect(fuzz).toContain(text);
});

test("to-bug takes a fuzz finding only on the owner's yes, with its label", () => {
  const skill = read("skills/to-bug/SKILL.md");
  for (const rule of ["a fuzz finding the owner approved", "A fuzz finding with no yes from the owner is no report", "the label `fuzz`"]) expect(skill).toContain(rule);
});

test("the workflow docs do not say every repo needs a green fuzz job", () => {
  for (const path of ["docs/agents/workflow.md", "skills/setup-repo/workflow.md"]) {
    expect(read(path)).not.toContain("`gate / check` and `gate / fuzz`. All green");
    expect(read(path)).toContain("a fuzz job that is off passes without running");
  }
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

test("ADR-0009 holds the amendment", () => {
  const adr = read("docs/adr/0009-the-queue-is-opt-in-through-a-status.md");
  for (const rule of ["A Bug that `/to-bug` writes starts unflagged", "turns auto-merge off", "`Runner hold: Awaiting Approval`", "A Bug that `/to-bug` wrote was Flagged"]) expect(adr).toContain(rule);
});

test("implement has its Bug paragraph, and the issue tracker doc its two lines", () => {
  expect(read("skills/implement/SKILL.md")).toContain("For a Bug, reproduce it first");
  const tracker = read("docs/agents/issue-tracker.md");
  expect(tracker).toContain("a Bug with no parent");
  expect(tracker).toContain("Flagged means the ticket waits on the owner");
});

test("correct is carried from pstack at the pinned commit, and retro is gone", () => {
  expect(read("skills/correct/SKILL.md")).toContain("`pstack/skills/correct` of `cursor/plugins` at `ae5650febf4320793844c12c4adaa937f417f8da`");
  expect(existsSync(new URL("../skills/retro", import.meta.url))).toBe(false);
});
