import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { World } from "./world.ts";

let world: World;

beforeEach(async () => {
  world = new World();
  await world.start();
});

afterEach(async () => {
  await world.stop();
});

function folder(): string {
  return join(world.root, ".local", "state", "runner", "agent-workflow");
}

function today(): any {
  return JSON.parse(readFileSync(join(folder(), "today.json"), "utf8"));
}

test("a tick that planned nothing writes the file with the five fields", async () => {
  const before = Date.now();

  const tick = await world.tick();

  expect(tick.code).toBe(0);
  expect(tick.lines).toEqual([]);
  const { at, ...fields } = today();
  expect(Date.parse(at)).toBeGreaterThanOrEqual(before);
  expect(fields).toEqual({ awaitingApproval: 0, stuck: [], drafts: [], red: [] });
  expect(readdirSync(folder())).toEqual(["today.json"]);
});

test("the file holds what waits on the owner", async () => {
  world.jira.add("AW-1", "To approve", { status: "Awaiting Approval" });
  world.jira.add("AW-2", "To approve too", { status: "Awaiting Approval" });
  world.jira.add("AW-3", "An Epic to approve", { status: "Awaiting Approval", issueType: "Epic" });
  world.jira.add("AW-4", "Stuck", { status: "In Progress", flagged: true });
  world.ticketComment("AW-4", "Stuck: build: the first reason.", 60);
  world.ticketComment("AW-4", "Stuck: gate: the latest reason.", 10);
  world.ticketComment("AW-4", "Runner sent continue: a later comment.", 5);
  world.jira.add("AW-5", "Flagged with no reason", { status: "In Progress", flagged: true });
  world.pullRequest({ title: "feat(AW-6): a draft", headRefName: "feat/AW-6-a-draft", isDraft: true });
  world.pullRequest({
    title: "no ticket: two red checks",
    headRefName: "no-ticket",
    checks: [
      { name: "gate", bucket: "fail" },
      { name: "build", bucket: "pass" },
      { name: "review", bucket: "cancel" },
      { name: "fuzz", bucket: "pending" },
    ],
  });
  world.pullRequest({ title: "green", headRefName: "green", checks: [{ name: "gate", bucket: "pass" }] });
  world.pullRequest({ title: "merged", headRefName: "merged", state: "MERGED", isDraft: true, checks: [{ name: "gate", bucket: "fail" }] });

  const tick = await world.tick();

  expect(tick.stderr).toBe("");
  expect(today()).toMatchObject({
    awaitingApproval: 2,
    stuck: [
      { key: "AW-4", reason: "gate: the latest reason." },
      { key: "AW-5", reason: "Flagged" },
    ],
    drafts: [{ number: 1, title: "feat(AW-6): a draft" }],
    red: [{ number: 2, checks: ["gate", "review"] }],
  });
});

test("the next tick overwrites the file", async () => {
  world.jira.add("AW-1", "To approve", { status: "Awaiting Approval" });
  await world.tick();
  expect(today().awaitingApproval).toBe(1);

  world.jira.issues.get("AW-1")!.status = "Done";
  await world.tick();

  expect(today().awaitingApproval).toBe(0);
  expect(readdirSync(folder())).toEqual(["today.json"]);
});

test("a dry run writes the file, and nothing else", async () => {
  world.jira.add("AW-1", "To approve", { status: "Awaiting Approval" });
  world.jira.add("AW-2", "Ready");

  const tick = await world.dryRun();

  expect(tick.code).toBe(0);
  expect(world.jira.writes).toEqual([]);
  expect(world.starts()).toEqual([]);
  expect(today().awaitingApproval).toBe(1);
});

test("a tick with a failed step still writes the file, and fails", async () => {
  world.jira.add("AW-1", "Fails to start");
  world.failStart("AW-1");

  const tick = await world.tick();

  expect(tick.code).toBe(1);
  expect(today().awaitingApproval).toBe(0);
});

test("a tick that cannot read writes no file, so its age shows", async () => {
  world.down("gh");
  world.jira.add("AW-1", "Ready");

  const tick = await world.tick();

  expect(tick.code).toBe(1);
  expect(existsSync(folder())).toBe(false);
});

test("the file goes under XDG_STATE_HOME when it is set", async () => {
  const home = join(world.root, "state-home");

  const tick = await world.shell(`XDG_STATE_HOME='${home}' '${join(import.meta.dirname, "..", "bin", "runner")}' tick`);

  expect(tick.code).toBe(0);
  expect(existsSync(join(home, "runner", "agent-workflow", "today.json"))).toBe(true);
});
