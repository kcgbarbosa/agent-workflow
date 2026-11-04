// The second step of a tick: a pure function from the state, the config and the time to the steps, one per action
// and skip. The tickets come in queue order, by priority, then key. The first match in `planOf` decides a ticket, in
// the order of the spec's table.
import { pinsOf, type Pin, specLinks } from "./archive.ts";
import type { Config } from "./config.ts";
import type { PullRequest } from "./github.ts";
import type { Ticket, TicketComment } from "./jira.ts";
import type { Thread } from "./t3.ts";

export type TicketState = { ticket: Ticket; comments: TicketComment[]; threads: Thread[]; pullRequests: PullRequest[] };
/** An open Epic with a child of this repo's component. `linking` holds the other Epics that link its spec, once its children are all Done. */
export type EpicState = { epic: Ticket; children: Ticket[]; linking: Ticket[] };
export type State = { tickets: TicketState[]; epics: EpicState[] };

export type Step = { key: string; reason: string } & (
  | { kind: "skip" }
  | { kind: "status"; status: string }
  | { kind: "start"; title: string; branch: string; message: string }
  | { kind: "send"; threadId: string; message: string }
  | { kind: "comment"; text: string }
  | { kind: "pr-comment"; url: string; text: string }
  | { kind: "auto-merge"; url: string }
  | { kind: "flag" }
  | { kind: "notify"; text: string }
  | { kind: "archive"; summary: string; pins: Pin[] }
);

/** What a ticket does at this tick. `turn` starts an agent turn, so it needs a place against the limit, and comes after `steps`. A fix or a retry is a `message`, which takes its place before any new start. */
type Plan = { steps: Step[]; turn?: (place: string) => Step[]; message?: boolean };

const READY = "To Do";
const IN_PROGRESS = "In Progress";
const IN_REVIEW = "In Review";
const DONE = "Done";
const STUCK = "Stuck:";
const CONTINUE = "Runner sent continue:";
// A pull request comment of an attempt, which names the head SHA it was sent for (ADR-0003).
const ATTEMPT = /^Runner fix attempt \d+ of \d+ at (\S+):/;
const RED_BUCKETS = new Set(["fail", "cancel"]);
const MINUTE_MS = 60_000;

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

/** The ticket's thread when it has several, newest first: the one waiting on a question, else the active one, else the newest. */
function threadOf(threads: Thread[]): Thread | undefined {
  return threads.find((thread) => thread.pendingRequestCount > 0) ?? threads.find(active) ?? threads[0];
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

/** The time of the latest `Stuck:` comment. Attempts and continues count only after it, so unflagging gives a fresh count. */
function stuckAt(comments: TicketComment[]): number {
  return Math.max(0, ...comments.filter((comment) => comment.text.startsWith(STUCK)).map((comment) => Date.parse(comment.created)));
}

/** The attempts on the pull request since the latest `Stuck:`, each with its head SHA and time. */
function attemptsOf(pr: PullRequest, since: number): { head: string; at: number }[] {
  return pr.comments.flatMap((comment) => {
    const head = ATTEMPT.exec(comment.body)?.[1];
    const at = Date.parse(comment.createdAt);
    return head && at > since ? [{ head, at }] : [];
  });
}

/** The comment, Flagged, and the notification, in that order, once: a Flagged ticket takes no further action. */
function stuckSteps({ ticket, threads, pullRequests }: TicketState, stage: string, reason: string, config: Config): Step[] {
  const { key } = ticket;
  const thread = threadOf(threads);
  const link = thread ? config.threadUrl.replace(/\/$/, "") + new URL(thread.link).pathname : (pullRequests.find((pr) => pr.state === "OPEN")?.url ?? "");
  return [
    { kind: "comment", key, reason, text: `${STUCK} ${stage}: ${reason}.` },
    { kind: "flag", key, reason },
    { kind: "notify", key, reason, text: `${key} stuck: ${reason}\n${link}` },
  ];
}

function planOf(item: TicketState, config: Config, now: number): Plan {
  const { ticket, comments, threads, pullRequests } = item;
  const { key } = ticket;
  const none = (steps: Step[], reason: string): Plan => ({ steps: steps.length ? steps : [{ kind: "skip", key, reason }] });
  const quiet = (since: number): boolean => now - since > config.quietMinutes * MINUTE_MS;
  if (ticket.issueType === "Epic") return none([], "an Epic");
  if (pullRequests.some((pr) => pr.state === "MERGED")) return { steps: [{ kind: "status", key, status: DONE, reason: "the pull request merged" }] };
  if (ticket.flagged) return none([], "Flagged");

  const open = pullRequests.find((pr) => pr.state === "OPEN");
  const thread = threadOf(threads);
  const status: Step[] = [];
  if (open && ticket.status !== IN_REVIEW) status.push({ kind: "status", key, status: IN_REVIEW, reason: "a pull request is open" });
  if (!open && thread && ticket.status !== IN_PROGRESS) status.push({ kind: "status", key, status: IN_PROGRESS, reason: "it has a thread and no pull request" });
  const stuck = (reason: string): Plan => ({ steps: [...status, ...stuckSteps(item, open ? "gate" : "build", reason, config)] });

  if (open?.isDraft) return none(status, "a draft pull request");
  if (thread && thread.pendingRequestCount > 0) return stuck("the thread waits on a question");
  if (thread && active(thread) && quiet(Date.parse(thread.updatedAt))) return stuck(`the thread shows an active turn with no update for longer than ${config.quietMinutes} minutes`);

  if (open) {
    const conflict = open.mergeable === "CONFLICTING";
    const red = open.checks.filter((check) => RED_BUCKETS.has(check.bucket)).map((check) => check.name);
    const pending = open.checks.some((check) => check.bucket === "pending");
    if (pending || (thread && active(thread)) || (!red.length && !conflict)) {
      // Not while in conflict, which may not merge, and a later tick turns it on once the conflict is gone.
      const merge: Step[] = open.autoMergeRequest || conflict ? [] : [{ kind: "auto-merge", key, url: open.url, reason: "an open pull request merges when the gate is green" }];
      return none([...status, ...merge], "waits on the gate");
    }
    const attempts = attemptsOf(open, stuckAt(comments));
    const sent = attempts.find((attempt) => attempt.head === open.headRefOid);
    if (sent) {
      if (quiet(sent.at)) return stuck(`the fix turn pushed nothing in ${config.quietMinutes} minutes`);
      return none(status, "a fix was sent for this head");
    }
    const problems = [...(red.length ? [`${red.join(", ")} failed`] : []), ...(conflict ? [`a merge conflict with ${config.mainBranch}`] : [])].join(" and ");
    if (!thread) return stuck(`the pull request needs a fix and has no thread: ${problems}`);
    if (attempts.length >= config.fixAttempts) return stuck(`${attempts.length} fix attempts and the pull request still has: ${problems}`);
    const attempt = `attempt ${attempts.length + 1} of ${config.fixAttempts} at ${open.headRefOid}`;
    const reason = `${problems}, ${attempt}`;
    const message = `The pull request ${open.url} needs a fix at ${open.headRefOid}: ${problems}. Fix it on this branch and push. This is ${attempt}.`;
    return {
      steps: status,
      message: true,
      turn: () => [
        { kind: "pr-comment", key, url: open.url, reason, text: `Runner fix ${attempt}: ${problems}.` },
        { kind: "send", key, threadId: thread.threadId, reason, message },
      ],
    };
  }

  if (thread && active(thread)) return none(status, "has a thread");
  if (thread) {
    const since = stuckAt(comments);
    if (comments.some((comment) => comment.text.startsWith(CONTINUE) && Date.parse(comment.created) > since)) return stuck("the thread stopped again with no pull request");
    const reason = `the thread ${thread.status === "failed" ? "failed" : "stopped"} with no pull request`;
    const message = `Continue ticket ${key}: your last turn ended with no pull request. Finish the work on this branch, then run /pr.`;
    return {
      steps: status,
      message: true,
      turn: () => [
        { kind: "comment", key, reason, text: `${CONTINUE} ${reason}.` },
        { kind: "send", key, threadId: thread.threadId, reason, message },
      ],
    };
  }

  if (ticket.status !== READY) return none([], `status ${ticket.status}`);
  const blockers = ticket.blockers.filter((blocker) => !blocker.done).map((blocker) => blocker.key);
  if (blockers.length) return none([], `blocked by ${blockers.join(", ")}`);
  const branch = branchOf(ticket);
  return {
    steps: [],
    turn: (place) => [
      { kind: "start", key, title: `${key}: ${ticket.summary}`, branch, message: firstMessage(ticket, branch, config), reason: `ready, ${place}` },
      { kind: "status", key, status: IN_PROGRESS, reason: "the thread started" },
    ],
  };
}

/**
 * What an open Epic does, after the tickets. A failed archive drops the Done that follows it, so the next tick tries
 * again. Two Epics that link one spec can close on one tick, and then the first by key archives it, so the spec gets
 * one pull request.
 */
function epicSteps(epics: EpicState[]): Step[] {
  const allDone = (item: EpicState): boolean => item.children.every((child) => child.done);
  const closing = new Set(epics.filter(allDone).map((item) => item.epic.key));
  return epics.flatMap((item): Step[] => {
    const { epic, children, linking } = item;
    const { key } = epic;
    if (!allDone(item)) {
      const open = children.filter((child) => !child.done).map((child) => child.key);
      return [{ kind: "skip", key, reason: `${open.join(", ")} ${open.length === 1 ? "is" : "are"} not Done` }];
    }
    const done: Step = { kind: "status", key, status: DONE, reason: "its last child is Done" };
    if (!specLinks(epic.text).length) return [{ kind: "skip", key, reason: "its description has no Spec line that links a spec" }, done];
    const waiting = linking.filter((other) => !other.done && !(closing.has(other.key) && key < other.key)).map((other) => other.key);
    if (waiting.length) {
      const verbs = waiting.length === 1 ? "links it and is" : "link it and are";
      return [{ kind: "skip", key, reason: `the spec stays, since ${waiting.join(", ")} ${verbs} not Done` }, done];
    }
    return [{ kind: "archive", key, summary: epic.summary, pins: pinsOf(epic, linking), reason: "every Epic that links the spec is Done" }, done];
  });
}

export function decide({ tickets: state, epics }: State, config: Config, now: number): Step[] {
  const plans = state.map((item) => planOf(item, config, now));
  // A stopped thread that is Flagged at this tick is stuck from here on, so it holds its place at once.
  let taken = state.filter((item, at) => holdsPlace(item) || (item.threads.length > 0 && plans[at].steps.some((step) => step.kind === "flag"))).length;
  const placed = (plan: Plan, at: number): Step[] => {
    if (!plan.turn) return plan.steps;
    const place = `${taken} of ${config.limit} places taken`;
    if (taken >= config.limit) return [...plan.steps, { kind: "skip", key: state[at].ticket.key, reason: `wait, ${place}` }];
    taken++;
    return [...plan.steps, ...plan.turn(place)];
  };
  const inOrder = (message: boolean): Step[] => plans.flatMap((plan, at) => (Boolean(plan.message) === message ? placed(plan, at) : []));
  return [...inOrder(true), ...inOrder(false), ...epicSteps(epics)];
}

/** The log line of a step. */
export function lineOf(step: Step): string {
  if (step.kind === "skip") return `${step.key} skip: ${step.reason}`;
  if (step.kind === "status") return `${step.key} status ${step.status}: ${step.reason}`;
  if (step.kind === "start") return `${step.key} start "${step.title}" on ${step.branch}: ${step.reason}`;
  if (step.kind === "send") return `${step.key} send to ${step.threadId}: ${step.reason}`;
  if (step.kind === "pr-comment" || step.kind === "auto-merge") return `${step.key} ${step.kind} on ${step.url}: ${step.reason}`;
  return `${step.key} ${step.kind}: ${step.reason}`;
}
