// Each write of a tick can fail, and the next tick reads what happened. So for each scenario, failing any one write ends
// where a run with no failure ends, and repeats nothing an agent or the owner reads. A new step is covered once a scenario
// here reaches it.
import { expect, test } from "vitest";
import { specLine } from "./fakes/jira.ts";
import { type Check, World } from "./world.ts";

const RED: Check[] = [{ name: "gate / check", bucket: "fail" }];
const GREEN: Check[] = [{ name: "gate / check", bucket: "pass" }];
const SPEC = "docs/specs/the-runner.md";
const LINK = `https://github.com/kcgbarbosa/specs/blob/main/${SPEC}`;
const PR = { title: "feat(AW-1): build", headRefName: "feat/AW-1-build" };
const LONG_AGO = 600;

function epics(world: World, ...pairs: [string, string][]): void {
  world.githubRepo("specs", {
    [SPEC]: "# The Runner\n",
    "README.md": "# Specs\n",
  });
  for (const [epic, child] of pairs) {
    world.jira.add(epic, "The Runner", {
      issueType: "Epic",
      components: [],
      description: specLine(LINK),
    });
    world.jira.add(child, "Add login", { parent: epic, status: "Done" });
  }
}

const SCENARIOS: [string, (world: World) => void][] = [
  ["a ready ticket starts", (world) => world.jira.add("AW-1", "Build")],
  [
    "a pull request opens",
    (world) => {
      world.jira.add("AW-1", "Build", { status: "In Progress" });
      world.pullRequest({ ...PR, checks: GREEN });
    },
  ],
  [
    "a pull request merges",
    (world) => {
      world.jira.add("AW-1", "Build", { status: "In Review" });
      world.pullRequest({ ...PR, state: "MERGED" });
    },
  ],
  [
    "a red pull request gets a fix",
    (world) => {
      world.jira.add("AW-1", "Build", { status: "In Progress" });
      world.thread({ title: "AW-1: Build" });
      world.pullRequest({ ...PR, checks: RED });
    },
  ],
  [
    "a red pull request reaches the cap",
    (world) => {
      world.jira.add("AW-1", "Build", { status: "In Review" });
      world.thread({ title: "AW-1: Build" });
      world.pullRequest({ ...PR, checks: RED, headRefOid: "ddd444" });
      for (const [at, head] of ["aaa111", "bbb222", "ccc333"].entries())
        world.prComment(
          `Runner fix attempt ${at + 1} of 3 at ${head}: gate / check failed.`,
          30 - at,
        );
    },
  ],
  [
    "a fix turn pushes nothing",
    (world) => {
      world.jira.add("AW-1", "Build", { status: "In Review" });
      world.thread({ title: "AW-1: Build" });
      world.pullRequest({ ...PR, checks: RED });
      world.prComment(
        "Runner fix attempt 1 of 3 at aaa111: gate / check failed.",
        LONG_AGO,
      );
    },
  ],
  [
    "a thread stops with no pull request",
    (world) => {
      world.jira.add("AW-1", "Build");
      world.thread({ title: "AW-1: Build" });
    },
  ],
  [
    "a thread stops again with no pull request",
    (world) => {
      world.jira.add("AW-1", "Build", { status: "In Progress" });
      world.thread({ title: "AW-1: Build" });
      world.ticketComment(
        "AW-1",
        "Runner sent continue: the thread stopped with no pull request.",
        10,
      );
    },
  ],
  [
    "a thread waits on a question",
    (world) => {
      world.jira.add("AW-1", "Build");
      world.thread({ title: "AW-1: Build", waiting: true });
    },
  ],
  [
    "a ticket moves back to Awaiting Approval",
    (world) => {
      world.jira.add("AW-1", "Build", { status: "Awaiting Approval" });
      world.pullRequest({ ...PR, checks: GREEN });
      world.updatePullRequest({
        autoMergeRequest: { enabledAt: "2026-11-01T00:00:00Z" },
      });
    },
  ],
  [
    "a ticket leaves Awaiting Approval",
    (world) => {
      world.jira.add("AW-1", "Build", { status: "In Review" });
      world.pullRequest({ ...PR, checks: GREEN, isDraft: true });
      world.prComment("Runner hold: Awaiting Approval", 10);
    },
  ],
  [
    "an Epic closes and archives its spec",
    (world) => epics(world, ["AW-1", "AW-2"]),
  ],
  [
    "two Epics that link one spec close",
    (world) => epics(world, ["AW-1", "AW-2"], ["AW-8", "AW-9"]),
  ],
];

/** Ticks until a tick writes nothing, as the timer does. */
async function settle(world: World): Promise<void> {
  for (let tick = 0; tick < 6; tick++) {
    const before = world.writesSeen();
    await world.tick();
    if (world.writesSeen() === before) return;
  }
  throw new Error("the ticks never stopped writing");
}

/** Where a run ended. A link's commit differs between runs, so it reads as `<sha>`. */
function ending(world: World) {
  const issues = [...world.jira.issues.values()];
  return {
    tickets: issues.map(({ key, status, flagged }) => ({
      key,
      status,
      flagged,
    })),
    specLines: issues.map(({ description }) =>
      JSON.stringify(description ?? "").replace(/\b[0-9a-f]{40}\b/g, "<sha>"),
    ),
    pullRequests: world
      .pullRequests()
      .map(({ headRefName, state, isDraft, autoMergeRequest }) => ({
        headRefName,
        state,
        isDraft,
        autoMerge: Boolean(autoMergeRequest),
      })),
  };
}

/** What an agent or the owner reads, so what a repeat would show. A failed flag posts to Slack again by design, `postSteps`, so Slack is left out. */
function repeatable(world: World) {
  return {
    threads: world.starts().length,
    sends: world.sends().length,
    prComments: world.pullRequests().flatMap((pr) => pr.comments).length,
    ticketComments: [...world.jira.issues.values()].flatMap(
      (issue) => issue.comments,
    ).length,
  };
}

async function run(seed: (world: World) => void, failing: number) {
  const world = new World();
  await world.start();
  try {
    seed(world);
    world.failWrite(failing);
    await settle(world);
    return {
      writes: world.writesSeen(),
      ending: ending(world),
      repeatable: repeatable(world),
    };
  } finally {
    await world.stop();
  }
}

test.concurrent.each(SCENARIOS)(
  "%s: any one failed write ends the same, with nothing repeated",
  async (_name, seed) => {
    const clean = await run(seed, 0);
    expect(clean.writes).toBeGreaterThan(0);
    for (let number = 1; number <= clean.writes; number++) {
      const failed = await run(seed, number);
      expect({ number, ending: failed.ending }).toEqual({
        number,
        ending: clean.ending,
      });
      for (const [name, count] of Object.entries(failed.repeatable))
        expect(
          count,
          `${name} after write ${number} failed`,
        ).toBeLessThanOrEqual(
          clean.repeatable[name as keyof typeof clean.repeatable],
        );
    }
  },
  300_000,
);
