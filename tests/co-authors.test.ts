// The co-author check fails on a Claude trailer in a pull request's own commits or body, nowhere else.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { gitEnv, REPO, tempDir } from "./repo.ts";

const TRAILER = "Co-authored-by: Claude <noreply@anthropic.com>";

function scratch() {
  const dir = tempDir();
  const env = gitEnv(dir);
  const work = join(dir, "work");
  mkdirSync(work);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: work, env, encoding: "utf8" }).trim();
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", `old commit on main\n\n${TRAILER}`);
  const check = (base: string, head: string, body = "") =>
    spawnSync(join(REPO, ".github", "scripts", "check-co-authors.sh"), {
      cwd: work,
      env: { ...env, BASE_SHA: base, HEAD_SHA: head, PR_BODY: body },
      encoding: "utf8",
    });
  return { dir, git, check };
}

test("passes on clean commits despite old trailers", () => {
  const { git, check } = scratch();
  const base = git("rev-parse", "HEAD");
  git("commit", "-q", "--allow-empty", "-m", "feat: clean\n\nClaude-Session: https://example.com");
  expect(check(base, git("rev-parse", "HEAD"), "A clean body.").status).toBe(0);
});

test("names each commit with a trailer", () => {
  const { git, check } = scratch();
  const base = git("rev-parse", "HEAD");
  git("commit", "-q", "--allow-empty", "-m", "feat: one\n\nco-authored-by: claude <x@y.z>");
  const first = git("rev-parse", "--short", "HEAD");
  git("commit", "-q", "--allow-empty", "-m", "feat: two");
  git("commit", "-q", "--allow-empty", "-m", "feat: three\n\nCo-Authored-By: X <noreply@anthropic.com>");
  const third = git("rev-parse", "--short", "HEAD");
  const result = check(base, git("rev-parse", "HEAD"));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`${first} feat: one`);
  expect(result.stderr).toContain(`${third} feat: three`);
  expect(result.stderr).not.toContain("feat: two");
  expect(result.stderr).toContain("Remove");
});

test("fails on a trailer in the body", () => {
  const { git, check } = scratch();
  const head = git("rev-parse", "HEAD");
  const result = check(head, head, `Summary\r\n\r\n${TRAILER}\r\n`);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("body");
});

test("the body is never run as code", () => {
  const { dir, git, check } = scratch();
  const marker = join(dir, "ran");
  const head = git("rev-parse", "HEAD");
  const result = check(head, head, `$(touch ${marker}) \`touch ${marker}\` "; touch ${marker}`);
  expect(result.status).toBe(0);
  expect(existsSync(marker)).toBe(false);
});
