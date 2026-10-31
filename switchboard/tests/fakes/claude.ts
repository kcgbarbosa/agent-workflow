// A stand-in for `claude -p` in stream-json mode. It echoes each message back as the answer.
//
// A message with "slow" waits two seconds before it answers. Each message it reads goes on a line of
// received.log in the folder it runs in, so a test can count them. A message with "inbound" first plays a turn that a
// message from another session woke, the way the real session does when a reply arrives while it is idle.

import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

function emit(event: object): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function turn(user: string, answer: string): void {
  emit({ type: "user", message: { role: "user", content: user }, isReplay: true });
  emit({ type: "assistant", message: { content: [{ type: "text", text: answer }] } });
  emit({ type: "result", subtype: "success" });
}

emit({ type: "system", subtype: "init", session_id: "fake-session" });
for await (const line of createInterface({ input: process.stdin })) {
  const content: string = JSON.parse(line).message.content;
  appendFileSync("received.log", content + "\n");
  if (content.includes("inbound")) turn("Another Claude session sent a message: done", "PITCH-16 says the tests pass.");
  if (content.includes("slow")) await sleep(2_000);
  turn(content, "**echo** " + content.split("] ").slice(1).join("] "));
}
