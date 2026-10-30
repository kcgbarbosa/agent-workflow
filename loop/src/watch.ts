// The watch page: a web page of the runs on this host. It reads what each run writes to the state folder, the
// decisions log and the agent logs, and changes nothing. A run is running when its pid is alive. The server
// answers only a Host of this host, on localhost and on the tailnet address.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Forecaster } from "./forecast.ts";
import {
  allRuns,
  breakdown,
  type Breakdown,
  compare,
  iso,
  KEY,
  merges,
  pick,
  planMeter,
  projects,
  readLines,
  runHomes,
  ticketKey,
} from "./report.ts";
import { DECISIONS, type Line } from "./log.ts";
import { run } from "./spawn.ts";

export const WATCH_PORT = 8790;
const PAGE = fileURLToPath(new URL("./watch.html", import.meta.url));
const SECRETS = "secrets.json";
const AGENT_LOG = /^agent-(\d+)\.jsonl$/;
const RUN = new RegExp(`^(?:${KEY.source}|filter-[0-9a-f]{8})$`);
const DENIED = "denied by the Claude Code auto mode classifier";
// A short secret would mask ordinary words.
const MIN_SECRET = 8;
// The steps that say nothing new on the page.
const QUIET = new Set(["tracker-status", "meter"]);
// The results of an agent that waits for a usage limit to reset.
const LIMITED = ["usage-limit", "usage-pause"];
const RECENT_ITEMS = 3;
const TAIL_BYTES = 256_000;
const SUMMARY_CHARS = 160;
const DETAIL_CHARS = 4000;
const CHUNK_BYTES = 2_000_000;
// The steps in which an agent writes its log.
const AGENT_STEPS = new Set(["build"]);
// An agent that writes nothing for longer than this needs a look. A Bash call stops after 10 minutes, so a
// quiet agent past 15 runs no command.
const STALL_MINUTES = 15;
// The lines that name a ticket's step: the steps of a ticket in order, and the stuck step.
const STEP_LINES = new Set(["build", "push", "pr", "wait", "base", "merge", "stuck"]);
// The check buckets that make a wait red.
const RED_BUCKETS = new Set(["fail", "cancel"]);
// The images a run folder holds, which the page lists apart from the files and serves raw.
const LISTED_IMAGES = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

export type Check = { name: string; bucket: string };
export type PullRequest = { url: string; result: string; checks: Check[] };
type Last = { step: string; result: string; time: string };
type Agent = { number: number; updated: string };
type AgentLog = Agent & { size: number };
type Step = { name: string; since: string; paused: boolean };
type Health = { state: string; reason: string };
type Item = Record<string, unknown>;
type Reply = { status: number; type: string; body: Buffer };
type Tailnet = { address: string; dns: string };

export type EventView = {
  time: string;
  ticket: string;
  step: string;
  result: string;
  detail: string;
  cost?: unknown;
  turns?: unknown;
  log?: string;
};

export type QueueItem = { key: string; state: string; waits_on: string[] };

export type TicketView = {
  key: string;
  summary: string;
  status: string;
  column: string;
  blockers: string[];
  stuck_reason: string;
  last: Last | null;
  cost: number;
  agents: Agent[];
  step: Step | null;
  health: Health | null;
  recent: Item[];
  files: string[];
  pr: PullRequest | null;
  stacked_on: { branch: string; pr: string | null } | null;
  red: number;
};

export type PlanView = {
  used: Record<string, number>;
  per_merged: Record<string, number>;
  fits: Record<string, number>;
};

export type EpicView = {
  key: string;
  summary: string;
  status: string;
  resumes: string | null;
  progress: { complete: number; total: number };
  queue: QueueItem[];
  state: string;
  stop_reason: string;
  started: string | null;
  updated: string | null;
  tickets: TicketView[];
  stats: {
    merged: number;
    stuck: number;
    first_pass_rate: number | null;
    median_merge_minutes: number | null;
  };
  plan: PlanView;
  events: EventView[];
  epic_files: string[];
  epic_agents: Agent[];
};

export type HostRun = {
  key: string;
  summary: string;
  updated: string;
  running: boolean;
  status: string;
  progress: { complete: number; total: number };
  stuck: number;
  working: { key: string; step: string | null }[];
};

export type HostProject = { name: string; runs: HostRun[] };

type FrontierTicket = {
  key: string;
  summary?: string;
  status?: string;
  state?: string;
  blockers?: string[];
};

/** A ticket as the view builds it from the frontier and the lines. */
type Tracked = {
  key: string;
  summary: string;
  status: string;
  frontier: string;
  blockers: string[];
  started: boolean;
  stuck: boolean;
  stuckReason: string;
  last: Last | null;
};

const FORBIDDEN: Reply = { status: 403, type: "text/plain", body: Buffer.from("Forbidden") };
const METHOD_NOT_ALLOWED: Reply = { status: 405, type: "text/plain", body: Buffer.from("Method Not Allowed") };

/** Replaces the value of each secret with its name. A transcript can hold what an agent printed. */
class Masker {
  private readonly pairs: [string, string][];

  constructor(...secrets: Record<string, string>[]) {
    const pairs: [string, string][] = [];
    for (const each of secrets) {
      for (const [name, value] of Object.entries(each)) {
        if (value.length >= MIN_SECRET) pairs.push([value, `[${name}]`]);
      }
    }
    this.pairs = pairs.sort((a, b) => b[0].length - a[0].length);
  }

  text(value: string): string {
    return this.pairs.reduce((result, [secret, name]) => result.replaceAll(secret, name), value);
  }

  data(value: unknown): unknown {
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map((item) => this.data(item));
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.data(item)]));
    return value;
  }
}

/** Whether the Epic's latest run is running: its latest start line has a pid that is alive, and no finish or stop line follows it. */
function isRunning(lines: Line[], epic: string): boolean {
  const index = lines.findLastIndex((line) => line.ticket === epic && line.step === "start" && line.result === "ok");
  if (index < 0) return false;
  const pid = lines[index].pid;
  if (typeof pid !== "number") return false;
  // A ticket logs its own `stop loop-error` and the run goes on, so only the run's end line counts.
  if (lines.slice(index + 1).some((line) => line.ticket === epic && (line.step === "finish" || line.step === "stop"))) return false;
  return alive(pid);
}

/** Whether a process with this pid exists. A process that belongs to another user exists too. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Each project on this host with the latest run of each of its Epics, the running one first, then the
 * newest: its status, its tickets complete of the total, and the step of each running ticket. The home page
 * lists them, and the page's project and Epic menus read them.
 */
export function hostView(stateDir: string): HostProject[] {
  return [...projects(stateDir)].map(([name, home]) => {
    const epics = runHomes(home).sort((a, b) => mtime(join(b, DECISIONS)) - mtime(join(a, DECISIONS)));
    const runs = epics.map((epic): HostRun => {
      const key = basename(epic);
      const view = epicView(home, key, isRunning(readLines(join(epic, DECISIONS)), key));
      return {
        key,
        summary: view.summary,
        updated: iso(mtime(join(epic, DECISIONS))),
        running: view.state === "running",
        status: view.status,
        progress: view.progress,
        stuck: view.stats.stuck,
        working: view.tickets
          .filter((ticket) => ticket.column === "running")
          .map((ticket) => ({ key: ticket.key, step: ticket.step?.name ?? null })),
      };
    });
    runs.sort((a, b) => Number(b.running) - Number(a.running));
    return { name, runs };
  });
}

/** The breakdown of an Epic's latest run, or of the latest run on this host, against the run before it. */
export function comparison(stateDir: string, epic?: string, against?: string) {
  const runs = allRuns(stateDir);
  let key = epic;
  if (key === undefined && runs.length) key = runs[runs.length - 1][0];
  const [current, previous] = pick(runs, key ?? "", against);
  if (!current) return null;
  const now = breakdown(current[0], current[1]);
  const before = previous ? breakdown(previous[0], previous[1]) : null;
  return { current: now, previous: before, rows: compare(now, before) };
}

/** The state of one Epic's latest run: the run, the tickets in columns, and the steps. `running` is whether
 * the run's pid is alive, which the view checks when the caller does not know.
 */
export function epicView(stateDir: string, epic: string, running?: boolean): EpicView {
  const home = join(stateDir, epic);
  const lines = readLines(join(home, DECISIONS));
  const live = running ?? isRunning(lines, epic);
  // The latest run starts at the last start line of the Epic.
  const starts = lines.flatMap((line, index) => (line.ticket === epic && line.step === "start" ? [index] : []));
  const runLines = starts.length ? lines.slice(starts[starts.length - 1]) : lines;

  // The latest frontier gives the summary and the tickets, in the order the loop reads them.
  const frontier = lines.findLast((line) => line.step === "frontier");
  const listed = frontier?.tickets;
  const tickets = new Map<string, Tracked>();
  for (const item of Array.isArray(listed) ? (listed as FrontierTicket[]) : []) {
    tickets.set(item.key, {
      key: item.key,
      summary: item.summary ?? "",
      status: item.status ?? "",
      frontier: item.state ?? "",
      blockers: item.blockers ?? [],
      started: false,
      stuck: false,
      stuckReason: "",
      last: null,
    });
  }

  // A ticket's lines anywhere in the log, for its pull request, and the tickets that merged anywhere in it.
  const everyByTicket = new Map<string, Line[]>();
  const merged = new Set<string>();
  for (const line of lines) {
    const key = ticketKey(line);
    if (key !== epic) addTo(everyByTicket, key, line);
    if ((line.step === "merge" && line.result === "merged") || (line.step === "start" && line.result === "merged-before")) {
      merged.add(key);
    }
  }

  // A run that ended wrote its end line. One with none was killed.
  let state = starts.length ? "stopped" : "idle";
  let stopReason = starts.length ? "killed" : "";
  let finished = false;
  const byTicket = new Map<string, Line[]>();
  const events: EventView[] = [];
  let resumes: string | null = null;
  for (const line of runLines) {
    const { step, result } = line;
    const key = ticketKey(line);
    if (key === epic) {
      if (step === "stop") {
        state = "stopped";
        stopReason = result;
      } else if (step === "finish") {
        state = "stopped";
        stopReason = "";
        finished = true;
      }
    } else {
      addTo(byTicket, key, line);
      let ticket = tickets.get(key);
      if (!ticket) {
        ticket = { key, summary: "", status: "", frontier: "", blockers: [], started: false, stuck: false, stuckReason: "", last: null };
        tickets.set(key, ticket);
      }
      if (step === "start") {
        ticket.started = ticket.started || result === "new" || result === "restart";
        ticket.stuck = false;
        ticket.stuckReason = "";
      } else if (step === "stuck") {
        ticket.stuck = true;
        ticket.stuckReason = String(line.detail ?? "").replaceAll(`${home}/`, "");
      }
      if (!QUIET.has(step) && !step.startsWith("tracker-")) ticket.last = { step, result, time: line.time };
    }
    if (step === "usage-pause" && result === "ok" && typeof line.resumes === "string") resumes = line.resumes;
    if (!QUIET.has(step)) events.push(eventOf(home, line));
  }
  if (live) {
    state = "running";
    stopReason = "";
  }
  const paused = live && resumes !== null && Date.parse(resumes) > Date.now();

  const costs = sessionCosts(lines);
  const columns: TicketView[] = [];
  for (const ticket of tickets.values()) {
    const own = byTicket.get(ticket.key) ?? [];
    const everything = everyByTicket.get(ticket.key) ?? [];
    const pr = pullRequest(everything);
    const step = currentStep(own, pr !== null, paused && limited(own));

    let column: string;
    if (merged.has(ticket.key) || ticket.frontier === "merged") column = "merged";
    else if (ticket.stuck || ticket.frontier === "flagged") column = "stuck";
    else if (ticket.frontier === "done") column = "done";
    else if (ticket.started && live) column = "running";
    else if (ticket.started) column = "stopped";
    else column = "waiting";

    const isLive = column === "running";
    const runDir = join(home, "runs", ticket.key);
    const agents = agentLogs(runDir);
    const newest = agents.reduce<string | null>((latest, log) => (latest === null || log.updated > latest ? log.updated : latest), null);
    const latestWait = everything.findLast((line) => line.step === "wait");
    columns.push({
      key: ticket.key,
      summary: ticket.summary,
      status: ticket.status,
      column,
      blockers: ticket.blockers,
      stuck_reason: ticket.stuckReason,
      last: ticket.last,
      cost: Math.round(sum(Object.values(ticketSessions(lines, ticket.key, costs))) * 100) / 100,
      agents: agents.map(({ number, updated }) => ({ number, updated })),
      step: isLive || column === "stopped" ? step : null,
      health: isLive ? ticketHealth(step, newest, latestWait) : null,
      recent: isLive ? recentActivity(home, ticket.key, runDir, agents) : [],
      files: runFiles(home, runDir),
      pr: pr && column === "merged" ? { ...pr, result: "merged" } : pr,
      stacked_on: stackedOn(own),
      red: own.filter((line) => line.step === "wait" && line.result === "red").length,
    });
  }

  const totals = breakdown(epic, runLines);
  const complete = columns.filter((ticket) => ticket.column === "merged" || ticket.column === "done").length;
  const status = paused ? "paused" : runStatus(state, stopReason, columns, finished);
  return {
    key: epic,
    summary: frontier && typeof frontier.summary === "string" ? frontier.summary : "",
    status,
    resumes: status === "paused" ? resumes : null,
    progress: { complete, total: columns.length },
    queue: queue(columns),
    state,
    stop_reason: stopReason,
    started: runLines.length ? runLines[0].time : null,
    updated: runLines.length ? runLines[runLines.length - 1].time : null,
    tickets: columns,
    stats: ticketStats(columns, byTicket),
    plan: planView(totals),
    events,
    epic_files: runFiles(home, join(home, "runs", epic)),
    epic_agents: agentLogs(join(home, "runs", epic)).map(({ number, updated }) => ({ number, updated })),
  };
}

/** Whether the ticket's last agent run met a usage limit, with no step after it. */
function limited(lines: Line[]): boolean {
  const last = lines.findLast((line) => line.step === "agent" || STEP_LINES.has(line.step));
  return last !== undefined && last.step === "agent" && LIMITED.includes(last.result);
}

/** One word for the run: running, idle, failed, blocked, completed, or stopped. A paused run is running.
 *
 * Failed: the loop itself failed. Completed or blocked: the run finished, and every ticket merged or was done,
 * or not. Stopped: the run stopped, or was killed, before it finished.
 */
function runStatus(state: string, stopReason: string, tickets: TicketView[], finished: boolean): string {
  if (state === "running") return "running";
  if (state === "idle") return "idle";
  if (stopReason === "loop-error") return "failed";
  if (finished) {
    const complete = tickets.length > 0 && tickets.every((ticket) => ticket.column === "merged" || ticket.column === "done");
    return complete ? "completed" : "blocked";
  }
  return "stopped";
}

/** How a running ticket fares, from explicit conditions: on-track, attention, or blocked, with why. */
function ticketHealth(step: Step | null, newestLog: string | null, latestWait: Line | undefined): Health {
  if (step?.paused) return { state: "blocked", reason: "It waits for the usage limit to reset." };
  if (step && AGENT_STEPS.has(step.name)) {
    // The step starts when its agent starts, so a new agent with no log yet is not quiet.
    const since = step.since;
    const quietSince = (newestLog ?? "") > since ? (newestLog ?? "") : since;
    const minutes = quietSince ? (Date.now() - Date.parse(quietSince)) / 60_000 : 0;
    if (minutes > STALL_MINUTES) {
      return { state: "attention", reason: `The agent has written nothing for ${Math.trunc(minutes)} minutes.` };
    }
  }
  if (latestWait?.result === "red") {
    const names = checksOf(latestWait)
      .filter((check) => RED_BUCKETS.has(check.bucket))
      .map((check) => check.name);
    const reason = names.length
      ? `Red checks: ${names.join(", ")}. The agent is fixing them.`
      : "The checks are red. The agent is fixing them.";
    return { state: "attention", reason };
  }
  return { state: "on-track", reason: "" };
}

/** The tickets that wait to start, in the order the loop takes them: the ready ones by key, as the
 * frontier reads them, then the ones that wait on a blocker, after their blockers. A ticket whose blocker
 * is stuck, or waits on a stuck one, is blocked and comes last.
 */
function queue(tickets: TicketView[]): QueueItem[] {
  const byKey = new Map(tickets.map((ticket) => [ticket.key, ticket]));
  const index = new Map(tickets.map((ticket, number) => [ticket.key, number]));

  const openBlockers = (ticket: TicketView): string[] =>
    ticket.blockers.filter((key) => {
      const column = byKey.get(key)?.column;
      return column !== "merged" && column !== "done";
    });

  /** How many open blockers lie in a row before the ticket, and whether a stuck one is among them. */
  const depth = (key: string, seen: Set<string> = new Set()): [number, boolean] => {
    const ticket = byKey.get(key);
    if (ticket === undefined || seen.has(key)) return [0, false];
    if (ticket.column === "stuck") return [0, true];
    const found = openBlockers(ticket).map((blocker) => depth(blocker, new Set([...seen, key])));
    if (!found.length) return [0, false];
    return [1 + Math.max(...found.map(([levels]) => levels)), found.some(([, stuck]) => stuck)];
  };

  const rank: Record<string, number> = { ready: 0, waiting: 1, blocked: 2 };
  const items: (QueueItem & { order: number })[] = [];
  for (const ticket of tickets) {
    if (ticket.column !== "waiting") continue;
    const waitsOn = openBlockers(ticket);
    const [levels, stuck] = depth(ticket.key);
    const state = stuck ? "blocked" : waitsOn.length ? "waiting" : "ready";
    items.push({ key: ticket.key, state, waits_on: waitsOn, order: levels });
  }
  items.sort(
    (a, b) =>
      rank[a.state] - rank[b.state] || a.order - b.order || (index.get(a.key) ?? 0) - (index.get(b.key) ?? 0),
  );
  return items.map(({ key, state, waits_on }) => ({ key, state, waits_on }));
}

/** The merged and stuck tickets of the board. Of the tickets that merged in this run: how many passed
 * their first wait, and the median time from their start to their merge.
 */
function ticketStats(columns: TicketView[], byTicket: Map<string, Line[]>): EpicView["stats"] {
  const found = merges(byTicket);
  const firstPass = found.filter((item) => item.first_pass).length;
  const minutes = found.flatMap((item) => (item.minutes === null ? [] : [item.minutes]));
  return {
    merged: columns.filter((ticket) => ticket.column === "merged").length,
    stuck: columns.filter((ticket) => ticket.column === "stuck").length,
    first_pass_rate: found.length ? firstPass / found.length : null,
    median_merge_minutes: minutes.length ? median(minutes) : null,
  };
}

/** The share of each window the run used, per merged ticket too, and how many more tickets fit in the
 * rest of each window at that share. A meter whose window has reset since the run read it gives no
 * estimate.
 */
function planView(totals: Breakdown): PlanView {
  const fits: Record<string, number> = {};
  for (const [window, value] of Object.entries(totals.meter)) {
    const past = typeof value.resets_at === "number" && value.resets_at < Date.now() / 1000;
    const each = totals.plan_per_merged[window];
    if (each && !past) fits[window] = Math.max(0, Math.floor((100 - value.utilization * 100) / each + 1e-9));
  }
  return { used: totals.plan_used, per_merged: totals.plan_per_merged, fits };
}

/** The last tool calls and messages of the ticket's newest agent log, read from its end. */
function recentActivity(home: string, key: string, runDir: string, agents: Agent[]): Item[] {
  if (!agents.length) return [];
  const path = join(runDir, `agent-${agents[agents.length - 1].number}.jsonl`);
  let size: number;
  let data: Buffer;
  try {
    size = statSync(path).size;
    data = readRange(path, Math.max(0, size - TAIL_BYTES), size - Math.max(0, size - TAIL_BYTES));
  } catch {
    return [];
  }
  if (size > TAIL_BYTES) data = data.subarray(data.indexOf(10) + 1);
  const roots: [string, string] = [`${home}/worktrees/${key}/`, `${home}/runs/${key}/`];
  const items: Item[] = [];
  for (const event of eventsOf(data)) {
    items.push(...itemsOf(event, roots).filter((item) => item.kind === "tool" || item.kind === "text"));
  }
  return items.slice(-RECENT_ITEMS).map((item) => {
    const kept: Item = {};
    for (const field of ["kind", "tool", "summary", "text"]) {
      if (field in item) kept[field] = item[field];
    }
    return kept;
  });
}

/** The cost of each agent session. A resumed session reports the cost of the whole session so far. */
function sessionCosts(lines: Line[]): Record<string, number> {
  const sessions: Record<string, number> = {};
  lines.forEach((line, number) => {
    const usage = isRecord(line.usage) ? line.usage : {};
    const cost = usage.total_cost_usd;
    if (typeof cost === "number") sessions[line.session || `line-${number}`] = cost;
  });
  return sessions;
}

function ticketSessions(lines: Line[], key: string, sessions: Record<string, number>): Record<string, number> {
  const ids = new Set(lines.filter((line) => line.ticket === key && line.usage).map((line) => line.session));
  return Object.fromEntries(Object.entries(sessions).filter(([session]) => ids.has(session)));
}

/** One line of the log as the page's activity lists it: the time, the ticket, the step, the result, and the
 * detail with the state folder cut out of it. A line that names a log of the run links to it.
 */
function eventOf(home: string, line: Line): EventView {
  const detail = String(line.detail ?? "");
  const event: EventView = {
    time: line.time,
    ticket: line.ticket,
    step: line.step,
    result: line.result,
    detail: detail.replaceAll(`${home}/`, ""),
  };
  const usage = isRecord(line.usage) ? line.usage : {};
  if (usage.total_cost_usd !== undefined && usage.total_cost_usd !== null) {
    event.cost = usage.total_cost_usd;
    event.turns = usage.num_turns;
  }
  // A gate or stuck line names its log, which the page links to.
  for (const [, match] of detail.matchAll(new RegExp(`${escapeRegExp(home)}/(runs/\\S+)`, "g"))) {
    if (isFile(join(home, match))) {
      event.log = match;
      break;
    }
  }
  return event;
}

function agentLogs(runDir: string): AgentLog[] {
  const logs: AgentLog[] = [];
  for (const name of listDir(runDir)) {
    const match = AGENT_LOG.exec(name);
    if (!match) continue;
    const stat = statSync(join(runDir, name));
    logs.push({ number: Number(match[1]), size: stat.size, updated: iso(stat.mtimeMs / 1000) });
  }
  return logs.sort((a, b) => a.number - b.number);
}

/** The files of a run folder, relative to the state folder. Images and agent logs are left out. */
function runFiles(home: string, runDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(runDir, { recursive: true, encoding: "utf8" });
  } catch {
    return [];
  }
  return names
    .filter(
      (name) =>
        !AGENT_LOG.test(basename(name)) &&
        !LISTED_IMAGES.has(extname(name).toLowerCase()) &&
        isFile(join(runDir, name)),
    )
    .map((name) => relative(home, join(runDir, name)))
    .sort();
}

/** The events of one agent log from a byte offset, each as one line a person can scan.
 *
 * A line the agent still writes stays for the next read, so the next offset starts at a whole line.
 */
function activity(home: string, ticket: string, path: string, offset: number): { items: Item[]; offset: number; size: number } {
  const size = statSync(path).size;
  const data = readRange(path, Math.min(offset, size), CHUNK_BYTES);
  const end = data.lastIndexOf(10) + 1;
  const roots: [string, string] = [`${home}/worktrees/${ticket}/`, `${home}/runs/${ticket}/`];
  const items: Item[] = [];
  for (const event of eventsOf(data.subarray(0, end))) items.push(...itemsOf(event, roots));
  return { items, offset: offset + end, size };
}

function itemsOf(event: Record<string, unknown>, roots: [string, string]): Item[] {
  const kind = event.type;
  const parent = event.parent_tool_use_id ?? null;
  if (kind === "system" && event.subtype === "init") return [{ kind: "init", model: event.model ?? "" }];
  if (kind === "result") {
    return [
      {
        kind: "result",
        error: Boolean(event.is_error),
        total_cost_usd: event.total_cost_usd ?? null,
        num_turns: event.num_turns ?? null,
        duration_ms: event.duration_ms ?? null,
      },
    ];
  }
  if (kind === "assistant" || kind === "user") {
    const message = isRecord(event.message) ? event.message : {};
    const content: unknown[] = Array.isArray(message.content) ? message.content : [];
    return content.flatMap((block) => {
      const item = isRecord(block) ? blockOf(kind, block, roots) : null;
      return item ? [{ ...item, parent }] : [];
    });
  }
  return [];
}

function blockOf(kind: string, block: Record<string, unknown>, roots: [string, string]): Item | null {
  const [worktree, runDir] = roots;
  const short = (text: string): string => text.replaceAll(worktree, "").replaceAll(runDir, "run/");
  if (block.type === "text" && kind === "assistant" && typeof block.text === "string" && block.text.trim()) {
    return { kind: "text", text: short(block.text.trim()).slice(0, DETAIL_CHARS) };
  }
  if (block.type === "tool_use") {
    const name = String(block.name ?? "");
    const input = isRecord(block.input) ? block.input : {};
    if (name === "StructuredOutput") {
      const decisions: unknown[] = Array.isArray(input.decisions) ? input.decisions : [];
      return {
        kind: "status",
        status: input.status ?? "",
        text: short(String(input.reason ?? "")),
        decisions: decisions.map((item) => short(String(item))),
      };
    }
    const [tool, summary, detail] = toolSummary(name, input);
    return {
      kind: "tool",
      id: block.id ?? null,
      tool,
      summary: short(summary).slice(0, SUMMARY_CHARS),
      detail: short(detail).slice(0, DETAIL_CHARS),
    };
  }
  if (block.type === "tool_result") {
    const text = resultText(block.content);
    return {
      kind: "output",
      id: block.tool_use_id ?? null,
      error: Boolean(block.is_error),
      denied: text.includes(DENIED),
      text: short(text).slice(0, DETAIL_CHARS),
    };
  }
  return null;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter(isRecord).map((part) => String(part.text ?? "")).join("\n");
  return "";
}

/** The label, the one-line summary, and the full input of one tool call. */
function toolSummary(name: string, input: Record<string, unknown>): [string, string, string] {
  const get = (key: string): string => String(input[key] ?? "");
  const command = get("command").trim();
  const firstLine = command ? command.split("\n")[0] : "";
  if (name === "Bash") return ["Bash", get("description") || firstLine, get("command")];
  if (name === "Read" || name === "Write" || name === "Edit" || name === "NotebookEdit") {
    const path = get("file_path") || get("notebook_path");
    return [name, path + (name === "Write" ? ` (${countLines(get("content"))} lines)` : ""), path];
  }
  if (name === "Grep" || name === "Glob") {
    const where = get("path") ? ` in ${get("path")}` : "";
    return [name, `${get("pattern")}${where}`, JSON.stringify(input)];
  }
  if (name === "Agent" || name === "Task") {
    const kind = get("subagent_type") ? `${get("subagent_type")}: ` : "";
    return ["Agent", `${kind}${get("description")}`, get("prompt")];
  }
  if (name === "Skill") return ["Skill", `${get("skill")} ${get("args")}`.trim(), get("args")];
  if (name === "SubagentHandback") {
    const message = get("message").trim();
    return ["Handback", message ? message.split("\n")[0] : "", message];
  }
  if (name === "WebFetch" || name === "WebSearch" || name === "ToolSearch") {
    return [name, get("url") || get("query"), JSON.stringify(input)];
  }
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return [parts[1] ?? "", parts.slice(2).join("__"), JSON.stringify(input, null, 1)];
  }
  return [name, JSON.stringify(input).slice(0, SUMMARY_CHARS), JSON.stringify(input, null, 1)];
}

// --- Helpers ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addTo(map: Map<string, Line[]>, key: string, line: Line): void {
  const list = map.get(key) ?? [];
  list.push(line);
  map.set(key, list);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The lines of a Python `splitlines`: a trailing newline ends the last line and adds none. */
function countLines(text: string): number {
  if (!text) return 0;
  const parts = text.split(/\r\n|\r|\n/);
  return parts[parts.length - 1] === "" ? parts.length - 1 : parts.length;
}

/** Each JSON object of a log's lines. A line that does not parse is skipped. */
function eventsOf(data: Buffer): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const text of data.toString("utf8").split("\n")) {
    try {
      const event: unknown = JSON.parse(text);
      if (isRecord(event)) found.push(event);
    } catch {
      // A line the agent is still writing, or one that is not JSON.
    }
  }
  return found;
}

function checksOf(line: Line | undefined): Check[] {
  return line && Array.isArray(line.checks) ? (line.checks as Check[]) : [];
}

/** The pull request a line names, or null when it names none. */
function prOf(line: Line): string | null {
  return typeof line.pr === "string" && line.pr !== "" ? line.pr : null;
}

/** The ticket's pull request, and how its checks stand: the result and the checks of its latest wait after
 * its latest push. A pull request that has not waited on a push yet is pending.
 */
function pullRequest(lines: Line[]): PullRequest | null {
  const linked = lines.findLast(
    (line) =>
      (line.step === "pr" && line.result === "open") ||
      line.step === "wait" ||
      line.step === "merge" ||
      line.step === "stuck" ||
      (line.step === "start" && line.result === "merged-before"),
  );
  const url = linked ? prOf(linked) : null;
  if (!url) return null;
  const pushed = lines.findLastIndex((line) => line.step === "push" && line.result === "ok");
  const wait = pushed < 0 ? undefined : lines.slice(pushed + 1).findLast((line) => line.step === "wait");
  return { url, result: wait ? wait.result : "pending", checks: checksOf(wait) };
}

/** The base a ticket stacks on, from its latest start line of this run. */
function stackedOn(own: Line[]): { branch: string; pr: string | null } | null {
  const start = own.findLast((line) => line.step === "start" && (line.result === "new" || line.result === "restart"));
  if (!start || typeof start.base !== "string") return null;
  return { branch: start.base, pr: typeof start.pr === "string" ? start.pr : null };
}

/** The step a ticket is in, from its step lines in this run: the last one, and the step it opens. Null when
 * the last step line opens none.
 */
function currentStep(lines: Line[], hasPullRequest: boolean, paused: boolean): Step | null {
  const last = lines.findLast((line) => STEP_LINES.has(line.step));
  if (!last) return null;
  const name = stepOpenedBy(last, hasPullRequest);
  return name ? { name, since: last.time, paused } : null;
}

/** The step a step line opens, or null when it opens none. A red wait goes back to build, as a fix round. */
function stepOpenedBy(line: Line, hasPullRequest: boolean): string | null {
  const { step, result } = line;
  if (step === "build" && result === "started") return "build";
  if (step === "build" && result === "pass") return "push";
  if (step === "push" && result === "ok") return hasPullRequest ? "wait" : "pr";
  if (step === "pr" && result === "open") return "wait";
  if ((step === "wait" && result === "green") || (step === "base" && result === "main")) return "merge";
  if (step === "wait" && result === "red") return "build";
  if (step === "stuck" && result === "started") return "stuck";
  return null;
}

function mtime(path: string): number {
  return statSync(path).mtimeMs / 1000;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function realPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function readRange(path: string, start: number, length: number): Buffer {
  const file = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(file, buffer, 0, length, start);
    return buffer.subarray(0, read);
  } finally {
    closeSync(file);
  }
}

/** The state of each project's secrets, from its secrets file: a flat map of names to values, or none when
 * the file is missing or unreadable.
 */
function storedSecrets(stateDir: string): Record<string, string> {
  try {
    const secrets: unknown = JSON.parse(readFileSync(join(stateDir, SECRETS), "utf8"));
    if (!isRecord(secrets)) return {};
    return Object.fromEntries(Object.entries(secrets).map(([name, value]) => [name, String(value)]));
  } catch {
    return {};
  }
}

// --- Server ---

/** Answers each path and file of the page, and only the page's own reads. Each API path and file takes
 * `?project=<name>`, and without it serves this repo's project.
 */
export class Watch {
  readonly stateDir: string;
  readonly forecast: Forecaster | null;
  private readonly names: ReadonlySet<string>;

  /** `names` are the Host names the watch answers, and `forecast` is the capacity forecast of this project. */
  constructor(stateDir: string, forecast: Forecaster | null = null, names: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"])) {
    this.stateDir = stateDir;
    this.forecast = forecast;
    this.names = names;
  }

  /** Whether a request's Host names this host. A site whose name resolves to this host, as in DNS rebinding,
   * sends its own name, and gets 403.
   */
  allows(host: string): boolean {
    try {
      return this.names.has(new URL(`http://${host}`).hostname);
    } catch {
      return false;
    }
  }

  masker(): Masker {
    // Read for each request, so a new secret takes effect without a restart.
    return new Masker(...[...projects(this.stateDir).values()].map(storedSecrets));
  }

  /** Each API path and file takes `?project=<name>`, and without it serves this repo's project. */
  async handle(url: string, host: string): Promise<Reply> {
    if (!this.allows(host)) return FORBIDDEN;
    let parsed: URL;
    let parts: string[];
    try {
      parsed = new URL(url, "http://localhost");
      parts = parsed.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    } catch {
      return missing();
    }
    if (!parts.length) return { status: 200, type: "text/html; charset=utf-8", body: readFileSync(PAGE) };
    const route = parts.join("/");
    if (route === "api/home") return this.json(hostView(this.stateDir).map((project) => ({ ...project, control: false })));
    if (route === "api/usage") return this.json(planMeter(this.stateDir));
    if (route === "api/forecast") return this.json(this.forecast ? await this.forecast.view() : null);
    const name = parsed.searchParams.get("project") ?? "";
    const dir = name ? projects(this.stateDir).get(name) : this.stateDir;
    if (dir === undefined) return missing();
    if (parts.length === 3 && parts[0] === "api" && parts[1] === "epic" && RUN.test(parts[2])) {
      if (!existsSync(join(dir, parts[2], DECISIONS))) return missing();
      return this.json(epicView(dir, parts[2]));
    }
    if (parts.length === 3 && parts[0] === "api" && parts[1] === "report" && RUN.test(parts[2])) {
      const against = parsed.searchParams.get("against") ?? "";
      const found = comparison(dir, parts[2], RUN.test(against) ? against : undefined);
      if (!found) return missing();
      const previous = found.previous;
      const before = previous ? { epic: previous.epic, started: previous.started } : null;
      return this.json({ previous: before, rows: found.rows });
    }
    if (parts.length === 5 && parts[0] === "api" && parts[1] === "agent" && RUN.test(parts[2]) && KEY.test(parts[3])) {
      const home = join(dir, parts[2]);
      const path = join(home, "runs", parts[3], `agent-${parts[4]}.jsonl`);
      if (!/^\d+$/.test(parts[4]) || !isFile(path)) return missing();
      const raw = parsed.searchParams.get("offset") ?? "";
      if (raw !== "" && !/^\d+$/.test(raw)) {
        return { status: 400, type: "application/json", body: Buffer.from(JSON.stringify({ error: "offset must be a whole number" })) };
      }
      return this.json(activity(home, parts[3], path, raw === "" ? 0 : Number(raw)));
    }
    if (parts.length >= 4 && parts[0] === "files" && RUN.test(parts[1]) && parts[2] === "runs") {
      return this.file(join(dir, parts[1]), parts.slice(2).join("/"));
    }
    return missing();
  }

  private json(data: unknown): Reply {
    return { status: 200, type: "application/json", body: Buffer.from(JSON.stringify(this.masker().data(data))) };
  }

  private file(home: string, relativePath: string): Reply {
    const root = realPath(join(home, "runs"));
    const path = realPath(join(home, relativePath));
    if (root === null || path === null || !path.startsWith(root + sep) || !isFile(path)) return missing();
    const imageType = IMAGE_TYPES[extname(path).toLowerCase()];
    if (imageType) return { status: 200, type: imageType, body: readFileSync(path) };
    const text = this.masker().text(readFileSync(path, "utf8"));
    return { status: 200, type: "text/plain; charset=utf-8", body: Buffer.from(text) };
  }
}

function missing(): Reply {
  return { status: 404, type: "text/plain", body: Buffer.from("Not found") };
}

/** Answers one request: GET reads the page and its API, and any other method is refused. */
async function answer(watch: Watch, request: IncomingMessage): Promise<Reply> {
  const host = request.headers.host ?? "";
  if (request.method !== "GET") return watch.allows(host) ? METHOD_NOT_ALLOWED : FORBIDDEN;
  return watch.handle(request.url ?? "/", host);
}

function send(response: ServerResponse, reply: Reply): void {
  response.writeHead(reply.status, {
    "Content-Type": reply.type,
    "Content-Length": String(reply.body.length),
    // An open page reloads itself when the page on disk changes, as after `loop` updates.
    "X-Page-Version": String(statSync(PAGE, { bigint: true }).mtimeNs),
    // Images under a run are cached for a day, and every other answer is never cached.
    "Cache-Control": reply.type.startsWith("image/") ? "private, max-age=86400" : "no-store",
  });
  response.end(reply.body);
}

/** This host's IPv4 address on the tailnet and its MagicDNS name, when it is on a tailnet. */
async function tailnet(): Promise<Tailnet | null> {
  try {
    const status: unknown = JSON.parse((await run("tailscale", ["status", "--json"], { seconds: 5 })).stdout);
    const self = isRecord(status) && isRecord(status.Self) ? status.Self : null;
    if (!self || !Array.isArray(self.TailscaleIPs)) return null;
    const address = self.TailscaleIPs.find((ip): ip is string => typeof ip === "string" && ip.includes("."));
    if (!address) return null;
    return { address, dns: String(self.DNSName ?? "").replace(/\.+$/, "").toLowerCase() };
  } catch {
    return null;
  }
}

/** The page of a run, at this host's tailnet address when it has one, which opens on any device in the tailnet. */
export async function pageUrl(project: string, run: string): Promise<string> {
  return `http://${addresses(await tailnet()).at(-1)}:${WATCH_PORT}/#/${project}/${run}`;
}

/** Localhost, and this host's tailnet address when it has one. No other network reaches the page. */
function addresses(found: Tailnet | null): string[] {
  return found ? ["127.0.0.1", found.address] : ["127.0.0.1"];
}

/** The names a request may give as its Host: localhost, the tailnet address, and the MagicDNS name, in full and
 * as the host name alone, which the tailnet's search domain completes.
 */
function hostNames(found: Tailnet | null): Set<string> {
  const names = new Set(["localhost", "127.0.0.1"]);
  if (found) {
    for (const name of [found.address, found.dns, found.dns.split(".")[0]]) {
      if (name) names.add(name);
    }
  }
  return names;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** Starts one server for each address and returns the bound URLs and a close. Localhost must bind. A tailnet
 * address that does not bind is left out, and a line says so.
 */
export async function serve(
  stateDir: string,
  port: number,
  options: { forecast?: Forecaster | null } = {},
): Promise<{ urls: string[]; close(): Promise<void> }> {
  const found = await tailnet();
  const watch = new Watch(stateDir, options.forecast ?? null, hostNames(found));
  const servers: Server[] = [];
  const urls: string[] = [];
  for (const host of addresses(found)) {
    const server = createServer((request, response) => {
      answer(watch, request).then(
        (reply) => send(response, reply),
        (error: unknown) => {
          console.error(error);
          send(response, { status: 500, type: "text/plain", body: Buffer.from("Server error") });
        },
      );
    });
    try {
      await listen(server, port, host);
    } catch (error) {
      if (host === "127.0.0.1") throw error;
      console.log(`loop watch does not listen on ${host}: ${(error as Error).message}`);
      continue;
    }
    servers.push(server);
    urls.push(`http://${host}:${(server.address() as AddressInfo).port}/`);
  }
  return {
    urls,
    close: async () => {
      await Promise.all(servers.map(closeServer));
    },
  };
}
