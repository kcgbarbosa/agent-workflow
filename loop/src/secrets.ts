// `loop secrets` copies the secrets of `loop.toml [secrets]` from Bitwarden to a file that only this user can
// read, so a run needs no unlock. The file is the only place a run reads them from.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, ConfigError, REQUIRED_SECRETS } from "./config.ts";
import { run } from "./spawn.ts";

export const SECRETS_FILE = "secrets.json";
export const NO_SECRETS = "Run `export BW_SESSION=$(bw unlock --raw)`, then `loop secrets`.";
/** A `bw` call that has not answered by then has failed. */
const QUIET_SECONDS = 120;

export function secretsPath(stateDir: string): string {
  return join(stateDir, SECRETS_FILE);
}

/** The secrets a run gets. It refuses a file that lacks one the run needs. */
export function readSecrets(config: Config): Record<string, string> {
  const path = secretsPath(config.stateDir);
  if (!existsSync(path)) throw new ConfigError(`This host has no secrets file. ${NO_SECRETS}`);
  const secrets = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  const missing = [...new Set([...REQUIRED_SECRETS, ...Object.keys(config.secrets)])].filter((name) => !secrets[name]);
  if (missing.length) throw new ConfigError(`${path} has no value for ${missing.join(", ")}. ${NO_SECRETS}`);
  return secrets;
}

export async function copySecrets(config: Config): Promise<string> {
  const status = await run("bw", ["status"], { seconds: QUIET_SECONDS });
  if (status.code !== 0 || !status.stdout.replaceAll(" ", "").includes('"status":"unlocked"')) {
    throw new ConfigError("Bitwarden is locked. Run `export BW_SESSION=$(bw unlock --raw)` first.");
  }
  await run("bw", ["sync"], { seconds: QUIET_SECONDS });
  const secrets: Record<string, string> = {};
  const missing: string[] = [];
  for (const [env, secret] of Object.entries(config.secrets)) {
    const found = await run("bw", ["get", secret.field, secret.item], { seconds: QUIET_SECONDS });
    if (found.code === 0 && found.stdout.trim()) secrets[env] = found.stdout.trim();
    else missing.push(`${secret.item} (${secret.field})`);
  }
  if (missing.length) throw new ConfigError(`Bitwarden has no value for ${missing.join(", ")}.`);
  const path = secretsPath(config.stateDir);
  mkdirSync(config.stateDir, { recursive: true });
  writeFileSync(path, JSON.stringify(secrets), { mode: 0o600 });
  // The mode of writeFileSync applies to a new file only.
  chmodSync(path, 0o600);
  return `The ${config.name} secrets are in ${path}. A run needs no unlock now.`;
}
