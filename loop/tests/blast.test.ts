// The blast level of a worker's pull request: a red one opens as a draft and waits for the owner, a yellow one
// holds after its first green, and a green one merges at its first green.
import { afterEach, beforeEach, expect, test } from "vitest";
import { World } from "./world.ts";

const KEY = "DEMO-2";
const RUN = `tickets/${KEY}`;

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.close();
});

/** The worker run by hand, as its unit runs it, in slot 2. */
function work() {
  return world.loop("run-ticket", KEY, "--slot", "2");
}

function labels(): string[] {
  return (world.prs()[0]!.labels ?? []).map((label) => label.name);
}

function worker(): string[] {
  return world.steps(RUN);
}

test("a changed file under a red glob opens a draft labelled blast:red, the dispatcher frees its slot, and marking it ready merges it", async () => {
  world.writeConfig('[blast]\nred = ["auth/**"]\n');
  world.jira.add(KEY, "Add the login page");
  world.verdicts({ [KEY]: "pass" });
  world.plan({ [KEY]: [{ write: { "auth/login.ts": "login\n" }, commit: "feat(DEMO-2): login" }] });

  const started = await world.loop("start");
  expect(started.code, started.stderr).toBe(0);
  await world.until(() => worker().includes(`${KEY} finish handed-back`), "the hand-back");

  expect(world.prs()[0]).toMatchObject({ isDraft: true, state: "OPEN", autoMerge: null });
  expect(labels()).toEqual(["blast:red"]);
  expect(world.decisions(RUN).find((line) => line.step === "blast")).toMatchObject({ result: "red", detail: expect.stringContaining("auth/login.ts") });
  expect(world.decisions(RUN).find((line) => line.step === "hand-back")).toMatchObject({ result: "red" });
  const issue = world.jira.issues.get(KEY)!;
  expect(issue.flagged).toBe(false);
  await world.until(() => world.decisions("").some((line) => line.step === "queue" && String(line.detail).includes(`${KEY} a draft`)), "the draft in the queue");
  expect(world.unitAlive(`loop-demo-${KEY}.service`)).toBe(false);

  world.draft(KEY, false);

  await world.until(() => worker().includes(`${KEY} merge merged`), "the merge");
  const restart = worker().lastIndexOf(`${KEY} start restart`);
  expect(worker().slice(restart)).toEqual(expect.arrayContaining([`${KEY} build skipped`, `${KEY} wait green`, `${KEY} merge merged`]));
  expect(world.calls()).toHaveLength(1);
});

test("a level that rises to red on a fix attempt converts the pull request to a draft and hands the ticket back", async () => {
  world.jira.add(KEY, "Add the login page");
  world.verdicts({ [KEY]: ["fail", "pass"] });
  world.plan({ [KEY]: [{ write: { "a.txt": "a\n" }, commit: "feat(DEMO-2): a" }, { write: { "a.txt": "b\n" }, commit: "fix(DEMO-2): b", blast: "red" }] });

  const ran = await work();

  // A worker that hands its ticket back exits 1, as for a usage limit.
  expect(ran.code, ran.stderr).toBe(1);
  expect(world.prs()[0]).toMatchObject({ isDraft: true, state: "OPEN" });
  expect(labels()).toEqual(["blast:red"]);
  expect(worker()).toEqual(expect.arrayContaining([`${KEY} blast green`, `${KEY} blast red`, `${KEY} draft ok`, `${KEY} hand-back red`]));
});

test("an agent blast of yellow on a green floor labels yellow, holds, and merges after the hold unless the hold label is on", async () => {
  world.writeConfig('[blast]\nred = ["auth/**"]\nhold_minutes = 0\n');
  world.jira.add(KEY, "Add the login page");
  world.verdicts({ [KEY]: "pass" });
  world.plan({ [KEY]: [{ write: { "a.txt": "a\n" }, commit: "feat(DEMO-2): a", blast: "yellow" }] });

  const first = await work();

  expect(first.code, first.stderr).toBe(1);
  expect(labels()).toEqual(["blast:yellow"]);
  expect(world.prs()[0]).toMatchObject({ state: "OPEN", autoMerge: null, isDraft: false });
  expect(world.prs()[0]!.body).toMatch(/^## Loop\n\nHold until \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n\n## Ticket$/m);
  expect(worker()).toEqual(expect.arrayContaining([`${KEY} wait green`, `${KEY} hold set`, `${KEY} hand-back hold`]));
  const body = world.prs()[0]!.body;

  // After the hold, the hold label stops it.
  world.label(KEY, "hold", true);
  const held = await work();
  expect(held.code, held.stderr).toBe(1);
  expect(world.prs()[0]).toMatchObject({ state: "OPEN", autoMerge: null });
  expect(world.decisions(RUN).filter((line) => line.step === "hand-back").at(-1)).toMatchObject({ result: "hold", detail: "The `hold` label is on the pull request." });
  expect(world.prs()[0]!.body).toBe(body);

  // Without the label, the time has passed, so it merges at once.
  world.label(KEY, "hold", false);
  const merged = await work();
  expect(merged.code, merged.stderr).toBe(0);
  expect(world.prs()[0]).toMatchObject({ state: "MERGED", autoMerge: { mergeMethod: "SQUASH" } });
  expect(worker().slice(worker().lastIndexOf(`${KEY} start restart`))).toEqual(expect.arrayContaining([`${KEY} hold over`, `${KEY} merge merged`]));
  expect(world.calls()).toHaveLength(1);
});

test("a yellow pull request hands back while its hold runs, and the dispatcher does not start it again until then", async () => {
  world.writeConfig('[blast]\nyellow = ["*.txt"]\n');
  world.jira.add(KEY, "Add the login page");
  world.verdicts({ [KEY]: "pass" });

  const started = await world.loop("start");
  expect(started.code, started.stderr).toBe(0);
  await world.until(() => worker().includes(`${KEY} hand-back hold`), "the hand-back");
  await world.until(() => world.decisions("").some((line) => line.step === "queue" && String(line.detail).includes(`${KEY} held until`)), "the hold in the queue");

  expect(labels()).toEqual(["blast:yellow"]);
  expect(world.prs()[0]!.state).toBe("OPEN");
  expect(world.decisions("").filter((line) => line.step === "worker" && line.result === "started")).toHaveLength(1);
});

test("a green pull request turns auto-merge on at the first green", async () => {
  world.jira.add(KEY, "Add the login page");
  world.verdicts({ [KEY]: "pass" });

  const ran = await work();

  expect(ran.code, ran.stderr).toBe(0);
  expect(labels()).toEqual(["blast:green"]);
  expect(world.prs()[0]).toMatchObject({ isDraft: false, state: "MERGED", autoMerge: { mergeMethod: "SQUASH" } });
  const steps = worker();
  expect(steps.some((step) => / hold | hand-back /.test(` ${step} `))).toBe(false);
});
