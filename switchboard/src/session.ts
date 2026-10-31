// The one Claude Code session behind every call: a long-lived `claude -p` that reads and writes stream-json.
//
// The session lives across calls, so it keeps what was said. Other sessions can message it by name, and a
// message wakes it for a turn of its own. What it says in such a turn waits in `pending` until the next ask.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

// What the session is told about the call. The Python package reads the same file until the cutover.
export const PROMPT = new URL("switchboard/prompt.md", import.meta.url);

// Each ask starts with this tag, so the reader can tell the turn that answers it from a turn a message woke.
export const tag = (id: number) => `[voice:${id}]`;
// Said when the session has not answered yet. ElevenLabs gives up on a custom LLM that sends nothing for
// about 4 seconds and asks again, so the first words go out well before that.
export const FILLER = "One moment...";
// Said every so often while a long turn runs, so the call does not go quiet.
export const STILL = "Still working on it...";
export const LATER = "This is taking a while. I'll tell you the rest when you ask.";
export const STOPPED = "The session stopped. Ask again.";

export interface Timings {
  // How long the call waits in silence before the filler.
  first: number;
  // How often it hears that the work goes on.
  every: number;
  // ElevenLabs sends the same words again when it retries. Within this long of the first, a request with the
  // same words hears that ask's answer instead of starting a second turn.
  retry: number;
  // How long an ask waits in all. After that the rest goes to `pending`.
  budget: number;
}

export const TIMINGS: Timings = { first: 1_000, every: 10_000, retry: 30_000, budget: 45_000 };

/** The `claude -p` line the session runs, with the model when one is set. */
export function command(model: string | undefined): string[] {
  const line = [
    "claude", "-p", "--verbose",
    "--input-format", "stream-json", "--output-format", "stream-json", "--replay-user-messages",
    // The mode of T3 Code threads. A message from another mode waits for approval.
    "--permission-mode", "bypassPermissions",
    // The name other sessions message it by.
    "--name", "switchboard",
    "--append-system-prompt", readFileSync(PROMPT, "utf8"),
  ];
  if (model) line.push("--model", model);
  return line;
}

interface Ask {
  id: number;
  text: string;
  started: number;
  // What the session has said for this ask so far. Every request for it reads from the start.
  pieces: string[];
  done: boolean;
}

export interface Status {
  session: boolean;
  last_call: number | null;
  waiting: number;
}

export class Session {
  readonly command: string[];
  readonly cwd: string;
  // The session ID, kept so a restart resumes the same conversation.
  readonly state: string;
  readonly timings: Timings;
  private process: ChildProcessByStdio<Writable, Readable, null> | null = null;
  private ids = 0;
  // The newest ask, the one whose tag a turn can still match, and the one the open turn answers.
  private latest: Ask | null = null;
  private tagged: Ask | null = null;
  private current: Ask | null = null;
  // What the session said with nobody asking: a reply from another session, or the end of a long turn.
  private pending: string[] = [];
  // When KC last said something, in seconds since the epoch, for the start page.
  private lastCall: number | null = null;
  private waiters = new Set<() => void>();

  constructor(command: string[], cwd: string, state: string, timings: Timings = TIMINGS) {
    this.command = command;
    this.cwd = cwd;
    this.state = state;
    this.timings = timings;
  }

  start(): void {
    const [program, ...rest] = this.command;
    const args = [...rest];
    const id = existsSync(this.state) ? readFileSync(this.state, "utf8").trim() : "";
    if (id) args.push("--resume", id);
    const child = spawn(program!, args, { cwd: this.cwd, stdio: ["pipe", "pipe", "inherit"] });
    this.process = child;
    // A process that is gone fails the write of the next ask, which then waits out its budget.
    child.stdin.on("error", () => {});
    child.on("error", (error) => console.error(`switchboard: claude: ${error.message}`));
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event && typeof event === "object" && !Array.isArray(event)) this.handle(event as Record<string, any>);
    });
    lines.on("close", () => {
      // The process ended mid-turn. The ask hears that, and the next ask starts a new process.
      if (this.current && !this.current.done) {
        this.current.pieces.push(STOPPED);
        this.current.done = true;
      }
      this.current = null;
      this.notify();
    });
  }

  alive(): boolean {
    return this.process !== null && this.process.exitCode === null && this.process.signalCode === null;
  }

  /** What the start page shows: whether the session runs, when KC last talked, and what waits. */
  status(): Status {
    return { session: this.alive(), last_call: this.lastCall, waiting: this.pending.length };
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child || !this.alive()) return;
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(timer);
  }

  /** The ask a call is still waiting on, which hears a turn that a message woke. */
  private listening(): Ask | null {
    return this.latest && !this.latest.done ? this.latest : null;
  }

  private handle(event: Record<string, any>): void {
    const kind = event.type;
    if (kind === "system" && event.session_id) {
      mkdirSync(dirname(this.state), { recursive: true });
      writeFileSync(this.state, String(event.session_id));
    }
    if (kind === "user") {
      const content = event.message?.content;
      if (typeof content === "string" && this.tagged && content.startsWith(tag(this.tagged.id))) this.current = this.tagged;
    } else if (kind === "assistant") {
      const blocks = event.message?.content;
      for (const block of Array.isArray(blocks) ? blocks : []) {
        const text = block?.type === "text" && typeof block.text === "string" ? block.text.trim() : "";
        if (!text) continue;
        const target = this.current ?? this.listening();
        // Text for an ask KC has moved on from waits for the next one.
        if (target && target === this.latest && !target.done) target.pieces.push(text);
        else this.pending.push(text);
      }
    } else if (kind === "result") {
      if (this.current) this.current.done = true;
      this.current = null;
    }
    this.notify();
  }

  private notify(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiters) wake();
  }

  /** Resolves at the next event from the session, or after `ms`. */
  private change(ms: number): Promise<void> {
    return new Promise((done) => {
      const wake = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        done();
      };
      const timer = setTimeout(wake, ms);
      this.waiters.add(wake);
    });
  }

  /** The ask for these words, and the updates to say first. A retry joins the ask it repeats. */
  private submit(text: string): { ask: Ask; updates: string[] } {
    const now = performance.now();
    const latest = this.latest;
    if (latest && latest.text === text && now - latest.started < this.timings.retry) return { ask: latest, updates: [] };
    if (!this.alive()) this.start();
    const ask: Ask = { id: ++this.ids, text, started: now, pieces: [], done: false };
    this.latest = this.tagged = ask;
    this.lastCall = Date.now() / 1000;
    const updates = this.pending;
    this.pending = [];
    const message = { type: "user", message: { role: "user", content: `${tag(ask.id)} ${text}` } };
    this.process!.stdin.write(JSON.stringify(message) + "\n");
    return { ask, updates };
  }

  /** The spoken answer to one thing KC said, a piece at a time. */
  async *ask(text: string): AsyncGenerator<string> {
    const { first, every, budget } = this.timings;
    const { ask, updates } = this.submit(text);
    yield* updates;
    const start = performance.now();
    let last = start;
    let said = 0;
    let quiet = updates.length === 0;
    while (true) {
      const now = performance.now();
      let piece: string;
      let real = false;
      if (said < ask.pieces.length) {
        piece = ask.pieces[said]!;
        real = true;
      } else if (ask.done || ask !== this.latest) {
        return;
      } else if (now - start >= budget) {
        // The rest of this turn goes to pending, for the next ask.
        this.latest = null;
        piece = LATER;
      } else {
        const gap = (quiet ? first : every) - (now - last);
        if (gap > 0) {
          await this.change(Math.min(gap, budget - (now - start)));
          continue;
        }
        piece = quiet ? FILLER : STILL;
      }
      if (real) said++;
      quiet = false;
      last = performance.now();
      yield piece;
      if (piece === LATER && !real) return;
    }
  }
}
