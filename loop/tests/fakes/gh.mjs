// The fake `gh`. It keeps the pull requests and their check runs in FAKE_DIR/github.json, and records each
// call in FAKE_DIR/gh.jsonl. A pull request with auto-merge on merges as a squash into the bare origin
// (FAKE_ORIGIN) once every check passes. A new pull request's check takes its bucket from
// FAKE_DIR/verdicts.json by ticket key, else it stays pending until a test sets it.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const fakes = process.env.FAKE_DIR;
const origin = process.env.FAKE_ORIGIN;
const store = join(fakes, "github.json");
const args = process.argv.slice(2);
appendFileSync(join(fakes, "gh.jsonl"), JSON.stringify({ args }) + "\n");

const state = existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : { prs: [] };
const save = () => writeFileSync(store, JSON.stringify(state, null, 2));
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const find = (url) => {
  const pr = state.prs.find((item) => item.url === url || String(item.number) === url);
  if (!pr) fail(`no pull requests found for ${url}`);
  return pr;
};
const fail = (message, code = 1) => {
  process.stderr.write(message + "\n");
  process.exit(code);
};
const STATES = { pass: "SUCCESS", fail: "FAILURE", pending: "PENDING", skipping: "SKIPPED", cancel: "CANCELLED" };
const green = (pr) => pr.checks.length > 0 && pr.checks.every((check) => check.bucket === "pass" || check.bucket === "skipping");
const git = (...command) => execFileSync("git", ["-C", origin, ...command], { encoding: "utf8" }).trim();

function squash(pr) {
  const base = `refs/heads/${pr.baseRefName}`;
  const tree = git("merge-tree", "--write-tree", base, `refs/heads/${pr.headRefName}`).split("\n")[0];
  const commit = git("commit-tree", tree, "-p", base, "-m", `${pr.title} (#${pr.number})`);
  git("update-ref", base, commit);
  git("update-ref", "-d", `refs/heads/${pr.headRefName}`);
  pr.state = "MERGED";
  pr.mergeCommit = { oid: commit };
}

// GitHub merges a pull request with auto-merge on as soon as its checks are green. A call that changes
// nothing leaves the file alone, so a test's own write to it is never lost.
let settled = false;
for (const pr of state.prs) {
  if (pr.state === "OPEN" && pr.autoMerge && green(pr)) {
    squash(pr);
    settled = true;
  }
}
if (settled) save();

const [noun, verb] = args;
const show = (pr) => {
  const { checks, body, autoMerge, ...rest } = pr;
  return { ...rest, autoMergeRequest: autoMerge };
};
if (noun !== "pr") fail(`fake gh: no ${noun}`);
if (verb === "list") {
  const wanted = option("state") ?? "open";
  const head = option("head");
  const prs = state.prs.filter(
    (pr) => (wanted === "all" || pr.state === wanted.toUpperCase()) && (head === undefined || pr.headRefName === head),
  );
  // Newest first, and 30 unless `--limit` says otherwise, as gh lists them.
  const limit = Number(option("limit") ?? 30);
  console.log(JSON.stringify(prs.reverse().slice(0, limit).map(show)));
} else if (verb === "view") {
  console.log(JSON.stringify(show(find(args[2]))));
} else if (verb === "create") {
  const head = option("head");
  const number = 100 + state.prs.length;
  const key = /^(?:feat|fix)\/([A-Z][A-Z0-9]*-\d+)-/.exec(head)?.[1];
  const verdicts = existsSync(join(fakes, "verdicts.json")) ? JSON.parse(readFileSync(join(fakes, "verdicts.json"), "utf8")) : {};
  const bucket = verdicts[key] ?? "pending";
  state.prs.push({
    number,
    url: `https://github.com/kcgbarbosa/demo/pull/${number}`,
    headRefName: head,
    baseRefName: option("base"),
    title: option("title"),
    body: readFileSync(option("body-file"), "utf8"),
    state: "OPEN",
    autoMerge: null,
    mergeCommit: null,
    checks: [{ name: "gate / check", bucket, state: STATES[bucket] }],
  });
  save();
  console.log(`https://github.com/kcgbarbosa/demo/pull/${number}`);
} else if (verb === "merge") {
  const pr = find(args[2]);
  if (pr.state !== "OPEN") fail(`Pull request #${pr.number} is not open`);
  if (args.includes("--auto")) pr.autoMerge = { mergeMethod: args.includes("--squash") ? "SQUASH" : "MERGE" };
  else if (green(pr)) squash(pr);
  else fail(`Pull request #${pr.number} is not mergeable: the base branch policy prohibits the merge.`);
  if (pr.autoMerge && green(pr)) squash(pr);
  save();
} else if (verb === "checks") {
  const pr = find(args[2]);
  if (!pr.checks.length) fail(`no checks reported on the '${pr.headRefName}' branch`);
  console.log(JSON.stringify(pr.checks));
  if (pr.checks.some((check) => check.bucket === "fail" || check.bucket === "cancel")) process.exit(1);
  if (pr.checks.some((check) => check.bucket === "pending")) process.exit(8);
} else {
  fail(`fake gh: no pr ${verb}`);
}
