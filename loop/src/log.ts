// The decisions log: one JSONL line per step, in the shape the watch page, the report, and the forecast read.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export const DECISIONS = "decisions.jsonl";

export type Line = {
  time: string;
  epic: string;
  ticket: string;
  step: string;
  result: string;
  commit: string | null;
  session: string | null;
  detail: string;
  [field: string]: unknown;
};

export type Extra = { commit?: string | null; session?: string | null; detail?: string; [field: string]: unknown };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The time as Python's `isoformat(timespec="seconds")` writes it, so the old readers parse it. */
function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
}

export class Log {
  readonly path: string;
  readonly run: string;
  private closed = false;

  constructor(path: string, run: string) {
    this.path = path;
    this.run = run;
    mkdirSync(dirname(path), { recursive: true });
  }

  write(ticket: string, step: string, result: string, extra: Extra = {}): Line {
    const { commit = null, session = null, detail = "", ...fields } = extra;
    const line: Line = { time: now(), epic: this.run, ticket, step, result, commit, session, detail, ...fields };
    if (this.closed && step !== "notify") return line;
    appendFileSync(this.path, JSON.stringify(line) + "\n");
    console.log([line.time, ticket, step, result, detail].filter(Boolean).join(" "));
    return line;
  }

  /** After a stop, a step that the stop cut short writes no result. Only the stop's notify line follows. */
  close(): void {
    this.closed = true;
  }

  lines(): Line[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((text) => {
        try {
          return [JSON.parse(text) as Line];
        } catch {
          return [];
        }
      });
  }
}
