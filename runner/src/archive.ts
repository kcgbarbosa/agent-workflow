// When every Epic that links a spec is Done, the spec leaves the default branch, and git keeps it, cut from the
// loop's. Each Spec line that links it changes to link the head of that branch, and a pull request deletes the files,
// with auto-merge on. It works in a fresh clone of the repo the Spec line links, which can be another repo than this
// one. GitHub, Jira and git hold the state, so a second archive repeats no side effect.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** Each link to change: this Epic's Spec line, and the lines of the other Epics that link the same files. */
export function pinsOf(epic: Ticket, linking: Ticket[]): Pin[] {
  const own = specLinks(epic.text);
  return [epic, ...linking].flatMap(({ key, text }) => specLinks(text).filter((link) => own.some((each) => sameFile(link, each))).map((link) => ({ key, link })));
}

/** Pins the links at the head of the default branch, and opens the pull request. Returns what it did, to log. */
export async function archive(key: string, summary: string, pins: Pin[], jira: Jira, cwd: string): Promise<string> {
  const folder = mkdtempSync(join(tmpdir(), "runner-archive-"));
  try {
    await run("gh", ["repo", "clone", pins[0].link.prefix, folder, "--", "--quiet"], cwd);
    const commit = (await run("git", ["rev-parse", "HEAD"], folder)).trim();
    const at = (link: Link) => (SHA.test(link.ref) ? link.url : `${link.prefix}/blob/${commit}/${link.path}`);
    for (const { key: owner, link } of pins) if (!SHA.test(link.ref)) await jira.replaceInDescription(owner, link.url, at(link));

    const paths = [...new Set(pins.map(({ link }) => link.path))].sort();
    const left = (await run("git", ["ls-tree", "--name-only", "HEAD", "--", ...paths], folder)).split("\n").filter(Boolean);
    if (!left.length) return "the spec is not on the default branch";
    const branch = `docs/${key}-archive-spec`;
    const title = `docs(${key}): archive the spec of ${summary.slice(0, 1).toLowerCase()}${summary.slice(1)}`;
    const url = (await openFrom(folder, branch)) ?? (await openPullRequest(folder, branch, left, title, [...new Set(pins.map(({ link }) => at(link)))].sort()));
    await autoMerge(folder, url);
    return `the pull request ${url} deletes ${left.join(", ")}`;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
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
