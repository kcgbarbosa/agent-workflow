// A fake `t3`. State is $FAKE_DIR/t3.json, and each call is logged to $FAKE_DIR/t3.jsonl. Like the real one, it
// prints log lines on stdout unless `--log-level error` comes before the subcommand, `list` leaves out
// `activeRunId` and `pendingRequestCount`, and it shows a thread waiting on a question as `running`.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const dir = process.env.FAKE_DIR;
const file = join(dir, "t3.json");
const state = JSON.parse(readFileSync(file, "utf8"));
appendFileSync(join(dir, "t3.jsonl"), JSON.stringify(args) + "\n");

if (existsSync(join(dir, "t3.down"))) {
  console.error("t3: no server is running");
  process.exit(1);
}
let rest = args;
if (args[0] === "--log-level" && args[1] === "error") rest = args.slice(2);
else console.log("[12:00:00] INFO starting");

function flag(name) {
  const at = rest.indexOf(name);
  return at < 0 ? undefined : rest[at + 1];
}

const [group, verb] = rest;
if (group === "thread" && verb === "list") {
  const listed = state.threads.map(({ activeRunId: _run, pendingRequestCount: _pending, ...thread }) => thread);
  console.log(JSON.stringify(listed));
} else if (group === "thread" && verb === "show") {
  const thread = state.threads.find((item) => item.threadId === rest.at(-1));
  if (!thread) {
    console.error("no such thread");
    process.exit(1);
  }
  console.log(JSON.stringify({ thread, messages: [] }));
} else if (group === "thread" && verb === "start") {
  const title = flag("--title");
  if (state.failStart.some((key) => title?.startsWith(key))) {
    console.error(`could not start ${title}`);
    process.exit(1);
  }
  const threadId = `thread:${state.threads.length + 1}`;
  state.threads.unshift({ threadId, title, status: "running", activeRunId: `run:${threadId}`, pendingRequestCount: 0, updatedAt: "2026-11-04T00:00:00.000Z" });
  writeFileSync(file, JSON.stringify(state));
  console.log(threadId);
} else {
  console.error(`fake t3: unknown call ${rest.join(" ")}`);
  process.exit(1);
}
