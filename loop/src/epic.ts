// The Epic check. When every child of an Epic, of every component, is Done or merged, the spec leaves the main
// branch (archive.ts) and the Epic is set Done. The dispatcher runs it for the parent of each ticket that merged,
// and once an hour for every open Epic, so a child that another repo's loop or a person set Done closes its Epic too.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { archive, mdLinks, specLineOf } from "./archive.ts";
import type { Config } from "./config.ts";
import { git } from "./git.ts";
import * as github from "./github.ts";
import type { Jira, Ticket } from "./jira.ts";

/** The status a ticket takes when its pull request merges, and an Epic when its last ticket merges. */
export const DONE = "Done";

export type EpicCheck = {
  config: Config;
  jira: Jira;
  /** The folder the archive's clones, worktree, and pull request body go under. */
  home: string;
  /** Writes one line of the checker's own log. */
  log: (step: string, result: string, extra?: Record<string, unknown>) => void;
  notify: (message: string) => Promise<void>;
  /** Whether the pull request of a child that is not Done merged. */
  merged: (child: Ticket) => Promise<boolean>;
  /** The repo on GitHub of this repo, or null when the loop does not know it. */
  repoUrl: string | null;
};

/**
 * When every child of the Epic has merged or is Done, archives the Epic's spec, then sets the Epic Done, and
 * returns true. A check that finds the Epic Done does nothing, and an archive that fails leaves it open, so the
 * next check goes on.
 */
export async function completeEpic(check: EpicCheck, key: string): Promise<boolean> {
  const { config, jira, log } = check;
  let stillOpen = "";
  try {
    const epic = await jira.ticket(key);
    if (epic.done) return false;
    // Read again, since a ticket of another repo can be done by now.
    const children = await jira.search(`parent = ${key} ORDER BY key ASC`);
    if (!children.length) return false;
    for (const child of children) if (!child.done && !(await check.merged(child))) return false;
    // The spec lives in the repo that the Spec line links, which can be another repo than this one.
    const here = check.repoUrl;
    const specRepo = mdLinks(specLineOf(epic.text))[0]?.prefix ?? here;
    if (!specRepo) throw new Error(`The Spec line of ${key} links no repo and no pull request of it merged, so the loop does not know the repo on GitHub.`);
    const specConfig = specRepo.toLowerCase() === here?.toLowerCase() ? config : await cloneOf(config, check.home, specRepo);
    const archived = await archive(specConfig, jira, epic, specRepo, check.home);
    log("archive", archived.result, { detail: archived.detail, pr: archived.pr });
    // The archive pull request merges on its own once its gate is green, and the Epic does not wait for it.
    if (archived.result === "pr-open") stillOpen = ` The archive pull request ${archived.pr} is still open.`;
  } catch (error) {
    log("archive", "fail", { detail: `${key}: ${(error as Error).message}` });
    return false;
  }
  try {
    await jira.transition(key, DONE);
    log("complete", "ok", { detail: `${key} is ${DONE}.${stillOpen}` });
  } catch (error) {
    log("complete", "fail", { detail: `${key}: ${(error as Error).message}` });
    return false;
  }
  await check.notify(`${key} complete`);
  return true;
}

/** The config of a clone of another repo, in `repos/` of the folder, for the archive of a spec that lives there. */
async function cloneOf(config: Config, home: string, repoUrl: string): Promise<Config> {
  const folder = join(home, "repos", repoUrl.split("/").slice(-2).join("-"));
  if (existsSync(folder)) await git(folder, "fetch", "--prune", "--quiet", "origin");
  else await github.clone(config.repo, repoUrl, folder);
  const head = await git(folder, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  return { ...config, repo: folder, mainBranch: head.replace(/^origin\//, "") };
}
