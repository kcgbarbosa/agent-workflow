// The fake `bws`, the Bitwarden Secrets Manager CLI. It needs BWS_ACCESS_TOKEN, as the real one does, and fails
// without it. Its secrets are FAKE_DIR/bws.json, names to values. `secret list` prints them as the real one's
// JSON, and `run -- <command>` joins the command into one `sh -c` line, as the real one does, and runs it with
// the secrets in its env and without the token. It passes no signal on. Each call goes to FAKE_DIR/bws.jsonl.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
appendFileSync(join(process.env.FAKE_DIR, "bws.jsonl"), JSON.stringify({ args, token: process.env.BWS_ACCESS_TOKEN ?? null }) + "\n");
if (!process.env.BWS_ACCESS_TOKEN) {
  process.stderr.write("Error: Missing access token\n");
  process.exit(1);
}
const path = join(process.env.FAKE_DIR, "bws.json");
const secrets = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
if (args[0] === "secret" && args[1] === "list") {
  const list = Object.entries(secrets).map(([key, value], index) => ({ id: `id-${index}`, key, value, projectId: "loop" }));
  console.log(JSON.stringify(list, null, 2));
} else if (args[0] === "run" && args[1] === "--") {
  const env = { ...process.env, ...secrets };
  delete env.BWS_ACCESS_TOKEN;
  const child = spawn("sh", ["-c", args.slice(2).join(" ")], { env, stdio: "inherit" });
  child.on("close", (code) => process.exit(code ?? 1));
} else {
  process.stderr.write(`error: unexpected arguments ${args.join(" ")}\n`);
  process.exit(2);
}
