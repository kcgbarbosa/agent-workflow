import { run } from "./spawn.ts";

export class GitError extends Error {}

/** Runs git in the folder, and returns its trimmed output. A failure throws git's own message. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const done = await run("git", args, { cwd });
  if (done.code !== 0) throw new GitError((done.stderr || done.stdout).trim() || `git ${args[0]} failed`);
  return done.stdout.trim();
}

export async function gitOk(cwd: string, ...args: string[]): Promise<boolean> {
  return (await run("git", args, { cwd })).code === 0;
}

export function slug(text: string, words = 6): string {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).slice(0, words).join("-") || "work";
}
