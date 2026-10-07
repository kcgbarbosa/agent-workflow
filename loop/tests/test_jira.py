"""The Jira client sends a read again when the network or a busy Jira fails it, and a write once."""

from __future__ import annotations

import socket
from collections.abc import Iterator

import pytest
from fake_jira import FakeJira

from loop.jira import Jira, JiraError


@pytest.fixture
def fake() -> Iterator[FakeJira]:
    jira = FakeJira()
    jira.add("DEMO-1", "The Loop", issue_type="Epic")
    jira.add("DEMO-2", "Add the first part", parent="DEMO-1")
    yield jira
    jira.close()


def client(url: str, sleeps: list[float]) -> Jira:
    return Jira(url, "kc@example.com", "secret-token", sleep=sleeps.append)


def test_a_read_waits_and_tries_again_when_jira_is_busy(fake: FakeJira) -> None:
    sleeps: list[float] = []
    fake.errors = [503, 429]

    assert client(fake.url, sleeps).issue("DEMO-2").summary == "Add the first part"

    # The backoff first, then the 7 seconds that the 429 asks for.
    assert sleeps == [5.0, 7.0]


def test_the_search_is_a_read_and_tries_again(fake: FakeJira) -> None:
    sleeps: list[float] = []
    jira = client(fake.url, sleeps)
    jira.flagged_field()
    fake.errors = [502]

    assert [ticket.key for ticket in jira.children("DEMO-1")] == ["DEMO-2"]
    assert sleeps == [5.0]


def test_a_write_is_sent_once(fake: FakeJira) -> None:
    sleeps: list[float] = []
    fake.errors = [503]

    with pytest.raises(JiraError, match="HTTP 503"):
        client(fake.url, sleeps).comment("DEMO-2", "The loop stopped this ticket.")

    assert sleeps == []
    assert fake.issues["DEMO-2"].comments == []


def test_a_read_gives_up_after_a_few_attempts_when_jira_does_not_answer() -> None:
    with socket.socket() as closed:
        closed.bind(("127.0.0.1", 0))
        url = f"http://127.0.0.1:{closed.getsockname()[1]}"
    sleeps: list[float] = []

    with pytest.raises(JiraError, match="GET /rest/api/3/myself"):
        client(url, sleeps).check_access()

    assert sleeps == [5.0, 10.0, 20.0]


def test_a_refused_read_is_not_sent_again(fake: FakeJira) -> None:
    sleeps: list[float] = []
    fake.errors = [401]

    with pytest.raises(JiraError, match="HTTP 401"):
        client(fake.url, sleeps).check_access()

    assert sleeps == []
