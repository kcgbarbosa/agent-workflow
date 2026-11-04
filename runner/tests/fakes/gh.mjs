// A fake `gh`. State is $FAKE_DIR/github.json, and each call is logged to $FAKE_DIR/gh.jsonl. It knows the reads and
// writes of the runner, and fails any other call. Like the real one, `pr list` gives only the fields it is asked for,
// and `pr checks` exits 8 while a check is pending and 1 when one failed or none has reported.
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

if (args[0] !== "pr") refuse("call");
if (args[1] === "list") list();
else if (args[1] === "checks") checks();
else if (args[1] === "comment") {
  byUrl().comments.push({ body: flag("--body") ?? refuse("comment"), createdAt: new Date().toISOString() });
  save();
} else if (args[1] === "merge") {
  if (!args.includes("--auto") || !args.includes("--squash")) refuse("merge");
  byUrl().autoMergeRequest = { enabledAt: new Date().toISOString() };
  save();
} else refuse("call");

function list() {
  if (flag("--state") !== "all" || !flag("--json")) refuse("list");
  const head = flag("--head");
  const term = /^"(.+)" in:title$/.exec(flag("--search") ?? "")?.[1];
  if (!head && !term) refuse("search");
  const fields = flag("--json").split(",");
  const found = pullRequests.filter((pr) => (head ? pr.headRefName === head : pr.title.includes(term)));
  console.log(JSON.stringify(found.map((pr) => Object.fromEntries(fields.map((field) => [field, pr[field]])))));
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
