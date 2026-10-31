// `node src/cli.ts`: starts the session and serves it. README.md is how it is set up.

import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { serve } from "./server.ts";
import { Session, command } from "./session.ts";

// How long a stop waits for the asks that run. `switchboard.service` gives it longer with `TimeoutStopSec`.
const GRACE = 60_000;

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "127.0.0.1" },
    // The Loop watch page has 8790, and the tailnet serves it on 8443, so the switchboard keeps clear of both.
    port: { type: "string", default: "8796" },
    cwd: { type: "string", default: join(homedir(), "dev", "agent-workflow") },
    state: { type: "string", default: join(homedir(), ".local", "state", "switchboard", "session") },
    model: { type: "string", default: process.env.SWITCHBOARD_MODEL },
  },
});

const token = process.env.SWITCHBOARD_TOKEN ?? "";
if (token.length < 32) {
  console.error("Set SWITCHBOARD_TOKEN to a secret of 32 characters or more. See switchboard/README.md.");
  process.exit(1);
}
const session = new Session(command(values.model || undefined), values.cwd, values.state);
session.start();
const serving = await serve(session, token, values.host, Number(values.port));
console.log(`switchboard on http://${values.host}:${serving.port}`);

// A stop or a restart refuses new requests, and exits when the asks that run have ended, so no call drops.
process.once("SIGTERM", async () => {
  console.log("switchboard stops when the asks that run end");
  const grace = new Promise((done) => setTimeout(done, GRACE).unref());
  await Promise.race([serving.drain(), grace]);
  serving.server.closeAllConnections();
  serving.server.close();
  await session.stop();
  process.exit(0);
});
