// A run turns each ticket of the frontier into one pull request. A ticket is a fixed list of steps: build,
// push, pull request, wait, merge. The gate on GitHub checks the work, so the loop runs no gate, no review,
// no landing, and no Epic branch of its own. A red gate resumes the agent as a fix attempt, and a ticket whose
// blocker has an open pull request stacks on it. A restart starts each ticket at its first step.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { ask, type Meter, runSetup, type Session } from "./agent.ts";
import { archive } from "./archive.ts";
import type { Config } from "./config.ts";
import { git, slug } from "./git.ts";
import * as github from "./github.ts";
import { run } from "./spawn.ts";
import { type Ticket, Jira } from "./jira.ts";
import { Log } from "./log.ts";

/** The longest the loop waits for the checks of one pull request. */
const WAIT_MINUTES = 120;

/** The lines of a failed job's log that a fix attempt gets, as the Python loop gives a failed gate's. */
const LOG_TAIL_LINES = 80;

/** A usage limit that resets later than this stops the run. */
const MAX_USAGE_WAIT_SECONDS = 6 * 60 * 60;

/** The run resumes this long after the reset, so the first call after it meets no limit. */
const PAST_RESET_SECONDS = 60;

/** The Python loop's Epic slot. The tickets take the slots after it, so both loops give a ticket the same ports. */
const EPIC_SLOT = 1;

/** The slots after the ticket slots that a ticket's stack moves to when another project holds its ports. */
const SPARE_SLOTS = 8;

/** A host port that `docker ps` lists as published, alone or as a range. */
const PUBLISHED_PORT = /:(\d+)(?:-(\d+))?->/g;

const USAGE_RESUME_PROMPT = "The run stopped at a usage limit, which has now reset. Continue the work.";

const STUCK_COMMENT = "The loop stopped this ticket.";

/** The status an Epic takes when its last ticket merges. */
const EPIC_DONE = "Done";

export type Target = { key: string } | { filter: string };

/** `meterSeconds` is the least time between two plan meter lines of a running agent. */
export type Options = { pollSeconds: number; meterSeconds: number };

type State = "merged" | "done" | "flagged" | "ready" | "waiting";

type Finished = "merged" | "stopped" | "stuck";

class PortsTaken extends Error {}

export function runName(target: Target): string {
  if ("key" in target) return target.key;
  return `filter-${createHash("sha256").update(target.filter).digest("hex").slice(0, 8)}`;
}

function branchPrefixes(key: string): string[] {
  return [`feat/${key}-`, `fix/${key}-`];
}


export class Run {
  private readonly config: Config;
  private readonly secrets: Record<string, string>;
  private readonly target: Target;
  private readonly options: Options;
  private readonly jira: Jira;
  private readonly name: string;
  private readonly home: string;
  readonly log: Log;
  private epic: string | null = null;
  /** The summary of the Epic or ticket the run started with, for the watch page. */
  private summary: string | null = null;
  private readonly merged = new Set<string>();
  /** The address of each merged pull request, which names the repo on GitHub. */
  private readonly mergedUrls: string[] = [];
  private readonly byKey = new Map<string, Ticket>();
  /** The pull request each ticket opened in this run and that has not merged, which a dependent stacks on. */
  private readonly open = new Map<string, { url: string; branch: string }>();
  /** The tickets that finished in this run without a merge. */
  private readonly stopped = new Set<string>();
  /** Why no new ticket starts: the circuit breaker or a usage limit the loop does not wait for. */
  private halt: "circuit-breaker" | "usage-limit" | null = null;
  /** Until when, in epoch milliseconds, the run waits for a usage limit to reset. */
  private pausedUntil = 0;
  private wake: () => void = () => {};
  /** The spare slot each ticket slot moved to for the rest of the run, because another project held a port. */
  private readonly slotMoves = new Map<number, number>();

  constructor(config: Config, secrets: Record<string, string>, target: Target, options: Options) {
    this.config = config;
    this.secrets = secrets;
    this.target = target;
    this.options = options;
    this.jira = new Jira(config.trackerUrl, secrets.JIRA_EMAIL ?? "", secrets.JIRA_API_TOKEN ?? "");
    this.name = runName(target);
    this.home = join(config.stateDir, this.name);
    this.log = new Log(join(this.home, "decisions.jsonl"), this.name);
  }

  /** Builds the frontier until no ticket is left to start, and returns the exit code. */
  async run(): Promise<number> {
    const input = "key" in this.target ? this.target.key : `--filter ${this.target.filter}`;
    // The watch page tells a running run from the pid, and two runs apart from the setup.
    const setup = await runSetup(this.config);
    this.log.write(this.name, "start", "ok", { detail: this.config.mainBranch, input, pid: process.pid, setup });
    const tickets = await this.tickets();
    for (const ticket of tickets) this.byKey.set(ticket.key, ticket);
    await git(this.config.repo, "fetch", "--prune", "--quiet", "origin");
    const mergedBefore = new Map<string, github.PullRequest>();
    for (const ticket of tickets) {
      const { branch } = await this.branchOf(ticket);
      const prs = await github.pullRequestsOf(this.config.repo, ticket.key, branch, branchPrefixes(ticket.key));
      const pr = prs.find((item) => item.state === "MERGED");
      if (pr) mergedBefore.set(ticket.key, pr);
    }
    for (const [key, pr] of mergedBefore) {
      this.merged.add(key);
      this.mergedUrls.push(pr.url);
    }
    const states = new Map(tickets.map((ticket) => [ticket.key, this.state(ticket)]));
    this.log.write(this.name, "frontier", "ok", {
      detail: tickets.map((ticket) => `${ticket.key} ${states.get(ticket.key)}`).join(", "),
      summary: this.summary,
      tickets: tickets.map((ticket) => ({
        key: ticket.key,
        summary: ticket.summary,
        status: ticket.status,
        state: states.get(ticket.key),
        blockers: ticket.blockers.map((blocker) => blocker.key),
      })),
    });
    for (const [key, pr] of mergedBefore) {
      this.log.write(key, "start", "merged-before", { pr: pr.url, detail: "Its pull request merged before this run." });
      // A kill between a merge and its retarget leaves a dependent on the merged branch.
      await this.retarget(key, pr.headRefName, pr.baseRefName);
    }

    // Slot 0 is the main checkout and slot 1 the Epic's, as in the Python loop, so the tickets take 2 and up.
    const slots = Array.from({ length: this.config.parallel }, (_, index) => EPIC_SLOT + 1 + index);
    const finished = new Map<string, Finished>();
    const running = new Map<string, Promise<void>>();
    let stuckInRow = 0;
    for (;;) {
      for (const ticket of tickets) {
        if (this.halt || running.size >= this.config.parallel) break;
        if (running.has(ticket.key) || finished.has(ticket.key) || this.state(ticket) !== "ready") continue;
        const slot = slots.shift()!;
        const work = this.ticket(ticket, slot)
          .catch((error: Error) => {
            this.log.write(ticket.key, "stop", "loop-error", { detail: error.message });
            return "stopped" as const;
          })
          .then((result) => {
            finished.set(ticket.key, result);
            running.delete(ticket.key);
            slots.push(slot);
            if (result !== "merged") this.stopped.add(ticket.key);
            if (result === "merged") stuckInRow = 0;
            if (result === "stuck" && ++stuckInRow >= this.config.circuitBreaker && !this.halt) {
              this.halt = "circuit-breaker";
              this.log.write(this.name, "circuit-breaker", "open", { detail: `${stuckInRow} tickets in a row are stuck, so no new ticket starts.` });
            }
          });
        running.set(ticket.key, work);
      }
      if (!running.size) break;
      // A pull request that opens wakes the loop too, since a ticket can stack on it.
      const woken = new Promise<void>((resolve) => (this.wake = resolve));
      await Promise.race([...running.values(), woken]);
    }

    const stopped = [...finished].filter(([, result]) => result !== "merged").map(([key]) => key);
    const left = tickets.filter((ticket) => !finished.has(ticket.key) && this.state(ticket) === "waiting");
    const parts = [
      `merged: ${tickets.filter((ticket) => this.merged.has(ticket.key)).map((ticket) => ticket.key).join(", ") || "none"}`,
    ];
    if (stopped.length) parts.push(`stopped: ${stopped.join(", ")}`);
    if (left.length) parts.push(`waiting on a blocker: ${left.map((ticket) => ticket.key).join(", ")}`);
    if (this.halt) parts.push(`the loop stopped at the ${this.halt}`);
    if (await this.completeEpic(tickets)) parts.push(`${this.epic} is complete`);
    const detail = parts.join(". ");
    const failed = stopped.length > 0 || this.halt !== null;
    this.log.write(this.name, "finish", failed ? "stopped" : "ok", { detail });
    await this.notify(`${this.name} finished. ${detail}`);
    return failed ? 1 : 0;
  }
  /**
   * When every ticket of the Epic has merged or is done, archives the Epic's spec, then marks the Epic done. A
   * run that finds the Epic done does nothing, and an archive that fails leaves it open, so the next run goes on.
   */
  private async completeEpic(tickets: Ticket[]): Promise<boolean> {
    if (!this.epic) return false;
    try {
      const epic = await this.jira.ticket(this.epic);
      if (epic.done) return false;
      const children = this.name === this.epic ? tickets : await this.jira.search(`parent = ${this.epic} ORDER BY key ASC`);
      if (!children.length || !children.every((child) => this.merged.has(child.key) || child.done)) return false;
      const [url] = this.mergedUrls;
      if (!url) throw new Error(`No pull request of ${this.epic} merged, so the loop does not know the repo on GitHub.`);
      const archived = await archive(this.config, this.jira, epic, url.split("/pull/")[0]!, this.home);
      this.log.write(this.name, "archive", archived.result, { detail: archived.detail, pr: archived.pr });
    } catch (error) {
      this.log.write(this.name, "archive", "fail", { detail: `${this.epic}: ${(error as Error).message}` });
      return false;
    }
    try {
      await this.jira.transition(this.epic, EPIC_DONE);
      this.log.write(this.name, "complete", "ok", { detail: `${this.epic} is ${EPIC_DONE}.` });
    } catch (error) {
      this.log.write(this.name, "complete", "fail", { detail: `${this.epic}: ${(error as Error).message}` });
      return false;
    }
    await this.notify(`${this.epic} complete`);
    return true;
  }

  /** The tickets of an Epic, the one ticket of a key, or the tickets a filter finds. */
  private async tickets(): Promise<Ticket[]> {
    if ("filter" in this.target) return this.jira.search(this.target.filter);
    const ticket = await this.jira.ticket(this.target.key);
    this.summary = ticket.summary;
    if (ticket.issueType === "Epic") {
      this.epic = ticket.key;
      return this.jira.search(`parent = ${ticket.key} ORDER BY key ASC`);
    }
    this.epic = ticket.parent;
    return [ticket];
  }

  private state(ticket: Ticket): State {
    if (this.merged.has(ticket.key)) return "merged";
    if (ticket.done) return "done";
    if (ticket.flagged) return "flagged";
    const open = ticket.blockers.filter((blocker) => !blocker.done && !this.merged.has(blocker.key));
    return !open.length || this.stackOn(ticket) ? "ready" : "waiting";
  }

  /**
   * The blocker whose open pull request the ticket stacks on: its one blocker that has not merged, once that
   * blocker's pull request opened in this run. A ticket with two open blockers waits, since a branch has one base.
   */
  private stackOn(ticket: Ticket): { key: string; url: string; branch: string } | null {
    const open = ticket.blockers.filter((blocker) => !blocker.done && !this.merged.has(blocker.key));
    if (open.length !== 1) return null;
    const key = open[0]!.key;
    const pr = this.open.get(key);
    if (!pr || this.stopped.has(key) || this.byKey.get(key)?.flagged) return null;
    return { key, ...pr };
  }

  private async ticket(ticket: Ticket, slot: number): Promise<Finished> {
    const repo = this.config.repo;
    const main = this.config.mainBranch;
    const key = ticket.key;
    const worktree = join(this.home, "worktrees", key);
    const runDir = join(this.home, "runs", key);
    mkdirSync(runDir, { recursive: true });
    const restart = this.log.lines().some((line) => line.ticket === key && line.step === "start" && line.result !== "merged-before");
    await git(repo, "fetch", "--prune", "--quiet", "origin");
    const stack = this.stackOn(ticket);
    const base = stack?.branch ?? main;
    const branch = await this.worktree(ticket, worktree, base);
    this.log.write(key, "start", restart ? "restart" : "new", { detail: branch, slot, ...(stack ? { base, pr: stack.url } : {}) });
    if (ticket.status !== this.config.inProgress) await this.status(key, this.config.inProgress);
    await this.writeTicket(ticket, branch, runDir, stack);

    let prompt = `/implement ${join(runDir, "ticket.md")}`;
    let url: string | null = null;
    let autoMerge = false;
    let red = "";
    for (let attempt = 1; ; attempt++) {
      if (attempt > 1 && this.fixes(key) >= this.config.fixAttempts) {
        return this.stuck(key, `The gate stayed red after ${this.config.fixAttempts} fix attempts. ${red}`, url);
      }

      // Build, or a fix attempt that resumes the session with what the gate found
      const before = await git(worktree, "rev-parse", "HEAD");
      this.log.write(key, "build", "started", { commit: before, attempt, ...(attempt > 1 ? { detail: red } : {}) });
      let session: Session;
      try {
        session = await this.agent(key, prompt, worktree, runDir, slot);
      } catch (error) {
        if (!(error instanceof PortsTaken)) throw error;
        this.log.write(key, "build", "fail", { commit: before, detail: error.message });
        return this.stuck(key, error.message, url);
      }
      const commit = await git(worktree, "rev-parse", "HEAD");
      if (session.result !== "done") {
        this.log.write(key, "build", session.result === "blocked" ? "blocked" : "fail", { commit, session: session.session, detail: session.detail });
        return "stopped";
      }
      if (attempt === 1 && !(await git(worktree, "rev-list", "--count", `origin/${base}..HEAD`)).match(/^[1-9]/)) {
        this.log.write(key, "build", "fail", { commit, session: session.session, detail: "The agent returned done with no commit on the branch." });
        return "stopped";
      }
      if (attempt > 1 && commit === before) {
        // The gate would give the same result, so the next attempt gets the same message.
        this.log.write(key, "build", "fail", { commit, session: session.session, detail: "The fix attempt returned done with no new commit." });
        continue;
      }
      this.log.write(key, "build", "pass", { commit, session: session.session });

      // Push
      try {
        await git(worktree, "push", "--quiet", "--force-with-lease", "-u", "origin", `HEAD:refs/heads/${branch}`);
        this.log.write(key, "push", "ok", { commit });
      } catch (error) {
        this.log.write(key, "push", "fail", { commit, detail: (error as Error).message });
        return "stopped";
      }

      // Pull request. A stacked one targets its blocker's branch, and gets auto-merge once it targets main,
      // so that GitHub never merges it into the blocker's branch.
      if (url === null) {
        try {
          url = await this.pullRequest(ticket, branch, runDir, base, session.output?.reason ?? "", session.output?.decisions ?? []);
        } catch (error) {
          this.log.write(key, "pr", "fail", { commit, detail: (error as Error).message });
          return "stopped";
        }
        let detail = "";
        if ((await github.view(repo, url)).baseRefName === main) {
          [autoMerge, detail] = await this.autoMerge(url);
        } else {
          detail = `It stacks on ${base}, so auto-merge waits until it targets ${main}.`;
        }
        this.log.write(key, "pr", "open", { commit, pr: url, auto_merge: autoMerge, detail });
        this.open.set(key, { url, branch });
        this.wake();
        await this.status(key, this.config.inReview);
      }

      // Wait
      const checks = await this.wait(url, autoMerge, commit);
      this.log.write(key, "wait", checks.result, {
        commit,
        pr: url,
        checks: checks.checks.map(({ name, bucket }) => ({ name, bucket })),
        detail: checks.detail,
      });
      if (checks.result === "green") break;
      if (checks.result !== "red" || checks.closed) return "stopped";
      red = checks.detail;
      prompt = await this.fixPrompt(url, checks.checks);
    }

    // A stacked pull request merges once its base has merged and it targets main.
    if (!autoMerge) {
      const pr = await github.view(repo, url);
      if (pr.baseRefName !== main && stack) {
        const result = await this.untilMain(url, stack.key);
        this.log.write(key, "base", result, { pr: url, detail: result === "main" ? `${stack.key} merged.` : `${stack.key} did not merge.` });
        if (result !== "main") return "stopped";
        [autoMerge] = await this.autoMerge(url);
      }
    }

    // Merge
    const merged = await this.merge(url);
    if (merged === null) {
      this.log.write(key, "merge", "fail", { pr: url, detail: "The pull request did not merge." });
      return "stopped";
    }
    this.log.write(key, "merge", "merged", { commit: merged, pr: url });
    this.merged.add(key);
    this.mergedUrls.push(url);
    this.open.delete(key);
    await this.retarget(key, branch, (await github.view(repo, url)).baseRefName);
    return "merged";
  }

  /** A run of the head agent, which waits out each usage limit that resets in time and resumes its session. */
  private async agent(key: string, prompt: string, worktree: string, runDir: string, slot: number): Promise<Session> {
    for (;;) {
      await this.untilResumed();
      const stack = await this.stackEnv(key, slot);
      const resume = this.log.lines().findLast((line) => line.ticket === key && line.step === "agent" && line.session)?.session;
      const meter = this.meterLogger(key);
      const session = await ask({
        prompt,
        cwd: worktree,
        resume: resume ?? null,
        model: this.config.agentModel,
        effort: this.config.agentEffort,
        env: { ...this.agentEnv(runDir), ...stack },
        log: nextLog(runDir),
        minutes: this.config.agentTimeoutMinutes,
        stateDir: this.config.stateDir,
        meter: meter.take,
      }).finally(meter.stop);
      this.log.write(key, "agent", session.result, {
        commit: await git(worktree, "rev-parse", "HEAD"),
        session: session.session,
        detail: session.detail,
        cost: session.cost,
        usage: session.usage,
        plan: session.plan,
      });
      if (session.result !== "usage-limit" || !(await this.pause(key, session.resets))) return session;
      if (session.session) prompt = USAGE_RESUME_PROMPT;
    }
  }

  /**
   * Logs the plan meter while an agent runs, when the reading changed, at most once in `meterSeconds`. A
   * reading that comes sooner waits for the time, and goes out then unless a newer one replaced it. At the
   * session's end, the agent line's `plan` holds the last reading, so `stop` drops one that still waits.
   */
  private meterLogger(key: string): { take: (reading: Meter) => void; stop: () => void } {
    let last = "";
    let at = 0;
    let held: Meter | null = null;
    let timer: NodeJS.Timeout | undefined;
    const write = () => {
      timer = undefined;
      if (!held) return;
      const text = JSON.stringify(held);
      if (text !== last) this.log.write(key, "meter", "read", { meter: held });
      last = text;
      at = Date.now();
      held = null;
    };
    return {
      take: (reading) => {
        held = reading;
        const wait = at + this.options.meterSeconds * 1000 - Date.now();
        if (wait <= 0) write();
        else timer ??= setTimeout(write, wait);
      },
      stop: () => {
        clearTimeout(timer);
        held = null;
      },
    };
  }

  /**
   * Waits for a usage limit that resets within MAX_USAGE_WAIT_SECONDS, and returns false for any other, which
   * stops the run. The pause is the run's, so each ticket that meets the limit waits for the same reset.
   */
  private async pause(key: string, resets: number | null): Promise<boolean> {
    if (resets === null || resets - Date.now() / 1000 > MAX_USAGE_WAIT_SECONDS) {
      const detail =
        resets === null
          ? "The usage limit gave no reset time."
          : `The usage limit resets at ${iso(resets)}, past the ${MAX_USAGE_WAIT_SECONDS / 3600} h the loop waits.`;
      this.log.write(key, "usage-pause", "stop", { detail });
      if (!this.halt) {
        this.halt = "usage-limit";
        await this.notify(`${this.name} stopped at a usage limit`);
      }
      return false;
    }
    const first = this.pausedUntil <= Date.now();
    this.pausedUntil = Math.max((resets + PAST_RESET_SECONDS) * 1000, this.pausedUntil);
    this.log.write(key, "usage-pause", "ok", { detail: `The usage limit resets at ${iso(resets)}.`, resumes: iso(this.pausedUntil / 1000) });
    if (first) await this.notify(`${this.name} paused`);
    await this.untilResumed();
    return true;
  }

  private async untilResumed(): Promise<void> {
    while (Date.now() < this.pausedUntil) await sleep((this.pausedUntil - Date.now()) / 1000);
  }

  /** The fix attempts since the ticket was last stuck, from the log, so a restart keeps the count. */
  private fixes(key: string): number {
    let count = 0;
    for (const line of this.log.lines()) {
      if (line.ticket !== key) continue;
      if (line.step === "stuck" && line.result === "started") count = 0;
      if (line.step === "build" && line.result === "started" && Number(line.attempt) > 1) count++;
    }
    return count;
  }

  /** One message with the end of each failed job's log and the review's blocking findings. */
  private async fixPrompt(url: string, checks: github.Check[]): Promise<string> {
    const repo = this.config.repo;
    let text = `The merge gate is red on ${url}. Fix the cause and commit the fix. Do not push: the loop pushes, and the gate runs again.\n`;
    for (const check of checks.filter((item) => item.bucket === "fail" || item.bucket === "cancel")) {
      text += `\n## ${check.name}\n\n`;
      try {
        const log = await github.failedLog(repo, check.link, LOG_TAIL_LINES);
        text += log ? `The end of its log:\n\n\`\`\`\n${log}\n\`\`\`\n` : `It is no Actions job. It is at ${check.link}.\n`;
      } catch (error) {
        text += `The loop could not read its log at ${check.link}: ${(error as Error).message}\n`;
      }
    }
    try {
      const findings = await github.blockingFindings(repo, Number(url.split("/").at(-1)));
      if (findings.length) {
        text += "\n## The review's blocking findings\n\n";
        text += findings.map((item) => `- \`${item.path}${item.line ? `:${item.line}` : ""}\` ${item.sentence}`).join("\n") + "\n";
      }
    } catch (error) {
      text += `\nThe loop could not read the review: ${(error as Error).message}\n`;
    }
    return text;
  }

  /** Flags the ticket, comments the reason and the pull request, and notifies. Its pull request stays open. */
  private async stuck(key: string, reason: string, url: string | null): Promise<Finished> {
    const pr = url ? `The pull request is ${url}.\n` : "";
    const comment = `${STUCK_COMMENT}\n${reason}\n${pr}The log is ${this.log.path} on ${hostname()}.`;
    this.log.write(key, "stuck", "started", { pr: url, detail: reason, comment });
    try {
      if (!(await this.jira.comments(key)).includes(comment)) await this.jira.comment(key, comment);
      await this.jira.flag(key);
      this.log.write(key, "stuck", "ok", { pr: url, detail: reason });
    } catch (error) {
      this.log.write(key, "stuck", "fail", { pr: url, detail: `${reason} ${(error as Error).message}` });
    }
    await this.notify(`${key} stuck`);
    return "stuck";
  }

  private async autoMerge(url: string): Promise<[boolean, string]> {
    try {
      await github.autoMerge(this.config.repo, url);
      return [true, ""];
    } catch (error) {
      return [false, `Auto-merge is off: ${(error as Error).message}`];
    }
  }

  /** Waits until a stacked pull request targets main, or its blocker stops without a merge. */
  private async untilMain(url: string, blocker: string): Promise<"main" | "stopped" | "timeout"> {
    const deadline = Date.now() + WAIT_MINUTES * 60_000;
    for (;;) {
      const pr = await github.view(this.config.repo, url).catch(() => null);
      if (pr?.baseRefName === this.config.mainBranch) return "main";
      if (this.stopped.has(blocker)) return "stopped";
      if (Date.now() >= deadline) return "timeout";
      await sleep(this.options.pollSeconds);
    }
  }

  /**
   * GitHub retargets a pull request to main when its base merges and the branch is deleted. Each open pull
   * request still on the merged branch is one GitHub did not retarget, and the loop moves it to the merged
   * pull request's base.
   */
  private async retarget(key: string, branch: string, base: string): Promise<void> {
    let dependents: github.PullRequest[];
    try {
      dependents = await github.stackedOn(this.config.repo, branch);
    } catch (error) {
      this.log.write(key, "retarget", "fail", { detail: (error as Error).message });
      return;
    }
    for (const pr of dependents) {
      const owner = /^(?:feat|fix)\/([A-Z][A-Z0-9]*-\d+)-/.exec(pr.headRefName)?.[1] ?? key;
      try {
        await github.retarget(this.config.repo, pr.url, base);
        this.log.write(owner, "retarget", "ok", { pr: pr.url, detail: `${branch} merged, so it targets ${base}.` });
      } catch (error) {
        this.log.write(owner, "retarget", "fail", { pr: pr.url, detail: (error as Error).message });
      }
    }
  }

  /** The ticket's branch from an earlier run, here or on origin, else the name the loop gives a new one. */
  private async branchOf(ticket: Ticket): Promise<{ branch: string; local: boolean; remote: boolean }> {
    const refs = await git(
      this.config.repo,
      "for-each-ref",
      "--format=%(refname)",
      ...branchPrefixes(ticket.key).flatMap((prefix) => [`refs/heads/${prefix}*`, `refs/remotes/origin/${prefix}*`]),
    );
    const found = refs.split("\n").filter(Boolean);
    const local = found.find((ref) => ref.startsWith("refs/heads/"));
    const remote = found.find((ref) => ref.startsWith("refs/remotes/origin/"));
    const type = ticket.issueType === "Bug" ? "fix" : "feat";
    const branch = local?.slice("refs/heads/".length) ?? remote?.slice("refs/remotes/origin/".length) ?? `${type}/${ticket.key}-${slug(ticket.summary)}`;
    return { branch, local: local !== undefined, remote: remote !== undefined };
  }

  /** Reuses the ticket's branch and worktree from an earlier run, or branches from the base: main, or the blocker's branch. */
  private async worktree(ticket: Ticket, path: string, base: string): Promise<string> {
    const repo = this.config.repo;
    const { branch, local, remote } = await this.branchOf(ticket);
    await git(repo, "worktree", "prune");
    if (existsSync(path)) return branch;
    if (local) await git(repo, "worktree", "add", "--quiet", path, branch);
    else if (remote) await git(repo, "worktree", "add", "--quiet", "--track", "-b", branch, path, `origin/${branch}`);
    else await git(repo, "worktree", "add", "--quiet", "--no-track", "-b", branch, path, `origin/${base}`);
    return branch;
  }

  private async writeTicket(ticket: Ticket, branch: string, runDir: string, stack: { key: string; branch: string } | null): Promise<void> {
    let text = `# ${ticket.key}: ${ticket.summary}\n\n${ticket.text.trim()}\n\n`;
    const comments = await this.jira.comments(ticket.key);
    if (comments.length) {
      text += "## Comments\n\nThe comments on the ticket, oldest first.\n\n";
      text += comments.join("\n\n---\n\n") + "\n\n";
    }
    text += "## Loop\n\n";
    if (this.epic) text += `- The Epic is ${this.epic}.\n`;
    text +=
      `- Commit on the branch \`${branch}\` with ${ticket.key} as the commit scope. ` +
      "Do not push, and do not open a pull request.\n" +
      (stack ? `- The branch stacks on \`${stack.branch}\`, the open pull request of ${stack.key}, and its pull request targets that branch.\n` : "") +
      `- The run folder is \`${runDir}\`.\n` +
      "- After you return done, the loop pushes the branch and opens a pull request with auto-merge on. " +
      "The merge gate runs every check on it. Run the tests that cover your change.\n";
    if (this.config.agentHint) text += `- ${this.config.agentHint}\n`;
    writeFileSync(join(runDir, "ticket.md"), text);
  }

  /** The open pull request of the branch, or a new one whose title becomes the squash commit on main. */
  private async pullRequest(ticket: Ticket, branch: string, runDir: string, base: string, reason: string, decisions: string[]): Promise<string> {
    const repo = this.config.repo;
    const open = (await github.pullRequestsOf(repo, ticket.key, branch, branchPrefixes(ticket.key))).find((pr) => pr.state === "OPEN");
    if (open) return open.url;
    const bodyFile = join(runDir, "pr-body.md");
    if (!existsSync(bodyFile)) {
      const browse = `${this.config.trackerUrl.replace(/\/$/, "")}/browse/${ticket.key}`;
      let body = `[${ticket.key}](${browse}): ${ticket.summary}\n\n${reason}\n`;
      if (decisions.length) body += `\n## Decisions\n\n${decisions.map((item) => `- ${item}`).join("\n")}\n`;
      writeFileSync(bodyFile, body);
    }
    const type = ticket.issueType === "Bug" ? "fix" : "feat";
    return github.create(repo, branch, base, `${type}(${ticket.key}): ${ticket.summary}`, bodyFile);
  }

  /**
   * Polls until a check fails, the pull request merges, or the wait runs out. With auto-merge on, GitHub
   * merges once every required check passes, so a check that has not reported yet keeps the loop waiting.
   * With auto-merge off, every check reported so far passing is green, and the loop merges. The checks count
   * once the pull request's head is the pushed commit, so the checks of the commit before a fix never do.
   */
  private async wait(
    url: string,
    autoMerge: boolean,
    commit: string,
  ): Promise<{ result: "green" | "red" | "timeout"; checks: github.Check[]; detail: string; closed: boolean }> {
    const repo = this.config.repo;
    const deadline = Date.now() + WAIT_MINUTES * 60_000;
    let checks: github.Check[] = [];
    for (;;) {
      const pr = await github.view(repo, url).catch(() => null);
      if (pr?.state === "MERGED") {
        // The checks as they were when GitHub merged, which the poll before the merge may not have seen.
        const last = await github.checks(repo, url).catch(() => null);
        return { result: "green", checks: last ?? checks, detail: "", closed: false };
      }
      if (pr?.state === "CLOSED") return { result: "red", checks, detail: "The pull request was closed.", closed: true };
      if (pr?.headRefOid === commit) {
        try {
          checks = await github.checks(repo, url);
        } catch (error) {
          console.error((error as Error).message);
        }
        const red = checks.filter((check) => check.bucket === "fail" || check.bucket === "cancel");
        if (red.length) return { result: "red", checks, detail: `Failed: ${red.map((check) => check.name).join(", ")}`, closed: false };
        const passed = checks.length > 0 && checks.every((check) => check.bucket === "pass" || check.bucket === "skipping");
        if (passed && !autoMerge) return { result: "green", checks, detail: "", closed: false };
      }
      if (Date.now() >= deadline) return { result: "timeout", checks, detail: `The checks ran past ${WAIT_MINUTES} min.`, closed: false };
      await sleep(this.options.pollSeconds);
    }
  }

  /** Auto-merge merges a green pull request. The loop merges it when auto-merge is off, and returns the commit. */
  private async merge(url: string): Promise<string | null> {
    const repo = this.config.repo;
    for (let attempt = 0; attempt < 5; attempt++) {
      const pr = await github.view(repo, url);
      if (pr.state === "MERGED") return pr.mergeCommit?.oid ?? "";
      if (pr.state === "CLOSED") return null;
      if (attempt === 1) await github.merge(repo, url).catch((error: Error) => console.error(error.message));
      await sleep(this.options.pollSeconds);
    }
    return null;
  }

  private async status(key: string, status: string): Promise<void> {
    try {
      await this.jira.transition(key, status);
      this.log.write(key, "tracker-status", "ok", { detail: status });
    } catch (error) {
      this.log.write(key, "tracker-status", "fail", { detail: `${status}: ${(error as Error).message}` });
    }
  }

  private agentEnv(runDir: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) if (value !== undefined && name !== "BW_SESSION") env[name] = value;
    return { ...env, ...this.secrets, LOOP_RUN_DIR: runDir, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" };
  }

  /** The env of the slot's stack, on its ports, as the Python loop sets them. A repo with no stack has none. */
  private slotEnv(slot: number, key: string): Record<string, string> {
    const stack = this.config.stack!;
    const env: Record<string, string> = {};
    for (const [port, base] of Object.entries(stack.ports)) env[port] = String(base + stack.portStep * slot);
    // Compose accepts lowercase project names only.
    env.COMPOSE_PROJECT_NAME = `${this.config.name}-${key.toLowerCase()}`;
    return env;
  }

  /**
   * The env of the slot's stack, on ports that no other Compose project holds. When another project, such as
   * a stack from a session outside the loop, holds one, the slot moves to a free spare slot for the rest of the
   * run, as in the Python loop. With no spare slot free, it throws PortsTaken.
   */
  private async stackEnv(key: string, slot: number): Promise<Record<string, string>> {
    if (!this.config.stack) return {};
    const env = this.slotEnv(this.slotMoves.get(slot) ?? slot, key);
    const held = await this.heldPorts(env.COMPOSE_PROJECT_NAME!);
    // No await from here on, so two tickets never take the same spare slot.
    const taken = this.taken(env, held);
    if (!taken) return env;
    const first = EPIC_SLOT + this.config.parallel + 1;
    for (let spare = first; spare < first + SPARE_SLOTS; spare++) {
      const moved = this.slotEnv(spare, key);
      if (![...this.slotMoves.values()].includes(spare) && !this.taken(moved, held)) {
        this.slotMoves.set(slot, spare);
        this.log.write(key, "slot", "moved", { detail: `${taken} The stack moved to slot ${spare}.` });
        return moved;
      }
    }
    throw new PortsTaken(`${taken} No spare slot has its ports free.`);
  }

  /** Which of the stack's ports another project holds, as a sentence, or "" when none is held. */
  private taken(env: Record<string, string>, held: Map<number, string>): string {
    return Object.keys(this.config.stack!.ports)
      .map((name) => Number(env[name]))
      .filter((port) => held.has(port))
      .map((port) => `Port ${port} is held by the container ${held.get(port)}.`)
      .join(" ");
  }

  /** The host ports that the running containers of other Compose projects publish, with the container of each. */
  private async heldPorts(project: string): Promise<Map<number, string>> {
    const format = '{{.Label "com.docker.compose.project"}}\t{{.Names}}\t{{.Ports}}';
    const listed = await run("docker", ["ps", "--format", format], { cwd: this.home, seconds: 60 });
    const held = new Map<number, string>();
    for (const line of listed.code === 0 ? listed.stdout.split("\n") : []) {
      const [owner, container, published] = line.split("\t");
      if (!container || owner === project) continue;
      for (const [, low, high] of (published ?? "").matchAll(PUBLISHED_PORT)) {
        for (let port = Number(low); port <= Number(high ?? low); port++) held.set(port, container);
      }
    }
    return held;
  }

  /** An ntfy message holds the run and its result only. */
  private async notify(message: string): Promise<void> {
    const url = `${this.config.ntfyUrl.replace(/\/$/, "")}/${this.secrets.NTFY_TOPIC}`;
    try {
      const response = await fetch(url, { method: "POST", body: message, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.log.write(this.name, "notify", "ok", { detail: message });
    } catch (error) {
      this.log.write(this.name, "notify", "fail", { detail: `${message}: ${(error as Error).message}` });
    }
  }
}

function nextLog(runDir: string): string {
  const taken = readdirSync(runDir).filter((name) => /^agent-\d+\.jsonl$/.test(name)).length;
  return join(runDir, `agent-${taken + 1}.jsonl`);
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
