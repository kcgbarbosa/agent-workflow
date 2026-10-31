// The fake `systemctl --user`, over the units of the fake `systemd-run`. `list-units` lists the loaded units
// that match the pattern, `is-active` answers for each unit named, `stop` sends SIGTERM to the unit's process
// group and waits for it to end, as KillMode=control-group does, and `restart` does nothing. Each call goes to
// FAKE_DIR/systemd.jsonl.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { alive, names, pidOf, record, units } from "./units.mjs";

const args = process.argv.slice(3);
record("systemctl", args);
const [command, ...rest] = args;
const glob = (pattern) => new RegExp(`^${pattern.replace(/[.]/g, "\\.").replaceAll("*", ".*")}$`);
if (command === "list-units") {
  const pattern = glob(rest.at(-1));
  for (const name of names()) if (alive(name) && pattern.test(name)) console.log(`${name} loaded active running ${name}`);
} else if (command === "is-active") {
  const states = rest.map(alive);
  console.log(states.map((state) => (state ? "active" : "inactive")).join("\n"));
  process.exitCode = states.some(Boolean) ? 0 : 3;
} else if (command === "stop" && alive(rest[0])) {
  const pid = pidOf(rest[0]);
  if (pid === null) rmSync(join(units, `${rest[0]}.json`));
  else process.kill(-pid, "SIGTERM");
  while (alive(rest[0])) await new Promise((done) => setTimeout(done, 50));
}
