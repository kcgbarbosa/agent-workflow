// The `t3` calls of the runner. `t3` prints log lines on stdout, so each call asks for errors only, before the
// subcommand, and JSON parses. `list` shows a thread that waits on a question as `running`, so the state of a
// ticket's thread comes from `show`.
import { run } from "./exec.ts";

export type Thread = {
  threadId: string;
  title: string;
  /** The thread's address on this host, as `t3` prints it. */
  link: string;
  status: string;
  activeRunId: string | null;
  pendingRequestCount: number;
  /** Does not move during a long foreground tool call, so a command longer than the quiet period flags a healthy thread. */
  updatedAt: string;
};

export type NewThread = {
  title: string;
  provider: string;
  model: string;
  /** The commit the new worktree starts from. */
  base: string;
  branch: string;
  message: string;
};

function t3(args: string[], cwd: string): Promise<string> {
  return run("t3", ["--log-level", "error", "thread", ...args], cwd);
}

export async function listThreads(cwd: string): Promise<{ threadId: string; title: string }[]> {
  return JSON.parse(await t3(["list", "--json", "--project", "."], cwd));
}

export async function showThread(cwd: string, id: string): Promise<Thread> {
  return JSON.parse(await t3(["show", "--json", "--messages", "0", id], cwd)).thread;
}

/** Starts the thread and returns, because a tick must exit: no `--wait`. Provider and model are always passed, since T3 ignores a project's default model for a thread from the CLI. */
export async function startThread(cwd: string, thread: NewThread): Promise<void> {
  const { title, provider, model, base, branch, message } = thread;
  await t3(["start", "--title", title, "--provider", provider, "--model", model, "--worktree", base, "--branch", branch, ".", message], cwd);
}

/** Sends a message to the thread and returns, with no `--wait`. A busy thread gets it as its next turn. */
export async function sendMessage(cwd: string, id: string, message: string): Promise<void> {
  await t3(["send", id, message], cwd);
}
