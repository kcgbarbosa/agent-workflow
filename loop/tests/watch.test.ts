// What KC sees of a run from the phone: the watch page, the cost report, and the forecast, all read from the
// decisions log, so they work with no network.
import { execFileSync } from "node:child_process";
import { existsSync, utimesSync, writeFileSync } from "node:fs";
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
  world.bws({ JIRA_EMAIL: "kc@example.com", JIRA_API_TOKEN: secret, NTFY_TOPIC: "topic" });
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

test("a real run's wait lines carry each check's link, and the page gives it", async () => {
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  world.verdicts({ "DEMO-2": ["fail", "pass"] });
  world.plan({ "DEMO-2": [{ write: { "login.txt": "login\n" } }, { write: { "login.txt": "fixed\n" }, commit: "fix(DEMO-2): fix the login" }] });
  const ran = await world.loop("run", EPIC);
  expect(ran.code, ran.stderr).toBe(0);

  watching = await world.watch();
  const { body: view } = await watching.get(`/api/epic/${EPIC}?project=demo`);

  const waits = world.decisions().filter((line) => line.step === "wait");
  for (const wait of waits) {
    for (const check of wait.checks as { link?: string }[]) expect(check.link).toMatch(/^https:\/\/github\.com\/kcgbarbosa\/demo\/actions\/runs\//);
  }
  const ticket = view.tickets.find((item: { key: string }) => item.key === "DEMO-2");
  expect(ticket.pr.checks).toEqual(waits.at(-1)!.checks);
  expect(ticket.pr.checks[0]).toMatchObject({ name: "gate / check", bucket: "pass", link: expect.stringContaining("/actions/runs/") });
});

test("a log with checks that have no link shows them with none", async () => {
  world.record(redThenFixed(deadPid()).slice(0, 8));
  watching = await world.watch();

  const { body: view } = await watching.get(`/api/epic/${EPIC}?project=demo`);

  expect(view.tickets[0].pr.checks).toEqual([
    { name: "gate / check", bucket: "fail" },
    { name: "gate / review", bucket: "pass" },
  ]);
});

test("a held pull request's result is held", async () => {
  world.record([
    ...redThenFixed(process.pid).slice(0, 7),
    { ticket: "DEMO-2", step: "wait", result: "held", pr: PR, checks: [{ name: "hold", bucket: "fail" }], detail: "The hold label is on. The loop waits until it is not." },
  ]);
  watching = await world.watch();

  const { body: view } = await watching.get(`/api/epic/${EPIC}?project=demo`);

  expect(view.tickets[0].pr.result).toBe("held");
});

test("a ticket whose auto-merge failed carries its reason, and merges", async () => {
  world.noAutoMerge();
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  world.verdicts({ "DEMO-2": "pass" });
  const ran = await world.loop("run", EPIC);
  expect(ran.code, ran.stderr).toBe(0);

  watching = await world.watch();
  const { body: view } = await watching.get(`/api/epic/${EPIC}?project=demo`);

  const [ticket] = view.tickets;
  expect(ticket.column).toBe("merged");
  expect(ticket.auto_merge).toContain("Auto-merge is not allowed");
});

test("a ticket with auto-merge on has no auto-merge reason", async () => {
  world.record([
    ...redThenFixed(process.pid).slice(0, 7),
    { ticket: "DEMO-2", step: "auto-merge", result: "fail", pr: PR, detail: "Auto-merge is off: no." },
    { ticket: "DEMO-2", step: "pr", result: "open", pr: PR, auto_merge: true },
  ]);
  watching = await world.watch();

  const { body: view } = await watching.get(`/api/epic/${EPIC}?project=demo`);

  expect(view.tickets[0].auto_merge).toBeNull();
});

test("a real run's passing build line carries the agent's reason, and the outcome gives it with the decisions", async () => {
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  world.verdicts({ "DEMO-2": "pass" });
  world.plan({ "DEMO-2": [{ write: { "login.txt": "login\n" }, reason: "Added the login page.", decisions: ["Email login only.", "No remember-me box."] }] });
  const ran = await world.loop("run", EPIC);
  expect(ran.code, ran.stderr).toBe(0);

  watching = await world.watch();
  const { body: view } = await watching.get(`/api/epic/${EPIC}?project=demo`);

  expect(world.decisions().find((line) => line.step === "build" && line.result === "pass")!.detail).toBe("Added the login page.");
  expect(view.tickets[0].outcome).toEqual({ result: "pass", reason: "Added the login page.", decisions: ["Email login only.", "No remember-me box."] });
});

test("a blocked ticket's outcome gives the agent's reason", async () => {
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  world.plan({ "DEMO-2": [{ status: "blocked", reason: "The spec leaves the login provider open." }] });
  await world.loop("run", EPIC);

  watching = await world.watch();
  const { body: view } = await watching.get(`/api/epic/${EPIC}?project=demo`);

  expect(view.tickets[0].outcome).toEqual({ result: "blocked", reason: "The spec leaves the login provider open.", decisions: [] });
});

test("a ticket with no finished build has no outcome", async () => {
  world.record([...redThenFixed(process.pid).slice(0, 4)]);
  watching = await world.watch();

  const { body: view } = await watching.get(`/api/epic/${EPIC}?project=demo`);

  expect(view.tickets.map((ticket: { outcome: unknown }) => ticket.outcome)).toEqual([null, null]);
});

test("the steps list holds retarget and worktree lines, and a failed one is a warning", async () => {
  const worktree = `${world.state}/${EPIC}/worktrees/DEMO-2`;
  world.record([
    ...redThenFixed(deadPid()).slice(0, 7),
    { ticket: "DEMO-2", step: "merge", result: "merged", pr: PR },
    { ticket: "DEMO-3", step: "retarget", result: "ok", pr: `${PR}0`, detail: "feat/DEMO-2-add-the-login-page merged, so it targets main." },
    { ticket: "DEMO-4", step: "retarget", result: "fail", pr: `${PR}1`, detail: "GraphQL: Base branch was modified." },
    { ticket: "DEMO-2", step: "worktree", result: "removed", detail: worktree },
    { ticket: "DEMO-2", step: "worktree", result: "fail", detail: "fatal: cannot remove a locked working tree" },
  ]);
  watching = await world.watch();

  const { body: view } = await watching.get(`/api/epic/${EPIC}?project=demo`);

  const steps = view.events
    .filter((event: { step: string }) => event.step === "retarget" || event.step === "worktree")
    .map(({ ticket, step, result, detail, warning }: Record<string, unknown>) => ({ ticket, step, result, detail, warning }));
  expect(steps).toEqual([
    { ticket: "DEMO-3", step: "retarget", result: "ok", detail: "feat/DEMO-2-add-the-login-page merged, so it targets main.", warning: undefined },
    { ticket: "DEMO-4", step: "retarget", result: "fail", detail: "GraphQL: Base branch was modified.", warning: true },
    { ticket: "DEMO-2", step: "worktree", result: "removed", detail: "worktrees/DEMO-2", warning: undefined },
    { ticket: "DEMO-2", step: "worktree", result: "fail", detail: "fatal: cannot remove a locked working tree", warning: true },
  ]);
});

/** A ticket's lines up to its open pull request, with no wait yet. */
function opened(key: string, pr: string): object[] {
  return [
    { ticket: key, step: "start", result: "new", detail: `feat/${key}`, slot: 0 },
    { ticket: key, step: "build", result: "started", attempt: 1 },
    { ticket: key, step: "build", result: "pass", commit: `${key}-1` },
    { ticket: key, step: "push", result: "ok", commit: `${key}-1` },
    { ticket: key, step: "pr", result: "open", commit: `${key}-1`, pr },
  ];
}

const HOLD = "The hold label is on. The loop waits until it is not.";

/** A killed run with one ticket of each needs-KC kind: held, stuck with no pull request, timed out, and not merged. */
function eachKind(): object[] {
  return [
    { ticket: EPIC, step: "start", result: "ok", pid: deadPid() },
    FRONTIER,
    ...opened("DEMO-2", `${PR}2`),
    { ticket: "DEMO-2", step: "wait", result: "held", pr: `${PR}2`, checks: [{ name: "hold", bucket: "fail" }], detail: HOLD },
    { ticket: "DEMO-3", step: "start", result: "new", detail: "feat/DEMO-3", slot: 1 },
    { ticket: "DEMO-3", step: "build", result: "started", attempt: 1 },
    { ticket: "DEMO-3", step: "build", result: "blocked", detail: "The spec does not say which page." },
    { ticket: "DEMO-3", step: "stuck", result: "started", detail: "The agent is blocked: the spec does not say which page." },
    ...opened("DEMO-4", `${PR}4`),
    { ticket: "DEMO-4", step: "wait", result: "timeout", pr: `${PR}4`, checks: [], detail: "The checks ran past 60 min." },
    ...opened("DEMO-5", `${PR}5`),
    { ticket: "DEMO-5", step: "wait", result: "green", pr: `${PR}5`, checks: [{ name: "gate / check", bucket: "pass" }] },
    { ticket: "DEMO-5", step: "merge", result: "fail", pr: `${PR}5`, detail: "The pull request did not merge." },
  ];
}

test("a log with one ticket of each kind gives the needs-KC rows in order, each with its reason and its link", async () => {
  world.record(eachKind());
  watching = await world.watch();

  const { body: view } = await watching.get(`/api/epic/${EPIC}?project=demo`);

  expect(view.needs_kc).toEqual([
    { kind: "stopped", ticket: EPIC, reason: "killed", pr: null },
    { kind: "held", ticket: "DEMO-2", reason: HOLD, pr: `${PR}2` },
    { kind: "stuck", ticket: "DEMO-3", reason: "The agent is blocked: the spec does not say which page.", pr: null },
    { kind: "timeout", ticket: "DEMO-4", reason: "The checks ran past 60 min.", pr: `${PR}4` },
    { kind: "merge", ticket: "DEMO-5", reason: "The pull request did not merge.", pr: `${PR}5` },
  ]);
});

test("a run with nothing to act on gives an empty needs-KC list", async () => {
  world.record([...redThenFixed(process.pid), { ticket: "DEMO-3", step: "start", result: "new", detail: "feat/DEMO-3", slot: 1 }]);
  watching = await world.watch();

  const { body: view } = await watching.get(`/api/epic/${EPIC}?project=demo`);

  expect(view.state).toBe("running");
  expect(view.needs_kc).toEqual([]);
});

test("a held pull request released by a later wait leaves the list, and a merged one leaves it", async () => {
  const held = { ticket: "DEMO-2", step: "wait", result: "held", pr: `${PR}2`, checks: [{ name: "hold", bucket: "fail" }], detail: HOLD };
  world.record([
    { ticket: EPIC, step: "start", result: "ok", pid: process.pid },
    FRONTIER,
    ...opened("DEMO-2", `${PR}2`),
    held,
    { ticket: "DEMO-2", step: "wait", result: "red", pr: `${PR}2`, checks: [{ name: "gate / check", bucket: "fail" }], detail: "Failed: gate / check" },
    ...opened("DEMO-3", `${PR}3`),
    { ...held, ticket: "DEMO-3", pr: `${PR}3` },
    { ticket: "DEMO-3", step: "merge", result: "merged", commit: "m3", pr: `${PR}3` },
  ]);
  watching = await world.watch();

  const { body: view } = await watching.get(`/api/epic/${EPIC}?project=demo`);

  expect(view.needs_kc).toEqual([]);
});

test("the home view counts the needs-KC rows of each run", async () => {
  world.record(eachKind());
  world.record([...redThenFixed(process.pid)].map((line) => ({ ...line, ...((line as { ticket: string }).ticket === EPIC ? { ticket: "DEMO-10" } : {}) })), "DEMO-10");
  watching = await world.watch();

  const { body: home } = await watching.get("/api/home");

  const counts = Object.fromEntries(home[0].runs.map((run: { key: string; needs_kc: number }) => [run.key, run.needs_kc]));
  expect(counts).toEqual({ [EPIC]: 5, "DEMO-10": 0 });
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

/** One run of an Epic that merges one ticket at the given share of the 5-hour window, or merges none. */
function shareRun(epic: string, ticket: string, share: number | null): object[] {
  return [
    { ticket: epic, step: "start", result: "ok", pid: 1 },
    ...(share === null
      ? [{ ticket, step: "stuck", result: "ok", detail: "Still red." }]
      : [
          { ticket, step: "start", result: "new", detail: `feat/${ticket}-work`, slot: 0 },
          { ticket, step: "agent", result: "done", session: ticket, plan: { five_hour: { start: 0, end: share / 100, resets_at: 1 } } },
          { ticket, step: "merge", result: "merged", pr: `${PR}${ticket}` },
        ]),
    { ticket: epic, step: "finish", result: "ok" },
  ];
}

/** Two runs of another Epic of the project, the day before, at 100% and 12% per merged ticket. */
function otherEpic(): void {
  const day = Date.parse("2026-10-19T10:00:00Z");
  const lines = [...shareRun("DEMO-20", "DEMO-21", 100), ...shareRun("DEMO-20", "DEMO-22", 12)];
  const at = (index: number) => new Date(day + index * 60_000).toISOString().replace(/\.\d+Z$/, "+00:00");
  world.record(lines.map((line, index) => ({ ...line, time: at(index) })), "DEMO-20");
}

/** Five earlier runs of the Epic, the last with no share, then this run at the given share. With the other Epic's,
 * the median of the last 5 earlier runs with a share is 4. Counting the run with none as zero gives 3, and taking
 * all six gives 7.
 */
function epicRuns(current: number): object[] {
  return [2, 3, 4, 10, null, current].flatMap((share, index) => shareRun(EPIC, `DEMO-${30 + index}`, share));
}

test("the typical share is the median of the project's last 5 earlier runs that have one", async () => {
  otherEpic();
  world.record(epicRuns(6));
  watching = await world.watch();

  const { body: view } = await watching.get(`/api/epic/${EPIC}?project=demo`);
  const { body: other } = await watching.get(`/api/epic/DEMO-20?project=demo`);

  expect(view.plan).toMatchObject({ per_merged: { five_hour: 6 }, typical: 4, warn: false });
  expect(other.plan).toMatchObject({ per_merged: { five_hour: 12 }, typical: 100, warn: false });
});

test("a run above 1.5 times the typical share is marked warn", async () => {
  otherEpic();
  world.record(epicRuns(6.1));
  watching = await world.watch();

  const { body: view } = await watching.get(`/api/epic/${EPIC}?project=demo`);

  expect(view.plan).toMatchObject({ per_merged: { five_hour: 6.1 }, typical: 4, warn: true });
});

test("a project with no earlier figure has no typical share", async () => {
  world.record([...shareRun(EPIC, "DEMO-30", null), ...shareRun(EPIC, "DEMO-31", 5)]);
  watching = await world.watch();

  const { body: view } = await watching.get(`/api/epic/${EPIC}?project=demo`);

  expect(view.plan).toMatchObject({ per_merged: { five_hour: 5 }, typical: null, warn: false });
});

const SECRET = "a-long-jira-token-value";
// The steps the log leaves out: the plan meter and the loop's bookkeeping.
const LEFT_OUT = ["meter", "tracker-status", "frontier", "notify", "agent"];

/** The lines, one minute apart from the start. */
function from(start: string, lines: object[]): object[] {
  return lines.map((line, index) => ({ time: new Date(Date.parse(start) + index * 60_000).toISOString().replace(/\.\d+Z$/, "+00:00"), ...line }));
}

/** A frontier line of the run's Epic and its tickets. */
function frontier(epic: string, summary: string, keys: string[]): object {
  return { ticket: epic, step: "frontier", result: "ok", summary, tickets: keys.map((key) => ({ key, summary: `Work on ${key}`, status: "To Do", state: "ready", blockers: [] })) };
}

/** A ticket's lines from its start to its merge. */
function mergedTicket(key: string): object[] {
  return [...opened(key, `${PR}${key}`), { ticket: key, step: "wait", result: "green", pr: `${PR}${key}`, checks: [] }, { ticket: key, step: "merge", result: "merged", pr: `${PR}${key}` }];
}

/** A host of four projects: demo runs two tickets in different steps, beta's running run has a held pull
 * request, gamma's newest run completed after an older blocked one, and delta has no runs. The logs hold more
 * than 50 work lines, the lines the log leaves out, and one line whose detail holds a secret.
 */
function fourProjects(): void {
  world.bws({ JIRA_EMAIL: "kc@example.com", JIRA_API_TOKEN: SECRET, NTFY_TOPIC: "topic" });
  world.record(from("2026-10-31T09:00:00Z", [
    { ticket: EPIC, step: "start", result: "ok", pid: process.pid },
    frontier(EPIC, "The Loop", ["DEMO-2", "DEMO-3"]),
    { ticket: EPIC, step: "tracker-status", result: "ok", detail: "In Progress" },
    ...opened("DEMO-2", `${PR}2`),
    { ticket: "DEMO-2", step: "agent", result: "done", session: "s1" },
    { ticket: "DEMO-2", step: "meter", result: "read", meter: { five_hour: { utilization: 0.4, resets_at: 1 } } },
    { ticket: "DEMO-3", step: "start", result: "new", detail: "feat/DEMO-3", slot: 1 },
    { ticket: "DEMO-3", step: "build", result: "started", attempt: 1 },
  ]));
  world.record(from("2026-10-31T09:30:00Z", [
    { ticket: "BETA-1", step: "start", result: "ok", pid: process.pid },
    frontier("BETA-1", "The Beta", ["BETA-2"]),
    { ticket: "BETA-2", step: "start", result: "new", detail: "feat/BETA-2", slot: 0 },
    { ticket: "BETA-2", step: "build", result: "started", attempt: 1 },
    { ticket: "BETA-2", step: "build", result: "pass", commit: "b1", detail: `Built with token ${SECRET}` },
    { ticket: "BETA-2", step: "push", result: "ok", commit: "b1" },
    { ticket: "BETA-2", step: "pr", result: "open", commit: "b1", pr: `${PR}b` },
    { ticket: "BETA-2", step: "wait", result: "held", pr: `${PR}b`, checks: [{ name: "hold", bucket: "fail" }], detail: HOLD },
    { ticket: "BETA-2", step: "notify", result: "ok", detail: "Held." },
  ]), "BETA-1", "beta");
  const gamma = world.project("gamma");
  world.record(from("2026-10-30T08:00:00Z", [
    { ticket: "GAMMA-1", step: "start", result: "ok", pid: 1 },
    frontier("GAMMA-1", "The Gamma", ["GAMMA-2"]),
    { ticket: "GAMMA-2", step: "start", result: "new", detail: "feat/GAMMA-2", slot: 0 },
    ...Array.from({ length: 40 }, (_, attempt) => ({ ticket: "GAMMA-2", step: "build", result: "started", attempt })),
    { ticket: "GAMMA-2", step: "build", result: "blocked", detail: "The spec does not say which page." },
    { ticket: "GAMMA-2", step: "stuck", result: "ok", detail: "The agent is blocked." },
    { ticket: "GAMMA-1", step: "finish", result: "ok" },
  ]), "GAMMA-1", "gamma");
  world.record(from("2026-10-31T07:00:00Z", [
    { ticket: "GAMMA-5", step: "start", result: "ok", pid: 1 },
    frontier("GAMMA-5", "The Gamma, again", ["GAMMA-6"]),
    ...mergedTicket("GAMMA-6"),
    { ticket: "GAMMA-5", step: "finish", result: "ok" },
  ]), "GAMMA-5", "gamma");
  const older = new Date("2026-10-30T09:00:00Z");
  utimesSync(join(gamma, "GAMMA-1", "decisions.jsonl"), older, older);
  world.project("delta");
}

type HomeProject = { name: string; state: string; current: string | null; [field: string]: unknown };

async function homeOf(name: string): Promise<HomeProject> {
  const { body } = await watching!.get("/api/home");
  return body.find((project: HomeProject) => project.name === name);
}

test("the home view gives each project of the host, including one with no runs", async () => {
  fourProjects();
  watching = await world.watch();

  const { body: home } = await watching.get("/api/home");

  expect(home.map((project: HomeProject) => project.name).sort()).toEqual(["beta", "delta", "demo", "gamma"]);
  expect(home.find((project: HomeProject) => project.name === "delta")).toEqual({
    name: "delta", runs: [], state: "idle", current: null, needs_kc: [], working: [], progress: null, epic: null, last: null,
  });
});

test("a running run's project is running, with each ticket's step and when it began, and the Epic's progress", async () => {
  fourProjects();
  watching = await world.watch();

  const demo = await homeOf("demo");

  expect(demo).toMatchObject({
    state: "running",
    current: EPIC,
    needs_kc: [],
    working: [
      { key: "DEMO-2", step: "wait", since: "2026-10-31T09:07:00+00:00" },
      { key: "DEMO-3", step: "build", since: "2026-10-31T09:11:00+00:00" },
    ],
    progress: { complete: 0, total: 2 },
    epic: { key: EPIC, summary: "The Loop" },
    last: null,
  });
  expect(demo.runs).toEqual([expect.objectContaining({ key: EPIC, running: true, needs_kc: 0 })]);
});

test("a project whose running run has a held pull request is needs KC, with the row, its reason and its link", async () => {
  fourProjects();
  watching = await world.watch();

  const beta = await homeOf("beta");

  expect(beta).toMatchObject({ state: "needs_kc", current: "BETA-1", needs_kc: [{ kind: "held", ticket: "BETA-2", reason: HOLD, pr: `${PR}b` }] });
});

test("a paused run's project is running", async () => {
  const resumes = new Date(Date.now() + 3_600_000).toISOString();
  world.record([
    { ticket: EPIC, step: "start", result: "ok", pid: process.pid },
    FRONTIER,
    { ticket: "DEMO-2", step: "start", result: "new", detail: "feat/DEMO-2", slot: 0 },
    { ticket: "DEMO-2", step: "build", result: "started", attempt: 1 },
    { ticket: "DEMO-2", step: "agent", result: "usage-pause", detail: "The 5-hour window is full." },
    { ticket: EPIC, step: "usage-pause", result: "ok", resumes },
  ]);
  watching = await world.watch();

  const demo = await homeOf("demo");

  expect(demo.runs).toEqual([expect.objectContaining({ status: "paused" })]);
  expect(demo).toMatchObject({ state: "running", current: EPIC, last: null });
});

test("a completed project is idle with its last run's key, status and time, and an older blocked run is not counted", async () => {
  fourProjects();
  watching = await world.watch();

  const gamma = await homeOf("gamma");

  expect(gamma).toMatchObject({
    state: "idle",
    current: "GAMMA-5",
    needs_kc: [],
    working: [],
    progress: { complete: 1, total: 1 },
    epic: { key: "GAMMA-5", summary: "The Gamma, again" },
    last: { key: "GAMMA-5", status: "completed", at: "2026-10-31T07:09:00+00:00" },
  });
  expect((gamma.runs as { key: string; status: string }[]).map((run) => [run.key, run.status])).toEqual([["GAMMA-5", "completed"], ["GAMMA-1", "blocked"]]);
});

test("the current run is the running one, else the newest", async () => {
  world.record(from("2026-10-31T09:00:00Z", redThenFixed(process.pid)));
  world.record(from("2026-10-31T10:00:00Z", [{ ticket: "DEMO-10", step: "start", result: "ok", pid: deadPid() }, { ticket: "DEMO-10", step: "finish", result: "ok" }]), "DEMO-10");
  const older = new Date("2026-10-31T09:30:00Z");
  utimesSync(join(world.state, EPIC, "decisions.jsonl"), older, older);
  world.record(from("2026-10-30T09:00:00Z", [{ ticket: "SIDE-1", step: "start", result: "ok", pid: 1 }, { ticket: "SIDE-1", step: "finish", result: "ok" }]), "SIDE-1", "side");
  world.record(from("2026-10-31T09:00:00Z", [{ ticket: "SIDE-2", step: "start", result: "ok", pid: 1 }, { ticket: "SIDE-2", step: "stop", result: "killed" }]), "SIDE-2", "side");
  utimesSync(join(world.project("side"), "SIDE-1", "decisions.jsonl"), older, older);
  watching = await world.watch();

  expect((await homeOf("demo")).current).toBe(EPIC);
  expect((await homeOf("side")).current).toBe("SIDE-2");
});

type LogLine = { time: string; project: string; epic: string; ticket: string; step: string; result: string; detail: string; pr?: string };

test("the log merges every project's lines newest first, at most 50", async () => {
  fourProjects();
  watching = await world.watch();

  const { body: log } = await watching.get("/api/log");

  expect(log).toHaveLength(50);
  const times = log.map((line: LogLine) => Date.parse(line.time));
  expect(times).toEqual([...times].sort((a, b) => b - a));
  expect(log[0]).toMatchObject({ project: "beta", time: "2026-10-31T09:37:00+00:00", step: "wait", result: "held" });
  expect(new Set(log.map((line: LogLine) => line.project))).toEqual(new Set(["demo", "beta", "gamma"]));
});

test("the log leaves out meter, tracker-status, frontier, notify and agent lines", async () => {
  fourProjects();
  watching = await world.watch();

  const { body: log } = await watching.get("/api/log?project=demo");

  expect(log.map((line: LogLine) => `${line.ticket} ${line.step} ${line.result}`)).toEqual([
    "DEMO-3 build started",
    "DEMO-3 start new",
    "DEMO-2 pr open",
    "DEMO-2 push ok",
    "DEMO-2 build pass",
    "DEMO-2 build started",
    "DEMO-2 start new",
    `${EPIC} start ok`,
  ]);
  const { body: all } = await watching.get("/api/log");
  expect(all.filter((line: LogLine) => LEFT_OUT.includes(line.step))).toEqual([]);
});

test("the log filtered to one project holds only its lines", async () => {
  fourProjects();
  watching = await world.watch();

  const { body: gamma } = await watching.get("/api/log?project=gamma");
  const missingProject = await watching.get("/api/log?project=nowhere");

  expect(gamma).toHaveLength(50);
  expect(new Set(gamma.map((line: LogLine) => line.project))).toEqual(new Set(["gamma"]));
  expect(gamma[0]).toMatchObject({ epic: "GAMMA-5", step: "finish" });
  expect(missingProject.status).toBe(404);
});

test("each log line carries its time, project, Epic, ticket, step, result and link, with each secret masked", async () => {
  fourProjects();
  watching = await world.watch();

  const { body: log } = await watching.get("/api/log?project=beta");

  expect(log[0]).toEqual({ time: "2026-10-31T09:37:00+00:00", project: "beta", epic: "BETA-1", ticket: "BETA-2", step: "wait", result: "held", detail: HOLD, pr: `${PR}b` });
  expect(log.find((line: LogLine) => line.step === "build" && line.result === "started")).not.toHaveProperty("pr");
  expect(JSON.stringify(log)).not.toContain(SECRET);
  expect(log.find((line: LogLine) => line.step === "build" && line.result === "pass").detail).toBe("Built with token [JIRA_API_TOKEN]");
});

test("the epic, usage, report and forecast routes answer as before", async () => {
  world.writeConfig('[watch]\nplans = [{ plan = "max-5x", since = 2026-10-01T00:00:00Z }]\n');
  world.jira.filters.set("project in (DEMO) AND issuetype = Epic AND statusCategory != Done ORDER BY key ASC", [EPIC]);
  world.jira.filters.set(`parent in (${EPIC}) ORDER BY key ASC`, []);
  fourProjects();
  watching = await world.watch();

  const epic = await watching.get("/api/epic/BETA-1?project=beta");
  const usage = await watching.get("/api/usage");
  const report = await watching.get("/api/report/GAMMA-5?project=gamma");
  const forecast = await watching.get("/api/forecast");

  expect(epic.body).toMatchObject({ key: "BETA-1", status: "running", needs_kc: [{ kind: "held", ticket: "BETA-2" }] });
  expect(usage.body.five_hour).toMatchObject({ utilization: 0.4, resets_at: 1 });
  expect(report.body.rows.find((item: { label: string }) => item.label === "Tickets merged")).toMatchObject({ current: 1 });
  expect(forecast.body.plan).toMatchObject({ key: "max-5x" });
});
