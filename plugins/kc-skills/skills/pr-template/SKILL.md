---
name: pr-template
description: Generate a filled-out PR description in raw markdown from the current git diff, following the repo's .github/pull_request_template.md structure exactly, and open the actual PR on GitHub via `gh pr create` for the user to review. Use this whenever the user asks for a PR description, PR template, PR summary, or wants to "write up," "open," or "create" a PR from the current branch/diff — even if they don't say the word "template". Never merge the PR — creation only, the user reviews and merges themselves. Do not use this for reviewing code quality (that's /code-review) — this skill only describes what changed, it doesn't judge it.
---

# PR Template Generator

Produce a PR description from the actual diff on this branch, not from
conversation history or assumptions about what the branch is "supposed" to
do. The diff is the source of truth — if something isn't in it, don't
mention it.

**Creation only, never merge.** This skill can open the PR on GitHub via
`gh pr create` so the user can review it there. Never run `gh pr merge`,
never approve a PR, never push directly to `main`/`master`. Merging is
always the user's call.

**Write everything in past tense.** "Added theme toggle to auth page," not
"Adds theme toggle." This applies to the Summary prose, Changes bullets,
and Verification checklist items alike, since the PR describes work that's
already done.

## Steps

1. **Find and read the repo's PR template**: `.github/pull_request_template.md`
   (also check `.github/PULL_REQUEST_TEMPLATE.md` and `docs/pull_request_template.md`
   as fallback locations — GitHub recognizes a few). This defines the exact
   section headers and order you must output. Do not invent your own
   structure, add sections, remove sections, or reorder them — the whole
   point is that the output drops straight into the repo's actual template.
   If no template file exists anywhere in the repo, fall back to a plain
   `## Summary` + `## Test plan` structure and tell the user you didn't find
   one.

2. **Read the diff.** One command covers committed and uncommitted changes:
   ```
   git diff main...HEAD; git diff HEAD
   ```
   Substitute the actual base branch if `main` isn't it (check
   `git status` / `git branch` if unsure, or use whatever base the user
   specifies). Skip test/fixture hunks (`test/`, `spec/`, `__tests__/`,
   `*_test.*`, `*.test.*`, `fixtures/`, `testdata/`) when writing content —
   they're rarely what a reviewer needs described, though a striking test
   addition can still earn a line if it reveals what behavior is now covered.

3. **Also skim recent commit messages** (`git log main...HEAD --oneline`)
   for intent the diff alone won't tell you — *why* a change was made, not
   just *what* changed. Commit messages are a hint, not a substitute for
   reading the actual diff.

4. **Ask the user one question before writing anything**: does this PR need
   a UI Preview section? Not every change touches the UI (a store refactor,
   a backend swap, a config change), so don't assume. If the template has a
   `## Preview` (or similarly named) section, either fill it with a short
   note on what to screenshot/record, or drop the section entirely for a
   non-visual change — whichever the user says.

5. **Output a recommended PR title** as the very first line of your response,
   before the markdown block, formatted as:
   ```
   **Title:** your recommended title here
   ```
   Keep it under 70 characters. Infer the right prefix from the diff
   (`feat:`, `fix:`, `refactor:`, etc.) and summarize the change in plain
   English. This line is not part of the markdown block — it sits above it
   so the user can copy it separately into the PR title field.

6. **Fill in every section of the template** using the diff as source
   material, and output the result as a single raw markdown block in the
   chat.

7. **Ask the user whether to open the PR now** (unless they already asked
   you to "create"/"open" one, in which case skip straight to opening it).
   If yes:
   - Confirm the current branch is pushed to the remote (`git push -u origin
     <branch>` if it isn't tracked yet or has unpushed commits) — check with
     the user before pushing if this is the first push of the branch.
   - Run `gh pr create --title "<title>" --body "<body>" --base <base
     branch>` using a HEREDOC for the body so formatting survives, exactly
     like the PR-creation steps in this agent's general instructions.
   - Report back the PR URL `gh` returns. Do not merge it, approve it, or
     take any further action on it — the user takes it from here.
   If the user declines or doesn't respond to the offer, just leave the
   markdown block for them to copy-paste manually.

8. **If the template included a Preview section** (i.e. the user confirmed
   screenshots are needed), end your response with a concise one-line
   reminder about sizing the dropped-in `<img>` tags: set mobile screenshots
   to `width="300"`, desktop screenshots to `width="800"`, and delete the
   `height` attribute GitHub auto-inserts since it should scale
   automatically from `width`. Skip this reminder entirely if there's no
   Preview section.

   **Screenshot capture rule.** When you take the screenshots yourself, use
   the viewport-only capture ("capture screenshot"), NOT the full-page
   capture ("capture full size screenshot"). Full-page capture renders the
   entire scroll length of the document into one enormous, unusable image.
   Capture just the visible viewport for each state instead. Set the
   viewport size to match the target: ~390px wide for mobile shots, ~1280px
   wide for desktop shots, and scroll to frame the relevant UI before
   capturing.

   **Save screenshots into the repo, then open Finder for drag-and-drop.**
   This repo keeps PR images organized under `jc-media/`, one folder per PR:
   `jc-media/pr-<number>/`. After capturing:
   1. Determine the PR number (`gh pr view --json number`), and ensure
      `jc-media/pr-<number>/` exists (`mkdir -p`).
   2. Save each screenshot there with a descriptive kebab-case name matching
      the existing convention `desktop-<page>-<context>.png` (or
      `mobile-<page>-<context>.png` for mobile shots) — e.g.
      `desktop-homepage-stylingpolish.png`. Check a sibling folder like
      `jc-media/pr-<previous>/` for the exact naming style already in use and
      match it.
   3. Open that folder in Finder with `open jc-media/pr-<number>/` so the
      user can drag the images straight into the GitHub PR body.

   Finder drag uploads the real file; a drag from the editor's file tree only
   pastes the path text, so always open Finder rather than pointing the user
   at the tree. Do not use `SendUserFile` for these — the user cannot drag
   those into GitHub. The in-repo `jc-media/` copies are the deliverable.

## How to fill each section

- **Summary**: prose, not bullets, but **multiple short independent
  sentences, not one long compound sentence.** Each sentence is its own
  action: `<Verb> <what changed>.` Chain additional sentences with "Also"
  rather than stitching them onto the first sentence with a gerund/
  participial clause (a comma + "-ing" tail, or "and" + past-tense verb).
  KC's real summaries read as a short list of flat statements, e.g. (PR
  #28) "Replaced the spinner loading state with component skeletons for
  all pages. Renamed the Home page to Overview page and updated its
  references. Also renamed a few component files for better clarity and
  cleaner imports." — three separate sentences, not "Replaced the spinner
  with skeletons, renaming the Home page and updating references while
  also renaming component files." If the diff spans a secondary or
  unrelated change (e.g. an eslint config fix bundled with a feature),
  give it its own trailing "Also ..." sentence rather than folding it into
  the main sentence as a subordinate clause.

  **Exception for PRs with many (4+) unrelated features bundled
  together:** don't write one flat sentence per feature, it reads as a
  wall of text. Instead use a short casual framing sentence naming the
  overall theme, then one sentence that lists the individual features.
  Real example (PR #29, five bundled features): "Added various features
  using the existing available api data. This included updating the Wild
  Card standings, adding a search bar, last 10 games record, and a
  strikeout leader card." Not: a separate `<Verb> <what changed>.`
  sentence for each of the five features. This is a summary, not a
  changelog — the per-feature detail belongs in `## Changes`.

- **Changes**: this is where the bullet points live. Group by *behavior*,
  not by file — a reviewer wants to know "auth state now persists across
  reloads," not just "modified App.jsx, useAuthStore.js, ProtectedRoute.jsx."
  Reading several file diffs and recognizing they're one feature is the
  actual value here, not echoing `git diff --stat` as prose. Default to
  plain behavior statements with no inline code-change detail (e.g.
  "switched theme toggle to ghost variant" not "`ThemeToggle.jsx`:
  switched to `variant=\"ghost\"`").

  **Do name the component** when a bullet is about changes to one
  specific component, KC prefers a real backticked component name over a
  generic paraphrase — write "Added a search input to `RosterTable`" not
  "Added a search input that filters the roster by player name."
  Real revision from PR #29: "Added an AL East / Wild Card toggle, win
  percentage and streak columns to `ALEastStandings`" (not "...toggle on
  the standings card that sorts by the relevant rank"). Keep it to the
  component name, not file paths or internal symbol/prop names — this is
  about anchoring *where*, not documenting internals.

  Cut explanatory sub-clauses that just restate implementation detail a
  reviewer can see in the diff — "computed from finished games", "that
  sorts by the relevant rank" got cut in KC's own revision. State what
  was added/changed and stop.

  Don't split a feature into two bullets when one covers it — a bullet
  like "highlighted the Blue Jays row" got merged into the toggle bullet
  above it, and dropped entirely as its own line once the same fact was
  already going to appear in `## Verification`. Don't spell out every
  option in an enumerated UI list (e.g. every filter category) if a
  short generic phrase covers it — "dedicated buttons above table for
  player position filtering" beat listing "All, Pitchers, Catchers,
  Infield, and Outfield" by name.

  Avoid narrow UI-vocabulary jargon in favor of plain words when both
  describe the same thing to a reviewer — "indicator" over "chip", "Last
  10 games" over "L10". No unexplained abbreviations in Changes bullets.

- **Type of Change**: if the template has this as a checklist, check the
  box(es) that match — infer from the diff content and commit message
  prefixes (`feat:`, `fix:`, `refactor:`, etc.) if the repo uses that
  convention, don't just guess.

- **Preview**: if the user confirmed a preview is needed, use a
  **single-drop-zone layout**, not per-image blocks. The workflow is: KC
  drags *all* the screenshots into GitHub in one motion, so GitHub inserts
  every `<img>` tag consecutively at one point, in drag order. Interleaving
  drop lines between alt-text lines breaks under that batch drag — the images
  all land in the first slot and the layout scrambles. So separate the two
  concerns: one drop marker, then a contiguous alt-text list in the same
  order the images are dragged.

  Do not write the alt text inside an `<img>` tag. When KC drops a
  screenshot, GitHub inserts its own brand-new `<img width height src>` tag
  at the drop point; it does not merge into a pre-existing tag's attributes.
  A plain text line survives the drop untouched, triple-clicks to select
  cleanly, and pastes straight into the `alt=""` GitHub generated.


  Alt text best practices:
  - Name the element/screen, its state, and the viewport, in that order
    (e.g. "Entries page empty state with no entries logged, mobile view").
  - No filler like "screenshot of," "image showing," or "picture of" — start
    directly with the subject.
  - Skip words the diff can't support — don't claim a state, theme, or
    viewport wasn't actually touched by the change.
  - If the user later supplies screenshot filenames (e.g.
    `desktop-dialog-darkmode.png`) instead of asking for placeholders,
    decode the filename into the same element/state/viewport structure
    rather than echoing the filename as alt text.

- **Verification / Test plan**: every checklist item must trace back to
  something visible in the diff, and must be **one flowing, single-clause,
  past-tense sentence stating the fact that was verified — with no leading
  verification verb and no two-part "action — dash — result" structure.**
  Do not open with `Confirmed`/`Verified`/`Checked` — state the outcome
  directly, the same way a completed checkbox already implies it was
  checked. Not "Confirmed toast displays when triggered," just "Toast
  displays when triggered." Not "Toggled dark mode — theme flips and
  persists," just "Theme flips and persists across reload after toggling
  dark mode." Every item's subject is the thing being described (a
  component, a piece of state, a screen), not "I" or an implied "you" — no
  hyphen/dash separating a step from its outcome anywhere in the line.
  Real items reworded from KC's own PRs this way: "Toast displays when
  triggered" (PR #25), "Timeline chart line renders with the smoother
  curve" (PR #25), "Skeleton loading states work correctly on all
  viewports" (PR #28), "Screen reader announces loading state via
  `role=\"status\"` on each skeleton" (PR #28), "Blue Jays row is
  highlighted in the standings table" (PR #29). Use "is/are + past
  participle" for a static state check like that last one rather than an
  active present-tense verb ("is highlighted" not "highlights"). Drop
  filler qualifiers that don't add information — "Roster filters by
  search query and position group," not "...position group together."
  Don't pad with generic boilerplate like "run the test suite" unless the
  diff actually touches tests, and don't invent scenarios the diff
  doesn't support — a short checklist is fine for a small change.

**Every point in every section: one line, plain statement of what changed
or what to check. No multi-sentence explanations, no justifying the
approach, no restating context the reviewer can already see in the diff
itself.** If you're writing more than one sentence for a bullet, cut it
down — the diff is right there for anyone who wants the detail.

## Commit message conventions

If the user asks you to draft or split individual commit messages (as
opposed to the overall PR description), follow the canonical commit message
conventions in the user's global `~/.claude/CLAUDE.md` ("Commit message
conventions"). In brief: subject-only by default, restricted verbs
(`add` / `update` / `remove` / `replace` / "change X to Y"), a
`<lowercase prefix>: <lowercase summary, no period>` title, and a plain
factual subject (no clinical/self-congratulatory verbs).

This is distinct from the `## Changes` bullets in a PR description, which
stay verb-flexible and behavior-grouped rather than file-grouped.

## Example

Given a diff that adds a Zustand auth store, wires `initAuth()` into
`App.jsx`, and simplifies `ProtectedRoute` to read from that store instead
of calling `supabase.auth.getSession()` directly, filled into this repo's
actual template (`.github/pull_request_template.md`), with the user having
said "no preview needed":

**Title:** feat: connect Supabase auth state into Zustand store

```markdown
## Summary

Connected auth state with Supabase's `onAuthStateChange`. Replaced the
per-mount session fetch in `ProtectedRoute` with a shared Zustand store.

## Type of Change

- [x] feat: A new feature
- [ ] style: A design change or update
- [ ] fix: A bug fix
- [ ] refactor: Code change that neither fixes a bug nor adds a feature
- [ ] chore: Build tasks, dependencies, or configuration
- [ ] test: New or modified tests

## Changes

- Added a new Zustand store for session state and auth actions
- Initialized auth state once on app mount and unsubscribes on unmount

## Verification

- [ ] Protected routes redirect to `/auth` when logged out
- [ ] Protected routes render without a reload after logging in
- [ ] Session persists after a refresh while logged in
- [ ] Protected routes redirect immediately after logging out
```

Note the recommended title appears above the markdown block so it can be
copied separately. `## Summary` is prose but written as short independent
sentences ("Wired up X. Replaced Y." not "Wired up X, replacing Y."),
`## Changes` is where the per-behavior bullets live, with no file names or
inline code details unless disambiguation truly requires it, `## Preview`
was omitted entirely since the user said this PR doesn't need one, and
`## Verification` items state the verified fact directly in one clause —
no leading `Confirmed`/`Verified`/`Checked`, and no dash-separated
action-then-result structure.
If the user had said yes to preview, the section would use the
single-drop-zone layout: one instruction comment, one drop marker, then the
label+alt pairs stacked in drag order so all screenshots can be dragged in
at once and the alt lines pasted top-to-bottom, e.g.:
```
## UI Preview

**Protected route, logged out**
Protected route redirecting to /auth when logged out

**Protected route, logged in**
Protected route rendering its content after login
```
