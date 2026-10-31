// The pull request text checks: no ticket key in the text or the commits, and a typed title with no em dash.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { gitEnv, REPO, tempDir } from "./repo.ts";

const SCRIPTS = join(REPO, ".github", "scripts");
const DASH = "\u2014";

function keys(text: string, message = "second") {
  const dir = tempDir();
  const env = gitEnv(dir);
  const work = join(dir, "work");
  mkdirSync(work);
  for (const args of [["init", "-q"], ["commit", "-q", "--allow-empty", "-m", "first"], ["commit", "-q", "--allow-empty", "-m", message]])
    execFileSync("git", args, { cwd: work, env });
  writeFileSync(join(work, "projects"), "PITCH\nGAL\n");
  return spawnSync(join(SCRIPTS, "check-pr-keys.sh"), ["HEAD~1..HEAD"], {
    cwd: work,
    env: { ...env, TICKET_PROJECTS_FILE: join(work, "projects") },
    input: text,
    encoding: "utf8",
  });
}

function title(title: string, body = "") {
  return spawnSync(join(SCRIPTS, "check-pr-title.sh"), { env: { ...process.env, TITLE: title, BODY: body }, encoding: "utf8" });
}

test("a key in the text fails", () => {
  const result = keys("fix(loop): stop it\nIn PITCH-13, a restart did it.");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("PITCH-13");
});

test("a key in a commit message fails", () => {
  const result = keys("fix(loop): stop it\n", "fix(GAL-4): stop it");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("GAL-4");
});

test("text with no key passes", () => {
  expect(keys("fix(loop): stop it\nA restart did it. See UTF-8 and ADR-0023.").status).toBe(0);
});

test("a title needs a type", () => {
  expect(title("fix(loop): stop a stuck session").status).toBe(0);
  expect(title("ci: guard the title").status).toBe(0);
  expect(title("Stop a stuck session").status).toBe(1);
});

test("an em dash in the title or the body fails", () => {
  expect(title(`fix(loop): stop it ${DASH} now`).status).toBe(1);
  expect(title("fix(loop): stop it", `It stops ${DASH} now.`).status).toBe(1);
});
