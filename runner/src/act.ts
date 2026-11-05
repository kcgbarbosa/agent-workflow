// The third step of a tick: it performs the steps and logs each. A step that fails drops the rest of its ticket's
// steps and holds up no other ticket. The next tick reads what happened, so nothing is done twice.
import { archive } from "./archive.ts";
import type { Config } from "./config.ts";
import { lineOf, type Step } from "./decide.ts";
import { run } from "./exec.ts";
import { autoMerge, comment } from "./github.ts";
import type { Jira } from "./jira.ts";
import { post } from "./notify.ts";
import { sendMessage, startThread } from "./t3.ts";

/** The head of the main branch on origin, since the checkout's own copy may be behind a blocker that just merged. */
async function headOfMain(config: Config, cwd: string): Promise<string> {
  await run("git", ["fetch", "--quiet", "origin", config.mainBranch], cwd);
  return (await run("git", ["rev-parse", "FETCH_HEAD"], cwd)).trim();
}

/** Returns whether every step went through. It throws, before any write, when it cannot find the head of main. */
export async function act(steps: Step[], config: Config, jira: Jira, webhook: string, cwd: string): Promise<boolean> {
  const base = steps.some((step) => step.kind === "start") ? await headOfMain(config, cwd) : "";
  const failed = new Set<string>();
  for (const step of steps) {
    if (failed.has(step.key)) continue;
    try {
      if (step.kind === "start") {
        await startThread(cwd, { title: step.title, provider: config.provider, model: config.model, base, branch: step.branch, message: step.message });
      } else if (step.kind === "status") {
        await jira.transition(step.key, step.status);
      } else if (step.kind === "send") {
        await sendMessage(cwd, step.threadId, step.message);
      } else if (step.kind === "comment") {
        await jira.comment(step.key, step.text);
      } else if (step.kind === "pr-comment") {
        await comment(cwd, step.url, step.text);
      } else if (step.kind === "auto-merge") {
        await autoMerge(cwd, step.url);
      } else if (step.kind === "flag") {
        await jira.flag(step.key);
      } else if (step.kind === "archive") {
        console.log(`${step.key} archive: ${await archive(step.key, step.summary, step.pins, jira, cwd)}`);
      } else if (step.kind === "notify") {
        await post(webhook, step.text);
      }
      console.log(lineOf(step));
    } catch (error) {
      failed.add(step.key);
      console.error(`${step.key} failed: ${lineOf(step)}: ${(error as Error).message}`);
    }
  }
  return failed.size === 0;
}
