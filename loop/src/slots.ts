// A ticket's slot gives its stack its ports. A worker's slot is a folder of the state folder, `slots/<n>/`, which
// `mkdir` takes, so two launchers never take the same one, and which holds the ticket's key and its unit. The
// worker frees it at its end, and a launcher, the dispatcher or `loop ticket`, takes back a slot whose worker's
// unit is gone. The take back renames the folder to a name of its own first, so of two launchers that find the
// same slot left behind, one takes it back.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./spawn.ts";

/** Slot 0 is the main checkout and slot 1, the old Epic branch's, stays free, so the tickets take 2 and up. */
export const FIRST_SLOT = 2;

/** The slots past `parallel + 1` a ticket takes when another Compose project holds the ports of a slot. */
export const SPARE_SLOTS = 8;

/** A host port that `docker ps` lists as published, alone or as a range. */
const PUBLISHED_PORT = /:(\d+)(?:-(\d+))?->/g;

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

/**
 * Takes a slot for the ticket, and returns it, or null when `parallel` slots are held or none is free. It takes
 * the first free one of slots 2 to `parallel + 1`, then of the spare slots, that `usable` accepts, which is where
 * the launcher puts the `docker ps` rule. `active` is the run names of the units that run, and a slot older than
 * NEW_SECONDS whose ticket has none is free.
 */
export function takeSlot(stateDir: string, key: string, unit: string, parallel: number, active: Set<string>, usable: (slot: number) => boolean = () => true): number | null {
  mkdirSync(join(stateDir, SLOTS), { recursive: true });
  const last = FIRST_SLOT + parallel + SPARE_SLOTS;
  const slots = Array.from({ length: last - FIRST_SLOT }, (_, at) => FIRST_SLOT + at);
  if (slots.filter((slot) => held(folderOf(stateDir, slot), active)).length >= parallel) return null;
  for (const slot of slots) {
    if (!usable(slot)) continue;
    const folder = folderOf(stateDir, slot);
    for (let tries = 0; tries < 2; tries++) {
      try {
        mkdirSync(folder);
        writeFileSync(join(folder, "key"), key);
        writeFileSync(join(folder, "unit"), unit);
        return slot;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (held(folder, active)) break;
      if (ageOf(folder) !== null) takeBack(folder);
    }
  }
  return null;
}

/** Frees each slot whose ticket's unit is no longer active, once it is older than NEW_SECONDS. */
export function freeLeftSlots(stateDir: string, active: Set<string>): void {
  let names: string[];
  try {
    names = readdirSync(join(stateDir, SLOTS));
  } catch {
    return;
  }
  for (const name of names) {
    const folder = join(stateDir, SLOTS, name);
    if (/^\d+$/.test(name) && ageOf(folder) !== null && !held(folder, active)) takeBack(folder);
  }
}

/** Whether a launcher just took the slot, or its ticket's unit runs. */
function held(folder: string, active: Set<string>): boolean {
  const age = ageOf(folder);
  if (age === null) return false;
  const holder = holderOf(folder);
  return age < NEW_SECONDS || (holder !== null && active.has(holder));
}

/**
 * The `docker ps` rule of a start: a slot is usable when no other Compose project holds a port of its stack. A
 * repo with no stack can use each slot.
 */
export async function portsFree(stateDir: string, project: string, stack: Stack | null): Promise<(slot: number) => boolean> {
  if (!stack) return () => true;
  const held = await heldPorts(stateDir, project);
  return (slot) => !Object.values(slotPorts(stack, slot)).some((port) => held.has(port));
}

/** The Compose project of a ticket's stack. Compose accepts lowercase project names only. */
export function composeProject(name: string, key: string): string {
  return `${name}-${key.toLowerCase()}`;
}

type Stack = { ports: Record<string, number>; portStep: number };

/** The host ports of each `[stack]` port in the slot. */
function slotPorts(stack: Stack, slot: number): Record<string, number> {
  return Object.fromEntries(Object.entries(stack.ports).map(([name, base]) => [name, base + stack.portStep * slot]));
}

/** The host ports that the running containers of other Compose projects publish, with the container of each. */
export async function heldPorts(cwd: string, project: string): Promise<Map<number, string>> {
  const format = '{{.Label "com.docker.compose.project"}}\t{{.Names}}\t{{.Ports}}';
  const listed = await run("docker", ["ps", "--format", format], { cwd, seconds: 60 });
  const found = new Map<number, string>();
  for (const line of listed.code === 0 ? listed.stdout.split("\n") : []) {
    const [owner, container, published] = line.split("\t");
    if (!container || owner === project) continue;
    for (const [, low, high] of (published ?? "").matchAll(PUBLISHED_PORT)) {
      for (let port = Number(low); port <= Number(high ?? low); port++) found.set(port, container);
    }
  }
  return found;
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
