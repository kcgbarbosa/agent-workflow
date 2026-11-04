// Runs a command to its end, with a limit, so a CLI that hangs cannot hold a tick open.
import { execFile } from "node:child_process";

const LIMIT_MS = 120_000;
const MAX_OUTPUT = 64 * 1024 * 1024;

export function run(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: LIMIT_MS, maxBuffer: MAX_OUTPUT }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} ${args.join(" ").slice(0, 80)}: ${(stderr || error.message).trim()}`));
      else resolve(stdout);
    });
  });
}
