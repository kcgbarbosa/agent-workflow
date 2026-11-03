// A ticket's slot gives its stack its ports. A worker's slot is a folder of the state folder, `slots/<n>/`, which
// `mkdir` takes, so two launchers never take the same one, and which holds the ticket's key. The worker frees it
// at its end, and a launcher takes back a slot whose worker's unit is gone.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Slot 0 is the main checkout and slot 1, the old Epic branch's, stays free, so the tickets take 2 and up. */
export const FIRST_SLOT = 2;

const SLOTS = "slots";

/** A slot a launcher took that still has no key is held this long before it counts as left behind. */
const UNNAMED_SECONDS = 60;

function folderOf(stateDir: string, slot: number): string {
  return join(stateDir, SLOTS, String(slot));
}

/** The key of the ticket that holds the slot, or null when the folder holds none yet. */
function holderOf(folder: string): string | null {
  try {
    return readFileSync(join(folder, "key"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Takes the first free one of the `parallel` slots for the ticket, and returns it, or null when each one is held.
 * `active` is the run names of the units that run, and a slot whose ticket has none is free.
 */
export function takeSlot(stateDir: string, key: string, parallel: number, active: Set<string>): number | null {
  mkdirSync(join(stateDir, SLOTS), { recursive: true });
  for (let slot = FIRST_SLOT; slot < FIRST_SLOT + parallel; slot++) {
    const folder = folderOf(stateDir, slot);
    for (let tries = 0; tries < 2; tries++) {
      try {
        mkdirSync(folder);
        writeFileSync(join(folder, "key"), key);
        return slot;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const holder = holderOf(folder);
      const age = Date.now() / 1000 - (statSync(folder, { throwIfNoEntry: false })?.mtimeMs ?? 0) / 1000;
      if (holder ? active.has(holder) : age < UNNAMED_SECONDS) break;
      rmSync(folder, { recursive: true, force: true });
    }
  }
  return null;
}

/** Frees the slot, when it still holds this ticket. */
export function freeSlot(stateDir: string, slot: number, key: string): void {
  const folder = folderOf(stateDir, slot);
  if (holderOf(folder) === key) rmSync(folder, { recursive: true, force: true });
}
