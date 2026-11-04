// The second step of a tick: a pure function from the state and the config to the steps, one per action and skip.
// The tickets come in queue order, by priority, then key. The first match in `stepsOf` decides a ticket.
import type { Config } from "./config.ts";
import type { PullRequest } from "./github.ts";
import type { Ticket } from "./jira.ts";
import type { Thread } from "./t3.ts";

export type TicketState = { ticket: Ticket; threads: Thread[]; pullRequests: PullRequest[] };
export type State = TicketState[];

export type Step = { key: string; reason: string } & (
  | { kind: "skip" }
  | { kind: "status"; status: string }
  | { kind: "start"; title: string; branch: string; message: string }
);

const READY = "To Do";
const IN_PROGRESS = "In Progress";

export function branchOf(ticket: Ticket): string {
  const words = (ticket.summary.toLowerCase().match(/[a-z0-9]+/g) ?? []).slice(0, 6).join("-") || "work";
  return `${ticket.issueType === "Bug" ? "fix" : "feat"}/${ticket.key}-${words}`;
}

/** A thread waiting on a question holds a place too: it is on its way to Flagged, with a thread, which holds one. */
function active(thread: Thread): boolean {
  return thread.activeRunId !== null || thread.pendingRequestCount > 0;
}

/** Active turns and stuck tickets hold a place (ADR-0008). A pull request that waits on the gate and a proposed Bug do not. */
function holdsPlace({ ticket, threads }: TicketState): boolean {
  return threads.some(active) || (ticket.flagged && threads.length > 0);
}

function firstMessage(ticket: Ticket, branch: string, config: Config): string {
  const lines = [
    `Build ticket ${ticket.key}: ${ticket.summary}`,
    `Read the ticket and its comments in Jira, then run /implement, then /pr, on the branch ${branch}, which this worktree has checked out.`,
    "The gate runs every check of the repo on the pull request, so run only the tests that cover your change. docs/agents/testing.md gives the commands.",
  ];
  if (config.firstMessage) lines.push(config.firstMessage);
  return lines.join("\n\n");
}

export function decide(state: State, config: Config): Step[] {
  let taken = state.filter(holdsPlace).length;
  return state.flatMap((item): Step[] => {
    const { ticket, threads, pullRequests } = item;
    const { key } = ticket;
    const skip = (reason: string): Step[] => [{ kind: "skip", key, reason }];
    if (ticket.issueType === "Epic") return skip("an Epic");
    if (pullRequests.some((pr) => pr.state === "MERGED")) return skip("a pull request merged");
    if (ticket.flagged) return skip("Flagged");
    if (pullRequests.some((pr) => pr.state === "OPEN")) return skip("a pull request is open");
    if (threads.length) {
      if (ticket.status === IN_PROGRESS) return skip("has a thread");
      return [{ kind: "status", key, status: IN_PROGRESS, reason: "it has a thread and no pull request" }];
    }
    if (ticket.status !== READY) return skip(`status ${ticket.status}`);
    const blockers = ticket.blockers.filter((blocker) => !blocker.done).map((blocker) => blocker.key);
    if (blockers.length) return skip(`blocked by ${blockers.join(", ")}`);
    if (taken >= config.limit) return skip(`wait, ${taken} of ${config.limit} places taken`);
    const branch = branchOf(ticket);
    const reason = `ready, ${taken++} of ${config.limit} places taken`;
    return [
      { kind: "start", key, title: `${key}: ${ticket.summary}`, branch, message: firstMessage(ticket, branch, config), reason },
      { kind: "status", key, status: IN_PROGRESS, reason: "the thread started" },
    ];
  });
}

/** The log line of a step. */
export function lineOf(step: Step): string {
  if (step.kind === "skip") return `${step.key} skip: ${step.reason}`;
  if (step.kind === "status") return `${step.key} status ${step.status}: ${step.reason}`;
  return `${step.key} start "${step.title}" on ${step.branch}: ${step.reason}`;
}
