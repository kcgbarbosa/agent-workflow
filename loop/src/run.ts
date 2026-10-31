// A run turns each ticket of the frontier into one pull request. A ticket is a fixed list of steps: build,
// push, pull request, wait, merge. The gate on GitHub checks the work, so the loop runs no gate, no review,
// no landing, and no Epic branch of its own. A red gate resumes the agent as a fix attempt, and a ticket whose
// blocker has an open pull request stacks on it. A restart starts each ticket at its first step.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { ask, type Meter, runSetup, type Session } from "./agent.ts";
import { archive, mdLinks, specLinks } from "./archive.ts";
import type { Config } from "./config.ts";
import { git, gitOk, originUrl, slug } from "./git.ts";
import * as github from "./github.ts";
import { endAll, run } from "./spawn.ts";
import { type Ticket, Jira } from "./jira.ts";
import { Log } from "./log.ts";

/** The longest the loop waits for the checks of one pull request. */
const WAIT_MINUTES = 120;

/** The lines of a failed job's log that a fix attempt gets. */
const LOG_TAIL_LINES = 80;

/** A usage limit that resets later than this stops the run. */
const MAX_USAGE_WAIT_SECONDS = 6 * 60 * 60;

/** The run resumes this long after the reset, so the first call after it meets no limit. */
const PAST_RESET_SECONDS = 60;

/** The slot the old loop gave the Epic branch. The tickets take the slots after it, so a repo's ports stay as they were. */
const EPIC_SLOT = 1;

/** The slots after the ticket slots that a ticket's stack moves to when another project holds its ports. */
const SPARE_SLOTS = 8;

/** A host port that `docker ps` lists as published, alone or as a range. */
const PUBLISHED_PORT = /:(\d+)(?:-(\d+))?->/g;

const USAGE_RESUME_PROMPT = "The run stopped at a usage limit, which has now reset. Continue the work.";

const STUCK_COMMENT = "The loop stopped this ticket.";

/** The status a ticket takes when its pull request merges, and an Epic when its last ticket merges. */
const DONE = "Done";

/** The lines of a failed setup's output that the stuck reason quotes. */
const SETUP_TAIL = 20;

/** The required check that fails while the pull request has the hold label. It is a pause, not a red gate, as a draft is. */
const HOLD_CHECK = "hold";

/** The types of a ticket's branch and commit scope: `fix` for a Bug, `feat` for the rest. */
const BRANCH_TYPES = ["feat", "fix"];

/** The key in a branch the loop named, `<type>/<KEY>-<slug>`. */
const BRANCH_KEY = new RegExp(`^(?:${BRANCH_TYPES.join("|")})/([A-Z][A-Z0-9]*-\\d+)-`);

/** A repo path of a Markdown file, as a ticket names its spec. */
const MD_PATH = /[\w./-]+\.md\b/;

/** The Spec line of an Epic's description. */
const SPEC_LINE = /^\s*\**spec\**[.:]/i;

/** The component of a ticket that a person does, which no loop builds. */
const MANUAL = "manual";

export type Target = { key: string } | { filter: string };

/** `meterSeconds` is the least time between two plan meter lines of a running agent. */
export type Options = { pollSeconds: number; meterSeconds: number };

type State = "merged" | "done" | "flagged" | "ready" | "waiting";

type Finished = "merged" | "stopped" | "stuck";

/** A pull request this run opened and that has not merged, which a dependent ticket stacks on. */
type OpenPr = { url: string; branch: string };

/** The blocker whose open pull request a ticket stacks on. */
type Stack = { key: string } & OpenPr;

class PortsTaken extends Error {}

/** A frontier the run refuses to build. */
class Refused extends Error {}

export function runName(target: Target): string {
  if ("key" in target) return target.key;
  return `filter-${createHash("sha256").update(target.filter).digest("hex").slice(0, 8)}`;
}

function branchPrefixes(key: string): string[] {
  return BRANCH_TYPES.map((type) => `${type}/${key}-`);
}

function specLineOf(text: string): string {
  return text.split("\n").find((line) => SPEC_LINE.test(line)) ?? "";
}

function typeOf(ticket: Ticket): string {
  return ticket.issueType === "Bug" ? "fix" : "feat";
}

/** A check as a `wait` line keeps it: its name, its bucket, and the link to its run. */
function logged({ name, bucket, link }: github.Check): { name: string; bucket: string; link?: string } {
  return link ? { name, bucket, link } : { name, bucket };
}

/** The checks that make the gate red. */
function redChecks(checks: github.Check[]): github.Check[] {
  return checks.filter((check) => check.bucket === "fail" || check.bucket === "cancel");
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
  /** The Epic's description, whose Spec line names the spec that each pull request body names. */
  private epicText: Promise<string> | null = null;
  /** The summary of the Epic or ticket the run started with, for the watch page. */
  private summary: string | null = null;
  /** The Epic's children, of every component, when the run started with the Epic. */
  private children: Ticket[] | null = null;
  private readonly merged = new Set<string>();
  /** The address of each merged pull request, which names the repo on GitHub. */
  private readonly mergedUrls: string[] = [];
  private readonly byKey = new Map<string, Ticket>();
  private readonly open = new Map<string, OpenPr>();
  /** The tickets that finished in this run without a merge. */
  private readonly stopped = new Set<string>();
  /** Why no new ticket starts: the circuit breaker or a usage limit the loop does not wait for. */
  private halt: "circuit-breaker" | "usage-limit" | null = null;
  private stopping = false;
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
    let tickets: Ticket[];
    try {
      tickets = await this.tickets();
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      console.error(error.message);
      this.log.write(this.name, "stop", "refused", { detail: error.message });
      await this.notify(`${this.name} refused: ${error.message}`);
      return 2;
    }
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
      // A kill after a merge can leave a dependent on the merged branch, and the ticket's worktree and branch.
      await this.afterMerge(key, pr.headRefName, pr.baseRefName);
    }

    // Slot 0 is the main checkout and slot 1 stays free, so the tickets take 2 and up.
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
    let stillOpen = "";
    try {
      const epic = await this.jira.ticket(this.epic);
      if (epic.done) return false;
      const children = this.children ?? (await this.jira.search(`parent = ${this.epic} ORDER BY key ASC`));
      if (!children.length || !children.every((child) => this.merged.has(child.key) || child.done)) return false;
      // The spec lives in the repo that the Spec line links, which can be another repo than this run's.
      const here = await this.repoUrl();
      const specRepo = mdLinks(specLineOf(epic.text))[0]?.prefix ?? here;
      if (!specRepo) throw new Error(`The Spec line of ${this.epic} links no repo and no pull request of it merged, so the loop does not know the repo on GitHub.`);
      const config = specRepo.toLowerCase() === here?.toLowerCase() ? this.config : await this.cloneOf(specRepo);
      const archived = await archive(config, this.jira, epic, specRepo, this.home);
      this.log.write(this.name, "archive", archived.result, { detail: archived.detail, pr: archived.pr });
      // The archive pull request merges on its own once its gate is green, and the Epic does not wait for it.
      if (archived.result === "pr-open") stillOpen = ` The archive pull request ${archived.pr} is still open.`;
    } catch (error) {
      this.log.write(this.name, "archive", "fail", { detail: `${this.epic}: ${(error as Error).message}` });
      return false;
    }
    try {
      await this.jira.transition(this.epic, DONE);
      this.log.write(this.name, "complete", "ok", { detail: `${this.epic} is ${DONE}.${stillOpen}` });
    } catch (error) {
      this.log.write(this.name, "complete", "fail", { detail: `${this.epic}: ${(error as Error).message}` });
      return false;
    }
    await this.notify(`${this.epic} complete`);
    return true;
  }

  /**
   * The tickets of the run's component among the Epic's children, the one ticket of a key, or the tickets a
   * filter finds. A ticket of another component, `manual` included, counts only as a blocker, through its
   * status. A ticket with no component refuses the run.
   */
  private async tickets(): Promise<Ticket[]> {
    let tickets: Ticket[];
    if ("filter" in this.target) tickets = await this.jira.search(this.target.filter);
    else {
      const ticket = await this.jira.ticket(this.target.key);
      this.summary = ticket.summary;
      if (ticket.issueType === "Epic") {
        this.epic = ticket.key;
        this.epicText = Promise.resolve(ticket.text);
        tickets = this.children = await this.jira.search(`parent = ${ticket.key} ORDER BY key ASC`);
      } else {
        this.epic = ticket.parent;
        tickets = [ticket];
      }
    }
    const none = tickets.filter((ticket) => !ticket.components.length).map((ticket) => ticket.key);
    if (none.length) {
      const have = none.length === 1 ? "has" : "have";
      throw new Refused(`${none.join(", ")} ${have} no component. Set the Jira component of each to the repo it changes, or ${MANUAL} for work no loop builds.`);
    }
    return tickets.filter((ticket) => ticket.components.includes(this.config.component));
  }

  /** The repo on GitHub of this run: the one of a merged pull request, or the origin remote. */
  private async repoUrl(): Promise<string | null> {
    return this.mergedUrls[0]?.split("/pull/")[0] ?? (await originUrl(this.config.repo));
  }

  /** The config of a clone of another repo, in the run's folder, for the archive of a spec that lives there. */
  private async cloneOf(repoUrl: string): Promise<Config> {
    const folder = join(this.home, "repos", repoUrl.split("/").slice(-2).join("-"));
    if (existsSync(folder)) await git(folder, "fetch", "--prune", "--quiet", "origin");
    else await github.clone(this.config.repo, repoUrl, folder);
    const head = await git(folder, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
    return { ...this.config, repo: folder, mainBranch: head.replace(/^origin\//, "") };
  }

  private state(ticket: Ticket): State {
    if (this.merged.has(ticket.key)) return "merged";
    if (ticket.done) return "done";
    if (ticket.flagged) return "flagged";
    return !this.openBlockers(ticket).length || this.stackOn(ticket) ? "ready" : "waiting";
  }

  /** The blockers that are neither done in the tracker nor merged. */
  private openBlockers(ticket: Ticket): { key: string; done: boolean }[] {
    return ticket.blockers.filter((blocker) => !blocker.done && !this.merged.has(blocker.key));
  }

  /**
   * The blocker whose open pull request the ticket stacks on: its one blocker that has not merged, once that
   * blocker's pull request opened in this run. A ticket with two open blockers waits, since a branch has one base.
   */
  private stackOn(ticket: Ticket): Stack | null {
    const open = this.openBlockers(ticket);
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
    // Only a ticket's own start lines. A run on one ticket logs its start under the same key, with the result ok.
    const restart = this.log.lines().some((line) => line.ticket === key && line.step === "start" && (line.result === "new" || line.result === "restart"));
    await git(repo, "fetch", "--prune", "--quiet", "origin");
    const stack = this.stackOn(ticket);
    const base = stack?.branch ?? main;
    const { branch, added } = await this.worktree(ticket, worktree, base);
    this.log.write(key, "start", restart ? "restart" : "new", { detail: branch, slot, ...(stack ? { base, pr: stack.url } : {}) });
    if (ticket.status !== this.config.inProgress) await this.status(key, this.config.inProgress);
    await this.writeTicket(ticket, branch, runDir, stack);
    // A restart runs it again when the setup of the earlier run did not pass.
    const setUp = this.log.lines().some((line) => line.ticket === key && line.step === "worktree" && line.result === "setup");
    if (this.config.setup.length && (added || !setUp)) {
      const failed = await this.setup(key, worktree);
      if (failed) return this.stuck(key, failed, null);
    }

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
      this.log.write(key, "build", "pass", { commit, session: session.session, detail: session.detail });

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
          url = await this.pullRequest(ticket, branch, runDir, base, session.output?.reason ?? "");
        } catch (error) {
          this.log.write(key, "pr", "fail", { commit, detail: (error as Error).message });
          return "stopped";
        }
        let detail = "";
        const onMain = (await github.view(repo, url)).baseRefName === main;
        if (onMain) {
          [autoMerge, detail] = await this.autoMerge(url);
        } else {
          detail = `It stacks on ${base}, so auto-merge waits until it targets ${main}.`;
        }
        // An open question of the agent goes in the log, not in the body, where it would read as a blocker.
        const decisions = session.output?.decisions ?? [];
        this.log.write(key, "pr", "open", { commit, pr: url, auto_merge: autoMerge, detail, ...(decisions.length ? { decisions } : {}) });
        if (onMain && !autoMerge) this.log.write(key, "auto-merge", "fail", { pr: url, detail });
        this.open.set(key, { url, branch });
        this.wake();
        await this.status(key, this.config.inReview);
      }

      // Wait. A stacked pull request that is green waits for its base to merge, then waits on its checks
      // again with auto-merge on, since green so far may predate the review, so a check that turns red after
      // the retarget still gets a fix attempt. When auto-merge does not turn on, the loop merges on that green.
      let checks: Awaited<ReturnType<Run["wait"]>>;
      for (;;) {
        checks = await this.wait(key, url, autoMerge, commit);
        this.log.write(key, "wait", checks.result, {
          commit,
          pr: url,
          checks: checks.checks.map(logged),
          detail: checks.detail,
        });
        if (checks.result !== "green" || autoMerge || !stack) break;
        if ((await github.view(repo, url)).baseRefName !== main) {
          const result = await this.untilMain(url, stack.key);
          this.log.write(key, "base", result, { pr: url, detail: result === "main" ? `${stack.key} merged.` : `${stack.key} did not merge.` });
          if (result !== "main") return "stopped";
        }
        autoMerge = await this.turnOnAutoMerge(key, url);
        if (!autoMerge) break;
      }
      if (checks.result === "green") break;
      if (checks.result !== "red" || checks.closed) return "stopped";
      red = checks.detail;
      prompt = await this.fixPrompt(url, checks.checks);
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
    await this.afterMerge(key, branch, (await github.view(repo, url)).baseRefName);
    return "merged";
  }

  /**
   * Moves a merged ticket to Done unless it is already done, also one that merged before this run, then moves its
   * dependents to its base, and removes its worktree and branch.
   */
  private async afterMerge(key: string, branch: string, base: string): Promise<void> {
    if (!this.byKey.get(key)?.done) await this.status(key, DONE);
    await this.retarget(key, branch, base);
    await this.removeWorktree(key, branch);
  }

  /**
   * Removes a merged ticket's worktree and local branch, so neither piles up on the host. The pull request and
   * the log keep its history. A ticket that stops keeps both, so a restart resumes on them.
   */
  private async removeWorktree(key: string, branch: string): Promise<void> {
    const repo = this.config.repo;
    const worktree = join(this.home, "worktrees", key);
    try {
      const hasWorktree = existsSync(worktree);
      const hasBranch = await gitOk(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
      if (!hasWorktree && !hasBranch) return;
      // A folder deleted by hand leaves git still registering the worktree, and `branch --delete` refuses then.
      if (hasWorktree) await git(repo, "worktree", "remove", "--force", worktree);
      else await git(repo, "worktree", "prune");
      if (hasBranch) await git(repo, "branch", "--delete", "--force", branch);
      this.log.write(key, "worktree", "removed", { detail: worktree });
    } catch (error) {
      this.log.write(key, "worktree", "fail", { detail: (error as Error).message });
    }
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
    for (const check of redChecks(checks).filter((item) => item.name !== HOLD_CHECK)) {
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

  /** Turns auto-merge on again, and logs why when it stays off, so the loop merges on the next green. */
  private async turnOnAutoMerge(key: string, url: string): Promise<boolean> {
    const [on, detail] = await this.autoMerge(url);
    if (!on) this.log.write(key, "auto-merge", "fail", { pr: url, detail });
    return on;
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
      const owner = BRANCH_KEY.exec(pr.headRefName)?.[1] ?? key;
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
    const branch =
      local?.slice("refs/heads/".length) ?? remote?.slice("refs/remotes/origin/".length) ?? `${typeOf(ticket)}/${ticket.key}-${slug(ticket.summary)}`;
    return { branch, local: local !== undefined, remote: remote !== undefined };
  }

  /**
   * Reuses the ticket's branch and worktree from an earlier run, or branches from the base: main, or the blocker's
   * branch. `added` is true when the worktree is new.
   */
  private async worktree(ticket: Ticket, path: string, base: string): Promise<{ branch: string; added: boolean }> {
    const repo = this.config.repo;
    const { branch, local, remote } = await this.branchOf(ticket);
    await git(repo, "worktree", "prune");
    if (existsSync(path)) return { branch, added: false };
    if (local) await git(repo, "worktree", "add", "--quiet", path, branch);
    else if (remote) await git(repo, "worktree", "add", "--quiet", "--track", "-b", branch, path, `origin/${branch}`);
    else await git(repo, "worktree", "add", "--quiet", "--no-track", "-b", branch, path, `origin/${base}`);
    return { branch, added: true };
  }

  /** Runs `setup` in the ticket's worktree, and returns why it failed, with the tail of its output, or null. */
  private async setup(key: string, worktree: string): Promise<string | null> {
    const [command, ...args] = this.config.setup;
    const shown = this.config.setup.join(" ");
    const minutes = this.config.agentTimeoutMinutes;
    const done = await run(command!, args, { cwd: worktree, seconds: minutes * 60 });
    if (done.code === 0 && !done.timedOut) {
      this.log.write(key, "worktree", "setup", { detail: shown });
      return null;
    }
    const output = [done.stdout.trimEnd(), done.stderr.trimEnd()].filter(Boolean).join("\n");
    const tail = output.split("\n").slice(-SETUP_TAIL).join("\n");
    const why = done.timedOut ? `ran past its limit of ${minutes} min` : `exited with ${done.code}`;
    return `The setup command \`${shown}\` ${why} in ${worktree}. Its output ends:\n${tail}`;
  }

  private async writeTicket(ticket: Ticket, branch: string, runDir: string, stack: Stack | null): Promise<void> {
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

  /**
   * The open pull request of the branch, or a new one whose title becomes the squash commit on main. The body
   * holds the ticket text and names the spec, which the gate's review reads the work against.
   */
  private async pullRequest(ticket: Ticket, branch: string, runDir: string, base: string, reason: string): Promise<string> {
    const repo = this.config.repo;
    const open = (await github.pullRequestsOf(repo, ticket.key, branch, branchPrefixes(ticket.key))).find((pr) => pr.state === "OPEN");
    if (open) return open.url;
    const bodyFile = join(runDir, "pr-body.md");
    if (!existsSync(bodyFile)) {
      const browse = `${this.config.trackerUrl.replace(/\/$/, "")}/browse/${ticket.key}`;
      const spec = await this.specLine(ticket);
      let body = `[${ticket.key}](${browse}): ${ticket.summary}.${spec ? ` ${spec}` : ""}\n\n`;
      if (reason) body += `${reason}\n\n`;
      body += `## Ticket\n\n${ticket.text.trim()}\n`;
      writeFileSync(bodyFile, body);
    }
    return github.create(repo, branch, base, `${typeOf(ticket)}(${ticket.key}): ${ticket.summary}`, bodyFile);
  }

  /**
   * The `Spec:` line of the pull request body: the Markdown file of this repo that the Spec line of the Epic's
   * description links, else the first one of this repo the description links, else the first Markdown path on
   * a line of the ticket that names the spec, else none. The repo is the one `repoUrl` gives; when it is
   * unknown, a link to any repo counts.
   */
  private async specLine(ticket: Ticket): Promise<string> {
    if (this.epic) {
      this.epicText ??= this.jira.ticket(this.epic).then((epic) => epic.text);
      const text = await this.epicText.catch(() => "");
      const repoUrl = await this.repoUrl();
      const links = (part: string) => (repoUrl ? specLinks(part, repoUrl) : mdLinks(part));
      const [link] = [...links(specLineOf(text)), ...links(text)];
      if (link) return `Spec: [${link.path}](${link.url})`;
    }
    const named = ticket.text.split("\n").find((line) => /\bspec\b/i.test(line) && MD_PATH.test(line));
    const path = named ? MD_PATH.exec(named)?.[0] : null;
    return path ? `Spec: ${path}` : "";
  }

  /**
   * Polls until a check fails, the pull request merges, or the wait runs out. With auto-merge on, GitHub
   * merges once every required check passes, so a check that has not reported yet keeps the loop waiting.
   * With auto-merge off, every check reported so far passing is green, and the loop merges. The checks count
   * once the pull request's head is the pushed commit, so the checks of the commit before a fix never do. The
   * `hold` check fails while the hold label is on, and GitHub turns auto-merge off on a draft: each is a pause
   * the loop waits out, not a red gate, and the wait's limit does not run while it lasts.
   */
  private async wait(
    key: string,
    url: string,
    autoMerge: boolean,
    commit: string,
  ): Promise<{ result: "green" | "red" | "timeout"; checks: github.Check[]; detail: string; closed: boolean }> {
    const repo = this.config.repo;
    let deadline = Date.now() + WAIT_MINUTES * 60_000;
    let checks: github.Check[] = [];
    let held = false;
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
        const red = redChecks(checks).filter((check) => check.name !== HOLD_CHECK);
        if (red.length) return { result: "red", checks, detail: `Failed: ${red.map((check) => check.name).join(", ")}`, closed: false };
        const holdOn = redChecks(checks).some((check) => check.name === HOLD_CHECK);
        if (holdOn || pr.isDraft) {
          deadline = Date.now() + WAIT_MINUTES * 60_000;
          if (!held) {
            const why = pr.isDraft ? "The pull request is a draft." : "The hold label is on.";
            this.log.write(key, "wait", "held", { commit, pr: url, checks: checks.map(logged), detail: `${why} The loop waits until it is not.` });
          }
          held = true;
        } else {
          if (held && autoMerge) {
            // GitHub turns auto-merge off on a draft and does not turn it back on. When that fails, the loop merges.
            autoMerge = await this.turnOnAutoMerge(key, url);
          }
          held = false;
          const passed = checks.length > 0 && checks.every((check) => check.bucket === "pass" || check.bucket === "skipping");
          if (passed && !autoMerge) return { result: "green", checks, detail: "", closed: false };
        }
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

  /** The env of the slot's stack, on its ports. A repo with no stack has none. */
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
   * run. With no spare slot free, it throws PortsTaken.
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

  /** The SIGTERM of `loop stop`. It ends every agent session, and the step in progress writes no result. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.log.write(this.name, "stop", "stopped");
    this.log.close();
    await endAll();
    await this.send(`${this.name} stopped`);
  }

  /** The loop itself failed, such as on a tracker that does not answer. */
  async failed(error: Error): Promise<void> {
    this.log.write(this.name, "stop", "loop-error", { detail: error.message });
    await this.notify(`${this.name} stopped`);
  }

  private async notify(message: string): Promise<void> {
    if (!this.stopping) await this.send(message);
  }

  /** An ntfy message holds the run and its result only. */
  private async send(message: string): Promise<void> {
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
