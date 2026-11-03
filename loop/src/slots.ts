// A ticket's slot gives its stack its ports. A worker's slot is a folder of the state folder, `slots/<n>/`, which
// `mkdir` takes, so two launchers never take the same one, and which holds the ticket's key. The worker frees it
// at its end, and a launcher takes back a slot whose worker's unit is gone. The take back renames the folder to
// a name of its own first, so of two launchers that find the same slot left behind, one takes it back.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Slot 0 is the main checkout and slot 1, the old Epic branch's, stays free, so the tickets take 2 and up. */
export const FIRST_SLOT = 2;

const SLOTS = "slots";

/** A slot a launcher just took is held this long, whatever it holds, since its worker's unit has not started yet. */
const NEW_SECONDS = 60;

function folderOf(stateDir: string, slot: number): string {
  return join(stateDir, SLOTS, String(slot));
}

/** How long ago the folder was made, in seconds, or null when it is gone. */
function ageOf(folder: string): number | null {
  const stat = statSync(folder, { throwIfNoEntry: false });
  return stat ? (Date.now() - stat.mtimeMs) / 1000 : null;
}

/** The key of the ticket that holds the slot, or null when the folder holds none yet. */
function holderOf(folder: string): string | null {
  try {
    return readFileSync(join(folder, "key"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** The keys of the tickets that hold a slot. */
export function slotHolders(stateDir: string): Set<string> {
  let names: string[];
  try {
    names = readdirSync(join(stateDir, SLOTS));
  } catch {
    return new Set();
  }
  return new Set(names.flatMap((name) => (/^\d+$/.test(name) ? [holderOf(join(stateDir, SLOTS, name))] : [])).filter((key) => key !== null));
}

/**
 * Takes the first free one of the `parallel` slots for the ticket, and returns it, or null when each one is held.
 * `active` is the run names of the units that run, and a slot older than NEW_SECONDS whose ticket has none is free.
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
      const age = ageOf(folder);
      if (age !== null && (age < NEW_SECONDS || (holder !== null && active.has(holder)))) break;
      if (age !== null) takeBack(folder);
    }
  }
  return null;
}

/**
 * Moves a left-behind slot folder out of the way under a name of its own, which only one launcher's rename gets,
 * and removes it. A folder that is new by then, which another launcher made after this one looked, goes back.
 */
function takeBack(folder: string): void {
  const aside = `${folder}.gone-${process.pid}-${Date.now()}`;
  try {
    renameSync(folder, aside);
  } catch (error) {
    // Another launcher took it back first.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if ((ageOf(aside) ?? Infinity) < NEW_SECONDS) {
    try {
      renameSync(aside, folder);
      return;
    } catch {
      // A third launcher made the slot again, and the one moved aside goes.
    }
  }
  rmSync(aside, { recursive: true, force: true });
}

/** Frees the slot, when it still holds this ticket. */
export function freeSlot(stateDir: string, slot: number, key: string): void {
  const folder = folderOf(stateDir, slot);
  if (holderOf(folder) === key) rmSync(folder, { recursive: true, force: true });
}
