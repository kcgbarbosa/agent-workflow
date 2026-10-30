// When the last ticket of an Epic merges, the spec leaves the main branch, and git keeps it. Each link of the
// Epic's description to a Markdown file of the repo changes to link the commit on main at that point, and a
// pull request deletes the files from main, with auto-merge on. GitHub, Jira, and git hold the state, so a
// second archive repeats no side effect.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { git, gitOk } from "./git.ts";
import * as github from "./github.ts";
import type { Jira, Ticket } from "./jira.ts";

/** A link to a Markdown file at a ref of a GitHub repo, in the text or a link target of the description. */
const LINK = /(https?:\/\/[^\s"'<>()[\]\\]+?)\/blob\/([^/\s"'<>()[\]\\]+)\/([^\s"'<>()[\]\\#?]+?\.md)\b/g;
const SHA = /^[0-9a-f]{40}$/;

export type Archived = { result: "pr-open" | "archived" | "no-spec"; detail: string; pr: string | null };

export type Link = { url: string; prefix: string; ref: string; path: string };

/** The links to a Markdown file of a GitHub repo, each once, in the order the text gives them. */
export function mdLinks(text: string): Link[] {
  const found = new Map<string, Link>();
  for (const [url, prefix, ref, path] of text.matchAll(LINK)) found.set(url!, { url: url!, prefix: prefix!, ref: ref!, path: path! });
  return [...found.values()];
}

/** The links of the repo to a Markdown file, each once. A link to another repo is not its spec. */
export function specLinks(text: string, repoUrl: string): Link[] {
  return mdLinks(text).filter((link) => link.prefix === repoUrl);
}

export async function archive(config: Config, jira: Jira, epic: Ticket, repoUrl: string, home: string): Promise<Archived> {
  const links = specLinks(epic.text, repoUrl);
  if (!links.length) return { result: "no-spec", detail: `The description of ${epic.key} links no spec of this repo.`, pr: null };
  const repo = config.repo;
  const main = `origin/${config.mainBranch}`;
  await git(repo, "fetch", "--prune", "--quiet", "origin");
  const commit = await git(repo, "rev-parse", main);
  const at = (link: Link) => `${link.prefix}/blob/${commit}/${link.path}`;
  for (const link of links) if (!SHA.test(link.ref)) await jira.replaceInDescription(epic.key, link.url, at(link));
  const pins = [...new Set(links.map((link) => (SHA.test(link.ref) ? link.url : at(link))))].sort();

  const left: string[] = [];
  for (const path of [...new Set(links.map((link) => link.path))].sort()) {
    if (await gitOk(repo, "cat-file", "-e", `${main}:${path}`)) left.push(path);
  }
  if (!left.length) return { result: "archived", detail: `The spec of ${epic.key} is not on ${config.mainBranch}.`, pr: null };
  const branch = `docs/${epic.key}-archive-spec`;
  const [open] = await github.openFrom(repo, branch);
  const url = open?.url ?? (await openPullRequest(config, home, branch, left, epic.summary, pins));
  await github.autoMerge(repo, url);
  return { result: "pr-open", detail: `The pull request deletes ${left.join(", ")} from ${config.mainBranch}.`, pr: url };
}

/** Deletes the paths on the branch, in a worktree of main, pushes it, and opens its pull request. */
async function openPullRequest(config: Config, home: string, branch: string, paths: string[], summary: string, pins: string[]): Promise<string> {
  const repo = config.repo;
  const worktree = join(home, "worktrees", "archive-spec");
  const title = `docs: archive the spec of ${summary.slice(0, 1).toLowerCase()}${summary.slice(1)}`;
  await git(repo, "worktree", "prune");
  if (existsSync(worktree)) await git(repo, "worktree", "remove", "--force", worktree);
  await git(repo, "worktree", "add", "--quiet", "--no-track", "-B", branch, worktree, `origin/${config.mainBranch}`);
  try {
    await git(worktree, "rm", "--quiet", "--", ...paths);
    await git(worktree, "commit", "--quiet", "-m", title);
    // An earlier archive can have pushed the branch and failed to open its pull request.
    await git(worktree, "push", "--quiet", "--force-with-lease", "--set-upstream", "origin", branch);
  } finally {
    await gitOk(repo, "worktree", "remove", "--force", worktree);
    await gitOk(repo, "branch", "--delete", "--force", branch);
  }
  const runDir = join(home, "runs", "archive-spec");
  mkdirSync(runDir, { recursive: true });
  const body = join(runDir, "pr-body.md");
  const list = pins.map((pin) => `- ${pin}\n`).join("");
  writeFileSync(body, `The last ticket of the Epic merged, so the spec leaves the main branch. Git keeps it:\n\n${list}`);
  return github.create(repo, branch, config.mainBranch, title, body);
}
