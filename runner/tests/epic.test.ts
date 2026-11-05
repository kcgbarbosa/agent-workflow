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

  // AW-1 is already Done with its archive still to do, so it goes first by key.
  expect(world.pullRequests().map((pr) => pr.headRefName)).toEqual(["docs/AW-1-archive-spec"]);
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

test("a failed archive keeps the Epic open and the link unmoved, and the next tick finishes with one pull request", async () => {
  const head = world.git(origin, "rev-parse", "main");
  world.failPullRequestCreate();

  const first = await world.tick();

  expect(first.code).toBe(1);
  expect(first.stderr).toContain("AW-1 failed");
  expect(world.jira.issues.get("AW-1")?.status).toBe("To Do");
  // The link moves after the pull request, so a Done Epic whose archive failed still shows as not archived.
  expect(description("AW-1")).toContain("blob/main");

  world.githubRepoCommit("specs", "later");
  const later = world.git(origin, "rev-parse", "main");
  expect(later).not.toBe(head);
  world.failPullRequestCreate(false);
  const second = await world.tick();

  expect(second.code, second.stderr).toBe(0);
  expect(world.pullRequests()).toHaveLength(1);
  expect(description("AW-1")).toContain(`blob/${later}/${SPEC}`);
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

test("an Epic Done before the runner ran still gets its spec archived, with no second Done", async () => {
  world.jira.issues.get("AW-1")!.status = "Done";
  const head = world.git(origin, "rev-parse", "main");

  const tick = await world.tick();

  expect(tick.code, tick.stderr).toBe(0);
  expect(world.pullRequests().map((pr) => pr.headRefName)).toEqual(["docs/AW-1-archive-spec"]);
  expect(description("AW-1")).toContain(`blob/${head}/${SPEC}`);
  expect(world.jira.writes).toEqual(["describe AW-1"]);
});

test("a Done Epic whose Spec line is at a commit is finished, and the next tick does nothing", async () => {
  world.jira.issues.get("AW-1")!.status = "Done";
  await world.tick();
  const writes = world.jira.writes.length;

  const tick = await world.tick();

  expect(tick.stdout).not.toContain("AW-1");
  expect(world.jira.writes).toHaveLength(writes);
  expect(world.pullRequests()).toHaveLength(1);
});

test("a Done Epic with no child of this repo's component is not this runner's", async () => {
  world.jira.add("AW-5", "Their Epic", { issueType: "Epic", components: [], status: "Done", description: specLine(LINK) });
  world.jira.add("AW-6", "Their ticket", { parent: "AW-5", components: ["pitchridge"], status: "Done" });
  world.jira.issues.delete("AW-1");

  const tick = await world.tick();

  expect(tick.stdout).not.toContain("AW-5");
  expect(world.pullRequests()).toEqual([]);
});

test("a Done Epic whose children predate the component is this runner's when its Spec line links this repo, as PITCH-175 is", async () => {
  world.jira.add("AW-5", "An old Epic", { issueType: "Epic", components: [], status: "Done", description: specLine(LINK) });
  world.jira.add("AW-6", "An old ticket", { parent: "AW-5", components: [], status: "Done" });
  world.jira.issues.delete("AW-1");
  world.git(world.repo, "remote", "set-url", "origin", "git@github.com:kcgbarbosa/specs.git");

  const tick = await world.tick();

  expect(tick.code, tick.stderr).toBe(0);
  expect(world.pullRequests().map((pr) => pr.headRefName)).toEqual(["docs/AW-5-archive-spec"]);
});

test("two Done Epics that link one spec open one pull request and both Spec lines move", async () => {
  world.jira.issues.get("AW-1")!.status = "Done";
  world.jira.add("AW-8", "The Runner, part two", { issueType: "Epic", components: [], status: "Done", description: specLine(LINK) });
  world.jira.add("AW-9", "Add the rest", { parent: "AW-8", status: "Done" });
  const head = world.git(origin, "rev-parse", "main");

  const tick = await world.tick();

  expect(tick.code, tick.stderr).toBe(0);
  expect(world.pullRequests().map((pr) => pr.headRefName)).toEqual(["docs/AW-1-archive-spec"]);
  for (const key of ["AW-1", "AW-8"]) expect(description(key)).toContain(`blob/${head}/${SPEC}`);
});

test("a Done Epic and a closing Epic that link one spec open one pull request", async () => {
  world.jira.issues.get("AW-1")!.status = "Done";
  world.jira.add("AW-8", "The Runner, part two", { issueType: "Epic", components: [], description: specLine(LINK) });
  world.jira.add("AW-9", "Add the rest", { parent: "AW-8", status: "Done" });

  const tick = await world.tick();

  expect(tick.code, tick.stderr).toBe(0);
  expect(world.pullRequests().map((pr) => pr.headRefName)).toEqual(["docs/AW-1-archive-spec"]);
  expect(world.jira.issues.get("AW-8")?.status).toBe("Done");
});

test("a spec a tracked file reads stays and the Done Epic keeps its link, as apex-page.md does for apex.ts", async () => {
  world.jira.issues.get("AW-1")!.status = "Done";
  // The path in pieces, as frontend/acceptance/apex.ts builds it, so only the file's name matches.
  world.githubRepoChange("specs", { "acceptance/apex.ts": "path.join(root, 'docs', 'specs', 'the-runner.md');\n" });

  const tick = await world.tick();

  expect(tick.code, tick.stderr).toBe(0);
  expect(tick.stdout).toContain("AW-1 skip: the spec stays, since acceptance/apex.ts uses it");
  expect(world.pullRequests()).toEqual([]);
  expect(description("AW-1")).toContain("blob/main");
  expect(onMain()).toContain(SPEC);
});

test("a spec an open ticket names stays, as security-findings-patches.md does for an Awaiting Approval ticket", async () => {
  world.jira.issues.get("AW-1")!.status = "Done";
  world.jira.add("AW-10", "A later fix", { status: "Awaiting Approval", description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: `Spec. ${SPEC}: The findings.` }] }] } });

  const tick = await world.tick();

  expect(tick.stdout).toContain("AW-1 skip: the spec stays, since AW-10 uses it");
  expect(world.pullRequests()).toEqual([]);
  expect(description("AW-1")).toContain("blob/main");
});

test("an Epic that closes with its spec still in use closes, and the spec goes when the last use goes", async () => {
  world.githubRepoChange("specs", { "docs/about.md": "See the-runner.md.\n" });

  const first = await world.tick();

  expect(first.stdout).toContain("AW-1 skip: the spec stays, since docs/about.md uses it");
  expect(world.jira.issues.get("AW-1")?.status).toBe("Done");
  expect(world.pullRequests()).toEqual([]);

  world.githubRepoChange("specs", {}, ["docs/about.md"]);
  const second = await world.tick();

  expect(second.code, second.stderr).toBe(0);
  expect(world.pullRequests().map((pr) => pr.headRefName)).toEqual(["docs/AW-1-archive-spec"]);
});

test("a spec deleted by hand from a Done Epic's repo gets the Spec line pinned where the spec last was, and no pull request", async () => {
  world.jira.issues.get("AW-1")!.status = "Done";
  const lastHeld = world.git(origin, "rev-parse", "main");
  world.githubRepoChange("specs", {}, [SPEC]);
  world.githubRepoCommit("specs", "later");

  const tick = await world.tick();

  expect(tick.code, tick.stderr).toBe(0);
  expect(world.pullRequests()).toEqual([]);
  expect(description("AW-1")).toContain(`blob/${lastHeld}/${SPEC}`);
});

test("a dry run names the archive of a Done Epic and writes nothing", async () => {
  world.jira.issues.get("AW-1")!.status = "Done";

  const tick = await world.dryRun();

  expect(tick.stdout).toContain("dry-run AW-1 archive");
  expect(tick.stdout).not.toContain("status Done");
  expect(world.jira.writes).toEqual([]);
});
