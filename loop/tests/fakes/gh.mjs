// The fake `gh`. It keeps the pull requests and their check runs in FAKE_DIR/github.json, and records each
// call in FAKE_DIR/gh.jsonl. A pull request with auto-merge on merges as a squash into the bare origin
// (FAKE_ORIGIN) once every check passes. Each push to a pull request's branch runs its check again, which
// takes its bucket from FAKE_DIR/verdicts.json by ticket key: one bucket, or one per push with the last one
// kept. With no verdict, the check stays pending until a test sets it. A failed job's log is
// FAKE_DIR/job-log.txt. GitHub retargets the pull requests on a merged branch to its base, unless
// FAKE_DIR/no-retarget exists. A new pull request gets the review of FAKE_DIR/reviews.json by ticket key, in
// the shape the gate's review posts: the findings in the diff as comments, and the others in the body. A draft
// pull request does not merge, as on GitHub. Auto-merge also waits for each check that FAKE_DIR/required.json
// names to report, as branch protection's required checks do.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const fakes = process.env.FAKE_DIR;
const origin = process.env.FAKE_ORIGIN;
const store = join(fakes, "github.json");
const args = process.argv.slice(2);
appendFileSync(join(fakes, "gh.jsonl"), JSON.stringify({ args }) + "\n");

// One call at a time, since two tickets' calls that read and write github.json at once lose a write.
const lock = join(fakes, "github.lock");
for (;;) {
  try {
    mkdirSync(lock);
    break;
  } catch {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
process.on("exit", () => rmdirSync(lock));

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
const required = existsSync(join(fakes, "required.json")) ? JSON.parse(readFileSync(join(fakes, "required.json"), "utf8")) : [];
const green = (pr) =>
  pr.checks.length > 0 &&
  pr.checks.every((check) => check.bucket === "pass" || check.bucket === "skipping") &&
  required.every((name) => pr.checks.some((check) => check.name === name));
const git = (...command) => execFileSync("git", ["-C", origin, ...command], { encoding: "utf8" }).trim();
const keyOf = (branch) => /^(?:feat|fix|docs)\/([A-Z][A-Z0-9]*-\d+)-/.exec(branch)?.[1];
const verdicts = existsSync(join(fakes, "verdicts.json")) ? JSON.parse(readFileSync(join(fakes, "verdicts.json"), "utf8")) : {};

function review(pr, findings) {
  const blocking = findings.filter((item) => item.severity === "blocking").length;
  const text = (item) => `**${item.severity}**: ${item.sentence}`;
  const outside = findings.filter((item) => item.outside).map((item) => `- \`${item.path}:${item.line}\` ${text(item)}`);
  let body = `<!-- gate review head=${pr.headRefOid} blocking=${blocking} -->\n**gate / review**: ${blocking} blocking.`;
  if (outside.length) body += `\n\nFindings outside the diff:\n${outside.join("\n")}`;
  const comments = findings.filter((item) => !item.outside).map((item) => ({ path: item.path, line: item.line, body: text(item) }));
  return { id: pr.number * 10, body, comments };
}

/** The check of the pull request's nth push, as its verdict gives it. */
function check(pr) {
  const verdict = verdicts[keyOf(pr.headRefName)] ?? "pending";
  const bucket = Array.isArray(verdict) ? verdict[Math.min(pr.pushes, verdict.length) - 1] : verdict;
  const link = `https://github.com/kcgbarbosa/demo/actions/runs/${pr.number}${pr.pushes}/job/${pr.number}${pr.pushes}0`;
  return { name: "gate / check", bucket, state: STATES[bucket], link };
}

function squash(pr) {
  const base = `refs/heads/${pr.baseRefName}`;
  const tree = git("merge-tree", "--write-tree", base, `refs/heads/${pr.headRefName}`).split("\n")[0];
  const commit = git("commit-tree", tree, "-p", base, "-m", `${pr.title} (#${pr.number})`);
  git("update-ref", base, commit);
  git("update-ref", "-d", `refs/heads/${pr.headRefName}`);
  if (!existsSync(join(fakes, "no-retarget"))) {
    for (const other of state.prs) if (other.state === "OPEN" && other.baseRefName === pr.headRefName) other.baseRefName = pr.baseRefName;
  }
  pr.state = "MERGED";
  pr.mergeCommit = { oid: commit };
}

// A push to an open pull request's branch runs its check again. GitHub merges a pull request with
// auto-merge on as soon as its checks are green. A call that changes nothing leaves the file alone, so a
// test's own write to it is never lost.
let settled = false;
for (const pr of state.prs) {
  if (pr.state !== "OPEN") continue;
  const oid = git("for-each-ref", "--format=%(objectname)", `refs/heads/${pr.headRefName}`);
  if (oid && oid !== pr.headRefOid) {
    pr.headRefOid = oid;
    pr.pushes = (pr.pushes ?? 0) + 1;
    pr.checks = [check(pr)];
    settled = true;
  }
}
for (const pr of state.prs) {
  if (pr.state === "OPEN" && pr.autoMerge && !pr.isDraft && green(pr)) {
    squash(pr);
    settled = true;
  }
}
if (settled) save();

const [noun, verb] = args;
const show = (pr) => {
  const { checks, body, autoMerge, pushes, reviews, ...rest } = pr;
  return { ...rest, autoMergeRequest: autoMerge };
};
if (noun === "run" && verb === "view") {
  // Only the call the loop makes: the failed steps of one job.
  if (!option("job") || !args.includes("--log-failed")) fail("fake gh: only run view --job <id> --log-failed");
  const log = join(fakes, "job-log.txt");
  process.stdout.write(existsSync(log) ? readFileSync(log, "utf8") : "check\tRun make check\tmake: *** [check] Error 1\n");
  process.exit(0);
}
if (noun === "api") {
  // Only the reads the loop makes: a pull request's reviews, and one review's comments.
  const [, number, id] = /^repos\/\{owner\}\/\{repo\}\/pulls\/(\d+)\/reviews(?:\/(\d+)\/comments)?$/.exec(args[1]) ?? [];
  if (!number) fail(`fake gh: no api ${args[1]}`);
  const reviews = find(number).reviews ?? [];
  const items = id ? (reviews.find((review) => String(review.id) === id)?.comments ?? []) : reviews.map(({ comments, ...review }) => review);
  for (const item of items) console.log(JSON.stringify(item));
  process.exit(0);
}
if (noun !== "pr") fail(`fake gh: no ${noun}`);
if (verb === "list") {
  const wanted = option("state") ?? "open";
  const head = option("head");
  const base = option("base");
  // Only the search the loop makes: a phrase in the title, which GitHub matches on whole words.
  const phrase = /^"(.+)" in:title$/.exec(option("search") ?? "")?.[1];
  const words = (text) => text.split(/[^A-Za-z0-9]+/).filter(Boolean).join(" ");
  const prs = state.prs.filter(
    (pr) =>
      (wanted === "all" || pr.state === wanted.toUpperCase()) &&
      (head === undefined || pr.headRefName === head) &&
      (base === undefined || pr.baseRefName === base) &&
      (phrase === undefined || ` ${words(pr.title)} `.includes(` ${words(phrase)} `)),
  );
  // Newest first, and 30 unless `--limit` says otherwise, as gh lists them.
  const limit = Number(option("limit") ?? 30);
  console.log(JSON.stringify(prs.reverse().slice(0, limit).map(show)));
} else if (verb === "view") {
  console.log(JSON.stringify(show(find(args[2]))));
} else if (verb === "create") {
  const head = option("head");
  const number = 100 + state.prs.length;
  const pr = {
    number,
    url: `https://github.com/kcgbarbosa/demo/pull/${number}`,
    headRefName: head,
    baseRefName: option("base"),
    title: option("title"),
    body: readFileSync(option("body-file"), "utf8"),
    state: "OPEN",
    isDraft: false,
    autoMerge: null,
    mergeCommit: null,
    headRefOid: git("rev-parse", `refs/heads/${head}`),
    pushes: 1,
    reviews: [],
  };
  pr.checks = [check(pr)];
  const reviews = existsSync(join(fakes, "reviews.json")) ? JSON.parse(readFileSync(join(fakes, "reviews.json"), "utf8")) : {};
  if (reviews[keyOf(head)]) pr.reviews.push(review(pr, reviews[keyOf(head)]));
  state.prs.push(pr);
  save();
  console.log(`https://github.com/kcgbarbosa/demo/pull/${number}`);
} else if (verb === "merge") {
  const pr = find(args[2]);
  if (pr.state !== "OPEN") fail(`Pull request #${pr.number} is not open`);
  if (args.includes("--auto") && existsSync(join(fakes, "no-auto-merge"))) fail("Auto-merge is not allowed for this repository");
  if (args.includes("--auto")) pr.autoMerge = { mergeMethod: args.includes("--squash") ? "SQUASH" : "MERGE" };
  else if (green(pr)) squash(pr);
  else fail(`Pull request #${pr.number} is not mergeable: the base branch policy prohibits the merge.`);
  if (pr.autoMerge && !pr.isDraft && green(pr)) squash(pr);
  save();
} else if (verb === "edit") {
  const pr = find(args[2]);
  if (option("base")) pr.baseRefName = option("base");
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
