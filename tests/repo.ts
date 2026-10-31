// The checkout under test, and the helpers the repo checks share.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/** Every file git tracks in the checkout, as absolute paths. */
export function tracked(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .map((name) => join(REPO, name))
    .filter((path) => existsSync(path) && lstatSync(path).isFile());
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "aw-test-"));
}

/** An environment whose git uses only a test identity, so the runner's own git config, such as commit signing, stays out. */
export function gitEnv(dir: string): NodeJS.ProcessEnv {
  const config = join(dir, "gitconfig");
  writeFileSync(config, "[user]\n\tname = Test\n\temail = test@example.com\n");
  return { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" };
}
