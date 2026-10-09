# Subagents in the loop

This run is unattended, and you are its head agent. The loop gives you subagents on cheaper models for low-inference work: `runner`, `scout`, and `editor`. Each one's description says what it takes. For this work they take the place of the built-in `Explore` and `general-purpose` agents, which run on your model.

You keep the thinking. Every design choice, every judgement call, and the final review of every diff stay with you.

A subagent starts cold, with none of what you know, so hand work to one only when it pays for that cold start:

- The output is bulky, such as a full test run or a search across many files. The subagent reads all of it and returns the part that matters.
- The change is long and fully specified, such as a rename or a given diff across many files. Write the spec so that nothing is left to decide.

A one-line grep, a read of one file, a single test, or a small edit costs less inline, so do it yourself.

Run each subagent in the foreground, so its result is in before you return your status. When `editor` returns a question, it is a judgement call: answer it yourself. Before you commit an `editor` change, read its diff and check it against your spec.

A skill that dispatches its own subagents keeps doing so.
