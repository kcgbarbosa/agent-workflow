// `runner install` and `runner uninstall`: the user systemd timer and the oneshot service of a repo's tick. Systemd
// does not start a oneshot service that is still running, so two ticks of one repo cannot overlap. The service loads
// the host's machine token and runs the tick under `bws run`. Every repo also shares one update pair, which pulls the
// runner's own checkout, so a merged change reaches the host.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { load } from "./config.ts";
import { run } from "./exec.ts";

const CHECKOUT = join(import.meta.dirname, "..", "..");
const RUNNER = join(CHECKOUT, "runner", "bin", "runner");
const UPDATE = "runner-update";
/** `git pull --ff-only origin main` on another branch would fast-forward that branch to main, so the pull stops first. */
const ON_MAIN = `branch=$(git symbolic-ref --quiet --short HEAD); [ "$branch" = main ] || { echo "The checkout is on \${branch:-no branch}, not main, so it is not pulled." >&2; exit 1; }`;
/** The user manager's own environment differs between a desktop login and a boot with linger. */
const ENV = ["PATH", "HOME", "LANG", "SSH_AUTH_SOCK"];

function nameOf(cwd: string): string {
  return `runner-${basename(cwd).replace(/[^\w.-]/g, "-")}`;
}

function folder(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user");
}

/** The word as a unit file holds it, in double quotes, with what systemd would expand escaped. */
function quoted(word: string): string {
  return `"${word.replace(/[\\"]/g, "\\$&").replaceAll("%", "%%").replaceAll("$", "$$$$")}"`;
}

/** The absolute path of the command, since a unit's ExecStart does not search the unit's PATH. */
function onPath(command: string): string {
  const found = (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, command)).find((path) => existsSync(path));
  if (!found) throw new Error(`${command} is not on the PATH, and the runner's service needs it.`);
  return found;
}

function environment(): string {
  return ENV.filter((each) => process.env[each] !== undefined).map((each) => `Environment=${quoted(`${each}=${process.env[each]}`)}\n`).join("");
}

function serviceOf(cwd: string, name: string, bws: string, token: string): string {
  return `[Unit]
Description=The runner's tick of ${name}

[Service]
Type=oneshot
WorkingDirectory=${cwd}
${environment()}EnvironmentFile=${token}
ExecStart=${bws} run -- ${quoted(`exec '${RUNNER.replaceAll("'", `'\\''`)}' tick`)}
`;
}

function timerOf(name: string): string {
  return `[Unit]
Description=The runner's tick of ${name}, every 2 minutes

[Timer]
OnCalendar=*:0/2

[Install]
WantedBy=timers.target
`;
}

/** Runs git itself, not `bin/runner` or `bws`, so a merge that breaks the runner's code cannot stop the pull of its fix. */
function updateServiceOf(sh: string, git: string): string {
  return `[Unit]
Description=Pull the runner's checkout, so a merged change reaches this host

[Service]
Type=oneshot
WorkingDirectory=${CHECKOUT}
${environment()}ExecStartPre=${sh} -c ${quoted(ON_MAIN)}
ExecStart=${git} pull --ff-only origin main
`;
}

/** The ticks fire together on the even minutes, so the pull fires on the odd ones and never moves the code under them as they start. */
function updateTimerOf(): string {
  return `[Unit]
Description=Pull the runner's checkout, every 2 minutes

[Timer]
OnCalendar=*:1/2

[Install]
WantedBy=timers.target
`;
}

async function systemctl(cwd: string, ...args: string[]): Promise<void> {
  await run("systemctl", ["--user", ...args], cwd);
}

export async function install(cwd: string): Promise<string> {
  load(cwd);
  const bws = onPath("bws");
  const token = join(homedir(), ".config", "bws", "token.env");
  if (!existsSync(token)) throw new Error(`This host has no Secrets Manager token file, ${token}, and the runner's service needs it.`);
  const sh = onPath("sh");
  const git = onPath("git");
  const name = nameOf(cwd);
  mkdirSync(folder(), { recursive: true });
  writeFileSync(join(folder(), `${name}.service`), serviceOf(cwd, name, bws, token));
  writeFileSync(join(folder(), `${name}.timer`), timerOf(name));
  writeFileSync(join(folder(), `${UPDATE}.service`), updateServiceOf(sh, git));
  writeFileSync(join(folder(), `${UPDATE}.timer`), updateTimerOf());
  await systemctl(cwd, "daemon-reload");
  await systemctl(cwd, "enable", "--now", `${name}.timer`);
  await systemctl(cwd, "enable", "--now", `${UPDATE}.timer`);
  return `${name}.timer is on, every 2 minutes, and ${UPDATE}.timer pulls ${CHECKOUT}`;
}

async function remove(cwd: string, name: string): Promise<void> {
  const timer = join(folder(), `${name}.timer`);
  const service = join(folder(), `${name}.service`);
  if (existsSync(timer)) await systemctl(cwd, "disable", "--now", `${name}.timer`);
  if (existsSync(service)) await systemctl(cwd, "stop", `${name}.service`);
  rmSync(timer, { force: true });
  rmSync(service, { force: true });
}

/** Whether a repo's tick timer is left, which still needs the shared update pair. */
function aTickRemains(): boolean {
  if (!existsSync(folder())) return false;
  return readdirSync(folder()).some((file) => /^runner-.*\.timer$/.test(file) && file !== `${UPDATE}.timer`);
}

export async function uninstall(cwd: string): Promise<string> {
  const name = nameOf(cwd);
  await remove(cwd, name);
  if (!aTickRemains()) await remove(cwd, UPDATE);
  await systemctl(cwd, "daemon-reload");
  return `${name} is off, and its units are gone`;
}
