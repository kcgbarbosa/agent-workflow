import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type Tick, World } from "./world.ts";

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

function unit(suffix: string, of = name): string {
  return readFileSync(join(units, `${of}.${suffix}`), "utf8");
}

const UPDATE = "runner-update";

/** Merges a change to main of the origin, from a clone of its own. */
function merge(file: string, text: string): string {
  const clone = join(world.root, "merger");
  world.git(world.root, "clone", "--quiet", world.origin, clone);
  writeFileSync(join(clone, file), text);
  world.git(clone, "add", ".");
  world.git(clone, "commit", "--quiet", "-m", `change ${file}`);
  world.git(clone, "push", "--quiet", "origin", "main");
  const head = world.git(clone, "rev-parse", "HEAD");
  rmSync(clone, { recursive: true });
  return head;
}

/** The update service's commands in order, as systemd would unquote them, run in the repo up to the first failure. */
async function pull(): Promise<Tick> {
  let last: Tick = { code: 0, stdout: "", stderr: "", lines: [] };
  for (const [, directive, command] of unit("service", UPDATE).matchAll(/^(ExecStartPre|ExecStart)=(.+)$/gm)) {
    const script = /^(\S+) -c "(.*)"$/.exec(command);
    last = await world.shell(script ? script[2].replaceAll('\\"', '"').replaceAll("$$", "$") : command);
    if (last.code !== 0) return { ...last, stderr: `${directive}: ${last.stderr}` };
  }
  return last;
}

test("install writes a timer of every 2 minutes and a service for the repo, and enables the timer", async () => {
  const done = await world.runner("install");

  expect(done.code, done.stderr).toBe(0);
  expect(readdirSync(units).sort()).toEqual([`${name}.service`, `${name}.timer`, `${UPDATE}.service`, `${UPDATE}.timer`]);
  expect(unit("timer")).toContain("OnCalendar=*:0/2\n");
  expect(unit("timer")).toContain("WantedBy=timers.target\n");
  expect(unit("service")).toContain(`WorkingDirectory=${world.repo}\n`);
  expect(unit("service")).toContain(`EnvironmentFile=${join(world.root, ".config", "bws", "token.env")}\n`);
  expect(world.systemctlCalls()).toEqual([
    ["--user", "daemon-reload"],
    ["--user", "enable", "--now", `${name}.timer`],
    ["--user", "enable", "--now", `${UPDATE}.timer`],
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
    ["--user", "disable", "--now", `${UPDATE}.timer`],
    ["--user", "stop", `${UPDATE}.service`],
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

test("install writes the update pair: a oneshot in the runner's checkout that runs git itself, on the odd minutes", async () => {
  await world.runner("install");

  const service = unit("service", UPDATE);
  expect(service).toContain("Type=oneshot\n");
  expect(service).toContain(`WorkingDirectory=${join(import.meta.dirname, "..", "..")}\n`);
  expect(service).toMatch(/^ExecStart=\/.*\/git pull --ff-only origin main$/m);
  // A merge that breaks the runner's code cannot stop the pull that brings its fix.
  expect(service).not.toContain("bin/runner");
  expect(service).not.toContain("bws");
  expect(unit("timer", UPDATE)).toContain("OnCalendar=*:1/2\n");
  expect(unit("timer", UPDATE)).toContain("WantedBy=timers.target\n");
});

test("a merge to main is in the checkout after the update service runs", async () => {
  await world.runner("install");
  const head = merge("fix.txt", "the fix\n");

  const done = await pull();

  expect(done.code, done.stderr).toBe(0);
  expect(world.git(world.repo, "rev-parse", "HEAD")).toBe(head);
  expect(readFileSync(join(world.repo, "fix.txt"), "utf8")).toBe("the fix\n");
});

test("a checkout on another branch stays as it is, and the failure says why", async () => {
  await world.runner("install");
  world.git(world.repo, "checkout", "--quiet", "-b", "work");
  const before = world.git(world.repo, "rev-parse", "HEAD");
  merge("fix.txt", "the fix\n");

  const done = await pull();

  expect(done.code).not.toBe(0);
  expect(done.stderr).toContain("The checkout is on work, not main");
  expect(world.git(world.repo, "rev-parse", "HEAD")).toBe(before);
  expect(world.git(world.repo, "symbolic-ref", "--short", "HEAD")).toBe("work");
});

test("a checkout with no branch stays as it is, and the failure says why", async () => {
  await world.runner("install");
  world.git(world.repo, "checkout", "--quiet", "--detach");
  const before = world.git(world.repo, "rev-parse", "HEAD");
  merge("fix.txt", "the fix\n");

  const done = await pull();

  expect(done.code).not.toBe(0);
  expect(done.stderr).toContain("The checkout is on no branch, not main");
  expect(world.git(world.repo, "rev-parse", "HEAD")).toBe(before);
});

test("a checkout whose local change the merge would overwrite stays as it is, and the failure says why", async () => {
  await world.runner("install");
  const before = world.git(world.repo, "rev-parse", "HEAD");
  writeFileSync(join(world.repo, "fix.txt"), "mine\n");
  merge("fix.txt", "the fix\n");

  const done = await pull();

  expect(done.code).not.toBe(0);
  expect(done.stderr).toContain("fix.txt");
  expect(world.git(world.repo, "rev-parse", "HEAD")).toBe(before);
  expect(readFileSync(join(world.repo, "fix.txt"), "utf8")).toBe("mine\n");
});

test("a checkout with a local commit stays as it is, and the failure says why", async () => {
  await world.runner("install");
  const local = world.commit("local");
  merge("fix.txt", "the fix\n");

  const done = await pull();

  expect(done.code).not.toBe(0);
  expect(done.stderr).toContain("Not possible to fast-forward");
  expect(world.git(world.repo, "rev-parse", "HEAD")).toBe(local);
});

test("a thread's worktree does not change when the checkout moves", async () => {
  await world.runner("install");
  const worktree = join(world.root, "thread");
  world.git(world.repo, "worktree", "add", "--quiet", "-b", "fix/AW-1-login", worktree);
  const before = world.git(worktree, "rev-parse", "HEAD");
  const head = merge("fix.txt", "the fix\n");

  const done = await pull();

  expect(done.code, done.stderr).toBe(0);
  expect(world.git(world.repo, "rev-parse", "HEAD")).toBe(head);
  expect(world.git(worktree, "rev-parse", "HEAD")).toBe(before);
  expect(world.git(worktree, "status", "--porcelain")).toBe("");
});

/** A second repo of the host, with its own `runner.toml`. */
function otherRepo(): string {
  const other = join(world.root, "other");
  mkdirSync(other);
  writeFileSync(join(other, "runner.toml"), readFileSync(join(world.repo, "runner.toml")));
  return other;
}

test("a second repo's install rewrites the one update pair", async () => {
  await world.runner("install");
  writeFileSync(join(units, `${UPDATE}.service`), "stale");

  const done = await world.runnerIn(otherRepo(), ["install"]);

  expect(done.code, done.stderr).toBe(0);
  expect(readdirSync(units).filter((file) => file.startsWith(UPDATE)).sort()).toEqual([`${UPDATE}.service`, `${UPDATE}.timer`]);
  expect(existsSync(join(units, "runner-other.timer"))).toBe(true);
  expect(unit("service", UPDATE)).toContain("Type=oneshot\n");
});

test("uninstall keeps the update pair while another repo's timer exists, and the last uninstall removes it", async () => {
  const other = otherRepo();
  await world.runner("install");
  await world.runnerIn(other, ["install"]);
  const before = world.systemctlCalls().length;

  const first = await world.runner("uninstall");

  expect(first.code, first.stderr).toBe(0);
  expect(readdirSync(units).sort()).toEqual(["runner-other.service", "runner-other.timer", `${UPDATE}.service`, `${UPDATE}.timer`]);
  expect(world.systemctlCalls().slice(before).flat()).not.toContain(`${UPDATE}.timer`);

  const last = await world.runnerIn(other, ["uninstall"]);

  expect(last.code, last.stderr).toBe(0);
  expect(readdirSync(units)).toEqual([]);
});
