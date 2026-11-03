import { afterEach, beforeEach, expect, test } from "vitest";
import { EPIC, World } from "./world.ts";

const SPEC = "docs/specs/the-loop.md";
const LINK = `https://github.com/kcgbarbosa/demo/blob/main/${SPEC}`;

let world: World;

beforeEach(async () => {
  world = await World.create();
  world.jira.issues.get(EPIC)!.body = [`The spec is ${LINK}.`, "A link to another repo stays: https://github.com/kcgbarbosa/other/blob/main/docs/x.md"];
  world.commitTo(world.repo, { [SPEC]: "# The Loop\n" }, "docs: the spec");
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  world.jira.add("DEMO-3", "Add the logout page", { parent: EPIC });
  // The archive pull request's check passes too.
  world.verdicts({ "DEMO-2": "pass", "DEMO-3": "pass", [EPIC]: "pass" });
});

afterEach(async () => {
  await world.close();
});

/** The dispatcher's own lines, `<ticket> <step> <result>`: only the dispatcher completes an Epic. */
function dispatched(): string[] {
  return world.steps("");
}

/** Waits for this many more polls of the dispatcher. Each poll reads the queue once. */
async function polls(count: number): Promise<void> {
  const searches = () => world.jira.requests.filter((request) => request === "POST /rest/api/3/search/jql").length;
  const until = searches() + count * 2;
  await world.until(() => searches() >= until, `${count} polls`);
}

/** Starts the dispatcher with `loop start` and waits for the Epic check to log its `complete` line. */
async function complete(): Promise<void> {
  const ran = await world.loop("start");
  expect(ran.code, ran.stderr).toBe(0);
  await world.until(() => dispatched().includes(`${EPIC} complete ok`), "the Epic check");
}

test("the last merge of an Epic archives the spec and marks the Epic done", async () => {
  await complete();

  const lastMerge = world.git(world.origin, "rev-parse", "main~1");
  const archived = world.prs().find((pr) => pr.headRefName === `docs/${EPIC}-archive-spec`);
  expect(archived).toMatchObject({ title: "docs: archive the spec of the Loop", baseRefName: "main", autoMerge: { mergeMethod: "SQUASH" }, state: "MERGED" });
  expect(archived!.body).toContain(`https://github.com/kcgbarbosa/demo/blob/${lastMerge}/${SPEC}`);
  expect(world.mainLog()[0]).toBe(`docs: archive the spec of the Loop (#${archived!.number})`);
  expect(world.git(world.origin, "ls-tree", "-r", "--name-only", "main")).not.toContain(SPEC);
  expect(world.jira.issues.get(EPIC)!.body).toEqual([
    `The spec is https://github.com/kcgbarbosa/demo/blob/${lastMerge}/${SPEC}.`,
    "A link to another repo stays: https://github.com/kcgbarbosa/other/blob/main/docs/x.md",
  ]);
  expect(world.jira.issues.get(EPIC)!.status).toBe("Done");
  const steps = dispatched();
  expect(steps.indexOf("DEMO-3 worker merged")).toBeLessThan(steps.indexOf(`${EPIC} archive pr-open`));
  expect(steps.indexOf(`${EPIC} archive pr-open`)).toBeLessThan(steps.indexOf(`${EPIC} complete ok`));
  expect(world.decisions("").find((line) => line.step === "archive")).toMatchObject({ pr: archived!.url });
  expect(world.jira.notifications).toContain(`${EPIC} complete`);
});

test("an Epic with a ticket still open is not archived", async () => {
  world.plan({ "DEMO-3": [{ status: "blocked", reason: "It needs KC." }] });

  const ran = await world.loop("start");
  expect(ran.code, ran.stderr).toBe(0);
  await world.until(() => dispatched().includes("DEMO-3 worker stuck"), "DEMO-3 to be stuck");
  await world.until(() => dispatched().includes("DEMO-2 worker merged"), "DEMO-2 to merge");
  // Past the hourly Epic check, which the tests run every half second.
  await polls(10);

  expect(dispatched().filter((step) => / (archive|complete) /.test(step))).toEqual([]);
  expect(world.prs().map((pr) => pr.headRefName)).not.toContain(`docs/${EPIC}-archive-spec`);
  expect(world.jira.issues.get(EPIC)!.status).toBe("To Do");
});

test("a dispatcher started again after the archive repeats no side effect", async () => {
  await complete();
  const prs = world.prs().length;
  expect((await world.loop("stop")).code).toBe(0);

  const again = await world.loop("start");
  expect(again.code, again.stderr).toBe(0);
  await polls(10);

  expect(world.prs()).toHaveLength(prs);
  expect(dispatched().filter((step) => step.includes(" archive "))).toHaveLength(1);
});

test("an Epic whose description links no spec is marked done with no archive pull request", async () => {
  world.jira.issues.get(EPIC)!.body = ["No spec."];

  await complete();

  expect(dispatched()).toContain(`${EPIC} archive no-spec`);
  expect(world.prs().map((pr) => pr.headRefName)).not.toContain(`docs/${EPIC}-archive-spec`);
});

test("the archive takes the repo from the Epic's Spec link, whichever repo's dispatcher closes the Epic", async () => {
  const specs = world.otherRepo("specs", { [SPEC]: "# The Loop\n" });
  world.jira.issues.get(EPIC)!.body = [`Spec: https://github.com/kcgbarbosa/specs/blob/main/${SPEC}`];

  await complete();

  const archived = world.prs().find((pr) => pr.headRefName === `docs/${EPIC}-archive-spec`);
  expect(archived).toMatchObject({ baseRefName: "main", state: "MERGED" });
  expect(archived!.url).toMatch(/^https:\/\/github\.com\/kcgbarbosa\/specs\/pull\/\d+$/);
  expect(world.git(specs, "ls-tree", "-r", "--name-only", "main")).not.toContain(SPEC);
  expect(world.git(world.origin, "ls-tree", "-r", "--name-only", "main")).toContain(SPEC);
  const pinned = world.git(specs, "rev-parse", "main~1");
  expect(world.jira.issues.get(EPIC)!.body).toEqual([`Spec: https://github.com/kcgbarbosa/specs/blob/${pinned}/${SPEC}`]);
  expect(dispatched()).toContain(`${EPIC} archive pr-open`);
  expect(world.jira.issues.get(EPIC)!.status).toBe("Done");
});

test("a spec that two Epics link stays on main until both are Done", async () => {
  world.jira.add("OTHER-1", "The Loop in the other repo", { issueType: "Epic", components: ["other"], status: "In Progress", body: [`Spec: ${LINK}`] });

  await complete();

  expect(world.decisions("").find((line) => line.step === "archive")).toMatchObject({ result: "waiting" });
  expect(world.decisions("").find((line) => line.step === "archive")!.detail).toContain("OTHER-1 also links it and is not Done");
  expect(world.prs().map((pr) => pr.headRefName)).not.toContain(`docs/${EPIC}-archive-spec`);
  expect(world.git(world.origin, "ls-tree", "-r", "--name-only", "main")).toContain(SPEC);
  expect(world.jira.issues.get(EPIC)!.body[0]).toBe(`The spec is ${LINK}.`);
  expect(world.jira.issues.get("OTHER-1")!.body).toEqual([`Spec: ${LINK}`]);
  expect(world.jira.issues.get(EPIC)!.status).toBe("Done");
});

test("once every Epic that links the spec is Done, it is archived and the Spec line of each is repointed", async () => {
  world.jira.add("OTHER-1", "The Loop in the other repo", { issueType: "Epic", components: ["other"], status: "Done", body: [`Spec: ${LINK}`] });

  await complete();

  const lastMerge = world.git(world.origin, "rev-parse", "main~1");
  const pinned = `https://github.com/kcgbarbosa/demo/blob/${lastMerge}/${SPEC}`;
  expect(world.prs().find((pr) => pr.headRefName === `docs/${EPIC}-archive-spec`)).toMatchObject({ state: "MERGED" });
  expect(world.git(world.origin, "ls-tree", "-r", "--name-only", "main")).not.toContain(SPEC);
  expect(world.jira.issues.get(EPIC)!.body[0]).toBe(`The spec is ${pinned}.`);
  expect(world.jira.issues.get("OTHER-1")!.body).toEqual([`Spec: ${pinned}`]);
});
