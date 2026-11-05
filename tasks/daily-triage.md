# Daily triage

Daily triage for KC. Report only: never merge, push, comment, edit, transition, label, start, or stop anything, on GitHub, in Jira, or in T3 Code. The two exceptions are the delete of the Loop state step and the post of the Slack step.

Do the steps in this order, then write one short list in this thread. KC has ADHD: lead with what needs KC, one line per item, each with its link. No em dashes. If a source cannot be read, say UNKNOWN and why, and go on.

1. **Awaiting Approval.** Read `~/.local/state/runner/*/today.json`, the file each runner tick writes for its repo. Give `awaitingApproval` for each repo with a count above 0. Name a repo with no file, and give the age of a file older than ten minutes, because its timer stopped.
2. **Stuck.** From the same files, one line for each item of `stuck`, with its key, its reason, and its Jira link on kcgbarbosa.atlassian.net.
3. **Runner failures.** `journalctl --user -u 'runner-*' --since '24 hours ago' --no-pager -q --grep 'failed: |runner: |Failed with result'`. One line for each distinct failure, with its repo and its count.
4. **Pull requests.** The open pull requests across KC's repos: `gh search prs --owner kcgbarbosa --state open --json repository,number,title,url,isDraft,updatedAt`, then `gh pr view` and `gh pr checks` for each. List each one that waits on KC: a red check, a draft, a review asking for changes, a merge conflict, or green with auto-merge off.
5. **In Review.** The tickets In Review for more than a day, from Jira on kcgbarbosa.atlassian.net: `project in (AW, PITCH) AND status = "In Review" AND NOT status changed TO "In Review" AFTER -1d`. One line for each.
6. **Threads.** The T3 threads that wait on KC. Get the projects with `t3_project_list`, and for each run `t3 --log-level error thread list --json --project <workspaceRoot>`. `list` shows a thread that waits as `running`, so for each `running` thread run `t3 --log-level error thread show --json --messages 0 <threadId>`. The thread waits on KC when its `pendingRequestCount` is above 0. One line for each, with its link, with the host of the link replaced by `https://t14.tail4fca58.ts.net:7443`.
7. **Loop state.** The loop is retired, and its state folders go the first time this finds them. Do not read them. `find ~/.local/state -maxdepth 1 -type d -name '*-loop' -print -exec rm -rf {} +`. Name each folder it deleted in the list. It deletes only folders, so an archive beside them stays. When it prints nothing, say nothing of it.

End the list with one line: what's running fine, counted. If nothing needs KC, say "Nothing needs you."

8. **Slack.** Always, as the last step, post the list in KC's Slack DM, and nowhere else. Save the list as plain text to a temporary file, and never print the webhook. Replace `<list>` with the file:

`payload=$(mktemp); jq -Rs '{text: .}' <list> > "$payload"; set -a; . ~/.config/bws/token.env; set +a; bws run -- "curl -fsS -o /dev/null -H 'Content-Type: application/json' -d @$payload \"\$SLACK_WEBHOOK_DM\""`

If it fails, say so in the thread.
