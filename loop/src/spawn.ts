// Every process the loop starts goes through `spawnGroup`, in a process group of its own, so a stop ends
// the agent and every child it left behind.
import { type ChildProcess, spawn } from "node:child_process";

const MINUTE = 60_000;
const live = new Set<ChildProcess>();

export type Spawn = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: "pipe" | "ignore" | "inherit";
  stdout?: "pipe" | "ignore" | "inherit";
  stderr?: "pipe" | "ignore" | "inherit";
};

export function spawnGroup(command: string, args: readonly string[], options: Spawn = {}): ChildProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: [options.stdin ?? "ignore", options.stdout ?? "pipe", options.stderr ?? "pipe"],
    detached: true,
  });
  live.add(child);
  child.once("exit", () => live.delete(child));
  child.once("error", () => live.delete(child));
  return child;
}

export function signalGroup(child: ChildProcess, signal: NodeJS.Signals | 0): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return false;
  }
}

function groupAlive(child: ChildProcess): boolean {
  return signalGroup(child, 0);
}

/** SIGTERM to the process group, then SIGKILL to what is left after a minute. */
export async function endGroup(child: ChildProcess): Promise<void> {
  signalGroup(child, "SIGTERM");
  const deadline = Date.now() + MINUTE;
  while (Date.now() < deadline) {
    if (!groupAlive(child)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  signalGroup(child, "SIGKILL");
}

export async function endAll(): Promise<void> {
  await Promise.all([...live].map(endGroup));
}

export type Finished = { code: number; stdout: string; stderr: string; timedOut: boolean };

/** Runs the command to its end or to its limit, and returns what it printed. */
export function run(
  command: string,
  args: readonly string[],
  options: Spawn & { seconds?: number } = {},
): Promise<Finished> {
  const child = spawnGroup(command, args, options);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (data: Buffer) => (stdout += data.toString()));
  child.stderr?.on("data", (data: Buffer) => (stderr += data.toString()));
  let timedOut = false;
  const timer =
    options.seconds === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          void endGroup(child);
        }, options.seconds * 1000);
  return new Promise((resolve) => {
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + error.message, timedOut });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr, timedOut });
    });
  });
}
