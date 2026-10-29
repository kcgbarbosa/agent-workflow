import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EPIC, World } from "./world.ts";

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

test("loop start takes the new commits when a tracked file has a change they do not touch", async () => {
  world.commitTo(other, { "loop/run.ts": "two\n" }, "feat: a new loop");

  const ran = await world.loop("start", EPIC);

  expect(ran.code, ran.stderr).toBe(0);
  expect(ran.stdout).toContain("The loop took 1 new commit from origin.");
  expect(readFileSync(join(world.checkout, "loop", "run.ts"), "utf8")).toBe("two\n");
  expect(readFileSync(join(world.checkout, "config", "settings.json"), "utf8")).toBe('{"theme": "dark"}\n');
  expect(world.prs().map((pr) => pr.state)).toEqual(["MERGED"]);
});

test("loop start refuses with git's message when the new commits touch the changed file", async () => {
  world.commitTo(other, { "config/settings.json": '{"theme": "light"}\n' }, "chore: a new setting");

  const ran = await world.loop("start", EPIC);

  expect(ran.code).toBe(2);
  expect(ran.stderr).toContain("config/settings.json");
  expect(ran.stderr).toMatch(/would be overwritten by merge/);
  expect(readFileSync(join(world.checkout, "config", "settings.json"), "utf8")).toBe('{"theme": "dark"}\n');
  expect(world.calls()).toEqual([]);
});

test("loop start on a current checkout runs as it is", async () => {
  const ran = await world.loop("start", EPIC);

  expect(ran.code, ran.stderr).toBe(0);
  expect(ran.stdout).toContain("The loop is current.");
});

test("the scenario suite runs with no network", async () => {
  const ran = await world.loop("start", EPIC);
  expect(ran.code, ran.stderr).toBe(0);
  expect(existsSync(join(world.fakes, "network.jsonl"))).toBe(false);

  // The guard is live: a Node process of the scenario that reaches out is refused and recorded.
  const script = "fetch('https://example.com').then(() => process.exit(0), () => process.exit(3))";
  expect(() => execFileSync("node", ["-e", script], { env: world.env, stdio: "ignore" })).toThrow();
  expect(readFileSync(join(world.fakes, "network.jsonl"), "utf8")).toContain("example.com");
});
