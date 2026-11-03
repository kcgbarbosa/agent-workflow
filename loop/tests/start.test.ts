import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EPIC, World } from "./world.ts";

const UNIT = "loop-demo-dispatch.service";
const WORKER = "loop-demo-DEMO-2.service";
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

test("loop start runs the dispatcher as a systemd unit and returns, and the dispatcher builds the ready ticket", async () => {
  const ran = await world.loop("start");

  expect(ran.code, ran.stderr).toBe(0);
  expect(ran.stdout).toMatch(new RegExp(`The loop is building the queue of demo\\. Watch it at http://[\\d.]+:8790/#/demo, or with \`journalctl --user -fu ${UNIT}\`\\.`));
  const [args] = runs(UNIT);
  expect(args).toEqual(
    expect.arrayContaining([
      "--user",
      "--collect",
      "--service-type=exec",
      "--property=KillMode=control-group",
      `--property=EnvironmentFile=${world.tokenFile}`,
      `--working-directory=${world.repo}`,
    ]),
  );
  expect(args!.some((arg) => arg.startsWith("--setenv=PATH="))).toBe(true);
  expect(args!.some((arg) => arg.includes("BWS_ACCESS_TOKEN"))).toBe(false);
  expect(args!.slice(-4, -1)).toEqual(["bws", "run", "--"]);
  expect(args!.at(-1)).toMatch(/^exec '[^']*\/bin\/loop' 'dispatch' '--repo' '[^']*\/demo'$/);

  await world.until(() => world.prs().some((pr) => pr.state === "MERGED"), "the merge");
  const output = await world.untilUnitEnds(WORKER);
  expect(world.prs().map((pr) => pr.state), output).toEqual(["MERGED"]);
  // The worker holds off sleep while it lasts.
  expect(world.systemd().some((call) => call.tool === "systemd-inhibit" && call.args.includes("--what=sleep:idle"))).toBe(true);
});

test("loop start takes the new commits when a tracked file has a change they do not touch", async () => {
  world.commitTo(other, { "loop/run.ts": "two\n" }, "feat: a new loop");

  const ran = await world.loop("start");

  expect(ran.code, ran.stderr).toBe(0);
  expect(ran.stdout).toContain("The loop took 1 new commit from origin.");
  expect(readFileSync(join(world.checkout, "loop", "run.ts"), "utf8")).toBe("two\n");
  expect(readFileSync(join(world.checkout, "config", "settings.json"), "utf8")).toBe('{"theme": "dark"}\n');
  await world.until(() => world.prs().some((pr) => pr.state === "MERGED"), "the merge");
});

test("loop start refuses with git's message when the new commits touch the changed file", async () => {
  world.commitTo(other, { "config/settings.json": '{"theme": "light"}\n' }, "chore: a new setting");

  const ran = await world.loop("start");

  expect(ran.code).toBe(2);
  expect(ran.stderr).toContain("config/settings.json");
  expect(ran.stderr).toMatch(/would be overwritten by merge/);
  expect(readFileSync(join(world.checkout, "config", "settings.json"), "utf8")).toBe('{"theme": "dark"}\n');
  expect(world.systemd()).toEqual([]);
});

test("loop start on a current checkout runs as it is", async () => {
  const ran = await world.loop("start");

  expect(ran.code, ran.stderr).toBe(0);
  expect(ran.stdout).toContain("The loop is current.");
  expect(world.unitAlive(UNIT)).toBe(true);
});

test("a second loop start while the dispatcher is active is refused with the unit's name", async () => {
  expect((await world.loop("start")).code).toBe(0);

  const again = await world.loop("start");

  expect(again.code).toBe(2);
  expect(again.stderr).toContain(`The dispatcher is active: ${UNIT}. \`loop stop\` stops it.`);
  expect(runs(UNIT)).toHaveLength(1);
});

test("loop stop with no active unit says so", async () => {
  const ran = await world.loop("stop");

  expect(ran.code).toBe(1);
  expect(ran.stderr).toContain("No unit of the demo loop is active.");
  const one = await world.loop("stop", "DEMO-2");
  expect(one.code).toBe(1);
  expect(one.stderr).toContain("No worker of DEMO-2 is active.");
});

test("loop start <KEY> and loop start --filter print that the command is gone", async () => {
  for (const args of [["start", EPIC], ["start", "--filter", "project = DEMO"], ["stop", "--filter", "project = DEMO"]]) {
    const ran = await world.loop(...args);

    expect(ran.code).toBe(2);
    expect(ran.stderr.trim().split("\n")).toHaveLength(1);
    expect(ran.stderr).toMatch(/ (is|are) gone\./);
  }
  expect(runs(UNIT)).toEqual([]);
});

test("an old loop.toml key warns and the file loads", async () => {
  world.writeConfig("", 'gates = ["make check"]');

  const ran = await world.loop("start");

  expect(ran.code, ran.stderr).toBe(0);
  expect(ran.stderr).toContain("loop.toml: [gates] is no longer read, because the merge gate runs the checks on the pull request. The loop ignores it.");
  expect(world.unitAlive(UNIT)).toBe(true);
});

test("the watch page keeps running across a loop update, which restarts it on the new code", async () => {
  expect((await world.loop("start")).code).toBe(0);
  expect((await world.loop("stop")).code).toBe(0);
  world.commitTo(other, { "loop/run.ts": "two\n" }, "feat: a new loop");

  expect((await world.loop("start")).code).toBe(0);

  const [args, ...more] = runs(WATCH_UNIT);
  expect(more).toEqual([]);
  expect(args).toEqual(expect.arrayContaining(["--property=Restart=always"]));
  expect(args!.slice(-4, -1)).toEqual(["bws", "run", "--"]);
  expect(args!.at(-1)).toMatch(new RegExp(`/bin/loop' 'watch' '--repo' '${world.repo}'$`));
  expect(world.unitAlive(WATCH_UNIT)).toBe(true);
  const restarts = world.systemd().filter((call) => call.tool === "systemctl" && call.args[0] === "restart");
  expect(restarts.map((call) => call.args)).toEqual([["restart", WATCH_UNIT]]);
});

test("loop start refuses with one line when the token file is missing", async () => {
  rmSync(world.tokenFile);

  const ran = await world.loop("start");

  expect(ran.code).toBe(2);
  expect(ran.stderr).toBe(`This host has no Secrets Manager token file, ${world.tokenFile}. \`/setup-loop\` sets it up.\n`);
  expect(runs(UNIT)).toEqual([]);
});

test("loop start refuses with one line naming a secret that Secrets Manager lacks", async () => {
  world.commitTo(world.repo, { "loop.toml": readFileSync(join(world.repo, "loop.toml"), "utf8").replace('"NTFY_TOPIC"]', '"NTFY_TOPIC", "CLAUDE_CODE_OAUTH_TOKEN"]') }, "chore: the loop account");
  world.bws({ JIRA_EMAIL: "kc@example.com", JIRA_API_TOKEN: "token", NTFY_TOPIC: "topic" });

  const ran = await world.loop("start");

  expect(ran.code).toBe(2);
  expect(ran.stderr).toBe("Secrets Manager has no secret CLAUDE_CODE_OAUTH_TOKEN. `/setup-loop` sets it up.\n");
  expect(runs(UNIT)).toEqual([]);
});

test("the scenario suite runs with no network", async () => {
  const ran = await world.loop("start");
  expect(ran.code, ran.stderr).toBe(0);
  await world.until(() => world.prs().some((pr) => pr.state === "MERGED"), "the merge");
  expect(existsSync(join(world.fakes, "network.jsonl"))).toBe(false);

  // The guard is live: a Node process of the scenario that reaches out is refused and recorded.
  const script = "fetch('https://example.com').then(() => process.exit(0), () => process.exit(3))";
  expect(() => execFileSync("node", ["-e", script], { env: world.env, stdio: "ignore" })).toThrow();
  expect(readFileSync(join(world.fakes, "network.jsonl"), "utf8")).toContain("example.com");
});
