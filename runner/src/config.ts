// The repo's `runner.toml`. A key it leaves out takes its default, and a key the runner does not know is refused.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";

export class ConfigError extends Error {}

export type Config = {
  /** The Jira component of this repo's tickets. */
  component: string;
  jiraUrl: string;
  mainBranch: string;
  /** Active turns plus stuck tickets at which no new thread starts. */
  limit: number;
  fixAttempts: number;
  quietMinutes: number;
  /** The T3 provider instance and model of each thread. */
  provider: string;
  model: string;
  /** A line this repo adds to the first message of each thread. */
  firstMessage: string;
};

const FILE = "runner.toml";
const KEYS = ["component", "jira_url", "main_branch", "limit", "fix_attempts", "quiet_minutes", "provider", "model", "first_message"];

export function load(repo: string): Config {
  const raw = parsed(join(repo, FILE));
  const unknown = Object.keys(raw).filter((key) => !KEYS.includes(key));
  if (unknown.length) throw new ConfigError(`${FILE}: unknown key ${unknown.join(", ")}`);
  const text = (key: string, fallback?: string): string => {
    const value = raw[key] ?? fallback;
    if (typeof value !== "string") throw new ConfigError(`${FILE}: ${key} needs a string`);
    return value;
  };
  const count = (key: string, fallback: number): number => {
    const value = raw[key] ?? fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new ConfigError(`${FILE}: ${key} needs a whole number, 0 or more`);
    return value;
  };
  return {
    component: text("component"),
    jiraUrl: text("jira_url"),
    mainBranch: text("main_branch", "main"),
    limit: count("limit", 3),
    fixAttempts: count("fix_attempts", 3),
    quietMinutes: count("quiet_minutes", 60),
    provider: text("provider", "claudeAgent"),
    model: text("model", "claude-opus-5-5"),
    firstMessage: text("first_message", ""),
  };
}

function parsed(path: string): Record<string, unknown> {
  try {
    return parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`${FILE}: ${(error as Error).message}`);
  }
}
