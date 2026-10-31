// No repo check changes the checkout: each runs its scripts in a temp folder.
import { execFileSync } from "node:child_process";
import { REPO } from "./repo.ts";

function state(): string {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" });
  return git("status", "--porcelain", "--untracked-files=all") + git("diff", "HEAD");
}

export default function setup(): () => void {
  const before = state();
  return () => {
    if (state() !== before) throw new Error("a repo check changed the checkout");
  };
}
