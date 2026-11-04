// A fake `gh`. State is $FAKE_DIR/github.json, and each call is logged to $FAKE_DIR/gh.jsonl. It knows the two
// reads of the runner, and fails any other call.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const dir = process.env.FAKE_DIR;
const pullRequests = JSON.parse(readFileSync(join(dir, "github.json"), "utf8"));
appendFileSync(join(dir, "gh.jsonl"), JSON.stringify(args) + "\n");

if (existsSync(join(dir, "gh.down"))) {
  console.error("gh: HTTP 401: Bad credentials");
  process.exit(1);
}
function flag(name) {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}

if (args[0] !== "pr" || args[1] !== "list" || flag("--state") !== "all" || !flag("--json")) {
  console.error(`fake gh: unknown call ${args.join(" ")}`);
  process.exit(1);
}
const head = flag("--head");
const search = flag("--search");
const term = /^"(.+)" in:title$/.exec(search ?? "")?.[1];
if (!head && !term) {
  console.error(`fake gh: unknown search ${search}`);
  process.exit(1);
}
console.log(JSON.stringify(pullRequests.filter((pr) => (head ? pr.headRefName === head : pr.title.includes(term)))));
