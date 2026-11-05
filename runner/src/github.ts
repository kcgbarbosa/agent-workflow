// The pull request calls of the runner, all through `gh`.
import { output, run } from "./exec.ts";

export type Check = { name: string; bucket: string };

export type PullRequest = {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  headRefName: string;
  headRefOid: string;
  isDraft: boolean;
  /** MERGEABLE, CONFLICTING, or UNKNOWN while GitHub works it out. */
  mergeable: string;
  /** Set while auto-merge is on. */
  autoMergeRequest: unknown;
  comments: { body: string; createdAt: string }[];
  /** The required checks of an open pull request. */
  checks: Check[];
};

const FIELDS = "number,title,url,state,headRefName,headRefOid,isDraft,mergeable,autoMergeRequest,comments";

/**
 * The pull requests in any state that may be the ticket's. A search for the key in the title finds one whose branch
 * was named from an older summary, and the head branch finds one the search index has not taken in yet. Neither
 * has a count that older pull requests of the repo could fill.
 */
export async function pullRequestsNaming(cwd: string, key: string, branch: string): Promise<Omit<PullRequest, "checks">[]> {
  const searched = await run("gh", ["pr", "list", "--state", "all", "--search", `"${key}" in:title`, "--limit", "100", "--json", FIELDS], cwd);
  const headed = await run("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", FIELDS], cwd);
  const found = new Map<number, Omit<PullRequest, "checks">>();
  for (const pr of [...JSON.parse(searched || "[]"), ...JSON.parse(headed || "[]")] as PullRequest[]) found.set(pr.number, pr);
  return [...found.values()];
}

/** The open pull requests of the repo, with or without a ticket. */
export async function openPullRequests(cwd: string): Promise<(Pick<PullRequest, "number" | "title" | "url" | "isDraft"> & { author: { login: string } })[]> {
  return JSON.parse((await run("gh", ["pr", "list", "--state", "open", "--limit", "100", "--json", "number,title,url,isDraft,author"], cwd)) || "[]");
}

/**
 * The required check runs, so a failing check that branch protection does not require never reads as red.
 * `gh pr checks` exits 8 while one is pending and 1 when one failed or none exist yet.
 */
export async function checksOf(cwd: string, url: string): Promise<Check[]> {
  const { stdout, stderr } = await output("gh", ["pr", "checks", url, "--required", "--json", "name,bucket"], cwd);
  if (stdout.trim().startsWith("[")) return JSON.parse(stdout);
  if (/no (?:required )?checks reported/i.test(stderr)) return [];
  throw new Error(`gh pr checks: ${(stderr || stdout).trim()}`);
}

export async function comment(cwd: string, url: string, body: string): Promise<void> {
  await run("gh", ["pr", "comment", url, "--body", body], cwd);
}

/** Auto-merge as a squash, so the pull request title becomes the commit on main. */
export async function autoMerge(cwd: string, url: string): Promise<void> {
  await run("gh", ["pr", "merge", url, "--auto", "--squash"], cwd);
}

export async function autoMergeOff(cwd: string, url: string): Promise<void> {
  await run("gh", ["pr", "merge", url, "--disable-auto"], cwd);
}

export async function draft(cwd: string, url: string): Promise<void> {
  await run("gh", ["pr", "ready", url, "--undo"], cwd);
}

export async function ready(cwd: string, url: string): Promise<void> {
  await run("gh", ["pr", "ready", url], cwd);
}

/** The url of the open pull request from the branch, if any. */
export async function openFrom(cwd: string, branch: string): Promise<string | null> {
  const [open] = JSON.parse((await run("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "url"], cwd)) || "[]");
  return open?.url ?? null;
}

/** Opens a pull request of the pushed branch against the default branch, and returns its url. */
export async function create(cwd: string, head: string, title: string, body: string): Promise<string> {
  return (await run("gh", ["pr", "create", "--head", head, "--title", title, "--body", body], cwd)).trim().split("\n").at(-1) as string;
}

/** The GitHub URL of the repo at cwd, as a Spec line links it, or nothing when origin is not on GitHub. */
export async function repoUrl(cwd: string): Promise<string> {
  const { stdout } = await output("git", ["remote", "get-url", "origin"], cwd);
  const name = /github\.com[:/](.+?)(?:\.git)?\s*$/.exec(stdout)?.[1];
  return name ? `https://github.com/${name}` : "";
}
