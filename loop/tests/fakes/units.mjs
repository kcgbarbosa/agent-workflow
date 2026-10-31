// The units of the fake `systemd-run`, which the fake `systemctl` reads too. FAKE_DIR/units/<unit>.json keeps a
// unit with its pid. A unit is loaded while a process of its group lives, as `--collect` unloads a unit that
// ended, also a failed one. A unit with no pid, as the fake `loop watch` unit, stays loaded.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const units = join(process.env.FAKE_DIR, "units");

export function record(tool, args) {
  appendFileSync(join(process.env.FAKE_DIR, "systemd.jsonl"), JSON.stringify({ tool, args }) + "\n");
}

export function names() {
  mkdirSync(units, { recursive: true });
  return readdirSync(units).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).sort();
}

export function pidOf(unit) {
  return JSON.parse(readFileSync(join(units, `${unit}.json`), "utf8")).pid;
}

export function alive(unit) {
  if (!existsSync(join(units, `${unit}.json`))) return false;
  const pid = pidOf(unit);
  if (pid === null) return true;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}
