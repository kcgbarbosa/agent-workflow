// The `runner` command. A tick reads the state, decides the steps, and acts on them. `--dry-run` stops before it acts.
// `install` and `uninstall` turn the timer of the current repo on and off.
import { act } from "./act.ts";
import { load } from "./config.ts";
import { decide, lineOf } from "./decide.ts";
import { install, uninstall } from "./install.ts";
import { Jira } from "./jira.ts";
import { read } from "./read.ts";

const USAGE = "usage: runner tick [--dry-run] | install | uninstall";

/** A secret from the env, which `bws run` fills as it does for the loop. */
function secret(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`The runner has no value for ${name} in its env. Run it under \`bws run\`.`);
  return value;
}

async function tick(dryRun: boolean): Promise<number> {
  const cwd = process.cwd();
  const config = load(cwd);
  const jira = new Jira(config.jiraUrl, secret("JIRA_EMAIL"), secret("JIRA_API_TOKEN"));
  const topic = secret("NTFY_TOPIC");
  const steps = decide(await read(config, jira, cwd), config, Date.now());
  if (dryRun) {
    for (const step of steps) console.log(`dry-run ${lineOf(step)}`);
    return 0;
  }
  return (await act(steps, config, jira, topic, cwd)) ? 0 : 1;
}

async function main(args: string[]): Promise<number> {
  if (args[0] === "tick" && args.length === 1) return tick(false);
  if (args[0] === "tick" && args[1] === "--dry-run" && args.length === 2) return tick(true);
  if (args.length === 1 && (args[0] === "install" || args[0] === "uninstall")) {
    console.log(await (args[0] === "install" ? install : uninstall)(process.cwd()));
    return 0;
  }
  console.error(USAGE);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: Error) => {
    console.error(`runner: ${error.message}`);
    process.exitCode = 1;
  },
);
