// Reads `loop.toml`. A key the old loop knew and this loop dropped warns and is ignored, so an old
// file still loads. Any other unknown key refuses the file, as a typo would otherwise pass unseen.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, TomlDate } from "smol-toml";

export const FILE = "loop.toml";
export const REQUIRED_SECRETS = ["JIRA_EMAIL", "JIRA_API_TOKEN", "NTFY_TOPIC"] as const;
const PLAN_KEYS = ["pro", "max-5x", "max-20x"];

/** The gate runs these now, so the loop no longer reads them. */
const DROPPED: Record<string, string> = {
  gates: "the merge gate runs the checks on the pull request",
  acceptance: "the merge gate runs the acceptance tests",
  "ui.skill": "the merge gate's judge reviews the UI",
  demo: "the loop no longer opens an Epic pull request with a demo",
};

export class ConfigError extends Error {}

export type Secret = { item: string; field: string };

export type Config = {
  repo: string;
  name: string;
  mainBranch: string;
  tools: string[];
  /** The command the loop runs in a new worktree before the build, or none. */
  setup: string[];
  agentHint: string;
  trackerUrl: string;
  inProgress: string;
  inReview: string;
  agentModel: string;
  agentEffort: string;
  parallel: number;
  agentTimeoutMinutes: number;
  fixAttempts: number;
  circuitBreaker: number;
  stack: { ports: Record<string, number>; portStep: number } | null;
  review: { enabled: boolean; model: string | null; effort: string | null; skip: string[] };
  ntfyUrl: string;
  /** `exact` is false for a `since` with a date only. */
  plans: { plan: string; since: string; exact: boolean }[];
  secrets: Record<string, Secret>;
  stateDir: string;
  warnings: string[];
};

type Value = unknown;

class Table {
  private readonly known = new Set<string>();
  private readonly data: Record<string, Value>;
  private readonly path: string;

  constructor(data: Record<string, Value>, path: string) {
    this.data = data;
    this.path = path;
  }

  private get(key: string): Value {
    this.known.add(key);
    return this.data[key];
  }

  private where(key: string): string {
    return `${this.path}${key}`;
  }

  text(key: string): string;
  text<T>(key: string, fallback: T): string | T;
  text(key: string, ...fallback: unknown[]): unknown {
    const value = this.get(key);
    if (value === undefined && fallback.length) return fallback[0];
    if (typeof value !== "string") throw new ConfigError(`${this.where(key)} must be text`);
    return value;
  }

  flag(key: string, fallback: boolean): boolean {
    const value = this.get(key);
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") throw new ConfigError(`${this.where(key)} must be true or false`);
    return value;
  }

  number(key: string, fallback?: number): number {
    const value = this.get(key);
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new ConfigError(`${this.where(key)} must be a whole number`);
    }
    return value;
  }

  texts(key: string, fallback?: string[]): string[] {
    const value = this.get(key);
    if (value === undefined && fallback !== undefined) return fallback;
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new ConfigError(`${this.where(key)} must be a list of text`);
    }
    return value;
  }

  table(key: string, optional = false): Table {
    const value = this.get(key);
    if (value === undefined && optional) return new Table({}, `${this.where(key)}.`);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ConfigError(`${this.where(key)} must be a table`);
    }
    return new Table(value as Record<string, Value>, `${this.where(key)}.`);
  }

  tables(key: string): Table[] {
    const value = this.get(key);
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new ConfigError(`${this.where(key)} must be a list of tables`);
    return value.map((item, index) => {
      if (typeof item !== "object" || item === null) {
        throw new ConfigError(`${this.where(key)} must be a list of tables`);
      }
      return new Table(item as Record<string, Value>, `${this.where(key)}[${index}].`);
    });
  }

  /** Whether the date of a key has a time, so that a date alone can leave its whole day unclear. */
  hasTime(key: string): boolean {
    const value = this.get(key);
    return value instanceof TomlDate ? !value.isDate() : !/^\d{4}-\d{2}-\d{2}$/.test(String(value));
  }

  date(key: string): string {
    const value = this.get(key);
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
    if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
    throw new ConfigError(`${this.where(key)} must be a date`);
  }

  empty(): boolean {
    return Object.keys(this.data).length === 0;
  }

  keys(): string[] {
    for (const key of Object.keys(this.data)) this.known.add(key);
    return Object.keys(this.data);
  }

  /** Warns for each dropped key, and refuses any other key that nothing read. */
  done(warnings: string[]): void {
    for (const key of Object.keys(this.data)) {
      if (this.known.has(key)) continue;
      const path = this.where(key);
      const reason = DROPPED[path];
      if (reason === undefined) throw new ConfigError(`unknown key ${path}`);
      const shown = path.includes(".") ? `[${path.replace(".", "].")}` : `[${path}]`;
      warnings.push(`${FILE}: ${shown} is no longer read, because ${reason}. The loop ignores it.`);
    }
  }
}

export function stateDirOf(name: string): string {
  return join(homedir(), ".local", "state", `${name}-loop`);
}

/** The `name` of `loop.toml` alone, with no check of the other keys, so a key that only newer code knows
 * reaches the newer code that `loop start` runs in its unit.
 */
export function peek(repo: string): string {
  const path = join(repo, FILE);
  let data: Record<string, unknown>;
  try {
    data = parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`${path}: ${(error as Error).message}`);
  }
  if (typeof data.name !== "string" || !data.name) throw new ConfigError(`${path}: name is missing`);
  return data.name;
}

export function load(repo: string): Config {
  const path = join(repo, FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`${path} is missing. The setup-loop skill writes it.`);
  }
  try {
    return parseConfig(repo, parse(text) as Record<string, Value>);
  } catch (error) {
    throw new ConfigError(`${path}: ${(error as Error).message}`);
  }
}

function parseConfig(repo: string, data: Record<string, Value>): Config {
  const warnings: string[] = [];
  const top = new Table(data, "");
  const name = top.text("name");
  const tracker = top.table("tracker");
  if (tracker.text("kind") !== "jira") throw new ConfigError("tracker.kind: the loop has a Jira adapter only");
  const agent = top.table("agent", true);
  const limits = top.table("limits", true);
  const stackTable = top.table("stack", true);
  const ui = top.table("ui", true);
  const review = top.table("review", true);
  const notify = top.table("notify", true);
  const watch = top.table("watch", true);
  const secretsTable = top.table("secrets");

  const secrets: Record<string, Secret> = {};
  for (const env of secretsTable.keys()) {
    const entry = secretsTable.table(env);
    secrets[env] = { item: entry.text("item"), field: entry.text("field") };
    entry.done(warnings);
  }
  const missing = REQUIRED_SECRETS.filter((env) => !(env in secrets));
  if (missing.length) throw new ConfigError(`secrets: the loop needs ${missing.join(", ")}`);

  let stack: Config["stack"] = null;
  if (!stackTable.empty()) {
    const ports = stackTable.table("ports");
    stack = {
      ports: Object.fromEntries(ports.keys().map((port) => [port, ports.number(port)])),
      portStep: stackTable.number("port_step"),
    };
    ports.done(warnings);
  }

  const plans = watch.tables("plans").map((entry) => {
    const plan = entry.text("plan");
    if (!PLAN_KEYS.includes(plan)) throw new ConfigError(`watch.plans: plan must be one of ${PLAN_KEYS.join(", ")}`);
    const since = entry.date("since");
    const exact = entry.hasTime("since");
    entry.done(warnings);
    return { plan, since, exact };
  });

  // Keys the loop checks and uses for nothing: `name_landed_keys_only` is from the Epic pull request the loop no
  // longer opens, and `[ui]` `path`, `accepted_unchecked`, and `blocking` are settings of the gate's judge.
  tracker.flag("name_landed_keys_only", false);
  ui.text("path", null);
  ui.texts("accepted_unchecked", []);
  ui.texts("blocking", []);

  const config: Config = {
    repo,
    name,
    mainBranch: top.text("main_branch", "main"),
    tools: top.texts("tools", []),
    setup: top.texts("setup", []),
    agentHint: top.text("agent_hint", ""),
    trackerUrl: tracker.text("url"),
    inProgress: tracker.text("in_progress", "In Progress"),
    inReview: tracker.text("landed", "In Review"),
    agentModel: agent.text("model", "claude-opus-5-5"),
    agentEffort: agent.text("effort", "high"),
    parallel: limits.number("parallel", 1),
    agentTimeoutMinutes: limits.number("agent_timeout_minutes", 90),
    fixAttempts: limits.number("fix_attempts", 2),
    circuitBreaker: limits.number("circuit_breaker", 2),
    stack,
    review: {
      enabled: review.flag("enabled", true),
      model: review.text("model", null),
      effort: review.text("effort", null),
      skip: review.texts("skip", []),
    },
    ntfyUrl: notify.text("url", "https://ntfy.sh"),
    plans,
    secrets,
    stateDir: stateDirOf(name),
    warnings,
  };
  for (const table of [top, tracker, agent, limits, stackTable, ui, review, notify, watch, secretsTable]) {
    table.done(warnings);
  }
  return config;
}
