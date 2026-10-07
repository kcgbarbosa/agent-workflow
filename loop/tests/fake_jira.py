"""A fake Jira REST API and ntfy server for the loop tests, on a local port. It keeps the issues in memory."""

from __future__ import annotations

import json
import re
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

FLAGGED = "customfield_10021"
CATEGORY = {"To Do": "new", "In Progress": "indeterminate", "In Review": "indeterminate", "Done": "done"}


@dataclass
class Issue:
    key: str
    summary: str
    status: str = "To Do"
    parent: str | None = None
    blockers: list[str] = field(default_factory=list)
    flagged: bool = False
    issue_type: str = "Task"
    comments: list[str] = field(default_factory=list)
    attachments: list[str] = field(default_factory=list)
    statuses: list[str] = field(default_factory=list)


class FakeJira:
    def __init__(self) -> None:
        self.issues: dict[str, Issue] = {}
        self.notifications: list[str] = []
        # The HTTP codes that the next requests get, one each, as from a busy Jira. A 429 asks for 7 seconds.
        self.errors: list[int] = []
        self.lock = threading.Lock()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}"

    def add(self, key: str, summary: str, **values: Any) -> Issue:
        issue = Issue(key, summary, **values)
        self.issues[key] = issue
        return issue

    def close(self) -> None:
        self.server.shutdown()

    def _json(self, issue: Issue) -> dict[str, Any]:
        links = [
            {
                "type": {"name": "Blocks"},
                "inwardIssue": {"key": key, "fields": {"status": self._status(self.issues[key].status)}},
            }
            for key in issue.blockers
        ]
        description = {
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": f"Build {issue.summary}."}]}
            ],
        }
        return {
            "key": issue.key,
            "fields": {
                "summary": issue.summary,
                "status": self._status(issue.status),
                "issuetype": {"name": issue.issue_type},
                "description": description,
                "issuelinks": links,
                FLAGGED: [{"value": "Impediment"}] if issue.flagged else None,
            },
        }

    @staticmethod
    def _status(name: str) -> dict[str, Any]:
        return {"name": name, "statusCategory": {"key": CATEGORY[name]}}

    def _handler(self) -> type[BaseHTTPRequestHandler]:
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:
                pass

            def _body(self) -> bytes:
                return self.rfile.read(int(self.headers.get("Content-Length", 0)))

            def _send(self, data: Any, code: int = 200) -> None:
                raw = json.dumps(data).encode() if data is not None else b""
                self.send_response(code)
                if code == 429:
                    self.send_header("Retry-After", "7")
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def _busy(self) -> bool:
                with fake.lock:
                    code = fake.errors.pop(0) if fake.errors else None
                if code is not None:
                    self._send({"errorMessages": ["busy"]}, code)
                return code is not None

            def do_GET(self) -> None:
                path = self.path.split("?")[0]
                if self._busy():
                    return
                with fake.lock:
                    if path == "/rest/api/3/myself":
                        return self._send({"accountId": "fake"})
                    if path == "/rest/api/3/field":
                        return self._send(
                            [{"id": "summary", "name": "Summary"}, {"id": FLAGGED, "name": "Flagged"}]
                        )
                    if match := re.fullmatch(r"/rest/api/3/issue/([A-Z]+-\d+)/transitions", path):
                        issue = fake.issues[match[1]]
                        targets = [name for name in CATEGORY if name != issue.status]
                        transitions = [{"id": name, "name": name, "to": {"name": name}} for name in targets]
                        return self._send({"transitions": transitions})
                    if match := re.fullmatch(r"/rest/api/3/issue/([A-Z]+-\d+)", path):
                        return self._send(fake._json(fake.issues[match[1]]))
                self._send({"errorMessages": ["not found"]}, 404)

            def do_POST(self) -> None:
                body = self._body()
                path = self.path
                if self._busy():
                    return
                with fake.lock:
                    if path.startswith("/ntfy/"):
                        fake.notifications.append(body.decode())
                        return self._send({})
                    if path == "/rest/api/3/search/jql":
                        parent = re.match(r"parent = ([A-Z]+-\d+)", json.loads(body)["jql"])
                        assert parent
                        issues = [fake._json(i) for i in fake.issues.values() if i.parent == parent[1]]
                        return self._send({"issues": issues, "isLast": True})
                    match = re.fullmatch(
                        r"/rest/api/3/issue/([A-Z]+-\d+)/(transitions|comment|attachments)", path
                    )
                    if match:
                        issue = fake.issues[match[1]]
                        if match[2] == "transitions":
                            issue.status = json.loads(body)["transition"]["id"]
                            issue.statuses.append(issue.status)
                        elif match[2] == "comment":
                            paragraphs = json.loads(body)["body"]["content"]
                            issue.comments.append("\n".join(p["content"][0]["text"] for p in paragraphs))
                        else:
                            found = re.search(rb'filename="([^"]+)"', body)
                            issue.attachments.append(found[1].decode() if found else "")
                        return self._send({}, 201)
                self._send({"errorMessages": ["not found"]}, 404)

            def do_PUT(self) -> None:
                body = json.loads(self._body())
                if self._busy():
                    return
                with fake.lock:
                    match = re.fullmatch(r"/rest/api/3/issue/([A-Z]+-\d+)", self.path)
                    if match and FLAGGED in body["fields"]:
                        fake.issues[match[1]].flagged = bool(body["fields"][FLAGGED])
                        return self._send(None, 204)
                self._send({"errorMessages": ["not found"]}, 404)

        return Handler
