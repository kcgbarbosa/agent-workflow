// The report of one run: what it cost, broken down, and how it compares with the run before it. A run starts at a
// start line of its Epic and ends before the next one. The breakdown reads only the lines of `decisions.jsonl`, so
// it works for any run whose log is on this host.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Meter, Usage } from "./agent.ts";
import { DECISIONS, type Line } from "./log.ts";

const HAIKU = "claude-haiku-5-5";
// Haiku 5.5 bills a prompt of up to 100K tokens at these rates, in dollars per million tokens, and a longer one at
// five times them. The 1-hour cache write, the dearer one, stands for every write, so a session that stayed under
// 100K never shows a cost above these rates.
const HAIKU_SHORT_RATES: Record<string, number> = {
  inputTokens: 0.1,
  outputTokens: 0.5,
  cacheReadInputTokens: 0.01,
  cacheCreationInputTokens: 0.2,
};
const TOKEN_FIELDS = Object.keys(HAIKU_SHORT_RATES);
// The dollar figures are what the API would bill. KC pays a plan, and its meter is the cost that counts.
export const LIST_PRICE = "list price (API)";
export const WINDOWS: Record<string, string> = { five_hour: "5-hour", seven_day: "Weekly" };

export const KEY = /^[A-Z][A-Z0-9]*-\d+$/;
const KEY_PREFIX = /^[A-Z][A-Z0-9]*-\d+/;
const RUN_NAME = /^(?:[A-Z][A-Z0-9]*-\d+|filter-[0-9a-f]{8})$/;
export const LOOP_SUFFIX = "-loop";

/** A run as its Epic key or filter name, and its lines, the oldest first. */
export type Run = [string, Line[]];

/** The lines of a decisions log, skipping any line that is not a JSON object. */
export function readLines(path: string): Line[] {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return content.split("\n").flatMap((row) => {
    try {
      const item: unknown = JSON.parse(row);
      return isRecord(item) ? [item as Line] : [];
    } catch {
      return [];
    }
  });
}

/**
 * The state folder of each project on this host, by name: this one first, then each sibling `<name>-loop` folder.
 * Each repo's `loop.toml` names its own folder there, so one page serves them all.
 */
export function projects(stateDir: string): Map<string, string> {
  const found = new Map([[stripSuffix(basename(stateDir)), stateDir]]);
  const parent = dirname(stateDir);
  for (const name of folders(parent)) {
    const home = join(parent, name);
    if (!name.endsWith(LOOP_SUFFIX) || home === stateDir) continue;
    const project = stripSuffix(name);
    if (!found.has(project)) found.set(project, home);
  }
  return found;
}

/** The folder of each run with a log in the project's state folder: an Epic, or a filter run. */
export function runHomes(stateDir: string): string[] {
  return folders(stateDir)
    .filter((name) => RUN_NAME.test(name) && existsSync(join(stateDir, name, DECISIONS)))
    .map((name) => join(stateDir, name));
}

/** The ticket of a line. A review session, such as `<KEY>-review`, belongs to its ticket. */
export function ticketKey(line: Line): string {
  return KEY_PREFIX.exec(line.ticket)?.[0] ?? line.ticket;
}

/** The lines of each ticket of a run, by key. The run's own lines, which carry its name, are left out. */
export function groupByTicket(run: string, lines: Line[]): Map<string, Line[]> {
  const byTicket = new Map<string, Line[]>();
  for (const line of lines) {
    const key = ticketKey(line);
    if (key === run) continue;
    const group = byTicket.get(key);
    if (group) group.push(line);
    else byTicket.set(key, [line]);
  }
  return byTicket;
}

/** The time of a line in epoch seconds. */
export function lineTime(line: Line): number {
  return Date.parse(line.time) / 1000;
}

/** The time as Python's `isoformat(timespec="seconds")` writes it, so the old readers parse it. */
export function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d+Z$/, "+00:00");
}

/** Each run on this host, as its Epic key and its lines, the oldest first. */
export function allRuns(stateDir: string): Run[] {
  const runs: Run[] = [];
  for (const home of runHomes(stateDir)) {
    const name = basename(home);
    for (const lines of splitRuns(name, readLines(join(home, DECISIONS)))) runs.push([name, lines]);
  }
  return runs.sort((a, b) => {
    const [first, second] = [a[1][0].time, b[1][0].time];
    return first < second ? -1 : first > second ? 1 : 0;
  });
}

export type Merge = {
  key: string;
  first_pass: boolean;
  red: number;
  start: number | null;
  merge: number;
  minutes: number | null;
};

/**
 * Each ticket that merged in a run, from its lines in that run: whether its first wait was green, how many of its
 * waits were red, and its start and merge times with the minutes between them.
 */
export function merges(byTicket: Map<string, Line[]>): Merge[] {
  const found: Merge[] = [];
  for (const [key, lines] of byTicket) {
    const merged = lines.find((line) => line.step === "merge" && line.result === "merged");
    if (!merged) continue;
    const waits = lines.filter((line) => line.step === "wait");
    const start = lines.find((line) => line.step === "start" && (line.result === "new" || line.result === "restart"));
    const mergedAt = lineTime(merged);
    const startedAt = start ? lineTime(start) : null;
    found.push({
      key,
      first_pass: waits.length > 0 && waits[0].result === "green",
      red: waits.filter((line) => line.result === "red").length,
      start: startedAt,
      merge: mergedAt,
      minutes: startedAt === null ? null : (mergedAt - startedAt) / 60,
    });
  }
  return found;
}

export type Reading = { utilization: number; resets_at: unknown; read: string; past: boolean };

/**
 * The newest reading of the account's plan meter on this host, for each window: its utilization, when it resets,
 * when it was read, and whether it has reset since. The meter belongs to the account, so the newest reading of any
 * run of any project counts. A running agent logs a `meter` line as the meter moves, and each agent line gives the
 * reading at the agent's end. Dollars never stand in for it.
 */
export function planMeter(stateDir: string): Record<string, Reading> {
  const newest: Record<string, Omit<Reading, "past">> = {};
  for (const project of projects(stateDir).values()) {
    for (const home of runHomes(project)) {
      for (const line of readLines(join(home, DECISIONS))) {
        for (const [window, value] of Object.entries(readings(line))) {
          if (!(window in newest) || value.read > newest[window].read) newest[window] = value;
        }
      }
    }
  }
  const now = Date.now() / 1000;
  return Object.fromEntries(
    Object.entries(newest).map(([window, value]) => [
      window,
      { ...value, past: typeof value.resets_at === "number" && value.resets_at < now },
    ]),
  );
}

type Read = Omit<Reading, "past">;

function readings(line: Line): Record<string, Read> {
  const found: Record<string, Read> = {};
  const meter = isRecord(line.meter) ? line.meter : null;
  const plan = line.plan;
  const source = meter ?? plan;
  if (!isRecord(source)) return found;
  for (const [window, value] of Object.entries(source)) {
    if (!isRecord(value)) continue;
    const utilization = meter ? value.utilization : value.end;
    if (typeof utilization === "number") {
      found[window] = { utilization, resets_at: value.resets_at, read: String(line.time) };
    }
  }
  return found;
}

/** The lines of each run of the Epic, the oldest first. Lines before the first start belong to no run. */
export function splitRuns(run: string, lines: Line[]): Line[][] {
  const starts = lines.flatMap((line, index) =>
    line.ticket === run && line.step === "start" && line.result === "ok" ? [index] : [],
  );
  return starts.map((start, index) => lines.slice(start, starts[index + 1] ?? lines.length));
}

/** The last agent line of each session. A resumed session reports the cost of the whole session so far. */
function sessions(lines: Line[]): Line[] {
  const last = new Map<string, Line>();
  for (const [number, line] of lines.entries()) {
    const usage = line.usage as Usage | null | undefined;
    if (line.step === "agent" && typeof usage?.total_cost_usd === "number") {
      last.set(line.session || `line-${number}`, line);
    }
  }
  return [...last.values()];
}

/** The least that a session paid above the Haiku 5.5 short-prompt rates, so 0 when it stayed under. */
function haikuOverCap(models: Record<string, Record<string, unknown>>): number {
  let over = 0;
  for (const [model, fields] of Object.entries(models)) {
    if (!model.startsWith(HAIKU) || !isRecord(fields) || fields.costBasis === "unknown") continue;
    const cost = fields.costUSD;
    if (typeof cost !== "number") continue;
    const short =
      TOKEN_FIELDS.reduce((sum, name) => sum + Number(fields[name] ?? 0) * HAIKU_SHORT_RATES[name], 0) / 1e6;
    // A cent's hundredth, or 1% of the cost, absorbs the rounding of the CLI's cost.
    if (cost - short > Math.max(0.0001, short * 0.01)) over += cost - short;
  }
  return over;
}

/**
 * The share of each plan window a run used, in percent, and the meter at its last agent line (loop.md rule 11).
 *
 * The meter is the account's, so parallel sessions, and KC's own, move it together. For each window, which one reset
 * time names, the run used the highest end less the lowest start of its agent lines.
 */
export function planUsage(lines: Line[]): { used: Record<string, number>; now: Meter } {
  const spans = new Map<string, { window: string; low: number; high: number }>();
  const now: Meter = {};
  for (const line of lines) {
    const plan = line.plan;
    if (!isRecord(plan)) continue;
    for (const [window, value] of Object.entries(plan)) {
      if (!isRecord(value)) continue;
      const { start, end, resets_at: resetsAt } = value;
      if (typeof start !== "number" || typeof end !== "number") continue;
      const key = JSON.stringify([window, resetsAt]);
      const span = spans.get(key);
      spans.set(
        key,
        span
          ? { window, low: Math.min(span.low, start), high: Math.max(span.high, end) }
          : { window, low: start, high: end },
      );
      now[window] = { utilization: end, resets_at: resetsAt };
    }
  }
  const used: Record<string, number> = {};
  for (const { window, low, high } of spans.values()) {
    used[window] = roundHalfEven((used[window] ?? 0) + (high - low) * 100, 1);
  }
  return { used, now };
}

export type HeadDrivers = {
  tickets: number;
  turns_per_ticket: number | null;
  peak_context_per_ticket: number | null;
  handoffs_per_ticket: Record<string, number>;
};

/**
 * What drives the head agent's cost, per ticket it worked on: its turns, the peak context of its sessions, and its
 * hand-offs to each subagent tier. Each turn sends the whole context again.
 */
function headDrivers(run: string, lines: Line[]): HeadDrivers {
  const tickets = new Set<string>();
  let turns = 0;
  const handoffs: Record<string, number> = {};
  for (const line of sessions(lines)) {
    if (line.ticket === run) continue;
    const usage = line.usage as Usage;
    tickets.add(line.ticket);
    turns += usage.num_turns ?? 0;
    for (const [kind, count] of Object.entries(usage.subagents ?? {})) {
      handoffs[kind] = (handoffs[kind] ?? 0) + Math.trunc(count);
    }
  }
  // Each agent line gives the peak of its own run, so a ticket's peak is the largest of its lines.
  const peaks = new Map<string, number>();
  for (const line of lines) {
    const usage = line.usage as Usage | null | undefined;
    const peak = line.step === "agent" ? usage?.peak_context : undefined;
    if (tickets.has(line.ticket) && typeof peak === "number") {
      peaks.set(line.ticket, Math.max(peaks.get(line.ticket) ?? 0, peak));
    }
  }
  const count = tickets.size;
  const peakTotal = [...peaks.values()].reduce((sum, peak) => sum + peak, 0);
  return {
    tickets: count,
    turns_per_ticket: count ? roundHalfEven(turns / count, 1) : null,
    peak_context_per_ticket: peaks.size ? roundHalfEven(peakTotal / peaks.size) : null,
    handoffs_per_ticket: count
      ? Object.fromEntries(Object.entries(handoffs).map(([kind, n]): [string, number] => [kind, roundHalfEven(n / count, 1)]))
      : {},
  };
}

export type Breakdown = {
  epic: string;
  started: string | null;
  ended: string | null;
  setup: Record<string, unknown>;
  merged: number;
  stuck: number;
  cost: number;
  cost_per_merged: number | null;
  plan_used: Record<string, number>;
  plan_per_merged: Record<string, number>;
  meter: Meter;
  head: HeadDrivers;
  turns: number;
  agent_minutes: number;
  red_checks: number;
  haiku_over_cap: number;
  haiku_over_cap_sessions: number;
  models: Record<string, Record<string, number>>;
  subagents: Record<string, number>;
};

/** The cost of one run by model and subagent, with what the run delivered for it. */
export function breakdown(run: string, lines: Line[]): Breakdown {
  const models: Record<string, Record<string, number>> = {};
  const subagents: Record<string, number> = {};
  let cost = 0;
  let turns = 0;
  let agentMs = 0;
  let over = 0;
  let overSessions = 0;
  for (const line of sessions(lines)) {
    const usage = line.usage as Usage;
    cost += usage.total_cost_usd ?? 0;
    turns += usage.num_turns ?? 0;
    agentMs += usage.duration_ms ?? 0;
    for (const [kind, count] of Object.entries(usage.subagents ?? {})) {
      subagents[kind] = (subagents[kind] ?? 0) + Math.trunc(count);
    }
    for (const [model, fields] of Object.entries(usage.models ?? {})) {
      const total = (models[model] ??= Object.fromEntries(
        ["costUSD", ...TOKEN_FIELDS].map((name): [string, number] => [name, 0]),
      ));
      for (const name of Object.keys(total)) total[name] += Number(fields[name] ?? 0);
    }
    const sessionOver = haikuOverCap(usage.models ?? {});
    over += sessionOver;
    if (sessionOver > 0) overSessions += 1;
  }
  const merged = merges(groupByTicket(run, lines));
  const plan = planUsage(lines);
  const count = merged.length;
  const first = lines[0];
  return {
    epic: run,
    started: first?.time ?? null,
    ended: lines[lines.length - 1]?.time ?? null,
    setup: (first?.setup as Record<string, unknown> | undefined) ?? {},
    merged: count,
    stuck: new Set(lines.filter((line) => line.step === "stuck").map(ticketKey)).size,
    cost,
    cost_per_merged: count ? cost / count : null,
    plan_used: plan.used,
    plan_per_merged: count
      ? Object.fromEntries(
          Object.entries(plan.used).map(([window, share]): [string, number] => [window, roundHalfEven(share / count, 1)]),
        )
      : {},
    meter: plan.now,
    head: headDrivers(run, lines),
    turns: Math.trunc(turns),
    agent_minutes: agentMs / 60000,
    red_checks: lines.filter((line) => line.step === "wait" && line.result === "red").length,
    haiku_over_cap: over,
    haiku_over_cap_sessions: overSessions,
    models,
    subagents,
  };
}

/**
 * The Epic's latest run, and the run to compare it with: the latest run of `against`, or else the latest run on this
 * host that started before it and has an agent line. `runs` is sorted oldest first.
 */
export function pick(runs: Run[], epic: string, against?: string): [Run | null, Run | null] {
  const current = runs.findLast((item) => item[0] === epic);
  if (!current) return [null, null];
  if (against) {
    return [current, runs.findLast((item) => item[0] === against && item !== current) ?? null];
  }
  const started = current[1][0].time;
  const earlier = runs.findLast((item) => item[1][0].time < started && sessions(item[1]).length > 0);
  return [current, earlier ?? null];
}

export type Kind = "money" | "minutes" | "count" | "percent" | "tokens" | "text";
type Figure = number | string | null;

export type Row = {
  section: string;
  label: string;
  kind: Kind;
  previous: Figure;
  current: Figure;
  change: number | string | null;
};

function row(section: string, label: string, kind: Kind, previous: Figure, current: Figure): Row {
  let change: number | string | null = null;
  if (kind === "text") {
    change = previous !== null && previous !== current ? "changed" : null;
  } else if (typeof previous === "number" && typeof current === "number") {
    change = previous
      ? roundHalfEven(((current - previous) / previous) * 100)
      : current
        ? "new"
        : null;
  }
  return { section, label, kind, previous, current, change };
}

/** One row per figure, with the previous run's value and the change in percent. */
export function compare(current: Breakdown, previous: Breakdown | null): Row[] {
  const rows: Row[] = [];
  const beforeUsed = previous?.plan_used ?? {};
  const afterUsed = current.plan_used;
  const beforeEach = previous?.plan_per_merged ?? {};
  const afterEach = current.plan_per_merged;
  for (const [window, name] of Object.entries(WINDOWS)) {
    if (window in beforeUsed || window in afterUsed) {
      rows.push(
        row("Plan usage", `${name} window used`, "percent", beforeUsed[window] ?? null, afterUsed[window] ?? null),
        row(
          "Plan usage",
          `${name} window used per merged ticket`,
          "percent",
          beforeEach[window] ?? null,
          afterEach[window] ?? null,
        ),
      );
    }
  }
  rows.push(
    row("Run", "Tickets merged", "count", previous?.merged ?? null, current.merged),
    row("Run", "Tickets stuck", "count", previous?.stuck ?? null, current.stuck),
    row("Run", `Cost, ${LIST_PRICE}`, "money", previous?.cost ?? null, current.cost),
    row(
      "Run",
      `Cost per merged ticket, ${LIST_PRICE}`,
      "money",
      previous?.cost_per_merged ?? null,
      current.cost_per_merged,
    ),
    row("Run", "Agent minutes", "minutes", previous?.agent_minutes ?? null, current.agent_minutes),
    row("Run", "Agent turns", "count", previous?.turns ?? null, current.turns),
    row("Run", "Red checks", "count", previous?.red_checks ?? null, current.red_checks),
    row(
      "Run",
      `Haiku cost above the 100K rate, ${LIST_PRICE}`,
      "money",
      previous?.haiku_over_cap ?? null,
      current.haiku_over_cap,
    ),
  );
  const beforeHead = previous?.head;
  const afterHead = current.head;
  rows.push(
    row(
      "Head agent",
      "Turns per ticket",
      "count",
      beforeHead?.turns_per_ticket ?? null,
      afterHead.turns_per_ticket,
    ),
    row(
      "Head agent",
      "Peak context per ticket",
      "tokens",
      beforeHead?.peak_context_per_ticket ?? null,
      afterHead.peak_context_per_ticket,
    ),
  );
  const beforeHandoffs = beforeHead?.handoffs_per_ticket ?? {};
  const afterHandoffs = afterHead.handoffs_per_ticket;
  for (const tier of sortedUnion(Object.keys(beforeHandoffs), Object.keys(afterHandoffs))) {
    rows.push(
      row(
        "Head agent",
        `Hand-offs per ticket: ${tier}`,
        "count",
        beforeHandoffs[tier] ?? (previous ? 0 : null),
        afterHandoffs[tier] ?? 0,
      ),
    );
  }
  const beforeModels = previous?.models ?? {};
  for (const name of sortedUnion(Object.keys(beforeModels), Object.keys(current.models))) {
    rows.push(
      row(
        `Cost by model, ${LIST_PRICE}`,
        name,
        "money",
        beforeModels[name]?.costUSD ?? null,
        current.models[name]?.costUSD ?? 0,
      ),
    );
  }
  const beforeSubagents = previous?.subagents ?? {};
  for (const name of sortedUnion(Object.keys(beforeSubagents), Object.keys(current.subagents))) {
    rows.push(row("Subagent calls", name, "count", beforeSubagents[name] ?? null, current.subagents[name] ?? 0));
  }
  const beforeSetup = flat(previous?.setup ?? {});
  const afterSetup = flat(current.setup);
  for (const name of sortedUnion(Object.keys(beforeSetup), Object.keys(afterSetup))) {
    rows.push(row("Setup", name, "text", beforeSetup[name] ?? null, afterSetup[name] ?? null));
  }
  return rows;
}

function sortedUnion(first: string[], second: string[]): string[] {
  return [...new Set([...first, ...second])].sort();
}

function flat(setup: Record<string, unknown>): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [key, value] of Object.entries(setup)) {
    if (isRecord(value)) {
      for (const [name, item] of Object.entries(value)) found[`${key} ${name}`] = String(item);
    } else {
      found[key] = String(value);
    }
  }
  return found;
}

/** The comparison as a table for a terminal. */
export function text(current: Breakdown, previous: Breakdown | null, rows: Row[]): string {
  const now = `${current.epic} ${day(current.started)}`;
  const then = previous ? `${previous.epic} ${day(previous.started)}` : "no earlier run";
  const lines = [`The run of ${now}, against ${then}.`];
  let section = "";
  for (const item of rows) {
    if (item.section !== section) {
      section = item.section;
      lines.push("", `${section.padEnd(50)}${"Before".padStart(16)}${"This run".padStart(16)}  Change`);
    }
    const shown = typeof item.change === "number" ? `${item.change >= 0 ? "+" : ""}${item.change}%` : (item.change ?? "");
    const before = show(item.kind, item.previous);
    const after = show(item.kind, item.current);
    lines.push(`  ${item.label.padEnd(48)}${before.padStart(16)}${after.padStart(16)}  ${shown}`);
  }
  return lines.join("\n");
}

function show(kind: Kind, figure: Figure): string {
  if (figure === null) return "-";
  if (typeof figure === "string") return figure;
  const grouped = (digits: number): string =>
    figure.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (kind === "money") return `$${grouped(2)}`;
  if (kind === "minutes") return `${grouped(0)} min`;
  if (kind === "percent") return `${grouped(1)}%`;
  if (kind === "tokens") return grouped(0);
  return String(figure);
}

function day(time: string | null): string {
  return (time ?? "").slice(0, 16).replace("T", " ");
}

/** The folder names under a folder, sorted, or none when the folder is not one. */
function folders(dir: string): string[] {
  if (!isDirectory(dir)) return [];
  return readdirSync(dir)
    .filter((name) => isDirectory(join(dir, name)))
    .sort();
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

function stripSuffix(name: string): string {
  return name.endsWith(LOOP_SUFFIX) ? name.slice(0, -LOOP_SUFFIX.length) : name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Python's `round`: a half goes to the even digit, so 2.5 gives 2, 3.5 gives 4, and 2.25 gives 2.2. The check reads
 * the binary value's exact digits, so only a true tie takes the even digit.
 */
function roundHalfEven(value: number, digits = 0): number {
  const exact = Math.abs(value).toFixed(100);
  const point = exact.indexOf(".");
  const kept = Number(exact.slice(0, point) + exact.slice(point + 1, point + 1 + digits));
  const rest = exact.slice(point + 1 + digits);
  const up = /^50*$/.test(rest) ? kept % 2 === 1 : rest[0] >= "5";
  const rounded = (kept + (up ? 1 : 0)) / 10 ** digits;
  return value < 0 ? -rounded : rounded;
}
