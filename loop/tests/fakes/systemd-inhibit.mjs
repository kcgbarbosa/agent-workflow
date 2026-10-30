// The fake `systemd-inhibit`. It holds off no sleep, records its call in FAKE_DIR/systemd.jsonl, and runs until
// the `--pid` process ends.
import { record } from "./units.mjs";

const args = process.argv.slice(2);
record("systemd-inhibit", args);
const pid = Number(args.find((arg) => arg.startsWith("--pid="))?.slice("--pid=".length));
const alive = () => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
while (alive()) await new Promise((done) => setTimeout(done, 200));
