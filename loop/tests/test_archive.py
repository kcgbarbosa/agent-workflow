"""The Archive spec button of `loop watch`: after the Epic PR merges, a PR deletes the spec from main, and the
Epic links the spec at the merge commit. Each test clicks it as the page does, against a real git origin, the
fake `gh`, and the fake Jira."""

from __future__ import annotations

import json
from typing import Any

from conftest import EPIC, SECRETS, World, sh, write_config

from loop import config
from loop.watch import Watch

SPEC = "docs/product/specs/the-loop.md"
REPO_URL = "https://github.com/kcgbarbosa/demo"
EPIC_BRANCH = f"feat/{EPIC}-the-loop"
ARCHIVE_BRANCH = f"docs/{EPIC}-archive-spec"
EPIC_PR = f"{REPO_URL}/pull/98"
LINK = f"{REPO_URL}/blob/main/{SPEC}"


def description(url: str) -> dict[str, Any]:
    """The Spec line of a PRD, with the link as text and as a link target."""
    text = {"type": "text", "text": url, "marks": [{"type": "link", "attrs": {"href": url}}]}
    spec = [{"type": "text", "text": "Spec. ", "marks": [{"type": "strong"}]}, text]
    return {"type": "doc", "version": 1, "content": [{"type": "paragraph", "content": spec}]}


def finished_epic(world: World) -> Watch:
    """An Epic whose run opened its PR, with the spec on main, as the page of the demo project sees it."""
    (world.repo / SPEC).parent.mkdir(parents=True)
    (world.repo / SPEC).write_text("# The Loop\n")
    sh(world.repo, "git", "add", "-A")
    sh(world.repo, "git", "commit", "-q", "-m", "docs: add the spec of the loop")
    sh(world.repo, "git", "push", "-q", "origin", "main")
    world.push_branch(EPIC_BRANCH, {"a.txt": "a"})
    world.jira.issues[EPIC].description = description(LINK)
    pr = {"url": EPIC_PR, "head": EPIC_BRANCH, "base": "main", "title": f"feat({EPIC}): the Loop"}
    (world.fakes / "prs.json").write_text(json.dumps([{**pr, "body": "", "draft": False, "state": "open"}]))
    home = world.state / EPIC
    home.mkdir(parents=True)
    lines = [
        {"time": "2026-10-20T10:00:00+00:00", "ticket": EPIC, "step": "start", "result": "ok"},
        {"time": "2026-10-20T11:00:00+00:00", "ticket": EPIC, "step": "pr", "result": "pr-open"},
    ]
    lines[0]["detail"], lines[1]["detail"] = EPIC_BRANCH, EPIC_PR
    (home / "decisions.jsonl").write_text("".join(json.dumps(line) + "\n" for line in lines))
    board = {"summary": "The Loop", "branch": EPIC_BRANCH, "tickets": []}
    (home / "board.json").write_text(json.dumps(board))
    write_config(world.repo, world.jira.url)
    world.write_secrets(SECRETS)
    return Watch(world.state, config=config.load(world.repo))


def merge(world: World, head: str) -> str:
    """Merges the PR of the branch into main on origin, as the owner does, and returns the merge commit."""
    sh(world.repo, "git", "fetch", "-q", "origin")
    sh(world.repo, "git", "merge", "-q", "--no-ff", "-m", f"Merge {head}", f"origin/{head}")
    sh(world.repo, "git", "push", "-q", "origin", "main")
    commit = sh(world.repo, "git", "rev-parse", "HEAD")
    prs = world.prs()
    for pr in prs:
        if pr["head"] == head:
            pr.update(state="merged", merge_commit=commit)
    (world.fakes / "prs.json").write_text(json.dumps(prs))
    return commit


def click(watch: Watch, key: str = EPIC, project: str = "demo") -> tuple[int, Any]:
    status, _, body = watch.post(f"/api/archive/{key}?project={project}")
    return status, json.loads(body)


def writes(world: World) -> list[tuple[str, str]]:
    return [(method, path) for method, path in world.jira.requests if method != "GET"]


def files(world: World, ref: str) -> list[str]:
    """The files of the ref on origin."""
    return sh(world.origin, "git", "ls-tree", "-r", "--name-only", ref).splitlines()


def archive_lines(world: World) -> list[tuple[str, str]]:
    return [(line["result"], line["detail"]) for line in world.decisions() if line["step"] == "archive"]


def test_the_home_page_offers_the_button_from_the_log_with_no_github_call(world: World) -> None:
    watch = finished_epic(world)

    home = json.loads(watch.handle("/api/home")[2])

    assert [(run["key"], run["pr_url"]) for run in home[0]["runs"]] == [(EPIC, EPIC_PR)]
    assert world.gh() == []


def test_before_the_epic_pr_merges_the_button_changes_nothing(world: World) -> None:
    watch = finished_epic(world)

    answer = click(watch)

    assert answer == (200, {"message": "Merge the Epic PR first.", "url": EPIC_PR})
    assert writes(world) == []
    assert world.gh("pr", "create") == []
    assert ARCHIVE_BRANCH not in sh(world.origin, "git", "branch", "--list")
    assert world.jira.issues[EPIC].description == description(LINK)
    assert archive_lines(world) == [("not-merged", EPIC_PR)]


def test_after_the_merge_a_pr_deletes_the_spec_and_the_epic_links_it_at_the_merge_commit(
    world: World,
) -> None:
    watch = finished_epic(world)
    commit = merge(world, EPIC_BRANCH)

    answer = click(watch)

    (pr,) = world.gh("pr", "create")
    url = f"{REPO_URL}/pull/100"
    pinned = f"{REPO_URL}/blob/{commit}/{SPEC}"
    assert answer == (200, {"message": f"Archived. Merge {url}.", "url": url})
    assert world.jira.issues[EPIC].description == description(pinned)
    assert SPEC in files(world, "main")
    assert set(files(world, "main")) - set(files(world, ARCHIVE_BRANCH)) == {SPEC}
    subject = sh(world.origin, "git", "log", "-1", "--format=%s", ARCHIVE_BRANCH)
    assert subject == "docs: archive the spec of the Loop"
    created = world.prs()[-1]
    assert (created["head"], created["base"], created["title"]) == (ARCHIVE_BRANCH, "main", subject)
    assert pinned in pr["body"]
    assert EPIC not in created["title"] + created["body"]
    assert not (world.state / EPIC / "worktrees" / "archive-spec").exists()
    assert archive_lines(world) == [("pr-open", url)]


def test_a_second_click_names_the_open_archive_pr_and_writes_nothing(world: World) -> None:
    watch = finished_epic(world)
    merge(world, EPIC_BRANCH)
    click(watch)
    before = (len(writes(world)), sh(world.origin, "git", "rev-parse", ARCHIVE_BRANCH))

    answer = click(watch)

    url = f"{REPO_URL}/pull/100"
    assert answer == (200, {"message": f"The archive PR is open: {url}.", "url": url})
    assert (len(writes(world)), sh(world.origin, "git", "rev-parse", ARCHIVE_BRANCH)) == before
    assert len(world.gh("pr", "create")) == 1
    assert archive_lines(world)[-1] == ("pr-open", url)


def test_once_the_archive_pr_merges_the_epic_is_already_archived(world: World) -> None:
    watch = finished_epic(world)
    merge(world, EPIC_BRANCH)
    click(watch)
    merge(world, ARCHIVE_BRANCH)
    before = len(writes(world))

    answer = click(watch)

    assert answer == (200, {"message": "Already archived.", "url": ""})
    assert len(writes(world)) == before
    assert len(world.gh("pr", "create")) == 1
    assert archive_lines(world)[-1] == ("archived", "")


def test_the_button_acts_only_on_the_epics_of_the_project_that_started_the_page(world: World) -> None:
    watch = finished_epic(world)
    merge(world, EPIC_BRANCH)

    archived = click(watch, project="other")
    stopped = watch.post(f"/api/stop/{EPIC}?project=other")
    unknown = click(watch, key="OTHER-1")
    no_project = Watch(world.state).post(f"/api/archive/{EPIC}")

    refusal = {"error": "This page acts only on the runs of demo."}
    assert archived == (409, refusal)
    assert (stopped[0], json.loads(stopped[2])) == (409, refusal)
    assert unknown == (409, {"error": "The demo project has no run of OTHER-1 on this host."})
    assert no_project[0] == 404
    assert writes(world) == []
    assert world.gh("pr") == []
    assert archive_lines(world) == []
