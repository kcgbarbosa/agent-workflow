// The dispatcher, `loop dispatch` in the unit `loop-demo-dispatch`, which `loop start` starts: the tracker is the
// queue, and it starts a worker for each ready ticket while a slot is free.
import { afterEach, beforeEach, expect, test } from "vitest";
import { EPIC, World } from "./world.ts";

const DISPATCH = "loop-demo-dispatch.service";

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.close();
});

function unitOf(key: string): string {
  return `loop-demo-${key}.service`;
}

function unitArgs(unit: string): string[][] {
  return world.systemd().filter((call) => call.tool === "systemd-run" && call.args.includes(`--unit=${unit}`)).map((call) => call.args);
}

/** The dispatcher's own lines, `<ticket> <step> <result>`, from its log at the top of the state folder. */
function dispatched(): string[] {
  return world.steps("");
}

function started(): string[] {
  return dispatched().filter((step) => step.endsWith(" worker started")).map((step) => step.split(" ")[0]!);
}

/** Waits for this many more polls of the dispatcher. Each poll reads the queue once. */
async function polls(count: number): Promise<void> {
  const searches = () => world.jira.requests.filter((request) => request === "POST /rest/api/3/search/jql").length;
  const until = searches() + count * 2;
  await world.until(() => searches() >= until, `${count} polls`);
}

async function start(): Promise<void> {
  const ran = await world.loop("start");
  expect(ran.code, ran.stderr).toBe(0);
}

test("loop start with no key starts the dispatcher, and a ticket that becomes ready on the next poll starts a worker", async () => {
  world.verdicts({ "DEMO-2": "pass" });
  await start();
  await world.until(() => dispatched().some((step) => step.startsWith("dispatch queue ")), "the first poll");
  expect(unitArgs(DISPATCH)).toHaveLength(1);
  expect(started()).toEqual([]);

  world.jira.add("DEMO-2", "Add the login page");

  await world.until(() => world.prs().some((pr) => pr.state === "MERGED"), "the merge");
  const [args] = unitArgs(unitOf("DEMO-2"));
  expect(args!.at(-1)).toMatch(/^exec '[^']*\/bin\/loop' 'run-ticket' 'DEMO-2' '--slot' '2' '--repo' '[^']*\/demo'$/);
  await world.until(() => dispatched().includes("DEMO-2 worker merged"), "the worker's end");
  expect(world.jira.issues.get("DEMO-2")!.status).toBe("Done");
});

test("two ready tickets start in priority then key order, and a third waits for a slot with parallel = 2", async () => {
  world.writeConfig("[limits]\nparallel = 2\n");
  world.jira.add("DEMO-2", "Add the login page");
  world.jira.add("DEMO-3", "Add the logout page", { priority: "High" });
  world.jira.add("DEMO-4", "Add the signup page");
  world.verdicts({ "DEMO-4": "pass" });

  await start();
  await world.until(() => world.prs().length === 2, "two pull requests");
  await polls(3);

  expect(started()).toEqual(["DEMO-3", "DEMO-2"]);
  expect(world.unitAlive(unitOf("DEMO-4"))).toBe(false);
  world.setCheck("DEMO-3", "pass");
  await world.until(() => started().includes("DEMO-4"), "DEMO-4 to start");
  const steps = dispatched();
  expect(steps.indexOf("DEMO-3 worker merged")).toBeLessThan(steps.indexOf("DEMO-4 worker started"));
  expect(world.decisions("").find((line) => line.ticket === "DEMO-4" && line.step === "worker")).toMatchObject({ slot: 2 });
});

test("a Flagged ticket, one of another component, one with no component, and one whose blocker has an open pull request never start", async () => {
  // A filter wider than the default one, so the dispatcher's own rules decide.
  world.writeConfig('[limits]\nparallel = 2\n\n[queue]\nfilter = "project = DEMO ORDER BY key ASC"\n');
  world.jira.add("DEMO-2", "Add the login page", { flagged: true });
  world.jira.add("DEMO-3", "Add the billing page", { components: ["other"] });
  world.jira.add("DEMO-4", "Write the release notes", { components: [] });
  world.jira.add("DEMO-5", "Add the logout page", { blockers: ["DEMO-6"] });
  world.jira.add("DEMO-6", "Add the session store");
  world.jira.filters.set("project = DEMO ORDER BY key ASC", ["DEMO-2", "DEMO-3", "DEMO-4", "DEMO-5", "DEMO-6"]);

  await start();
  await world.until(() => world.prs().length === 1, "DEMO-6's pull request");
  await polls(3);

  expect(started()).toEqual(["DEMO-6"]);
  expect(world.decisions("").findLast((line) => line.step === "queue")!.detail).toContain("DEMO-5 waiting on DEMO-6");
  for (const key of ["DEMO-2", "DEMO-3", "DEMO-4", "DEMO-5"]) {
    const issue = world.jira.issues.get(key)!;
    expect(issue.comments, key).toEqual([]);
    expect(issue.statuses, key).toEqual([]);
    expect(issue.flagged, key).toBe(key === "DEMO-2");
  }
  world.setCheck("DEMO-6", "pass");
  await world.until(() => started().includes("DEMO-5"), "DEMO-5 to start once its blocker merged");
});

test("loop stop <KEY> ends one worker and flags its ticket, and loop stop ends the dispatcher and every worker and flags nothing", async () => {
  world.writeConfig("[limits]\nparallel = 2\n");
  world.jira.add("DEMO-2", "Add the login page");
  world.jira.add("DEMO-3", "Add the logout page");
  await start();
  await world.until(() => world.prs().length === 2, "two pull requests");

  const one = await world.loop("stop", "DEMO-2");

  expect(one.code, one.stderr).toBe(0);
  expect(world.unitAlive(unitOf("DEMO-2"))).toBe(false);
  const issue = world.jira.issues.get("DEMO-2")!;
  expect(issue.flagged).toBe(true);
  expect(issue.comments).toEqual(["Stopped by the owner"]);
  await polls(3);
  expect(started()).toEqual(["DEMO-2", "DEMO-3"]);
  expect(world.unitAlive(DISPATCH)).toBe(true);
  expect(world.unitAlive(unitOf("DEMO-3"))).toBe(true);

  const all = await world.loop("stop");

  expect(all.code, all.stderr).toBe(0);
  expect(all.stdout).toContain("Nothing is flagged");
  expect(world.unitAlive(DISPATCH)).toBe(false);
  expect(world.unitAlive(unitOf("DEMO-3"))).toBe(false);
  expect(world.jira.issues.get("DEMO-3")!.flagged).toBe(false);
  expect(world.jira.issues.get("DEMO-3")!.comments).toEqual([]);
  expect(dispatched()).toContain("dispatch stop stopped");
});

test("two stuck workers in a row open the circuit breaker, and an unflag of one of them closes it and the ticket starts", async () => {
  world.jira.add("DEMO-2", "Add the login page");
  world.jira.add("DEMO-3", "Add the logout page");
  world.jira.add("DEMO-4", "Add the signup page");
  world.plan({
    "DEMO-2": [{ status: "blocked", reason: "It needs KC." }],
    "DEMO-3": [{ status: "blocked", reason: "It needs KC." }, { write: { "b.txt": "b\n" }, commit: "feat(DEMO-3): b" }],
  });
  world.verdicts({ "DEMO-3": "pass", "DEMO-4": "pass" });

  await start();
  await world.until(() => dispatched().includes("dispatch circuit-breaker open"), "the circuit breaker");
  await polls(3);

  expect(started()).toEqual(["DEMO-2", "DEMO-3"]);
  expect(world.jira.notifications).toContain("demo circuit breaker open");
  world.jira.issues.get("DEMO-3")!.flagged = false;

  await world.until(() => dispatched().includes("DEMO-3 worker merged"), "DEMO-3 to merge");
  const steps = dispatched();
  expect(steps.indexOf("dispatch circuit-breaker closed")).toBeLessThan(steps.lastIndexOf("DEMO-3 worker started"));
  expect(started()).toEqual(["DEMO-2", "DEMO-3", "DEMO-3"]);
  await world.until(() => started().includes("DEMO-4"), "DEMO-4 to start");
});

test("a worker's usage pause holds the next start until a minute after the reset", async () => {
  world.writeConfig("[limits]\nparallel = 2\n");
  world.jira.add("DEMO-2", "Add the login page");
  world.plan({ "DEMO-2": [{ limit: { resetsIn: 600 } }] });
  await start();
  await world.until(() => dispatched().includes("dispatch hold usage-pause"), "the hold");

  world.jira.add("DEMO-3", "Add the logout page");
  await polls(3);

  expect(started()).toEqual(["DEMO-2"]);
  const pause = world.decisions("tickets/DEMO-2").find((line) => line.step === "usage-pause" && line.result === "ok")!;
  const hold = world.decisions("").find((line) => line.step === "hold")!;
  expect(Date.parse(hold.until as string)).toBe(Date.parse(pause.resumes as string));
  expect(world.decisions("").findLast((line) => line.step === "queue")).toMatchObject({ result: "held" });
});

test("a limit with no reset time hands the ticket back with no flag, and the dispatcher holds for the maximum wait", async () => {
  world.jira.add("DEMO-2", "Add the login page");
  world.jira.add("DEMO-3", "Add the logout page");
  world.plan({ "DEMO-2": [{ limit: {} }] });
  await start();

  await world.until(() => dispatched().includes("dispatch hold usage-limit"), "the hold");
  await polls(3);

  expect(dispatched()).toContain("DEMO-2 worker usage-limit");
  expect(world.jira.issues.get("DEMO-2")!.flagged).toBe(false);
  expect(started()).toEqual(["DEMO-2"]);
  const hold = world.decisions("").find((line) => line.step === "hold")!;
  const hours = (Date.parse(hold.until as string) - Date.now()) / 3_600_000;
  expect(hours).toBeGreaterThan(5.9);
  expect(hours).toBeLessThanOrEqual(6);
  expect(world.jira.notifications.filter((message) => message === "demo holds at a usage limit")).toHaveLength(1);
});

test("the Epic is set Done after its last merge", async () => {
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  world.jira.add("DEMO-3", "Sign the contract", { parent: EPIC, components: ["other"], status: "Done" });
  world.verdicts({ "DEMO-2": "pass" });

  await start();

  // The check moves the Epic to Done, then logs, then notifies.
  await world.until(() => world.jira.notifications.includes(`${EPIC} complete`), "the Epic's notification");
  expect(world.jira.issues.get(EPIC)!.status).toBe("Done");
  expect(dispatched()).toContain(`${EPIC} complete ok`);
});

test("the Epic is set Done after a child of another component is set Done", async () => {
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  world.jira.add("DEMO-3", "Sign the contract", { parent: EPIC, components: ["other"] });
  world.verdicts({ "DEMO-2": "pass" });
  await start();
  await world.until(() => dispatched().includes("DEMO-2 worker merged"), "the merge");
  await polls(3);
  expect(world.jira.issues.get(EPIC)!.status).toBe("To Do");

  world.jira.issues.get("DEMO-3")!.status = "Done";

  await world.until(() => world.jira.issues.get(EPIC)!.status === "Done", "the Epic to be Done");
  expect(world.jira.issues.get("DEMO-3")!.statuses).toEqual([]);
});
