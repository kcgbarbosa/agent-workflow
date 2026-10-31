// The systemd user units of the loop: one for each run, and one for the watch page. A unit outlives the agent
// or shell that starts it, and systemd knows whether the run is alive. Each unit loads the host's machine token
// and runs the loop under `bws run`, which gives it the secrets as env vars.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenFile, underBws } from "./secrets.ts";
import { run, spawnGroup } from "./spawn.ts";
import { WATCH_PORT } from "./watch.ts";

export class UnitError extends Error {}

export const WATCH_UNIT = `loop-watch-${WATCH_PORT}.service`;
/** The user manager's own environment differs between a desktop login and a boot with linger. */
const ENV = ["PATH", "HOME", "LANG", "SSH_AUTH_SOCK"];
/** `bws run` is the unit's main process and passes no signal on, so the SIGTERM of a stop goes to every process
 * of the unit, the run among them, which stops its agents. Systemd kills what is left after 10 minutes.
 */
const RUN_PROPERTIES = ["KillMode=control-group", "TimeoutStopSec=10min"];
const WATCH_PROPERTIES = ["Restart=always", "RestartSec=5"];
const RUN_NAME = String.raw`[A-Z][A-Z0-9]*-\d+|filter-[0-9a-f]{8}`;
const LOOP = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "loop");

export function runUnit(project: string, name: string): string {
  return `loop-${project}-${name}.service`;
}

/** The run names of the project's run units that systemd has loaded. `--collect` unloads a run when it ends,
 * also when it fails, so a failed run never blocks the next start.
 */
export async function runs(project: string): Promise<string[]> {
  const listed = await systemctl(["list-units", "--plain", "--no-legend", `loop-${project}-*`]);
  const unit = new RegExp(`^loop-${project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(${RUN_NAME})\\.service$`);
  return listed
    .split("\n")
    .map((line) => unit.exec(line.split(" ")[0] ?? "")?.[1])
    .filter((name): name is string => Boolean(name));
}

/** Starts `loop run` with these arguments in its unit, and returns the unit once it is active. */
export async function startRun(repo: string, project: string, name: string, args: string[]): Promise<string> {
  const unit = runUnit(project, name);
  await inUnit(unit, repo, [LOOP, "run", ...args, "--repo", repo], RUN_PROPERTIES);
  return unit;
}

/** Stops the run's unit, and returns once the run has ended. False when no run of that name is active. */
export async function stopRun(project: string, name: string): Promise<boolean> {
  if (!(await runs(project)).includes(name)) return false;
  await systemctl(["stop", runUnit(project, name)]);
  return true;
}

/** Starts the watch page when it is not active, or restarts it on the loop's new code. */
export async function startWatch(repo: string, restart: boolean): Promise<void> {
  if ((await systemctl(["is-active", WATCH_UNIT], false)).trim() === "active") {
    if (restart) await systemctl(["restart", WATCH_UNIT]);
    return;
  }
  await inUnit(WATCH_UNIT, repo, [LOOP, "watch", "--repo", repo], WATCH_PROPERTIES);
}

async function inUnit(unit: string, cwd: string, command: string[], properties: string[]): Promise<void> {
  const env = ENV.filter((name) => process.env[name] !== undefined).map((name) => `--setenv=${name}=${process.env[name]}`);
  const options = [`EnvironmentFile=${tokenFile()}`, ...properties].map((item) => `--property=${item}`);
  const args = ["--user", "--collect", "--quiet", "--service-type=exec", `--unit=${unit}`, `--working-directory=${cwd}`];
  const done = await run("systemd-run", [...args, ...env, ...options, ...underBws(command)], { seconds: 60 });
  if (done.code === 127) throw new UnitError("systemd-run does not run. The loop needs systemd.");
  if (done.code !== 0) throw new UnitError(`systemd-run cannot start ${unit}: ${done.stderr.trim()}`);
}

async function systemctl(args: string[], check = true): Promise<string> {
  const done = await run("systemctl", ["--user", ...args], { seconds: 15 * 60 });
  if (done.code === 127) throw new UnitError("systemctl does not run. The loop needs systemd.");
  if (check && done.code !== 0) throw new UnitError(`systemctl ${args.join(" ")}: ${done.stderr.trim()}`);
  return done.stdout;
}

/** Holds off sleep until this process ends. The inhibitor runs beside the run, so the run stays the process
 * that `bws run` started.
 */
export async function awake(project: string, name: string): Promise<void> {
  const child = spawnGroup("systemd-inhibit", [
    "--what=sleep:idle",
    `--who=${project}-loop`,
    `--why=The loop builds ${name}`,
    "--mode=block",
    "tail",
    `--pid=${process.pid}`,
    "-f",
    "/dev/null",
  ]);
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  // An inhibitor that holds runs until the run ends, so one that ends at once could not hold off sleep.
  const ended = await new Promise<boolean>((done) => {
    const timer = setTimeout(() => done(false), 1000);
    child.once("close", () => (clearTimeout(timer), done(true)));
    child.once("error", (error) => ((stderr = error.message), clearTimeout(timer), done(true)));
  });
  if (ended) throw new UnitError(`\`systemd-inhibit\` cannot hold off sleep: ${stderr.trim()}`);
}
