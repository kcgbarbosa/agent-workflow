"""An OpenAI-compatible chat endpoint in front of the session, for an ElevenLabs agent's custom LLM.

ElevenLabs sends the whole conversation each turn. The session already holds it, so only the last thing KC
said goes in. The answer streams back as Server-Sent Events, which ElevenLabs requires.
"""

from __future__ import annotations

import hmac
import json
import re
import time
import uuid
from collections.abc import Iterable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .session import Session

# Markdown read aloud is noise: the voice would say the asterisks and backticks.
MARKUP = re.compile(r"[*_`#>|]+")


def spoken(text: str) -> str:
    return MARKUP.sub("", text).strip()


def last_user_text(body: dict[str, Any]) -> str:
    for message in reversed(body.get("messages", [])):
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, list):
            content = " ".join(part.get("text", "") for part in content if isinstance(part, dict))
        return str(content or "").strip()
    return ""


def chunk(answer_id: str, delta: dict[str, str], finish: str | None = None) -> bytes:
    payload = {
        "id": answer_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": "switchboard",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }
    return f"data: {json.dumps(payload)}\n\n".encode()


def server(session: Session, token: str, host: str, port: int) -> ThreadingHTTPServer:
    """The server, bound and ready for `serve_forever`. Port 0 picks a free port."""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            # A health check for curl that says nothing about the session.
            if self.path == "/health":
                self.reply(200, {"ok": True})
            elif self.path == "/api/status":
                # Funnel makes every path public, so the status needs the token like a call does.
                if self.authorized():
                    self.reply(200, session.status())
                else:
                    self.reply(401, {"error": "unauthorized"})
            else:
                self.reply(404, {"error": "not found"})

        def do_POST(self) -> None:
            if not self.authorized():
                self.reply(401, {"error": "unauthorized"})
                return
            # Whatever base URL the agent was given, the OpenAI clients add `/chat/completions` to it.
            if not self.path.split("?")[0].rstrip("/").endswith("/chat/completions"):
                self.reply(404, {"error": "not found"})
                return
            length = int(self.headers.get("Content-Length", 0))
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                self.reply(400, {"error": "body is not JSON"})
                return
            text = last_user_text(body)
            if not text:
                self.reply(400, {"error": "no user message"})
                return
            pieces = (spoken(piece) for piece in session.ask(text))
            if body.get("stream"):
                self.stream(pieces)
            else:
                answer = " ".join(piece for piece in pieces if piece)
                message = {"role": "assistant", "content": answer}
                choice = {"index": 0, "message": message, "finish_reason": "stop"}
                self.reply(200, {"object": "chat.completion", "model": "switchboard", "choices": [choice]})

        def authorized(self) -> bool:
            given = self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
            return hmac.compare_digest(given.encode(), token.encode())

        def stream(self, pieces: Iterable[str]) -> None:
            answer_id = f"chatcmpl-{uuid.uuid4().hex}"
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(chunk(answer_id, {"role": "assistant", "content": ""}))
            for piece in pieces:
                if piece:
                    # A space between pieces, so two text blocks do not run together when spoken.
                    self.wfile.write(chunk(answer_id, {"content": piece + " "}))
                    self.wfile.flush()
            self.wfile.write(chunk(answer_id, {}, "stop"))
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()

        def reply(self, status: int, payload: dict[str, Any]) -> None:
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, format: str, *args: Any) -> None:
            # The journal keeps the status line of each request, never a body.
            print(f"{self.address_string()} {format % args}", flush=True)

    return ThreadingHTTPServer((host, port), Handler)
