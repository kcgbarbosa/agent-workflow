// One agent session through the Claude Agent SDK. The SDK starts `claude` through the loop's spawn function,
// so a stop ends the session's whole process group, and each event goes to the agent log as one JSON line.
import { accessSync, appendFileSync, constants, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { query, type SpawnedProcess, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { endGroup, signalGroup, spawnGroup } from "./spawn.ts";

const DISPATCH = new URL("./loop/dispatch.md", import.meta.url);

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
  result: "done" | "blocked" | "error" | "timeout";
  session: string | null;
  detail: string;
  output: Output | null;
  cost: number | null;
  usage: unknown;
};

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
};

/** The `claude` on the PATH, as the Python loop runs it, so the tests' fake agent stands in for it. */
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
  const found: Session = { result: "error", session: request.resume, detail: "", output: null, cost: null, usage: null };
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
      if (message.type !== "result") continue;
      found.cost = message.total_cost_usd ?? null;
      found.usage = message.usage ?? null;
      const output = message.subtype === "success" ? (message.structured_output as Output | undefined) : undefined;
      if (output && (output.status === "done" || output.status === "blocked")) {
        found.output = output;
        found.result = output.status;
        found.detail = output.reason ?? "";
      } else if (!found.output) {
        found.detail = message.subtype === "success" ? "The agent returned no status." : message.subtype;
      }
    }
  } catch (error) {
    if (!found.output) found.detail = (error as Error).message.split("\n")[0] ?? "";
  } finally {
    clearTimeout(timer);
  }
  if (timedOut && !found.output) {
    return { ...found, result: "timeout", detail: `The agent ran past its limit of ${request.minutes} min.` };
  }
  if (!found.output && !found.detail) found.detail = "The agent returned no status.";
  return found;
}
