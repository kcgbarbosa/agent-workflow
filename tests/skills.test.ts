// Each skill's SKILL.md starts with frontmatter that names its folder and describes it.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { REPO } from "./repo.ts";

const FIELD = /^([A-Za-z][\w-]*):\s*(.*)$/;

function frontmatter(text: string): Map<string, string> | undefined {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return undefined;
  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    if (line === "---") return fields;
    const match = FIELD.exec(line);
    if (match) fields.set(match[1], match[2].trim().replace(/^["']+|["']+$/g, "").trim());
  }
  return undefined;
}

test("each skill has a name and a description", () => {
  const skills = join(REPO, "skills");
  const failures: string[] = [];
  for (const name of readdirSync(skills).sort()) {
    const skill = join(skills, name, "SKILL.md");
    // A folder without a SKILL.md, such as a mod with `.claude-plugin/plugin.json`, is not a skill.
    if (!statSync(join(skills, name)).isDirectory() || !existsSync(skill)) continue;
    const fields = frontmatter(readFileSync(skill, "utf8"));
    if (!fields) failures.push(`${name}: no frontmatter`);
    else {
      if (fields.get("name") !== name) failures.push(`${name}: name is ${fields.get("name")}`);
      if (!fields.get("description")) failures.push(`${name}: no description`);
    }
  }
  expect(failures).toEqual([]);
});

const userOnly = (name: string) => frontmatter(readFileSync(join(REPO, "skills", name, "SKILL.md"), "utf8"))?.get("disable-model-invocation") === "true";

// The texts that tell an agent to run a skill. Each `.md` in `tasks/` is a scheduled task.
function textsToAgents(): string[] {
  const inFolder = (folder: string, extension: string) =>
    readdirSync(join(REPO, folder))
      .filter((name) => name.endsWith(extension))
      .map((name) => readFileSync(join(REPO, folder, name), "utf8"));
  return [...inFolder("runner/src", ".ts"), readFileSync(join(REPO, "bots/chief.md"), "utf8"), ...inFolder("tasks", ".md")];
}

// `/implement`, and the Chief's "through `to-bug`". A path such as `src/implement`, and the Chief's "no `to-tickets`", name nothing.
const SKILL_NAMED = /(?<![\w./-])\/([a-z][a-z-]*)|through `([a-z][a-z-]*)`/g;

test("no skill an agent is told to run is user-only", () => {
  const skills = new Set(readdirSync(join(REPO, "skills")).filter((name) => existsSync(join(REPO, "skills", name, "SKILL.md"))));
  const named = new Set(
    textsToAgents()
      .flatMap((text) => [...text.matchAll(SKILL_NAMED)].map((match) => match[1] ?? match[2]))
      .filter((name) => skills.has(name)),
  );
  for (const name of ["implement", "pr", "to-bug", "correct"]) expect(named).toContain(name);
  expect([...named].filter(userOnly)).toEqual([]);
});

test("the skills no agent starts on its own stay user-only", () => {
  const skills = ["grill-with-docs", "grill-me", "to-spec", "to-prd", "to-tickets", "handoff", "teach", "setup-repo", "setup-runner", "interrogate"];
  expect(skills.filter((name) => !userOnly(name))).toEqual([]);
});
