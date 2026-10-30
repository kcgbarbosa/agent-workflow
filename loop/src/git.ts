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

/** The repo's address on GitHub from its origin remote, `https://github.com/<owner>/<repo>`, or null when the remote is no GitHub one. */
export async function originUrl(cwd: string): Promise<string | null> {
  const remote = await git(cwd, "remote", "get-url", "origin").catch(() => "");
  const found = /^(?:git@github\.com:|https:\/\/github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(remote);
  return found ? `https://github.com/${found[1]}` : null;
}

export function slug(text: string, words = 6): string {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).slice(0, words).join("-") || "work";
}
