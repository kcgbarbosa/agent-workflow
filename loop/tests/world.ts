// One scenario's world: a git repo with a bare origin, the fake Jira, the fake `gh`, the fake `claude`, and
// the loop's own checkout with an origin of its own, all in a temporary folder with no network.
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Line } from "../src/log.ts";
import { FakeJira } from "./fakes/jira.ts";

const LOOP = resolve(import.meta.dirname, "..", "bin", "loop");
const FAKES = resolve(import.meta.dirname, "fakes");

export const EPIC = "DEMO-1";

export type Ran = { code: number; stdout: string; stderr: string };

export type Watching = {
  url: string;
  get(path: string, host?: string): Promise<{ status: number; body: any }>;
  close(): Promise<void>;
};

export type PullRequest = {
  number: number;
  url: string;
  headRefName: string;
  baseRefName: string;
  isDraft?: boolean;
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

  /** The bucket of each pull request's check, by ticket key: one for every push, or one per push. */
  verdicts(verdicts: Record<string, string | string[]>): void {
    writeFileSync(join(this.fakes, "verdicts.json"), JSON.stringify(verdicts));
  }

  /** The findings of the gate's review of each new pull request, by ticket key. */
  reviews(reviews: Record<string, { path: string; line: number; severity: "blocking" | "minor"; sentence: string; outside?: boolean }[]>): void {
    writeFileSync(join(this.fakes, "reviews.json"), JSON.stringify(reviews));
  }

  /** The log of each failed job. */
  jobLog(text: string): void {
    writeFileSync(join(this.fakes, "job-log.txt"), text);
  }

  /** GitHub leaves the pull requests on a merged branch where they are, as when the repo keeps merged branches. */
  noRetarget(): void {
    writeFileSync(join(this.fakes, "no-retarget"), "");
  }

  /** The running containers that `docker ps` lists: project, name, and ports, tab-separated, one per line. */
  containers(lines: string[]): void {
    writeFileSync(join(this.fakes, "containers.txt"), lines.map((line) => line + "\n").join(""));
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

  /** Starts `loop watch` on a free port, and returns once it serves. */
  async watch(): Promise<Watching> {
    const child = spawn(LOOP, ["watch", "--repo", this.repo], { env: { ...this.env, LOOP_WATCH_PORT: "0" } });
    const url = await new Promise<string>((done, fail) => {
      let output = "";
      child.stdout.on("data", (data: Buffer) => {
        output += data;
        const found = /serves the demo runs at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output);
        if (found) done(found[1]!);
      });
      child.stderr.on("data", (data: Buffer) => (output += data));
      child.once("close", (code) => fail(new Error(`loop watch exited with ${code}: ${output}`)));
    });
    // `fetch` sets the Host header itself, and the page's answer depends on it.
    const get = (path: string, host = "localhost") =>
      new Promise<{ status: number; body: any }>((done, fail) => {
        const request = httpGet(url + path.replace(/^\//, ""), { headers: { host } }, (response) => {
          let text = "";
          response.on("data", (data: Buffer) => (text += data));
          response.on("end", () =>
            done({ status: response.statusCode ?? 0, body: response.headers["content-type"]?.includes("json") ? JSON.parse(text) : text }),
          );
        });
        request.once("error", fail);
      });
    const close = () =>
      new Promise<void>((done) => {
        if (child.exitCode !== null) return done();
        child.once("close", () => done());
        child.kill("SIGTERM");
      });
    return { url, get, close };
  }

  /** Writes a recorded decisions log for the run. */
  record(lines: object[], run = EPIC): void {
    mkdirSync(join(this.state, run), { recursive: true });
    const start = Date.parse("2026-10-20T10:00:00Z");
    const text = lines.map((line, index) => JSON.stringify({
      time: new Date(start + index * 60_000).toISOString().replace(/\.\d+Z$/, "+00:00"),
      epic: run,
      commit: null,
      session: null,
      detail: "",
      ...line,
    }) + "\n");
    writeFileSync(join(this.state, run, "decisions.jsonl"), text.join(""));
  }

  /** The calls of the fake `systemd-run`, `systemctl`, and `systemd-inhibit`, in order. */
  systemd(): { tool: string; args: string[] }[] {
    const path = join(this.fakes, "systemd.jsonl");
    return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  }

  /** Whether the fake unit's process lives. */
  unitAlive(unit: string): boolean {
    const path = join(this.fakes, "units", `${unit}.json`);
    if (!existsSync(path)) return false;
    const { pid } = JSON.parse(readFileSync(path, "utf8")) as { pid: number | null };
    if (pid === null) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** Waits until the run that `loop start` started in its unit ends, and returns what it printed. */
  async untilUnitEnds(unit: string): Promise<string> {
    await this.until(() => !this.unitAlive(unit), `${unit} to end`);
    return readFileSync(join(this.fakes, "units", `${unit}.log`), "utf8");
  }

  /** A command of this test alone, first on the PATH, such as a fake `bw`. */
  command(name: string, script: string): void {
    const bin = join(this.fakes, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, name), script, { mode: 0o755 });
    if (!this.env.PATH!.startsWith(bin)) this.env.PATH = `${bin}:${this.env.PATH}`;
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

  /** Changes the fake GitHub's state under the lock the fake `gh` takes, so neither loses the other's write. */
  private github(change: (state: { prs: any[] }) => void): void {
    const lock = join(this.fakes, "github.lock");
    for (;;) {
      try {
        mkdirSync(lock);
        break;
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try {
      const path = join(this.fakes, "github.json");
      const state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { prs: [] };
      change(state);
      writeFileSync(path, JSON.stringify(state, null, 2));
    } finally {
      rmdirSync(lock);
    }
  }

  /** Sets the checks of the ticket's pull request, as the gate would. Each named check takes its bucket. */
  setChecks(key: string, buckets: Record<string, "pass" | "fail" | "pending">): void {
    const states = { pass: "SUCCESS", fail: "FAILURE", pending: "PENDING" };
    this.github((state) => {
      for (const pr of state.prs) {
        if (!pr.headRefName.includes(`/${key}-`)) continue;
        for (const [name, bucket] of Object.entries(buckets)) {
          const check = { name, bucket, state: states[bucket] };
          const index = pr.checks.findIndex((item: { name: string }) => item.name === name);
          if (index >= 0) pr.checks[index] = check;
          else pr.checks.push(check);
        }
      }
    });
  }

  /** Converts the ticket's pull request to a draft, or back. */
  draft(key: string, on: boolean): void {
    this.github((state) => {
      for (const pr of state.prs) if (pr.headRefName.includes(`/${key}-`)) pr.isDraft = on;
    });
  }

  setCheck(key: string, bucket: "pass" | "fail"): void {
    this.setChecks(key, { "gate / check": bucket });
  }

  /** A pull request merged before the run, with its branch named as the loop names it. */
  mergedBefore(key: string, branch: string, title = `feat(${key}): earlier`): void {
    this.github((state) => state.prs.push({
      number: 100 + state.prs.length,
      url: `https://github.com/kcgbarbosa/demo/pull/${100 + state.prs.length}`,
      headRefName: branch,
      baseRefName: "main",
      title,
      body: "",
      state: "MERGED",
      autoMerge: null,
      mergeCommit: { oid: "0".repeat(40) },
      checks: [{ name: "gate / check", bucket: "pass", state: "SUCCESS" }],
    }));
  }

  calls(): {
    key: string;
    prompt: string;
    resume: string | null;
    cwd: string;
    bw_session: string | null;
    port: string | null;
    compose: string | null;
    met: boolean;
  }[] {
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
