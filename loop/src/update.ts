// `loop start` takes the new commits of the loop's own checkout first. It has no dirty check of its own:
// `git merge --ff-only` refuses only when a change that is not committed overlaps the incoming commits,
// so a local edit such as `config/settings.json` stays and the update still runs.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, GitError } from "./git.ts";

export class UpdateError extends Error {}

/** The checkout the loop runs from. `LOOP_CHECKOUT` names another, as the tests do. */
export function sourceCheckout(): string | null {
  if (process.env.LOOP_CHECKOUT) return process.env.LOOP_CHECKOUT;
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return existsSync(join(root, ".git")) && existsSync(join(root, "loop", "package.json")) ? root : null;
}

export async function update(checkout: string): Promise<{ message: string; updated: boolean }> {
  const branch = await git(checkout, "branch", "--show-current");
  if (branch !== "main") return { message: `The loop runs as it is, on the branch ${branch || "(detached)"}.`, updated: false };
  try {
    await git(checkout, "fetch", "--quiet", "origin", "main");
  } catch (error) {
    throw new UpdateError(`The loop could not fetch origin: ${(error as Error).message}`);
  }
  const behind = Number(await git(checkout, "rev-list", "--count", "HEAD..origin/main"));
  if (!behind) return { message: "The loop is current.", updated: false };
  try {
    await git(checkout, "merge", "--ff-only", "--quiet", "origin/main");
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    throw new UpdateError(`The loop could not take the new commits from origin. Git says:\n${error.message}`);
  }
  return { message: `The loop took ${behind} new commit${behind === 1 ? "" : "s"} from origin.`, updated: true };
}
