// The switchboard over real HTTP, the way ElevenLabs calls it, against the fake `claude`.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { serve, type Serving } from "../src/server.ts";
import { FILLER, STILL, Session, TIMINGS, command, type Timings } from "../src/session.ts";
import { FAKE, TOKEN, answer, ask, post } from "./http.ts";

let dir: string;
let session: Session | null;
let serving: Serving | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "switchboard-"));
  session = serving = null;
});

afterEach(async () => {
  serving?.server.closeAllConnections();
  serving?.server.close();
  await session?.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function start(timings: Partial<Timings> = {}): Promise<string> {
  const line = [process.execPath, "--disable-warning=ExperimentalWarning", FAKE];
  session = new Session(line, dir, join(dir, "state", "session"), { ...TIMINGS, ...timings });
  session.start();
  serving = await serve(session, TOKEN, "127.0.0.1", 0);
  return `http://127.0.0.1:${serving.port}`;
}

test("the last thing said goes in, and the answer streams back without markup", async () => {
  const base = await start();
  expect(await answer(base, "how is pitchridge")).toBe("echo how is pitchridge");
  expect(readFileSync(join(dir, "received.log"), "utf8")).toBe("[voice:1] how is pitchridge\n");
});

test("a reply that arrived between turns is said first", async () => {
  const base = await start();
  expect(await answer(base, "hello inbound")).toBe("PITCH-16 says the tests pass. echo hello inbound");
});

test("a slow answer starts with the filler", async () => {
  const base = await start({ first: 500 });
  expect(await answer(base, "slow one")).toBe(`${FILLER} echo slow one`);
});

test("a long turn keeps saying it is still working", async () => {
  const base = await start({ first: 200, every: 600 });
  const heard = await answer(base, "slow one");
  expect(heard.startsWith(`${FILLER} ${STILL}`)).toBe(true);
  expect(heard.endsWith("echo slow one")).toBe(true);
});

test("three retries of the same words make one turn, and all hear the answer", async () => {
  // ElevenLabs sends the same request again when the first is slow, sometimes two at once.
  const base = await start();
  const answers = await Promise.all([1, 2, 3].map(() => answer(base, "slow status")));
  expect(readFileSync(join(dir, "received.log"), "utf8")).toBe("[voice:1] slow status\n");
  for (const heard of answers) expect(heard.endsWith("echo slow status")).toBe(true);
});

test("the session ID is kept, so a restart resumes", async () => {
  const base = await start();
  await answer(base, "hi");
  expect(readFileSync(join(dir, "state", "session"), "utf8")).toBe("fake-session");
});

test("a request without the token is refused, and the status needs the token", async () => {
  const base = await start();
  expect((await post(base, ask("hi"), "wrong")).status).toBe(401);
  const health = await fetch(`${base}/health`);
  expect(await health.json()).toEqual({ ok: true });
  expect((await fetch(`${base}/api/status`)).status).toBe(401);
  await answer(base, "hi");
  const status = await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const body = await status.json();
  expect(body.session).toBe(true);
  expect(body.last_call).toBeGreaterThan(Date.now() / 1000 - 60);
  expect(body.waiting).toBe(0);
});

test("the session starts in bypass mode, as `switchboard`, with a prompt that sends through `t3 thread send`", () => {
  const line = command(undefined);
  expect(line.slice(0, 2)).toEqual(["claude", "-p"]);
  expect(line).toContain("--replay-user-messages");
  expect(line[line.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  expect(line[line.indexOf("--name") + 1]).toBe("switchboard");
  expect(line[line.indexOf("--append-system-prompt") + 1]).toContain("t3 thread send");
  expect(line).not.toContain("--model");
  expect(command("claude-opus-5-5").slice(-2)).toEqual(["--model", "claude-opus-5-5"]);
});
