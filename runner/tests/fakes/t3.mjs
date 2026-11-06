// A fake `t3`. State is $FAKE_DIR/t3.json, and each call is logged to $FAKE_DIR/t3.jsonl. Like the real one, it
// prints log lines on stdout unless `--log-level error` comes before the subcommand, `list` leaves out
// `activeRunId` and `pendingRequestCount`, and it shows a thread waiting on a question as `running`.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { failsWrite } from "./fail-write.ts";

const args = process.argv.slice(2);
const dir = process.env.FAKE_DIR;
const file = join(dir, "t3.json");
const state = JSON.parse(readFileSync(file, "utf8"));
// A failed write reached no thread, so it is not logged.
const write = args.at(args[0] === "--log-level" ? 3 : 1);
if ((write === "start" || write === "send") && failsWrite(dir)) {
  console.error("t3: a blip");
  process.exit(1);
}
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

/** Like the real one, a path names a project only from inside its workspace root, and a T3 worktree is outside it. */
function refuseUnregistered(project) {
  for (const root of [state.project, ...(state.projects ?? [])]) if (resolve(project) === root || resolve(project).startsWith(`${root}/`)) return;
  console.error(`No T3 Code project matches '${project}'`);
  process.exit(1);
}

const [group, verb] = rest;
if (group === "thread" && verb === "list") {
  refuseUnregistered(flag("--project"));
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
  refuseUnregistered(rest.at(-2));
  if (state.failStart.some((key) => title?.startsWith(key))) {
    console.error(`could not start ${title}`);
    process.exit(1);
  }
  const threadId = `thread:${state.threads.length + 1}`;
  const link = `http://127.0.0.1:3773/env/${encodeURIComponent(threadId)}`;
  state.threads.unshift({ threadId, title, link, status: "running", activeRunId: `run:${threadId}`, pendingRequestCount: 0, updatedAt: new Date().toISOString() });
  writeFileSync(file, JSON.stringify(state));
  console.log(threadId);
} else if (group === "thread" && verb === "send") {
  const thread = state.threads.find((item) => item.threadId === rest[2]);
  if (!thread || state.failSend) {
    console.error("could not send");
    process.exit(1);
  }
  Object.assign(thread, { status: "running", activeRunId: `run:${thread.threadId}`, updatedAt: new Date().toISOString() });
  writeFileSync(file, JSON.stringify(state));
} else {
  console.error(`fake t3: unknown call ${rest.join(" ")}`);
  process.exit(1);
}
