// The last step of a tick: the Today file, the state of the repo for a page that holds no secret. The runner never
// reads it back, so a tick still keeps no state of its own (ADR-0001). `docs/agents/runner.md` gives the format.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { AWAITING_APPROVAL, RED_BUCKETS, type State, STUCK, type TicketState } from "./decide.ts";
import { checksOf, openPullRequests } from "./github.ts";

export type Today = {
  at: string;
  awaitingApproval: number;
  stuck: { key: string; reason: string }[];
  drafts: { number: number; title: string }[];
  red: { number: number; checks: string[] }[];
};

/** The latest `Stuck:` comment, with no prefix. A ticket can be Flagged with no such comment, by the owner or the Chief. */
function reasonOf({ comments }: TicketState): string {
  const [latest] = comments.filter((comment) => comment.text.startsWith(STUCK)).toSorted((a, b) => Date.parse(b.created) - Date.parse(a.created));
  return latest ? latest.text.slice(STUCK.length).trim() : "Flagged";
}

/** Every open pull request of the repo counts, with or without a ticket, so it reads them itself and not from the state. */
async function readToday({ tickets }: State, cwd: string): Promise<Today> {
  const open = await openPullRequests(cwd);
  const checked = await Promise.all(open.map(async (pr) => ({ number: pr.number, checks: (await checksOf(cwd, pr.url)).filter((check) => RED_BUCKETS.has(check.bucket)).map((check) => check.name) })));
  return {
    at: new Date().toISOString(),
    awaitingApproval: tickets.filter(({ ticket }) => ticket.status === AWAITING_APPROVAL && ticket.issueType !== "Epic").length,
    stuck: tickets.filter(({ ticket }) => ticket.flagged).map((item) => ({ key: item.ticket.key, reason: reasonOf(item) })),
    drafts: open.filter((pr) => pr.isDraft).map(({ number, title }) => ({ number, title })),
    red: checked.filter((pr) => pr.checks.length),
  };
}

/** Writes the file through a rename, so a page that reads it mid-write never sees half of it. */
export async function writeToday(state: State, config: Config, cwd: string): Promise<void> {
  const folder = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "runner", config.component);
  const file = join(folder, "today.json");
  const today = await readToday(state, cwd);
  mkdirSync(folder, { recursive: true });
  // By pid, since a dry run by hand can meet the timer's tick.
  const written = `${file}.${process.pid}`;
  writeFileSync(written, `${JSON.stringify(today, null, 2)}\n`);
  renameSync(written, file);
}
