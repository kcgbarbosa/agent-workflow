// What KC sees of a run from the phone: the watch page, the cost report, and the forecast, all read from the
// decisions log, so they work with no network.
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EPIC, type Watching, World } from "./world.ts";

let world: World;
let watching: Watching | null;

beforeEach(async () => {
  world = await World.create();
  watching = null;
});

afterEach(async () => {
  await watching?.close();
  await world.close();
});

const PR = "https://github.com/kcgbarbosa/demo/pull/1";
const FRONTIER = {
  ticket: EPIC,
  step: "frontier",
  result: "ok",
  summary: "The Loop",
  tickets: [
    { key: "DEMO-2", summary: "Add the login page", status: "To Do", state: "ready", blockers: [] },
    { key: "DEMO-3", summary: "Add the logout button", status: "To Do", state: "waiting", blockers: ["DEMO-2"] },
  ],
};

/** A run whose DEMO-2 went red, took a fix, and pushed it, so it waits for its checks again. */
function redThenFixed(pid: number): object[] {
  return [
    { ticket: EPIC, step: "start", result: "ok", pid, setup: { agent: "claude-opus-5-5 high" } },
    FRONTIER,
    { ticket: "DEMO-2", step: "start", result: "new", detail: "feat/DEMO-2-add-the-login-page", slot: 0 },
    { ticket: "DEMO-2", step: "build", result: "started", attempt: 1 },
    { ticket: "DEMO-2", step: "build", result: "pass", commit: "a1" },
    { ticket: "DEMO-2", step: "push", result: "ok", commit: "a1" },
    { ticket: "DEMO-2", step: "pr", result: "open", commit: "a1", pr: PR },
    { ticket: "DEMO-2", step: "wait", result: "red", pr: PR, checks: [{ name: "gate / check", bucket: "fail" }, { name: "gate / review", bucket: "pass" }] },
    { ticket: "DEMO-2", step: "build", result: "started", attempt: 2 },
    { ticket: "DEMO-2", step: "build", result: "pass", commit: "a2" },
    { ticket: "DEMO-2", step: "push", result: "ok", commit: "a2" },
  ];
}

function deadPid(): number {
  return Number(execFileSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).trim());
}

test("the watch page shows each ticket's pull request and its checks from the log of a real run", async () => {
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  world.verdicts({ "DEMO-2": ["fail", "pass"] });
  world.plan({ "DEMO-2": [{ write: { "login.txt": "login\n" } }, { write: { "login.txt": "fixed\n" }, commit: "fix(DEMO-2): fix the login" }] });
  const ran = await world.loop("run", EPIC);
  expect(ran.code, ran.stderr).toBe(0);

  watching = await world.watch();
  const { status, body: view } = await watching.get(`/api/epic/${EPIC}?project=demo`);

  expect(status).toBe(200);
  expect(view.summary).toBe("The Loop");
  expect(view.status).toBe("completed");
  const ticket = view.tickets.find((item: { key: string }) => item.key === "DEMO-2");
  const waits = world.decisions().filter((line) => line.step === "wait");
  expect(ticket.column).toBe("merged");
  expect(ticket.red).toBe(1);
  expect(ticket.pr).toEqual({ url: world.prs()[0]!.url, result: "merged", checks: waits.at(-1)!.checks });
  expect(ticket.pr.checks.length).toBeGreaterThan(0);
  const home = await watching.get("/api/home");
  expect(home.body[0].runs[0]).toMatchObject({ key: EPIC, status: "completed", running: false, progress: { complete: 1, total: 1 } });
  expect(existsSync(join(world.fakes, "network.jsonl"))).toBe(false);
});

test("a running ticket that pushed a fix after red checks waits for its checks again", async () => {
  world.record(redThenFixed(process.pid));
  watching = await world.watch();

  const { body: view } = await watching.get(`/api/epic/${EPIC}?project=demo`);

  expect(view.status).toBe("running");
  const [login, logout] = view.tickets;
  expect(login).toMatchObject({ key: "DEMO-2", column: "running", red: 1, step: { name: "wait" } });
  expect(login.pr).toEqual({ url: PR, result: "pending", checks: [] });
  expect(login.health.state).toBe("attention");
  expect(logout).toMatchObject({ key: "DEMO-3", column: "waiting", pr: null });
  expect(view.queue).toEqual([{ key: "DEMO-3", state: "waiting", waits_on: ["DEMO-2"] }]);
});

test("a run whose process is gone shows as stopped, with each ticket in the step it stopped in", async () => {
  world.record(redThenFixed(deadPid()));
  watching = await world.watch();

  const { body: view } = await watching.get(`/api/epic/${EPIC}?project=demo`);

  expect(view.status).toBe("stopped");
  expect(view.stop_reason).toBe("killed");
  expect(view.tickets[0]).toMatchObject({ key: "DEMO-2", column: "stopped", step: { name: "wait" } });
});

test("the page shows the checks of a red pull request, masks each secret, and answers only its own host names", async () => {
  const secret = "a-long-jira-token-value";
  writeFileSync(join(world.state, "secrets.json"), JSON.stringify({ JIRA_EMAIL: "kc@example.com", JIRA_API_TOKEN: secret, NTFY_TOPIC: "topic" }));
  world.record([...redThenFixed(deadPid()).slice(0, 8), { ticket: "DEMO-2", step: "stuck", result: "ok", pr: PR, detail: `Still red, token ${secret}` }]);
  watching = await world.watch();

  const { body: view } = await watching.get(`/api/epic/${EPIC}?project=demo`);

  expect(view.tickets[0].column).toBe("stuck");
  expect(view.tickets[0].pr).toEqual({
    url: PR,
    result: "red",
    checks: [{ name: "gate / check", bucket: "fail" }, { name: "gate / review", bucket: "pass" }],
  });
  expect(JSON.stringify(view)).not.toContain(secret);
  expect(view.tickets[0].stuck_reason).toContain("[JIRA_API_TOKEN]");
  expect((await watching.get("/", "localhost")).status).toBe(200);
  expect((await watching.get("/api/home", "evil.example")).status).toBe(403);
  expect((await watching.get(`/api/agent/${EPIC}/DEMO-2/1?offset=-1&project=demo`)).status).not.toBe(500);
});

/** Two runs of the Epic: the first merges one ticket, the second merges two after a red check. */
function twoRuns(): object[] {
  const agent = (ticket: string, session: string, cost: number, plan: object) => ({
    ticket,
    step: "agent",
    result: "done",
    session,
    cost,
    usage: {
      total_cost_usd: cost,
      num_turns: 10,
      duration_ms: 120_000,
      subagents: { scout: 2 },
      models: { "claude-opus-5-5": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: cost } },
      peak_context: 50_000,
    },
    plan,
  });
  const merged = (ticket: string, ...waits: string[]) => [
    { ticket, step: "start", result: "new", detail: `feat/${ticket}-work`, slot: 0 },
    ...waits.flatMap((result) => [
      { ticket, step: "build", result: "started" },
      { ticket, step: "pr", result: "open", pr: `${PR}${ticket}` },
      { ticket, step: "wait", result, pr: `${PR}${ticket}`, checks: [{ name: "gate / check", bucket: result === "green" ? "pass" : "fail" }] },
    ]),
    { ticket, step: "merge", result: "merged", pr: `${PR}${ticket}` },
  ];
  return [
    { ticket: EPIC, step: "start", result: "ok", pid: 1, setup: { claude: "2.1.301", agent: "claude-opus-5-5 high" } },
    FRONTIER,
    ...merged("DEMO-2", "green"),
    agent("DEMO-2", "s1", 2, { five_hour: { start: 0.1, end: 0.2, resets_at: 1 } }),
    { ticket: "DEMO-3", step: "stuck", result: "ok", detail: "Still red." },
    { ticket: EPIC, step: "finish", result: "ok" },
    { ticket: EPIC, step: "start", result: "ok", pid: 1, setup: { claude: "2.1.301", agent: "claude-opus-5-5 max" } },
    FRONTIER,
    ...merged("DEMO-3", "red", "green"),
    agent("DEMO-3", "s2", 3, { five_hour: { start: 0.2, end: 0.3, resets_at: 1 } }),
    ...merged("DEMO-4", "green"),
    agent("DEMO-4", "s3", 1, { five_hour: { start: 0.25, end: 0.4, resets_at: 1 } }),
    { ticket: "DEMO-4", step: "meter", result: "read", meter: { five_hour: { utilization: 0.45, resets_at: 1 } } },
    { ticket: EPIC, step: "finish", result: "ok" },
  ];
}

test("the cost report breaks the latest run down by the plan meter and compares it with the run before", async () => {
  world.record(twoRuns());

  const ran = await world.loop("report", EPIC, "--json");

  expect(ran.code, ran.stderr).toBe(0);
  const { current, previous, rows } = JSON.parse(ran.stdout);
  expect(current).toMatchObject({ merged: 2, stuck: 0, cost: 4, cost_per_merged: 2, red_checks: 1, plan_used: { five_hour: 20 }, plan_per_merged: { five_hour: 10 } });
  expect(previous).toMatchObject({ merged: 1, stuck: 1, cost: 2, plan_used: { five_hour: 10 } });
  const row = (label: string) => rows.find((item: { label: string }) => item.label === label);
  expect(row("Tickets merged")).toMatchObject({ previous: 1, current: 2, change: 100 });
  expect(row("Red checks")).toMatchObject({ previous: 0, current: 1 });
  expect(row("agent")).toMatchObject({ previous: "claude-opus-5-5 high", current: "claude-opus-5-5 max", change: "changed" });

  const printed = await world.loop("report", EPIC);
  expect(printed.stdout).toContain("list price (API)");
  expect(printed.stdout).toContain("Tickets merged");
});

test("the page serves the report, and the plan meter is the newest reading on the host", async () => {
  world.record(twoRuns());
  watching = await world.watch();

  const report = await watching.get(`/api/report/${EPIC}?project=demo`);
  const usage = await watching.get("/api/usage");

  expect(report.body.rows.find((item: { label: string }) => item.label === "Tickets merged")).toMatchObject({ current: 2 });
  expect(usage.body.five_hour).toMatchObject({ utilization: 0.45, resets_at: 1, past: true });
});

test("a real run logs the plan meter and the usage the report reads", async () => {
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  // The second reading comes before the meter's time is up, so it waits for it and goes out then.
  world.env.LOOP_METER_SECONDS = "0.3";
  world.plan({ "DEMO-2": [{ write: { "login.txt": "login\n" }, meter: { five_hour: [0.1, 0.25] }, pause: 1000 }] });
  world.verdicts({ "DEMO-2": "pass" });
  expect((await world.loop("run", EPIC)).code).toBe(0);

  const ran = await world.loop("report", EPIC, "--json");

  const { current } = JSON.parse(ran.stdout);
  expect(current).toMatchObject({ merged: 1, cost: 0.5, plan_used: { five_hour: 15 }, models: { "claude-opus-5-5": { costUSD: 0.5 } } });
  const meters = world.decisions().filter((line) => line.step === "meter");
  expect(meters.map((line) => (line.meter as { five_hour: { utilization: number } }).five_hour.utilization)).toEqual([0.1, 0.25]);
  expect(current.setup).toEqual({
    claude: "2.1.999",
    agent: "claude-opus-5-5 high",
    tiers: expect.objectContaining({ scout: "claude-haiku-5-5 medium" }),
    review: "the gate's model the gate's effort",
  });
});

test("the forecast reads the merges of each run from the log and the open work from Jira", async () => {
  world.writeConfig('[watch]\nplans = [{ plan = "max-5x", since = 2026-10-01T00:00:00Z }]\n');
  world.jira.add("DEMO-5", "Add the settings page", { parent: EPIC });
  world.jira.filters.set("project in (DEMO) AND issuetype = Epic AND statusCategory != Done ORDER BY key ASC", [EPIC]);
  world.jira.filters.set(`parent in (${EPIC}) ORDER BY key ASC`, ["DEMO-5"]);
  world.record(twoRuns());
  watching = await world.watch();

  const { body: forecast } = await watching.get("/api/forecast");

  expect(forecast.plan).toMatchObject({ key: "max-5x" });
  expect(forecast.periods[0]).toMatchObject({ plan: "max-5x", runs: 2, merged: 3, stuck: 1 });
  expect(forecast.open.epics).toEqual([expect.objectContaining({ key: EPIC, left: 1 })]);
});
