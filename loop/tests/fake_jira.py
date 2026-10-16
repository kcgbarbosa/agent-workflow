"""A fake Jira REST API and ntfy server for the loop tests, on a local port. It keeps the issues in memory.

Each write reaches the kill point `jira:<method> <key> <kind>` after it changes the issue and before it
answers.
"""

from __future__ import annotations

import json
import re
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from killpoint import reached

FLAGGED = "customfield_10021"
# A read of the comments gets them two at a time, so a ticket with more comments takes more than one page.
COMMENT_PAGE = 2
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
    attachment_sizes: list[int] = field(default_factory=list)
    statuses: list[str] = field(default_factory=list)
    # The description: a paragraph for each text, and a bullet list for each run of "- " texts.
    body: list[str] = field(default_factory=list)


class FakeJira:
    def __init__(self) -> None:
        self.issues: dict[str, Issue] = {}
        self.notifications: list[str] = []
        # The HTTP codes that the next requests get, one each, as from a busy Jira. A 429 asks for 7 seconds.
        self.errors: list[int] = []
        # When True, a read of the comments gets HTTP 403, as for a token that may not see them.
        self.refuse_comments = False
        # Each request as its method and path, so a test can tell a read from a write.
        self.requests: list[tuple[str, str]] = []
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
        description = {"type": "doc", "content": _content(issue.body or [f"Build {issue.summary}."])}
        return {
            "key": issue.key,
            "fields": {
                "summary": issue.summary,
                "status": self._status(issue.status),
                "issuetype": {"name": issue.issue_type},
                "description": description,
                "issuelinks": links,
                "parent": {"key": issue.parent} if issue.parent else None,
                FLAGGED: [{"value": "Impediment"}] if issue.flagged else None,
                "attachment": [
                    {"filename": name, "size": size}
                    for name, size in zip(issue.attachments, issue.attachment_sizes, strict=True)
                ],
            },
        }

    @staticmethod
    def _comments(issue: Issue, path: str) -> dict[str, Any]:
        found = re.search(r"startAt=(\d+)", path)
        start = int(found[1]) if found else 0
        page = [
            {"body": {"type": "doc", "content": [_paragraph(line) for line in text.splitlines()]}}
            for text in issue.comments[start : start + COMMENT_PAGE]
        ]
        return {"startAt": start, "maxResults": COMMENT_PAGE, "total": len(issue.comments), "comments": page}

    def _search(self, jql: str) -> list[dict[str, Any]]:
        """The three queries the loop and the forecast send: one Epic's children, the open Epics of some
        projects, and the children of some Epics."""
        if parent := re.match(r"parent = ([A-Z]+-\d+)", jql):
            found = [i for i in self.issues.values() if i.parent == parent[1]]
        elif parents := re.match(r"parent in \(([^)]*)\)", jql):
            keys = {key.strip() for key in parents[1].split(",")}
            found = [i for i in self.issues.values() if i.parent in keys]
        elif projects := re.match(
            r"project in \(([^)]*)\) AND issuetype = Epic AND statusCategory != Done", jql
        ):
            names = {name.strip() for name in projects[1].split(",")}
            found = [
                i
                for i in self.issues.values()
                if i.issue_type == "Epic" and i.key.split("-")[0] in names and CATEGORY[i.status] != "done"
            ]
        else:
            raise AssertionError(f"the fake Jira does not know this query: {jql}")
        return [self._json(i) for i in sorted(found, key=lambda i: int(i.key.split("-")[1]))]

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
                    fake.requests.append((self.command, self.path.split("?")[0]))
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
                    if match := re.fullmatch(r"/rest/api/3/issue/([A-Z]+-\d+)/comment", path):
                        if fake.refuse_comments:
                            return self._send({"errorMessages": ["no permission"]}, 403)
                        return self._send(fake._comments(fake.issues[match[1]], self.path))
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
                        reached(f"ntfy:{body.decode()}")
                        return self._send({})
                    if path == "/rest/api/3/search/jql":
                        jql = json.loads(body)["jql"]
                        return self._send({"issues": fake._search(jql), "isLast": True})
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
                            content = body.split(b"\r\n\r\n", 1)[1].rsplit(b"\r\n--", 1)[0]
                            issue.attachment_sizes.append(len(content))
                        reached(f"jira:POST {match[1]} {match[2]}")
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
                        reached(f"jira:PUT {match[1]} flag")
                        return self._send(None, 204)
                self._send({"errorMessages": ["not found"]}, 404)

        return Handler


def _content(texts: list[str]) -> list[dict[str, Any]]:
    nodes: list[dict[str, Any]] = []
    for text in texts:
        if not text.startswith("- "):
            nodes.append(_paragraph(text))
            continue
        if not nodes or nodes[-1]["type"] != "bulletList":
            nodes.append({"type": "bulletList", "content": []})
        nodes[-1]["content"].append({"type": "listItem", "content": [_paragraph(text[2:])]})
    return nodes


def _paragraph(text: str) -> dict[str, Any]:
    return {"type": "paragraph", "content": [{"type": "text", "text": text}]}
