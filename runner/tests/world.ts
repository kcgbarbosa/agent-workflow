// A scenario's world: a repo with a bare origin, a fake Jira, and the fakes of `t3` and `gh` on the PATH.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FakeJira, jiraTime } from "./fakes/jira.ts";
import { FakeNtfy } from "./fakes/ntfy.ts";

const HERE = import.meta.dirname;
const RUNNER = join(HERE, "..", "bin", "runner");
const GIT = dirname(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim());

export type Tick = { code: number; stdout: string; stderr: string; lines: string[] };
export type Thread = { title: string; running?: boolean; waiting?: boolean; failed?: boolean; quietMinutes?: number };
export type Check = { name: string; bucket: "pass" | "fail" | "pending" | "cancel" | "skipping" };
export type PullRequest = {
  title: string;
  headRefName: string;
  state?: "OPEN" | "MERGED" | "CLOSED";
  isDraft?: boolean;
  headRefOid?: string;
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  checks?: Check[];
};

const MINUTE = 60_000;

export class World {
  jira = new FakeJira();
  ntfy = new FakeNtfy();
  root = mkdtempSync(join(tmpdir(), "runner-"));
  repo = join(this.root, "repo");
  origin = join(this.root, "origin.git");
  fakes = join(this.root, "fakes");
  private env: NodeJS.ProcessEnv = {};

  async start(config = ""): Promise<void> {
    await this.jira.start();
    await this.ntfy.start();
    execFileSync("mkdir", ["-p", this.fakes]);
    writeFileSync(join(this.fakes, "t3.json"), JSON.stringify({ threads: [], failStart: [] }));
    writeFileSync(join(this.fakes, "github.json"), "[]");
    this.env = {
      PATH: [join(HERE, "fakes", "bin"), GIT, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      HOME: this.root,
      FAKE_DIR: this.fakes,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      JIRA_EMAIL: "owner@example.com",
      JIRA_API_TOKEN: "token",
      NTFY_TOPIC: "the-topic",
    };
    this.git(this.root, "init", "--quiet", "--bare", "--initial-branch=main", this.origin);
    this.git(this.root, "init", "--quiet", "--initial-branch=main", this.repo);
    this.git(this.repo, "remote", "add", "origin", this.origin);
    this.commit("first");
    this.git(this.repo, "push", "--quiet", "origin", "main");
    this.config(config);
  }

  async stop(): Promise<void> {
    await this.jira.stop();
    await this.ntfy.stop();
    rmSync(this.root, { recursive: true, force: true });
  }

  git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, env: this.env, encoding: "utf8" }).trim();
  }

  commit(message: string): string {
    this.git(this.repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "--allow-empty", "-m", message);
    return this.git(this.repo, "rev-parse", "HEAD");
  }

  /** Writes `runner.toml`, with the keys every repo must set before these. */
  config(extra = ""): void {
    writeFileSync(join(this.repo, "runner.toml"), `component = "agent-workflow"\njira_url = "${this.jira.url}"\nntfy_url = "${this.ntfy.url}"\n${extra}\n`);
  }

  thread(thread: Thread): void {
    const file = join(this.fakes, "t3.json");
    const state = JSON.parse(readFileSync(file, "utf8"));
    const threadId = `seeded:${state.threads.length + 1}`;
    state.threads.push({
      threadId,
      title: thread.title,
      link: `http://127.0.0.1:3773/env/${encodeURIComponent(threadId)}`,
      status: thread.running || thread.waiting ? "running" : thread.failed ? "failed" : "completed",
      activeRunId: thread.running || thread.waiting ? `run:${threadId}` : null,
      pendingRequestCount: thread.waiting ? 1 : 0,
      updatedAt: new Date(Date.now() - (thread.quietMinutes ?? 0) * MINUTE).toISOString(),
    });
    writeFileSync(file, JSON.stringify(state));
  }

  /** Ends every thread's turn, as a turn that finishes between ticks does. */
  stopThreads(): void {
    const file = join(this.fakes, "t3.json");
    const state = JSON.parse(readFileSync(file, "utf8"));
    for (const thread of state.threads) Object.assign(thread, { status: "completed", activeRunId: null, pendingRequestCount: 0 });
    writeFileSync(file, JSON.stringify(state));
  }

  failStart(key: string): void {
    const file = join(this.fakes, "t3.json");
    const state = JSON.parse(readFileSync(file, "utf8"));
    state.failStart.push(key);
    writeFileSync(file, JSON.stringify(state));
  }

  pullRequest({ title, headRefName, state = "OPEN", isDraft = false, headRefOid = "aaa111", mergeable = "MERGEABLE", checks = [] }: PullRequest): void {
    const pullRequests = this.pullRequests();
    const number = pullRequests.length + 1;
    const url = `https://github.com/o/r/pull/${number}`;
    pullRequests.push({ number, url, title, headRefName, state, isDraft, headRefOid, mergeable, autoMergeRequest: null, comments: [], checks });
    this.savePullRequests(pullRequests);
  }

  /** Changes the first pull request, as a push or a finished check does. */
  updatePullRequest(values: Partial<PullRequest>): void {
    const pullRequests = this.pullRequests();
    Object.assign(pullRequests[0], values);
    this.savePullRequests(pullRequests);
  }

  /** A comment on the first pull request, written that long ago. */
  prComment(body: string, minutesAgo = 0): void {
    const pullRequests = this.pullRequests();
    pullRequests[0].comments.push({ body, createdAt: new Date(Date.now() - minutesAgo * MINUTE).toISOString() });
    this.savePullRequests(pullRequests);
  }

  /** A comment on the ticket, written that long ago. */
  ticketComment(key: string, text: string, minutesAgo = 0): void {
    this.jira.issues.get(key)?.comments.push({ text, created: jiraTime(Date.now() - minutesAgo * MINUTE) });
  }

  pullRequests(): any[] {
    return JSON.parse(readFileSync(join(this.fakes, "github.json"), "utf8"));
  }

  private savePullRequests(pullRequests: unknown[]): void {
    writeFileSync(join(this.fakes, "github.json"), JSON.stringify(pullRequests));
  }

  /** Makes `t3` or `gh` fail each call. */
  down(tool: "t3" | "gh"): void {
    writeFileSync(join(this.fakes, `${tool}.down`), "");
  }

  unset(name: string): void {
    delete this.env[name];
  }

  /** Runs `runner` in the repo with these arguments, to its end. */
  runner(...args: string[]): Promise<Tick> {
    return new Promise((resolve) => {
      execFile(RUNNER, args, { cwd: this.repo, env: this.env, timeout: 30_000 }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout, stderr, lines: stdout.split("\n").filter(Boolean) });
      });
    });
  }

  tick(): Promise<Tick> {
    return this.runner("tick");
  }

  dryRun(): Promise<Tick> {
    return this.runner("tick", "--dry-run");
  }

  /** Each `gh` call that reached the fake and wrote, as its arguments. */
  ghWrites(): string[][] {
    const file = join(this.fakes, "gh.jsonl");
    if (!existsSync(file)) return [];
    const calls: string[][] = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return calls.filter(([, verb]) => verb === "comment" || verb === "merge");
  }

  /** Each message sent to a thread, as its thread's id and its text. */
  sends(): { threadId: string; message: string }[] {
    return this.t3Calls()
      .filter((args) => args.includes("send"))
      .map((args) => ({ threadId: args.at(-2) as string, message: args.at(-1) as string }));
  }

  /** Each `t3` call that reached the fake, as its arguments. */
  t3Calls(): string[][] {
    const file = join(this.fakes, "t3.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  starts(): Start[] {
    return this.t3Calls()
      .filter((args) => args.includes("start"))
      .map((args) => ({
        args,
        title: args[args.indexOf("--title") + 1],
        provider: args[args.indexOf("--provider") + 1],
        model: args[args.indexOf("--model") + 1],
        worktree: args[args.indexOf("--worktree") + 1],
        branch: args[args.indexOf("--branch") + 1],
        project: args.at(-2) as string,
        message: args.at(-1) as string,
      }));
  }

  titles(): string[] {
    return this.starts().map((start) => start.title);
  }
}

export type Start = { args: string[]; title: string; provider: string; model: string; worktree: string; branch: string; project: string; message: string };
