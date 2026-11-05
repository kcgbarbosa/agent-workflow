// `runner tasks`: registers the files of `tasks/` as T3 scheduled tasks, the triage in this repo and the correct in
// each repo with a runner. `t3` has no scheduling command, so a thread in the project calls `schedule_task`. A thread
// that fails stops no other, and running this again updates each task, so a second run after a failure is safe.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { load } from "./config.ts";
import { installedRepos } from "./install.ts";
import { askThread, projectOf } from "./t3.ts";

/** The checkout of this code, which holds `tasks/` and this repo's `runner.toml`. */
const CHECKOUT = join(import.meta.dirname, "..", "..");

/** The file's first line, `# <title>`, is the task's title: the one the thread matches on. */
function titleOf(text: string, file: string): string {
  const title = /^# (.+)\n/.exec(text)?.[1];
  if (!title) throw new Error(`${file} needs \`# <title>\` as its first line.`);
  return title;
}

function messageOf(title: string, timeOfDay: string, text: string): string {
  return `Register a T3 scheduled task for this project, then reply with its id and its next run time. Do not run the prompt. Load the tools with ToolSearch if they are deferred.

Call \`list_scheduled_tasks\` for this project. If a task has the same title, call \`schedule_task\` with its \`scheduledTaskId\`, to update it. If none has, call \`schedule_task\` to create one. Either way, pass these values, and make no other task:

Title: ${title}
\`schedule\`: ${JSON.stringify({ type: "fixed_time", timeOfDay })}
\`bindToCurrentThread\`: false
\`prompt\`: all of the text between the two marker lines, unchanged.

PROMPT START
${text}PROMPT END`;
}

async function register(project: string, config: string, file: string, timeOfDay: string): Promise<boolean> {
  const text = readFileSync(join(CHECKOUT, "tasks", file), "utf8");
  const title = titleOf(text, file);
  const name = `${title} in ${basename(project)}`;
  try {
    const { provider, model } = load(config);
    console.log(`${name}: ${await askThread(project, { title: `Register ${name}`, provider, model, message: messageOf(title, timeOfDay, text) })}`);
    return true;
  } catch (error) {
    console.error(`${name} failed: ${(error as Error).message}`);
    return false;
  }
}

/** Whether every task registered. One at a time, so a failure's output stays apart from the next thread's. */
export async function registerTasks(): Promise<boolean> {
  let done = await register(await projectOf(CHECKOUT), CHECKOUT, "daily-triage.md", "06:00");
  for (const repo of installedRepos()) done = (await register(repo, repo, "daily-correct.md", "06:30")) && done;
  return done;
}
