// The daily tasks: the prompts in `tasks/`, which no test can run, and `runner tasks`, against the runner's fake `t3`.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { gitEnv, REPO, tempDir } from "./repo.ts";

const read = (path: string) => readFileSync(join(REPO, path), "utf8");
const RUNNER = join(REPO, "runner", "bin", "runner");
const FAKES = join(REPO, "runner", "tests", "fakes");
const TRIAGE = read("tasks/daily-triage.md");
const CORRECT = read("tasks/daily-correct.md");

test("the triage names each thing it reports, in order, under the title that replaces the task in T3's database", () => {
  expect(TRIAGE.split("\n")[0]).toBe("# Daily triage");
  const steps = ["Awaiting Approval", "Stuck", "Runner failures", "Pull requests", "In Review", "Threads", "Loop state", "Slack"].map((step) => TRIAGE.indexOf(`**${step}.**`));
  expect(steps).not.toContain(-1);
  expect(steps).toEqual([...steps].sort((a, b) => a - b));
});

test("the triage reads nothing of the loop and nothing of the old workflow doc, and deletes the loop's folders and no other file", () => {
  expect(TRIAGE).not.toMatch(/decisions\.jsonl|-loop\/|workflow\.html/);
  expect(TRIAGE).toContain("find ~/.local/state -maxdepth 1 -type d -name '*-loop'");
  expect(TRIAGE).toContain("Name each folder it deleted");
});

test("the triage ends with the post in the owner's Slack DM", () => {
  expect(TRIAGE.indexOf("SLACK_WEBHOOK_DM")).toBeGreaterThan(TRIAGE.indexOf("**Slack.**"));
  expect(TRIAGE.indexOf("**Slack.**")).toBeGreaterThan(TRIAGE.indexOf("**Loop state.**"));
});

test("the correct task runs /correct on a branch of its own, and the skill holds the one pull request rule", () => {
  expect(CORRECT.split("\n")[0]).toBe("# Daily correct");
  expect(CORRECT).toContain("`/correct`");
  expect(CORRECT).toContain("git worktree add");
  expect(read("skills/correct/SKILL.md")).toContain("Each run opens at most one pull request.");
});

let root: string;
let env: NodeJS.ProcessEnv;
let fakes: string;

/** The folder of a repo with a runner.toml, as `runner install` leaves it on the host. */
function repoWithRunner(name: string): string {
  const repo = join(root, "dev", name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "runner.toml"), `component = "${name}"\njira_url = "http://jira.invalid"\n`);
  const installed = spawnSync(RUNNER, ["install"], { cwd: repo, env, encoding: "utf8" });
  expect(installed.status, installed.stderr).toBe(0);
  return repo;
}

/** The main checkout of this repo, T3's project for the triage. */
const home = () => dirname(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: REPO, encoding: "utf8" }).trim());

function fakeT3(projects: string[], failStart: string[] = []): void {
  writeFileSync(join(fakes, "t3.json"), JSON.stringify({ project: home(), projects, threads: [], failStart }));
}

function starts(): { title: string; project: string; message: string; args: string[] }[] {
  return readFileSync(join(fakes, "t3.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((args: string[]) => ({ title: args[args.indexOf("--title") + 1], project: args.at(-2)!, message: args.at(-1)!, args }));
}

const tasks = () => spawnSync(RUNNER, ["tasks"], { cwd: root, env, encoding: "utf8" });

beforeEach(() => {
  root = tempDir();
  fakes = join(root, "fakes");
  mkdirSync(fakes);
  mkdirSync(join(root, ".config", "bws"), { recursive: true });
  writeFileSync(join(root, ".config", "bws", "token.env"), "BWS_ACCESS_TOKEN=token\n");
  env = { ...gitEnv(root), HOME: root, XDG_CONFIG_HOME: join(root, ".config"), FAKE_DIR: fakes, PATH: `${join(FAKES, "bin")}:${process.env.PATH}` };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("runner tasks starts one triage thread, and one correct thread for each repo on the runner, each message holding its file", () => {
  const repos = [repoWithRunner("machines"), repoWithRunner("pitchridge")];
  // A unit of the same prefix that is no runner of a repo.
  writeFileSync(join(root, ".config", "systemd", "user", "actions-runner-pitchridge.service"), "[Service]\nWorkingDirectory=/nowhere\n");
  fakeT3(repos);

  const done = tasks();

  expect(done.status, done.stderr).toBe(0);
  const started = starts();
  expect(started.map(({ title, project }) => [title, project])).toEqual([
    ["Register Daily triage in " + home().split("/").at(-1), home()],
    ["Register Daily correct in machines", repos[0]],
    ["Register Daily correct in pitchridge", repos[1]],
  ]);
  for (const start of started) {
    expect(start.args).toContain("--wait");
    expect(start.args).toContain("--provider");
    expect(start.args).toContain("--model");
    expect(start.args).not.toContain("--worktree");
  }
  expect(started[0].message).toContain(TRIAGE);
  expect(started[0].message).toContain('"timeOfDay":"06:00"');
  expect(started[1].message).toContain(CORRECT);
  expect(started[1].message).toContain('"timeOfDay":"06:30"');
  expect(done.stdout).toContain("Daily correct in pitchridge:");
});

test("each message tells the thread to update a task of the same title, and leave the task on no thread", () => {
  fakeT3([]);

  tasks();

  const { message } = starts()[0];
  for (const rule of ["`list_scheduled_tasks`", "`schedule_task`", "`scheduledTaskId`", "the same title", "`bindToCurrentThread`: false", "Do not run the prompt"]) expect(message).toContain(rule);
  expect(message).toContain("Title: Daily triage");
});

test("a thread that fails makes runner tasks exit non-zero, says which, and the others still start", () => {
  const repos = [repoWithRunner("machines"), repoWithRunner("pitchridge")];
  fakeT3(repos, ["Register Daily correct in machines"]);

  const done = tasks();

  expect(done.status).toBe(1);
  expect(done.stderr).toContain("Daily correct in machines failed:");
  expect(starts().map(({ project }) => project)).toEqual([home(), ...repos]);
  expect(done.stdout).toContain("Daily correct in pitchridge:");
});
