// The pull request reads of the runner, cut from the loop's, all through `gh`.
import { run } from "./exec.ts";

export type PullRequest = {
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  headRefName: string;
};

const FIELDS = "number,url,state,headRefName";

/**
 * The pull requests in any state that may be the ticket's. A search for the key in the title finds one whose branch
 * was named from an older summary, and the head branch finds one the search index has not taken in yet. Neither
 * has a count that older pull requests of the repo could fill.
 */
export async function pullRequestsNaming(cwd: string, key: string, branch: string): Promise<PullRequest[]> {
  const searched = await run("gh", ["pr", "list", "--state", "all", "--search", `"${key}" in:title`, "--limit", "100", "--json", FIELDS], cwd);
  const headed = await run("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", FIELDS], cwd);
  const found = new Map<number, PullRequest>();
  for (const pr of [...JSON.parse(searched || "[]"), ...JSON.parse(headed || "[]")] as PullRequest[]) found.set(pr.number, pr);
  return [...found.values()];
}
