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
  /** MERGEABLE, CONFLICTING, or UNKNOWN while GitHub works it out. */
  mergeable?: string;
  labels?: { name: string }[];
};

export type Check = { name: string; state: string; bucket: string; link: string };

async function gh(cwd: string, args: string[], ok: (code: number) => boolean = (code) => code === 0) {
  const done = await run("gh", args, { cwd });
  if (!ok(done.code)) throw new GhError(`gh ${args.slice(0, 2).join(" ")}: ${(done.stderr || done.stdout).trim()}`);
  return done;
}

const FIELDS = "number,url,state,headRefName,baseRefName,headRefOid,isDraft,title,mergeCommit,mergeable,labels";

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

export async function create(cwd: string, head: string, base: string, title: string, bodyFile: string, draft = false): Promise<string> {
  const args = ["pr", "create", "--head", head, "--base", base, "--title", title, "--body-file", bodyFile];
  const done = await gh(cwd, draft ? [...args, "--draft"] : args);
  const url = done.stdout.trim().split("\n").at(-1) ?? "";
  if (!url.startsWith("http")) throw new GhError(`gh pr create printed no pull request address: ${done.stdout}`);
  return url;
}

/** The body of the pull request. */
export async function body(cwd: string, url: string): Promise<string> {
  return (JSON.parse((await gh(cwd, ["pr", "view", url, "--json", "body"])).stdout) as { body?: string }).body ?? "";
}

export async function editBody(cwd: string, url: string, bodyFile: string): Promise<void> {
  await gh(cwd, ["pr", "edit", url, "--body-file", bodyFile]);
}

/** Makes the label in the repo, or updates it when it is there, since `gh pr edit` refuses a label the repo does not have. */
export async function createLabel(cwd: string, name: string): Promise<void> {
  await gh(cwd, ["label", "create", name, "--force", "--color", LABEL_COLORS[name] ?? "ededed"]);
}

/** Puts the label on the pull request and takes the others off. */
export async function label(cwd: string, url: string, add: string, remove: string[]): Promise<void> {
  await createLabel(cwd, add);
  const args = ["pr", "edit", url, "--add-label", add];
  for (const name of remove) args.push("--remove-label", name);
  await gh(cwd, args);
}

const LABEL_COLORS: Record<string, string> = { "blast:green": "0e8a16", "blast:yellow": "fbca04", "blast:red": "b60205", hold: "5319e7" };

/** Converts the pull request to a draft, which does not merge and turns auto-merge off. */
export async function toDraft(cwd: string, url: string): Promise<void> {
  await gh(cwd, ["pr", "ready", url, "--undo"]);
}

/** Auto-merge as a squash, so the pull request title becomes the commit on main. */
export async function autoMerge(cwd: string, url: string): Promise<void> {
  await gh(cwd, ["pr", "merge", url, "--auto", "--squash"]);
}

/** Clones the repo at its address on GitHub into the folder, with the git protocol and sign-in that gh has. */
export async function clone(cwd: string, url: string, folder: string): Promise<void> {
  await gh(cwd, ["repo", "clone", url, folder, "--", "--quiet"]);
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

/**
 * The required check runs, so a failing check that branch protection does not require never reads as red.
 * `gh pr checks` exits 8 while one is pending and 1 when one failed or none exist yet.
 */
export async function checks(cwd: string, url: string): Promise<Check[]> {
  const done = await gh(cwd, ["pr", "checks", url, "--required", "--json", "name,state,bucket,link"], () => true);
  if (done.stdout.trim().startsWith("[")) return JSON.parse(done.stdout) as Check[];
  if (/no (?:required )?checks reported/i.test(done.stderr)) return [];
  throw new GhError(`gh pr checks: ${(done.stderr || done.stdout).trim()}`);
}

/**
 * The check names that branch protection requires on the branch, which `gh pr checks --required` lists only
 * once they report. A branch with no protection requires none.
 */
export async function requiredChecks(cwd: string, branch: string): Promise<string[]> {
  const endpoint = `repos/{owner}/{repo}/branches/${branch}/protection/required_status_checks`;
  const done = await gh(cwd, ["api", endpoint, "--jq", ".contexts"], () => true);
  if (done.code === 0) return JSON.parse(done.stdout.trim() || "[]") as string[];
  if (/\(HTTP 404\)/.test(done.stderr)) return [];
  throw new GhError(`gh api ${endpoint}: ${(done.stderr || done.stdout).trim()}`);
}

/** The end of a failed Actions job's log, from the job id in the check's link, or null for a check that is no job. */
export async function failedLog(cwd: string, link: string, lines: number): Promise<string | null> {
  const job = /\/actions\/runs\/\d+\/job\/(\d+)/.exec(link)?.[1];
  if (!job) return null;
  const done = await gh(cwd, ["run", "view", "--job", job, "--log-failed"]);
  return done.stdout.trimEnd().split("\n").slice(-lines).join("\n");
}

/** The Actions run id in a check's link, or null for a check that is no Actions job. */
export function runOf(link: string): string | null {
  return /\/actions\/runs\/(\d+)\//.exec(link)?.[1] ?? null;
}

/** Runs the failed jobs of an Actions run again, on the same head. Each gets a new job, so a new link. */
export async function rerunFailed(cwd: string, run: string): Promise<void> {
  await gh(cwd, ["run", "rerun", run, "--failed"]);
}

// The gate's fuzz job starts its review comment with this marker, then lists the findings that survived a
// rerun, each with its command, its output, and its reproduction.
const MARKER = /<!-- gate fuzz head=([0-9a-f]+) findings=(\d+) -->/;

/** The text of the fuzz job's newest comment at `head`, or null when it found nothing there. */
export async function fuzzFindings(cwd: string, number: number, head: string): Promise<string | null> {
  const done = await gh(cwd, ["api", `repos/{owner}/{repo}/pulls/${number}/reviews`, "--paginate", "--jq", ".[]"]);
  const bodies = done.stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => String(JSON.parse(line).body ?? ""))
    .filter((body) => MARKER.test(body));
  const last = bodies.at(-1);
  const marker = last ? MARKER.exec(last)! : null;
  if (!last || !marker || marker[2] === "0" || !head.startsWith(marker[1]!)) return null;
  return last.replace(MARKER, "").trim();
}
