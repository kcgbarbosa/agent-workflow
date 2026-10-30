import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EPIC, World } from "./world.ts";

const UNIT = `loop-demo-${EPIC}.service`;
const WATCH_UNIT = "loop-watch-8790.service";

let world: World;
let other: string;

beforeEach(async () => {
  world = await World.create();
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  world.verdicts({ "DEMO-2": "pass" });
  // KC's own edit, which is not committed.
  writeFileSync(join(world.checkout, "config", "settings.json"), '{"theme": "dark"}\n');
  other = join(world.root, "elsewhere");
  world.git(world.root, "clone", "--quiet", world.checkoutOrigin, other);
});

afterEach(async () => {
  await world.close();
});

function runs(unit: string): string[][] {
  return world.systemd().filter((call) => call.tool === "systemd-run" && call.args.includes(`--unit=${unit}`)).map((call) => call.args);
}

test("loop start runs the loop as a systemd unit and returns, and the unit builds the Epic", async () => {
  const ran = await world.loop("start", EPIC);

  expect(ran.code, ran.stderr).toBe(0);
  expect(ran.stdout).toMatch(new RegExp(`The loop is building ${EPIC}\\. Watch it at http://[\\d.]+:8790/#/demo/${EPIC}, or with \`journalctl --user -fu ${UNIT}\`\\.`));
  const [args] = runs(UNIT);
  expect(args).toEqual(expect.arrayContaining(["--user", "--collect", "--service-type=exec", "--property=KillMode=mixed", `--working-directory=${world.repo}`]));
  expect(args!.some((arg) => arg.startsWith("--setenv=PATH="))).toBe(true);
  expect(args!.some((arg) => arg.startsWith("--setenv=BW_SESSION"))).toBe(false);
  expect(args!.slice(-4)).toEqual(["run", EPIC, "--repo", world.repo]);

  const output = await world.untilUnitEnds(UNIT);
  expect(world.prs().map((pr) => pr.state), output).toEqual(["MERGED"]);
  // The run holds off sleep while it lasts.
  expect(world.systemd().some((call) => call.tool === "systemd-inhibit" && call.args.includes("--what=sleep:idle"))).toBe(true);
});

test("loop start takes the new commits when a tracked file has a change they do not touch", async () => {
  world.commitTo(other, { "loop/run.ts": "two\n" }, "feat: a new loop");

  const ran = await world.loop("start", EPIC);

  expect(ran.code, ran.stderr).toBe(0);
  expect(ran.stdout).toContain("The loop took 1 new commit from origin.");
  expect(readFileSync(join(world.checkout, "loop", "run.ts"), "utf8")).toBe("two\n");
  expect(readFileSync(join(world.checkout, "config", "settings.json"), "utf8")).toBe('{"theme": "dark"}\n');
  await world.untilUnitEnds(UNIT);
  expect(world.prs().map((pr) => pr.state)).toEqual(["MERGED"]);
});

test("loop start refuses with git's message when the new commits touch the changed file", async () => {
  world.commitTo(other, { "config/settings.json": '{"theme": "light"}\n' }, "chore: a new setting");

  const ran = await world.loop("start", EPIC);

  expect(ran.code).toBe(2);
  expect(ran.stderr).toContain("config/settings.json");
  expect(ran.stderr).toMatch(/would be overwritten by merge/);
  expect(readFileSync(join(world.checkout, "config", "settings.json"), "utf8")).toBe('{"theme": "dark"}\n');
  expect(world.systemd()).toEqual([]);
});

test("loop start on a current checkout runs as it is", async () => {
  const ran = await world.loop("start", EPIC);

  expect(ran.code, ran.stderr).toBe(0);
  expect(ran.stdout).toContain("The loop is current.");
  await world.untilUnitEnds(UNIT);
});

test("a second loop start while a run is active is refused with the unit's name", async () => {
  world.plan({ "DEMO-2": [{ meet: "DEMO-9" }] });
  expect((await world.loop("start", EPIC)).code).toBe(0);

  const again = await world.loop("start", EPIC);

  expect(again.code).toBe(2);
  expect(again.stderr).toContain(`A run is active: ${UNIT}. \`loop stop ${EPIC}\` stops it.`);
  expect(runs(UNIT)).toHaveLength(1);
  expect((await world.loop("stop", EPIC)).code).toBe(0);
});

test("loop stop ends the run with a stopped line, and the next start goes on with the same ticket", async () => {
  world.plan({ "DEMO-2": [{ meet: "DEMO-9" }] });
  expect((await world.loop("start", EPIC)).code).toBe(0);
  await world.until(() => world.steps().includes("DEMO-2 build started"), "the build to start");

  const stopped = await world.loop("stop", EPIC);

  expect(stopped.code, stopped.stderr).toBe(0);
  expect(stopped.stdout).toContain(`The loop stopped ${EPIC}. \`loop start ${EPIC}\` goes on with the same tickets.`);
  expect(world.unitAlive(UNIT)).toBe(false);
  expect(world.steps().filter((step) => step.startsWith(`${EPIC} stop`))).toEqual([`${EPIC} stop stopped`]);

  world.plan({});
  expect((await world.loop("start", EPIC)).code).toBe(0);
  await world.untilUnitEnds(UNIT);
  expect(world.steps().filter((step) => step.startsWith("DEMO-2 start"))).toEqual(["DEMO-2 start new", "DEMO-2 start restart"]);
  expect(world.prs().map((pr) => pr.state)).toEqual(["MERGED"]);
});

test("loop stop with no active run says so", async () => {
  const ran = await world.loop("stop", EPIC);

  expect(ran.code).toBe(1);
  expect(ran.stderr).toContain(`No run of ${EPIC} is active.`);
});

test("a failed run does not block the next start of the same Epic", async () => {
  world.jira.add("DEMO-3", "Add the logout page", { parent: EPIC });
  world.verdicts({ "DEMO-2": "pass", "DEMO-3": "pass" });
  world.plan({ "DEMO-2": [{ status: "blocked", reason: "It needs KC." }] });
  expect((await world.loop("start", EPIC)).code).toBe(0);
  await world.untilUnitEnds(UNIT);

  const again = await world.loop("start", EPIC);

  expect(again.code, again.stderr).toBe(0);
  await world.untilUnitEnds(UNIT);
});

test("the watch page keeps running across a loop update, which restarts it on the new code", async () => {
  expect((await world.loop("start", EPIC)).code).toBe(0);
  await world.untilUnitEnds(UNIT);
  world.commitTo(other, { "loop/run.ts": "two\n" }, "feat: a new loop");

  expect((await world.loop("start", EPIC)).code).toBe(0);
  await world.untilUnitEnds(UNIT);

  const [args, ...more] = runs(WATCH_UNIT);
  expect(more).toEqual([]);
  expect(args).toEqual(expect.arrayContaining(["--property=Restart=always"]));
  expect(args!.slice(-3)).toEqual(["watch", "--repo", world.repo]);
  expect(world.unitAlive(WATCH_UNIT)).toBe(true);
  const restarts = world.systemd().filter((call) => call.tool === "systemctl" && call.args[0] === "restart");
  expect(restarts.map((call) => call.args)).toEqual([["restart", WATCH_UNIT]]);
});

test("loop start refuses a host with no secrets file", async () => {
  execFileSync("rm", [join(world.state, "secrets.json")]);

  const ran = await world.loop("start", EPIC);

  expect(ran.code).toBe(2);
  expect(ran.stderr).toContain("This host has no secrets file. Run `export BW_SESSION=$(bw unlock --raw)`, then `loop secrets`.");
  expect(runs(UNIT)).toEqual([]);
});

test("the scenario suite runs with no network", async () => {
  const ran = await world.loop("start", EPIC);
  expect(ran.code, ran.stderr).toBe(0);
  await world.untilUnitEnds(UNIT);
  expect(existsSync(join(world.fakes, "network.jsonl"))).toBe(false);

  // The guard is live: a Node process of the scenario that reaches out is refused and recorded.
  const script = "fetch('https://example.com').then(() => process.exit(0), () => process.exit(3))";
  expect(() => execFileSync("node", ["-e", script], { env: world.env, stdio: "ignore" })).toThrow();
  expect(readFileSync(join(world.fakes, "network.jsonl"), "utf8")).toContain("example.com");
});
