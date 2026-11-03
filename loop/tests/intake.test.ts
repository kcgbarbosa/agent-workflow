// What a day's work leaves behind: a Slack notification, a report per ticket and per day, and the daily `correct` run.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { World } from "./world.ts";

const KEY = "DEMO-2";
const CORRECT = "loop-demo-correct.service";
const PR = "https://github.com/kcgbarbosa/demo/pull";

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.close();
});

function unitArgs(unit: string): string[][] {
  return world.systemd().filter((call) => call.tool === "systemd-run" && call.args.includes(`--unit=${unit}`)).map((call) => call.args);
}

/** The time of a line, this many hours from now. */
function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString().replace(/\.\d+Z$/, "+00:00");
}

test("with [notify] kind = slack, a stuck ticket posts its text to the webhook in the secret, and nothing to ntfy", async () => {
  world.bws({ JIRA_EMAIL: "kc@example.com", JIRA_API_TOKEN: "token", NTFY_TOPIC: "topic", SLACK_WEBHOOK_URL: `${world.jira.url}/slack/demo` });
  world.writeConfig('kind = "slack"\n');
  world.jira.add(KEY, "Add the login page");
  world.plan({ [KEY]: [{ status: "blocked", reason: "The spec names no provider." }] });

  const ran = await world.loop("run-ticket", KEY, "--slot", "2");

  expect(ran.code, ran.stderr).toBe(1);
  expect(world.jira.slack).toEqual([{ path: "/slack/demo", body: { text: `${KEY} stuck` } }]);
  expect(world.jira.notifications).toEqual([]);
});

test("a webhook secret that is no URL fails the post, and its value stays out of the log", async () => {
  world.bws({ JIRA_EMAIL: "kc@example.com", JIRA_API_TOKEN: "token", NTFY_TOPIC: "topic", SLACK_WEBHOOK_URL: "not-a-url-hunter2" });
  world.writeConfig('kind = "slack"\n');
  world.jira.add(KEY, "Add the login page");
  world.plan({ [KEY]: [{ status: "blocked", reason: "No." }] });

  await world.loop("run-ticket", KEY, "--slot", "2");

  expect(world.steps(`tickets/${KEY}`)).toContain(`${KEY} notify fail`);
  expect(JSON.stringify(world.decisions(`tickets/${KEY}`))).not.toContain("hunter2");
  expect(JSON.stringify(world.decisions(`tickets/${KEY}`))).toContain("the value of SLACK_WEBHOOK_URL is not a URL");
});

test("[notify] secret names each repo's own webhook, a start refuses a store without it, and slack needs no ntfy topic", async () => {
  world.writeConfig('kind = "slack"\nsecret = "DEMO_HOOK"\n');
  const config = join(world.repo, "loop.toml");
  writeFileSync(config, readFileSync(config, "utf8").replace(/^secrets = .*$/m, 'secrets = ["JIRA_EMAIL", "JIRA_API_TOKEN"]'));
  world.bws({ JIRA_EMAIL: "kc@example.com", JIRA_API_TOKEN: "token" });

  const refused = await world.loop("start");
  expect(refused.code).toBe(2);
  expect(refused.stderr).toContain("DEMO_HOOK");
  expect(refused.stderr).not.toContain("NTFY_TOPIC");

  world.bws({ JIRA_EMAIL: "kc@example.com", JIRA_API_TOKEN: "token", DEMO_HOOK: `${world.jira.url}/slack/own` });
  world.jira.add(KEY, "Add the login page");
  world.plan({ [KEY]: [{ status: "blocked", reason: "No." }] });
  await world.loop("run-ticket", KEY, "--slot", "2");
  expect(world.jira.slack).toEqual([{ path: "/slack/own", body: { text: `${KEY} stuck` } }]);
});

test("a ticket with no component refuses a run with the repo's component alone", async () => {
  world.jira.add(KEY, "Of no repo", { components: [] });

  const ran = await world.loop("run", KEY);

  expect(ran.stderr).toContain(`${KEY} has no component. Set the Jira component of each to demo, the repo it changes.`);
  expect(ran.stderr).not.toContain("manual");
  expect(world.jira.notifications.join()).not.toContain("manual");
});

test("loop report <KEY> reads one ticket's log, by model, subagent, turns, and peak context", async () => {
  world.jira.add(KEY, "Add the login page");
  world.verdicts({ [KEY]: "pass" });
  await world.loop("run-ticket", KEY, "--slot", "2");

  const ran = await world.loop("report", KEY, "--json");

  expect(ran.code, ran.stderr).toBe(0);
  const { current } = JSON.parse(ran.stdout);
  expect(current.epic).toBe(KEY);
  expect(current.merged).toBe(1);
  expect(current.cost).toBeGreaterThan(0);
  expect(current.turns).toBeGreaterThan(0);
  expect(Object.keys(current.models).length).toBeGreaterThan(0);
  expect(current.subagents).toBeTypeOf("object");
  const plain = await world.loop("report", KEY);
  expect(plain.stdout).toContain(`The run of ${KEY}`);
  expect((await world.loop("report", "DEMO-9")).stderr).toContain("This host has no run of DEMO-9.");

  world.record(
    [
      { ticket: "DEMO-8", step: "start", result: "ok", pid: 1, run: true },
      { ticket: "DEMO-8", step: "agent", result: "done", session: "s", usage: { total_cost_usd: 2, num_turns: 7, duration_ms: 1000, peak_context: 90_000, models: {}, subagents: { runner: 2 } } },
      { ticket: "DEMO-8", step: "finish", result: "ok", run: true },
    ],
    "tickets/DEMO-8",
  );
  const { current: peak } = JSON.parse((await world.loop("report", "DEMO-8", "--json")).stdout);
  expect(peak.head.peak_context_per_ticket).toBe(90_000);
  expect(peak.turns).toBe(7);
});

test("loop report lists the tickets merged today, and the day's share of each window once, however many workers moved it", async () => {
  const worker = (key: string, n: number, start: number, end: number, hours: number) =>
    world.record(
      [
        { ticket: key, step: "start", result: "ok", pid: 1, run: true, time: hoursAgo(hours) },
        { ticket: key, step: "agent", result: "done", cost: 1.5, time: hoursAgo(hours), plan: { five_hour: { start, end, resets_at: 2_000_000_000 } } },
        { ticket: key, step: "merge", result: "merged", pr: `${PR}/${n}`, time: hoursAgo(hours) },
        { ticket: key, step: "finish", result: "ok", run: true, time: hoursAgo(hours) },
      ],
      `tickets/${key}`,
    );
  worker("DEMO-5", 5, 0.1, 0.2, 0);
  worker("DEMO-6", 6, 0.15, 0.25, 0);
  worker("DEMO-7", 7, 0.5, 0.6, 24 * 3);

  const ran = await world.loop("report", "--json");

  expect(ran.code, ran.stderr).toBe(0);
  const day = JSON.parse(ran.stdout);
  expect(day.merged).toEqual([
    { key: "DEMO-5", pr: `${PR}/5`, cost: 1.5 },
    { key: "DEMO-6", pr: `${PR}/6`, cost: 1.5 },
  ]);
  expect(day.plan_share).toEqual({ five_hour: 15 });
  const plain = await world.loop("report");
  expect(plain.stdout).toContain("DEMO-5");
  expect(plain.stdout).not.toContain("DEMO-7");
  expect(plain.stdout).toContain("15.0%");
});

test("with no ticket merged, loop report says so", async () => {
  const ran = await world.loop("report");

  expect(ran.code).toBe(0);
  expect(ran.stdout).toContain("No ticket merged on");
  expect(ran.stdout).toContain("No agent read the plan meter today.");
});

/** The dispatcher with `[correct]` on, from hour 0, so the hour has come. */
async function dispatching(extra = ""): Promise<void> {
  world.writeConfig(`\n[correct]\nenabled = true\nhour = 0\n${extra}`);
  const ran = await world.loop("start");
  expect(ran.code, ran.stderr).toBe(0);
}

test("the dispatcher starts loop correct at the hour, once a day, also over a restart", async () => {
  world.plan({ correct: [{}] });

  await dispatching();

  await world.until(() => world.steps("").includes("dispatch correct started"), "the correct start");
  const [args] = unitArgs(CORRECT);
  expect(args!.at(-1)).toMatch(/^exec '[^']*\/bin\/loop' 'run-correct' '--slot' '2' '--repo' '[^']*\/demo'$/);
  await world.until(() => !world.unitAlive(CORRECT), "the correct unit's end");
  const searches = () => world.jira.requests.filter((request) => request === "POST /rest/api/3/search/jql").length;
  const seen = searches();
  await world.until(() => searches() >= seen + 6, "more polls");
  expect(unitArgs(CORRECT)).toHaveLength(1);

  expect((await world.loop("stop")).code).toBe(0);
  expect((await world.loop("start")).code).toBe(0);
  const again = searches();
  await world.until(() => searches() >= again + 6, "the polls after the restart");
  expect(unitArgs(CORRECT)).toHaveLength(1);
});

test("the dispatcher starts no loop correct when it is off, which is the default, or before the hour", async () => {
  const now = new Date().getHours();
  world.writeConfig(now < 23 ? `\n[correct]\nenabled = true\nhour = ${now + 1}\n` : "");
  expect((await world.loop("start")).code).toBe(0);

  const searches = () => world.jira.requests.filter((request) => request === "POST /rest/api/3/search/jql").length;
  await world.until(() => searches() >= 6, "some polls");
  expect(unitArgs(CORRECT)).toEqual([]);
});

test("loop correct waits for a free slot, and holds it from the next ticket", async () => {
  world.jira.add(KEY, "Add the login page");
  world.jira.add("DEMO-3", "Add the logout page");
  world.plan({ correct: [{ meet: "NOBODY" }] });

  await dispatching();

  await world.until(() => world.prs().length === 1, "the first ticket's pull request");
  expect(unitArgs(CORRECT)).toEqual([]);
  world.setCheck(KEY, "pass");
  await world.until(() => world.prs().some((pr) => pr.headRefName.includes("DEMO-3")), "the second ticket's pull request");
  expect(unitArgs(CORRECT)).toEqual([]);
  world.setCheck("DEMO-3", "pass");

  await world.until(() => unitArgs(CORRECT).length === 1, "the correct start");
  expect((await world.loop("stop")).code).toBe(0);
  expect(world.unitAlive(CORRECT)).toBe(false);
});

test("loop stop ends the correct unit, and a second start by hand refuses", async () => {
  world.plan({ correct: [{ meet: "NOBODY" }] });

  const ran = await world.loop("correct");
  expect(ran.code, ran.stderr).toBe(0);
  expect(ran.stdout).toContain(CORRECT);
  await world.until(() => existsSync(join(world.fakes, "running-correct")), "the agent");

  const again = await world.loop("correct");
  expect(again.code).toBe(2);
  expect(again.stderr).toContain(`is running in ${CORRECT}`);

  expect((await world.loop("stop")).code).toBe(0);
  expect(world.unitAlive(CORRECT)).toBe(false);
});

test("loop correct with two classes opens one pull request, with no key, the correct label, and auto-merge on", async () => {
  world.commitTo(world.repo, { "a.txt": "a\n" }, "fix: first thing");
  world.commitTo(world.repo, { "b.txt": "b\n" }, 'Revert "fix: first thing"');
  world.record(
    [
      { ticket: "DEMO-5", step: "build", result: "started", attempt: 2 },
      { ticket: "DEMO-5", step: "wait", result: "red", pr: `${PR}/5`, checks: [{ name: "gate / fuzz", bucket: "fail" }] },
      { ticket: "DEMO-6", step: "wait", result: "red", pr: `${PR}/6`, checks: [{ name: "gate / check", bucket: "fail" }] },
    ],
    "tickets/DEMO-5",
  );
  world.plan({ correct: [{ write: { "lint.txt": "rule\n" }, commit: "fix: make the most frequent class impossible", reason: "Two classes. Fixed the one seen three times; the other waits." }] });

  const ran = await world.loop("run-correct", "--slot", "2");

  expect(ran.code, ran.stderr).toBe(0);
  const prs = world.prs();
  expect(prs).toHaveLength(1);
  const [pr] = prs;
  expect(pr!.title).toBe("chore: make the most frequent class impossible");
  expect(pr!.title).not.toMatch(/[A-Z]+-\d+/);
  expect(pr!.headRefName).toMatch(/^chore\/correct-\d{12}$/);
  expect(pr!.baseRefName).toBe("main");
  expect(pr!.isDraft).toBe(false);
  expect(pr!.labels!.map((label) => label.name).sort()).toEqual(["blast:green", "correct"]);
  expect(pr!.autoMerge).toEqual({ mergeMethod: "SQUASH" });
  const [call] = world.calls();
  expect(call!.prompt).toBe(`/correct ${join(world.state, "correct", "brief.md")}`);
  const brief = readFileSync(join(world.state, "correct", "brief.md"), "utf8");
  expect(brief).toContain("fix: first thing");
  expect(brief).toMatch(/## Reverts\n\n- \w+ Revert "fix: first thing"/);
  expect(brief).toContain("DEMO-5: fix attempt 2.");
  expect(brief).toContain(`DEMO-5: ${PR}/5`);
  expect(brief).not.toContain(`${PR}/6`);
  // The slot and the worktree are free for the next run.
  expect(existsSync(join(world.state, "slots", "2"))).toBe(false);
  expect(existsSync(join(world.state, "correct", "worktree"))).toBe(false);
});

test("loop correct reads only since the newest merged correct pull request, and opens none while one is open", async () => {
  world.commitTo(world.repo, { "a.txt": "a\n" }, "fix: before the last correction");
  const since = world.git(world.repo, "rev-parse", "HEAD");
  world.commitTo(world.repo, { "b.txt": "b\n" }, "fix: after the last correction");
  world.mergedCorrect(since);
  world.plan({ correct: [{}, { write: { "second.txt": "2\n" }, commit: "chore: second" }] });

  const none = await world.loop("run-correct", "--slot", "2");

  expect(none.code, none.stderr).toBe(0);
  const brief = readFileSync(join(world.state, "correct", "brief.md"), "utf8");
  expect(brief).toContain("fix: after the last correction");
  expect(brief).not.toContain("fix: before the last correction");
  expect(world.prs().filter((pr) => pr.state === "OPEN")).toEqual([]);
  expect(world.steps("correct")).toContain("correct finish none");

  expect((await world.loop("run-correct", "--slot", "2")).code).toBe(0);
  expect(world.prs().filter((pr) => pr.state === "OPEN")).toHaveLength(1);
  world.plan({ correct: [{ write: { "third.txt": "3\n" }, commit: "chore: third" }] });
  expect((await world.loop("run-correct", "--slot", "2")).code).toBe(0);
  expect(world.prs().filter((pr) => pr.state === "OPEN")).toHaveLength(1);
  expect(world.steps("correct")).toContain("correct finish skipped");
});

test("a correct pull request under a red glob opens as a draft with no auto-merge", async () => {
  world.writeConfig('\n[blast]\nred = ["lint/**"]\n');
  world.plan({ correct: [{ write: { "lint/rule.txt": "rule\n" }, commit: "chore: a rule" }] });

  expect((await world.loop("run-correct", "--slot", "2")).code).toBe(0);

  const [pr] = world.prs();
  expect(pr!.isDraft).toBe(true);
  expect(pr!.autoMerge).toBeNull();
  expect(pr!.labels!.map((label) => label.name).sort()).toEqual(["blast:red", "correct"]);
});
