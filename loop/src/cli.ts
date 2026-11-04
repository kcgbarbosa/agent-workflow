// `loop start` updates the loop's own checkout, then starts the dispatcher, `loop dispatch`, as the systemd user
// unit `loop-<name>-dispatch`, and the watch page as another. The dispatcher starts a worker, `loop run-ticket
// <KEY> --slot <n>`, in the ticket's own unit for each ready ticket of the queue. `loop ticket <KEY>` takes a slot
// and starts one worker by hand. `loop stop` stops the dispatcher and every worker, and `loop stop <KEY>` one
// worker, whose ticket it flags. The units run under `bws run`, with the secrets in their env. `loop watch`
// serves the page of the runs on this host, and `loop report [<KEY>]` breaks down what the latest run cost
// against the run before it. `loop run <KEY>` builds an Epic in the foreground, as the scenario tests drive it,
// and completes no Epic.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { claudePath } from "./agent.ts";
import { runCorrect, startCorrect } from "./correct.ts";
import { type Config, ConfigError, load, peek } from "./config.ts";
import { git } from "./git.ts";
import { Forecaster } from "./forecast.ts";
import { Jira } from "./jira.ts";
import { CORRECT, DISPATCH } from "./layout.ts";
import { dayReport, dayText, text } from "./report.ts";
import { Dispatcher } from "./dispatch.ts";
import { Run, runName, type Target } from "./run.ts";
import { checkSecrets, readSecrets, secretNames, storedNames, storedSecrets } from "./secrets.ts";
import { composeProject, freeSlot, portsFree, takeSlot } from "./slots.ts";
import { endAll } from "./spawn.ts";
import { awake, runs, runUnit, startRun, startWatch, stopRun, UnitError } from "./units.ts";
import { sourceCheckout, update, UpdateError } from "./update.ts";
import { comparison, pageUrl, serve, WATCH_PORT } from "./watch.ts";

const KEY = /^[A-Z][A-Z0-9]*-\d+$/;
const USAGE = [
  "Usage: loop start [--repo <path>]",
  "       loop ticket <KEY> [--repo <path>]",
  "       loop stop [<KEY>] [--repo <path>]",
  "       loop correct [--repo <path>]",
  "       loop dispatch [--repo <path>]",
  "       loop run-ticket <KEY> --slot <n> [--repo <path>]",
  "       loop run-correct --slot <n> [--repo <path>]",
  "       loop run <KEY>|--filter <JQL> [--repo <path>]",
  "       loop watch [--repo <path>]",
  "       loop report [<KEY>] [--against <KEY>] [--json] [--repo <path>]",
].join("\n");
// The seconds between two polls of a pull request. The tests set a short one.
const POLL_SECONDS = Number(process.env.LOOP_POLL_SECONDS ?? 30);
// The seconds between two reads of the queue, `[queue] poll_minutes` unless the tests set a short one.
const QUEUE_SECONDS = process.env.LOOP_QUEUE_SECONDS;
// The seconds between two Epic checks of every open Epic. The tests set a short one.
const EPIC_SECONDS = Number(process.env.LOOP_EPIC_SECONDS ?? 60 * 60);
/** The line of an old command, which the per-ticket loop dropped. */
const GONE_START = "`loop start <KEY>` and `loop start --filter` are gone. `loop start` builds every ready ticket of the queue, `[queue] filter` in loop.toml picks them, and `loop ticket <KEY>` builds one ticket.";
const GONE_STOP = "`loop stop --filter` is gone. `loop stop` stops the dispatcher and every worker, and `loop stop <KEY>` one worker.";
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

/** Starts the dispatcher in its unit, and the watch page in its own, then returns. The dispatcher checks the rest. */
async function start(repoArg: string | undefined, newCode: boolean): Promise<number> {
  const repo = await mainCheckout(resolve(repoArg ?? process.cwd()));
  const config = load(repo);
  for (const warning of config.warnings) console.error(warning);
  await checkSecrets(config.secrets);
  if ((await runs(config.name)).includes(DISPATCH)) {
    return refuse(`The dispatcher is active: ${runUnit(config.name, DISPATCH)}. \`loop stop\` stops it.`);
  }
  const unit = await startRun(repo, config.name, DISPATCH, [], DISPATCH);
  await startWatch(repo, newCode);
  openOnScreen(`http://127.0.0.1:${WATCH_PORT}/#/${config.name}`);
  console.log(`The loop is building the queue of ${config.name}. Watch it at ${await pageUrl(config.name)}, or with \`journalctl --user -fu ${unit}\`.`);
  return 0;
}

/**
 * Takes a slot and starts the ticket's worker in the unit `loop-<name>-<KEY>`, then returns. It refuses, with
 * one line, a ticket whose unit is active, one that is Flagged, of another component, or with no component,
 * and a start with no free slot.
 */
async function ticket(key: string, repoArg: string | undefined, newCode: boolean): Promise<number> {
  const repo = await mainCheckout(resolve(repoArg ?? process.cwd()));
  const config = load(repo);
  await checkSecrets(config.secrets);
  const active = new Set(await runs(config.name));
  if (active.has(key)) return refuse(`${key} is building in ${runUnit(config.name, key)}. \`loop stop ${key}\` stops it.`);
  let why: string | null;
  try {
    why = await unbuildable(config, key);
  } catch (error) {
    return refuse(`The loop cannot read ${key} in Jira: ${(error as Error).message}`);
  }
  if (why) return refuse(why);
  const usable = await portsFree(config.stateDir, composeProject(config.name, key), config.stack);
  const slot = takeSlot(config.stateDir, key, runUnit(config.name, key), config.parallel, active, usable);
  if (slot === null) return refuse(`No slot is free: ${config.parallel} of ${config.parallel} tickets are building. \`loop stop <KEY>\` frees one.`);
  let unit: string;
  try {
    unit = await startRun(repo, config.name, key, [key, "--slot", String(slot)], "run-ticket");
  } catch (error) {
    freeSlot(config.stateDir, slot, key);
    throw error;
  }
  await startWatch(repo, newCode);
  openOnScreen(`http://127.0.0.1:${WATCH_PORT}/#/${config.name}/${key}`);
  console.log(`The loop is building ${key} in slot ${slot}. Watch it at ${await pageUrl(config.name, key)}, or with \`journalctl --user -fu ${unit}\`.`);
  return 0;
}

/** Jira, with the secrets of Secrets Manager, for a command that runs outside `bws run`. */
async function storedJira(config: Config): Promise<Jira> {
  const secrets = await storedSecrets();
  return new Jira(config.trackerUrl, secrets.get("JIRA_EMAIL") ?? "", secrets.get("JIRA_API_TOKEN") ?? "");
}

/** Why this repo's loop does not build the ticket, or null when it does. */
async function unbuildable(config: Config, key: string): Promise<string | null> {
  const found = await (await storedJira(config)).ticket(key);
  if (found.flagged) return `${key} is Flagged. Unflag it in Jira, and \`loop ticket ${key}\` builds it.`;
  if (!found.components.length) return `${key} has no component. Set its Jira component to ${config.component}, the repo it changes.`;
  if (!found.components.includes(config.component)) {
    return `${key} is of the component ${found.components.join(", ")}, not ${config.component}, so this repo's loop does not build it.`;
  }
  return null;
}

function refuse(message: string): number {
  console.error(message);
  return 2;
}

/** Opens the page on this host's screen, when it has one. The loop does not wait for the browser. */
function openOnScreen(url: string): void {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;
  if (!(process.env.PATH ?? "").split(":").some((folder) => existsSync(join(folder, "xdg-open")))) return;
  spawn("xdg-open", [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

/** Stops the dispatcher, then each worker, and flags nothing, so the next `loop start` goes on with the same tickets. */
async function stopAll(repoArg: string | undefined): Promise<number> {
  const project = peek(await mainCheckout(resolve(repoArg ?? process.cwd()))).name;
  const active = await runs(project);
  if (!active.length) {
    console.error(`No unit of the ${project} loop is active.`);
    return 1;
  }
  // The dispatcher first, so it starts no worker while the workers stop.
  const names = [...active.filter((name) => name === DISPATCH), ...active.filter((name) => name !== DISPATCH)];
  for (const name of names) await stopRun(project, name);
  console.log(`The loop stopped ${names.map((name) => runUnit(project, name)).join(", ")}. Nothing is flagged, and \`loop start\` goes on with the same tickets.`);
  return 0;
}

/** The comment of a ticket that `loop stop <KEY>` stopped. */
const STOPPED = "Stopped by the owner";

/**
 * Flags the ticket, then stops its worker, so the dispatcher never starts it again in between. It stays
 * Flagged until the owner unflags it.
 */
async function stopTicket(key: string, repoArg: string | undefined): Promise<number> {
  const config = load(await mainCheckout(resolve(repoArg ?? process.cwd())));
  if (!(await runs(config.name)).includes(key)) {
    console.error(`No worker of ${key} is active.`);
    return 1;
  }
  const jira = await storedJira(config);
  await jira.comment(key, STOPPED);
  await jira.flag(key);
  await stopRun(config.name, key);
  console.log(`The loop stopped ${key} and flagged it. Unflag it in Jira, and the dispatcher starts it again.`);
  return 0;
}

/** Runs the dispatcher until its unit stops. */
async function dispatch(repoArg: string | undefined): Promise<number> {
  const config = load(await mainCheckout(resolve(repoArg ?? process.cwd())));
  for (const warning of config.warnings) console.error(warning);
  const secrets = readSecrets(config.secrets);
  const pollSeconds = QUEUE_SECONDS === undefined ? config.queue.pollMinutes * 60 : Number(QUEUE_SECONDS);
  const dispatcher = new Dispatcher(config, secrets, { pollSeconds, epicSeconds: EPIC_SECONDS });
  const stop = () => {
    dispatcher.stop();
    process.exit(143);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return dispatcher.run();
}

async function run(target: Target, repoArg: string | undefined): Promise<number> {
  const config = load(await mainCheckout(resolve(repoArg ?? process.cwd())));
  for (const warning of config.warnings) console.error(warning);
  const missing = missingTools([...config.tools, ...(config.stack ? ["docker"] : [])]);
  if (missing.length) {
    console.error(`The loop refuses to run: ${missing.join(", ")} not on the PATH.`);
    return 2;
  }
  const secrets = readSecrets(config.secrets);
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

/** Takes a slot and starts the `correct` unit by hand, then returns. It refuses when the unit is active or no slot is free. */
async function correct(repoArg: string | undefined): Promise<number> {
  const config = load(await mainCheckout(resolve(repoArg ?? process.cwd())));
  await checkSecrets(config.secrets);
  const active = new Set(await runs(config.name));
  if (active.has(CORRECT)) return refuse(`\`loop correct\` is running in ${runUnit(config.name, CORRECT)}. \`loop stop\` stops it.`);
  const started = await startCorrect(config, active);
  if (!started) return refuse(`No slot is free: ${config.parallel} of ${config.parallel} are building.`);
  console.log(`\`loop correct\` runs in slot ${started.slot}, in ${started.unit}. Follow it with \`journalctl --user -fu ${started.unit}\`.`);
  return 0;
}

/** The body of the `correct` unit. */
async function workCorrect(slot: number, repoArg: string | undefined): Promise<number> {
  const config = load(await mainCheckout(resolve(repoArg ?? process.cwd())));
  for (const warning of config.warnings) console.error(warning);
  const secrets = readSecrets(config.secrets);
  await awake(config.name, CORRECT);
  process.once("SIGTERM", () => process.exit(143));
  process.once("SIGINT", () => process.exit(143));
  return runCorrect(config, secrets, slot);
}

/** Serves the page until the process stops. It changes nothing the loop reads. */
async function watch(repoArg: string | undefined): Promise<number> {
  const config = load(await mainCheckout(resolve(repoArg ?? process.cwd())));
  // With no secrets, the forecast says why it has no open work, and the rest of the page works.
  let secrets: Record<string, string> = {};
  try {
    secrets = readSecrets(config.secrets);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
  }
  // The page serves every project on the host, so it masks the env value of each secret that `bws run` gave,
  // also of one that only another repo names.
  let names = secretNames(config.secrets);
  try {
    names = [...new Set([...names, ...(await storedNames())])];
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`loop watch masks only the secrets of this repo: ${error.message}`);
  }
  const masked = Object.fromEntries(names.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])));
  let server;
  try {
    server = await serve(config.stateDir, PORT, { forecast: new Forecaster(config, secrets), secrets: masked });
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

/** The breakdown of what one ticket cost, against the run before it, or with no key the tickets merged today and the day's share of each plan window, from the logs on this host. */
async function report(key: string | undefined, against: string | undefined, json: boolean, repoArg: string | undefined): Promise<number> {
  const config = load(await mainCheckout(resolve(repoArg ?? process.cwd())));
  if (!key) {
    const day = dayReport(config.stateDir, Date.now() / 1000);
    console.log(json ? JSON.stringify(day, null, 1) : dayText(day));
    return 0;
  }
  const found = comparison(config.stateDir, key, against);
  if (!found) {
    console.error(`This host has no run of ${key}.`);
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
      options: {
        filter: { type: "string" },
        repo: { type: "string" },
        against: { type: "string" },
        json: { type: "boolean" },
        slot: { type: "string" },
      },
    });
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const [command, key, ...rest] = parsed.positionals;
  const { filter, against, json, repo, slot } = parsed.values;
  const bare = !key && !filter && !against && !json;
  const reportArgs = !filter && !rest.length && (!key || KEY.test(key)) && (!against || (key !== undefined && KEY.test(against)));
  const targetArgs = !rest.length && !against && !json && !slot && (filter ? !key : key && KEY.test(key));
  const ticketArgs = !rest.length && !against && !json && !filter && key !== undefined && KEY.test(key);
  const target = filter ? { filter } : { key: key ?? "" };
  try {
    if (command === "watch" && bare) return await watch(repo);
    if (command === "report" && reportArgs) return await report(key, against, json ?? false, repo);
    if (command === "start" && targetArgs) return refuse(GONE_START);
    if (command === "stop" && filter) return refuse(GONE_STOP);
    if (command === "stop" && bare && !slot) return await stopAll(repo);
    if (command === "stop" && ticketArgs && !slot) return await stopTicket(key!, repo);
    if (command === "dispatch" && bare && !slot) return await dispatch(repo);
    if (command === "correct" && bare && !slot) return await correct(repo);
    if (command === "run-correct" && bare && slot && /^\d+$/.test(slot)) return await workCorrect(Number(slot), repo);
    if (command === "run" && targetArgs) return await run(target, repo);
    if (command === "run-ticket" && ticketArgs && slot && /^\d+$/.test(slot)) return await run({ ticket: key!, slot: Number(slot) }, repo);
    if ((command === "start" && bare && !slot) || (command === "ticket" && ticketArgs && !slot)) {
      const checkout = sourceCheckout();
      let newCode = false;
      if (checkout) {
        const { message, updated } = await update(checkout);
        console.log(message);
        newCode = updated;
      }
      return command === "ticket" ? await ticket(key!, repo, newCode) : await start(repo, newCode);
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
