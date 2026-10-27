"""The bridge against a stand-in `claude`, over real HTTP, the way ElevenLabs calls it."""

from __future__ import annotations

import json
import sys
import threading
import urllib.error
import urllib.request
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from switchboard.server import server
from switchboard.session import FILLER, Session

FAKE = Path(__file__).parent / "bin" / "claude"
TOKEN = "t" * 32


@pytest.fixture
def url(tmp_path: Path) -> Iterator[str]:
    session = Session([sys.executable, str(FAKE)], tmp_path, tmp_path / "state" / "session")
    bound = server(session, TOKEN, "127.0.0.1", 0)
    threading.Thread(target=bound.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{bound.server_address[1]}/v1/chat/completions"
    bound.shutdown()
    session.stop()


def post(url: str, body: dict[str, Any], token: str = TOKEN) -> str:
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    request = urllib.request.Request(url, json.dumps(body).encode(), headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        return str(response.read().decode())


def said(stream: str) -> str:
    """What the voice would read out, from the SSE chunks."""
    lines = [line.removeprefix("data: ") for line in stream.splitlines() if line.startswith("data: ")]
    assert lines[-1] == "[DONE]"
    chunks = [json.loads(line) for line in lines[:-1]]
    assert chunks[-1]["choices"][0]["finish_reason"] == "stop"
    return "".join(chunk["choices"][0]["delta"].get("content", "") for chunk in chunks).strip()


def ask(text: str) -> dict[str, Any]:
    history = [{"role": "system", "content": "ElevenLabs prompt"}, {"role": "user", "content": "earlier"}]
    return {"stream": True, "messages": [*history, {"role": "user", "content": text}]}


def test_the_last_thing_said_goes_in_and_the_answer_streams_back_without_markup(url: str) -> None:
    assert said(post(url, ask("how is pitchridge"))) == "echo how is pitchridge"


def test_a_reply_that_arrived_between_turns_is_said_first(url: str) -> None:
    assert said(post(url, ask("hello inbound"))) == "PITCH-16 says the tests pass. echo hello inbound"


def test_a_slow_answer_starts_with_filler_so_the_call_does_not_go_quiet(tmp_path: Path) -> None:
    session = Session([sys.executable, str(FAKE)], tmp_path, tmp_path / "session")
    try:
        assert list(session.ask("slow one", first=0.5)) == [FILLER, "**echo** slow one"]
    finally:
        session.stop()


def test_the_session_id_is_kept_so_a_restart_resumes_the_conversation(tmp_path: Path) -> None:
    session = Session([sys.executable, str(FAKE)], tmp_path, tmp_path / "session")
    try:
        list(session.ask("hi"))
        assert (tmp_path / "session").read_text() == "fake-session"
    finally:
        session.stop()


def test_a_request_without_the_token_is_refused(url: str) -> None:
    with pytest.raises(urllib.error.HTTPError) as refused:
        post(url, ask("hi"), token="wrong")
    assert refused.value.code == 401
