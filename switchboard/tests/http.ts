// How ElevenLabs calls the switchboard, for the tests.

import { expect } from "vitest";

export const TOKEN = "t".repeat(32);
export const FAKE = new URL("fakes/claude.ts", import.meta.url).pathname;
export const FAKE_BIN = new URL("fakes/bin", import.meta.url).pathname;

/** A turn of the call: the conversation so far, and the last thing KC said. */
export function ask(text: string): object {
  const history = [
    { role: "system", content: "ElevenLabs prompt" },
    { role: "user", content: "earlier" },
  ];
  return { stream: true, messages: [...history, { role: "user", content: text }] };
}

export async function post(base: string, body: object, token = TOKEN): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** What the voice would read out, from the SSE chunks. */
export function said(stream: string): string {
  const lines = stream
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
  expect(lines.at(-1)).toBe("[DONE]");
  const chunks = lines.slice(0, -1).map((line) => JSON.parse(line));
  expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
  return chunks
    .map((chunk) => chunk.choices[0].delta.content ?? "")
    .join("")
    .trim();
}

export async function answer(base: string, text: string): Promise<string> {
  const response = await post(base, ask(text));
  expect(response.status).toBe(200);
  return said(await response.text());
}
