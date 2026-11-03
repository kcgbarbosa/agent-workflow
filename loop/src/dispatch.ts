// The dispatcher, `loop dispatch`, which `loop start` runs in the unit `loop-<name>-dispatch`. The tracker is the
// queue: every `poll_minutes` it reads `[queue] filter` and starts a worker, `loop run-ticket <KEY> --slot <n>`
// in the unit `loop-<name>-<KEY>`, for each ready ticket in the filter's order while a slot is free. It owns the
// slots, the circuit breaker, the hold of a usage limit, and the Epic check, and writes its own log at the top of
// the state folder. It never stops a worker: `loop stop` does.
import { join } from "node:path";
import type { Config } from "./config.ts";
import { completeEpic } from "./epic.ts";
import { originUrl, slug } from "./git.ts";
import * as github from "./github.ts";
import { Jira, type Ticket } from "./jira.ts";
import { ticketHome } from "./layout.ts";
import { DECISIONS, type Line, Log } from "./log.ts";
import { branchPrefixes, HOLD_LABEL, holdOf, MAX_USAGE_WAIT_SECONDS, typeOf } from "./run.ts";
import { composeProject, freeLeftSlots, portsFree, takeSlot } from "./slots.ts";
import { DISPATCH, runs, runUnit, startRun } from "./units.ts";

const KEY = /^[A-Z][A-Z0-9]*-\d+$/;

/** The JQL of the hourly Epic check. Each Epic it finds counts only when a child has the repo's component. */
const OPEN_EPICS = "issuetype = Epic AND statusCategory != Done ORDER BY key ASC";

export type DispatchOptions = { pollSeconds: number; epicSeconds: number };

/** How a worker ended, from its own log. */
type Ending = "merged" | "stuck" | "handed-back" | "usage-limit" | "stopped" | "gone";

export class Dispatcher {
  private readonly config: Config;
  private readonly secrets: Record<string, string>;
  private readonly options: DispatchOptions;
  private readonly jira: Jira;
  readonly log: Log;
  /** The worker units seen active, by key, so the next poll reads how each one ended. */
  private readonly workers = new Set<string>();
  /** The stuck workers in a row, which open the circuit breaker at `circuit_breaker`. */
  private stuckRow: string[] = [];
  private breakerOpen = false;
  /** Until when, in epoch milliseconds, no worker starts, for a usage limit. */
  private holdUntil = 0;
  /** The Epics of the tickets that merged since the last Epic check. */
  private readonly mergedParents = new Set<string>();
  private lastSweep = 0;
  /** The last queue line, so a poll that changes nothing writes none. */
  private lastQueue = "";
  /** The repo on GitHub, from a pull request the dispatcher saw. */
  private repoUrl: string | null = null;
  private stopping = false;

  constructor(config: Config, secrets: Record<string, string>, options: DispatchOptions) {
    this.config = config;
    this.secrets = secrets;
    this.options = options;
    this.jira = new Jira(config.trackerUrl, secrets.JIRA_EMAIL ?? "", secrets.JIRA_API_TOKEN ?? "");
    this.log = new Log(join(config.stateDir, DECISIONS), DISPATCH);
  }

  private own(step: string, result: string, extra: Record<string, unknown> = {}): void {
    this.log.write(DISPATCH, step, result, extra);
  }

  /** Polls until the unit stops. A poll that fails logs it and the next one goes on. */
  async run(): Promise<number> {
    this.own("start", "ok", { pid: process.pid, detail: this.config.queue.filter, parallel: this.config.parallel });
    while (!this.stopping) {
      try {
        await this.poll();
      } catch (error) {
        this.own("poll", "fail", { detail: (error as Error).message });
      }
      await new Promise((resolve) => setTimeout(resolve, this.options.pollSeconds * 1000));
    }
    return 0;
  }

  /** The SIGTERM of `loop stop`. The workers run on until `loop stop` stops each. */
  stop(): void {
    this.stopping = true;
    this.own("stop", "stopped");
    this.log.close();
  }

  private async poll(): Promise<void> {
    const active = new Set(await runs(this.config.name));
    freeLeftSlots(this.config.stateDir, active);
    for (const key of [...this.workers]) {
      if (active.has(key)) continue;
      this.workers.delete(key);
      await this.ended(key);
    }
    for (const name of active) if (KEY.test(name)) this.workers.add(name);
    if (this.breakerOpen) await this.closeBreaker();
    this.usagePause();
    await this.startReady(active);
    await this.checkEpics();
  }

  /** Reads how a worker ended, and counts it for the circuit breaker, the usage hold, and the Epic check. */
  private async ended(key: string): Promise<void> {
    const lines = sinceStart(this.workerLines(key));
    const ending = endingOf(lines);
    this.log.write(key, "worker", ending, { detail: `The worker of ${key} ended: ${ending}.` });
    if (ending === "merged") {
      this.stuckRow = [];
      const pr = lines.findLast((line) => line.step === "merge" && line.result === "merged")?.pr;
      if (typeof pr === "string") this.repoUrl ??= pr.split("/pull/")[0]!;
      try {
        const parent = (await this.jira.ticket(key)).parent;
        if (parent) this.mergedParents.add(parent);
      } catch (error) {
        this.log.write(key, "epic", "fail", { detail: (error as Error).message });
      }
    }
    if (ending === "stuck") {
      this.stuckRow.push(key);
      if (this.stuckRow.length >= this.config.circuitBreaker && !this.breakerOpen) {
        this.breakerOpen = true;
        const detail = `${this.stuckRow.join(", ")} are stuck in a row, so no ticket starts until one of them is unflagged.`;
        this.own("circuit-breaker", "open", { detail, tickets: [...this.stuckRow] });
        await this.notify(`${this.config.name} circuit breaker open`);
      }
    }
    if (ending === "usage-limit") {
      const until = Date.now() + MAX_USAGE_WAIT_SECONDS * 1000;
      const holding = this.holdUntil > Date.now();
      this.holdUntil = Math.max(this.holdUntil, until);
      this.own("hold", "usage-limit", { detail: `${key} met a usage limit with no reset in time, so no ticket starts until ${iso(this.holdUntil)}.`, until: iso(this.holdUntil) });
      if (!holding) await this.notify(`${this.config.name} holds at a usage limit`);
    }
  }

  /** The breaker closes once a ticket of the stuck row is no longer Flagged. */
  private async closeBreaker(): Promise<void> {
    for (const key of this.stuckRow) {
      if ((await this.jira.ticket(key)).flagged) continue;
      this.own("circuit-breaker", "closed", { detail: `${key} is no longer Flagged.` });
      this.breakerOpen = false;
      this.stuckRow = [];
      return;
    }
  }

  /** A running worker that waits for a usage limit to reset holds the next start until it resumes. */
  private usagePause(): void {
    for (const key of this.workers) {
      const pause = sinceStart(this.workerLines(key)).findLast((line) => line.step === "usage-pause" && line.result === "ok");
      const resumes = typeof pause?.resumes === "string" ? Date.parse(pause.resumes) : NaN;
      if (!(resumes > this.holdUntil)) continue;
      this.holdUntil = resumes;
      this.own("hold", "usage-pause", { detail: `${key} waits for a usage limit, so no ticket starts until ${iso(resumes)}.`, until: iso(resumes) });
    }
  }

  /** Starts a worker for each ready ticket of the queue, in its order, while a slot is free. */
  private async startReady(active: Set<string>): Promise<void> {
    const queue = await this.jira.search(this.config.queue.filter);
    const states: string[] = [];
    const held = this.breakerOpen ? "the circuit breaker is open" : this.holdUntil > Date.now() ? "a usage limit holds" : null;
    for (const ticket of queue) {
      const state = await this.stateOf(ticket, active);
      if (state === "ready" && !held && this.running(active) < this.config.parallel) {
        states.push(`${ticket.key} ${(await this.start(ticket.key, active)) ? "started" : "ready"}`);
      } else states.push(`${ticket.key} ${state}`);
    }
    const line = states.join(", ") || "No ticket is in the queue";
    if (`${line}|${held}` === this.lastQueue) return;
    this.lastQueue = `${line}|${held}`;
    this.own("queue", held ? "held" : "ok", { detail: held ? `${line}. No ticket starts: ${held}.` : `${line}.` });
  }

  private running(active: Set<string>): number {
    return [...active].filter((name) => KEY.test(name)).length;
  }

  /** Why a ticket of the queue starts or not. A ticket the filter should not have found never starts. */
  private async stateOf(ticket: Ticket, active: Set<string>): Promise<string> {
    if (active.has(ticket.key)) return "building";
    if (ticket.issueType === "Epic") return "an Epic";
    if (ticket.flagged) return "flagged";
    if (!ticket.components.includes(this.config.component)) return "not this component";
    if (ticket.done) return "merged";
    const prs = await this.pullRequests(ticket);
    if (prs.some((pr) => pr.state === "MERGED")) return "merged";
    for (const blocker of ticket.blockers) {
      if (blocker.done) continue;
      if (!(await this.pullRequests(await this.jira.ticket(blocker.key))).some((pr) => pr.state === "MERGED")) return `waiting on ${blocker.key}`;
    }
    // A handed-back ticket waits while its pull request is a draft, carries the hold label, or its hold runs.
    const open = prs.find((pr) => pr.state === "OPEN");
    if (open?.isDraft) return "a draft";
    if (open?.labels?.some((label) => label.name === HOLD_LABEL)) return "on hold";
    if (open) {
      const until = holdOf(await github.body(this.config.repo, open.url));
      if (until && until.getTime() > Date.now()) return `held until ${until.toISOString()}`;
    }
    return "ready";
  }

  /** Takes a slot with the `docker ps` rule, and starts the ticket's worker. False when no slot is free. */
  private async start(key: string, active: Set<string>): Promise<boolean> {
    const usable = await portsFree(this.config.stateDir, composeProject(this.config.name, key), this.config.stack);
    const unit = runUnit(this.config.name, key);
    const slot = takeSlot(this.config.stateDir, key, unit, this.config.parallel, active, usable);
    if (slot === null) return false;
    try {
      await startRun(this.config.repo, this.config.name, key, [key, "--slot", String(slot)], "run-ticket");
    } catch (error) {
      this.log.write(key, "worker", "fail", { detail: (error as Error).message, slot });
      return false;
    }
    active.add(key);
    this.workers.add(key);
    this.log.write(key, "worker", "started", { detail: `${key} builds in slot ${slot}, in ${unit}.`, slot, unit });
    return true;
  }

  /** The pull requests of the ticket's branch on GitHub. */
  private async pullRequests(ticket: Ticket): Promise<github.PullRequest[]> {
    const branch = `${typeOf(ticket)}/${ticket.key}-${slug(ticket.summary)}`;
    const prs = await github.pullRequestsOf(this.config.repo, ticket.key, branch, branchPrefixes(ticket.key));
    const merged = prs.find((pr) => pr.state === "MERGED");
    if (merged) this.repoUrl ??= merged.url.split("/pull/")[0]!;
    return prs;
  }

  /** The Epic check for the parent of each ticket that merged, and once an hour for every open Epic. */
  private async checkEpics(): Promise<void> {
    const epics = new Set(this.mergedParents);
    if (Date.now() - this.lastSweep >= this.options.epicSeconds * 1000) {
      this.lastSweep = Date.now();
      for (const epic of await this.jira.search(OPEN_EPICS)) {
        const children = await this.jira.search(`parent = ${epic.key} ORDER BY key ASC`);
        if (children.some((child) => child.components.includes(this.config.component))) epics.add(epic.key);
      }
    }
    const repoUrl = this.repoUrl ?? (await originUrl(this.config.repo));
    for (const epic of epics) {
      await completeEpic(
        {
          config: this.config,
          jira: this.jira,
          home: this.config.stateDir,
          log: (step, result, extra = {}) => this.log.write(epic, step, result, extra),
          notify: (message) => this.notify(message),
          merged: async (child) => (await this.pullRequests(child)).some((pr) => pr.state === "MERGED"),
          repoUrl,
        },
        epic,
      );
    }
    // Cleared only once each Epic check ran, so a throw before then keeps the parents for the next poll.
    for (const epic of epics) this.mergedParents.delete(epic);
  }

  private workerLines(key: string): Line[] {
    return new Log(join(ticketHome(this.config.stateDir, key), DECISIONS), key).lines();
  }

  /** An ntfy message holds the repo or ticket and its event only. */
  private async notify(message: string): Promise<void> {
    if (this.stopping) return;
    const url = `${this.config.ntfyUrl.replace(/\/$/, "")}/${this.secrets.NTFY_TOPIC}`;
    try {
      const response = await fetch(url, { method: "POST", body: message, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.own("notify", "ok", { detail: message });
    } catch (error) {
      this.own("notify", "fail", { detail: `${message}: ${(error as Error).message}` });
    }
  }
}

/** The lines of a worker's log from its last start on. */
function sinceStart(lines: Line[]): Line[] {
  const start = lines.findLastIndex((line) => line.run === true && line.step === "start" && line.result === "ok");
  return start < 0 ? [] : lines.slice(start);
}

/** How a worker ended: its `finish` line, or the `stop` line of a stop or a loop error. */
function endingOf(lines: Line[]): Ending {
  const own = lines.filter((line) => line.run === true);
  const finish = own.findLast((line) => line.step === "finish");
  if (finish?.result === "ok") return "merged";
  if (finish?.result === "stuck") return "stuck";
  if (finish?.result === "handed-back") return lines.some((line) => line.step === "hand-back" && line.result === "usage-limit") ? "usage-limit" : "handed-back";
  const stop = own.findLast((line) => line.step === "stop");
  if (stop?.result === "loop-error") return "stuck";
  if (stop?.result === "stopped") return "stopped";
  return "gone";
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}
