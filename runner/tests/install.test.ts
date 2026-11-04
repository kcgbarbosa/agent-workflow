import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { World } from "./world.ts";

let world: World;
let units: string;
let name: string;

beforeEach(async () => {
  world = new World();
  await world.start();
  units = join(world.root, ".config", "systemd", "user");
  name = `runner-${basename(world.repo)}`;
  mkdirSync(join(world.root, ".config", "bws"), { recursive: true });
  writeFileSync(join(world.root, ".config", "bws", "token.env"), "BWS_ACCESS_TOKEN=token\n");
});

afterEach(async () => {
  await world.stop();
});

function unit(suffix: string): string {
  return readFileSync(join(units, `${name}.${suffix}`), "utf8");
}

test("install writes a timer of every 2 minutes and a service for the repo, and enables the timer", async () => {
  const done = await world.runner("install");

  expect(done.code, done.stderr).toBe(0);
  expect(readdirSync(units).sort()).toEqual([`${name}.service`, `${name}.timer`]);
  expect(unit("timer")).toContain("OnCalendar=*:0/2\n");
  expect(unit("timer")).toContain("WantedBy=timers.target\n");
  expect(unit("service")).toContain(`WorkingDirectory=${world.repo}\n`);
  expect(unit("service")).toContain(`EnvironmentFile=${join(world.root, ".config", "bws", "token.env")}\n`);
  expect(world.systemctlCalls()).toEqual([
    ["--user", "daemon-reload"],
    ["--user", "enable", "--now", `${name}.timer`],
  ]);
});

test("a running tick means the next one does not start: the service is a oneshot that stays inactive between ticks", async () => {
  await world.runner("install");

  expect(unit("service")).toContain("Type=oneshot\n");
  expect(unit("service")).not.toContain("RemainAfterExit");
  expect(unit("service")).not.toContain("Restart=");
  // The timer alone starts it, so nothing but its one job can.
  expect(unit("service")).not.toContain("[Install]");
});

test("the service's command runs a tick in the repo, under bws, with the PATH of the install", async () => {
  world.jira.add("AW-1", "Add login");
  await world.runner("install");

  const service = unit("service");
  expect(service).toMatch(/^Environment="PATH=[^"]*fakes\/bin:/m);
  const command = /^ExecStart=(.+)$/m.exec(service)![1];
  expect(command).toMatch(/^\/.*\/bws run -- /);
  const tick = await world.shell(command);

  expect(tick.code, tick.stderr).toBe(0);
  expect(tick.stdout).toContain('AW-1 start "AW-1: Add login"');
  expect(world.jira.issues.get("AW-1")?.status).toBe("In Progress");
});

test("install again rewrites the units and enables them, with no error", async () => {
  await world.runner("install");
  writeFileSync(join(units, `${name}.service`), "stale");

  const done = await world.runner("install");

  expect(done.code, done.stderr).toBe(0);
  expect(unit("service")).toContain("Type=oneshot\n");
});

test("uninstall stops the timer and any running tick, removes both units, and is safe to run again", async () => {
  await world.runner("install");
  const before = world.systemctlCalls().length;

  const done = await world.runner("uninstall");

  expect(done.code, done.stderr).toBe(0);
  expect(readdirSync(units)).toEqual([]);
  expect(world.systemctlCalls().slice(before)).toEqual([
    ["--user", "disable", "--now", `${name}.timer`],
    ["--user", "stop", `${name}.service`],
    ["--user", "daemon-reload"],
  ]);

  const again = await world.runner("uninstall");
  expect(again.code, again.stderr).toBe(0);
});

test.each([
  ["no runner.toml", () => rmSync(join(world.repo, "runner.toml")), "runner.toml"],
  ["no machine token", () => rmSync(join(world.root, ".config", "bws", "token.env")), "token.env"],
])("install with %s refuses and writes nothing", async (_name, arrange, message) => {
  arrange();

  const done = await world.runner("install");

  expect(done.code).toBe(1);
  expect(done.stderr).toContain(message);
  expect(existsSync(units)).toBe(false);
  expect(world.systemctlCalls()).toEqual([]);
});

test("a failed systemctl fails install and uninstall and says why", async () => {
  world.down("systemctl");

  const done = await world.runner("install");

  expect(done.code).toBe(1);
  expect(done.stderr).toContain("Failed to connect to user scope bus");
  // The units stay, so the owner can run either command again once systemd answers.
  const removed = await world.runner("uninstall");
  expect(removed.code).toBe(1);
  expect(existsSync(join(units, `${name}.timer`))).toBe(true);
});

test("install needs no secret", async () => {
  world.unset("JIRA_API_TOKEN");

  const done = await world.runner("install");

  expect(done.code, done.stderr).toBe(0);
});
