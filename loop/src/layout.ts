// Where a run keeps its files under the state folder. An Epic or filter run has `<name>/`, with `runs/<KEY>/`
// and `worktrees/<KEY>/` for each ticket. A ticket worker has `tickets/<KEY>/`, with the ticket's files at its
// top and its worktree in `worktree/`.
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DECISIONS, type Line } from "./log.ts";

/** The folder of the state folder that holds a folder for each ticket a worker builds. */
export const TICKETS = "tickets";

/** The run name of the dispatcher's unit, `loop-<name>-dispatch`, and the ticket of its own lines. */
export const DISPATCH = "dispatch";

/** The name of the daily `correct` run: its unit's, `loop-<name>-correct`, and its folder's under the state folder. */
export const CORRECT = "correct";

/** The worktree folder of a ticket worker. */
export const WORKTREE = "worktree";

const KEY = /^[A-Z][A-Z0-9]*-\d+$/;
const KEY_PREFIX = /^[A-Z][A-Z0-9]*-\d+/;

/** The folder of a ticket worker. */
export function ticketHome(stateDir: string, key: string): string {
  return join(stateDir, TICKETS, key);
}

/** Whether the run folder is a ticket worker's. */
export function isTicketHome(home: string): boolean {
  return basename(dirname(home)) === TICKETS;
}

/** The folder of a run by its name: a ticket worker's when one has a log, else the Epic or filter run's. */
export function runHome(stateDir: string, name: string): string {
  const worker = ticketHome(stateDir, name);
  return KEY.test(name) && existsSync(join(worker, DECISIONS)) ? worker : join(stateDir, name);
}

/** The folder of a ticket's files in a run: `ticket.md`, `pr-body.md`, and its agent logs. */
export function ticketDir(home: string, key: string): string {
  return isTicketHome(home) ? home : join(home, "runs", key);
}

/** The worktree of a ticket in a run. */
export function worktreeOf(home: string, key: string): string {
  return isTicketHome(home) ? join(home, WORKTREE) : join(home, "worktrees", key);
}

/**
 * Whether a line is the run's own and not a ticket's. An Epic run names its own lines with its name. A worker's
 * name is its ticket's key, so it marks its own lines with `run`, and a log with such a line is a worker's.
 */
export function runLineOf(run: string, lines: Line[]): (line: Line) => boolean {
  if (lines.some((line) => line.run === true)) return (line) => line.run === true;
  return (line) => (KEY_PREFIX.exec(line.ticket)?.[0] ?? line.ticket) === run;
}
