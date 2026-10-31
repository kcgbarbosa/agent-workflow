// setup-repo's lefthook step writes the checks from what the repo has, removes a core.hooksPath, and installs the hooks.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { gitEnv, REPO, tempDir } from "./repo.ts";

const HOOKS = join(REPO, "skills", "setup-repo", "hooks.sh");

/** A repo with the given files, git added, and a fake lefthook that logs its arguments and the core.hooksPath it saw. */
function repo(files: Record<string, string>) {
  const dir = tempDir();
  const bin = join(dir, "bin");
  const work = join(dir, "work");
  const log = join(dir, "lefthook.log");
  mkdirSync(bin);
  mkdirSync(work);
  writeFileSync(join(bin, "lefthook"), `#!/bin/sh\necho "$* hooksPath=$(git config core.hooksPath)" >> "${log}"\n`, { mode: 0o755 });
  const env = { ...gitEnv(dir), PATH: `${bin}:${process.env.PATH}` };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(work, name)), { recursive: true });
    writeFileSync(join(work, name), text);
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: work, env, encoding: "utf8" });
  git("init", "-q");
  git("add", ".");
  const run = () => {
    const result = spawnSync(HOOKS, { cwd: work, env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result;
  };
  return { work, log, git, run };
}

const commands = (work: string) => [...readFileSync(join(work, "lefthook.yml"), "utf8").matchAll(/^ {4}([\w-]+):$/gm)].map((match) => match[1]);

test("a docs-only repo gets Prettier, gitleaks, and lychee", () => {
  const { work, run } = repo({ "README.md": "# app\n" });
  run();
  expect(commands(work)).toEqual(["prettier", "gitleaks", "lychee"]);
});

test("each language the repo has adds its checks", () => {
  const { work, run } = repo({ "app/pyproject.toml": "[project]\n", "web/tsconfig.json": "{}\n", "web/package.json": "{}\n", "bin/deploy.sh": "#!/bin/sh\n" });
  run();
  expect(commands(work)).toEqual(["prettier", "gitleaks", "lychee", "ruff-format", "ruff-check", "oxlint", "tsc", "shellcheck"]);
  expect(readFileSync(join(work, "lefthook.yml"), "utf8")).toContain("cd web && npx tsc --noEmit");
});

test("removes core.hooksPath, then installs the hooks", () => {
  const { log, git, run } = repo({ "README.md": "# app\n" });
  git("config", "core.hooksPath", ".githooks");
  run();
  expect(readFileSync(log, "utf8")).toBe("install hooksPath=\n");
  expect(spawnSync("git", ["config", "--local", "core.hooksPath"], { cwd: dirname(log) + "/work" }).status).toBe(1);
});

test("keeps a lefthook file the repo has, and a second run changes nothing", () => {
  const { work, run } = repo({ "lefthook.yml": "pre-commit:\n  commands: {}\n", "web/tsconfig.json": "{}\n" });
  run();
  run();
  expect(readFileSync(join(work, "lefthook.yml"), "utf8")).toBe("pre-commit:\n  commands: {}\n");
});
