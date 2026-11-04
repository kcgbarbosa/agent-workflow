// `runner install` and `runner uninstall`: the user systemd timer and the oneshot service of a repo's tick. Systemd
// does not start a oneshot service that is still running, so two ticks of one repo cannot overlap. The service loads
// the host's machine token and runs the tick under `bws run`, as the loop's units do.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { load } from "./config.ts";
import { run } from "./exec.ts";

const RUNNER = join(import.meta.dirname, "..", "bin", "runner");
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

function serviceOf(cwd: string, name: string, bws: string, token: string): string {
  const env = ENV.filter((each) => process.env[each] !== undefined).map((each) => `Environment=${quoted(`${each}=${process.env[each]}`)}\n`);
  return `[Unit]
Description=The runner's tick of ${name}

[Service]
Type=oneshot
WorkingDirectory=${cwd}
${env.join("")}EnvironmentFile=${token}
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

async function systemctl(cwd: string, ...args: string[]): Promise<void> {
  await run("systemctl", ["--user", ...args], cwd);
}

export async function install(cwd: string): Promise<string> {
  load(cwd);
  const bws = onPath("bws");
  const token = join(homedir(), ".config", "bws", "token.env");
  if (!existsSync(token)) throw new Error(`This host has no Secrets Manager token file, ${token}, and the runner's service needs it.`);
  const name = nameOf(cwd);
  mkdirSync(folder(), { recursive: true });
  writeFileSync(join(folder(), `${name}.service`), serviceOf(cwd, name, bws, token));
  writeFileSync(join(folder(), `${name}.timer`), timerOf(name));
  await systemctl(cwd, "daemon-reload");
  await systemctl(cwd, "enable", "--now", `${name}.timer`);
  return `${name}.timer is on, every 2 minutes`;
}

export async function uninstall(cwd: string): Promise<string> {
  const name = nameOf(cwd);
  const timer = join(folder(), `${name}.timer`);
  const service = join(folder(), `${name}.service`);
  if (existsSync(timer)) await systemctl(cwd, "disable", "--now", `${name}.timer`);
  if (existsSync(service)) await systemctl(cwd, "stop", `${name}.service`);
  rmSync(timer, { force: true });
  rmSync(service, { force: true });
  await systemctl(cwd, "daemon-reload");
  return `${name} is off, and its units are gone`;
}
