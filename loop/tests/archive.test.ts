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

test("the last merge of an Epic archives the spec and marks the Epic done", async () => {
  const ran = await world.loop("run", EPIC);

  expect(ran.code, ran.stderr).toBe(0);
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
  const steps = world.steps();
  expect(steps.indexOf("DEMO-3 merge merged")).toBeLessThan(steps.indexOf(`${EPIC} archive pr-open`));
  expect(steps.indexOf(`${EPIC} archive pr-open`)).toBeLessThan(steps.indexOf(`${EPIC} complete ok`));
  expect(world.decisions().find((line) => line.step === "archive")).toMatchObject({ pr: archived!.url });
  expect(world.jira.notifications).toContain(`${EPIC} complete`);
  expect(world.decisions().find((line) => line.step === "finish")!.detail).toContain(`${EPIC} is complete`);
});

test("an Epic with a ticket still open is not archived", async () => {
  world.plan({ "DEMO-3": [{ status: "blocked", reason: "It needs KC." }] });

  const ran = await world.loop("run", EPIC);

  expect(ran.code).toBe(1);
  expect(world.steps().filter((step) => / (archive|complete) /.test(step))).toEqual([]);
  expect(world.prs().map((pr) => pr.headRefName)).not.toContain(`docs/${EPIC}-archive-spec`);
  expect(world.jira.issues.get(EPIC)!.status).toBe("To Do");
});

test("a ticket run that merges the Epic's last ticket archives the Epic", async () => {
  world.jira.issues.get("DEMO-3")!.status = "Done";

  const ran = await world.loop("run", "DEMO-2");

  expect(ran.code, ran.stderr).toBe(0);
  expect(world.steps("DEMO-2")).toEqual(expect.arrayContaining(["DEMO-2 archive pr-open", "DEMO-2 complete ok"]));
  expect(world.jira.issues.get(EPIC)!.status).toBe("Done");
});

test("a run after the archive repeats no side effect", async () => {
  expect((await world.loop("run", EPIC)).code).toBe(0);
  const prs = world.prs().length;

  const again = await world.loop("run", EPIC);

  expect(again.code, again.stderr).toBe(0);
  expect(world.prs()).toHaveLength(prs);
  expect(world.steps().filter((step) => step.includes(" archive "))).toHaveLength(1);
});

test("an Epic whose description links no spec is marked done with no archive pull request", async () => {
  world.jira.issues.get(EPIC)!.body = ["No spec."];

  expect((await world.loop("run", EPIC)).code).toBe(0);

  expect(world.steps()).toEqual(expect.arrayContaining([`${EPIC} archive no-spec`, `${EPIC} complete ok`]));
  expect(world.prs().map((pr) => pr.headRefName)).not.toContain(`docs/${EPIC}-archive-spec`);
});
