// A run turns each ticket of the frontier into one pull request. A ticket is a fixed list of steps: build,
// push, pull request, wait, merge. The gate on GitHub checks the work, so the loop runs no gate, no review,
// no landing, and no Epic branch of its own. A restart starts each ticket at its first step.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ask } from "./agent.ts";
import type { Config } from "./config.ts";
import { git, slug } from "./git.ts";
import * as github from "./github.ts";
import { type Ticket, Jira } from "./jira.ts";
import { Log } from "./log.ts";

/** The longest the loop waits for the checks of one pull request. */
const WAIT_MINUTES = 120;

export type Target = { key: string } | { filter: string };

export type Options = { pollSeconds: number };

type State = "merged" | "done" | "flagged" | "ready" | "waiting";

type Finished = "merged" | "stopped";

export function runName(target: Target): string {
  if ("key" in target) return target.key;
  return `filter-${createHash("sha256").update(target.filter).digest("hex").slice(0, 8)}`;
}

function branchPrefixes(key: string): string[] {
  return [`feat/${key}-`, `fix/${key}-`];
}

function ownsBranch(key: string, branch: string): boolean {
  return branchPrefixes(key).some((prefix) => branch.startsWith(prefix));
}

export class Run {
  private readonly config: Config;
  private readonly secrets: Record<string, string>;
  private readonly target: Target;
  private readonly options: Options;
  private readonly jira: Jira;
  private readonly name: string;
  private readonly home: string;
  readonly log: Log;
  private epic: string | null = null;
  private readonly merged = new Set<string>();

  constructor(config: Config, secrets: Record<string, string>, target: Target, options: Options) {
    this.config = config;
    this.secrets = secrets;
    this.target = target;
    this.options = options;
    this.jira = new Jira(config.trackerUrl, secrets.JIRA_EMAIL ?? "", secrets.JIRA_API_TOKEN ?? "");
    this.name = runName(target);
    this.home = join(config.stateDir, this.name);
    this.log = new Log(join(this.home, "decisions.jsonl"), this.name);
  }

  /** Builds the frontier until no ticket is left to start, and returns the exit code. */
  async run(): Promise<number> {
    const input = "key" in this.target ? this.target.key : `--filter ${this.target.filter}`;
    this.log.write(this.name, "start", "ok", { detail: this.config.mainBranch, input });
    const tickets = await this.tickets();
    await git(this.config.repo, "fetch", "--prune", "--quiet", "origin");
    const prs = await github.pullRequests(this.config.repo);
    for (const ticket of tickets) {
      if (prs.some((pr) => pr.state === "MERGED" && ownsBranch(ticket.key, pr.headRefName))) this.merged.add(ticket.key);
    }
    const states = new Map(tickets.map((ticket) => [ticket.key, this.state(ticket)]));
    this.log.write(this.name, "frontier", "ok", {
      detail: tickets.map((ticket) => `${ticket.key} ${states.get(ticket.key)}`).join(", "),
      tickets: tickets.map((ticket) => ({
        key: ticket.key,
        summary: ticket.summary,
        status: ticket.status,
        state: states.get(ticket.key),
        blockers: ticket.blockers.map((blocker) => blocker.key),
      })),
    });
    for (const ticket of tickets) {
      if (this.merged.has(ticket.key)) {
        const pr = prs.find((item) => item.state === "MERGED" && ownsBranch(ticket.key, item.headRefName));
        this.log.write(ticket.key, "start", "merged-before", { pr: pr?.url, detail: "Its pull request merged before this run." });
      }
    }

    const finished = new Map<string, Finished>();
    const running = new Map<string, Promise<void>>();
    for (;;) {
      for (const ticket of tickets) {
        if (running.size >= this.config.parallel) break;
        if (running.has(ticket.key) || finished.has(ticket.key) || this.state(ticket) !== "ready") continue;
        const work = this.ticket(ticket)
          .catch((error: Error) => {
            this.log.write(ticket.key, "stop", "loop-error", { detail: error.message });
            return "stopped" as const;
          })
          .then((result) => {
            finished.set(ticket.key, result);
            running.delete(ticket.key);
          });
        running.set(ticket.key, work);
      }
      if (!running.size) break;
      await Promise.race(running.values());
    }

    const stopped = [...finished].filter(([, result]) => result === "stopped").map(([key]) => key);
    const left = tickets.filter((ticket) => !finished.has(ticket.key) && this.state(ticket) === "waiting");
    const parts = [
      `merged: ${tickets.filter((ticket) => this.merged.has(ticket.key)).map((ticket) => ticket.key).join(", ") || "none"}`,
    ];
    if (stopped.length) parts.push(`stopped: ${stopped.join(", ")}`);
    if (left.length) parts.push(`waiting on a blocker: ${left.map((ticket) => ticket.key).join(", ")}`);
    const detail = parts.join(". ");
    this.log.write(this.name, "finish", stopped.length ? "stopped" : "ok", { detail });
    await this.notify(`${this.name} finished. ${detail}`);
    return stopped.length ? 1 : 0;
  }

  /** The tickets of an Epic, the one ticket of a key, or the tickets a filter finds. */
  private async tickets(): Promise<Ticket[]> {
    if ("filter" in this.target) return this.jira.search(this.target.filter);
    const ticket = await this.jira.ticket(this.target.key);
    if (ticket.issueType === "Epic") {
      this.epic = ticket.key;
      return this.jira.search(`parent = ${ticket.key} ORDER BY key ASC`);
    }
    this.epic = ticket.parent;
    return [ticket];
  }

  private state(ticket: Ticket): State {
    if (this.merged.has(ticket.key)) return "merged";
    if (ticket.done) return "done";
    if (ticket.flagged) return "flagged";
    const clear = ticket.blockers.every((blocker) => blocker.done || this.merged.has(blocker.key));
    return clear ? "ready" : "waiting";
  }

  private async ticket(ticket: Ticket): Promise<Finished> {
    const repo = this.config.repo;
    const key = ticket.key;
    const worktree = join(this.home, "worktrees", key);
    const runDir = join(this.home, "runs", key);
    mkdirSync(runDir, { recursive: true });
    const restart = this.log.lines().some((line) => line.ticket === key && line.step === "start" && line.result !== "merged-before");
    await git(repo, "fetch", "--prune", "--quiet", "origin");
    const branch = await this.worktree(ticket, worktree);
    this.log.write(key, "start", restart ? "restart" : "new", { detail: branch });
    if (ticket.status !== this.config.inProgress) await this.status(key, this.config.inProgress);
    await this.writeTicket(ticket, branch, runDir);

    // Build
    const base = `origin/${this.config.mainBranch}`;
    let commit = await git(worktree, "rev-parse", "HEAD");
    this.log.write(key, "build", "started", { commit, attempt: 1 });
    const resume = this.log.lines().findLast((line) => line.ticket === key && line.step === "agent" && line.session)?.session;
    const session = await ask({
      prompt: `/implement ${join(runDir, "ticket.md")}`,
      cwd: worktree,
      resume: resume ?? null,
      model: this.config.agentModel,
      effort: this.config.agentEffort,
      env: this.agentEnv(runDir),
      log: nextLog(runDir),
      minutes: this.config.agentTimeoutMinutes,
      stateDir: this.config.stateDir,
    });
    commit = await git(worktree, "rev-parse", "HEAD");
    this.log.write(key, "agent", session.result, {
      commit,
      session: session.session,
      detail: session.detail,
      cost: session.cost,
      usage: session.usage,
    });
    if (session.result !== "done") {
      this.log.write(key, "build", session.result === "blocked" ? "blocked" : "fail", { commit, session: session.session, detail: session.detail });
      return "stopped";
    }
    if (!(await git(worktree, "rev-list", "--count", `${base}..HEAD`)).match(/^[1-9]/)) {
      this.log.write(key, "build", "fail", { commit, session: session.session, detail: "The agent returned done with no commit on the branch." });
      return "stopped";
    }
    this.log.write(key, "build", "pass", { commit, session: session.session });

    // Push
    try {
      await git(worktree, "push", "--quiet", "--force-with-lease", "-u", "origin", `HEAD:refs/heads/${branch}`);
      this.log.write(key, "push", "ok", { commit });
    } catch (error) {
      this.log.write(key, "push", "fail", { commit, detail: (error as Error).message });
      return "stopped";
    }

    // Pull request
    let url: string;
    try {
      url = await this.pullRequest(ticket, branch, runDir, session.output?.reason ?? "", session.output?.decisions ?? []);
    } catch (error) {
      this.log.write(key, "pr", "fail", { commit, detail: (error as Error).message });
      return "stopped";
    }
    let autoMerge = true;
    let detail = "";
    try {
      await github.autoMerge(repo, url);
    } catch (error) {
      autoMerge = false;
      detail = `Auto-merge is off: ${(error as Error).message}`;
    }
    this.log.write(key, "pr", "open", { commit, pr: url, auto_merge: autoMerge, detail });
    await this.status(key, this.config.inReview);

    // Wait
    const checks = await this.wait(url);
    this.log.write(key, "wait", checks.result, { commit, pr: url, checks: checks.checks, detail: checks.detail });
    if (checks.result !== "green") return "stopped";

    // Merge
    const merged = await this.merge(url);
    if (merged === null) {
      this.log.write(key, "merge", "fail", { pr: url, detail: "The pull request did not merge." });
      return "stopped";
    }
    this.log.write(key, "merge", "merged", { commit: merged, pr: url });
    this.merged.add(key);
    return "merged";
  }

  /** Reuses the ticket's branch and worktree from an earlier run, or branches from main. */
  private async worktree(ticket: Ticket, path: string): Promise<string> {
    const repo = this.config.repo;
    const refs = await git(
      repo,
      "for-each-ref",
      "--format=%(refname)",
      ...branchPrefixes(ticket.key).flatMap((prefix) => [`refs/heads/${prefix}*`, `refs/remotes/origin/${prefix}*`]),
    );
    const found = refs.split("\n").filter(Boolean);
    const local = found.find((ref) => ref.startsWith("refs/heads/"));
    const remote = found.find((ref) => ref.startsWith("refs/remotes/origin/"));
    const type = ticket.issueType === "Bug" ? "fix" : "feat";
    const branch = local?.slice("refs/heads/".length) ?? remote?.slice("refs/remotes/origin/".length) ?? `${type}/${ticket.key}-${slug(ticket.summary)}`;
    await git(repo, "worktree", "prune");
    if (existsSync(path)) return branch;
    if (local) await git(repo, "worktree", "add", "--quiet", path, branch);
    else if (remote) await git(repo, "worktree", "add", "--quiet", "--track", "-b", branch, path, `origin/${branch}`);
    else await git(repo, "worktree", "add", "--quiet", "--no-track", "-b", branch, path, `origin/${this.config.mainBranch}`);
    return branch;
  }

  private async writeTicket(ticket: Ticket, branch: string, runDir: string): Promise<void> {
    let text = `# ${ticket.key}: ${ticket.summary}\n\n${ticket.text.trim()}\n\n`;
    const comments = await this.jira.comments(ticket.key);
    if (comments.length) {
      text += "## Comments\n\nThe comments on the ticket, oldest first.\n\n";
      text += comments.join("\n\n---\n\n") + "\n\n";
    }
    text += "## Loop\n\n";
    if (this.epic) text += `- The Epic is ${this.epic}.\n`;
    text +=
      `- Commit on the branch \`${branch}\` with ${ticket.key} as the commit scope. ` +
      "Do not push, and do not open a pull request.\n" +
      `- The run folder is \`${runDir}\`.\n` +
      "- After you return done, the loop pushes the branch and opens a pull request with auto-merge on. " +
      "The merge gate runs every check on it. Run the tests that cover your change.\n";
    if (this.config.agentHint) text += `- ${this.config.agentHint}\n`;
    writeFileSync(join(runDir, "ticket.md"), text);
  }

  /** The open pull request of the branch, or a new one whose title becomes the squash commit on main. */
  private async pullRequest(ticket: Ticket, branch: string, runDir: string, reason: string, decisions: string[]): Promise<string> {
    const repo = this.config.repo;
    const open = (await github.pullRequests(repo)).find((pr) => pr.state === "OPEN" && pr.headRefName === branch);
    if (open) return open.url;
    const bodyFile = join(runDir, "pr-body.md");
    if (!existsSync(bodyFile)) {
      const browse = `${this.config.trackerUrl.replace(/\/$/, "")}/browse/${ticket.key}`;
      let body = `[${ticket.key}](${browse}): ${ticket.summary}\n\n${reason}\n`;
      if (decisions.length) body += `\n## Decisions\n\n${decisions.map((item) => `- ${item}`).join("\n")}\n`;
      writeFileSync(bodyFile, body);
    }
    const type = ticket.issueType === "Bug" ? "fix" : "feat";
    return github.create(repo, branch, this.config.mainBranch, `${type}(${ticket.key}): ${ticket.summary}`, bodyFile);
  }

  /** Polls the check runs until one fails, all pass, or the wait runs out. */
  private async wait(url: string): Promise<{ result: "green" | "red" | "timeout"; checks: { name: string; bucket: string }[]; detail: string }> {
    const deadline = Date.now() + WAIT_MINUTES * 60_000;
    let checks: { name: string; bucket: string }[] = [];
    for (;;) {
      try {
        checks = (await github.checks(this.config.repo, url)).map(({ name, bucket }) => ({ name, bucket }));
      } catch (error) {
        console.error((error as Error).message);
      }
      const red = checks.filter((check) => check.bucket === "fail" || check.bucket === "cancel");
      if (red.length) return { result: "red", checks, detail: `Failed: ${red.map((check) => check.name).join(", ")}` };
      if (checks.length && checks.every((check) => check.bucket === "pass" || check.bucket === "skipping")) {
        return { result: "green", checks, detail: "" };
      }
      if (Date.now() >= deadline) return { result: "timeout", checks, detail: `The checks ran past ${WAIT_MINUTES} min.` };
      await sleep(this.options.pollSeconds);
    }
  }

  /** Auto-merge merges a green pull request. The loop merges it when GitHub has not yet, and returns the commit. */
  private async merge(url: string): Promise<string | null> {
    const repo = this.config.repo;
    for (let attempt = 0; attempt < 5; attempt++) {
      const pr = await github.view(repo, url);
      if (pr.state === "MERGED") return pr.mergeCommit?.oid ?? "";
      if (pr.state === "CLOSED") return null;
      if (attempt === 1) await github.merge(repo, url).catch((error: Error) => console.error(error.message));
      await sleep(this.options.pollSeconds);
    }
    return null;
  }

  private async status(key: string, status: string): Promise<void> {
    try {
      await this.jira.transition(key, status);
      this.log.write(key, "tracker-status", "ok", { detail: status });
    } catch (error) {
      this.log.write(key, "tracker-status", "fail", { detail: `${status}: ${(error as Error).message}` });
    }
  }

  private agentEnv(runDir: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) if (value !== undefined && name !== "BW_SESSION") env[name] = value;
    return { ...env, ...this.secrets, LOOP_RUN_DIR: runDir, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" };
  }

  /** An ntfy message holds the run and its result only. */
  private async notify(message: string): Promise<void> {
    const url = `${this.config.ntfyUrl.replace(/\/$/, "")}/${this.secrets.NTFY_TOPIC}`;
    try {
      const response = await fetch(url, { method: "POST", body: message, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.log.write(this.name, "notify", "ok", { detail: message });
    } catch (error) {
      this.log.write(this.name, "notify", "fail", { detail: `${message}: ${(error as Error).message}` });
    }
  }
}

function nextLog(runDir: string): string {
  const taken = readdirSync(runDir).filter((name) => /^agent-\d+\.jsonl$/.test(name)).length;
  return join(runDir, `agent-${taken + 1}.jsonl`);
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
