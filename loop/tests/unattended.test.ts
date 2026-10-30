// The behaviours that let a long Epic run unattended: fix attempts on a red gate, stacked tickets, the usage
// pause, and stack slots.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EPIC, World } from "./world.ts";

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.close();
});

test("a red gate resumes the agent with the failing job's log tail and the review's blocking findings", async () => {
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  world.verdicts({ "DEMO-2": ["fail", "pass"] });
  world.jobLog("check\tRun make check\tFAIL tests/login.test.ts\ncheck\tRun make check\texpected 200, got 500\n");
  world.reviews({
    "DEMO-2": [
      { path: "src/login.ts", line: 12, severity: "blocking", sentence: "The password is logged in plain text." },
      { path: "src/session.ts", line: 3, severity: "blocking", sentence: "The session never expires.", outside: true },
      { path: "src/login.ts", line: 20, severity: "minor", sentence: "The name could be clearer." },
    ],
  });
  world.plan({ "DEMO-2": [{ write: { "login.txt": "login\n" } }, { write: { "login.txt": "fixed\n" }, commit: "fix(DEMO-2): fix the login" }] });

  const ran = await world.loop("start", EPIC);

  expect(ran.code, ran.stderr).toBe(0);
  const [build, fix] = world.calls();
  const session = world.decisions().find((line) => line.ticket === "DEMO-2" && line.step === "agent")!.session;
  expect(fix!.resume).toBe(session);
  expect(fix!.prompt).toContain(world.prs()[0]!.url);
  expect(fix!.prompt).toContain("## gate / check");
  expect(fix!.prompt).toContain("expected 200, got 500");
  expect(fix!.prompt).toContain("`src/login.ts:12` The password is logged in plain text.");
  expect(fix!.prompt).toContain("`src/session.ts:3` The session never expires.");
  expect(fix!.prompt).not.toContain("The name could be clearer.");
  expect(build!.prompt).toMatch(/^\/implement /);
  expect(world.decisions().filter((line) => line.step === "build" && line.result === "started").map((line) => line.attempt)).toEqual([1, 2]);
  expect(world.steps().filter((step) => step.startsWith("DEMO-2 wait"))).toEqual(["DEMO-2 wait red", "DEMO-2 wait green"]);
  expect(world.prs()).toHaveLength(1);
  expect(world.prs()[0]!.state).toBe("MERGED");
  expect(world.git(world.origin, "show", "main:login.txt")).toBe("fixed");
});

test("a ticket still red after the attempt limit is flagged with the reason and the pull request link", async () => {
  world.writeConfig("[limits]\nfix_attempts = 1\n");
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  world.jira.add("DEMO-3", "Add the logout button", { parent: EPIC, blockers: ["DEMO-2"] });
  world.verdicts({ "DEMO-2": "fail" });
  world.plan({ "DEMO-2": [{ write: { "login.txt": "login\n" } }, { write: { "login.txt": "fixed\n" } }] });

  const ran = await world.loop("start", EPIC);

  expect(ran.code).toBe(1);
  const issue = world.jira.issues.get("DEMO-2")!;
  const url = world.prs()[0]!.url;
  expect(issue.flagged).toBe(true);
  expect(issue.comments).toHaveLength(1);
  expect(issue.comments[0]).toContain("The gate stayed red after 1 fix attempts. Failed: gate / check");
  expect(issue.comments[0]).toContain(url);
  expect(world.prs().map((pr) => pr.state)).toEqual(["OPEN"]);
  expect(world.calls().map((call) => call.key)).toEqual(["DEMO-2", "DEMO-2"]);
  expect(world.steps()).toContain("DEMO-2 stuck ok");
  expect(world.jira.notifications).toContain("DEMO-2 stuck");
  expect(world.decisions().find((line) => line.step === "finish")).toMatchObject({ result: "stopped" });
});

test("stuck tickets in a row as long as the circuit breaker start no new ticket", async () => {
  world.writeConfig("[limits]\nfix_attempts = 0\ncircuit_breaker = 1\n");
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  world.jira.add("DEMO-3", "Add the logout button", { parent: EPIC });
  world.verdicts({ "DEMO-2": "fail" });

  const ran = await world.loop("start", EPIC);

  expect(ran.code).toBe(1);
  expect(world.calls().map((call) => call.key)).toEqual(["DEMO-2"]);
  expect(world.steps()).toContain("DEMO-1 circuit-breaker open");
  expect(world.decisions().find((line) => line.step === "finish")!.detail).toContain("circuit-breaker");
});

test.each([
  { github: "retargets", retarget: false },
  { github: "does not retarget", retarget: true },
])("a ticket stacks on its blocker's open pull request, and targets main when the base merges (GitHub $github)", async ({ retarget }) => {
  if (retarget) world.noRetarget();
  world.writeConfig("[limits]\nparallel = 2\n");
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  world.jira.add("DEMO-3", "Add the logout button", { parent: EPIC, blockers: ["DEMO-2"] });
  world.verdicts({ "DEMO-3": "pass" });

  const running = world.loop("start", EPIC);
  await world.until(() => world.steps().includes("DEMO-3 wait green"), "the stacked pull request's green checks");
  const [base, stacked] = world.prs();
  expect(stacked!.baseRefName).toBe(base!.headRefName);
  expect(stacked!.autoMerge).toBeNull();
  expect(existsSync(join(world.calls().find((call) => call.key === "DEMO-3")!.cwd, "DEMO-2.txt"))).toBe(true);
  world.setCheck("DEMO-2", "pass");
  const ran = await running;

  expect(ran.code, ran.stderr).toBe(0);
  expect(world.prs().map((pr) => [pr.state, pr.baseRefName])).toEqual([
    ["MERGED", "main"],
    ["MERGED", "main"],
  ]);
  expect(world.steps().includes("DEMO-3 retarget ok")).toBe(retarget);
  expect(world.decisions().find((line) => line.ticket === "DEMO-3" && line.step === "start")).toMatchObject({ base: base!.headRefName });
  const steps = world.steps();
  expect(steps.indexOf("DEMO-3 start new")).toBeLessThan(steps.indexOf("DEMO-2 merge merged"));
  expect(world.mainLog().slice(0, 2)).toEqual(["feat(DEMO-3): Add the logout button (#101)", "feat(DEMO-2): Add the login page (#100)"]);
});

test("a usage limit pauses the run, and the run resumes the session when the limit resets", async () => {
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  world.verdicts({ "DEMO-2": "pass" });
  // Reset 59 s ago, so the run resumes a second after the limit, a minute past the reset.
  world.plan({ "DEMO-2": [{ limit: { resetsIn: -59 } }, { write: { "login.txt": "login\n" } }] });

  const ran = await world.loop("start", EPIC);

  expect(ran.code, ran.stderr).toBe(0);
  const [limited, resumed] = world.calls();
  const session = world.decisions().find((line) => line.step === "agent" && line.result === "usage-limit")!.session;
  expect(session).toBeTruthy();
  expect(limited!.resume).toBeNull();
  expect(resumed!.resume).toBe(session);
  expect(resumed!.prompt).toBe("The run stopped at a usage limit, which has now reset. Continue the work.");
  const pause = world.decisions().find((line) => line.step === "usage-pause")!;
  expect(pause.result).toBe("ok");
  expect(Date.parse(String(pause.resumes))).toBeLessThanOrEqual(Date.parse(pause.time) + 2_000);
  expect(world.jira.notifications).toContain(`${EPIC} paused`);
  expect(world.steps().filter((step) => step.startsWith("DEMO-2 build"))).toEqual(["DEMO-2 build started", "DEMO-2 build pass"]);
  expect(world.prs()[0]!.state).toBe("MERGED");
});

test("a usage limit that resets past the longest wait stops the run", async () => {
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  world.jira.add("DEMO-3", "Add the logout button", { parent: EPIC });
  world.plan({ "DEMO-2": [{ limit: { resetsIn: 7 * 3600 } }] });

  const ran = await world.loop("start", EPIC);

  expect(ran.code).toBe(1);
  expect(world.calls().map((call) => call.key)).toEqual(["DEMO-2"]);
  expect(world.steps()).toContain("DEMO-2 usage-pause stop");
  expect(world.jira.notifications).toContain(`${EPIC} stopped at a usage limit`);
});

test("two tickets build at the same time, each on its own stack slot", async () => {
  world.writeConfig('[limits]\nparallel = 2\n\n[stack]\nports = { PORT = 3000 }\nport_step = 10\n');
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  world.jira.add("DEMO-3", "Add the logout button", { parent: EPIC });
  world.verdicts({ "DEMO-2": "pass", "DEMO-3": "pass" });
  world.plan({
    "DEMO-2": [{ meet: "DEMO-3", write: { "login.txt": "login\n" } }],
    "DEMO-3": [{ meet: "DEMO-2", write: { "logout.txt": "logout\n" } }],
  });

  const ran = await world.loop("start", EPIC);

  expect(ran.code, ran.stderr).toBe(0);
  const calls = world.calls().sort((a, b) => a.key.localeCompare(b.key));
  expect(calls.map(({ key, port, compose, met }) => ({ key, port, compose, met }))).toEqual([
    { key: "DEMO-2", port: "3020", compose: "demo-demo-2", met: true },
    { key: "DEMO-3", port: "3030", compose: "demo-demo-3", met: true },
  ]);
  expect(world.decisions().filter((line) => line.step === "start" && line.ticket !== EPIC).map((line) => line.slot)).toEqual([2, 3]);
});

test("a slot whose port another Compose project holds moves to a spare slot", async () => {
  world.writeConfig("[stack]\nports = { PORT = 3000 }\nport_step = 10\n");
  world.containers(["other\tother-web-1\t0.0.0.0:3020->3000/tcp", "demo-demo-2\tdemo-demo-2-web-1\t0.0.0.0:3030->3000/tcp"]);
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  world.verdicts({ "DEMO-2": "pass" });

  const ran = await world.loop("start", EPIC);

  expect(ran.code, ran.stderr).toBe(0);
  expect(world.calls().map((call) => call.port)).toEqual(["3030"]);
  const moved = world.decisions().find((line) => line.step === "slot")!;
  expect(moved).toMatchObject({ ticket: "DEMO-2", result: "moved" });
  expect(moved.detail).toBe("Port 3020 is held by the container other-web-1. The stack moved to slot 3.");
});

test("a ticket with no free slot is stuck with the container that holds its port", async () => {
  world.writeConfig("[stack]\nports = { PORT = 3000 }\nport_step = 10\n");
  world.containers(["other\tother-web-1\t0.0.0.0:3000-3200->3000-3200/tcp"]);
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });

  const ran = await world.loop("start", EPIC);

  expect(ran.code).toBe(1);
  expect(world.calls()).toEqual([]);
  const issue = world.jira.issues.get("DEMO-2")!;
  expect(issue.flagged).toBe(true);
  expect(issue.comments[0]).toContain("Port 3020 is held by the container other-web-1. No spare slot has its ports free.");
  expect(issue.comments[0]).not.toContain("The pull request is");
});
