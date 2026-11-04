// The first step of a tick: it gathers the state from Jira, GitHub and T3, and writes nothing. A failed read throws.
import { linkingEpics } from "./archive.ts";
import type { Config } from "./config.ts";
import { branchOf, type EpicState, type State, type TicketState } from "./decide.ts";
import { checksOf, pullRequestsNaming } from "./github.ts";
import type { Jira } from "./jira.ts";
import { listThreads, showThread } from "./t3.ts";

/** Whether the branch names the key, and not a longer key that starts with it. */
function names(branch: string, key: string): boolean {
  return new RegExp(`(?<![\\w-])${key}(?!\\w)`).test(branch);
}

/** The open Epics with a child of this repo's component. Only an Epic whose children are all Done needs its linking Epics. */
async function readEpics(config: Config, jira: Jira): Promise<EpicState[]> {
  const epics: EpicState[] = [];
  for (const epic of await jira.search("issuetype = Epic AND statusCategory != Done ORDER BY key ASC")) {
    const children = await jira.search(`parent = ${epic.key} ORDER BY key ASC`);
    if (!children.some((child) => child.components.includes(config.component))) continue;
    epics.push({ epic, children, linking: children.every((child) => child.done) ? await linkingEpics(jira, epic) : [] });
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
    items.push({
      ticket,
      comments: await jira.comments(ticket.key),
      threads: await Promise.all(own.map((thread) => showThread(cwd, thread.threadId))),
      pullRequests: await Promise.all(pullRequests.map(async (pr) => ({ ...pr, checks: pr.state === "OPEN" ? await checksOf(cwd, pr.url) : [] }))),
    });
  }
  return { tickets: items, epics: await readEpics(config, jira) };
}
