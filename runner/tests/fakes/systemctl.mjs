// A fake `systemctl --user`, so no test reaches the real user manager. Each call is logged to
// $FAKE_DIR/systemctl.jsonl. Like the real one, it refuses a unit that has no file in the user's unit folder.
import { appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [scope, command, ...rest] = process.argv.slice(2);
const dir = process.env.FAKE_DIR;
appendFileSync(join(dir, "systemctl.jsonl"), JSON.stringify([scope, command, ...rest]) + "\n");

if (existsSync(join(dir, "systemctl.down"))) {
  console.error("Failed to connect to user scope bus");
  process.exit(1);
}
if (scope !== "--user") {
  console.error(`fake systemctl: not the user scope: ${scope}`);
  process.exit(1);
}
for (const unit of rest.filter((word) => !word.startsWith("--"))) {
  if (!existsSync(join(homedir(), ".config", "systemd", "user", unit))) {
    console.error(`Failed to ${command} unit: Unit file ${unit} does not exist.`);
    process.exit(1);
  }
}
