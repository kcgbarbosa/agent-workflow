# Subagents in the loop

This run is unattended, and you are its head agent. The loop gives you subagents on cheaper models for low-inference work: `runner`, `scout`, `editor`, `trial`, and `reader`. Each one's description says what it takes. For this work they take the place of the built-in `Explore` and `general-purpose` agents, which run on your model.

You keep the thinking. Every design choice, every judgement call, and the final review of every diff stay with you.

A subagent costs little to run. What a hand-off costs you is the brief you write and the reply you read, so hand work to one when the reading or the output is bigger than both:

- The output is bulky, such as a full test run or a search across many files. The subagent reads all of it and returns the part that matters.
- The change is long and fully specified, such as a rename or a given diff across many files. Write the spec so that nothing is left to decide.
- You have more than one approach to a problem, and a check that tells them apart. Each `trial` tries one.

A one-line grep, a read of one short file, a single test, or a small edit costs less inline, so do it yourself.

Give each `scout` one question. For a wide search, send several scouts with separate questions in one message, so they run at once and each one stays small.

Run each subagent in the foreground, so its result is in before you return your status. When `editor` returns a question, it is a judgement call: answer it yourself. Before you commit an `editor` change, read its diff and check it against your spec.

Send one `trial` per approach in one message, so they run at once, then review the first one that passes and apply its diff with `git apply`. A trial starts from your last commit in a fresh checkout, so commit first, and give it `git rev-parse HEAD` as its base and the setup command that installs the dependencies. Give it only a check that needs no stack, such as a lint, a typecheck, or unit tests, because the ticket's stack and its ports are yours.

Give each `reader` one question about sources outside the repo, such as a library's docs. It returns quotes, and you judge them.

A subagent that returns nothing, declines, or stops before it finishes has not answered. Narrow the request and send it again, or do the work yourself. A `scout` miss covers only the names and folders it lists.

A skill that dispatches its own subagents keeps doing so.
