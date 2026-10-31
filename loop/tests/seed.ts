// A seeded run for the watch page, so a review opens each panel with no real run: `node tests/seed.ts [port]`.
// It writes a fictional project's state folder in a temporary folder, serves the page over it, and prints the
// address. The run is live while the script runs, since its pid is the script's.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../src/watch.ts";

const EPIC = "DEMO-1";
const KILLED = "DEMO-20";
const PLANNED = "DEMO-40";
const REPO = "https://github.com/kcgbarbosa/demo";
const pr = (n: number) => `${REPO}/pull/${n}`;
const link = (run: number) => `${REPO}/actions/runs/${run}/job/${run}0`;

/** A ticket's lines up to its open pull request. */
function opened(key: string, n: number): object[] {
  return [
    { ticket: key, step: "start", result: "new", detail: `feat/${key}`, slot: 0 },
    { ticket: key, step: "build", result: "started", attempt: 1 },
    { ticket: key, step: "build", result: "pass", commit: `${key}-1` },
    { ticket: key, step: "push", result: "ok", commit: `${key}-1` },
    { ticket: key, step: "pr", result: "open", commit: `${key}-1`, pr: pr(n), auto_merge: true },
  ];
}

/** The lines of the run: a merged ticket whose auto-merge failed, a stacked one that merged after a retarget and
 * left its worktree behind, a red one whose checks were logged before the loop kept links, a held one, a stuck one,
 * one whose checks timed out, one that did not merge, one held and then released, and one with no build yet.
 */
function lines(home: string): object[] {
  return [
    { ticket: EPIC, step: "start", result: "ok", pid: process.pid, input: EPIC, setup: { agent: "claude-opus-5-5 high" } },
    {
      ticket: EPIC,
      step: "frontier",
      result: "ok",
      summary: "The login flow",
      tickets: [
        { key: "DEMO-2", summary: "Add the login page", status: "To Do", state: "ready", blockers: [] },
        { key: "DEMO-3", summary: "Add the logout button", status: "To Do", state: "waiting", blockers: ["DEMO-2"] },
        { key: "DEMO-4", summary: "Remember the last user", status: "To Do", state: "ready", blockers: [] },
        { key: "DEMO-5", summary: "Show the password rules", status: "To Do", state: "ready", blockers: [] },
        { key: "DEMO-6", summary: "Lock the account after five tries", status: "To Do", state: "ready", blockers: [] },
        { key: "DEMO-7", summary: "Send the reset email", status: "To Do", state: "ready", blockers: [] },
        { key: "DEMO-8", summary: "Log each sign-in", status: "To Do", state: "ready", blockers: [] },
        { key: "DEMO-9", summary: "Show the sign-in errors", status: "To Do", state: "ready", blockers: [] },
        { key: "DEMO-10", summary: "Add single sign-on", status: "To Do", state: "ready", blockers: [] },
      ],
    },
    { ticket: "DEMO-2", step: "start", result: "new", detail: "feat/DEMO-2-add-the-login-page", slot: 0 },
    { ticket: "DEMO-2", step: "build", result: "started", attempt: 1 },
    { ticket: "DEMO-2", step: "build", result: "pass", commit: "a1", detail: "Added the login page, with its form and its tests." },
    { ticket: "DEMO-2", step: "push", result: "ok", commit: "a1" },
    {
      ticket: "DEMO-2",
      step: "pr",
      result: "open",
      commit: "a1",
      pr: pr(1),
      auto_merge: false,
      decisions: ["The form takes an email, not a user name.", "A wrong password shows one message, not which field was wrong."],
      detail: "Auto-merge is off: Auto-merge is not allowed for this repository",
    },
    { ticket: "DEMO-2", step: "auto-merge", result: "fail", pr: pr(1), detail: "Auto-merge is off: Auto-merge is not allowed for this repository" },
    {
      ticket: "DEMO-2",
      step: "wait",
      result: "green",
      commit: "a1",
      pr: pr(1),
      checks: [
        { name: "gate / check", bucket: "pass", link: link(11) },
        { name: "gate / review", bucket: "pass", link: link(12) },
      ],
    },
    { ticket: "DEMO-2", step: "agent", result: "done", session: "DEMO-2", plan: { five_hour: { start: 0.2, end: 0.41, resets_at: 1 } } },
    { ticket: "DEMO-2", step: "merge", result: "merged", commit: "m1", pr: pr(1) },
    { ticket: "DEMO-3", step: "start", result: "new", detail: "feat/DEMO-3-add-the-logout-button", slot: 1, base: "feat/DEMO-2-add-the-login-page", pr: pr(1) },
    { ticket: "DEMO-3", step: "retarget", result: "ok", pr: pr(2), detail: "feat/DEMO-2-add-the-login-page merged, so it targets main." },
    { ticket: "DEMO-2", step: "worktree", result: "removed", detail: join(home, "worktrees", "DEMO-2") },
    { ticket: "DEMO-3", step: "build", result: "started", attempt: 1 },
    { ticket: "DEMO-3", step: "build", result: "pass", commit: "b1" },
    { ticket: "DEMO-3", step: "push", result: "ok", commit: "b1" },
    { ticket: "DEMO-3", step: "pr", result: "open", commit: "b1", pr: pr(2), auto_merge: true },
    {
      ticket: "DEMO-3",
      step: "wait",
      result: "green",
      commit: "b1",
      pr: pr(2),
      checks: [
        { name: "gate / check", bucket: "pass", link: link(21) },
        { name: "gate / review", bucket: "pass", link: link(22) },
      ],
    },
    { ticket: "DEMO-3", step: "merge", result: "merged", commit: "m2", pr: pr(2) },
    { ticket: "DEMO-3", step: "worktree", result: "fail", detail: "fatal: 'worktrees/DEMO-3' contains modified or untracked files, use --force to delete it" },
    { ticket: "DEMO-4", step: "start", result: "new", detail: "feat/DEMO-4-remember-the-last-user", slot: 0 },
    { ticket: "DEMO-4", step: "build", result: "started", attempt: 1 },
    { ticket: "DEMO-4", step: "build", result: "pass", commit: "c1" },
    { ticket: "DEMO-4", step: "push", result: "ok", commit: "c1" },
    { ticket: "DEMO-4", step: "pr", result: "open", commit: "c1", pr: pr(3), auto_merge: true },
    {
      ticket: "DEMO-4",
      step: "wait",
      result: "red",
      commit: "c1",
      pr: pr(3),
      checks: [
        { name: "gate / check", bucket: "fail" },
        { name: "gate / review", bucket: "pass" },
      ],
      detail: "Failed: gate / check",
    },
    { ticket: "DEMO-5", step: "start", result: "new", detail: "feat/DEMO-5-show-the-password-rules", slot: 1 },
    { ticket: "DEMO-5", step: "build", result: "started", attempt: 1 },
    { ticket: "DEMO-5", step: "build", result: "pass", commit: "d1" },
    { ticket: "DEMO-5", step: "push", result: "ok", commit: "d1" },
    { ticket: "DEMO-5", step: "pr", result: "open", commit: "d1", pr: pr(4), auto_merge: true },
    {
      ticket: "DEMO-5",
      step: "wait",
      result: "held",
      commit: "d1",
      pr: pr(4),
      checks: [
        { name: "hold", bucket: "fail", link: link(41) },
        { name: "gate / check", bucket: "pass", link: link(42) },
      ],
      detail: "The hold label is on. The loop waits until it is not.",
    },
    { ticket: "DEMO-6", step: "start", result: "new", detail: "feat/DEMO-6", slot: 0 },
    { ticket: "DEMO-6", step: "build", result: "started", attempt: 1 },
    { ticket: "DEMO-6", step: "build", result: "blocked", detail: "The spec does not say how long the lock lasts." },
    { ticket: "DEMO-6", step: "stuck", result: "started", detail: "The agent is blocked: the spec does not say how long the lock lasts." },
    ...opened("DEMO-7", 5),
    { ticket: "DEMO-7", step: "wait", result: "timeout", commit: "DEMO-7-1", pr: pr(5), checks: [{ name: "gate / check", bucket: "pending", link: link(51) }], detail: "The checks ran past 60 min." },
    ...opened("DEMO-8", 6),
    { ticket: "DEMO-8", step: "wait", result: "green", commit: "DEMO-8-1", pr: pr(6), checks: [{ name: "gate / check", bucket: "pass", link: link(61) }] },
    { ticket: "DEMO-8", step: "merge", result: "fail", pr: pr(6), detail: "The pull request did not merge." },
    ...opened("DEMO-9", 7),
    { ticket: "DEMO-9", step: "wait", result: "held", commit: "DEMO-9-1", pr: pr(7), checks: [{ name: "hold", bucket: "fail", link: link(71) }], detail: "The hold label is on. The loop waits until it is not." },
    { ticket: "DEMO-9", step: "wait", result: "green", commit: "DEMO-9-1", pr: pr(7), checks: [{ name: "gate / check", bucket: "pass", link: link(72) }] },
  ];
}

/** The lines of an earlier run of another Epic, whose process is gone before it finished. */
function killed(): object[] {
  const pid = Number(execFileSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).trim());
  return [
    { ticket: KILLED, step: "start", result: "ok", pid, input: KILLED },
    {
      ticket: KILLED,
      step: "frontier",
      result: "ok",
      summary: "The signup flow",
      tickets: [{ key: "DEMO-21", summary: "Add the signup page", status: "To Do", state: "ready", blockers: [] }],
    },
    { ticket: "DEMO-21", step: "start", result: "new", detail: "feat/DEMO-21-add-the-signup-page", slot: 0 },
    { ticket: "DEMO-21", step: "build", result: "started", attempt: 1 },
  ];
}

/** Seven earlier runs of a third Epic: six that merged a ticket at a share of the 5-hour window, so the typical
 * share is the median of the last 5 and skips the oldest, and a last one that merged nothing.
 */
function planned(): object[] {
  return [9, 3, 4, 5, 6, 4, null].flatMap((share, index) => {
    const key = `DEMO-${41 + index}`;
    return [
      { ticket: PLANNED, step: "start", result: "ok", pid: 1, input: PLANNED },
      ...(share === null
        ? [{ ticket: key, step: "stuck", result: "ok", detail: "The checks stayed red." }]
        : [
            { ticket: key, step: "start", result: "new", detail: `feat/${key}`, slot: 0 },
            { ticket: key, step: "agent", result: "done", session: key, plan: { five_hour: { start: 0, end: share / 100, resets_at: 1 } } },
            { ticket: key, step: "merge", result: "merged", pr: pr(40 + index) },
          ]),
      { ticket: PLANNED, step: "finish", result: "ok" },
    ];
  });
}

/** Writes a run's decisions log, its last line `end` minutes ago, in this project or another on the host. */
function write(epic: string, seeded: (home: string) => object[], end: number, state = stateDir): void {
  const home = join(state, epic);
  mkdirSync(home, { recursive: true });
  const written = seeded(home);
  const first = Date.now() - (end + written.length) * 60_000;
  const text = written.map((line, index) => {
    const time = new Date(first + index * 60_000).toISOString();
    return JSON.stringify({ time, epic, commit: null, session: null, detail: "", ...line });
  });
  writeFileSync(join(home, "decisions.jsonl"), text.join("\n") + "\n");
}

/** A running run of another project, with two tickets in different steps. */
function busy(): object[] {
  return [
    { ticket: "SHOP-1", step: "start", result: "ok", pid: process.pid },
    { ticket: "SHOP-1", step: "frontier", result: "ok", summary: "Checkout", tickets: ["SHOP-2", "SHOP-3", "SHOP-4"].map((key) => ({ key, summary: `Work on ${key}`, status: "To Do", state: "ready", blockers: [] })) },
    ...opened("SHOP-2", 30),
    { ticket: "SHOP-3", step: "start", result: "new", detail: "feat/SHOP-3", slot: 1 },
    { ticket: "SHOP-3", step: "build", result: "started", attempt: 1 },
    { ticket: "SHOP-3", step: "meter", result: "read", meter: { five_hour: { utilization: 0.42, resets_at: Math.floor(Date.now() / 1000) + 7200 } } },
  ];
}

/** A run of another project that finished with every ticket merged, or, `blocked`, with one stuck. */
function finished(epic: string, blocked: boolean): () => object[] {
  const ticket = `${epic.split("-")[0]}-${Number(epic.split("-")[1]) + 1}`;
  return () => [
    { ticket: epic, step: "start", result: "ok", pid: 1 },
    { ticket: epic, step: "frontier", result: "ok", summary: blocked ? "Search" : "Search, again", tickets: [{ key: ticket, summary: "Add search", status: "To Do", state: "ready", blockers: [] }] },
    ...opened(ticket, 40),
    ...(blocked
      ? [{ ticket, step: "stuck", result: "ok", detail: "Still red." }]
      : [{ ticket, step: "wait", result: "green", pr: pr(40), checks: [] }, { ticket, step: "merge", result: "merged", pr: pr(40) }]),
    { ticket: epic, step: "finish", result: "ok" },
  ];
}

const stateDir = join(mkdtempSync(join(tmpdir(), "seed-")), "demo-loop");
const other = (name: string) => {
  const state = join(stateDir, "..", `${name}-loop`);
  mkdirSync(state, { recursive: true });
  return state;
};
write(PLANNED, planned, 600);
write(KILLED, killed, 180);
write(EPIC, lines, 0);
write("SHOP-1", busy, 2, other("shop"));
// DEMO-4's session: one tool call that ran, and one that auto mode denied, which the ticket detail shows in red.
const session = join(stateDir, EPIC, "runs", "DEMO-4");
mkdirSync(session, { recursive: true });
const call = (id: string, command: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
const answer = (id: string, content: string, is_error: boolean) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] } });
writeFileSync(join(session, "agent-1.jsonl"), [
  { type: "system", subtype: "init", model: "claude-opus-5-5" },
  call("t1", "npx vitest run tests/login.test.ts"),
  answer("t1", "Tests  4 passed (4)", false),
  call("t2", "git push --force origin main"),
  answer("t2", "Permission for this action has been denied by the Claude Code auto mode classifier.", true),
].map((event) => JSON.stringify(event)).join("\n") + "\n");
write("FIND-1", finished("FIND-1", true), 900, other("find"));
write("FIND-5", finished("FIND-5", false), 120, other("find"));
other("notes");

const server = await serve(stateDir, Number(process.argv[2] ?? 8791));
for (const url of server.urls) console.log(`The seeded run is at ${url}#/demo/${EPIC}`);
