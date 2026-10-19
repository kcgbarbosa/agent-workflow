"""The schemas and prompts that the loop gives its agents."""

from __future__ import annotations

import json
from pathlib import Path

AGENT_SCHEMA = json.dumps(
    {
        "type": "object",
        "properties": {
            "status": {"type": "string", "enum": ["done", "blocked"]},
            "reason": {"type": "string"},
            "decisions": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Each open question that the ticket and the docs do not answer, "
                    "and that only KC can settle. Make the call and continue. "
                    "Leave it empty when the docs answer the question."
                ),
            },
            "notes": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Anything else worth keeping on the ticket: a judgement call that follows the docs, "
                    "a polish idea, a limit of the check. KC reads these only when KC opens the ticket."
                ),
            },
        },
        "required": ["status", "reason", "decisions"],
        "additionalProperties": False,
    }
)
# A review returns each finding that needs a change, and the head agent fixes them in its own session.
REVIEW_SCHEMA = json.dumps(
    {
        **json.loads(AGENT_SCHEMA),
        "properties": {
            **json.loads(AGENT_SCHEMA)["properties"],
            "findings": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Each problem that needs a change, with its file and line or its screenshot.",
            },
            "open": {
                "type": "array",
                "items": {"type": "integer"},
                "description": "The number of each earlier finding in the prompt that is still not fixed.",
            },
            "unchecked": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Each screen or part that you could not check, with its path and the reason. "
                    "Leave out what you checked."
                ),
            },
        },
        "required": ["status", "reason", "decisions", "findings"],
    }
)
REVIEW_RULES = (
    "Change no file, and do not commit or push. Return in `findings` each problem that breaks the behaviour, "
    "the ticket, or a documented standard. List polish that blocks nothing, such as a name or a spacing, in "
    "`notes` instead. Leave out a judgement call that you would not change. "
    "Give each command a timeout long enough for it. Stop each server you start, such as a dev server, "
    "before you give your result."
)
# The gates run the tests, so a code review reads the diff, and its time goes to what no test shows.
CODE_REVIEW_TESTS = (
    "The ticket gate `{gate}` passed at this commit, and the merge gate `{merge}` runs every test at "
    "landing. Review by reading the diff and its tests. Run a test only to confirm a problem that you "
    "suspect. "
)
CODE_REVIEW_PROMPT = "/code-review {base} The spec is the ticket file {ticket}. {tests}" + REVIEW_RULES
# A later review looks only at the commits since the last one, so each round has less to review than the one
# before it, and a fix is not reviewed again as new code.
CODE_REVIEW_AGAIN_PROMPT = (
    "/code-review {since} The spec is the ticket file {ticket}. An earlier review of the ticket, at {since}, "
    "covered all the work up to that commit. Review only the ticket's own commits since then, not the work "
    "of other tickets that a merge of the Epic branch brought in.{earlier} {tests}" + REVIEW_RULES
)
EARLIER_FINDINGS = (
    " That review found these problems:\n\n{findings}\n\nGive in `open` the number of each one that the new "
    "commits did not fix, and give it again in `findings`."
)
ACCEPTANCE_PROMPT = (
    "These lines of what the user sees have no acceptance test of the same name:\n\n{missing}\n\n"
    "Write one test for each line, as the repo's testing doc gives: its title is the line, word for word, "
    "and its tag is {key}. Make it pass on the real stack, and commit it with {key} as the commit scope."
)
UI_REVIEW_PROMPT = (
    "/{skill} The screenshot folder is {shots}. The base is `{base}`. "
    + REVIEW_RULES
    + " When the environment lacks something that a screen needs, such as a secret, a bucket, or a seeded"
    " file, return `blocked` with what is missing. A screen that shows an error in place of its content fails"
    " the review. List in `unchecked` only a part that the seeded data cannot show, with its path and the"
    " reason, so that KC reviews it by hand."
)
REVIEW_FIX_PROMPT = (
    "The {review} found these problems:\n\n{findings}\n\nFix each one that is a real problem, and commit the "
    "fixes with {key} as the commit scope. Give each one you leave as it is in `notes`, with the reason."
)
USAGE_RESUME_PROMPT = "The run stopped at a usage limit, which has now reset. Continue the work."
PR_PROMPT = (
    "/pr Write the body of the Epic pull request for the diff `{merge_base}..HEAD` to the file "
    "`{body_file}`. Do not commit, push, or open the pull request. In Evidence, give this ticket "
    "table as it is:\n\n{tickets}\n\nThe log of the merge gate is `{gate_log}`. In Evidence, also name each "
    "test that it shows as flaky, which failed and then passed on a retry."
)
LANDED_KEYS_PROMPT = "\n\nName no ticket key that the table does not give."
# The loop's own comments start with these lines, so the ticket file leaves them out.
STUCK_COMMENT = "The loop stopped this ticket."
DECISIONS_COMMENT = "The agent made these decisions for KC to check:"
NOTES_COMMENT = "The agent noted these:"
UI_OPEN_COMMENT = "The UI review left these open:"
DISPATCH = Path(__file__).with_name("dispatch.md")
