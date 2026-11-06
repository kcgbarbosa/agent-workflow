// One count of writes across the fakes, in this process and in the fake commands, so a test can fail the write of a number.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Counts this write, and returns whether it is the one to fail. */
export function failsWrite(dir: string): boolean {
  const file = join(dir, "fail-write.json");
  if (!existsSync(file)) return false;
  const count = JSON.parse(readFileSync(file, "utf8"));
  count.writes++;
  writeFileSync(file, JSON.stringify(count));
  return count.writes === count.number;
}
