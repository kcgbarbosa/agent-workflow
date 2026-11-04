// The first step of a tick: it gathers the state from Jira, GitHub and T3, and writes nothing. A failed read throws.
import type { Config } from "./config.ts";
import { branchOf, type State } from "./decide.ts";
import { pullRequestsNaming } from "./github.ts";
import type { Jira } from "./jira.ts";
import { listThreads, showThread } from "./t3.ts";

/** Whether the text names the key, and not a longer key that starts with it. */
function names(text: string, key: string): boolean {
  return new RegExp(`(?<![\\w-])${key}(?!\\w)`).test(text);
}

export async function read(config: Config, jira: Jira, cwd: string): Promise<State> {
  const jql = `component = ${JSON.stringify(config.component)} AND statusCategory != Done ORDER BY priority DESC, key ASC`;
  const tickets = await jira.search(jql);
  const threads = await listThreads(cwd);
  const state: State = [];
  for (const ticket of tickets) {
    const own = threads.filter((thread) => names(thread.title, ticket.key));
    const pullRequests = await pullRequestsNaming(cwd, ticket.key, branchOf(ticket));
    state.push({
      ticket,
      threads: await Promise.all(own.map((thread) => showThread(cwd, thread.threadId))),
      pullRequests: pullRequests.filter((pr) => names(pr.headRefName, ticket.key)),
    });
  }
  return state;
}
