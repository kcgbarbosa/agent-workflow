// The pull request calls, all through `gh`, so the loop and KC read the same state from GitHub.
import { run } from "./spawn.ts";

export class GhError extends Error {}

export type PullRequest = {
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  headRefName: string;
  baseRefName: string;
  title: string;
  mergeCommit: { oid: string } | null;
};

export type Check = { name: string; state: string; bucket: string };

async function gh(cwd: string, args: string[], ok: (code: number) => boolean = (code) => code === 0) {
  const done = await run("gh", args, { cwd });
  if (!ok(done.code)) throw new GhError(`gh ${args.slice(0, 2).join(" ")}: ${(done.stderr || done.stdout).trim()}`);
  return done;
}

export async function pullRequests(cwd: string): Promise<PullRequest[]> {
  const fields = "number,url,state,headRefName,baseRefName,title,mergeCommit";
  const done = await gh(cwd, ["pr", "list", "--state", "all", "--limit", "200", "--json", fields]);
  return JSON.parse(done.stdout || "[]") as PullRequest[];
}

export async function view(cwd: string, url: string): Promise<PullRequest> {
  const fields = "number,url,state,headRefName,baseRefName,title,mergeCommit";
  return JSON.parse((await gh(cwd, ["pr", "view", url, "--json", fields])).stdout) as PullRequest;
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

export async function merge(cwd: string, url: string): Promise<void> {
  await gh(cwd, ["pr", "merge", url, "--squash"]);
}

/** The check runs. `gh pr checks` exits 8 while one is pending and 1 when one failed or none exist yet. */
export async function checks(cwd: string, url: string): Promise<Check[]> {
  const done = await gh(cwd, ["pr", "checks", url, "--json", "name,state,bucket"], () => true);
  if (done.stdout.trim().startsWith("[")) return JSON.parse(done.stdout) as Check[];
  if (/no checks reported/i.test(done.stderr)) return [];
  throw new GhError(`gh pr checks: ${(done.stderr || done.stdout).trim()}`);
}
