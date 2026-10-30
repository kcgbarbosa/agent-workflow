// `loop start <KEY>` or `loop start --filter <JQL>` updates the loop's own checkout, then starts `loop run`
// as a systemd user unit, and the watch page as another. KEY is an Epic or a ticket. `loop stop` stops the run's
// unit. `loop run` is the run itself, which the unit runs. `loop secrets` copies the secrets from Bitwarden to
// this host. `loop watch` serves the page of the runs on this host, and `loop report [<KEY>]` breaks down what
// the latest run cost against the run before it.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { claudePath } from "./agent.ts";
import { ConfigError, load, peek, stateDirOf } from "./config.ts";
import { git } from "./git.ts";
import { Forecaster } from "./forecast.ts";
import { text } from "./report.ts";
import { Run, runName, type Target } from "./run.ts";
import { copySecrets, NO_SECRETS, readSecrets, secretsPath } from "./secrets.ts";
import { endAll } from "./spawn.ts";
import { awake, runs, runUnit, startRun, startWatch, stopRun, UnitError } from "./units.ts";
import { sourceCheckout, update, UpdateError } from "./update.ts";
import { comparison, pageUrl, serve, WATCH_PORT } from "./watch.ts";

const KEY = /^[A-Z][A-Z0-9]*-\d+$/;
/** A filter run is named by a hash of its JQL, as `runName` gives it. */
const FILTER_RUN = /^filter-[0-9a-f]{8}$/;
const USAGE = [
  "Usage: loop start|run <KEY> [--repo <path>]",
  "       loop start|run --filter <JQL> [--repo <path>]",
  "       loop stop <KEY>|--filter <JQL> [--repo <path>]",
  "       loop secrets [--repo <path>]",
  "       loop watch [--repo <path>]",
  "       loop report [<KEY>] [--against <KEY>] [--json] [--repo <path>]",
].join("\n");
// The seconds between two polls of a pull request. The tests set a short one.
const POLL_SECONDS = Number(process.env.LOOP_POLL_SECONDS ?? 30);
// The least seconds between two plan meter lines of a running agent. The tests set a short one.
const METER_SECONDS = Number(process.env.LOOP_METER_SECONDS ?? 60);
// The tests take any free port.
const PORT = Number(process.env.LOOP_WATCH_PORT ?? WATCH_PORT);

async function mainCheckout(folder: string): Promise<string> {
  return dirname(await git(folder, "rev-parse", "--path-format=absolute", "--git-common-dir"));
}

function missingTools(needed: string[]): string[] {
  const path = process.env.PATH ?? "";
  const found = (tool: string) => path.split(":").some((folder) => existsSync(join(folder, tool)));
  const tools = [...new Set(["git", "gh", "systemd-inhibit", ...needed])].filter((tool) => !found(tool));
  return claudePath(path) ? tools : ["claude", ...tools];
}

/** Starts the run in its unit, and the watch page in its own, then returns. The run checks the rest itself. */
async function start(target: Target, repoArg: string | undefined, newCode: boolean): Promise<number> {
  const repo = await mainCheckout(resolve(repoArg ?? process.cwd()));
  const project = peek(repo);
  if (!existsSync(secretsPath(stateDirOf(project)))) throw new ConfigError(`This host has no secrets file. ${NO_SECRETS}`);
  const [active] = await runs(project);
  if (active) throw new UnitError(`A run is active: ${runUnit(project, active)}. \`loop stop ${active}\` stops it.`);
  const name = runName(target);
  const unit = await startRun(repo, project, name, "key" in target ? [target.key] : ["--filter", target.filter]);
  await startWatch(repo, newCode);
  openOnScreen(`http://127.0.0.1:${WATCH_PORT}/#/${project}/${name}`);
  console.log(`The loop is building ${name}. Watch it at ${await pageUrl(project, name)}, or with \`journalctl --user -fu ${unit}\`.`);
  return 0;
}

/** Opens the page on this host's screen, when it has one. The loop does not wait for the browser. */
function openOnScreen(url: string): void {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;
  if (!(process.env.PATH ?? "").split(":").some((folder) => existsSync(join(folder, "xdg-open")))) return;
  spawn("xdg-open", [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

async function stop(name: string, repoArg: string | undefined): Promise<number> {
  const project = peek(await mainCheckout(resolve(repoArg ?? process.cwd())));
  if (!(await stopRun(project, name))) {
    console.error(`No run of ${name} is active.`);
    return 1;
  }
  console.log(`The loop stopped ${name}. \`loop start ${name.startsWith("filter-") ? "--filter <JQL>" : name}\` goes on with the same tickets.`);
  return 0;
}

async function secrets(repoArg: string | undefined): Promise<number> {
  console.log(await copySecrets(load(await mainCheckout(resolve(repoArg ?? process.cwd())))));
  return 0;
}

async function run(target: Target, repoArg: string | undefined): Promise<number> {
  const config = load(await mainCheckout(resolve(repoArg ?? process.cwd())));
  for (const warning of config.warnings) console.error(warning);
  const missing = missingTools([...config.tools, ...(config.stack ? ["docker"] : [])]);
  if (missing.length) {
    console.error(`The loop refuses to run: ${missing.join(", ")} not on the PATH.`);
    return 2;
  }
  const secrets = readSecrets(config);
  await awake(config.name, runName(target));
  const loop = new Run(config, secrets, target, { pollSeconds: POLL_SECONDS, meterSeconds: METER_SECONDS });
  let stopping: Promise<never> | null = null;
  const stop = () => {
    stopping ??= loop.stop().then(() => process.exit(143));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  let code: number;
  try {
    code = await loop.run();
  } catch (error) {
    await loop.failed(error as Error);
    code = 1;
  }
  // A stop ends the agents, so the run can return before the stop has notified. The stop ends the process.
  return stopping ?? code;
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
  const bare = !key && !filter && !against && !json;
  const reportArgs = !filter && !rest.length && (!key || KEY.test(key)) && (!against || KEY.test(against));
  const targetArgs = !rest.length && !against && !json && (filter ? !key : key && KEY.test(key));
  const target: Target = filter ? { filter } : { key: key ?? "" };
  try {
    if (command === "watch" && bare) return await watch(repo);
    if (command === "secrets" && bare) return await secrets(repo);
    if (command === "report" && reportArgs) return await report(key, against, json ?? false, repo);
    // `loop stop` also takes the name of a filter run, which `loop start` prints when one is active.
    const runArg = !filter && !rest.length && !against && !json && key && FILTER_RUN.test(key);
    if (command === "stop" && (targetArgs || runArg)) return await stop(runArg ? key! : runName(target), repo);
    if (command === "run" && targetArgs) return await run(target, repo);
    if (command === "start" && targetArgs) {
      const checkout = sourceCheckout();
      let newCode = false;
      if (checkout) {
        const { message, updated } = await update(checkout);
        console.log(message);
        newCode = updated;
      }
      return await start(target, repo, newCode);
    }
  } catch (error) {
    if (error instanceof ConfigError || error instanceof UpdateError || error instanceof UnitError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
  console.error(USAGE);
  return 2;
}

const code = await main(process.argv.slice(2));
await endAll();
process.exit(code);
