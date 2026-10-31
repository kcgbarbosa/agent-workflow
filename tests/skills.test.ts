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
