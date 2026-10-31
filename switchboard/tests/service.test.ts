// The switchboard as the unit runs it: a process of its own, with the fake `claude` on its PATH.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FAKE_BIN, TOKEN, answer, ask, post, said } from "./http.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

let dir: string;
let child: ChildProcess | null;
let stdout: string;
let stderr: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "switchboard-"));
  child = null;
  stdout = stderr = "";
});

afterEach(async () => {
  if (child && child.exitCode === null) {
    const closed = new Promise((done) => child!.once("close", done));
    child.kill("SIGKILL");
    await closed;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Starts the switchboard on a free port, and returns its base URL once it serves. */
async function start(): Promise<string> {
  const args = ["--disable-warning=ExperimentalWarning", CLI, "--port", "0", "--cwd", dir, "--state", join(dir, "session")];
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${FAKE_BIN}:${process.env.PATH}`, SWITCHBOARD_TOKEN: TOKEN };
  delete env.SWITCHBOARD_MODEL;
  const started = spawn(process.execPath, args, { env });
  child = started;
  started.stdout.on("data", (data: Buffer) => (stdout += data));
  started.stderr.on("data", (data: Buffer) => (stderr += data));
  return new Promise((done, fail) => {
    started.stdout.on("data", () => {
      const found = /switchboard on (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
      if (found) done(found[1]!);
    });
    started.once("close", (code) => fail(new Error(`switchboard exited with ${code}: ${stdout}${stderr}`)));
  });
}

async function until(text: string): Promise<void> {
  while (!stdout.includes(text)) await new Promise((done) => setTimeout(done, 20));
}

function exited(): Promise<number | null> {
  return new Promise((done) => {
    if (child!.exitCode !== null) done(child!.exitCode);
    else child!.once("exit", (code) => done(code));
  });
}

test("a request that hangs up mid-answer leaves no error in the output", async () => {
  const base = await start();
  // ElevenLabs hangs up on a slow request after its first bytes, and sends it again.
  await new Promise<void>((done, fail) => {
    const sent = request(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    });
    sent.once("response", (response) => response.once("data", () => (sent.destroy(), done())));
    sent.once("error", fail);
    sent.end(JSON.stringify(ask("slow hangup")));
  });
  // The retry joins the ask, so it ends after the turn the first request hung up on.
  expect(await answer(base, "slow hangup")).toContain("echo slow hangup");
  await until("hung up");
  child!.kill("SIGTERM");
  expect(await exited()).toBe(0);
  expect(stderr).toBe("");
  expect(stdout).not.toMatch(/error/i);
});

test("a SIGTERM during an ask answers new requests with 503, and exits after the ask ends", async () => {
  const base = await start();
  const running = await post(base, ask("slow drain"));
  const reader = running.body!.getReader();
  // The first empty chunk goes out before the ask starts.
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain('"role":"assistant"');
  child!.kill("SIGTERM");
  await until("switchboard stops");
  expect((await post(base, ask("hi"))).status).toBe(503);
  expect(child!.exitCode).toBe(null);
  let rest = "";
  for (let part = await reader.read(); !part.done; part = await reader.read()) rest += new TextDecoder().decode(part.value);
  expect(said(first + rest)).toBe("One moment... echo slow drain");
  expect(await exited()).toBe(0);
});
