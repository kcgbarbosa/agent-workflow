// The fake `systemd-run --user`. It starts the command as a process of its own and returns, as
// `--service-type=exec` does once the command runs. The process gets the caller's environment, the variables of
// an `EnvironmentFile=`, which must exist, and the `--setenv` variables, and writes its output to
// FAKE_DIR/units/<unit>.log. It leads a process group of its own, which stands for the unit's control group. A
// `loop watch` unit starts no process and stays loaded. Each call goes to FAKE_DIR/systemd.jsonl.
import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
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
if (/\/bin\/loop' 'watch'/.test(args.join(" "))) {
  writeFileSync(state, JSON.stringify({ pid: null, args }));
  process.exit(0);
}
const env = { ...process.env };
for (const option of options.filter((item) => item.startsWith("--property=EnvironmentFile="))) {
  const path = option.slice("--property=EnvironmentFile=".length);
  if (!existsSync(path)) {
    process.stderr.write(`Job for ${unit} failed: Failed to load environment files: No such file or directory\n`);
    process.exit(1);
  }
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const found = /^\s*([A-Za-z_][A-Za-z0-9_]*)=["']?([^"']*)["']?\s*$/.exec(line);
    if (found) env[found[1]] = found[2];
  }
}
for (const option of options.filter((item) => item.startsWith("--setenv="))) {
  const [name, ...rest] = option.slice("--setenv=".length).split("=");
  env[name] = rest.join("=");
}
const log = openSync(join(units, `${unit}.log`), "a");
const child = spawn(args[0], args.slice(1), { cwd: value("--working-directory"), env, stdio: ["ignore", log, log], detached: true });
writeFileSync(state, JSON.stringify({ pid: child.pid, args }));
child.unref();
