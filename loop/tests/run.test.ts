import { readdirSync } from "node:fs";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EPIC, World } from "./world.ts";

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.close();
});

test("a ticket becomes a worktree, a branch from main, an agent run, a push, and a pull request with auto-merge on", async () => {
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  world.verdicts({ "DEMO-2": "pass" });

  const ran = await world.loop("run", EPIC);

  expect(ran.code, ran.stderr).toBe(0);
  const [pr] = world.prs();
  expect(pr).toMatchObject({
    headRefName: "feat/DEMO-2-add-the-login-page",
    baseRefName: "main",
    title: "feat(DEMO-2): Add the login page",
    autoMerge: { mergeMethod: "SQUASH" },
    state: "MERGED",
  });
  expect(world.mainLog()[0]).toBe("feat(DEMO-2): Add the login page (#100)");
  const [call] = world.calls();
  expect(call!.cwd).toBe(`${world.state}/${EPIC}/worktrees/DEMO-2`);
  expect(call!.prompt).toBe(`/implement ${world.state}/${EPIC}/runs/DEMO-2/ticket.md`);
  expect(call!.bw_session).toBeNull();
});

test("an Epic key, a ticket key, and a filter build the same frontier shape", async () => {
  const frontiers = [];
  for (const args of [[EPIC], ["DEMO-2"], ["--filter", "labels = loop"]]) {
    const one = await World.create();
    try {
      one.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
      one.jira.filters.set("labels = loop", ["DEMO-2"]);
      one.verdicts({ "DEMO-2": "pass" });
      const ran = await one.loop("run", ...args);
      expect(ran.code, ran.stderr).toBe(0);
      const run = args[0] === "--filter" ? readdirSync(one.state).find((name) => name.startsWith("filter-"))! : args[0]!;
      const frontier = one.decisions(run).find((line) => line.step === "frontier");
      frontiers.push(frontier!.tickets);
      expect(one.prs()).toHaveLength(1);
    } finally {
      await one.close();
    }
  }
  expect(frontiers[0]).toEqual([{ key: "DEMO-2", summary: "Add the login page", status: "To Do", state: "ready", blockers: [] }]);
  expect(frontiers[1]).toEqual(frontiers[0]);
  expect(frontiers[2]).toEqual(frontiers[0]);
});

test("the loop waits for the pull request's checks and merges on green", async () => {
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });

  const running = world.loop("run", EPIC);
  await world.until(() => world.prs().length === 1 && world.ghCalls().filter((args) => args[1] === "checks").length >= 3, "the loop to poll the checks");
  expect(world.prs()[0]!.state).toBe("OPEN");
  expect(world.steps()).not.toContain("DEMO-2 merge merged");
  world.setCheck("DEMO-2", "pass");
  const ran = await running;

  expect(ran.code, ran.stderr).toBe(0);
  expect(world.prs()[0]!.state).toBe("MERGED");
  const wait = world.decisions().find((line) => line.step === "wait");
  expect(wait).toMatchObject({ result: "green", pr: world.prs()[0]!.url, checks: [{ name: "gate / check", bucket: "pass" }] });
  expect(world.steps().slice(-3)).toEqual(["DEMO-2 merge merged", "DEMO-1 finish ok", "DEMO-1 notify ok"]);
});

test("a check that reports late keeps the loop waiting until the pull request merges", async () => {
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  world.jira.add("DEMO-3", "Add the logout button", { parent: EPIC, blockers: ["DEMO-2"] });
  world.verdicts({ "DEMO-3": "pass" });

  const running = world.loop("run", EPIC);
  await world.until(() => world.prs().length === 1, "the pull request");
  world.setChecks("DEMO-2", { "gate / check": "pending", "gate / review": "pending" });
  world.setChecks("DEMO-2", { "gate / check": "pass" });
  const polls = world.ghCalls().length;
  await world.until(() => world.ghCalls().length >= polls + 6, "the loop to poll again");
  expect(world.prs()[0]!.state).toBe("OPEN");
  expect(world.steps().filter((step) => /DEMO-2 (wait|merge)/.test(step))).toEqual([]);
  world.setChecks("DEMO-2", { "gate / review": "pass" });
  const ran = await running;

  expect(ran.code, ran.stderr).toBe(0);
  expect(world.decisions().find((line) => line.step === "wait")).toMatchObject({
    result: "green",
    checks: [
      { name: "gate / check", bucket: "pass" },
      { name: "gate / review", bucket: "pass" },
    ],
  });
  expect(world.steps()).toContain("DEMO-2 merge merged");
  expect(world.steps()).toContain("DEMO-3 merge merged");
});

test("the ticket goes to In Progress at start and In Review when the pull request opens", async () => {
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  world.jira.add("DEMO-3", "Already in progress", { parent: EPIC, status: "In Progress" });
  world.verdicts({ "DEMO-2": "pass", "DEMO-3": "pass" });

  const ran = await world.loop("run", EPIC);

  expect(ran.code, ran.stderr).toBe(0);
  expect(world.jira.issues.get("DEMO-2")!.statuses).toEqual(["In Progress", "In Review"]);
  expect(world.jira.issues.get("DEMO-3")!.statuses).toEqual(["In Review"]);
  const steps = world.steps().filter((step) => step.startsWith("DEMO-2"));
  expect(steps.indexOf("DEMO-2 tracker-status ok")).toBeLessThan(steps.indexOf("DEMO-2 build started"));
  expect(steps.lastIndexOf("DEMO-2 tracker-status ok")).toBe(steps.indexOf("DEMO-2 pr open") + 1);
});

test("a ticket whose pull request merged before the run counts as done, and its dependent builds", async () => {
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  world.jira.add("DEMO-3", "Add the logout button", { parent: EPIC, blockers: ["DEMO-2"] });
  // Its branch is gone and was named from the summary the ticket had then.
  world.mergedBefore("DEMO-2", "feat/DEMO-2-add-a-sign-in-page", "feat(DEMO-2): Add a sign-in page");
  // More pull requests since than one page of `gh pr list` holds, one of them for DEMO-20.
  world.mergedBefore("DEMO-20", "feat/DEMO-20-work");
  for (let number = 0; number < 250; number++) world.mergedBefore(`OTHER-${number}`, `feat/OTHER-${number}-work`);
  world.verdicts({ "DEMO-3": "pass" });

  const ran = await world.loop("run", EPIC);

  expect(ran.code, ran.stderr).toBe(0);
  expect(world.calls().map((call) => call.key)).toEqual(["DEMO-3"]);
  expect(world.decisions().find((line) => line.ticket === "DEMO-2" && line.step === "start")).toMatchObject({
    result: "merged-before",
    pr: world.prs()[0]!.url,
  });
  expect(world.jira.issues.get("DEMO-2")!.statuses).toEqual([]);
});

test("a restart does not rebuild a ticket the first run merged", async () => {
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  world.verdicts({ "DEMO-2": "pass" });
  expect((await world.loop("run", EPIC)).code).toBe(0);

  const ran = await world.loop("run", EPIC);

  expect(ran.code, ran.stderr).toBe(0);
  expect(world.calls()).toHaveLength(1);
  expect(world.prs()).toHaveLength(1);
  expect(world.steps()).toContain("DEMO-2 start merged-before");
});

test("a ticket blocked by another builds after the blocker merges, from a main that holds its work", async () => {
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  world.jira.add("DEMO-3", "Add the logout button", { parent: EPIC, blockers: ["DEMO-2"] });
  world.verdicts({ "DEMO-2": "pass", "DEMO-3": "pass" });

  const ran = await world.loop("run", EPIC);

  expect(ran.code, ran.stderr).toBe(0);
  const steps = world.steps();
  expect(steps.indexOf("DEMO-2 merge merged")).toBeLessThan(steps.indexOf("DEMO-3 start new"));
  const worktree = `${world.state}/${EPIC}/worktrees/DEMO-3`;
  expect(world.git(worktree, "log", "--format=%s", "-3").split("\n")).toEqual([
    "feat(DEMO-3): change",
    "feat(DEMO-2): Add the login page (#100)",
    "chore: start",
  ]);
  expect(world.mainLog().slice(0, 2)).toEqual(["feat(DEMO-3): Add the logout button (#101)", "feat(DEMO-2): Add the login page (#100)"]);
});

test("the decisions log has one line per step, and no gate, review, land, or Epic branch lines", async () => {
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  world.verdicts({ "DEMO-2": "pass" });

  const ran = await world.loop("run", EPIC);

  expect(ran.code, ran.stderr).toBe(0);
  expect(world.steps()).toEqual([
    "DEMO-1 start ok",
    "DEMO-1 frontier ok",
    "DEMO-2 start new",
    "DEMO-2 tracker-status ok",
    "DEMO-2 build started",
    "DEMO-2 agent done",
    "DEMO-2 build pass",
    "DEMO-2 push ok",
    "DEMO-2 pr open",
    "DEMO-2 tracker-status ok",
    "DEMO-2 wait green",
    "DEMO-2 merge merged",
    "DEMO-1 finish ok",
    "DEMO-1 notify ok",
  ]);
  for (const line of world.decisions()) {
    expect(Object.keys(line).slice(0, 8)).toEqual(["time", "epic", "ticket", "step", "result", "commit", "session", "detail"]);
  }
  expect(world.decisions().find((line) => line.step === "pr")!.pr).toBe(world.prs()[0]!.url);
  expect(world.decisions().find((line) => line.step === "pr" && "checks" in line)).toBeUndefined();
  expect(world.decisions().find((line) => line.step === "start")!.detail).toBe("main");
  expect(world.git(world.origin, "branch", "--list", "feat/DEMO-1-*")).toBe("");
});

test("a blocked agent opens no pull request", async () => {
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  world.plan({ "DEMO-2": [{ status: "blocked", reason: "The spec leaves the login provider open." }] });

  const ran = await world.loop("run", EPIC);

  expect(ran.code).toBe(1);
  expect(world.prs()).toEqual([]);
  expect(world.decisions().find((line) => line.step === "build" && line.result === "blocked")!.detail).toBe(
    "The spec leaves the login provider open.",
  );
});

test("an old loop.toml loads with one warning per dropped key", async () => {
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  world.verdicts({ "DEMO-2": "pass" });
  world.writeConfig(`
[gates]
ticket = ["make", "test"]
merge = ["make", "check"]

[acceptance]
list = ["make", "acceptance"]

[ui]
path = "frontend/src/"
skill = "ui-review"
blocking = ["layout"]

[demo]
command = ["make", "demo"]
url = "http://localhost:3000"

[review]
enabled = true
`);

  const ran = await world.loop("run", EPIC);

  expect(ran.code, ran.stderr).toBe(0);
  const warnings = ran.stderr.split("\n").filter((line) => line.includes("is no longer read"));
  expect(warnings).toHaveLength(4);
  for (const key of ["[gates]", "[acceptance]", "[ui].skill", "[demo]"]) {
    expect(warnings.filter((line) => line.startsWith(`loop.toml: ${key} `))).toHaveLength(1);
  }
});

test("an unknown loop.toml key refuses the run", async () => {
  world.writeConfig(`
[limits]
paralel = 2
`);

  const ran = await world.loop("run", EPIC);

  expect(ran.code).toBe(2);
  expect(ran.stderr).toContain("unknown key limits.paralel");
});

test("the loop needs a key or a filter", async () => {
  const ran = await world.loop("run");

  expect(ran.code).toBe(2);
  expect(ran.stderr).toContain("Usage");
});

