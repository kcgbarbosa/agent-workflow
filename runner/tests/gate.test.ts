// The gate, stopped threads, being told, stepping in, and Jira status, each driven through the `runner` command.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type PullRequest, WEBHOOK, World } from "./world.ts";

let world: World;

const RED = [{ name: "gate / check", bucket: "fail" as const }];
const GREEN = [{ name: "gate / check", bucket: "pass" as const }];
const PENDING = [{ name: "gate / check", bucket: "pending" as const }];
const BRANCH = "feat/AW-1-build";
const LONG_AGO = 90;

beforeEach(async () => {
  world = new World();
  await world.start();
});

afterEach(async () => {
  await world.stop();
});

/** A ticket in review with a stopped thread and a pull request of these values. */
function inReview(values: Partial<PullRequest> = {}, thread = true): void {
  world.jira.add("AW-1", "Build", { status: "In Review" });
  if (thread) world.thread({ title: "AW-1: Build" });
  world.pullRequest({ title: "feat(AW-1): build", headRefName: BRANCH, ...values });
}

/** What a second tick on the same state must leave alone. */
function writes(): unknown {
  return { jira: [...world.jira.writes], gh: world.ghWrites(), sends: world.sends(), starts: world.starts(), slack: [...world.slack.posts] };
}

function status(key = "AW-1"): string | undefined {
  return world.jira.issues.get(key)?.status;
}

function flagged(key = "AW-1"): boolean | undefined {
  return world.jira.issues.get(key)?.flagged;
}

function comments(key = "AW-1"): string[] {
  return (world.jira.issues.get(key)?.comments ?? []).map((comment) => comment.text);
}

// The gate and merge.

test.each([
  ["green", GREEN],
  ["pending", PENDING],
  ["with no check reported", []],
])("an open pull request that is %s gets auto-merge on once", async (_name, checks) => {
  inReview({ checks });

  const tick = await world.tick();

  expect(tick.code).toBe(0);
  expect(world.ghWrites()).toEqual([["pr", "merge", "https://github.com/o/r/pull/1", "--auto", "--squash"]]);
  const before = writes();
  const again = await world.tick();
  expect(writes()).toEqual(before);
  expect(again.lines).toEqual(["AW-1 skip: waits on the gate"]);
});

test("a draft is left alone, and moves to In Review only", async () => {
  world.jira.add("AW-1", "Build", { status: "In Progress" });
  world.thread({ title: "AW-1: Build", waiting: true });
  world.pullRequest({ title: "feat(AW-1): build", headRefName: BRANCH, isDraft: true, checks: RED });

  await world.tick();

  expect(status()).toBe("In Review");
  expect(world.ghWrites()).toEqual([]);
  expect(world.sends()).toEqual([]);
  expect(flagged()).toBe(false);
});

test("a red required check is sent to the thread with its name, and a comment gives the attempt and the head", async () => {
  inReview({ checks: [...RED, { name: "gate / review", bucket: "pass" }, { name: "gate / fuzz", bucket: "cancel" }], headRefOid: "abc123" });

  const tick = await world.tick();

  expect(tick.code).toBe(0);
  const [send, ...others] = world.sends();
  expect(others).toEqual([]);
  expect(send.threadId).toBe("seeded:1");
  expect(send.message).toContain("gate / check");
  expect(send.message).toContain("gate / fuzz");
  expect(send.message).not.toContain("gate / review");
  const [comment] = world.pullRequests()[0].comments;
  expect(comment.body).toContain("attempt 1 of 3");
  expect(comment.body).toContain("abc123");
  expect(world.ghWrites()[0].slice(0, 3)).toEqual(["pr", "comment", "https://github.com/o/r/pull/1"]);
  expect(world.slack.posts).toEqual([]);
});

test("a merge conflict is sent to the thread, with no auto-merge", async () => {
  inReview({ mergeable: "CONFLICTING" });

  await world.tick();

  expect(world.sends()[0].message).toContain("conflict");
  expect(world.pullRequests()[0].comments[0].body).toContain("attempt 1 of 3");
  expect(world.ghWrites().filter(([, verb]) => verb === "merge")).toEqual([]);
});

test("one head SHA is sent once: not while the fix runs, not after it stops, and a new push is sent again", async () => {
  inReview({ checks: RED, headRefOid: "aaa111" });

  await world.tick();
  expect(world.sends().length).toBe(1);

  // The fix turn runs.
  await world.tick();
  expect(world.sends().length).toBe(1);

  // It stopped with no push, inside the quiet period.
  world.stopThreads();
  const stopped = await world.tick();
  expect(world.sends().length).toBe(1);
  expect(stopped.lines).toEqual(["AW-1 skip: a fix was sent for this head"]);
  expect(flagged()).toBe(false);

  world.updatePullRequest({ headRefOid: "bbb222" });
  await world.tick();
  expect(world.sends().length).toBe(2);
  const bodies = world.pullRequests()[0].comments.map((comment: { body: string }) => comment.body);
  expect(bodies[1]).toContain("attempt 2 of 3");
  expect(bodies[1]).toContain("bbb222");
});

test.each([
  ["the thread has an active turn", { checks: RED }, { running: true }],
  ["checks are pending", { checks: [...RED, ...PENDING.map((check) => ({ ...check, name: "gate / fuzz" }))] }, {}],
  ["a conflict waits while checks are pending", { checks: PENDING, mergeable: "CONFLICTING" as const }, {}],
])("nothing is sent while %s", async (_name, values, thread) => {
  world.jira.add("AW-1", "Build", { status: "In Review" });
  world.thread({ title: "AW-1: Build", ...thread });
  world.pullRequest({ title: "feat(AW-1): build", headRefName: BRANCH, ...values });

  await world.tick();

  expect(world.sends()).toEqual([]);
  expect(world.pullRequests()[0].comments).toEqual([]);
  expect(flagged()).toBe(false);
});

test("at the cap of attempts the ticket is Flagged, with no fourth message", async () => {
  inReview({ checks: RED, headRefOid: "ddd444" });
  world.prComment("Runner fix attempt 1 of 3 at aaa111: gate / check failed.", 30);
  world.prComment("Runner fix attempt 2 of 3 at bbb222: gate / check failed.", 20);
  world.prComment("Runner fix attempt 3 of 3 at ccc333: gate / check failed.", 10);
  world.prComment("A person's comment on attempt 3.", 5);

  await world.tick();

  expect(world.sends()).toEqual([]);
  expect(flagged()).toBe(true);
  expect(comments()[0]).toMatch(/^Stuck: /);
  expect(comments()[0]).toContain("3 fix attempts");
  expect(world.slack.posts.length).toBe(1);
});

test("the cap comes from the config", async () => {
  world.config("fix_attempts = 1");
  inReview({ checks: RED, headRefOid: "bbb222" });
  world.prComment("Runner fix attempt 1 of 1 at aaa111: gate / check failed.", 10);

  await world.tick();

  expect(flagged()).toBe(true);
});

test("a fix turn that pushes nothing is Flagged after the quiet period, measured from its comment", async () => {
  inReview({ checks: RED, headRefOid: "aaa111" });
  world.prComment("Runner fix attempt 1 of 3 at aaa111: gate / check failed.", LONG_AGO);

  await world.tick();

  expect(world.sends()).toEqual([]);
  expect(flagged()).toBe(true);
  expect(comments()[0]).toContain("pushed nothing");
});

test("the quiet period comes from the config", async () => {
  world.config("quiet_minutes = 120");
  inReview({ checks: RED, headRefOid: "aaa111" });
  world.prComment("Runner fix attempt 1 of 3 at aaa111: gate / check failed.", LONG_AGO);

  await world.tick();

  expect(flagged()).toBe(false);
});

// Stopped threads.

test("a thread waiting on a question is Flagged at once, with no retry", async () => {
  world.jira.add("AW-1", "Build", { status: "In Progress" });
  world.thread({ title: "AW-1: Build", waiting: true });

  await world.tick();

  expect(world.sends()).toEqual([]);
  expect(flagged()).toBe(true);
  expect(comments()[0]).toMatch(/^Stuck: build: .*question/);
});

test("a thread waiting on a question with an open pull request is Flagged before the gate", async () => {
  inReview({ checks: RED }, false);
  world.thread({ title: "AW-1: Build", waiting: true });

  await world.tick();

  expect(world.sends()).toEqual([]);
  expect(world.ghWrites()).toEqual([]);
  expect(flagged()).toBe(true);
  expect(comments()[0]).toMatch(/^Stuck: gate: .*question/);
});

test.each([
  ["failed", { failed: true }],
  ["completed with no pull request", {}],
])("a thread that %s gets one continue, recorded on the ticket, then is Flagged", async (_name, values) => {
  world.jira.add("AW-1", "Build", { status: "In Progress" });
  world.thread({ title: "AW-1: Build", ...values });

  await world.tick();

  const [send, ...others] = world.sends();
  expect(others).toEqual([]);
  expect(send.threadId).toBe("seeded:1");
  expect(send.message).toContain("Continue");
  expect(comments().length).toBe(1);
  expect(comments()[0]).toMatch(/^Runner sent continue/);
  expect(flagged()).toBe(false);

  // The retry runs.
  await world.tick();
  expect(world.sends().length).toBe(1);

  // It stops again with no pull request.
  world.stopThreads();
  await world.tick();
  expect(world.sends().length).toBe(1);
  expect(flagged()).toBe(true);
  expect(comments()[1]).toMatch(/^Stuck: build: /);
});

test("a thread with an active turn and no update for the quiet period is Flagged", async () => {
  world.jira.add("AW-1", "Build", { status: "In Progress" });
  world.thread({ title: "AW-1: Build", running: true, quietMinutes: LONG_AGO });

  await world.tick();

  expect(flagged()).toBe(true);
  expect(comments()[0]).toContain("no update");
});

test("an active thread inside the quiet period is left alone", async () => {
  world.jira.add("AW-1", "Build", { status: "In Progress" });
  world.thread({ title: "AW-1: Build", running: true, quietMinutes: 30 });

  const tick = await world.tick();

  expect(flagged()).toBe(false);
  expect(tick.lines).toEqual(["AW-1 skip: has a thread"]);
});

test("a pull request with no thread is Flagged when it needs a fix, and starts no second thread", async () => {
  inReview({ checks: RED }, false);

  await world.tick();

  expect(world.starts()).toEqual([]);
  expect(flagged()).toBe(true);
  expect(comments()[0]).toContain("no thread");
  expect(world.slack.posts[0].text).toContain("https://github.com/o/r/pull/1");
});

test("a pull request with no thread that is green gets auto-merge and no flag", async () => {
  inReview({ checks: GREEN }, false);

  await world.tick();

  expect(flagged()).toBe(false);
  expect(world.ghWrites().map(([, verb]) => verb)).toEqual(["merge"]);
});

// Being told.

test("a flag writes the Stuck comment, posts to Slack with the four parts, then flags, in that order and once", async () => {
  world.jira.add("AW-1", "Build", { status: "In Progress" });
  world.thread({ title: "AW-1: Build", waiting: true });

  const tick = await world.tick();

  expect(world.jira.writes.map((write) => write.split(" ")[0])).toEqual(["comment", "flag"]);
  expect(tick.lines.map((line) => line.split(/[ :]/)[1])).toEqual(["comment", "notify", "flag"]);
  const [post, ...others] = world.slack.posts;
  expect(others).toEqual([]);
  expect(post.path).toBe(WEBHOOK);
  expect(post.text.split("\n")).toEqual([
    "AW-1 stuck: the thread waits on a question",
    `${world.jira.url}/browse/AW-1`,
    "https://t14.tail4fca58.ts.net:7443/env/seeded%3A1",
  ]);

  const before = writes();
  await world.tick();
  expect(writes()).toEqual(before);
});

test.each([
  ["machines", "SLACK_WEBHOOK_KC_WORKFLOW", WEBHOOK],
  ["pitchridge", "SLACK_WEBHOOK_PITCHRIDGE", "/services/pitchridge"],
])("a stuck %s ticket posts to the webhook in %s", async (component, env, path) => {
  world.config("", component);
  world.setEnv(env, `${world.slack.url}${path}`);
  world.jira.add("AW-1", "Build", { status: "In Progress", components: [component] });
  world.thread({ title: "AW-1: Build", waiting: true });

  await world.tick();

  expect(world.slack.posts.map((post) => post.path)).toEqual([path]);
});

test("the post escapes what Slack reads as markup", async () => {
  inReview({ checks: [{ name: "a <b> & c", bucket: "fail" }] }, false);

  await world.tick();

  expect(world.slack.posts[0].text).toContain("a &lt;b&gt; &amp; c failed");
  expect(comments()[0]).toContain("a <b> & c failed");
});

test("the address of the notification's link comes from the config", async () => {
  world.config('thread_url = "https://other.example:8443/"');
  world.jira.add("AW-1", "Build", { status: "In Progress" });
  world.thread({ title: "AW-1: Build", waiting: true });

  await world.tick();

  expect(world.slack.posts[0].text).toContain("https://other.example:8443/env/seeded%3A1");
});

test("a start, a fix, an auto-merge and a merge notify nothing", async () => {
  world.jira.add("AW-1", "Ready");
  world.jira.add("AW-2", "Fix", { status: "In Review" });
  world.thread({ title: "AW-2: Fix" });
  world.pullRequest({ title: "feat(AW-2): fix", headRefName: "feat/AW-2-fix", checks: RED });
  world.jira.add("AW-3", "Green", { status: "In Review" });
  world.pullRequest({ title: "feat(AW-3): green", headRefName: "feat/AW-3-green", checks: GREEN });
  world.jira.add("AW-4", "Merged", { status: "In Review" });
  world.pullRequest({ title: "feat(AW-4): merged", headRefName: "feat/AW-4-merged", state: "MERGED" });

  const tick = await world.tick();

  expect(tick.code).toBe(0);
  expect(world.starts().length).toBe(1);
  expect(world.sends().length).toBe(1);
  expect(world.slack.posts).toEqual([]);
});

test.each([
  ["a question", () => {
    world.jira.add("AW-1", "Build", { status: "In Progress" });
    world.thread({ title: "AW-1: Build", waiting: true });
  }, "question"],
  ["a thread that stopped again", () => {
    world.jira.add("AW-1", "Build", { status: "In Progress" });
    world.thread({ title: "AW-1: Build" });
    world.ticketComment("AW-1", "Runner sent continue: the thread stopped with no pull request.", 10);
  }, "stopped again"],
  ["the cap of attempts", () => {
    inReview({ checks: RED, headRefOid: "bbb222" });
    world.config("fix_attempts = 1");
    world.prComment("Runner fix attempt 1 of 1 at aaa111: gate / check failed.", 10);
  }, "1 fix attempts"],
  ["a fix turn that pushed nothing", () => {
    inReview({ checks: RED, headRefOid: "aaa111" });
    world.prComment("Runner fix attempt 1 of 3 at aaa111: gate / check failed.", LONG_AGO);
  }, "pushed nothing"],
])("after %s, a refused post fails the tick before the flag, and the next tick posts and flags with no second comment", async (_name, seed, reason) => {
  seed();
  world.slack.down = 500;

  const refused = await world.tick();

  expect(refused.code).not.toBe(0);
  expect(refused.stderr).toContain("AW-1 failed");
  expect(refused.stderr).toContain("Slack: HTTP 500");
  expect(refused.stderr).not.toContain(WEBHOOK);
  expect(flagged()).toBe(false);
  const stuck = comments().filter((text) => text.startsWith("Stuck:"));
  expect(stuck.length).toBe(1);
  const pullRequestComments = world.pullRequests().flatMap((pr) => pr.comments);

  // Slack still refuses it, and nothing else moves.
  expect((await world.tick()).code).not.toBe(0);
  expect(flagged()).toBe(false);

  world.slack.down = null;
  const retry = await world.tick();

  expect(retry.code).toBe(0);
  expect(flagged()).toBe(true);
  expect(comments().filter((text) => text.startsWith("Stuck:"))).toEqual(stuck);
  expect(world.sends()).toEqual([]);
  expect(world.pullRequests().flatMap((pr) => pr.comments)).toEqual(pullRequestComments);
  const [post, ...others] = world.slack.posts;
  expect(others).toEqual([]);
  expect(post.text).toContain(reason);
  expect(post.text.split("\n")[1]).toBe(`${world.jira.url}/browse/AW-1`);

  await world.tick();
  expect(world.slack.posts.length).toBe(1);
});

test("a refused post after an earlier stop was unflagged is still posted, with one new comment", async () => {
  world.jira.add("AW-1", "Build", { status: "In Progress" });
  world.thread({ title: "AW-1: Build" });
  world.ticketComment("AW-1", "Stuck: build: the thread stopped again with no pull request.", 40);
  world.ticketUnflagged("AW-1", 39, 30);
  world.ticketComment("AW-1", "Runner sent continue: the thread stopped with no pull request.", 20);
  world.slack.down = 500;

  await world.tick();
  world.slack.down = null;
  await world.tick();

  expect(flagged()).toBe(true);
  expect(comments().filter((text) => text.startsWith("Stuck:")).length).toBe(2);
  expect(world.sends()).toEqual([]);
  expect(world.slack.posts.length).toBe(1);
});

test("a webhook value that cannot be read fails the tick, and no error names it", async () => {
  world.setEnv("SLACK_WEBHOOK_KC_WORKFLOW", "not-a-secret-url");
  world.jira.add("AW-1", "Build", { status: "In Progress" });
  world.thread({ title: "AW-1: Build", waiting: true });

  const tick = await world.tick();

  expect(tick.code).not.toBe(0);
  expect(tick.stderr).not.toContain("not-a-secret-url");
  expect(flagged()).toBe(false);
});

test("a stuck ticket needs no ntfy topic, and no runner code names ntfy", async () => {
  world.jira.add("AW-1", "Build", { status: "In Progress" });
  world.thread({ title: "AW-1: Build", waiting: true });

  const tick = await world.tick();

  expect(tick.code).toBe(0);
  expect(world.slack.posts.length).toBe(1);
  const source = join(import.meta.dirname, "..", "src");
  for (const file of readdirSync(source)) expect(readFileSync(join(source, file), "utf8")).not.toMatch(/ntfy/i);
});

test("a tick with no webhook value exits non-zero before it reads", async () => {
  world.jira.add("AW-1", "Ready");
  world.unset("SLACK_WEBHOOK_KC_WORKFLOW");
  const tick = await world.tick();
  expect(tick.code).not.toBe(0);
  expect(tick.stderr).toContain("SLACK_WEBHOOK_KC_WORKFLOW");
  expect(world.starts()).toEqual([]);
  expect(world.t3Calls()).toEqual([]);
});

// After I step in.

test.each([
  ["a red pull request", () => inReview({ checks: RED }, true)],
  ["a green pull request", () => inReview({ checks: GREEN }, true)],
])("a Flagged ticket with %s gets no action", async (_name, seed) => {
  seed();
  world.jira.issues.get("AW-1")!.flagged = true;

  const tick = await world.tick();

  expect(tick.lines).toEqual(["AW-1 skip: Flagged"]);
  expect(world.jira.writes).toEqual([]);
  expect(world.ghWrites()).toEqual([]);
  expect(world.sends()).toEqual([]);
  expect(world.slack.posts).toEqual([]);
});

test("unflagging at the cap gives a fresh count, and it is not flagged again at once", async () => {
  inReview({ checks: RED, headRefOid: "ddd444" });
  world.prComment("Runner fix attempt 1 of 3 at aaa111: gate / check failed.", 30);
  world.prComment("Runner fix attempt 2 of 3 at bbb222: gate / check failed.", 20);
  world.prComment("Runner fix attempt 3 of 3 at ccc333: gate / check failed.", 10);
  await world.tick();
  expect(flagged()).toBe(true);

  world.jira.issues.get("AW-1")!.flagged = false;
  await world.tick();

  expect(flagged()).toBe(false);
  const [send, ...others] = world.sends();
  expect(others).toEqual([]);
  expect(send.message).toContain("ddd444");
  expect(world.pullRequests()[0].comments.at(-1).body).toContain("attempt 1 of 3");
});

test("unflagging a fix turn that pushed nothing sends that head again", async () => {
  inReview({ checks: RED, headRefOid: "aaa111" });
  world.prComment("Runner fix attempt 1 of 3 at aaa111: gate / check failed.", LONG_AGO);
  world.ticketComment("AW-1", "Stuck: gate: the fix turn pushed nothing.", 10);
  world.ticketUnflagged("AW-1", 9);

  await world.tick();

  expect(flagged()).toBe(false);
  expect(world.sends().length).toBe(1);
});

test("unflagging a stopped thread gives it one more continue", async () => {
  world.jira.add("AW-1", "Build", { status: "In Progress" });
  world.thread({ title: "AW-1: Build" });
  world.ticketComment("AW-1", "Runner sent continue: the thread stopped with no pull request.", 30);
  world.ticketComment("AW-1", "Stuck: build: the thread stopped again with no pull request.", 20);
  world.ticketUnflagged("AW-1", 19, 15);

  await world.tick();

  expect(flagged()).toBe(false);
  expect(world.sends().length).toBe(1);
});

test("a continue before the latest Stuck does not count, and one after it does", async () => {
  world.jira.add("AW-1", "Build", { status: "In Progress" });
  world.thread({ title: "AW-1: Build" });
  world.ticketComment("AW-1", "Runner sent continue: the thread stopped with no pull request.", 30);
  world.ticketComment("AW-1", "Stuck: build: the thread stopped again with no pull request.", 20);
  world.ticketUnflagged("AW-1", 19, 15);
  world.ticketComment("AW-1", "Runner sent continue: the thread stopped with no pull request.", 10);

  await world.tick();

  expect(world.sends()).toEqual([]);
  expect(flagged()).toBe(true);
});

// The limit.

test("a stopped thread flagged at this tick holds its place at once", async () => {
  world.config("limit = 1");
  world.jira.add("AW-1", "Stops", { status: "In Progress" });
  world.thread({ title: "AW-1: Stops" });
  world.ticketComment("AW-1", "Runner sent continue: the thread stopped with no pull request.", 10);
  world.jira.add("AW-2", "Ready");

  const tick = await world.tick();

  expect(flagged()).toBe(true);
  expect(world.starts()).toEqual([]);
  expect(tick.stdout).toContain("AW-2 skip: wait, 1 of 1 places taken");
});

test("fix messages go before new starts, whatever the priority, and take the place", async () => {
  world.config("limit = 1");
  world.jira.add("AW-1", "Ready", { priority: "Highest" });
  world.jira.add("AW-2", "Fix", { status: "In Review" });
  world.thread({ title: "AW-2: Fix" });
  world.pullRequest({ title: "feat(AW-2): fix", headRefName: "feat/AW-2-fix", checks: RED });

  const tick = await world.tick();

  expect(world.sends().length).toBe(1);
  expect(world.starts()).toEqual([]);
  expect(tick.lines[0]).toMatch(/^AW-2 /);
  expect(tick.stdout).toContain("AW-1 skip: wait, 1 of 1 places taken");
});

test("a fix message and a start in one tick go in that order", async () => {
  world.jira.add("AW-1", "Ready", { priority: "Highest" });
  world.jira.add("AW-2", "Fix", { status: "In Review" });
  world.thread({ title: "AW-2: Fix" });
  world.pullRequest({ title: "feat(AW-2): fix", headRefName: "feat/AW-2-fix", checks: RED });

  await world.tick();

  const verbs = world.t3Calls().map((args) => args[3]).filter((verb) => verb === "send" || verb === "start");
  expect(verbs).toEqual(["send", "start"]);
});

test.each([
  ["a fix", () => world.pullRequest({ title: "feat(AW-1): fix", headRefName: BRANCH, checks: RED })],
  ["a continue", () => {}],
])("%s that would pass the limit waits for a later tick, with no comment", async (_name, seed) => {
  world.config("limit = 1");
  world.jira.add("AW-1", "Build", { status: "In Review" });
  world.thread({ title: "AW-1: Build" });
  seed();
  world.jira.add("AW-2", "Busy", { status: "In Progress" });
  world.thread({ title: "AW-2: Busy", running: true });

  const tick = await world.tick();

  expect(world.sends()).toEqual([]);
  expect(comments()).toEqual([]);
  expect(world.pullRequests().flatMap((pr) => pr.comments)).toEqual([]);
  expect(tick.stdout).toContain("AW-1 skip: wait, 1 of 1 places taken");

  // The turn ends, and the place is free.
  world.stopThreads();
  world.jira.issues.delete("AW-2");
  await world.tick();
  expect(world.sends().length).toBe(1);
});

// Jira status.

test.each([
  ["green", { checks: GREEN }, "In Progress"],
  ["red", { checks: RED }, "In Progress"],
  ["red", { checks: RED }, "To Do"],
] as const)("an open pull request that is %s moves the ticket to In Review", async (_name, values, from) => {
  world.jira.add("AW-1", "Build", { status: from });
  world.thread({ title: "AW-1: Build" });
  world.pullRequest({ title: "feat(AW-1): build", headRefName: BRANCH, ...values });

  await world.tick();

  expect(status()).toBe("In Review");
});

test("a stopped thread with no pull request moves the ticket to In Progress", async () => {
  world.jira.add("AW-1", "Build");
  world.thread({ title: "AW-1: Build" });
  await world.tick();
  expect(status()).toBe("In Progress");
});

test.each([
  ["with a thread", true],
  ["built by hand, with no thread", false],
])("a merged pull request %s sets Done", async (_name, thread) => {
  world.jira.add("AW-1", "Build", { status: "In Review" });
  if (thread) world.thread({ title: "AW-1: Build" });
  world.pullRequest({ title: "feat(AW-1): build", headRefName: BRANCH, state: "MERGED" });

  const tick = await world.tick();

  expect(status()).toBe("Done");
  expect(tick.lines).toEqual(["AW-1 status Done: the pull request merged"]);
  expect(world.slack.posts).toEqual([]);
  const before = writes();
  await world.tick();
  expect(writes()).toEqual(before);
});

test("a merged pull request on a Flagged ticket still sets Done", async () => {
  world.jira.add("AW-1", "Build", { status: "In Review", flagged: true });
  world.pullRequest({ title: "feat(AW-1): build", headRefName: BRANCH, state: "MERGED" });
  await world.tick();
  expect(status()).toBe("Done");
});

// Determinism.

test("a dry run plans each new step and writes nothing", async () => {
  world.jira.add("AW-1", "Fix", { status: "In Review" });
  world.thread({ title: "AW-1: Fix" });
  world.pullRequest({ title: "feat(AW-1): fix", headRefName: "feat/AW-1-fix", checks: RED });
  world.jira.add("AW-2", "Question", { status: "In Progress" });
  world.thread({ title: "AW-2: Question", waiting: true });
  world.jira.add("AW-3", "Green", { status: "In Progress" });
  world.pullRequest({ title: "feat(AW-3): green", headRefName: "feat/AW-3-green", checks: GREEN });

  const tick = await world.dryRun();

  expect(tick.code).toBe(0);
  expect(tick.lines.every((line) => line.startsWith("dry-run "))).toBe(true);
  for (const part of ["AW-1 send", "AW-1 pr-comment", "AW-2 notify", "AW-2 flag", "AW-3 auto-merge"]) expect(tick.stdout).toContain(part);
  expect(world.jira.writes).toEqual([]);
  expect(world.ghWrites()).toEqual([]);
  expect(world.sends()).toEqual([]);
  expect(world.slack.posts).toEqual([]);
  expect((await world.dryRun()).stdout).toBe(tick.stdout);
});
