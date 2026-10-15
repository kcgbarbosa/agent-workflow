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
    "Wait for every subagent you start to return, and stop every background task you start, such as a dev "
    "server, before you give your result, which ends the session."
)
CODE_REVIEW_PROMPT = "/code-review {base} The spec is the ticket file {ticket}. " + REVIEW_RULES
UI_REVIEW_PROMPT = (
    "/{skill} The run folder is {run_dir}. The base is `{base}`. "
    + REVIEW_RULES
    + " When the environment lacks something that a screen needs, such as a bucket name, that is not a block:"
    " check the rest, return `done`, and list in `unchecked` each screen or part that you could not check,"
    " with its path and the reason, so that KC reviews it by hand."
)
REVIEW_FIX_PROMPT = (
    "The {review} found these problems:\n\n{findings}\n\nFix each one that is a real problem, and commit the "
    "fixes with {key} as the commit scope. Give each one you leave as it is in `notes`, with the reason."
)
RESTART_PROMPT = "A previous run was interrupted. Check the diff against the ticket and continue."
USAGE_RESUME_PROMPT = "The run stopped at a usage limit, which has now reset. Continue the work."
EARLY_STATUS_PROMPT = (
    "Claude Code asked for your status while subagents that you started still ran, so it came before "
    "your work was done. Continue the work from where you stopped. Send again each subagent whose report "
    "you do not have, and set `run_in_background: false` on each Agent call."
)
PR_PROMPT = (
    "/pr Write the body of the Epic pull request for the diff `{merge_base}..HEAD` to the file "
    "`{body_file}`. Do not commit, push, or open the pull request. In Evidence, give this ticket "
    "table as it is:\n\n{tickets}"
)
LANDED_KEYS_PROMPT = "\n\nName no ticket key that the table does not give."
# The loop's own comments start with these lines, so the ticket file leaves them out.
STUCK_COMMENT = "The loop stopped this ticket."
DECISIONS_COMMENT = "The agent made these decisions for KC to check:"
NOTES_COMMENT = "The agent noted these:"
UI_OPEN_COMMENT = "The UI review left these open:"
# The rule for when the head agent hands work to the subagent tiers in `tiers.py`.
DISPATCH = Path(__file__).with_name("dispatch.md")
