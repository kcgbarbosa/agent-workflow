// The first step of a tick: it gathers the state from Jira, GitHub and T3, and writes nothing. A failed read throws.
import { linkingEpics, specLinks, unarchived, usersOf } from "./archive.ts";
import type { Config } from "./config.ts";
import { branchOf, type EpicState, stuckAt, type State, type TicketState } from "./decide.ts";
import { checksOf, pullRequestsNaming, repoUrl } from "./github.ts";
import type { Jira } from "./jira.ts";
import { listThreads, showThread } from "./t3.ts";

/** Whether the branch names the key, and not a longer key that starts with it. */
function names(branch: string, key: string): boolean {
  return new RegExp(`(?<![\\w-])${key}(?!\\w)`).test(branch);
}

/**
 * The open Epics with a child of this repo's component, and the Done Epics whose archive has not finished. A Done Epic is
 * also this runner's when its Spec line links this repo, because its children can predate the component. Only an Epic
 * that is Done, or whose children are all Done, needs its linking Epics and what uses its spec.
 */
async function readEpics(config: Config, jira: Jira, cwd: string): Promise<EpicState[]> {
  const epics: EpicState[] = [];
  const repo = await repoUrl(cwd);
  const open = await jira.search("issuetype = Epic AND statusCategory != Done ORDER BY key ASC");
  const done = (await jira.search("issuetype = Epic AND statusCategory = Done ORDER BY key ASC")).filter((epic) => unarchived(epic.text));
  for (const epic of [...open, ...done]) {
    const children = await jira.search(`parent = ${epic.key} ORDER BY key ASC`);
    const linksHere = epic.done && specLinks(epic.text).some((link) => link.prefix === repo);
    if (!linksHere && !children.some((child) => child.components.includes(config.component))) continue;
    const closing = epic.done || children.every((child) => child.done);
    epics.push({ epic, children, linking: closing ? await linkingEpics(jira, epic) : [], users: closing ? await usersOf(jira, epic, cwd) : [] });
  }
  return epics;
}

export async function read(config: Config, jira: Jira, cwd: string): Promise<State> {
  const jql = `component = ${JSON.stringify(config.component)} AND statusCategory != Done ORDER BY priority DESC, key ASC`;
  const tickets = await jira.search(jql);
  const threads = await listThreads(cwd);
  const items: TicketState[] = [];
  for (const ticket of tickets) {
    const own = threads.filter((thread) => thread.title.startsWith(`${ticket.key}:`));
    const pullRequests = (await pullRequestsNaming(cwd, ticket.key, branchOf(ticket))).filter((pr) => names(pr.headRefName, ticket.key) || pr.title.includes(`(${ticket.key}):`));
    const comments = await jira.comments(ticket.key);
    items.push({
      ticket,
      comments,
      // Only an unflagged ticket with a `Stuck:` comment needs it, so a tick reads no history for the rest.
      flaggedAt: !ticket.flagged && stuckAt(comments) ? await jira.flaggedAt(ticket.key) : 0,
      threads: await Promise.all(own.map((thread) => showThread(cwd, thread.threadId))),
      pullRequests: await Promise.all(pullRequests.map(async (pr) => ({ ...pr, checks: pr.state === "OPEN" ? await checksOf(cwd, pr.url) : [] }))),
    });
  }
  return { tickets: items, epics: await readEpics(config, jira, cwd) };
}
