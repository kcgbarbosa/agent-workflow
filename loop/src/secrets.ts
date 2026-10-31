// The loop's secrets live in Bitwarden Secrets Manager. The run unit and the watch unit load the host's machine
// token from TOKEN_FILE and start the loop under `bws run`, which puts each secret in the env. No secret is
// kept in a file on the host but the token.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError, REQUIRED_SECRETS } from "./config.ts";
import { run } from "./spawn.ts";

/** A `bws` call that has not answered by then has failed. */
const QUIET_SECONDS = 120;
const SETUP = "`/setup-loop` sets it up.";

/** The host's machine token, as `BWS_ACCESS_TOKEN=<token>`, mode 600. */
export function tokenFile(): string {
  return join(homedir(), ".config", "bws", "token.env");
}

/** The env var names of the secrets a run needs: those of the loop, and those of `loop.toml`. */
export function secretNames(names: string[]): string[] {
  return [...new Set([...REQUIRED_SECRETS, ...names])];
}

/** The secrets a run gets, from the env that `bws run` gave it. It refuses an env that lacks one. */
export function readSecrets(names: string[]): Record<string, string> {
  const wanted = secretNames(names);
  const missing = wanted.filter((name) => !process.env[name]);
  if (missing.length) throw new ConfigError(`The loop has no value for ${missing.join(", ")} in its env. It runs under \`bws run\`, which ${SETUP}`);
  return Object.fromEntries(wanted.map((name) => [name, process.env[name]!]));
}

/** Refuses, with one line, a host with no token file, or a store that lacks a secret the run needs. */
export async function checkSecrets(names: string[]): Promise<void> {
  const path = tokenFile();
  if (!existsSync(path)) throw new ConfigError(`This host has no Secrets Manager token file, ${path}. ${SETUP}`);
  const token = /^\s*BWS_ACCESS_TOKEN=["']?([^"'\n]*)["']?\s*$/m.exec(readFileSync(path, "utf8"))?.[1];
  if (!token) throw new ConfigError(`${path} has no BWS_ACCESS_TOKEN. ${SETUP}`);
  const listed = await run("bws", ["secret", "list", "--output", "json"], { seconds: QUIET_SECONDS, env: { ...process.env, BWS_ACCESS_TOKEN: token } });
  if (listed.code === 127) throw new ConfigError(`bws is not on the PATH. ${SETUP}`);
  if (listed.code !== 0) throw new ConfigError(`bws cannot list the secrets: ${listed.stderr.trim().split("\n")[0]}`);
  let keys: Set<string>;
  try {
    keys = new Set((JSON.parse(listed.stdout) as { key: string }[]).map((secret) => secret.key));
  } catch {
    throw new ConfigError("bws listed the secrets in a form the loop does not read.");
  }
  const missing = secretNames(names).filter((name) => !keys.has(name));
  if (missing.length) throw new ConfigError(`Secrets Manager has no secret ${missing.join(", ")}. ${SETUP}`);
}

/** The command line that runs the command under `bws run`. `bws` joins its arguments into one `sh -c` line,
 * so each word is quoted, and `exec` makes the command the shell's own process.
 */
export function underBws(command: string[]): string[] {
  return ["bws", "run", "--", `exec ${command.map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(" ")}`];
}
