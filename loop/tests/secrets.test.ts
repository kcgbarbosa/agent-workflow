import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EPIC, type Watching, World } from "./world.ts";

const WORKER = "loop-demo-DEMO-2.service";
const SECRET = "a-long-jira-token-value";

let world: World;
let watching: Watching | null = null;

beforeEach(async () => {
  world = await World.create();
  world.jira.add("DEMO-2", "Add the login page", { parent: EPIC });
  world.verdicts({ "DEMO-2": "pass" });
});

afterEach(async () => {
  await watching?.close();
  watching = null;
  await world.close();
});

test("a run under the fake bws gives the agent the secrets, and the watch page masks them", async () => {
  // Another repo's stack secret, which this repo's `secrets` does not name, but `bws run` puts in the env too.
  const stack = "a-long-stack-key-of-another-repo";
  world.bws({ JIRA_EMAIL: "kc@example.com", JIRA_API_TOKEN: SECRET, NTFY_TOPIC: "topic", STACK_KEY: stack });

  const ran = await world.loop("start");

  expect(ran.code, ran.stderr).toBe(0);
  await world.until(() => world.prs().some((pr) => pr.state === "MERGED"), "the merge");
  const output = await world.untilUnitEnds(WORKER);
  expect(world.prs().map((pr) => pr.state), output).toEqual(["MERGED"]);
  const [call] = world.calls();
  expect(call!.jira_token).toBe(SECRET);
  // `bws run` keeps the machine token from the run and its agents.
  expect(call!.bws_token).toBeNull();
  await world.until(() => world.jira.notifications.includes(`${EPIC} complete`), "the Epic check");

  appendFileSync(join(world.state, "tickets", "DEMO-2", "decisions.jsonl"), JSON.stringify({ time: new Date().toISOString(), epic: "DEMO-2", ticket: "DEMO-2", step: "stuck", result: "ok", detail: `token ${SECRET}, key ${stack}` }) + "\n");
  watching = await world.watch();
  const { body: view } = await watching.get("/api/epic/DEMO-2?project=demo");

  expect(JSON.stringify(view)).not.toContain(SECRET);
  expect(JSON.stringify(view)).not.toContain(stack);
  expect(JSON.stringify(view)).toContain("[JIRA_API_TOKEN]");
  expect(JSON.stringify(view)).toContain("[STACK_KEY]");
});

test("a run refuses an env without a secret it needs", async () => {
  world.bws({ JIRA_EMAIL: "kc@example.com", JIRA_API_TOKEN: "token" });

  const ran = await world.loop("run", EPIC);

  expect(ran.code).toBe(2);
  expect(ran.stderr).toContain("The loop has no value for NTFY_TOPIC in its env.");
  expect(world.calls()).toEqual([]);
});

test("an old [secrets] entry with item and field loads with a warning", async () => {
  const path = join(world.repo, "loop.toml");
  const config = readFileSync(path, "utf8").replace(/^secrets = .*\n/m, "");
  writeFileSync(path, `${config}\n[secrets]\nJIRA_EMAIL = { item = "Jira", field = "username" }\nJIRA_API_TOKEN = { item = "Jira", field = "password" }\n`);

  const ran = await world.loop("run", EPIC);

  expect(ran.code, ran.stderr).toBe(0);
  const warnings = ran.stderr.split("\n").filter((line) => line.includes("[secrets]"));
  expect(warnings).toEqual([
    "loop.toml: [secrets] with item and field is no longer read, because Bitwarden Secrets Manager holds the values and `secrets` lists the names. The loop ignores it.",
  ]);
  expect(world.prs().map((pr) => pr.state)).toEqual(["MERGED"]);
});
