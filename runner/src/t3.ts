// The `t3` calls of the runner. `t3` prints log lines on stdout, so each call asks for errors only, before the
// subcommand, and JSON parses. `list` shows a thread that waits on a question as `running`, so the state of a
// ticket's thread comes from `show`.
import { dirname } from "node:path";
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

/** A thread's whole turn, which takes longer than a call that only reads or starts. */
const TURN_LIMIT_MS = 10 * 60_000;

function t3(args: string[], cwd: string, limit?: number): Promise<string> {
  return run("t3", ["--log-level", "error", "thread", ...args], cwd, limit);
}

/** The main checkout, which is T3's project even from a worktree, since a T3 worktree sits outside the project. */
export async function projectOf(cwd: string): Promise<string> {
  return dirname((await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd)).trim());
}

export async function listThreads(cwd: string): Promise<{ threadId: string; title: string }[]> {
  return JSON.parse(await t3(["list", "--json", "--project", await projectOf(cwd)], cwd));
}

export async function showThread(cwd: string, id: string): Promise<Thread> {
  return JSON.parse(await t3(["show", "--json", "--messages", "0", id], cwd)).thread;
}

/** Starts the thread and returns, because a tick must exit: no `--wait`. Provider and model are always passed, since T3 ignores a project's default model for a thread from the CLI. */
export async function startThread(cwd: string, thread: NewThread): Promise<void> {
  const { title, provider, model, base, branch, message } = thread;
  await t3(["start", "--title", title, "--provider", provider, "--model", model, "--worktree", base, "--branch", branch, await projectOf(cwd), message], cwd);
}

/** Starts a thread in the project's folder and returns its reply. `t3` exits non-zero when the run fails or waits on an answer, so either rejects. */
export async function askThread(project: string, thread: Pick<NewThread, "title" | "provider" | "model" | "message">): Promise<string> {
  const { title, provider, model, message } = thread;
  return (await t3(["start", "--title", title, "--provider", provider, "--model", model, "--wait", project, message], project, TURN_LIMIT_MS)).trim();
}

/** Sends a message to the thread and returns, with no `--wait`. A busy thread gets it as its next turn. */
export async function sendMessage(cwd: string, id: string, message: string): Promise<void> {
  await t3(["send", id, message], cwd);
}
