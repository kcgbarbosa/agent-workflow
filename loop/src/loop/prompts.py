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
                "description": "Each judgement call that KC should check. Make the call and continue.",
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
        },
        "required": ["status", "reason", "decisions", "findings"],
    }
)
REVIEW_RULES = (
    "Change no file, and do not commit or push. Return in `findings` each problem that breaks the behaviour, "
    "the ticket, or a documented standard. List polish that blocks nothing, such as a name or a spacing, in "
    "`decisions` instead, so that KC fixes it by hand. Leave out a judgement call that you would not change. "
    "Wait for every subagent you start to return before you give your result, which ends the session."
)
CODE_REVIEW_PROMPT = "/code-review {base} The spec is the ticket file {ticket}. " + REVIEW_RULES
UI_REVIEW_PROMPT = (
    "/{skill} The run folder is {run_dir}. The base is `{base}`. "
    + REVIEW_RULES
    + " When the environment lacks something that a screen needs, such as a bucket name, that is not a block:"
    " check the rest, return `done`, and list in `decisions` each screen or part that you could not check,"
    " with the reason, so that KC reviews it by hand."
)
REVIEW_FIX_PROMPT = (
    "The {review} found these problems:\n\n{findings}\n\nFix each one that is a real problem, and commit the "
    "fixes with {key} as the commit scope. Give each one you leave as it is in `decisions`, with the reason."
)
RESTART_PROMPT = "A previous run was interrupted. Check the diff against the ticket and continue."
USAGE_RESUME_PROMPT = "The run stopped at a usage limit, which has now reset. Continue the work."
PR_PROMPT = (
    "/pr Write the body of the Epic pull request for the diff `{merge_base}..HEAD` to the file "
    "`{body_file}`. Do not commit, push, or open the pull request. In Evidence, give this ticket "
    "table as it is:\n\n{tickets}"
)
LANDED_KEYS_PROMPT = "\n\nName no ticket key that the table does not give."
# The loop's own comments start with these lines, so the ticket file leaves them out.
STUCK_COMMENT = "The loop stopped this ticket."
DECISIONS_COMMENT = "The agent made these decisions for KC to check:"
# The rule for when the head agent hands work to the subagent tiers in `tiers.py`.
DISPATCH = Path(__file__).with_name("dispatch.md")
