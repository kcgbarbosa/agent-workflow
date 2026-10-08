"""`loop watch`: a read-only web page of the runs on this host.

It reads only what the run writes to the state folder: `decisions.jsonl`, `board.json`, the agent logs, the
gate logs, and the screenshots. It changes nothing, so it can run while a run lasts, after it, or without one.
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import subprocess
import threading
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

RUN_LOCK = "run.lock"
SECRETS_FILE = "secrets.json"
BOARD = "board.json"
DECISIONS = "decisions.jsonl"
PAGE = Path(__file__).with_name("watch.html")
KEY = re.compile(r"[A-Z][A-Z0-9]*-\d+")
AGENT_LOG = re.compile(r"agent-(\d+)\.jsonl")
DENIED = "denied by the Claude Code auto mode classifier"
# A short secret would mask ordinary words.
MIN_SECRET = 8
# The steps that say nothing new on the page.
QUIET_STEPS = {"tracker-status", "tracker-flag", "tracker-comment", "tracker-attach", "tracker-comments"}
SUMMARY_CHARS = 160
DETAIL_CHARS = 4000
CHUNK_BYTES = 2_000_000


class Masker:
    """Replaces the value of each secret with its name. A transcript can hold what an agent printed."""

    def __init__(self, secrets: dict[str, str]) -> None:
        pairs = [(value, f"[{name}]") for name, value in secrets.items() if len(value) >= MIN_SECRET]
        self.pairs = sorted(pairs, key=lambda pair: -len(pair[0]))

    def text(self, value: str) -> str:
        for secret, name in self.pairs:
            value = value.replace(secret, name)
        return value

    def data(self, value: Any) -> Any:
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, list):
            return [self.data(item) for item in value]
        if isinstance(value, dict):
            return {key: self.data(item) for key, item in value.items()}
        return value


def read_secrets(state_dir: Path) -> dict[str, str]:
    try:
        secrets = json.loads((state_dir / SECRETS_FILE).read_text())
    except OSError, json.JSONDecodeError:
        return {}
    return {str(name): str(value) for name, value in secrets.items()} if isinstance(secrets, dict) else {}


def active_run(state_dir: Path) -> str | None:
    """The Epic key of the run that holds the lock, read from the lock file. The lock stays untouched."""
    try:
        holder = json.loads((state_dir / RUN_LOCK).read_text())
        pid, epic = int(holder["pid"]), str(holder["epic"])
    except OSError, ValueError, KeyError, TypeError:
        return None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return None
    except PermissionError:
        pass
    return epic


def read_lines(path: Path) -> list[dict[str, Any]]:
    try:
        text = path.read_text()
    except OSError:
        return []
    lines = []
    for line in text.splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            lines.append(item)
    return lines


def epics(state_dir: Path) -> list[dict[str, Any]]:
    """Each Epic with a log on this host, the newest first."""
    active = active_run(state_dir)
    found = []
    for home in state_dir.iterdir() if state_dir.is_dir() else []:
        log = home / DECISIONS
        if KEY.fullmatch(home.name) and log.exists():
            board = _board(home)
            found.append(
                {
                    "key": home.name,
                    "summary": board.get("summary", ""),
                    "updated": _iso(log.stat().st_mtime),
                    "running": home.name == active,
                }
            )
    return sorted(found, key=lambda epic: epic["updated"], reverse=True)


def _board(home: Path) -> dict[str, Any]:
    try:
        board = json.loads((home / BOARD).read_text())
    except OSError, json.JSONDecodeError:
        return {}
    return board if isinstance(board, dict) else {}


def _iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, UTC).isoformat(timespec="seconds")


@dataclass
class _Ticket:
    key: str
    summary: str = ""
    status: str = ""
    done: bool = False
    flagged: bool = False
    landed: bool = False
    started: bool = False
    stuck_reason: str = ""
    blockers: list[dict[str, Any]] | None = None
    last: dict[str, Any] | None = None


def epic_view(state_dir: Path, epic_key: str) -> dict[str, Any]:
    """The state of one Epic's latest run: the run, the tickets in columns, the cost, and the steps."""
    home = state_dir / epic_key
    lines = read_lines(home / DECISIONS)
    # The latest run starts at the last start line of the Epic.
    starts = [
        index
        for index, line in enumerate(lines)
        if line.get("ticket") == epic_key and line.get("step") == "start"
    ]
    run = lines[starts[-1] :] if starts else lines
    board = _board(home)
    running = active_run(state_dir) == epic_key

    tickets: dict[str, _Ticket] = {}
    for item in board.get("tickets", []):
        tickets[item["key"]] = _Ticket(
            key=item["key"],
            summary=item.get("summary", ""),
            status=item.get("status", ""),
            done=bool(item.get("done")),
            flagged=bool(item.get("flagged")),
            landed=bool(item.get("landed")),
            blockers=item.get("blockers", []),
        )

    state, stop_reason, pr_url = ("running" if running else "idle"), "", ""
    every_run, this_run = _session_costs(lines), _session_costs(run)
    events = []
    for line in run:
        key, step, result = line.get("ticket", ""), line.get("step", ""), line.get("result", "")
        if key == epic_key or key.startswith(f"{epic_key}-"):
            if step == "stop":
                state, stop_reason = "stopped", result
            elif step == "finish" and result == "nothing-landed":
                state, stop_reason = "stopped", result
            elif step == "pr" and result in ("pr-open", "pr-draft"):
                state, pr_url = result, line.get("detail", "")
        else:
            ticket = tickets.setdefault(key, _Ticket(key=key))
            if step == "start" and result == "done-not-landed":
                ticket.done = True
            elif step == "start":
                ticket.started, ticket.stuck_reason = True, ""
            elif step == "stuck":
                ticket.stuck_reason = str(line.get("detail", "")).replace(f"{home}/", "")
            elif step == "land" and result == "landed":
                ticket.landed = True
            if step not in QUIET_STEPS and not step.startswith("tracker-"):
                ticket.last = {"step": step, "result": result, "time": line.get("time")}
        if step not in QUIET_STEPS:
            events.append(_event(home, line))
    if running:
        state = "running"

    columns = []
    for ticket in tickets.values():
        if ticket.landed:
            column = "landed"
        elif ticket.stuck_reason or ticket.flagged:
            column = "stuck"
        elif ticket.done:
            column = "done"
        elif ticket.started and running:
            column = "running"
        else:
            column = "waiting"
        run_dir = home / "runs" / ticket.key
        columns.append(
            {
                "key": ticket.key,
                "summary": ticket.summary,
                "status": ticket.status,
                "column": column,
                "blockers": ticket.blockers or [],
                "stuck_reason": ticket.stuck_reason,
                "last": ticket.last,
                "cost": round(sum(_ticket_sessions(lines, ticket.key, every_run).values()), 2),
                "agents": agent_logs(run_dir),
                "screenshots": _files(home, run_dir, image=True),
                "files": _files(home, run_dir, image=False),
            }
        )
    return {
        "key": epic_key,
        "summary": board.get("summary", ""),
        "branch": board.get("branch", ""),
        "state": state,
        "stop_reason": stop_reason,
        "pr_url": pr_url,
        "started": run[0].get("time") if run else None,
        "updated": run[-1].get("time") if run else None,
        "cost": round(sum(this_run.values()), 2),
        "epic_cost": round(sum(every_run.values()), 2),
        "tickets": columns,
        "events": events,
        "epic_files": _files(home, home / "runs" / epic_key, image=False),
        "epic_agents": agent_logs(home / "runs" / epic_key),
    }


def _session_costs(lines: list[dict[str, Any]]) -> dict[str, float]:
    """The cost of each agent session. A resumed session reports the cost of the whole session so far."""
    sessions: dict[str, float] = {}
    for number, line in enumerate(lines):
        cost = (line.get("usage") or {}).get("total_cost_usd")
        if isinstance(cost, int | float):
            sessions[line.get("session") or f"line-{number}"] = float(cost)
    return sessions


def _ticket_sessions(run: list[dict[str, Any]], key: str, sessions: dict[str, float]) -> dict[str, float]:
    ids = {line.get("session") for line in run if line.get("ticket") == key and line.get("usage")}
    return {session: cost for session, cost in sessions.items() if session in ids}


def _event(home: Path, line: dict[str, Any]) -> dict[str, Any]:
    detail = str(line.get("detail") or "")
    event = {
        "time": line.get("time"),
        "ticket": line.get("ticket"),
        "step": line.get("step"),
        "result": line.get("result"),
        "detail": detail.replace(f"{home}/", ""),
    }
    usage = line.get("usage") or {}
    if usage.get("total_cost_usd") is not None:
        event["cost"] = usage.get("total_cost_usd")
        event["turns"] = usage.get("num_turns")
    # A gate or stuck line names its log, which the page links to.
    for match in re.findall(rf"{re.escape(str(home))}/(runs/\S+)", detail):
        if (home / match).is_file():
            event["log"] = match
            break
    return event


def agent_logs(run_dir: Path) -> list[dict[str, Any]]:
    logs = []
    for path in run_dir.glob("agent-*.jsonl"):
        if match := AGENT_LOG.fullmatch(path.name):
            stat = path.stat()
            logs.append({"number": int(match[1]), "size": stat.st_size, "updated": _iso(stat.st_mtime)})
    return sorted(logs, key=lambda log: log["number"])


def _files(home: Path, run_dir: Path, image: bool) -> list[str]:
    images = {".png", ".jpg", ".jpeg", ".webp"}
    if not run_dir.is_dir():
        return []
    found = [
        path
        for path in run_dir.rglob("*")
        if path.is_file() and (path.suffix.lower() in images) == image and not AGENT_LOG.fullmatch(path.name)
    ]
    return [str(path.relative_to(home)) for path in sorted(found)]


def activity(home: Path, ticket: str, path: Path, offset: int) -> dict[str, Any]:
    """The events of one agent log from a byte offset, each as one line a person can scan.

    A line the agent still writes stays for the next read, so the next offset starts at a whole line.
    """
    size = path.stat().st_size
    with path.open("rb") as file:
        file.seek(min(offset, size))
        data = file.read(CHUNK_BYTES)
    end = data.rfind(b"\n") + 1
    items: list[dict[str, Any]] = []
    roots = (f"{home}/worktrees/{ticket}/", f"{home}/runs/{ticket}/")
    for raw in data[:end].splitlines():
        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            items += _items(event, roots)
    return {"items": items, "offset": offset + end, "size": size}


def _items(event: dict[str, Any], roots: tuple[str, str]) -> Iterator[dict[str, Any]]:
    kind = event.get("type")
    parent = event.get("parent_tool_use_id")
    if kind == "system" and event.get("subtype") == "init":
        yield {"kind": "init", "model": event.get("model", ""), "session": event.get("session_id", "")}
    elif kind == "result":
        usage = {key: event.get(key) for key in ("total_cost_usd", "num_turns", "duration_ms")}
        yield {"kind": "result", "error": bool(event.get("is_error")), **usage}
    elif kind in ("assistant", "user"):
        content = (event.get("message") or {}).get("content")
        for block in content if isinstance(content, list) else []:
            item = _block(kind, block, roots)
            if item:
                yield {**item, "parent": parent}


def _block(kind: str, block: dict[str, Any], roots: tuple[str, str]) -> dict[str, Any] | None:
    worktree, run_dir = roots

    def short(text: str) -> str:
        return text.replace(worktree, "").replace(run_dir, "run/")

    if block.get("type") == "text" and kind == "assistant" and block.get("text", "").strip():
        return {"kind": "text", "text": short(block["text"].strip())[:DETAIL_CHARS]}
    if block.get("type") == "tool_use":
        name = str(block.get("name", ""))
        given = block.get("input")
        tool_input: dict[str, Any] = given if isinstance(given, dict) else {}
        if name == "StructuredOutput":
            return {
                "kind": "status",
                "status": tool_input.get("status", ""),
                "text": short(str(tool_input.get("reason", ""))),
                "decisions": [short(str(item)) for item in tool_input.get("decisions", [])],
            }
        label, summary, detail = tool_summary(name, tool_input)
        return {
            "kind": "tool",
            "id": block.get("id"),
            "tool": label,
            "summary": short(summary)[:SUMMARY_CHARS],
            "detail": short(detail)[:DETAIL_CHARS],
        }
    if block.get("type") == "tool_result":
        text = _result_text(block.get("content"))
        return {
            "kind": "output",
            "id": block.get("tool_use_id"),
            "error": bool(block.get("is_error")),
            "denied": DENIED in text,
            "text": short(text)[:DETAIL_CHARS],
        }
    return None


def _result_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(part.get("text", "")) for part in content if isinstance(part, dict))
    return ""


def tool_summary(name: str, tool_input: dict[str, Any]) -> tuple[str, str, str]:
    """The label, the one-line summary, and the full input of one tool call."""

    def get(key: str) -> str:
        return str(tool_input.get(key, ""))

    first_line = get("command").strip().splitlines()[0] if get("command").strip() else ""
    if name == "Bash":
        return "Bash", get("description") or first_line, get("command")
    if name in ("Read", "Write", "Edit", "NotebookEdit"):
        path = get("file_path") or get("notebook_path")
        lines = len(get("content").splitlines())
        return name, path + (f" ({lines} lines)" if name == "Write" else ""), path
    if name in ("Grep", "Glob"):
        where = f" in {get('path')}" if get("path") else ""
        return name, f"{get('pattern')}{where}", json.dumps(tool_input)
    if name in ("Agent", "Task"):
        kind = f"{get('subagent_type')}: " if get("subagent_type") else ""
        return "Agent", f"{kind}{get('description')}", get("prompt")
    if name == "Skill":
        return "Skill", f"{get('skill')} {get('args')}".strip(), get("args")
    if name == "SubagentHandback":
        message = get("message").strip()
        return "Handback", message.splitlines()[0] if message else "", message
    if name in ("WebFetch", "WebSearch", "ToolSearch"):
        return name, get("url") or get("query"), json.dumps(tool_input)
    if name.startswith("mcp__"):
        _, server, tool = (name.split("__", 2) + ["", ""])[:3]
        return server, tool, json.dumps(tool_input, indent=1)
    return name, json.dumps(tool_input)[:SUMMARY_CHARS], json.dumps(tool_input, indent=1)


# --- Server ---


class Watch:
    def __init__(self, state_dir: Path) -> None:
        self.state_dir = state_dir

    def masker(self) -> Masker:
        # Read for each request, so a new `loop secrets` takes effect without a restart.
        return Masker(read_secrets(self.state_dir))

    def handle(self, url: str) -> tuple[HTTPStatus, str, bytes]:
        parsed = urlparse(url)
        parts = [unquote(part) for part in parsed.path.strip("/").split("/") if part]
        query = parse_qs(parsed.query)
        if not parts:
            return HTTPStatus.OK, "text/html; charset=utf-8", PAGE.read_bytes()
        if parts == ["api", "epics"]:
            return self.json(epics(self.state_dir))
        if len(parts) == 3 and parts[:2] == ["api", "epic"] and KEY.fullmatch(parts[2]):
            if not (self.state_dir / parts[2] / DECISIONS).exists():
                return self.missing()
            return self.json(epic_view(self.state_dir, parts[2]))
        if len(parts) == 5 and parts[:2] == ["api", "agent"] and all(KEY.fullmatch(p) for p in parts[2:4]):
            home = self.state_dir / parts[2]
            path = home / "runs" / parts[3] / f"agent-{parts[4]}.jsonl"
            if not parts[4].isdigit() or not path.is_file():
                return self.missing()
            offset = int(query.get("offset", ["0"])[0] or 0)
            return self.json(activity(home, parts[3], path, offset))
        if len(parts) >= 4 and parts[0] == "files" and KEY.fullmatch(parts[1]) and parts[2] == "runs":
            return self.file(self.state_dir / parts[1], "/".join(parts[2:]))
        return self.missing()

    def json(self, data: Any) -> tuple[HTTPStatus, str, bytes]:
        body = json.dumps(self.masker().data(data)).encode()
        return HTTPStatus.OK, "application/json", body

    def file(self, home: Path, relative: str) -> tuple[HTTPStatus, str, bytes]:
        root = (home / "runs").resolve()
        path = (home / relative).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            return self.missing()
        kind = mimetypes.guess_type(path.name)[0] or "text/plain"
        if kind.startswith("image/"):
            return HTTPStatus.OK, kind, path.read_bytes()
        text = self.masker().text(path.read_text(errors="replace"))
        return HTTPStatus.OK, "text/plain; charset=utf-8", text.encode()

    def missing(self) -> tuple[HTTPStatus, str, bytes]:
        return HTTPStatus.NOT_FOUND, "text/plain", b"Not found"


def handler(watch: Watch) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - the name http.server calls.
            status, kind, body = watch.handle(self.path)
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: Any) -> None:
            pass

    return Handler


def addresses() -> list[str]:
    """Localhost, and this host's tailnet address when it has one. No other network reaches the page."""
    found = ["127.0.0.1"]
    try:
        result = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=5)
    except OSError, subprocess.TimeoutExpired:
        return found
    if result.returncode == 0 and result.stdout.strip():
        found.append(result.stdout.split()[0])
    return found


def serve(state_dir: Path, port: int, hosts: list[str] | None = None) -> list[ThreadingHTTPServer]:
    """Starts one server for each address, each in its own thread, and returns them."""
    watch = Watch(state_dir)
    servers = []
    for host in hosts or addresses():
        try:
            server = ThreadingHTTPServer((host, port), handler(watch))
        except OSError as error:
            if host == "127.0.0.1":
                raise
            print(f"loop watch does not listen on {host}: {error}", flush=True)
            continue
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
    return servers


def url(port: int, epic_key: str | None = None) -> str:
    return f"http://127.0.0.1:{port}/" + (f"#/{epic_key}" if epic_key else "")
