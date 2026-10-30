// `loop start <KEY>` or `loop start --filter <JQL>` updates the loop's own checkout, then runs. KEY is an Epic
// or a ticket. `loop run` runs with no update. `loop watch` serves the page of the runs on this host, and
// `loop report [<KEY>]` breaks down what the latest run cost against the run before it.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { claudePath } from "./agent.ts";
import { type Config, ConfigError, load, REQUIRED_SECRETS } from "./config.ts";
import { git } from "./git.ts";
import { Forecaster } from "./forecast.ts";
import { text } from "./report.ts";
import { Run, type Target } from "./run.ts";
import { endAll, endGroup, spawnGroup } from "./spawn.ts";
import { sourceCheckout, update, UpdateError } from "./update.ts";
import { comparison, serve, WATCH_PORT } from "./watch.ts";

const KEY = /^[A-Z][A-Z0-9]*-\d+$/;
const USAGE = [
  "Usage: loop start|run <KEY> [--repo <path>]",
  "       loop start|run --filter <JQL> [--repo <path>]",
  "       loop watch [--repo <path>]",
  "       loop report [<KEY>] [--against <KEY>] [--json] [--repo <path>]",
].join("\n");
// The seconds between two polls of a pull request. The tests set a short one.
const POLL_SECONDS = Number(process.env.LOOP_POLL_SECONDS ?? 30);
// The tests take any free port.
const PORT = Number(process.env.LOOP_WATCH_PORT ?? WATCH_PORT);

async function mainCheckout(folder: string): Promise<string> {
  return dirname(await git(folder, "rev-parse", "--path-format=absolute", "--git-common-dir"));
}

function readSecrets(config: Config): Record<string, string> {
  const path = join(config.stateDir, "secrets.json");
  if (!existsSync(path)) throw new ConfigError(`${path} is missing. Run \`loop secrets\` once to write it.`);
  const secrets = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  const missing = REQUIRED_SECRETS.filter((name) => !secrets[name]);
  if (missing.length) throw new ConfigError(`${path} has no ${missing.join(", ")}. Run \`loop secrets\` again.`);
  return secrets;
}

function missingTools(): string[] {
  const path = process.env.PATH ?? "";
  const found = (tool: string) => path.split(":").some((folder) => existsSync(join(folder, tool)));
  return ["git", "gh"].filter((tool) => !found(tool)).concat(claudePath(path) ? [] : ["claude"]);
}

/** Runs the new code of a checkout that just took commits, as the code in this process is the old one. */
function rerun(args: string[]): Promise<number> {
  const child = spawnGroup(process.execPath, [...process.execArgv, process.argv[1]!, "run", ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const stop = () => void endGroup(child);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return new Promise((done) => child.once("close", (code) => done(code ?? 1)));
}

async function run(target: Target, repoArg: string | undefined): Promise<number> {
  const missing = missingTools();
  if (missing.length) {
    console.error(`The loop refuses to run: ${missing.join(", ")} not on the PATH.`);
    return 2;
  }
  const config = load(await mainCheckout(resolve(repoArg ?? process.cwd())));
  for (const warning of config.warnings) console.error(warning);
  const secrets = readSecrets(config);
  const loop = new Run(config, secrets, target, { pollSeconds: POLL_SECONDS });
  const stop = async () => {
    loop.log.write(loop.log.run, "stop", "stopped");
    await endAll();
    process.exit(143);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    return await loop.run();
  } catch (error) {
    loop.log.write(loop.log.run, "stop", "loop-error", { detail: (error as Error).message });
    return 1;
  }
}

/** Serves the page until the process stops. It changes nothing the loop reads. */
async function watch(repoArg: string | undefined): Promise<number> {
  const config = load(await mainCheckout(resolve(repoArg ?? process.cwd())));
  // With no secrets, the forecast says why it has no open work, and the rest of the page works.
  let secrets: Record<string, string> = {};
  try {
    secrets = readSecrets(config);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
  }
  let server;
  try {
    server = await serve(config.stateDir, PORT, { forecast: new Forecaster(config, secrets) });
  } catch (error) {
    console.error(`loop watch cannot listen on port ${PORT}: ${(error as Error).message}`);
    return 2;
  }
  for (const url of server.urls) console.log(`loop watch serves the ${config.name} runs at ${url}`);
  await new Promise((done) => {
    process.once("SIGTERM", done);
    process.once("SIGINT", done);
  });
  await server.close();
  return 0;
}

/** The breakdown of what a run cost, against the run before it, from the logs on this host. */
async function report(key: string | undefined, against: string | undefined, json: boolean, repoArg: string | undefined): Promise<number> {
  const config = load(await mainCheckout(resolve(repoArg ?? process.cwd())));
  const found = comparison(config.stateDir, key, against);
  if (!found) {
    console.error(key ? `This host has no run of ${key}.` : "This host has no run.");
    return 1;
  }
  console.log(json ? JSON.stringify(found, null, 1) : text(found.current, found.previous, found.rows));
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { filter: { type: "string" }, repo: { type: "string" }, against: { type: "string" }, json: { type: "boolean" } },
    });
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const [command, key, ...rest] = parsed.positionals;
  const { filter, against, json, repo } = parsed.values;
  const reportArgs = !filter && !rest.length && (!key || KEY.test(key)) && (!against || KEY.test(against));
  try {
    if (command === "watch" && !key && !filter && !against && !json) return await watch(repo);
    if (command === "report" && reportArgs) return await report(key, against, json ?? false, repo);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
  const valid =
    (command === "start" || command === "run") && !rest.length && !against && !json && (filter ? !key : key && KEY.test(key));
  if (!valid) {
    console.error(USAGE);
    return 2;
  }
  const target: Target = filter ? { filter } : { key: key! };
  try {
    if (command === "start") {
      const checkout = sourceCheckout();
      if (checkout) {
        const { message, updated } = await update(checkout);
        console.log(message);
        if (updated) return await rerun(argv.slice(1));
      }
    }
    return await run(target, repo);
  } catch (error) {
    if (error instanceof ConfigError || error instanceof UpdateError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
}

const code = await main(process.argv.slice(2));
await endAll();
process.exit(code);
