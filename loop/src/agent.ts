// One agent session through the Claude Agent SDK. The SDK starts `claude` through the loop's spawn function,
// so a stop ends the session's whole process group, and each event goes to the agent log as one JSON line.
import { accessSync, appendFileSync, constants, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { query, type SpawnedProcess, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "./config.ts";
import { endGroup, run, signalGroup, spawnGroup } from "./spawn.ts";

const DISPATCH = new URL("./dispatch.md", import.meta.url);

// A session ends at its status, so nothing wakes it for a later turn. These tools wait for one.
const WAIT_TOOLS = ["ScheduleWakeup", "CronCreate", "CronDelete", "CronList", "RemoteTrigger", "Monitor", "Workflow"];

export const SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["done", "blocked"] },
    reason: { type: "string" },
    decisions: {
      type: "array",
      items: { type: "string" },
      description:
        "Each open question that the ticket and the docs do not answer, and that only KC can settle. " +
        "Make the call and continue. Leave it empty when the docs answer the question.",
    },
    notes: {
      type: "array",
      items: { type: "string" },
      description:
        "Anything else worth keeping on the ticket: a judgement call that follows the docs, a polish idea, " +
        "a limit of the check. KC reads these only when KC opens the ticket.",
    },
  },
  required: ["status", "reason", "decisions"],
  additionalProperties: false,
};

export type Output = { status: "done" | "blocked"; reason: string; decisions: string[]; notes?: string[] };

export type Session = {
  result: "done" | "blocked" | "error" | "timeout" | "usage-limit";
  session: string | null;
  detail: string;
  output: Output | null;
  cost: number | null;
  usage: Usage | null;
  plan: Plan;
  /** At a usage limit, when it resets in epoch seconds, from the run's last rejected `rate_limit_event`. */
  resets: number | null;
};

/** What one session cost, from its last result event, in the shape the report reads. */
export type Usage = {
  total_cost_usd: number | null;
  num_turns: number | null;
  duration_ms: number | null;
  subagents: Record<string, number> | null;
  models: Record<string, Record<string, number>> | null;
  /** The largest context one of the session's own assistant messages sent. */
  peak_context: number;
};

/** The plan meter over one session, per window: the first and the last utilization, and when it resets. */
export type Plan = Record<string, { start: number; end: number; resets_at: unknown }>;

/** The newest reading of each window of the plan meter. */
export type Meter = Record<string, { utilization: number; resets_at: unknown }>;

const MODEL_USAGE = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "costUSD", "costBasis"];
// The tokens of one assistant message that make up the context it sent.
const CONTEXT_TOKENS = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];

/** Adds one `rate_limit_event` to the plan. A window that resets during the session starts its entry again. */
export function addReading(plan: Plan, info: Record<string, unknown>): void {
  const unified = info.unifiedWindows;
  // A CLI that gives no windows reports the one window that is closest to its limit.
  const windows = unified && typeof unified === "object" ? (unified as Record<string, unknown>) : { [String(info.rateLimitType)]: info };
  for (const [window, value] of Object.entries(windows)) {
    if (!value || typeof value !== "object") continue;
    const { utilization, resetsAt } = value as { utilization?: unknown; resetsAt?: unknown };
    if (typeof utilization !== "number") continue;
    const entry = plan[window];
    if (!entry || entry.resets_at !== resetsAt) plan[window] = { start: utilization, end: utilization, resets_at: resetsAt };
    else entry.end = utilization;
  }
}

function usageOf(result: Record<string, unknown>, peak: number): Usage {
  const number = (value: unknown) => (typeof value === "number" ? value : null);
  const models = result.modelUsage as Record<string, Record<string, number>> | undefined;
  const stats = result.subagent_stats as { by_type?: Record<string, number> } | undefined;
  return {
    total_cost_usd: number(result.total_cost_usd),
    num_turns: number(result.num_turns),
    duration_ms: number(result.duration_ms),
    subagents: stats?.by_type ?? null,
    models: models
      ? Object.fromEntries(
          Object.entries(models).map(([model, fields]) => [
            model,
            Object.fromEntries(Object.entries(fields).filter(([field]) => MODEL_USAGE.includes(field))),
          ]),
        )
      : null,
    peak_context: peak,
  };
}

// The subagent tiers, one Markdown file each in the agents folder of this checkout.
const TIERS = new URL("../../agents/", import.meta.url);

/**
 * What the agents of a run run on: the `claude` version, and the model and effort of the head agent, of each
 * subagent tier, and of the gate's review. The start line keeps it, so `loop report` can tell two runs apart.
 */
export async function runSetup(config: Config): Promise<Record<string, unknown>> {
  const executable = claudePath();
  const printed = executable ? (await run(executable, ["--version"], { seconds: 30 })).stdout : "";
  const tiers: Record<string, string> = {};
  for (const file of readdirSync(TIERS).filter((name) => name.endsWith(".md")).sort()) {
    const front = /^---\n([\s\S]*?)\n---/.exec(readFileSync(new URL(file, TIERS), "utf8"))?.[1] ?? "";
    const field = (key: string) => new RegExp(`^${key}: *(.+)$`, "m").exec(front)?.[1]?.trim() ?? "";
    tiers[field("name") || file.replace(/\.md$/, "")] = `${field("model")} ${field("effort")}`;
  }
  return {
    claude: /\d+\.\d+\.\d+/.exec(printed)?.[0] ?? "",
    agent: `${config.agentModel} ${config.agentEffort}`,
    tiers,
    review: `${config.review.model ?? "the gate's model"} ${config.review.effort ?? "the gate's effort"}`,
  };
}

/** The text of a failed run that names a usage limit. */
const USAGE_LIMIT = /usage limit|hit your limit|limit reached|rate.?limit/i;

export type Ask = {
  prompt: string;
  cwd: string;
  resume: string | null;
  model: string;
  effort: string;
  env: Record<string, string>;
  log: string;
  minutes: number;
  stateDir: string;
  /** Takes each new reading of the plan meter while the session runs. */
  meter?: (reading: Meter) => void;
};

/** The `claude` on the PATH, so the tests' fake agent stands in for it. */
export function claudePath(path = process.env.PATH ?? ""): string | null {
  for (const folder of path.split(delimiter)) {
    const candidate = join(folder, "claude");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function settings(stateDir: string): string {
  return JSON.stringify({
    permissions: { deny: WAIT_TOOLS },
    autoMode: {
      environment: [
        "$defaults",
        "Host containment: an unattended build loop runs this session. Nobody is at the keyboard. " +
          `The loop owns each git worktree and run folder under ${stateDir}.`,
      ],
    },
    // A `trial` branches from the ticket's last commit, not from the default branch.
    worktree: { baseRef: "head" },
  });
}

function spawner(errors: string) {
  return (options: SpawnOptions): SpawnedProcess => {
    const child = spawnGroup(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stderr?.on("data", (data: Buffer) => appendFileSync(errors, data));
    options.signal.addEventListener("abort", () => void endGroup(child), { once: true });
    return {
      stdin: child.stdin!,
      stdout: child.stdout!,
      get killed() {
        return child.killed;
      },
      get exitCode() {
        return child.exitCode;
      },
      get signalCode() {
        return child.signalCode;
      },
      kill: (signal) => signalGroup(child, signal),
      on: (event: "exit" | "error", listener: (...args: any[]) => void) => void child.on(event, listener),
      once: (event: "exit" | "error", listener: (...args: any[]) => void) => void child.once(event, listener),
      off: (event: "exit" | "error", listener: (...args: any[]) => void) => void child.off(event, listener),
    } as SpawnedProcess;
  };
}

export async function ask(request: Ask): Promise<Session> {
  const executable = claudePath(request.env.PATH);
  const errors = request.log.replace(/\.jsonl$/, ".err");
  writeFileSync(request.log, "");
  writeFileSync(errors, "");
  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, request.minutes * 60_000);
  const found: Session = { result: "error", session: request.resume, detail: "", output: null, cost: null, usage: null, plan: {}, resets: null };
  let limited = false;
  let peak = 0;
  // The stream repeats a message for each of its content blocks.
  const seen = new Set<string>();
  try {
    const messages = query({
      prompt: request.prompt,
      options: {
        cwd: request.cwd,
        env: request.env,
        model: request.model,
        effort: request.effort as never,
        resume: request.resume ?? undefined,
        permissionMode: "auto",
        outputFormat: { type: "json_schema", schema: SCHEMA },
        systemPrompt: { type: "preset", preset: "claude_code", append: readFileSync(DISPATCH, "utf8") },
        settings: settings(request.stateDir),
        abortController: abort,
        pathToClaudeCodeExecutable: executable ?? undefined,
        spawnClaudeCodeProcess: spawner(errors),
      },
    });
    for await (const message of messages) {
      appendFileSync(request.log, JSON.stringify(message) + "\n");
      if ("session_id" in message && message.session_id) found.session = message.session_id;
      if (message.type === "rate_limit_event") {
        const info = message.rate_limit_info;
        if (info.status === "rejected" && info.resetsAt) found.resets = info.resetsAt;
        addReading(found.plan, info as unknown as Record<string, unknown>);
        request.meter?.(
          Object.fromEntries(Object.entries(found.plan).map(([window, { end, resets_at }]) => [window, { utilization: end, resets_at }])),
        );
        continue;
      }
      // A subagent's messages carry a parent tool call, and they are not counted.
      if (message.type === "assistant" && !message.parent_tool_use_id && !seen.has(message.message.id)) {
        seen.add(message.message.id);
        const tokens = message.message.usage as unknown as Record<string, number | null>;
        peak = Math.max(peak, CONTEXT_TOKENS.reduce((sum, name) => sum + (tokens?.[name] ?? 0), 0));
      }
      if (message.type !== "result") continue;
      found.cost = message.total_cost_usd ?? null;
      found.usage = usageOf(message as unknown as Record<string, unknown>, peak);
      const output = message.subtype === "success" ? (message.structured_output as Output | undefined) : undefined;
      if (output && (output.status === "done" || output.status === "blocked")) {
        found.output = output;
        found.result = output.status;
        found.detail = output.reason ?? "";
      } else if (!found.output) {
        found.detail = message.subtype === "success" ? "The agent returned no status." : message.subtype;
        if (message.is_error) {
          const text = message.subtype === "success" ? message.result : message.errors.join("\n");
          if (text) found.detail = text.split("\n")[0] ?? found.detail;
          limited = (message.subtype === "success" && message.api_error_status === 429) || USAGE_LIMIT.test(text);
        }
      }
    }
  } catch (error) {
    if (!found.output) found.detail = (error as Error).message.split("\n")[0] ?? "";
  } finally {
    clearTimeout(timer);
  }
  if (!found.output && !limited && !timedOut && USAGE_LIMIT.test(found.detail + "\n" + readFileSync(errors, "utf8"))) limited = true;
  if (limited && !found.output) return { ...found, result: "usage-limit" };
  if (timedOut && !found.output) {
    return { ...found, result: "timeout", detail: `The agent ran past its limit of ${request.minutes} min.` };
  }
  if (!found.output && !found.detail) found.detail = "The agent returned no status.";
  return found;
}
