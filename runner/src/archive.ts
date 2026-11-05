// When every Epic that links a spec is Done and nothing else uses the spec, the spec leaves the default branch, and git keeps it. A pull request deletes the files,
// with auto-merge on, and each Spec line that links them changes to link a commit that holds them. That link is what marks a
// Done Epic as finished, so it moves last. It works in a fresh clone of the repo the Spec line links, which can be another repo than this
// one. GitHub, Jira and git hold the state, so a second archive repeats no side effect.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { run } from "./exec.ts";
import { autoMerge, create, openFrom } from "./github.ts";
import type { Jira, Ticket } from "./jira.ts";

/** A link to a Markdown file at a ref of a GitHub repo, in the text or a link target of the description. */
const LINK = /(https?:\/\/[^\s"'<>()[\]\\]+?)\/blob\/([^/\s"'<>()[\]\\]+)\/([^\s"'<>()[\]\\#?]+?\.md)\b/g;
const SHA = /^[0-9a-f]{40}$/;
/** The Spec line of an Epic's description. */
const SPEC_LINE = /^\s*\**spec\**[.:]/i;

export type Link = { url: string; prefix: string; ref: string; path: string };
/** A link to change, and the Epic whose description holds it. */
export type Pin = { key: string; link: Link };

/** Whether the Spec line still links a file by a branch, which marks an Epic whose archive has not finished. */
export function unarchived(description: string): boolean {
  return specLinks(description).some((link) => !SHA.test(link.ref));
}

/** The links of the Spec line, each once, all in the repo of its first link. */
export function specLinks(description: string): Link[] {
  const line = description.split("\n").find((each) => SPEC_LINE.test(each)) ?? "";
  const found = new Map<string, Link>();
  for (const [url, prefix, ref, path] of line.matchAll(LINK)) found.set(url, { url, prefix, ref, path });
  const links = [...found.values()];
  return links.filter((link) => link.prefix === links[0].prefix);
}

function sameFile(one: Link, other: Link): boolean {
  return one.prefix === other.prefix && one.path === other.path;
}

/** The other Epics whose Spec line links a file of this Epic's Spec line, in any project. */
export async function linkingEpics(jira: Jira, epic: Ticket): Promise<Ticket[]> {
  const links = specLinks(epic.text);
  const found = new Map<string, Ticket>();
  for (const path of new Set(links.map((link) => link.path))) {
    for (const other of await jira.search(`issuetype = Epic AND description ~ "\\"${path}\\"" ORDER BY key ASC`)) {
      if (other.key !== epic.key && specLinks(other.text).some((link) => links.some((own) => sameFile(link, own)))) found.set(other.key, other);
    }
  }
  return [...found.values()];
}

/**
 * What still uses the Spec line's files on the default branch: each tracked file and each open ticket that names one,
 * by its file name, because a file can build the path in pieces. A wrong match only keeps a spec, and the log names it.
 */
export async function usersOf(jira: Jira, epic: Ticket, cwd: string): Promise<string[]> {
  const links = specLinks(epic.text);
  if (!links.length) return [];
  const folder = mkdtempSync(join(tmpdir(), "runner-uses-"));
  try {
    await run("gh", ["repo", "clone", links[0].prefix, folder, "--", "--quiet", "--depth", "1"], cwd);
    const paths = [...new Set(links.map((link) => link.path))];
    const left = (await run("git", ["ls-tree", "--name-only", "HEAD", "--", ...paths], folder)).split("\n").filter(Boolean);
    const users = new Set<string>();
    for (const name of new Set(left.map((path) => basename(path)))) {
      // grep exits 1 when it finds nothing, and higher when it fails.
      const named = await run("sh", ["-c", 'git grep -lF -e "$1"; [ $? -le 1 ]', "sh", name], folder);
      for (const file of named.split("\n").filter(Boolean)) if (!left.includes(file)) users.add(file);
      for (const ticket of await jira.search(`issuetype != Epic AND statusCategory != Done AND description ~ "\\"${name}\\"" ORDER BY key ASC`)) users.add(ticket.key);
    }
    return [...users].sort();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** Each link to change: this Epic's Spec line, and the lines of the other Epics that link the same files. */
export function pinsOf(epic: Ticket, linking: Ticket[]): Pin[] {
  const own = specLinks(epic.text);
  return [epic, ...linking].flatMap(({ key, text }) => specLinks(text).filter((link) => own.some((each) => sameFile(link, each))).map((link) => ({ key, link })));
}

/** Opens the pull request, and pins the links. Returns what it did, to log. */
export async function archive(key: string, summary: string, pins: Pin[], jira: Jira, cwd: string): Promise<string> {
  const folder = mkdtempSync(join(tmpdir(), "runner-archive-"));
  try {
    await run("gh", ["repo", "clone", pins[0].link.prefix, folder, "--", "--quiet"], cwd);
    const paths = [...new Set(pins.map(({ link }) => link.path))].sort();
    const left = (await run("git", ["ls-tree", "--name-only", "HEAD", "--", ...paths], folder)).split("\n").filter(Boolean);
    const holders = new Map<string, string>();
    for (const path of paths) holders.set(path, await lastHolder(folder, path, left.includes(path)));
    const at = (link: Link) => (SHA.test(link.ref) || !holders.get(link.path) ? link.url : `${link.prefix}/blob/${holders.get(link.path)}/${link.path}`);

    let done = "the spec is not on the default branch";
    if (left.length) {
      const branch = `docs/${key}-archive-spec`;
      const title = `docs(${key}): archive the spec of ${summary.slice(0, 1).toLowerCase()}${summary.slice(1)}`;
      const url = (await openFrom(folder, branch)) ?? (await openPullRequest(folder, branch, left, title, [...new Set(pins.map(({ link }) => at(link)))].sort()));
      await autoMerge(folder, url);
      done = `the pull request ${url} deletes ${left.join(", ")}`;
    }
    for (const { key: owner, link } of pins) if (at(link) !== link.url) await jira.replaceInDescription(owner, link.url, at(link));
    return done;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** The newest commit that holds the file: the head, or the parent of the commit that deleted it. Nothing when it never was on the branch. */
async function lastHolder(folder: string, path: string, onHead: boolean): Promise<string> {
  if (onHead) return (await run("git", ["rev-parse", "HEAD"], folder)).trim();
  const deleted = (await run("git", ["rev-list", "-1", "HEAD", "--", path], folder)).trim();
  return deleted ? (await run("git", ["rev-parse", `${deleted}^`], folder)).trim() : "";
}

async function openPullRequest(folder: string, branch: string, paths: string[], title: string, pins: string[]): Promise<string> {
  await run("git", ["checkout", "--quiet", "-b", branch], folder);
  await run("git", ["rm", "--quiet", "--", ...paths], folder);
  await run("git", ["commit", "--quiet", "-m", title], folder);
  // An earlier archive can have pushed the branch and failed to open its pull request.
  await run("git", ["push", "--quiet", "--force-with-lease", "--set-upstream", "origin", branch], folder);
  const list = pins.map((pin) => `- ${pin}\n`).join("");
  return create(folder, branch, title, `The last ticket of the Epic is Done, so the spec leaves the default branch. Git keeps it:\n\n${list}`);
}
