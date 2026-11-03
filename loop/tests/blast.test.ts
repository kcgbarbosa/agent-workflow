// The blast level of a worker's pull request: a red one opens as a draft and waits for the owner, a yellow one
// holds after its first green, and a green one merges at its first green.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { World } from "./world.ts";

const KEY = "DEMO-2";
const RUN = `tickets/${KEY}`;

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.close();
});

/** The worker run by hand, as its unit runs it, in slot 2. */
function work() {
  return world.loop("run-ticket", KEY, "--slot", "2");
}

function labels(): string[] {
  return (world.prs()[0]!.labels ?? []).map((label) => label.name);
}

function worker(): string[] {
  return world.steps(RUN);
}

/**
 * Makes the gh call that starts with `call`, such as `pr ready`, hang until `crash` kills the worker in it. The
 * call never reaches GitHub, as when the host dies. The call after the crash goes through.
 */
function hangOn(call: string): { inFlight: () => boolean; crash: () => void } {
  const flag = join(world.fakes, "hang");
  writeFileSync(flag, "");
  const fake = resolve(import.meta.dirname, "fakes", "gh.mjs");
  world.command(
    "gh",
    `#!/bin/sh\nif [ "$1 $2" = "${call}" ] && [ -e "${flag}" ]; then\n  touch "${flag}.waiting"\n  while [ -e "${flag}" ]; do sleep 0.05; done\n  exit 137\nfi\nexec node "${fake}" "$@"\n`,
  );
  return {
    inFlight: () => existsSync(`${flag}.waiting`),
    crash: () => {
      const { pid } = JSON.parse(readFileSync(join(world.fakes, "units", `loop-demo-${KEY}.service.json`), "utf8")) as { pid: number };
      process.kill(-pid, "SIGKILL");
      rmSync(flag);
    },
  };
}

/** Waits a while for the pull request to merge, which it must not. */
async function settle(): Promise<void> {
  await world.until(() => worker().filter((line) => line === `${KEY} start restart`).length > 0, "the restart");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && world.prs()[0]!.state !== "MERGED") await new Promise((done) => setTimeout(done, 100));
}

test("a changed file under a red glob opens a draft labelled blast:red, the dispatcher frees its slot, and marking it ready merges it", async () => {
  world.writeConfig('[blast]\nred = ["auth/**"]\n');
  world.jira.add(KEY, "Add the login page");
  world.verdicts({ [KEY]: "pass" });
  world.plan({ [KEY]: [{ write: { "auth/login.ts": "login\n" }, commit: "feat(DEMO-2): login" }] });

  const started = await world.loop("start");
  expect(started.code, started.stderr).toBe(0);
  await world.until(() => worker().includes(`${KEY} finish handed-back`), "the hand-back");

  expect(world.prs()[0]).toMatchObject({ isDraft: true, state: "OPEN", autoMerge: null });
  expect(labels()).toEqual(["blast:red"]);
  expect(world.decisions(RUN).find((line) => line.step === "blast")).toMatchObject({ result: "red", detail: expect.stringContaining("auth/login.ts") });
  expect(world.decisions(RUN).find((line) => line.step === "hand-back")).toMatchObject({ result: "red" });
  const issue = world.jira.issues.get(KEY)!;
  expect(issue.flagged).toBe(false);
  await world.until(() => world.decisions("").some((line) => line.step === "queue" && String(line.detail).includes(`${KEY} a draft`)), "the draft in the queue");
  expect(world.unitAlive(`loop-demo-${KEY}.service`)).toBe(false);

  world.draft(KEY, false);

  await world.until(() => worker().includes(`${KEY} merge merged`), "the merge");
  const restart = worker().lastIndexOf(`${KEY} start restart`);
  expect(worker().slice(restart)).toEqual(expect.arrayContaining([`${KEY} build skipped`, `${KEY} wait green`, `${KEY} merge merged`]));
  expect(world.calls()).toHaveLength(1);
});

test("a level that rises to red on a fix attempt converts the pull request to a draft and hands the ticket back", async () => {
  world.jira.add(KEY, "Add the login page");
  world.verdicts({ [KEY]: ["fail", "pass"] });
  world.plan({ [KEY]: [{ write: { "a.txt": "a\n" }, commit: "feat(DEMO-2): a" }, { write: { "a.txt": "b\n" }, commit: "fix(DEMO-2): b", blast: "red" }] });

  const ran = await work();

  // A worker that hands its ticket back exits 1, as for a usage limit.
  expect(ran.code, ran.stderr).toBe(1);
  expect(world.prs()[0]).toMatchObject({ isDraft: true, state: "OPEN" });
  expect(labels()).toEqual(["blast:red"]);
  expect(worker()).toEqual(expect.arrayContaining([`${KEY} blast green`, `${KEY} blast red`, `${KEY} draft ok`, `${KEY} hand-back red`]));
});

test("an agent blast of yellow on a green floor labels yellow, holds, and merges after the hold unless the hold label is on", async () => {
  world.writeConfig('[blast]\nred = ["auth/**"]\nhold_minutes = 0\n');
  world.jira.add(KEY, "Add the login page");
  world.verdicts({ [KEY]: "pass" });
  world.plan({ [KEY]: [{ write: { "a.txt": "a\n" }, commit: "feat(DEMO-2): a", blast: "yellow" }] });

  const first = await work();

  expect(first.code, first.stderr).toBe(1);
  expect(labels()).toEqual(["blast:yellow"]);
  expect(world.prs()[0]).toMatchObject({ state: "OPEN", autoMerge: null, isDraft: false });
  expect(world.prs()[0]!.body).toMatch(/^## Loop\n\nHold until \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n\n## Ticket$/m);
  expect(worker()).toEqual(expect.arrayContaining([`${KEY} wait green`, `${KEY} hold set`, `${KEY} hand-back hold`]));
  const body = world.prs()[0]!.body;

  // After the hold, the hold label stops it.
  world.label(KEY, "hold", true);
  const held = await work();
  expect(held.code, held.stderr).toBe(1);
  expect(world.prs()[0]).toMatchObject({ state: "OPEN", autoMerge: null });
  expect(world.decisions(RUN).filter((line) => line.step === "hand-back").at(-1)).toMatchObject({ result: "hold", detail: "The `hold` label is on the pull request." });
  expect(world.prs()[0]!.body).toBe(body);

  // Without the label, the time has passed, so it merges at once.
  world.label(KEY, "hold", false);
  const merged = await work();
  expect(merged.code, merged.stderr).toBe(0);
  expect(world.prs()[0]).toMatchObject({ state: "MERGED", autoMerge: { mergeMethod: "SQUASH" } });
  expect(worker().slice(worker().lastIndexOf(`${KEY} start restart`))).toEqual(expect.arrayContaining([`${KEY} hold over`, `${KEY} merge merged`]));
  expect(world.calls()).toHaveLength(1);
});

test("a yellow pull request hands back while its hold runs, and the dispatcher does not start it again until then", async () => {
  world.writeConfig('[blast]\nyellow = ["*.txt"]\n');
  world.jira.add(KEY, "Add the login page");
  world.verdicts({ [KEY]: "pass" });

  const started = await world.loop("start");
  expect(started.code, started.stderr).toBe(0);
  await world.until(() => worker().includes(`${KEY} hand-back hold`), "the hand-back");
  await world.until(() => world.decisions("").some((line) => line.step === "queue" && String(line.detail).includes(`${KEY} held until`)), "the hold in the queue");

  expect(labels()).toEqual(["blast:yellow"]);
  expect(world.prs()[0]!.state).toBe("OPEN");
  expect(world.decisions("").filter((line) => line.step === "worker" && line.result === "started")).toHaveLength(1);
});

test("a green pull request turns auto-merge on at the first green", async () => {
  world.jira.add(KEY, "Add the login page");
  world.verdicts({ [KEY]: "pass" });

  const ran = await work();

  expect(ran.code, ran.stderr).toBe(0);
  expect(labels()).toEqual(["blast:green"]);
  expect(world.prs()[0]).toMatchObject({ isDraft: false, state: "MERGED", autoMerge: { mergeMethod: "SQUASH" } });
  const steps = worker();
  expect(steps.some((step) => / hold | hand-back /.test(` ${step} `))).toBe(false);
});

test("a red pull request whose worker dies before the draft goes on is a draft again on the restart", async () => {
  const gh = hangOn("pr ready");
  world.writeConfig("[limits]\nparallel = 2\n");
  world.jira.add(KEY, "Add the login page");
  world.verdicts({ [KEY]: ["fail", "pass"] });
  world.plan({ [KEY]: [{ write: { "a.txt": "a\n" }, commit: "feat(DEMO-2): a" }, { write: { "b.txt": "b\n" }, commit: "fix(DEMO-2): b", blast: "red" }] });

  const started = await world.loop("start");
  expect(started.code, started.stderr).toBe(0);
  await world.until(gh.inFlight, "the draft call");
  gh.crash();
  await world.until(() => world.prs()[0]!.isDraft === true && labels().includes("blast:red"), "the draft on the restart");
  await settle();

  expect(world.prs()[0]).toMatchObject({ state: "OPEN", isDraft: true });
  expect(labels()).toEqual(["blast:red"]);
});

test("a yellow pull request whose worker dies before its label goes on holds on the restart", async () => {
  const gh = hangOn("label create");
  world.writeConfig('[blast]\nyellow = ["*.txt"]\n\n[limits]\nparallel = 2\n');
  world.jira.add(KEY, "Add the login page");
  world.verdicts({ [KEY]: "pass" });
  world.plan({ [KEY]: [{ write: { "a.txt": "a\n" }, commit: "feat(DEMO-2): a" }] });

  const started = await world.loop("start");
  expect(started.code, started.stderr).toBe(0);
  await world.until(() => world.prs().length === 1 && gh.inFlight(), "the label call");
  gh.crash();
  await world.until(() => /^Hold until \S+$/m.test(world.prs()[0]!.body), "the hold on the restart");
  await settle();

  expect(world.prs()[0]!.state).toBe("OPEN");
  expect(labels()).toEqual(["blast:yellow"]);
});

test("a level that rises to yellow after auto-merge turned on turns it off and holds", async () => {
  // The token cannot read the branch protection, so the loop knows no required check and turns auto-merge on
  // before `gate / fuzz` reports.
  world.required(["gate / check", "gate / fuzz"]);
  const fake = resolve(import.meta.dirname, "fakes", "gh.mjs");
  world.command("gh", `#!/bin/sh\ncase "$2" in */protection/required_status_checks) echo "gh: Not Found (HTTP 404)" >&2; exit 1;; esac\nexec node "${fake}" "$@"\n`);
  world.jira.add(KEY, "Add the login page");
  world.verdicts({ [KEY]: "pass" });
  world.plan({ [KEY]: [{ write: { "a.txt": "a\n" }, commit: "feat(DEMO-2): a" }, { write: { "b.txt": "b\n" }, commit: "fix(DEMO-2): b", blast: "yellow" }] });

  const ran = work();
  await world.until(() => world.prs()[0]?.autoMerge != null, "auto-merge on");
  world.setChecks(KEY, { "gate / fuzz": "fail" });
  await world.until(() => labels().includes("blast:yellow"), "the yellow label");
  world.setChecks(KEY, { "gate / fuzz": "pass" });
  const done = await ran;

  expect(done.code).toBe(1);
  expect(worker()).toContain(`${KEY} auto-merge off`);
  expect(world.prs()[0]).toMatchObject({ state: "OPEN", autoMerge: null });
  expect(world.prs()[0]!.body).toMatch(/^Hold until \S+$/m);
});

test.each([
  ["auth/**", "auth/.secrets.json"],
  [".github/**", ".github/.env"],
  ["*.env", ".env"],
  ["auth/**", 'auth/café "x".ts'],
])("a changed dotfile under the red glob %s is red", async (glob, file) => {
  world.writeConfig(`[blast]\nred = ["${glob}"]\n`);
  world.jira.add(KEY, "Add the login secrets");
  world.verdicts({ [KEY]: "pass" });
  world.plan({ [KEY]: [{ write: { [file]: "{}\n" }, commit: "feat(DEMO-2): secrets" }] });

  const ran = await work();

  expect(ran.code).toBe(1);
  expect(worker()).toContain(`${KEY} blast red`);
  expect(world.prs()[0]).toMatchObject({ isDraft: true, state: "OPEN" });
  expect(labels()).toEqual(["blast:red"]);
});

test("a file moved out from under a red glob is red", async () => {
  world.writeConfig('[blast]\nred = ["auth/**"]\n');
  const token = "export const token = 'the signing key of the sessions';\n".repeat(5);
  world.commitTo(world.repo, { "auth/token.ts": token }, "chore: the auth token");
  // The agent's commit moves auth/token.ts to lib/token.ts: the hook takes the old path out of the commit.
  const hooks = join(world.root, "hooks");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nif [ -f lib/token.ts ] && [ -f auth/token.ts ]; then git rm -q auth/token.ts; fi\n");
  chmodSync(join(hooks, "pre-commit"), 0o755);
  world.git(world.repo, "config", "core.hooksPath", hooks);
  world.jira.add(KEY, "Move the token code");
  world.verdicts({ [KEY]: "pass" });
  world.plan({ [KEY]: [{ write: { "lib/token.ts": token }, commit: "refactor(DEMO-2): move the token" }] });

  const ran = await work();

  expect(ran.code).toBe(1);
  expect(worker()).toContain(`${KEY} blast red`);
  expect(world.prs()[0]).toMatchObject({ isDraft: true, state: "OPEN" });
  // GitHub merges no draft, auto-merge or not.
  const merge = ["pr", "merge", world.prs()[0]!.url, "--squash"];
  expect(() => execFileSync("node", [resolve(import.meta.dirname, "fakes", "gh.mjs"), ...merge], { cwd: world.repo, env: world.env, stdio: "pipe" })).toThrow(/still a draft/);
});

test("a level that rises to yellow after a restart turns off the auto-merge an earlier run turned on", async () => {
  const fake = resolve(import.meta.dirname, "fakes", "gh.mjs");
  world.required(["gate / check", "gate / fuzz"]);
  world.command("gh", `#!/bin/sh\ncase "$2" in */protection/required_status_checks) echo "gh: Not Found (HTTP 404)" >&2; exit 1;; esac\nexec node "${fake}" "$@"\n`);
  world.jira.add(KEY, "Add the login page");
  world.verdicts({ [KEY]: "pass" });
  world.plan({
    [KEY]: [{ write: { "a.txt": "a\n" }, commit: "feat(DEMO-2): a" }, { limit: {} }, { write: { "b.txt": "b\n" }, commit: "fix(DEMO-2): b", blast: "yellow" }],
  });

  // The first worker turns auto-merge on, and its fix attempt hits the usage limit.
  const first = work();
  await world.until(() => world.prs()[0]?.autoMerge != null, "auto-merge on");
  world.setChecks(KEY, { "gate / fuzz": "fail" });
  expect((await first).code).toBe(1);
  // The second worker's fix attempt gives yellow.
  expect((await work()).code).toBe(1);
  world.setChecks(KEY, { "gate / fuzz": "pass" });
  execFileSync("node", [fake, "pr", "list"], { cwd: world.repo, env: world.env });

  expect(worker()).toContain(`${KEY} auto-merge off`);
  expect(world.prs()[0]).toMatchObject({ state: "OPEN", autoMerge: null });
  expect(world.prs()[0]!.body).toMatch(/^Hold until \S+$/m);
});

test("a red draft whose worker died right after it opened merges once the owner marks it ready", async () => {
  const fake = resolve(import.meta.dirname, "fakes", "gh.mjs");
  const once = join(world.fakes, "kill-once");
  writeFileSync(once, "");
  // `gh pr create --draft` reaches GitHub, and the worker dies before it logs anything after it.
  world.command(
    "gh",
    `#!/bin/sh\nif [ "$1 $2" = "pr create" ] && [ -e "${once}" ]; then\n  node "${fake}" "$@"\n  rm -f "${once}"\n  kill -9 $PPID\n  exit 0\nfi\nexec node "${fake}" "$@"\n`,
  );
  world.writeConfig('[blast]\nred = ["auth/**"]\n');
  world.jira.add(KEY, "Add the login page");
  world.verdicts({ [KEY]: "pass" });
  world.plan({ [KEY]: [{ write: { "auth/login.ts": "login\n" }, commit: "feat(DEMO-2): login" }] });

  expect((await work()).code).not.toBe(0);
  expect(world.prs()[0]).toMatchObject({ isDraft: true, state: "OPEN" });
  world.draft(KEY, false);
  const second = await work();

  expect(second.code, second.stderr).toBe(0);
  expect(world.prs()[0]).toMatchObject({ isDraft: false, state: "MERGED" });
});

test("a yellow pull request whose worker died while it turned auto-merge off holds on the restart", async () => {
  const fake = resolve(import.meta.dirname, "fakes", "gh.mjs");
  const flag = join(world.fakes, "hang");
  world.required(["gate / check", "gate / fuzz"]);
  // The token cannot read the branch protection, and `gh pr merge --disable-auto` hangs while the flag file is there.
  world.command(
    "gh",
    `#!/bin/sh\ncase "$2" in */protection/required_status_checks) echo "gh: Not Found (HTTP 404)" >&2; exit 1;; esac\nif [ "$1 $2 $4" = "pr merge --disable-auto" ] && [ -e "${flag}" ]; then\n  touch "${flag}.waiting"\n  while [ -e "${flag}" ]; do sleep 0.05; done\n  exit 137\nfi\nexec node "${fake}" "$@"\n`,
  );
  world.writeConfig("[limits]\nparallel = 2\n");
  world.jira.add(KEY, "Add the login page");
  world.verdicts({ [KEY]: "pass" });
  world.plan({
    [KEY]: [
      { write: { "a.txt": "a\n" }, commit: "feat(DEMO-2): a" },
      { write: { "b.txt": "b\n" }, commit: "fix(DEMO-2): b", blast: "yellow" },
      { write: { "c.txt": "c\n" }, commit: "fix(DEMO-2): c" },
    ],
  });

  writeFileSync(flag, "");
  const started = await world.loop("start");
  expect(started.code, started.stderr).toBe(0);
  await world.until(() => world.prs()[0]?.autoMerge != null, "auto-merge on");
  world.setChecks(KEY, { "gate / fuzz": "fail" });
  await world.until(() => existsSync(`${flag}.waiting`), "the auto-merge off call");
  const { pid } = JSON.parse(readFileSync(join(world.fakes, "units", `loop-demo-${KEY}.service.json`), "utf8")) as { pid: number };
  process.kill(-pid, "SIGKILL");
  rmSync(flag);
  await world.until(() => /^Hold until \S+$/m.test(world.prs()[0]!.body), "the hold on the restart");
  world.setChecks(KEY, { "gate / fuzz": "pass" });
  execFileSync("node", [fake, "pr", "list"], { cwd: world.repo, env: world.env });

  expect(worker()).toContain(`${KEY} auto-merge off`);
  expect(world.prs()[0]).toMatchObject({ state: "OPEN", autoMerge: null });
});
