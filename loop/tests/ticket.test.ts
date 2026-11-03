// `loop ticket <KEY>` builds one ticket to merge as its own unit, and the worker it starts, `loop run-ticket`.
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { World } from "./world.ts";

const KEY = "DEMO-2";
const UNIT = `loop-demo-${KEY}.service`;
const RUN = `tickets/${KEY}`;

let world: World;
let home: string;

beforeEach(async () => {
  world = await World.create();
  home = join(world.state, RUN);
});

afterEach(async () => {
  await world.close();
});

function unitArgs(unit: string): string[][] {
  return world.systemd().filter((call) => call.tool === "systemd-run" && call.args.includes(`--unit=${unit}`)).map((call) => call.args);
}

/** The worker run by hand, as its unit runs it, in slot 2. */
function work(key = KEY) {
  return world.loop("run-ticket", key, "--slot", "2");
}

test("loop ticket starts the ticket's unit, which builds it to merge in its own folder, and a second start refuses", async () => {
  world.jira.add(KEY, "Add the login page");
  world.jira.add("DEMO-3", "Add the logout page");

  const ran = await world.loop("ticket", KEY);

  expect(ran.code, ran.stderr).toBe(0);
  expect(ran.stdout).toContain(`The loop is building ${KEY} in slot 2.`);
  const [args] = unitArgs(UNIT);
  expect(args!.slice(-4, -1)).toEqual(["bws", "run", "--"]);
  expect(args!.at(-1)).toMatch(new RegExp(`^exec '[^']*/bin/loop' 'run-ticket' '${KEY}' '--slot' '2' '--repo' '[^']*/demo'$`));
  // The worker waits on its checks, so it is still building.
  await world.until(() => world.prs().length === 1, "the pull request");

  const again = await world.loop("ticket", KEY);
  expect(again.code).toBe(2);
  expect(again.stderr.trim()).toBe(`${KEY} is building in ${UNIT}. \`loop stop ${KEY}\` stops it.`);
  // With `parallel = 1`, the one slot is taken.
  const full = await world.loop("ticket", "DEMO-3");
  expect(full.code).toBe(2);
  expect(full.stderr.trim().split("\n")).toHaveLength(1);
  expect(full.stderr).toContain("No slot is free");
  expect(unitArgs(UNIT)).toHaveLength(1);

  world.setCheck(KEY, "pass");
  const output = await world.untilUnitEnds(UNIT);
  const [pr] = world.prs();
  expect(pr, output).toMatchObject({ headRefName: "feat/DEMO-2-add-the-login-page", baseRefName: "main", state: "MERGED" });
  expect(world.jira.issues.get(KEY)!.status).toBe("Done");
  const lines = world.decisions(RUN);
  expect(new Set(lines.map((line) => line.epic))).toEqual(new Set([KEY]));
  expect(world.steps(RUN)).toContain(`${KEY} merge merged`);
  expect(world.steps(RUN).at(-2)).toBe(`${KEY} finish ok`);
  const [call] = world.calls();
  expect(call!.cwd).toBe(join(home, "worktree"));
  expect(call!.prompt).toBe(`/implement ${join(home, "ticket.md")}`);
  expect(existsSync(join(home, "pr-body.md"))).toBe(true);
  expect(existsSync(join(home, "agent-1.jsonl"))).toBe(true);
  // A merged ticket's worktree goes, and the slot is free again.
  expect(existsSync(join(home, "worktree"))).toBe(false);
  expect(existsSync(join(world.state, "slots", "2"))).toBe(false);
});

test("loop ticket refuses a Flagged ticket, one of another component, and one with no component, with one line each", async () => {
  world.jira.add("DEMO-2", "Flagged", { flagged: true });
  world.jira.add("DEMO-3", "Of the shop", { components: ["shop"] });
  world.jira.add("DEMO-4", "Of no repo", { components: [] });

  const refusals: string[] = [];
  for (const key of ["DEMO-2", "DEMO-3", "DEMO-4"]) {
    const ran = await world.loop("ticket", key);
    expect(ran.code).toBe(2);
    expect(ran.stderr.trim().split("\n")).toHaveLength(1);
    refusals.push(ran.stderr.trim());
  }

  expect(refusals[0]).toBe("DEMO-2 is Flagged. Unflag it in Jira, and `loop ticket DEMO-2` builds it.");
  expect(refusals[1]).toBe("DEMO-3 is of the component shop, not demo, so this repo's loop does not build it.");
  expect(refusals[2]).toMatch(/^DEMO-4 has no component\./);
  expect(world.systemd().filter((call) => call.tool === "systemd-run" && !call.args.some((arg) => arg.includes("loop-watch")))).toEqual([]);
  expect(existsSync(join(world.state, "slots", "2"))).toBe(false);
});

test("a failed build flags the ticket with its reason, and nothing starts it until it is unflagged", async () => {
  world.jira.add(KEY, "Add the login page");
  world.plan({ [KEY]: [{ status: "blocked", reason: "The spec names no login provider." }, { write: { "a.txt": "a\n" }, commit: "feat(DEMO-2): a" }] });
  world.verdicts({ [KEY]: "pass" });

  const ran = await work();

  expect(ran.code).toBe(1);
  const issue = world.jira.issues.get(KEY)!;
  expect(issue.flagged).toBe(true);
  const [comment] = issue.comments;
  expect(comment!.split("\n")[0]).toBe("Stuck: build blocked");
  expect(comment).toContain("The spec names no login provider.");
  expect(world.jira.notifications).toContain(`${KEY} stuck`);
  expect(world.steps(RUN)).toContain(`${KEY} stuck ok`);
  expect(world.steps(RUN).at(-1)).toBe(`${KEY} finish stuck`);
  const refused = await world.loop("ticket", KEY);
  expect(refused.code).toBe(2);
  expect(refused.stderr).toContain(`${KEY} is Flagged.`);

  issue.flagged = false;
  const again = await world.loop("ticket", KEY);
  expect(again.code, again.stderr).toBe(0);
  await world.untilUnitEnds(UNIT);
  expect(world.prs().map((pr) => pr.state)).toEqual(["MERGED"]);
  expect(world.steps(RUN)).toContain(`${KEY} start restart`);
});

test("a stuck comment gives the fingerprint first, then the reason, the pull request, and the log path", async () => {
  world.jira.add(KEY, "Add the login page");
  world.writeConfig("[limits]\nfix_attempts = 1\n");
  world.verdicts({ [KEY]: "fail" });
  world.plan({ [KEY]: [{ write: { "a.txt": "a\n" }, commit: "feat(DEMO-2): a" }, { write: { "a.txt": "b\n" }, commit: "fix(DEMO-2): b" }] });

  const ran = await work();

  expect(ran.code).toBe(1);
  const [pr] = world.prs();
  const [comment] = world.jira.issues.get(KEY)!.comments;
  expect(comment!.split("\n")).toEqual([
    "Stuck: wait red",
    "The gate stayed red after 1 fix attempts. Failed: gate / check",
    `The pull request is ${pr!.url}.`,
    `The log is ${join(home, "decisions.jsonl")} on ${hostname()}.`,
  ]);
  expect(pr!.state).toBe("OPEN");
});

test("a worker that throws logs stop loop-error and flags the ticket", async () => {
  world.jira.add(KEY, "Add the login page");
  world.git(world.repo, "remote", "set-url", "origin", join(world.root, "gone.git"));

  const ran = await work();

  expect(ran.code).toBe(1);
  expect(world.steps(RUN)).toContain(`${KEY} stop loop-error`);
  const issue = world.jira.issues.get(KEY)!;
  expect(issue.flagged).toBe(true);
  expect(issue.comments[0]!.split("\n")[0]).toBe("Stuck: stop loop-error");
  expect(existsSync(join(world.state, "slots", "2"))).toBe(false);
});

test("an unflagged ticket with an open pull request starts again at the wait, with no build", async () => {
  world.jira.add(KEY, "Add the login page");
  world.writeConfig("[limits]\nfix_attempts = 1\n");
  world.verdicts({ [KEY]: "fail" });
  world.plan({ [KEY]: [{ write: { "a.txt": "a\n" }, commit: "feat(DEMO-2): a" }, { write: { "a.txt": "b\n" }, commit: "fix(DEMO-2): b" }] });
  await work();
  const issue = world.jira.issues.get(KEY)!;
  expect(issue.flagged).toBe(true);
  const calls = world.calls().length;

  issue.flagged = false;
  world.setCheck(KEY, "pass");
  const ran = await work();

  expect(ran.code, ran.stderr).toBe(0);
  expect(world.calls()).toHaveLength(calls);
  const steps = world.steps(RUN);
  const restart = steps.lastIndexOf(`${KEY} start restart`);
  expect(steps.slice(restart)).toEqual(expect.arrayContaining([`${KEY} build skipped`, `${KEY} wait green`, `${KEY} merge merged`]));
  expect(steps.slice(restart)).not.toContain(`${KEY} build started`);
  expect(world.prs().map((pr) => pr.state)).toEqual(["MERGED"]);
});

test("a pull request that conflicts with main gets a fix attempt that rebases, and the gate runs again", async () => {
  world.jira.add(KEY, "Add the login page");
  world.verdicts({ [KEY]: ["conflict", "pass"] });
  world.plan({ [KEY]: [{ write: { "a.txt": "a\n" }, commit: "feat(DEMO-2): a" }, { write: { "a.txt": "rebased\n" }, commit: "fix(DEMO-2): rebase" }] });

  const ran = await work();

  expect(ran.code, ran.stderr).toBe(0);
  const red = world.decisions(RUN).find((line) => line.step === "wait" && line.result === "red");
  expect(red?.detail).toBe("It conflicts with main.");
  const [, fix] = world.calls();
  expect(fix!.prompt).toContain("conflicts with main. Rebase the branch on origin/main");
  expect(world.steps(RUN).filter((step) => step === `${KEY} push ok`)).toHaveLength(2);
  expect(world.prs().map((pr) => pr.state)).toEqual(["MERGED"]);
});

test("a Bug's ticket.md carries the reproduce-first line, and its branch is fix/", async () => {
  world.jira.add(KEY, "The login page throws", { issueType: "Bug" });
  world.verdicts({ [KEY]: "pass" });

  const ran = await work();

  expect(ran.code, ran.stderr).toBe(0);
  const ticket = readFileSync(join(home, "ticket.md"), "utf8");
  expect(ticket).toContain('- This is a Bug, so reproduce it first: write the acceptance test of the first "What the user sees" line, and see it fail twice on the stack before you fix it.');
  const [pr] = world.prs();
  expect(pr).toMatchObject({ headRefName: "fix/DEMO-2-the-login-page-throws", title: "fix(DEMO-2): The login page throws" });
});

test("the watch page's log and ticket detail show a ticket from tickets/<KEY>/", async () => {
  world.jira.add(KEY, "Add the login page");
  world.verdicts({ [KEY]: "pass" });
  await work();

  const watching = await world.watch();
  try {
    const log = (await watching.get("/api/log?project=demo")).body as { epic: string; ticket: string; step: string; result: string }[];
    expect(log.some((entry) => entry.epic === KEY && entry.step === "merge" && entry.result === "merged")).toBe(true);
    const view = (await watching.get(`/api/epic/${KEY}?project=demo`)).body as {
      key: string;
      summary: string;
      tickets: { key: string; column: string; files: string[]; agents: { number: number }[] }[];
    };
    expect(view.key).toBe(KEY);
    expect(view.summary).toBe("Add the login page");
    expect(view.tickets).toHaveLength(1);
    expect(view.tickets[0]).toMatchObject({ key: KEY, column: "merged", agents: [{ number: 1 }] });
    expect(view.tickets[0]!.files).toEqual(expect.arrayContaining(["pr-body.md", "ticket.md"]));
    expect(view.tickets[0]!.files.filter((file) => file.startsWith("worktree") || file === "decisions.jsonl")).toEqual([]);
    const file = await watching.get(`/files/${KEY}/ticket.md?project=demo`);
    expect(file.status).toBe(200);
    expect(file.body).toContain(`# ${KEY}: Add the login page`);
    expect((await watching.get(`/files/${KEY}/decisions.jsonl?project=demo`)).status).toBe(404);
    expect((await watching.get(`/api/agent/${KEY}/${KEY}/1?project=demo`)).status).toBe(200);
  } finally {
    await watching.close();
  }
});
