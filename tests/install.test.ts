// install.sh links the repo into a fresh home and is safe to run again.
// Every run gets a temp HOME, a fake uv, a fake npm, and a fake claude, so nothing is installed for real and the checkout is never touched.
// The real claude would write through the settings.json link into config/ in the checkout.
import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";
import { REPO, tempDir } from "./repo.ts";

const SHARED_FILES = ["settings.json", "statusline.sh", "keybindings.json", "notify.sh", "format-markdown.ts"];
const SCRIPTS = ["statusline.sh", "notify.sh", "format-markdown.ts"];

function setup() {
  const dir = tempDir();
  const home = join(dir, "home");
  const claude = join(home, ".claude");
  const bin = join(dir, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  const fake = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}`, { mode: 0o755 });
  fake("uv", `echo "$@" >> "${join(dir, "uv.log")}"\n`);
  // Records its arguments, so the test can see the loop's packages would be installed.
  fake("npm", `echo "$@" >> "${join(dir, "npm.log")}"\n`);
  // Records its arguments. `mcp get` finds only a server that an earlier `mcp add` added.
  fake("claude", `log="${join(dir, "claude.log")}"\n[ "$1 $2" = "mcp get" ] && exec grep -q "^mcp add .* $3 " "$log"\necho "$@" >> "$log"\n`);
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
  const run = () => {
    const result = spawnSync(join(REPO, "install.sh"), { cwd: dir, env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result;
  };
  return { dir, home, claude, run };
}

const isLink = (path: string) => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
const linksTo = (link: string, target: string) => isLink(link) && realpathSync(link) === realpathSync(target);
const skills = () => readdirSync(join(REPO, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
const tiers = () => readdirSync(join(REPO, "agents")).filter((name) => name.endsWith(".md")).sort();
const backups = (claude: string, prefix: string) => readdirSync(claude).filter((name) => name.startsWith(prefix));

/** Each entry under root, with its link target or kind, to compare two runs. */
function snapshot(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    entries[relative(root, path)] = entry.isSymbolicLink() ? `-> ${readlinkSync(path)}` : entry.isDirectory() ? "dir" : "file";
  }
  return entries;
}

test("links every skill, tier, and CLAUDE.md, and installs the loop", () => {
  const { dir, home, claude, run } = setup();
  run();
  for (const skill of skills()) expect(linksTo(join(claude, "skills", skill), join(REPO, "skills", skill)), skill).toBe(true);
  for (const tier of tiers()) expect(linksTo(join(claude, "agents", tier), join(REPO, "agents", tier)), tier).toBe(true);
  expect(linksTo(join(claude, "CLAUDE.md"), join(REPO, "config", "CLAUDE.md"))).toBe(true);
  expect(readFileSync(join(dir, "npm.log"), "utf8")).toContain(`ci --prefix ${REPO}/loop`);
  expect(linksTo(join(home, ".local", "bin", "loop"), join(REPO, "loop", "bin", "loop"))).toBe(true);
});

test("adds each MCP server once", () => {
  const { dir, run } = setup();
  run();
  run();
  const added = readFileSync(join(dir, "claude.log"), "utf8").trim().split("\n");
  expect(added.map((line) => line.split(/\s+/).at(-2))).toEqual(["workos", "aws-mcp"]);
});

test("removes stale repo links and keeps others", () => {
  const { dir, claude, run } = setup();
  mkdirSync(join(claude, "skills"), { recursive: true });
  mkdirSync(join(claude, "agents"));
  // Paths under the repo that do not exist, as after a skill or tier is removed.
  symlinkSync(join(REPO, "skills", "no-such-skill"), join(claude, "skills", "gone"));
  symlinkSync(join(REPO, "agents", "no-such-tier.md"), join(claude, "agents", "gone.md"));
  // Links to elsewhere belong to someone else, even when they dangle.
  const elsewhere = join(dir, "elsewhere");
  symlinkSync(join(elsewhere, "skill"), join(claude, "skills", "mine"));
  symlinkSync(join(elsewhere, "tier.md"), join(claude, "agents", "mine.md"));

  run();

  expect(isLink(join(claude, "skills", "gone"))).toBe(false);
  expect(isLink(join(claude, "agents", "gone.md"))).toBe(false);
  expect(readlinkSync(join(claude, "skills", "mine"))).toBe(join(elsewhere, "skill"));
  expect(readlinkSync(join(claude, "agents", "mine.md"))).toBe(join(elsewhere, "tier.md"));
});

test("skips real files and names them", () => {
  const { claude, run } = setup();
  const skill = skills()[0];
  const tier = tiers()[0];
  mkdirSync(join(claude, "skills", skill), { recursive: true });
  writeFileSync(join(claude, "skills", skill, "keep.txt"), "mine");
  mkdirSync(join(claude, "agents"));
  writeFileSync(join(claude, "agents", tier), "my tier");
  writeFileSync(join(claude, "CLAUDE.md"), "my rules");

  const { stderr } = run();

  expect(isLink(join(claude, "skills", skill))).toBe(false);
  expect(readFileSync(join(claude, "skills", skill, "keep.txt"), "utf8")).toBe("mine");
  expect(isLink(join(claude, "agents", tier))).toBe(false);
  expect(readFileSync(join(claude, "agents", tier), "utf8")).toBe("my tier");
  expect(isLink(join(claude, "CLAUDE.md"))).toBe(false);
  expect(readFileSync(join(claude, "CLAUDE.md"), "utf8")).toBe("my rules");
  for (const name of [`skipped ${skill}`, `skipped the ${tier} tier`, "skipped CLAUDE.md"]) expect(stderr).toContain(name);
});

test("links the shared files into the repo", () => {
  const { claude, run } = setup();
  run();
  for (const name of SHARED_FILES) expect(linksTo(join(claude, name), join(REPO, "config", name)), name).toBe(true);
});

test("backs up a real file and links", () => {
  const { claude, run } = setup();
  mkdirSync(claude);
  for (const name of SHARED_FILES) writeFileSync(join(claude, name), `my ${name}`);

  const { stderr } = run();

  for (const name of SHARED_FILES) {
    expect(linksTo(join(claude, name), join(REPO, "config", name)), name).toBe(true);
    expect(readFileSync(join(claude, `${name}.bak`), "utf8")).toBe(`my ${name}`);
    expect(stderr).toContain(`moved ${join(claude, name)} to ${join(claude, name)}.bak`);
  }
});

test("keeps an old backup and uses a timestamp", () => {
  const { claude, run } = setup();
  mkdirSync(claude);
  writeFileSync(join(claude, "settings.json.bak"), "first");
  writeFileSync(join(claude, "settings.json"), "second");

  run();

  expect(readFileSync(join(claude, "settings.json.bak"), "utf8")).toBe("first");
  const stamped = backups(claude, "settings.json.bak.");
  expect(stamped).toHaveLength(1);
  expect(readFileSync(join(claude, stamped[0]), "utf8")).toBe("second");
  expect(isLink(join(claude, "settings.json"))).toBe(true);
});

test("leaves a link to somewhere else", () => {
  const { dir, claude, run } = setup();
  mkdirSync(claude);
  symlinkSync(join(dir, "elsewhere.json"), join(claude, "settings.json"));

  const { stderr } = run();

  expect(readlinkSync(join(claude, "settings.json"))).toBe(join(dir, "elsewhere.json"));
  expect(stderr).toContain("skipped settings.json");
  expect(backups(claude, "settings.json.bak")).toEqual([]);
});

test("replaces a repo link without a backup", () => {
  const { claude, run } = setup();
  mkdirSync(claude);
  symlinkSync(join(REPO, "config", "gone.sh"), join(claude, "notify.sh"));

  const { stderr } = run();

  expect(linksTo(join(claude, "notify.sh"), join(REPO, "config", "notify.sh"))).toBe(true);
  expect(backups(claude, "notify.sh.bak")).toEqual([]);
  expect(stderr).not.toContain("notify.sh");
});

test("does not warn about baseRef", () => {
  expect(setup().run().stderr).not.toContain("baseRef");
});

test("the shared settings set baseRef to head, turn updates off, and format each Markdown edit", () => {
  const settings = JSON.parse(readFileSync(join(REPO, "config", "settings.json"), "utf8"));
  expect(settings.worktree.baseRef).toBe("head");
  expect(settings.env.DISABLE_UPDATES).toBe("1");
  expect(settings.hooks.PostToolUse).toEqual([{ matcher: "Edit|Write", hooks: [{ type: "command", command: "~/.claude/format-markdown.ts" }] }]);
});

test("the shared scripts are executable", () => {
  for (const name of SCRIPTS) expect(() => accessSync(join(REPO, "config", name), constants.X_OK), name).not.toThrow();
});

test("a second run changes nothing", () => {
  const { home, claude, run } = setup();
  const first = run();
  const before = snapshot(home);
  const second = run();
  expect(snapshot(home)).toEqual(before);
  expect(second.stderr).toBe(first.stderr);
  expect(readdirSync(claude).filter((name) => name.includes(".bak"))).toEqual([]);
});

test("a second run after a backup changes nothing", () => {
  const { home, claude, run } = setup();
  mkdirSync(claude);
  writeFileSync(join(claude, "settings.json"), "mine");
  run();
  const before = snapshot(home);
  const second = run();
  expect(snapshot(home)).toEqual(before);
  expect(second.stderr).not.toContain("moved");
});
