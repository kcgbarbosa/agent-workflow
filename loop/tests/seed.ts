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
    { ticket: "DEMO-2", step: "build", result: "pass", commit: "a1" },
    { ticket: "DEMO-2", step: "push", result: "ok", commit: "a1" },
    {
      ticket: "DEMO-2",
      step: "pr",
      result: "open",
      commit: "a1",
      pr: pr(1),
      auto_merge: false,
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

/** Writes a run's decisions log, its last line `end` minutes ago. */
function write(epic: string, seeded: (home: string) => object[], end: number): void {
  const home = join(stateDir, epic);
  mkdirSync(home, { recursive: true });
  const written = seeded(home);
  const first = Date.now() - (end + written.length) * 60_000;
  const text = written.map((line, index) => {
    const time = new Date(first + index * 60_000).toISOString();
    return JSON.stringify({ time, epic, commit: null, session: null, detail: "", ...line });
  });
  writeFileSync(join(home, "decisions.jsonl"), text.join("\n") + "\n");
}

const stateDir = join(mkdtempSync(join(tmpdir(), "seed-")), "demo-loop");
write(KILLED, killed, 180);
write(EPIC, lines, 0);

const server = await serve(stateDir, Number(process.argv[2] ?? 8791));
for (const url of server.urls) console.log(`The seeded run is at ${url}#/demo/${EPIC}`);
