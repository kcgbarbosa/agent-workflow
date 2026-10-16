"""`loop start` and `loop stop`: each Epic run is a systemd user unit, and the dashboard is a user service.
The fake `systemd-run` and `systemctl` start and stop the real `loop run`."""

from __future__ import annotations

import collections
import json

from conftest import EPIC, SECRETS, TAILNET, UNIT, World
from test_crash import assert_built_once, two_tickets

from loop.units import WATCH_UNIT

WATCH = WATCH_UNIT


def stall_the_first_build(world: World) -> None:
    """DEMO-2's first build goes on until the loop stops it."""
    two_tickets(world)
    plan = json.loads((world.fakes / "plan.json").read_text())
    world.plan({**plan, "DEMO-2": [{"write": {"frontend/src/a.tsx": "a"}, "stall": 120}, {}]})


def unit_calls(world: World, tool: str, *args: str) -> list[list[str]]:
    calls = [record["args"] for record in world.records("systemd") if record["tool"] == tool]
    return [call for call in calls if all(arg in call for arg in args)]


def test_loop_start_returns_when_the_unit_is_active_and_prints_the_dashboard_address(world: World) -> None:
    stall_the_first_build(world)

    code, output = world.start()

    assert code == 0
    assert world.unit_active()
    assert f"http://{TAILNET}:8790/#/demo/{EPIC}" in output
    (run,) = unit_calls(world, "systemd-run", f"--unit={UNIT}")
    assert {"--user", "--collect", "--service-type=exec", "--property=KillMode=mixed"} <= set(run)
    assert any(arg.startswith("--setenv=PATH=") for arg in run)
    world.stop()


def test_a_second_loop_start_while_a_run_is_active_is_refused_with_the_unit_name(world: World) -> None:
    stall_the_first_build(world)
    world.start()

    code, output = world.start()

    assert code == 2
    assert UNIT in output
    assert len(unit_calls(world, "systemd-run", f"--unit={UNIT}")) == 1
    world.stop()


def test_loop_stop_ends_the_run_with_a_stopped_line_and_stops_its_stacks(world: World) -> None:
    stall_the_first_build(world)
    world.start()
    world.wait_for_call("DEMO-2")

    code, output = world.stop()

    assert code == 0
    assert not world.unit_active()
    stops = [line["result"] for line in world.decisions() if (line["ticket"], line["step"]) == (EPIC, "stop")]
    assert stops == ["stopped"]
    downs = {r["project"] for r in world.records("docker") if r["args"][:2] == ["compose", "down"]}
    assert {"demo-demo-1", "demo-demo-2"} <= downs


def test_a_start_after_a_stop_continues_the_same_tickets(world: World) -> None:
    stall_the_first_build(world)
    world.start()
    world.wait_for_call("DEMO-2")
    world.stop()

    code, _ = world.start()
    world.wait_for_run()

    assert code == 0
    assert_built_once(world, head_runs=2)
    starts = collections.Counter(line["result"] for line in world.decisions() if line["step"] == "start")
    assert starts["restart"] == 1


def test_a_failed_run_does_not_block_the_next_start_of_the_same_epic(world: World) -> None:
    two_tickets(world)
    # The run refuses a secrets file without the secrets, and its unit ends failed.
    world.write_secrets({})
    world.start()
    world.wait_for_run()

    world.write_secrets(SECRETS)
    code, _ = world.start()
    world.wait_for_run()

    assert code == 0
    assert_built_once(world)


def test_the_dashboard_keeps_running_across_a_loop_update_and_after_a_crash(world: World) -> None:
    two_tickets(world)
    world.start()
    world.wait_for_run()
    world.start(new_code=True)
    world.wait_for_run()

    (started,) = unit_calls(world, "systemd-run", f"--unit={WATCH}")
    assert "--property=Restart=always" in started
    assert world.unit_active(WATCH)
    assert unit_calls(world, "systemctl", "restart", WATCH) == [["restart", WATCH]]
