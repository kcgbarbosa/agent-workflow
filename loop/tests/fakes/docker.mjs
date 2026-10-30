// The fake `docker`. It records each call in FAKE_DIR/docker.jsonl and starts no container. `ps` prints
// FAKE_DIR/containers.txt, one running container per line as the loop's format gives it, or none.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const fakes = process.env.FAKE_DIR;
const args = process.argv.slice(2);
appendFileSync(join(fakes, "docker.jsonl"), JSON.stringify({ args }) + "\n");
const containers = join(fakes, "containers.txt");
if (args[0] === "ps" && existsSync(containers)) process.stdout.write(readFileSync(containers, "utf8"));
