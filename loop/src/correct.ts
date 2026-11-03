// `loop correct`, the unit `loop-<name>-correct`: the `correct` skill once, in a worktree of the main branch, on
// what went wrong since the newest merged pull request with the `correct` label. It opens at most one pull
// request a run, with no key, whatever the agent found. The dispatcher starts it once a day, and `loop stop` ends it.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ask, type Session } from "./agent.ts";
import type { Config, Level } from "./config.ts";
import { git, gitOk } from "./git.ts";
import * as github from "./github.ts";
import { CORRECT, TICKETS, WORKTREE } from "./layout.ts";
import { DECISIONS, type Line, Log } from "./log.ts";
import { lineTime, readLines } from "./report.ts";
import { globFloor, higher, nextLog } from "./run.ts";
import { composeProject, freeSlot, portsFree, takeSlot } from "./slots.ts";
import { run } from "./spawn.ts";
import { runUnit, startRun } from "./units.ts";

/** The label of each pull request of `loop correct`. */
export const CORRECT_LABEL = "correct";
const COMMITS = 200;
const FUZZ = /(^|\/ )fuzz$/;

/** The folder of the `correct` runs under the state folder. */
export function correctHome(stateDir: string): string {
  return join(stateDir, CORRECT);
}

/** Takes a slot and starts the unit, with what `loop run-correct` needs. Null when no slot is free. */
export async function startCorrect(config: Config, active: Set<string>): Promise<{ slot: number; unit: string } | null> {
  const usable = await portsFree(config.stateDir, composeProject(config.name, CORRECT), config.stack);
  const slot = takeSlot(config.stateDir, CORRECT, runUnit(config.name, CORRECT), config.parallel, active, usable);
  if (slot === null) return null;
  try {
    return { slot, unit: await startRun(config.repo, config.name, CORRECT, ["--slot", String(slot)], "run-correct") };
  } catch (error) {
    freeSlot(config.stateDir, slot, CORRECT);
    throw error;
  }
}

/** The run of the unit. Returns the exit code. */
export async function runCorrect(config: Config, secrets: Record<string, string>, slot: number): Promise<number> {
  const home = correctHome(config.stateDir);
  mkdirSync(home, { recursive: true });
  const log = new Log(join(home, DECISIONS), CORRECT);
  const own = (step: string, result: string, extra: Record<string, unknown> = {}) => log.write(CORRECT, step, result, { ...extra, run: true });
  own("start", "ok", { pid: process.pid, slot });
  const worktree = join(home, WORKTREE);
  const branch = `chore/correct-${new Date().toISOString().replace(/\D/g, "").slice(0, 12)}`;
  try {
    const open = await github.labeled(config.repo, CORRECT_LABEL, "open");
    if (open.length) {
      own("finish", "skipped", { pr: open[0]!.url, detail: "A pull request of `loop correct` is still open, so this run opens no other." });
      return 0;
    }
    await git(config.repo, "fetch", "--quiet", "origin", config.mainBranch);
    const since = (await github.labeled(config.repo, CORRECT_LABEL, "merged"))[0]?.mergeCommit?.oid ?? null;
    await removeWorktree(config.repo, worktree);
    await git(config.repo, "worktree", "add", "--quiet", "--no-track", "-b", branch, worktree, `origin/${config.mainBranch}`);
    if (config.setup.length) {
      const [command, ...args] = config.setup;
      const done = await run(command!, args, { cwd: worktree, seconds: config.agentTimeoutMinutes * 60 });
      if (done.code !== 0 || done.timedOut) throw new Error(`The setup command \`${config.setup.join(" ")}\` failed: ${done.stderr.trim()}`);
    }
    const brief = join(home, "brief.md");
    writeFileSync(brief, await briefOf(config, since));
    const session = await ask({
      prompt: `/correct ${brief}`,
      cwd: worktree,
      resume: null,
      model: config.agentModel,
      effort: config.agentEffort,
      env: agentEnv(secrets, home),
      log: nextLog(home),
      minutes: config.agentTimeoutMinutes,
      stateDir: config.stateDir,
    });
    log.write(CORRECT, "agent", session.result, { session: session.session, detail: session.detail, cost: session.cost, usage: session.usage, plan: session.plan });
    if (session.result !== "done") {
      own("finish", "fail", { detail: session.detail });
      return 1;
    }
    if ((await git(worktree, "rev-list", "--count", `origin/${config.mainBranch}..HEAD`)) === "0") {
      own("finish", "none", { detail: session.output?.reason ?? "No class has happened twice." });
      return 0;
    }
    const url = await openPullRequest(config, session, worktree, branch, own);
    own("finish", "ok", { pr: url });
    return 0;
  } catch (error) {
    own("finish", "fail", { detail: (error as Error).message });
    return 1;
  } finally {
    await removeWorktree(config.repo, worktree).catch((error: Error) => own("worktree", "fail", { detail: error.message }));
    freeSlot(config.stateDir, slot, CORRECT);
    log.close();
  }
}

/** Pushes the branch and opens the one pull request. A green one merges on green. No worker comes back to a held one, so a yellow or red one opens as a draft for the owner. */
async function openPullRequest(
  config: Config,
  session: Session,
  worktree: string,
  branch: string,
  own: (step: string, result: string, extra?: Record<string, unknown>) => unknown,
): Promise<string> {
  const changed = (await git(worktree, "diff", "--name-only", "--no-renames", "-z", `origin/${config.mainBranch}...HEAD`)).split("\0").filter(Boolean);
  const { floor, file } = globFloor(config.blast, changed);
  const level: Level = higher(floor, session.output?.blast ?? "green");
  own("blast", level, { detail: `${file ? `${file} matches a ${floor} glob` : "no changed file matches a glob"}, the agent gave ${session.output?.blast ?? "none"}.` });
  await git(worktree, "push", "--quiet", "-u", "origin", `HEAD:refs/heads/${branch}`);
  const subject = await git(worktree, "log", "-1", "--format=%s");
  const title = `chore: ${subject.replace(/^[a-z]+(\([^)]*\))?!?:\s*/, "")}`;
  const body = join(correctHome(config.stateDir), "pr-body.md");
  writeFileSync(body, `${session.output?.reason ?? ""}\n\nOpened by \`loop correct\`.\n`);
  const url = await github.create(config.repo, branch, config.mainBranch, title, body, level !== "green");
  own("pr", "open", { pr: url, detail: title });
  for (const label of [CORRECT_LABEL, `blast:${level}`]) {
    try {
      await github.label(config.repo, url, label, []);
    } catch (error) {
      own("label", "fail", { pr: url, detail: (error as Error).message });
    }
  }
  if (level === "green") {
    try {
      await github.autoMerge(config.repo, url);
    } catch (error) {
      own("auto-merge", "fail", { pr: url, detail: (error as Error).message });
    }
  }
  return url;
}

/** What the skill reads: the commits and the reverts on main since the last correction, and from the logs the fix attempts and the red fuzz checks. */
async function briefOf(config: Config, since: string | null): Promise<string> {
  const known = since !== null && (await gitOk(config.repo, "cat-file", "-e", `${since}^{commit}`));
  const range = known ? `${since}..origin/${config.mainBranch}` : `origin/${config.mainBranch}`;
  const commits = (await git(config.repo, "log", `--max-count=${COMMITS}`, "--format=%h %s", range)).split("\n").filter(Boolean);
  const from = known ? Number(await git(config.repo, "show", "-s", "--format=%ct", since)) : 0;
  const reverts = commits.filter((commit) => /\brevert/i.test(commit));
  const fixes: string[] = [];
  const fuzz = new Set<string>();
  const tickets = join(config.stateDir, TICKETS);
  for (const key of existsSync(tickets) ? readdirSync(tickets).sort() : []) {
    for (const line of readLines(join(tickets, key, DECISIONS))) {
      if (lineTime(line) < from) continue;
      if (line.step === "build" && line.result === "started" && Number(line.attempt) > 1) fixes.push(`${key}: fix attempt ${line.attempt}. ${logOf(config, key)}`);
      if (line.step === "wait" && line.result === "red" && typeof line.pr === "string" && redFuzz(line)) fuzz.add(`${key}: ${line.pr}`);
    }
  }
  const section = (title: string, items: string[]) => `## ${title}\n\n${items.length ? items.map((item) => `- ${item}`).join("\n") : "None."}\n\n`;
  return (
    `# What to read\n\n${known ? `Since ${since}, the newest merged pull request with the \`${CORRECT_LABEL}\` label.` : `The last ${COMMITS} commits: no pull request with the \`${CORRECT_LABEL}\` label has merged.`}\n\n` +
    section("Commits", commits) +
    section("Reverts", reverts) +
    section("Fix attempts in the loop logs", fixes) +
    section("Pull requests with a red fuzz check, whose findings are in the fuzz comment", [...fuzz])
  );
}

function logOf(config: Config, key: string): string {
  return `Its session logs are in ${join(config.stateDir, TICKETS, key)}.`;
}

function redFuzz(line: Line): boolean {
  const checks = Array.isArray(line.checks) ? (line.checks as { name?: string; bucket?: string }[]) : [];
  return checks.some((check) => FUZZ.test(check.name ?? "") && check.bucket === "fail");
}

/** Removes the run's worktree, and each local branch of a run, which a stop can leave behind. A pushed branch lives on origin. */
async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(repo, "worktree", "prune");
  if (existsSync(path)) await git(repo, "worktree", "remove", "--force", path);
  const branches = (await git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/chore/correct-*")).split("\n").filter(Boolean);
  if (branches.length) await git(repo, "branch", "--delete", "--force", ...branches);
}

function agentEnv(secrets: Record<string, string>, home: string): Record<string, string> {
  const env: Record<string, string> = {};
  // `bws run` keeps its machine token from the run, and a run started some other way keeps it from the agent too.
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && name !== "BWS_ACCESS_TOKEN") env[name] = value;
  return { ...env, ...secrets, LOOP_RUN_DIR: home, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" };
}
