// The fake `claude`. It speaks the stream-json protocol the Claude Agent SDK drives, and plays the steps of
// FAKE_DIR/plan.json for the ticket of the run folder. A ticket with no plan writes one file and commits.
//
// A step holds `write` ({path: text}) and `commit` (the message), `status` ("done" or "blocked"), and `reason`.
// `{}` returns done with no change.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import readline from "node:readline";

const fakes = process.env.FAKE_DIR;
const key = basename(process.env.LOOP_RUN_DIR ?? "");
const flag = (name) => {
  const args = process.argv.slice(2);
  const joined = args.find((arg) => arg.startsWith(`--${name}=`));
  if (joined) return joined.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : null;
};
const out = (event) => process.stdout.write(JSON.stringify(event) + "\n");

function step() {
  const plans = existsSync(join(fakes, "plan.json")) ? JSON.parse(readFileSync(join(fakes, "plan.json"), "utf8")) : {};
  const counter = join(fakes, `count-${key}`);
  const count = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  writeFileSync(counter, String(count + 1));
  if (!(key in plans)) return { write: { [`${key}.txt`]: `${key}\n` } };
  return plans[key][count] ?? {};
}

function play(prompt) {
  const session = flag("resume") ?? randomUUID();
  const now = step();
  appendFileSync(
    join(fakes, "calls.jsonl"),
    JSON.stringify({
      key,
      prompt,
      resume: flag("resume"),
      cwd: process.cwd(),
      model: flag("model"),
      effort: flag("effort"),
      run_dir: process.env.LOOP_RUN_DIR,
      jira_token: process.env.JIRA_API_TOKEN ?? null,
      bw_session: process.env.BW_SESSION ?? null,
    }) + "\n",
  );
  if (now.write) {
    for (const [path, text] of Object.entries(now.write)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    execFileSync("git", ["add", "-A"]);
    execFileSync("git", ["commit", "--quiet", "-m", now.commit ?? `feat(${key}): change`]);
  }
  out({ type: "system", subtype: "init", session_id: session, cwd: process.cwd(), tools: [], model: flag("model") });
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: session,
    duration_ms: 1000,
    num_turns: 1,
    result: "",
    total_cost_usd: 0.5,
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    structured_output: { status: now.status ?? "done", reason: now.reason ?? "Built it.", decisions: [] },
  });
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
  } else if (message.type === "user") {
    const content = message.message.content;
    play(typeof content === "string" ? content : content.map((part) => part.text ?? "").join(""));
  }
}
