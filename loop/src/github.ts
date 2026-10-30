// The pull request calls, all through `gh`, so the loop and KC read the same state from GitHub.
import { run } from "./spawn.ts";

export class GhError extends Error {}

export type PullRequest = {
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  isDraft: boolean;
  title: string;
  mergeCommit: { oid: string } | null;
};

export type Check = { name: string; state: string; bucket: string; link: string };

/** A finding of the gate's review, from its newest review of the pull request. */
export type Finding = { path: string; line: number | null; sentence: string };

async function gh(cwd: string, args: string[], ok: (code: number) => boolean = (code) => code === 0) {
  const done = await run("gh", args, { cwd });
  if (!ok(done.code)) throw new GhError(`gh ${args.slice(0, 2).join(" ")}: ${(done.stderr || done.stdout).trim()}`);
  return done;
}

const FIELDS = "number,url,state,headRefName,baseRefName,headRefOid,isDraft,title,mergeCommit";

/**
 * The ticket's pull requests in any state, on any branch whose name starts with one of the prefixes. A
 * search for the key in the title finds one whose branch was deleted and named from an older summary, and
 * the head branch finds one the search index has not taken in yet. Neither has a count that older pull
 * requests of the repo could fill.
 */
export async function pullRequestsOf(cwd: string, key: string, branch: string, prefixes: string[]): Promise<PullRequest[]> {
  const searched = await gh(cwd, ["pr", "list", "--state", "all", "--search", `"${key}" in:title`, "--limit", "100", "--json", FIELDS]);
  const headed = await gh(cwd, ["pr", "list", "--head", branch, "--state", "all", "--json", FIELDS]);
  const found = new Map<number, PullRequest>();
  for (const pr of [...JSON.parse(searched.stdout || "[]"), ...JSON.parse(headed.stdout || "[]")] as PullRequest[]) {
    if (prefixes.some((prefix) => pr.headRefName.startsWith(prefix))) found.set(pr.number, pr);
  }
  return [...found.values()];
}

export async function view(cwd: string, url: string): Promise<PullRequest> {
  return JSON.parse((await gh(cwd, ["pr", "view", url, "--json", FIELDS])).stdout) as PullRequest;
}

export async function create(cwd: string, head: string, base: string, title: string, bodyFile: string): Promise<string> {
  const done = await gh(cwd, ["pr", "create", "--head", head, "--base", base, "--title", title, "--body-file", bodyFile]);
  const url = done.stdout.trim().split("\n").at(-1) ?? "";
  if (!url.startsWith("http")) throw new GhError(`gh pr create printed no pull request address: ${done.stdout}`);
  return url;
}

/** Auto-merge as a squash, so the pull request title becomes the commit on main. */
export async function autoMerge(cwd: string, url: string): Promise<void> {
  await gh(cwd, ["pr", "merge", url, "--auto", "--squash"]);
}

/** The open pull requests that target the branch, as a stacked ticket's does. */
export async function stackedOn(cwd: string, branch: string): Promise<PullRequest[]> {
  return JSON.parse((await gh(cwd, ["pr", "list", "--base", branch, "--state", "open", "--json", FIELDS])).stdout || "[]") as PullRequest[];
}

/** The open pull requests from the branch. */
export async function openFrom(cwd: string, branch: string): Promise<PullRequest[]> {
  return JSON.parse((await gh(cwd, ["pr", "list", "--head", branch, "--state", "open", "--json", FIELDS])).stdout || "[]") as PullRequest[];
}

export async function retarget(cwd: string, url: string, base: string): Promise<void> {
  await gh(cwd, ["pr", "edit", url, "--base", base]);
}

export async function merge(cwd: string, url: string): Promise<void> {
  await gh(cwd, ["pr", "merge", url, "--squash"]);
}

/** The check runs. `gh pr checks` exits 8 while one is pending and 1 when one failed or none exist yet. */
export async function checks(cwd: string, url: string): Promise<Check[]> {
  const done = await gh(cwd, ["pr", "checks", url, "--json", "name,state,bucket,link"], () => true);
  if (done.stdout.trim().startsWith("[")) return JSON.parse(done.stdout) as Check[];
  if (/no checks reported/i.test(done.stderr)) return [];
  throw new GhError(`gh pr checks: ${(done.stderr || done.stdout).trim()}`);
}

/** The end of a failed Actions job's log, from the job id in the check's link, or null for a check that is no job. */
export async function failedLog(cwd: string, link: string, lines: number): Promise<string | null> {
  const job = /\/actions\/runs\/\d+\/job\/(\d+)/.exec(link)?.[1];
  if (!job) return null;
  const done = await gh(cwd, ["run", "view", "--job", job, "--log-failed"]);
  return done.stdout.trimEnd().split("\n").slice(-lines).join("\n");
}

// The gate's review starts each review body with this marker. The newest review holds the findings at the
// pull request's head: each at its line as a review comment, and the ones outside the diff in the body.
const MARKER = /<!-- gate review head=([0-9a-f]+) blocking=(\d+) -->/;
const BLOCKING = /^\*\*blocking\*\*: (.*)$/s;

/** The blocking findings of the gate's newest review of the pull request. */
export async function blockingFindings(cwd: string, number: number): Promise<Finding[]> {
  const list = async (endpoint: string) => {
    const done = await gh(cwd, ["api", endpoint, "--paginate", "--jq", ".[]"]);
    return done.stdout.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  };
  const reviews = (await list(`repos/{owner}/{repo}/pulls/${number}/reviews`)).filter((review) => MARKER.test(review.body ?? ""));
  const last = reviews.at(-1);
  if (!last || MARKER.exec(last.body)![2] === "0") return [];
  const findings: Finding[] = [];
  for (const comment of await list(`repos/{owner}/{repo}/pulls/${number}/reviews/${last.id}/comments`)) {
    const sentence = BLOCKING.exec(comment.body ?? "")?.[1];
    if (sentence) findings.push({ path: comment.path, line: comment.line ?? null, sentence });
  }
  for (const line of String(last.body).split("\n")) {
    const found = /^- `(.+):(\d+)` \*\*blocking\*\*: (.*)$/.exec(line);
    if (found) findings.push({ path: found[1]!, line: Number(found[2]), sentence: found[3]! });
  }
  return findings;
}
