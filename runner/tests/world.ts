// A scenario's world: a repo with a bare origin, a fake Jira, and the fakes of `t3` and `gh` on the PATH.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FakeJira } from "./fakes/jira.ts";

const HERE = import.meta.dirname;
const RUNNER = join(HERE, "..", "bin", "runner");
const GIT = dirname(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim());

export type Tick = { code: number; stdout: string; stderr: string; lines: string[] };
export type Thread = { title: string; running?: boolean; waiting?: boolean };
export type PullRequest = { title: string; headRefName: string; state?: "OPEN" | "MERGED" | "CLOSED" };

export class World {
  jira = new FakeJira();
  root = mkdtempSync(join(tmpdir(), "runner-"));
  repo = join(this.root, "repo");
  origin = join(this.root, "origin.git");
  fakes = join(this.root, "fakes");
  private env: NodeJS.ProcessEnv = {};

  async start(config = ""): Promise<void> {
    await this.jira.start();
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
    writeFileSync(join(this.repo, "runner.toml"), `component = "agent-workflow"\njira_url = "${this.jira.url}"\n${extra}\n`);
  }

  thread(thread: Thread): void {
    const file = join(this.fakes, "t3.json");
    const state = JSON.parse(readFileSync(file, "utf8"));
    const threadId = `seeded:${state.threads.length + 1}`;
    state.threads.push({
      threadId,
      title: thread.title,
      status: thread.running || thread.waiting ? "running" : "completed",
      activeRunId: thread.running || thread.waiting ? `run:${threadId}` : null,
      pendingRequestCount: thread.waiting ? 1 : 0,
      updatedAt: "2026-11-04T00:00:00.000Z",
    });
    writeFileSync(file, JSON.stringify(state));
  }

  failStart(key: string): void {
    const file = join(this.fakes, "t3.json");
    const state = JSON.parse(readFileSync(file, "utf8"));
    state.failStart.push(key);
    writeFileSync(file, JSON.stringify(state));
  }

  pullRequest({ title, headRefName, state = "OPEN" }: PullRequest): void {
    const file = join(this.fakes, "github.json");
    const pullRequests = JSON.parse(readFileSync(file, "utf8"));
    const number = pullRequests.length + 1;
    pullRequests.push({ number, url: `https://github.com/o/r/pull/${number}`, title, headRefName, state, isDraft: false });
    writeFileSync(file, JSON.stringify(pullRequests));
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
