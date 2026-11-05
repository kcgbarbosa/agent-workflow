import { copyFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

test("a dry run prints what it would do and writes nothing to Jira, T3 or git", async () => {
  world.jira.add("AW-1", "Add login");
  world.jira.add("AW-2", "Crashed before its status");
  world.thread({ title: "AW-2: Crashed before its status", running: true });
  const before = world.git(world.repo, "rev-parse", "refs/remotes/origin/main");
  world.commit("ahead");
  world.git(world.repo, "push", "--quiet", "origin", "main");
  world.git(world.repo, "update-ref", "refs/remotes/origin/main", before);

  const tick = await world.dryRun();

  expect(tick.code).toBe(0);
  expect(tick.stdout).toContain('AW-1 start "AW-1: Add login" on feat/AW-1-add-login');
  expect(tick.stdout).toContain("AW-1 status In Progress");
  expect(tick.stdout).toContain("AW-2 status In Progress");
  expect(tick.lines.every((line) => line.startsWith("dry-run "))).toBe(true);
  expect(world.starts()).toEqual([]);
  expect(world.jira.writes).toEqual([]);
  expect(world.git(world.repo, "rev-parse", "refs/remotes/origin/main")).toBe(before);
});

test("a ready ticket gets a thread in its own worktree from the head of main, and moves to In Progress", async () => {
  world.jira.add("AW-1", "Add login, with SSO!");
  // The checkout is behind origin, where a blocker has just merged.
  world.commit("the checkout's");
  const head = world.git(world.repo, "rev-parse", "HEAD");
  world.git(world.repo, "push", "--quiet", "origin", "main");
  world.git(world.repo, "reset", "--quiet", "--hard", "HEAD~1");
  world.git(world.repo, "update-ref", "refs/remotes/origin/main", "HEAD");

  const tick = await world.tick();

  expect(tick.stderr).toBe("");
  expect(tick.code).toBe(0);
  const [start, ...others] = world.starts();
  expect(others).toEqual([]);
  expect(start.title).toBe("AW-1: Add login, with SSO!");
  expect(start.branch).toBe("feat/AW-1-add-login-with-sso");
  expect(start.worktree).toBe(head);
  expect(start.provider).toBe("claudeAgent");
  expect(start.model).toBe("claude-opus-5-5");
  expect(start.project).toBe(world.repo);
  expect(start.args).not.toContain("--wait");
  expect(start.args.slice(0, 2)).toEqual(["--log-level", "error"]);
  expect(start.message).toContain("AW-1");
  expect(start.message).toContain("/implement");
  expect(start.message).toContain("/pr");
  expect(start.message).toContain("feat/AW-1-add-login-with-sso");
  expect(start.message).toContain("comments");
  expect(start.message).toContain("cover your change");
  expect(world.jira.issues.get("AW-1")?.status).toBe("In Progress");
});

test("a To Do, unflagged Bug, as `to-bug` writes it, starts on the next tick on a fix branch", async () => {
  world.jira.add("AW-1", "Login fails", { issueType: "Bug" });
  await world.tick();
  expect(world.starts()[0].branch).toBe("fix/AW-1-login-fails");
});

test("a ticket whose blockers have all merged starts", async () => {
  world.jira.add("AW-2", "Next", { blockedBy: { "AW-1": "Done" } });
  await world.tick();
  expect(world.titles()).toEqual(["AW-2: Next"]);
});

test.each([
  ["Awaiting Approval", { status: "Awaiting Approval" }, "status Awaiting Approval"],
  ["an unmerged blocker", { blockedBy: { "AW-9": "Done", "AW-8": "In Review" } }, "blocked by AW-8"],
  ["Flagged", { flagged: true }, "Flagged"],
  ["an Epic", { issueType: "Epic" }, "an Epic"],
])("a ticket with %s does not start, and logs why", async (_name, values, reason) => {
  world.jira.add("AW-1", "Not this one", values);
  const tick = await world.tick();
  expect(tick.code).toBe(0);
  expect(world.starts()).toEqual([]);
  expect(world.jira.writes).toEqual([]);
  expect(tick.lines).toEqual([`AW-1 skip: ${reason}`]);
});

test("a ticket moved from Awaiting Approval to To Do starts at a later tick", async () => {
  world.jira.add("AW-1", "Waits for the owner", { status: "Awaiting Approval" });

  await world.tick();
  expect(world.starts()).toEqual([]);

  world.jira.issues.get("AW-1")!.status = "To Do";
  await world.tick();

  expect(world.titles()).toEqual(["AW-1: Waits for the owner"]);
  expect(world.jira.issues.get("AW-1")?.status).toBe("In Progress");
});

test("a To Do ticket blocked by a Awaiting Approval ticket waits", async () => {
  world.jira.add("AW-1", "The blocker", { status: "Awaiting Approval" });
  world.jira.add("AW-2", "Blocked", { blockedBy: { "AW-1": "Awaiting Approval" } });

  const tick = await world.tick();

  expect(world.starts()).toEqual([]);
  expect(world.jira.writes).toEqual([]);
  expect(tick.lines).toEqual(["AW-1 skip: status Awaiting Approval", "AW-2 skip: blocked by AW-1"]);
});

test.each([
  ["a stopped thread", { title: "AW-1: Moved back" }],
  ["a failed thread", { title: "AW-1: Moved back", failed: true }],
])("a ticket moved back to Awaiting Approval with %s does not start again", async (_name, thread) => {
  world.jira.add("AW-1", "Moved back", { status: "Awaiting Approval" });
  world.thread(thread);

  const tick = await world.tick();

  expect(tick.lines).toEqual(["AW-1 skip: status Awaiting Approval"]);
  expect(world.starts()).toEqual([]);
  expect(world.sends()).toEqual([]);
  expect(world.jira.writes).toEqual([]);
});

const HOLD = "Runner hold: Awaiting Approval";
const PR_URL = "https://github.com/o/r/pull/1";

test("a ticket moved back to Awaiting Approval with a red pull request gets no fix, no auto-merge and no status", async () => {
  world.jira.add("AW-1", "Moved back", { status: "Awaiting Approval" });
  world.thread({ title: "AW-1: Moved back" });
  world.pullRequest({ title: "feat(AW-1): moved back", headRefName: "feat/AW-1-moved-back", checks: [{ name: "gate / check", bucket: "fail" }] });

  await world.tick();

  expect(world.sends()).toEqual([]);
  expect(world.ghWrites().filter(([, verb]) => verb === "merge")).toEqual([]);
  expect(world.jira.writes).toEqual([]);
});

test("a stop with an open pull request turns auto-merge off and makes a draft, once", async () => {
  world.jira.add("AW-1", "Stopped", { status: "Awaiting Approval" });
  world.pullRequest({ title: "feat(AW-1): stopped", headRefName: "feat/AW-1-stopped" });
  world.updatePullRequest({ autoMergeRequest: { enabledAt: "now" } });

  await world.tick();

  expect(world.ghWrites()).toEqual([
    ["pr", "merge", PR_URL, "--disable-auto"],
    ["pr", "comment", PR_URL, "--body", HOLD],
    ["pr", "ready", PR_URL, "--undo"],
  ]);
  const [pr] = world.pullRequests();
  expect(pr.autoMergeRequest).toBeNull();
  expect(pr.isDraft).toBe(true);
  expect(pr.comments.map((comment: { body: string }) => comment.body)).toEqual([HOLD]);
  expect(world.jira.writes).toEqual([]);

  const writes = world.ghWrites();
  const again = await world.tick();

  expect(world.ghWrites()).toEqual(writes);
  expect(again.lines).toEqual(["AW-1 skip: status Awaiting Approval"]);
});

test("a stop on a Flagged ticket still turns auto-merge off and makes a draft", async () => {
  world.jira.add("AW-1", "Stuck and stopped", { status: "Awaiting Approval", flagged: true });
  world.pullRequest({ title: "feat(AW-1): stopped", headRefName: "feat/AW-1-stuck-and-stopped" });
  world.updatePullRequest({ autoMergeRequest: { enabledAt: "now" } });

  await world.tick();

  const [pr] = world.pullRequests();
  expect(pr.autoMergeRequest).toBeNull();
  expect(pr.isDraft).toBe(true);
});

test("a stop whose draft failed makes the draft on the next tick, with no second hold comment", async () => {
  world.jira.add("AW-1", "Stopped", { status: "Awaiting Approval" });
  world.pullRequest({ title: "feat(AW-1): stopped", headRefName: "feat/AW-1-stopped" });
  world.prComment(HOLD);

  await world.tick();

  const [pr] = world.pullRequests();
  expect(pr.isDraft).toBe(true);
  expect(pr.comments).toHaveLength(1);
});

test("a stop with a running turn sends no message, and the turn holds its place", async () => {
  world.config("limit = 1");
  world.jira.add("AW-1", "Stopped", { status: "Awaiting Approval" });
  world.thread({ title: "AW-1: Stopped", running: true });
  world.pullRequest({ title: "feat(AW-1): stopped", headRefName: "feat/AW-1-stopped", checks: [{ name: "gate / check", bucket: "fail" }] });
  world.jira.add("AW-2", "Next");

  const tick = await world.tick();

  expect(world.pullRequests()[0].isDraft).toBe(true);
  expect(world.sends()).toEqual([]);
  expect(world.starts()).toEqual([]);
  expect(tick.lines).toContain("AW-2 skip: wait, 1 of 1 places taken");
});

test("a stop on a draft the runner did not make writes no hold comment, and the draft stays after a resume", async () => {
  world.jira.add("AW-1", "Stopped", { status: "Awaiting Approval" });
  world.pullRequest({ title: "feat(AW-1): stopped", headRefName: "feat/AW-1-stopped", isDraft: true });

  await world.tick();
  expect(world.ghWrites()).toEqual([]);

  world.jira.issues.get("AW-1")!.status = "To Do";
  await world.tick();

  expect(world.pullRequests()[0].isDraft).toBe(true);
  expect(world.ghWrites()).toEqual([]);
});

test("a ticket back in To Do whose draft carries the hold comment gets ready and auto-merge on, once", async () => {
  world.jira.add("AW-1", "Resumed");
  world.thread({ title: "AW-1: Resumed" });
  world.pullRequest({ title: "feat(AW-1): resumed", headRefName: "feat/AW-1-resumed", isDraft: true });
  world.prComment(HOLD, 5);

  await world.tick();

  expect(world.ghWrites()).toEqual([
    ["pr", "ready", PR_URL],
    ["pr", "comment", PR_URL, "--body", "Runner hold released"],
    ["pr", "merge", PR_URL, "--auto", "--squash"],
  ]);
  const [pr] = world.pullRequests();
  expect(pr.isDraft).toBe(false);
  expect(pr.autoMergeRequest).not.toBeNull();
  expect(world.jira.issues.get("AW-1")?.status).toBe("In Review");

  const writes = world.ghWrites();
  await world.tick();
  expect(world.ghWrites()).toEqual(writes);
});

test("a ticket in To Do whose draft carries no hold comment stays a draft", async () => {
  world.jira.add("AW-1", "Agent's draft");
  world.pullRequest({ title: "feat(AW-1): draft", headRefName: "feat/AW-1-agents-draft", isDraft: true });

  await world.tick();

  expect(world.pullRequests()[0].isDraft).toBe(true);
  expect(world.ghWrites()).toEqual([]);
});

test("a draft made after a resume stays a draft", async () => {
  world.jira.add("AW-1", "Drafted again", { status: "In Review" });
  world.pullRequest({ title: "feat(AW-1): again", headRefName: "feat/AW-1-drafted-again", isDraft: true });
  world.prComment(HOLD, 10);
  world.prComment("Runner hold released", 5);

  await world.tick();

  expect(world.pullRequests()[0].isDraft).toBe(true);
  expect(world.ghWrites()).toEqual([]);
});

test("a resume whose release comment failed writes it on the next tick, so a later draft is not taken for the hold", async () => {
  world.jira.add("AW-1", "Resumed", { status: "In Review" });
  world.pullRequest({ title: "feat(AW-1): resumed", headRefName: "feat/AW-1-resumed" });
  world.prComment(HOLD, 5);

  await world.tick();

  expect(world.pullRequests()[0].comments.at(-1).body).toBe("Runner hold released");
  expect(world.pullRequests()[0].autoMergeRequest).not.toBeNull();
});

test("a second stop after a resume writes a second hold comment", async () => {
  world.jira.add("AW-1", "Stopped twice", { status: "Awaiting Approval" });
  world.pullRequest({ title: "feat(AW-1): twice", headRefName: "feat/AW-1-stopped-twice" });
  world.prComment(HOLD, 10);
  world.prComment("Runner hold released", 5);

  await world.tick();

  expect(world.pullRequests()[0].isDraft).toBe(true);
  expect(world.pullRequests()[0].comments.at(-1).body).toBe(HOLD);
});

test("a Flagged ticket keeps its held draft until the owner unflags it", async () => {
  world.jira.add("AW-1", "Flagged in To Do", { flagged: true });
  world.pullRequest({ title: "feat(AW-1): held", headRefName: "feat/AW-1-flagged-in-to-do", isDraft: true });
  world.prComment(HOLD, 5);

  await world.tick();

  expect(world.pullRequests()[0].isDraft).toBe(true);
  expect(world.ghWrites()).toEqual([]);
});

test("a turn still running on a ticket moved back to Awaiting Approval holds its place, and gets no status", async () => {
  world.config("limit = 1");
  world.jira.add("AW-1", "Moved back", { status: "Awaiting Approval" });
  world.thread({ title: "AW-1: Moved back", running: true });
  world.jira.add("AW-2", "Next");

  const tick = await world.tick();

  expect(tick.lines).toEqual(["AW-1 skip: status Awaiting Approval", "AW-2 skip: wait, 1 of 1 places taken"]);
  expect(world.starts()).toEqual([]);
  expect(world.jira.writes).toEqual([]);
});

test("a ticket moved back to Awaiting Approval whose pull request merged moves to Done", async () => {
  world.jira.add("AW-1", "Moved back", { status: "Awaiting Approval" });
  world.pullRequest({ title: "feat(AW-1): moved back", headRefName: "feat/AW-1-moved-back", state: "MERGED" });

  await world.tick();

  expect(world.jira.issues.get("AW-1")?.status).toBe("Done");
});

test("a Flagged Bug waits until the owner unflags it, and then starts", async () => {
  world.jira.add("AW-1", "Proposed", { issueType: "Bug", flagged: true });

  const tick = await world.tick();
  expect(tick.lines).toEqual(["AW-1 skip: Flagged"]);

  world.jira.issues.get("AW-1")!.flagged = false;
  await world.tick();

  expect(world.titles()).toEqual(["AW-1: Proposed"]);
});

test.each([
  ["another component", ["machines"]],
  ["no component", []],
])("a ticket of %s stays out of the tick", async (_name, components) => {
  world.jira.add("AW-1", "Not this repo", { components });
  const tick = await world.tick();
  expect(tick.code).toBe(0);
  expect(world.starts()).toEqual([]);
  expect(world.jira.writes).toEqual([]);
  expect(tick.lines).toEqual([]);
});

test("a thread whose title starts with the key stops a second thread, and a longer key does not", async () => {
  world.jira.add("AW-1", "Has a thread", { status: "In Progress" });
  world.jira.add("AW-4", "Is ready");
  world.thread({ title: "AW-1: Has a thread", running: true });
  world.thread({ title: "AW-41: Another ticket" });

  const tick = await world.tick();

  expect(world.titles()).toEqual(["AW-4: Is ready"]);
  expect(tick.stdout).toContain("AW-1 skip: has a thread");
});

test("a side thread that names a ticket does not count as its thread", async () => {
  world.jira.add("AW-1", "Is ready");
  world.thread({ title: "Sanity check AW-1 plan" });

  await world.tick();

  expect(world.titles()).toEqual(["AW-1: Is ready"]);
  expect(world.sends()).toEqual([]);
});

test("a tick from a worktree of the repo finds the T3 project and starts the thread", async () => {
  world.jira.add("AW-1", "Is ready");
  const worktree = join(world.root, "a-worktree");
  world.git(world.repo, "worktree", "add", "--quiet", worktree);
  copyFileSync(join(world.repo, "runner.toml"), join(worktree, "runner.toml"));

  const tick = await world.tick(worktree);

  expect(tick.code).toBe(0);
  expect(world.titles()).toEqual(["AW-1: Is ready"]);
});

test.each([
  ["open", "OPEN", "AW-1 status In Review: a pull request is open"],
  ["merged", "MERGED", "AW-1 status Done: the pull request merged"],
] as const)("a pull request that is %s stops a second thread", async (_name, state, line) => {
  world.jira.add("AW-1", "Built by hand");
  world.pullRequest({ title: "feat(AW-1): by hand", headRefName: "feat/AW-1-by-hand", state });
  const tick = await world.tick();
  expect(world.starts()).toEqual([]);
  expect(tick.lines[0]).toBe(line);
});

test("the pull request of a thread under another title is found by its branch", async () => {
  world.jira.add("AW-1", "Add login");
  world.pullRequest({ title: "A title with no key", headRefName: "feat/AW-1-add-login" });
  await world.tick();
  expect(world.starts()).toEqual([]);
});

test("a pull request with the key as its title's scope is found under a branch with no key", async () => {
  world.jira.add("AW-1", "Built by hand");
  world.pullRequest({ title: "feat(AW-1): by hand", headRefName: "by-hand", state: "MERGED" });
  const tick = await world.tick();
  expect(world.starts()).toEqual([]);
  expect(tick.lines[0]).toBe("AW-1 status Done: the pull request merged");
});

test("a closed pull request or a neighbour's stops nothing", async () => {
  world.jira.add("AW-1", "Tried before");
  world.pullRequest({ title: "feat(AW-1): tried", headRefName: "feat/AW-1-tried", state: "CLOSED" });
  world.pullRequest({ title: "feat(AW-12): follows AW-1", headRefName: "feat/AW-12-other" });
  await world.tick();
  expect(world.titles()).toEqual(["AW-1: Tried before"]);
});

test("ready tickets start by priority, then key, up to the limit", async () => {
  world.jira.add("AW-10", "Second by key");
  world.jira.add("AW-9", "First by key");
  world.jira.add("AW-11", "Top", { priority: "Highest" });
  world.jira.add("AW-12", "Over the limit");
  world.jira.add("AW-13", "Lowest", { priority: "Low" });

  const tick = await world.tick();

  expect(world.titles()).toEqual(["AW-11: Top", "AW-9: First by key", "AW-10: Second by key"]);
  expect(tick.stdout).toContain("AW-12 skip: wait, 3 of 3 places taken");
  expect(tick.stdout).toContain("AW-13 skip: wait, 3 of 3 places taken");
  expect(world.jira.issues.get("AW-12")?.status).toBe("To Do");
});

test("active turns and stuck tickets take a place, whatever their order in the queue", async () => {
  world.jira.add("AW-1", "Ready", { priority: "Highest" });
  world.jira.add("AW-2", "Ready too", { priority: "Highest" });
  world.jira.add("AW-3", "Active", { status: "In Progress" });
  world.jira.add("AW-4", "Stuck", { status: "In Progress", flagged: true });
  world.thread({ title: "AW-3: Active", running: true });
  world.thread({ title: "AW-4: Stuck" });

  const tick = await world.tick();

  expect(world.titles()).toEqual(["AW-1: Ready"]);
  expect(tick.stdout).toContain("AW-2 skip: wait, 3 of 3 places taken");
});

test("a thread waiting on a question, and an active fix on an open pull request, take a place", async () => {
  world.jira.add("AW-1", "Ready");
  world.jira.add("AW-2", "Waiting", { status: "In Progress" });
  world.jira.add("AW-3", "Fixing", { status: "In Review" });
  world.jira.add("AW-4", "Fixing too", { status: "In Review" });
  world.thread({ title: "AW-2: Waiting", waiting: true });
  world.thread({ title: "AW-3: Fixing", running: true });
  world.thread({ title: "AW-4: Fixing too", running: true });
  world.pullRequest({ title: "feat(AW-3): fix", headRefName: "feat/AW-3-fixing" });
  world.pullRequest({ title: "feat(AW-4): fix", headRefName: "feat/AW-4-fixing-too" });

  await world.tick();

  expect(world.starts()).toEqual([]);
});

test("a Flagged Bug with no thread and a pull request that waits on the gate take no place", async () => {
  world.config("limit = 1");
  world.jira.add("AW-1", "Ready");
  world.jira.add("AW-2", "Waits on the owner", { issueType: "Bug", flagged: true });
  world.jira.add("AW-3", "Waits on the gate", { status: "In Review" });
  world.thread({ title: "AW-3: Waits on the gate" });
  world.pullRequest({ title: "feat(AW-3): done", headRefName: "feat/AW-3-waits" });

  await world.tick();

  expect(world.titles()).toEqual(["AW-1: Ready"]);
});

test("each action and skip logs one line with its reason", async () => {
  world.config("limit = 1");
  world.jira.add("AW-1", "Ready");
  world.jira.add("AW-2", "Over the limit");
  world.jira.add("AW-3", "Awaiting Approval", { status: "Awaiting Approval" });

  const tick = await world.tick();

  expect(tick.lines).toEqual([
    'AW-1 start "AW-1: Ready" on feat/AW-1-ready: ready, 0 of 1 places taken',
    "AW-1 status In Progress: the thread started",
    "AW-2 skip: wait, 1 of 1 places taken",
    "AW-3 skip: status Awaiting Approval",
  ]);
});

test("a second tick repeats nothing, and the same state prints the same plan", async () => {
  world.jira.add("AW-1", "Ready");
  world.jira.add("AW-2", "Blocked", { blockedBy: { "AW-1": "To Do" } });
  expect((await world.dryRun()).stdout).toBe((await world.dryRun()).stdout);

  await world.tick();
  const writes = [...world.jira.writes];
  const again = await world.tick();

  expect(again.code).toBe(0);
  expect(world.titles()).toEqual(["AW-1: Ready"]);
  expect(world.jira.writes).toEqual(writes);
  expect(again.lines).toContain("AW-1 skip: has a thread");
});

test("a crash between the start and the status sets the status at the next tick, with no second thread", async () => {
  world.jira.add("AW-1", "Crashed");
  world.thread({ title: "AW-1: Crashed", running: true });

  const tick = await world.tick();

  expect(world.starts()).toEqual([]);
  expect(world.jira.issues.get("AW-1")?.status).toBe("In Progress");
  expect(tick.lines).toEqual(["AW-1 status In Progress: it has a thread and no pull request"]);
});

test.each([
  ["Jira", () => (world.jira.down = 401)],
  ["GitHub", () => world.down("gh")],
  ["T3", () => world.down("t3")],
])("a tick that cannot read %s exits non-zero and writes nothing", async (name, breakIt) => {
  world.jira.add("AW-1", "Ready");
  world.jira.add("AW-2", "Crashed");
  world.thread({ title: "AW-2: Crashed" });
  if (name === "T3") world.jira.issues.delete("AW-2");
  breakIt();

  const tick = await world.tick();

  expect(tick.code).not.toBe(0);
  expect(tick.stderr).not.toBe("");
  expect(world.starts()).toEqual([]);
  expect(world.jira.writes).toEqual([]);
  expect(tick.lines).toEqual([]);
});

test("every t3 call asks for errors only, so its log lines cannot break the JSON", async () => {
  world.jira.add("AW-1", "Has a thread", { status: "In Progress" });
  world.thread({ title: "AW-1: Has a thread" });
  const tick = await world.tick();
  expect(tick.code).toBe(0);
  for (const call of world.t3Calls()) expect(call.slice(0, 2)).toEqual(["--log-level", "error"]);
});

test("a tick that cannot read the head of main starts nothing", async () => {
  world.jira.add("AW-1", "Ready");
  rmSync(world.origin, { recursive: true });
  const tick = await world.tick();
  expect(tick.code).not.toBe(0);
  expect(world.starts()).toEqual([]);
  expect(world.jira.writes).toEqual([]);
});

test("a thread that fails to start keeps its ticket's status, holds up no other ticket, and fails the tick", async () => {
  world.jira.add("AW-1", "Will not start", { priority: "High" });
  world.jira.add("AW-2", "Starts");
  world.failStart("AW-1");

  const tick = await world.tick();

  expect(tick.code).not.toBe(0);
  expect(tick.stderr).toContain("AW-1 failed");
  expect(world.titles()).toEqual(["AW-1: Will not start", "AW-2: Starts"]);
  expect(world.jira.issues.get("AW-1")?.status).toBe("To Do");
  expect(world.jira.issues.get("AW-2")?.status).toBe("In Progress");
});

test("a tick with no secret or no config exits non-zero before it reads", async () => {
  world.jira.add("AW-1", "Ready");
  world.unset("JIRA_API_TOKEN");
  const noSecret = await world.tick();
  expect(noSecret.code).not.toBe(0);
  expect(noSecret.stderr).toContain("JIRA_API_TOKEN");

  rmSync(join(world.repo, "runner.toml"));
  const noConfig = await world.tick();
  expect(noConfig.code).not.toBe(0);
  expect(noConfig.stderr).toContain("runner.toml");
  expect(world.starts()).toEqual([]);
});

test("the provider, the model and the extra line come from the config", async () => {
  world.config(['provider = "codex"', 'model = "gpt-9"', 'first_message = "Mind the stack."'].join("\n"));
  world.jira.add("AW-1", "Ready");
  await world.tick();
  const [start] = world.starts();
  expect(start.provider).toBe("codex");
  expect(start.model).toBe("gpt-9");
  expect(start.message).toContain("Mind the stack.");
});

test("an unknown command prints the usage and fails", async () => {
  const done = await world.runner("start");
  expect(done.code).not.toBe(0);
  expect(done.stderr).toContain("runner tick");
});

