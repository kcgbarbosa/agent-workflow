import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EPIC, World } from "./world.ts";

let world: World;

beforeEach(async () => {
  world = await World.create();
  rmSync(join(world.state, "secrets.json"));
});

afterEach(async () => {
  await world.close();
});

/** A fake `bw` whose vault is unlocked, and gives `value-of-<field>-<item>` for each item but `missing`. */
function vault(status = "unlocked", missing = "none"): void {
  world.command(
    "bw",
    `#!/bin/sh
[ "$1" = status ] && { echo '{"serverUrl":null, "status": "${status}"}'; exit 0; }
[ "$1" = sync ] && exit 0
[ "$1" = get ] && [ "$3" = "${missing}" ] && { echo "Not found." >&2; exit 1; }
[ "$1" = get ] && { echo "value-of-$2-$3"; exit 0; }
exit 2
`,
  );
}

test("loop secrets copies the secrets to a file only this user reads, and a run needs no unlock", async () => {
  vault();

  const ran = await world.loop("secrets");

  expect(ran.code, ran.stderr).toBe(0);
  const path = join(world.state, "secrets.json");
  expect(ran.stdout).toContain(`The demo secrets are in ${path}. A run needs no unlock now.`);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    JIRA_EMAIL: "value-of-username-Jira",
    JIRA_API_TOKEN: "value-of-password-Jira",
    NTFY_TOPIC: "value-of-topic-ntfy",
  });
});

test("loop secrets refuses a locked vault", async () => {
  vault("locked");

  const ran = await world.loop("secrets");

  expect(ran.code).toBe(2);
  expect(ran.stderr).toContain("Bitwarden is locked. Run `export BW_SESSION=$(bw unlock --raw)` first.");
});

test("loop secrets refuses a vault without a secret of the config, and writes no file", async () => {
  vault("unlocked", "ntfy");

  const ran = await world.loop("secrets");

  expect(ran.code).toBe(2);
  expect(ran.stderr).toContain("Bitwarden has no value for ntfy (topic).");
  expect(() => statSync(join(world.state, "secrets.json"))).toThrow();
});

test("a run refuses a secrets file without a secret of the config", async () => {
  vault();
  expect((await world.loop("secrets")).code).toBe(0);
  const path = join(world.state, "secrets.json");
  const { JIRA_EMAIL } = JSON.parse(readFileSync(path, "utf8"));
  // Only the email is left.
  writeFileSync(path, JSON.stringify({ JIRA_EMAIL }));

  const ran = await world.loop("run", EPIC);

  expect(ran.code).toBe(2);
  expect(ran.stderr).toContain(`${path} has no value for JIRA_API_TOKEN, NTFY_TOPIC. Run \`export BW_SESSION=$(bw unlock --raw)\`, then \`loop secrets\`.`);
  expect(world.calls()).toEqual([]);
});
