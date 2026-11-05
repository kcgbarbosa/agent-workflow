import { afterEach, beforeEach, expect, test } from "vitest";
import { specLine } from "./fakes/jira.ts";
import { World } from "./world.ts";

const SPEC = "docs/specs/the-runner.md";
const REPO = "https://github.com/kcgbarbosa/specs";
const LINK = `${REPO}/blob/main/${SPEC}`;

let world: World;
let origin: string;

beforeEach(async () => {
  world = new World();
  await world.start();
  origin = world.githubRepo("specs", { [SPEC]: "# The Runner\n", "README.md": "# Specs\n" });
  world.jira.add("AW-1", "The Runner", { issueType: "Epic", components: [], description: specLine(LINK) });
  world.jira.add("AW-2", "Add login", { parent: "AW-1", status: "Done" });
  world.jira.add("AW-3", "Add logout", { parent: "AW-1", status: "Done" });
});

afterEach(async () => {
  await world.stop();
});

function description(key: string): string {
  return JSON.stringify(world.jira.issues.get(key)?.description);
}

function onMain(): string {
  return world.git(origin, "ls-tree", "-r", "--name-only", "main");
}

test("the last child going Done sets the Epic Done on the next tick", async () => {
  world.jira.issues.get("AW-3")!.status = "In Review";
  world.pullRequest({ title: "feat(AW-3): Add logout", headRefName: "feat/AW-3-add-logout", state: "MERGED" });

  const first = await world.tick();

  expect(first.code, first.stderr).toBe(0);
  expect(world.jira.issues.get("AW-3")?.status).toBe("Done");
  expect(world.jira.issues.get("AW-1")?.status).toBe("To Do");

  const second = await world.tick();

  expect(second.code, second.stderr).toBe(0);
  expect(world.jira.issues.get("AW-1")?.status).toBe("Done");
  expect(second.stdout).toContain("AW-1 status Done");
});

test("an Epic with a child still open stays open and logs why", async () => {
  world.jira.issues.get("AW-3")!.status = "In Progress";
  world.jira.issues.get("AW-3")!.flagged = true;

  const tick = await world.tick();

  expect(tick.stdout).toContain("AW-1 skip: AW-3 is not Done");
  expect(world.jira.issues.get("AW-1")?.status).toBe("To Do");
  expect(world.pullRequests()).toEqual([]);
});

test("a child of another component's repo that is still open holds the Epic", async () => {
  world.jira.add("AW-4", "Their ticket", { parent: "AW-1", components: ["pitchridge"] });

  await world.tick();

  expect(world.jira.issues.get("AW-1")?.status).toBe("To Do");
});

test("an Epic with no child in this repo's component is not this runner's", async () => {
  world.jira.add("AW-5", "Their Epic", { issueType: "Epic", components: [] });
  world.jira.add("AW-6", "Their ticket", { parent: "AW-5", components: ["pitchridge"], status: "Done" });
  world.jira.add("AW-7", "An empty Epic", { issueType: "Epic", components: [] });

  const tick = await world.tick();

  expect(tick.stdout).not.toContain("AW-5");
  expect(tick.stdout).not.toContain("AW-7");
  expect(world.jira.issues.get("AW-5")?.status).toBe("To Do");
  expect(world.jira.issues.get("AW-7")?.status).toBe("To Do");
});

test("every Epic that links the spec Done opens a pull request that deletes it, and the Spec line points at the head of main", async () => {
  const head = world.git(origin, "rev-parse", "main");

  const tick = await world.tick();

  expect(tick.code, tick.stderr).toBe(0);
  const [pr, ...others] = world.pullRequests();
  expect(others).toEqual([]);
  expect(pr).toMatchObject({ title: "docs(AW-1): archive the spec of the Runner", headRefName: "docs/AW-1-archive-spec", state: "OPEN" });
  expect(pr.autoMergeRequest).not.toBeNull();
  expect(pr.body).toContain(`${REPO}/blob/${head}/${SPEC}`);
  // The branch deletes the spec and nothing else, and main keeps it until the pull request merges.
  expect(world.git(origin, "diff", "--name-status", "main", "docs/AW-1-archive-spec")).toBe(`D\t${SPEC}`);
  expect(world.git(origin, "log", "-1", "--format=%s", "docs/AW-1-archive-spec")).toBe("docs(AW-1): archive the spec of the Runner");
  expect(onMain()).toContain(SPEC);
  // Both the text and the target of the link move.
  expect(description("AW-1")).not.toContain("blob/main");
  expect(description("AW-1").split(`blob/${head}/${SPEC}`)).toHaveLength(3);
  expect(world.jira.issues.get("AW-1")?.status).toBe("Done");
  expect(world.jira.writes.filter((write) => write.includes("AW-1"))).toEqual(["describe AW-1", "transition AW-1 Done"]);
  expect(tick.stdout).toContain(`AW-1 archive: the pull request ${pr.url} deletes ${SPEC}`);
  // A notification means the owner must act, and this needs nothing of them.
  expect(world.slack.posts).toEqual([]);
});

test("a dry run prints the archive and the Done, and writes nothing", async () => {
  const before = world.git(origin, "rev-parse", "--all");

  const tick = await world.dryRun();

  expect(tick.code, tick.stderr).toBe(0);
  expect(tick.stdout).toContain("dry-run AW-1 archive");
  expect(tick.stdout).toContain("dry-run AW-1 status Done");
  expect(world.jira.writes).toEqual([]);
  expect(world.pullRequests()).toEqual([]);
  expect(world.git(origin, "rev-parse", "--all")).toBe(before);
});

test("a spec that another Epic links stays until that Epic is Done, and then both Spec lines move", async () => {
  world.jira.add("AW-8", "The Runner, part two", { issueType: "Epic", components: [], description: specLine(LINK) });
  world.jira.add("AW-9", "Add the rest", { parent: "AW-8", status: "In Progress", flagged: true });

  const first = await world.tick();

  expect(first.stdout).toContain("AW-1 skip: the spec stays, since AW-8 links it and is not Done");
  expect(world.jira.issues.get("AW-1")?.status).toBe("Done");
  expect(world.pullRequests()).toEqual([]);
  expect(description("AW-1")).toContain("blob/main");

  world.jira.issues.get("AW-9")!.status = "Done";
  const head = world.git(origin, "rev-parse", "main");
  await world.tick();

  expect(world.pullRequests().map((pr) => pr.headRefName)).toEqual(["docs/AW-8-archive-spec"]);
  expect(world.jira.issues.get("AW-8")?.status).toBe("Done");
  for (const key of ["AW-1", "AW-8"]) expect(description(key)).toContain(`blob/${head}/${SPEC}`);
  for (const key of ["AW-1", "AW-8"]) expect(description(key)).not.toContain("blob/main");
});

test("two Epics that link one spec and close on one tick open one pull request", async () => {
  world.jira.add("AW-8", "The Runner, part two", { issueType: "Epic", components: [], description: specLine(LINK) });
  world.jira.add("AW-9", "Add the rest", { parent: "AW-8", status: "Done" });
  const head = world.git(origin, "rev-parse", "main");

  const tick = await world.tick();

  expect(tick.code, tick.stderr).toBe(0);
  expect(world.pullRequests().map((pr) => pr.headRefName)).toEqual(["docs/AW-1-archive-spec"]);
  for (const key of ["AW-1", "AW-8"]) {
    expect(world.jira.issues.get(key)?.status).toBe("Done");
    expect(description(key)).toContain(`blob/${head}/${SPEC}`);
  }
});

test("a failed archive keeps the Epic open, and the next tick finishes with one pull request and the first pin", async () => {
  const head = world.git(origin, "rev-parse", "main");
  world.failPullRequestCreate();

  const first = await world.tick();

  expect(first.code).toBe(1);
  expect(first.stderr).toContain("AW-1 failed");
  expect(world.jira.issues.get("AW-1")?.status).toBe("To Do");
  expect(description("AW-1")).toContain(`blob/${head}/${SPEC}`);

  // Main moves on, and the Spec line stays at the commit it was first pinned to.
  world.githubRepoCommit("specs", "later");
  world.failPullRequestCreate(false);
  const second = await world.tick();

  expect(second.code, second.stderr).toBe(0);
  expect(world.pullRequests()).toHaveLength(1);
  expect(description("AW-1")).toContain(`blob/${head}/${SPEC}`);
  expect(world.jira.issues.get("AW-1")?.status).toBe("Done");
});

test("an archive pull request already open is the one that gets auto-merge", async () => {
  world.pullRequest({ title: "docs(AW-1): archive the spec of the Runner", headRefName: "docs/AW-1-archive-spec" });

  const tick = await world.tick();

  expect(tick.code, tick.stderr).toBe(0);
  expect(world.pullRequests()).toHaveLength(1);
  expect(world.pullRequests()[0].autoMergeRequest).not.toBeNull();
  expect(world.jira.issues.get("AW-1")?.status).toBe("Done");
});

test("a spec already off main opens no pull request and the Epic closes", async () => {
  world.jira.issues.get("AW-1")!.description = specLine(`${REPO}/blob/main/docs/specs/gone.md`);

  const tick = await world.tick();

  expect(tick.code, tick.stderr).toBe(0);
  expect(world.pullRequests()).toEqual([]);
  expect(world.jira.issues.get("AW-1")?.status).toBe("Done");
});

test("an Epic with no Spec line closes with no pull request", async () => {
  world.jira.issues.get("AW-1")!.description = null;

  const tick = await world.tick();

  expect(tick.code, tick.stderr).toBe(0);
  expect(tick.stdout).toContain("AW-1 skip: its description has no Spec line that links a spec");
  expect(world.pullRequests()).toEqual([]);
  expect(world.jira.issues.get("AW-1")?.status).toBe("Done");
});

test("a failed read of an Epic's children fails the tick with no writes", async () => {
  world.jira.add("AW-10", "Add a page");
  world.jira.down = 500;

  const tick = await world.tick();

  expect(tick.code).toBe(1);
  expect(world.jira.writes).toEqual([]);
  expect(world.starts()).toEqual([]);
});
