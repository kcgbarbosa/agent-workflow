// The capacity forecast on the Usage view of `loop watch`: the open work in Jira, what the current plan fits, and what
// each Claude plan delivered.
//
// It reports only. No run reads it, and it reads Jira through one search and never writes.
import { existsSync, readdirSync } from "node:fs";
import type { Config } from "./config.ts";
import { Jira } from "./jira.ts";
import {
  allRuns,
  groupByTicket,
  iso,
  KEY,
  lineTime,
  type Merge,
  merges,
  planUsage,
  ticketKey,
} from "./report.ts";
import type { Line } from "./log.ts";

// Anthropic's published plans: the usage of each against Pro's, and the monthly price in US dollars, from
// https://claude.com/pricing. Anthropic states the multiple for the 5-hour window, and none for the week.
export type PlanInfo = { name: string; multiple: number; price: number };
export const PLANS: Record<string, PlanInfo> = {
  pro: { name: "Pro", multiple: 1, price: 20 },
  "max-5x": { name: "Max 5x", multiple: 5, price: 100 },
  "max-20x": { name: "Max 20x", multiple: 20, price: 200 },
};

/** The open Epics with their tickets are kept this long, so a page that stays open reads Jira at most this often. */
export const BACKLOG_MINUTES = 5;

const RESETS = /resets at (\S+?)\.?$/;
const WINDOWS = ["five_hour", "seven_day"] as const;
type Window = (typeof WINDOWS)[number];

export class BacklogError extends Error {}

type OpenEpic = { key: string; summary: string; status: string };
type EpicTicket = { key: string; status: string; done: boolean };
type Epic = OpenEpic & { tickets: EpicTicket[] };
type Backlog = { epics: Epic[] | null; error: string | null; read: string };

// --- The open work in Jira ---

async function openEpics(jira: Jira, projects: string[]): Promise<OpenEpic[]> {
  if (!projects.length) return [];
  const jql = `project in (${projects.join(", ")}) AND issuetype = Epic AND statusCategory != Done ORDER BY key ASC`;
  const issues = await jira.search(jql);
  return issues.map((issue) => ({ key: issue.key, summary: issue.summary, status: issue.status }));
}

/**
 * The open Epics of the projects, each with its tickets' keys and statuses. No ticket text, so the read can never
 * stand in for a ticket's spec.
 */
async function fetchBacklog(jira: Jira, projects: string[]): Promise<Epic[]> {
  const found = new Map<string, Epic>();
  for (const epic of await openEpics(jira, projects)) found.set(epic.key, { ...epic, tickets: [] });
  if (!found.size) return [];
  const issues = await jira.search(`parent in (${[...found.keys()].join(", ")}) ORDER BY key ASC`);
  for (const issue of issues) {
    const epic = issue.parent ? found.get(issue.parent) : undefined;
    if (epic) epic.tickets.push({ key: issue.key, status: issue.status, done: issue.done });
  }
  return [...found.values()];
}

/** The Jira projects of the Epics that ran on this host. */
export function projectKeys(stateDir: string): string[] {
  const homes = existsSync(stateDir) ? readdirSync(stateDir) : [];
  return [...new Set(homes.filter((name) => KEY.test(name)).map((name) => name.split("-")[0]))].sort();
}

/** Whether Jira has the ticket open and not in the status the loop gives a merged ticket. */
export function isOpen(ticket: { done: boolean; status: string }, landedStatus: string): boolean {
  return !ticket.done && ticket.status !== landedStatus;
}

export type Need = Partial<Record<Window, number>>;
export type Open = {
  epics: { key: string; summary: string; left: number | null; need: Need }[];
  left: number;
  need: Need;
};

/**
 * Each open Epic with its tickets left and the share of each window they need. A ticket is left when Jira has it
 * open, not in the merged status, and no run on this host merged it. An Epic with no tickets yet has none left to
 * count.
 */
function openWork(epics: Epic[], merged: Set<string>, landedStatus: string, each: Each | null): Open {
  const rows = epics.map((epic) => {
    const left = epic.tickets.filter((ticket) => isOpen(ticket, landedStatus) && !merged.has(ticket.key)).length;
    const tickets = epic.tickets.length ? left : null;
    return { key: epic.key, summary: epic.summary, left: tickets, need: need(tickets, each) };
  });
  const total = rows.reduce((sum, item) => sum + (item.left ?? 0), 0);
  return { epics: rows, left: total, need: need(total, each) };
}

/** The share of each window the tickets need, in percent of one window. */
function need(tickets: number | null, each: Each | null): Need {
  const found: Need = {};
  if (!each || tickets === null) return found;
  for (const window of WINDOWS) {
    const share = each[window];
    if (share !== null) found[window] = tickets * share;
  }
  return found;
}

// --- What each plan delivered ---

type PlanSpan = { plan: string; since: number; exact: boolean };

/** The plan spans of the config, in epoch seconds, oldest first. */
function planSpans(config: Config): PlanSpan[] {
  return config.plans
    .map((entry) => ({ plan: entry.plan, since: Date.parse(entry.since) / 1000, exact: entry.exact }))
    .sort((a, b) => a.since - b.since);
}

/**
 * The plan of a run: a plan key, `ambiguous` when a change may fall inside the run, or null before the first span. A
 * span with a date only leaves the runs of that day to either plan.
 */
function planOf(spans: PlanSpan[], start: number, end: number): string | null {
  let current: string | null = null;
  for (const span of spans) {
    const until = span.exact ? span.since : span.since + 86400;
    if (until <= start) {
      current = span.plan;
    } else if (span.since < end) {
      return span.plan === current ? span.plan : "ambiguous";
    } else {
      break;
    }
  }
  return current;
}

type Wait = { resets: string; since: number; until: number };
type Merged = Merge & { active_minutes: number | null };
type RunRecord = {
  epic: string;
  started: number;
  ended: number;
  plan: string | null;
  merged: Merged[];
  stuck: Set<string>;
  fixes: number;
  used: Record<string, number>;
  waits: Wait[];
};

/**
 * Each run on this host with its plan, its merged and stuck tickets, its fix rounds, its plan usage, and its
 * usage-limit waits.
 */
function runRecords(stateDir: string, spans: PlanSpan[]): RunRecord[] {
  return allRuns(stateDir).map(([epic, run]) => {
    const started = lineTime(run[0]);
    const ended = lineTime(run[run.length - 1]);
    const waits = waitsOf(run, ended);
    const merged = merges(groupByTicket(epic, run)).map((item): Merged => {
      const waited = waits.reduce((sum, wait) => sum + overlap(wait, item.start, item.merge), 0) / 60;
      return {
        ...item,
        active_minutes: item.minutes === null ? null : Math.max(0, item.minutes - waited),
      };
    });
    return {
      epic,
      started,
      ended,
      plan: planOf(spans, started, ended),
      merged,
      stuck: new Set(run.filter((line) => line.step === "stuck").map(ticketKey)),
      fixes: fixes(run),
      used: planUsage(run).used,
      waits,
    };
  });
}

/** The fix attempts of every ticket in the run, merged or not: each build after the first, sent back by a red check. */
function fixes(run: Line[]): number {
  return run.filter(
    (line) => line.step === "build" && line.result === "started" && typeof line.attempt === "number" && line.attempt > 1,
  ).length;
}

/**
 * Each wait for a usage limit to reset, from the first pause line that names the reset to the reset, or to the run's
 * last line when the run ended first. Parallel tickets wait for the same reset once.
 */
function waitsOf(run: Line[], ended: number): Wait[] {
  const first = new Map<string, number>();
  for (const line of run) {
    if (line.step !== "usage-pause" || line.result !== "ok") continue;
    const match = RESETS.exec(String(line.detail ?? ""));
    if (match && !first.has(match[1])) first.set(match[1], lineTime(line));
  }
  const waits: Wait[] = [];
  for (const [resets, since] of first) {
    const until = Date.parse(resets) / 1000;
    if (Number.isNaN(until)) continue;
    waits.push({ resets, since, until: Math.max(since, Math.min(until, ended)) });
  }
  return waits;
}

function overlap(wait: Wait, start: number | null, end: number): number {
  return Math.max(0, Math.min(wait.until, end) - Math.max(wait.since, start ?? end));
}

export type Period = {
  plan: string | null;
  name: string;
  runs: number;
  from: string | null;
  to: string | null;
  merged: number;
  first_pass_rate: number | null;
  fixes_per_merged: number | null;
  stuck: number;
  median_minutes: number | null;
  waits: number;
  waited_hours: number;
};

/**
 * What one plan delivered: the work merged, its rework, and its time. A usage limit counts once however many runs
 * waited for its reset, as when a run restarts and pauses again.
 */
function period(plan: string | null, records: RunRecord[]): Period {
  const merged = records.flatMap((record) => record.merged);
  const minutes = merged.flatMap((item) => (item.active_minutes === null ? [] : [item.active_minutes]));
  const waited = new Map<string, number>();
  for (const record of records) {
    for (const wait of record.waits) {
      waited.set(wait.resets, (waited.get(wait.resets) ?? 0) + wait.until - wait.since);
    }
  }
  const fixes = records.reduce((sum, record) => sum + record.fixes, 0);
  const info = planInfo(plan);
  const name = info ? info.name : plan === "ambiguous" ? "Unclear" : "Not set";
  const starts = records.map((record) => record.started);
  const ends = records.map((record) => record.ended);
  return {
    plan,
    name,
    runs: records.length,
    from: records.length ? iso(Math.min(...starts)) : null,
    to: records.length ? iso(Math.max(...ends)) : null,
    merged: merged.length,
    first_pass_rate: merged.length ? merged.filter((item) => item.first_pass).length / merged.length : null,
    fixes_per_merged: merged.length ? fixes / merged.length : null,
    stuck: new Set(records.flatMap((record) => [...record.stuck])).size,
    median_minutes: minutes.length ? median(minutes) : null,
    waits: waited.size,
    waited_hours: [...waited.values()].reduce((sum, hours) => sum + hours, 0) / 3600,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// --- What the current plan fits ---

function currentPlan(spans: PlanSpan[], now: number): string | null {
  const started = spans.filter((span) => span.since <= now);
  return started.at(-1)?.plan ?? null;
}

function planInfo(plan: string | null): PlanInfo | null {
  return plan !== null && Object.hasOwn(PLANS, plan) ? PLANS[plan] : null;
}

type Each = { tickets: number; runs: number; five_hour: number | null; seven_day: number | null };

/**
 * The share of each window, in percent, that one ticket needed in the plan's own runs: their total over their merged
 * tickets. A run that merged nothing counts toward the total, since its work went into tickets that merged later.
 */
function perTicket(records: RunRecord[], plan: string | null): Each | null {
  const own = records.filter((record) => record.plan === plan && Object.keys(record.used).length > 0);
  const tickets = own.reduce((sum, record) => sum + record.merged.length, 0);
  if (!tickets) return null;

  const share = (window: Window): number | null => {
    const used = own.filter((record) => window in record.used).map((record) => record.used[window]);
    return used.length ? used.reduce((sum, value) => sum + value, 0) / tickets : null;
  };
  return { tickets, runs: own.length, five_hour: share("five_hour"), seven_day: share("seven_day") };
}

export type Fit = { five_hour: number | null; week: number | null; weeks: number | null };
export type Capacity = Fit & {
  tickets: number;
  runs: number;
  bigger: (Fit & { name: string; price_more: number })[];
};

/**
 * The tickets that fit in a 5-hour window and in a week, the weeks the open work needs, and the same for each bigger
 * plan, scaled by its multiple.
 */
function capacity(each: Each | null, plan: string | null, left: number | null): Capacity | null {
  if (!each) return null;
  const { five_hour: five, seven_day: week } = each;

  const fits = (factor: number): Fit => ({
    five_hour: five ? (100 / five) * factor : null,
    week: week ? (100 / week) * factor : null,
    weeks: week && left !== null ? (left * week) / 100 / factor : null,
  });

  const current = planInfo(plan);
  const bigger =
    current === null
      ? []
      : Object.values(PLANS)
          .filter((other) => other.multiple > current.multiple)
          .map((other) => ({
            name: other.name,
            price_more: other.price - current.price,
            ...fits(other.multiple / current.multiple),
          }));
  return { tickets: each.tickets, runs: each.runs, ...fits(1), bigger };
}

// --- The view ---

export type View = {
  project: string;
  plan: ({ key: string } & PlanInfo) | null;
  jira: { read: string; error: string | null };
  open: Open | null;
  capacity: Capacity | null;
  periods: Period[];
  landed_status: string;
};

/** The forecast of one project, the one whose `loop.toml` started `loop watch`. */
export class Forecaster {
  private readonly config: Config;
  private readonly secrets: Record<string, string>;
  private kept: { at: number; found: Backlog } | null = null;
  private reading: Promise<Backlog> | null = null;

  constructor(config: Config, secrets: Record<string, string>) {
    this.config = config;
    this.secrets = secrets;
  }

  async view(): Promise<View> {
    const { config } = this;
    const spans = planSpans(config);
    const records = runRecords(config.stateDir, spans);
    const plan = currentPlan(spans, Date.now() / 1000);
    const order: (string | null)[] = [...Object.keys(PLANS), "ambiguous", null];
    const periods = order
      .filter((key) => records.some((record) => record.plan === key))
      .map((key) => period(key, records.filter((record) => record.plan === key)));
    const each = perTicket(records, plan);
    const merged = new Set(records.flatMap((record) => record.merged.map((item) => item.key)));
    const jira = await this.backlog();
    const work = jira.epics ? openWork(jira.epics, merged, config.inReview, each) : null;
    const info = planInfo(plan);
    return {
      project: config.name,
      plan: plan !== null && info ? { key: plan, ...info } : null,
      jira: { read: jira.read, error: jira.error },
      open: work,
      capacity: capacity(each, plan, work ? work.left : null),
      periods,
      landed_status: config.inReview,
    };
  }

  /** The Jira client of the project, from the secrets it was built with. */
  private client(): Jira {
    const email = this.secrets.JIRA_EMAIL;
    const token = this.secrets.JIRA_API_TOKEN;
    if (!email || !token) {
      throw new BacklogError("This host has no Jira secret in its secrets file. Run `loop secrets`.");
    }
    return new Jira(this.config.trackerUrl, email, token);
  }

  /** The backlog as the last read kept it, or a new read once `BACKLOG_MINUTES` have passed. A failed read is kept too. */
  private backlog(): Promise<Backlog> {
    if (this.kept && performance.now() - this.kept.at < BACKLOG_MINUTES * 60_000) {
      return Promise.resolve(this.kept.found);
    }
    this.reading ??= this.read().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  private async read(): Promise<Backlog> {
    let found: { epics: Epic[] | null; error: string | null };
    try {
      const projects = projectKeys(this.config.stateDir);
      if (!projects.length) throw new BacklogError("No run on this host names a Jira project yet.");
      found = { epics: await fetchBacklog(this.client(), projects), error: null };
    } catch (error) {
      found = { epics: null, error: (error as Error).message.slice(0, 300) };
    }
    const backlog: Backlog = { ...found, read: iso(Date.now() / 1000) };
    this.kept = { at: performance.now(), found: backlog };
    return backlog;
  }
}
