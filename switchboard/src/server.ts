// An OpenAI-compatible chat endpoint in front of the session, for an ElevenLabs agent's custom LLM.
//
// ElevenLabs sends the whole conversation each turn. The session already holds it, so only the last thing KC
// said goes in. The answer streams back as Server-Sent Events, which ElevenLabs requires.

import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Session } from "./session.ts";

// Markdown read aloud is noise: the voice would say the asterisks and backticks.
const MARKUP = /[*_`#>|]+/g;

export function spoken(text: string): string {
  return text.replace(MARKUP, "").trim();
}

export function lastUserText(body: Record<string, any>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages.toReversed()) {
    if (message?.role !== "user") continue;
    let content = message.content;
    if (Array.isArray(content)) {
      content = content.map((part) => (part && typeof part === "object" ? (part.text ?? "") : "")).join(" ");
    }
    return String(content ?? "").trim();
  }
  return "";
}

function chunk(answerId: string, delta: Record<string, string>, finish: string | null = null): string {
  const payload = {
    id: answerId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "switchboard",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function reply(response: ServerResponse, status: number, payload: unknown): void {
  const data = JSON.stringify(payload);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  response.end(data);
}

function read(request: IncomingMessage): Promise<string> {
  return new Promise((done, fail) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (data: string) => (body += data));
    request.on("end", () => done(body));
    request.on("error", fail);
  });
}

export interface Serving {
  server: Server;
  port: number;
  /** Answers every new request with 503, and resolves once the asks that run have ended. */
  drain(): Promise<void>;
}

/** The server, listening. Port 0 picks a free port. */
export async function serve(session: Session, token: string, host: string, port: number): Promise<Serving> {
  const secret = Buffer.from(token);
  let draining = false;
  let running = 0;
  let idle: (() => void) | null = null;

  const authorized = (request: IncomingMessage) => {
    const given = Buffer.from((request.headers.authorization ?? "").replace(/^Bearer /, "").trim());
    return given.length === secret.length && timingSafeEqual(given, secret);
  };

  async function stream(response: ServerResponse, pieces: AsyncGenerator<string>): Promise<void> {
    const answerId = `chatcmpl-${randomUUID().replaceAll("-", "")}`;
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    // The headers and the first chunk go out before the ask starts, so ElevenLabs gets bytes at once.
    response.write(chunk(answerId, { role: "assistant", content: "" }));
    for await (const piece of pieces) {
      // ElevenLabs hung up on this request, usually to retry it. The retry joins the same ask.
      if (response.destroyed) return;
      const text = spoken(piece);
      // A space between pieces, so two text blocks do not run together when spoken.
      if (text) response.write(chunk(answerId, { content: text + " " }));
    }
    if (response.destroyed) return;
    response.write(chunk(answerId, {}, "stop"));
    response.end("data: [DONE]\n\n");
  }

  async function complete(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!authorized(request)) return reply(response, 401, { error: "unauthorized" });
    // Whatever base URL the agent was given, the OpenAI clients add `/chat/completions` to it.
    if (!(request.url ?? "").split("?")[0]!.replace(/\/+$/, "").endsWith("/chat/completions")) {
      return reply(response, 404, { error: "not found" });
    }
    let body: unknown;
    try {
      body = JSON.parse((await read(request)) || "{}");
    } catch {
      return reply(response, 400, { error: "body is not JSON" });
    }
    const fields = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, any>) : {};
    const text = lastUserText(fields);
    if (!text) return reply(response, 400, { error: "no user message" });
    if (fields.stream) return stream(response, session.ask(text));
    const said: string[] = [];
    for await (const piece of session.ask(text)) said.push(spoken(piece));
    const message = { role: "assistant", content: said.filter(Boolean).join(" ") };
    reply(response, 200, {
      object: "chat.completion",
      model: "switchboard",
      choices: [{ index: 0, message, finish_reason: "stop" }],
    });
  }

  function answer(request: IncomingMessage, response: ServerResponse): Promise<void> | void {
    if (draining) return reply(response, 503, { error: "restarting" });
    const path = (request.url ?? "").split("?")[0];
    if (request.method === "GET") {
      // A health check for curl that says nothing about the session.
      if (path === "/health") return reply(response, 200, { ok: true });
      // Funnel makes every path public, so the status needs the token like a call does.
      if (path === "/api/status") {
        return authorized(request) ? reply(response, 200, session.status()) : reply(response, 401, { error: "unauthorized" });
      }
      return reply(response, 404, { error: "not found" });
    }
    if (request.method !== "POST") return reply(response, 405, { error: "method not allowed" });
    running++;
    return complete(request, response).finally(() => {
      running--;
      if (running === 0) idle?.();
    });
  }

  const server = createServer((request, response) => {
    // The journal keeps the status line of each request, never a body.
    response.once("close", () => {
      const status = response.writableFinished ? response.statusCode : "hung up";
      console.log(`${request.socket.remoteAddress} "${request.method} ${request.url}" ${status}`);
    });
    Promise.resolve(answer(request, response)).catch((error: unknown) => {
      console.error(error);
      if (!response.headersSent) reply(response, 500, { error: "server error" });
      else response.destroy();
    });
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => done());
  });
  return {
    server,
    port: (server.address() as AddressInfo).port,
    drain: () => {
      draining = true;
      return running === 0 ? Promise.resolve() : new Promise((done) => (idle = done));
    },
  };
}
