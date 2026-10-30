// The fake `systemd-run --user`. It starts the command as a process of its own and returns, as
// `--service-type=exec` does once the command runs. The process gets the caller's environment and the
// `--setenv` variables, and writes its output to FAKE_DIR/units/<unit>.log. A `loop watch` unit starts no
// process and stays loaded. Each call goes to FAKE_DIR/systemd.jsonl.
import { spawn } from "node:child_process";
import { openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alive, record, units } from "./units.mjs";

const args = process.argv.slice(2);
record("systemd-run", args);
const options = [];
while (args.length && args[0].startsWith("-")) options.push(args.shift());
const value = (name) => options.find((option) => option.startsWith(`${name}=`))?.slice(name.length + 1);
const unit = value("--unit");
if (alive(unit)) {
  process.stderr.write(`Failed to start transient service unit: Unit ${unit} was already loaded.\n`);
  process.exit(1);
}
const state = join(units, `${unit}.json`);
if (args[1] === "watch") {
  writeFileSync(state, JSON.stringify({ pid: null, args }));
  process.exit(0);
}
const env = { ...process.env };
for (const option of options.filter((item) => item.startsWith("--setenv="))) {
  const [name, ...rest] = option.slice("--setenv=".length).split("=");
  env[name] = rest.join("=");
}
const log = openSync(join(units, `${unit}.log`), "a");
const child = spawn(args[0], args.slice(1), { cwd: value("--working-directory"), env, stdio: ["ignore", log, log], detached: true });
writeFileSync(state, JSON.stringify({ pid: child.pid, args }));
child.unref();
