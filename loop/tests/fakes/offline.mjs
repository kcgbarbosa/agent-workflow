// Loaded into every Node process of a scenario through NODE_OPTIONS. A connection to any host but this
// one is refused and recorded, so a test proves the scenario suite runs with no network.
import { appendFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

const LOCAL = new Set(["127.0.0.1", "localhost", "::1"]);
const connect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function (...args) {
  let options = args[0];
  if (Array.isArray(options)) options = options[0];
  let host = "localhost";
  if (typeof options === "object" && options !== null) {
    if (options.path) return connect.apply(this, args);
    host = options.host ?? "localhost";
  } else if (typeof args[1] === "string") {
    host = args[1];
  }
  if (!LOCAL.has(host)) {
    appendFileSync(join(process.env.FAKE_DIR, "network.jsonl"), JSON.stringify({ host, argv: process.argv.slice(1, 2) }) + "\n");
    throw new Error(`The scenario suite runs offline, and ${host} is not this host.`);
  }
  return connect.apply(this, args);
};
