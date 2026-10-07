"""The Jira REST client of the loop."""

from __future__ import annotations

import base64
import json
import mimetypes
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .tracker import Blocker, Ticket, TrackerError

FIELDS = ["summary", "status", "issuetype", "description", "issuelinks"]
SEARCH = "/rest/api/3/search/jql"
# A read that meets a network error or a busy Jira is sent again, with a backoff that doubles.
ATTEMPTS = 4
BACKOFF_SECONDS = 5.0
MAX_WAIT_SECONDS = 120.0


class JiraError(TrackerError):
    pass


class Jira:
    def __init__(
        self, base_url: str, email: str, token: str, sleep: Callable[[float], None] = time.sleep
    ) -> None:
        self.base_url = base_url.rstrip("/")
        credentials = base64.b64encode(f"{email}:{token}".encode()).decode()
        self._auth = f"Basic {credentials}"
        self._flagged_field: str | None = None
        self._sleep = sleep

    def check_access(self) -> None:
        self._request("GET", "/rest/api/3/myself")

    def issue(self, key: str) -> Ticket:
        data = self._request("GET", f"/rest/api/3/issue/{key}?fields={','.join(self._fields())}")
        return self._ticket(data)

    def children(self, epic_key: str) -> list[Ticket]:
        tickets: list[Ticket] = []
        token: str | None = None
        while True:
            body: dict[str, Any] = {
                "jql": f"parent = {epic_key} ORDER BY key ASC",
                "fields": self._fields(),
                "maxResults": 100,
            }
            if token:
                body["nextPageToken"] = token
            data = self._request("POST", SEARCH, body)
            tickets += [self._ticket(issue) for issue in data.get("issues", [])]
            token = data.get("nextPageToken")
            if data.get("isLast", True) or not token:
                return tickets

    def transition(self, key: str, status: str) -> bool:
        data = self._request("GET", f"/rest/api/3/issue/{key}/transitions")
        for transition in data.get("transitions", []):
            if transition.get("to", {}).get("name") == status:
                body = {"transition": {"id": transition["id"]}}
                self._request("POST", f"/rest/api/3/issue/{key}/transitions", body)
                return True
        return False

    def flag(self, key: str) -> None:
        body = {"fields": {self.flagged_field(): [{"value": "Impediment"}]}}
        self._request("PUT", f"/rest/api/3/issue/{key}", body)

    def comment(self, key: str, text: str) -> None:
        paragraphs = [
            {"type": "paragraph", "content": [{"type": "text", "text": line}]}
            for line in text.splitlines()
            if line.strip()
        ]
        body = {"body": {"type": "doc", "version": 1, "content": paragraphs}}
        self._request("POST", f"/rest/api/3/issue/{key}/comment", body)

    def attach(self, key: str, files: list[Path]) -> None:
        for path in files:
            boundary = uuid.uuid4().hex
            kind = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            head = (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
                f"Content-Type: {kind}\r\n\r\n"
            ).encode()
            data = head + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
            headers = {
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "X-Atlassian-Token": "no-check",
            }
            self._request("POST", f"/rest/api/3/issue/{key}/attachments", data=data, headers=headers)

    def flagged_field(self) -> str:
        """The id of the Flagged custom field. Each Jira site gives it a different id."""
        if self._flagged_field is None:
            for field in self._request("GET", "/rest/api/3/field"):
                if field.get("name") == "Flagged":
                    self._flagged_field = str(field["id"])
                    break
            else:
                raise JiraError("This Jira site has no Flagged field")
        return self._flagged_field

    def _fields(self) -> list[str]:
        return [*FIELDS, self.flagged_field()]

    def _ticket(self, data: dict[str, Any]) -> Ticket:
        fields = data["fields"]
        blockers = tuple(
            Blocker(link["inwardIssue"]["key"], _is_done(link["inwardIssue"]["fields"]["status"]))
            for link in fields.get("issuelinks") or []
            if link["type"]["name"] == "Blocks" and "inwardIssue" in link
        )
        return Ticket(
            key=data["key"],
            summary=fields["summary"],
            issue_type=fields["issuetype"]["name"],
            status=fields["status"]["name"],
            done=_is_done(fields["status"]),
            flagged=bool(fields.get(self.flagged_field())),
            blockers=blockers,
            text=adf_to_text(fields.get("description")),
        )

    def _request(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        all_headers = {"Authorization": self._auth, "Accept": "application/json"}
        if body is not None:
            data = json.dumps(body).encode()
            all_headers["Content-Type"] = "application/json"
        all_headers.update(headers or {})
        # A write is sent once, so a retry never adds a second comment. The search is a POST that only reads.
        retry = method == "GET" or path == SEARCH
        attempt = 1
        while True:
            request = urllib.request.Request(
                self.base_url + path, data=data, headers=all_headers, method=method
            )
            try:
                with urllib.request.urlopen(request, timeout=60) as response:
                    raw = response.read()
            except urllib.error.HTTPError as error:
                busy = error.code == 429 or error.code >= 500
                if not (retry and busy) or attempt == ATTEMPTS:
                    detail = error.read().decode(errors="replace")[:300]
                    raise JiraError(f"{method} {path}: HTTP {error.code} {detail}") from error
                wait = _retry_after(error.headers.get("Retry-After"))
            except OSError as error:
                # A URLError, or a timeout or a reset while the response is read.
                if not retry or attempt == ATTEMPTS:
                    raise JiraError(f"{method} {path}: {getattr(error, 'reason', error)}") from error
                wait = None
            else:
                return json.loads(raw) if raw else None
            backoff = BACKOFF_SECONDS * 2 ** (attempt - 1)
            self._sleep(min(backoff if wait is None else wait, MAX_WAIT_SECONDS))
            attempt += 1


def _retry_after(value: str | None) -> float | None:
    """The seconds that a busy Jira asks for. A date in the header falls back to the backoff."""
    try:
        return max(0.0, float(value)) if value else None
    except ValueError:
        return None


def _is_done(status: dict[str, Any]) -> bool:
    return bool(status.get("statusCategory", {}).get("key") == "done")


def adf_to_text(node: Any) -> str:
    """Turns an Atlassian Document Format body into plain text for the ticket file."""
    if not isinstance(node, dict):
        return ""
    kind = node.get("type")
    if kind == "text":
        text = str(node.get("text", ""))
        for mark in node.get("marks", []):
            if mark.get("type") == "code":
                text = f"`{text}`"
            elif mark.get("type") == "link":
                text = f"[{text}]({mark.get('attrs', {}).get('href', '')})"
        return text
    if kind == "hardBreak":
        return "\n"
    if kind == "inlineCard":
        return str(node.get("attrs", {}).get("url", ""))
    children = node.get("content", [])
    if kind in ("bulletList", "orderedList"):
        items = []
        for number, item in enumerate(children, start=1):
            marker = f"{number}." if kind == "orderedList" else "-"
            body = adf_to_text(item).strip().replace("\n", "\n  ")
            items.append(f"{marker} {body}")
        return "\n".join(items) + "\n\n"
    inner = "".join(adf_to_text(child) for child in children)
    if kind == "heading":
        level = int(node.get("attrs", {}).get("level", 2))
        return f"{'#' * level} {inner}\n\n"
    if kind == "codeBlock":
        return f"```\n{inner}\n```\n\n"
    if kind == "paragraph":
        return f"{inner}\n\n"
    if kind == "listItem":
        return inner.strip() + "\n"
    return inner
