import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ConfigError, load } from "../src/config.ts";

const dir = mkdtempSync(join(tmpdir(), "runner-config-"));
const REQUIRED = 'component = "agent-workflow"\njira_url = "https://example.atlassian.net"\n';

afterEach(() => rmSync(join(dir, "runner.toml"), { force: true }));
function loaded(text: string) {
  writeFileSync(join(dir, "runner.toml"), text);
  return load(dir);
}

test("the defaults load", () => {
  expect(loaded(REQUIRED)).toEqual({
    component: "agent-workflow",
    jiraUrl: "https://example.atlassian.net",
    mainBranch: "main",
    limit: 3,
    fixAttempts: 3,
    quietMinutes: 60,
    provider: "claudeAgent",
    model: "claude-opus-5-5",
    firstMessage: "",
  });
});

test("each value can change", () => {
  const config = loaded(
    REQUIRED +
      'main_branch = "trunk"\nlimit = 0\nfix_attempts = 5\nquiet_minutes = 90\nprovider = "codex"\nmodel = "gpt-9"\nfirst_message = "Mind the stack."\n',
  );
  expect(config).toMatchObject({ mainBranch: "trunk", limit: 0, fixAttempts: 5, quietMinutes: 90, provider: "codex", model: "gpt-9", firstMessage: "Mind the stack." });
});

test.each([
  ["a missing key", 'jira_url = "https://example.atlassian.net"\n', "component"],
  ["an unknown key", REQUIRED + "limits = 2\n", "limits"],
  ["a wrong type", REQUIRED + 'limit = "two"\n', "limit"],
  ["a negative count", REQUIRED + "limit = -1\n", "limit"],
  ["a broken file", "limit = \n", "runner.toml"],
])("%s is refused", (_name, text, named) => {
  expect(() => loaded(text)).toThrow(ConfigError);
  expect(() => loaded(text)).toThrow(named);
});

test("a repo with no file is refused", () => {
  expect(() => load(dir)).toThrow(ConfigError);
});
