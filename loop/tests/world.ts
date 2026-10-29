// One scenario's world: a git repo with a bare origin, the fake Jira, the fake `gh`, the fake `claude`, and
// the loop's own checkout with an origin of its own, all in a temporary folder with no network.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Line } from "../src/log.ts";
import { FakeJira } from "./fakes/jira.ts";

const LOOP = resolve(import.meta.dirname, "..", "bin", "loop");
const FAKES = resolve(import.meta.dirname, "fakes");

export const EPIC = "DEMO-1";

export type Ran = { code: number; stdout: string; stderr: string };

export type PullRequest = {
  number: number;
  url: string;
  headRefName: string;
  baseRefName: string;
  title: string;
  body: string;
  state: string;
  autoMerge: { mergeMethod: string } | null;
  mergeCommit: { oid: string } | null;
  checks: { name: string; bucket: string; state: string }[];
};

function which(tool: string): string {
  return dirname(execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim());
}

export class World {
  readonly root = mkdtempSync(join(tmpdir(), "loop-"));
  readonly origin = join(this.root, "origin.git");
  readonly repo = join(this.root, "demo");
  readonly home = join(this.root, "home");
  readonly fakes = join(this.root, "fakes");
  readonly checkout = join(this.root, "agent-workflow");
  readonly checkoutOrigin = join(this.root, "agent-workflow.git");
  readonly state = join(this.home, ".local", "state", "demo-loop");
  readonly env: NodeJS.ProcessEnv;
  readonly jira: FakeJira;

  private constructor(jira: FakeJira) {
    this.jira = jira;
    mkdirSync(this.fakes);
    mkdirSync(this.state, { recursive: true });
    const gitconfig = join(this.root, "gitconfig");
    writeFileSync(gitconfig, "[user]\n\tname = Loop Test\n\temail = loop@test\n[init]\n\tdefaultBranch = main\n");
    this.env = {
      PATH: [join(FAKES, "bin"), which("git"), which("node"), "/usr/bin", "/bin"].join(":"),
      HOME: this.home,
      LANG: "C.UTF-8",
      GIT_CONFIG_GLOBAL: gitconfig,
      GIT_CONFIG_NOSYSTEM: "1",
      FAKE_DIR: this.fakes,
      FAKE_ORIGIN: this.origin,
      LOOP_CHECKOUT: this.checkout,
      LOOP_POLL_SECONDS: "0.05",
      BW_SESSION: "vault-session-key",
      NODE_OPTIONS: `--import=${join(FAKES, "offline.mjs")}`,
    };
    this.git(this.root, "init", "--quiet", "--bare", this.origin);
    this.git(this.root, "init", "--quiet", this.repo);
    this.git(this.repo, "remote", "add", "origin", this.origin);
    writeFileSync(join(this.repo, "README.md"), "# Demo\n");
    this.writeConfig();
    this.git(this.repo, "add", "-A");
    this.git(this.repo, "commit", "--quiet", "-m", "chore: start");
    this.git(this.repo, "push", "--quiet", "origin", "main");
    this.git(this.root, "init", "--quiet", "--bare", this.checkoutOrigin);
    this.git(this.root, "init", "--quiet", this.checkout);
    this.git(this.checkout, "remote", "add", "origin", this.checkoutOrigin);
    this.commitTo(this.checkout, { "config/settings.json": "{}\n", "loop/run.ts": "one\n" }, "chore: start");
    writeFileSync(join(this.state, "secrets.json"), JSON.stringify({ JIRA_EMAIL: "kc@example.com", JIRA_API_TOKEN: "token", NTFY_TOPIC: "topic" }));
    jira.add(EPIC, "The Loop", { issueType: "Epic" });
  }

  static async create(): Promise<World> {
    return new World(await FakeJira.start());
  }

  async close(): Promise<void> {
    await this.jira.close();
    rmSync(this.root, { recursive: true, force: true });
  }

  git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, env: this.env, encoding: "utf8" }).trim();
  }

  /** Writes the files in the clone, commits them, and pushes main. */
  commitTo(clone: string, files: Record<string, string>, message: string): void {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(clone, path)), { recursive: true });
      writeFileSync(join(clone, path), text);
    }
    this.git(clone, "add", "-A");
    this.git(clone, "commit", "--quiet", "-m", message);
    this.git(clone, "push", "--quiet", "-u", "origin", "HEAD:main");
  }

  writeConfig(extra = ""): void {
    const config = `name = "demo"

[tracker]
kind = "jira"
url = "${this.jira.url}"

[notify]
url = "${this.jira.url}/ntfy"

[secrets]
JIRA_EMAIL = { item = "Jira", field = "username" }
JIRA_API_TOKEN = { item = "Jira", field = "password" }
NTFY_TOPIC = { item = "ntfy", field = "topic" }
${extra}`;
    writeFileSync(join(this.repo, "loop.toml"), config);
  }

  /** The agent's steps for a ticket. */
  plan(plans: Record<string, object[]>): void {
    writeFileSync(join(this.fakes, "plan.json"), JSON.stringify(plans));
  }

  /** The bucket each new pull request's check starts with, by ticket key. */
  verdicts(verdicts: Record<string, string>): void {
    writeFileSync(join(this.fakes, "verdicts.json"), JSON.stringify(verdicts));
  }

  /** Runs the loop to its end. */
  loop(...args: string[]): Promise<Ran> {
    return new Promise((done) => {
      execFile(LOOP, [...args, "--repo", this.repo], { env: this.env, timeout: 60_000 }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        done({ code, stdout, stderr });
      });
    });
  }

  /** Waits until the test's condition holds, as the loop runs beside it. */
  async until(condition: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  decisions(run = EPIC): Line[] {
    const path = join(this.state, run, "decisions.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Line);
  }

  steps(run = EPIC): string[] {
    return this.decisions(run).map((line) => `${line.ticket} ${line.step} ${line.result}`);
  }

  prs(): PullRequest[] {
    const path = join(this.fakes, "github.json");
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")).prs as PullRequest[]) : [];
  }

  /** Sets the check of the ticket's pull request, as the gate would. */
  setCheck(key: string, bucket: "pass" | "fail"): void {
    const path = join(this.fakes, "github.json");
    const state = JSON.parse(readFileSync(path, "utf8"));
    for (const pr of state.prs) {
      if (pr.headRefName.includes(`/${key}-`)) pr.checks = [{ name: "gate / check", bucket, state: bucket === "pass" ? "SUCCESS" : "FAILURE" }];
    }
    writeFileSync(path, JSON.stringify(state, null, 2));
  }

  /** A pull request merged before the run, with its branch named as the loop names it. */
  mergedBefore(key: string, branch: string): void {
    const path = join(this.fakes, "github.json");
    const state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { prs: [] };
    state.prs.push({
      number: 100 + state.prs.length,
      url: `https://github.com/kcgbarbosa/demo/pull/${100 + state.prs.length}`,
      headRefName: branch,
      baseRefName: "main",
      title: `feat(${key}): earlier`,
      body: "",
      state: "MERGED",
      autoMerge: null,
      mergeCommit: { oid: "0".repeat(40) },
      checks: [{ name: "gate / check", bucket: "pass", state: "SUCCESS" }],
    });
    writeFileSync(path, JSON.stringify(state, null, 2));
  }

  calls(): { key: string; prompt: string; resume: string | null; cwd: string; bw_session: string | null }[] {
    const path = join(this.fakes, "calls.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  ghCalls(): string[][] {
    const path = join(this.fakes, "gh.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).args);
  }

  /** The subjects on origin's main, newest first. */
  mainLog(): string[] {
    return this.git(this.origin, "log", "--format=%s", "main").split("\n");
  }
}
