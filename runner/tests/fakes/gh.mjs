// A fake `gh`. State is $FAKE_DIR/github.json, and each call is logged to $FAKE_DIR/gh.jsonl. It knows the reads and
// writes of the runner, and fails any other call. Like the real one, `pr list` gives only the fields it is asked for,
// and `pr checks` exits 8 while a check is pending and 1 when one failed or none has reported.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const dir = process.env.FAKE_DIR;
const file = join(dir, "github.json");
const pullRequests = JSON.parse(readFileSync(file, "utf8"));
appendFileSync(join(dir, "gh.jsonl"), JSON.stringify(args) + "\n");

if (existsSync(join(dir, "gh.down"))) {
  console.error("gh: HTTP 401: Bad credentials");
  process.exit(1);
}
function flag(name) {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}
function refuse(what) {
  console.error(`fake gh: unknown ${what} ${args.join(" ")}`);
  process.exit(1);
}
function byUrl() {
  return pullRequests.find((pr) => pr.url === args[2]) ?? refuse("pull request");
}
function save() {
  writeFileSync(file, JSON.stringify(pullRequests));
}

if (args[0] === "repo" && args[1] === "clone") {
  // Each repo on the fake GitHub is a bare repo under $FAKE_DIR/repos, by its name.
  const origin = join(dir, "repos", `${args[2].split("/").at(-1)}.git`);
  if (!existsSync(origin)) refuse("repo");
  execFileSync("git", ["clone", "--quiet", origin, args[3]]);
  process.exit(0);
}
if (args[0] !== "pr") refuse("call");
if (args[1] === "list") list();
else if (args[1] === "create") create();
else if (args[1] === "checks") checks();
else if (args[1] === "comment") {
  byUrl().comments.push({ body: flag("--body") ?? refuse("comment"), createdAt: new Date().toISOString() });
  save();
} else if (args[1] === "merge") {
  if (args.includes("--disable-auto")) byUrl().autoMergeRequest = null;
  else if (args.includes("--auto") && args.includes("--squash")) {
    // Like the real one, it refuses a draft.
    if (byUrl().isDraft) refuse("merge of a draft");
    byUrl().autoMergeRequest = { enabledAt: new Date().toISOString() };
  } else refuse("merge");
  save();
} else if (args[1] === "ready") {
  byUrl().isDraft = args.includes("--undo");
  save();
} else refuse("call");

function list() {
  const state = flag("--state");
  if ((state !== "all" && state !== "open") || !flag("--json")) refuse("list");
  const head = flag("--head");
  const term = /^"(.+)" in:title$/.exec(flag("--search") ?? "")?.[1];
  if (!head && !term && state !== "open") refuse("search");
  const fields = flag("--json").split(",");
  const found = pullRequests.filter((pr) => (head ? pr.headRefName === head : !term || pr.title.includes(term)) && (state === "all" || pr.state === "OPEN"));
  console.log(JSON.stringify(found.map((pr) => Object.fromEntries(fields.map((field) => [field, pr[field]])))));
}

// Like the real one, it refuses a branch that is not on origin, and it opens against the default branch.
function create() {
  if (existsSync(join(dir, "gh.failcreate"))) {
    console.error("gh: GraphQL: was submitted too quickly");
    process.exit(1);
  }
  const head = flag("--head") ?? refuse("create");
  execFileSync("git", ["ls-remote", "--exit-code", "--quiet", "origin", `refs/heads/${head}`]);
  const number = pullRequests.length + 1;
  const url = `https://github.com/o/r/pull/${number}`;
  pullRequests.push({
    number,
    url,
    title: flag("--title") ?? refuse("create"),
    body: flag("--body") ?? refuse("create"),
    headRefName: head,
    state: "OPEN",
    isDraft: false,
    headRefOid: "aaa111",
    mergeable: "MERGEABLE",
    autoMergeRequest: null,
    comments: [],
    checks: [],
    author: { login: "kcgbarbosa" },
  });
  save();
  console.log(url);
}

function checks() {
  if (!args.includes("--required") || !flag("--json")) refuse("checks");
  const { checks: found, headRefName } = byUrl();
  if (!found.length) {
    console.error(`no required checks reported on the '${headRefName}' branch`);
    process.exit(1);
  }
  console.log(JSON.stringify(found));
  if (found.some((check) => check.bucket === "fail" || check.bucket === "cancel")) process.exit(1);
  if (found.some((check) => check.bucket === "pending")) process.exit(8);
}
