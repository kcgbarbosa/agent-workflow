---
name: research
description: Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated to background readers.
---

`reader` subagents do the reading, and you keep the judgement and the writing.

1. Split the question into the sources that own its answers: **primary sources** (official docs, source code, specs, first-party APIs), not a secondary write-up of them. Send one `reader` per source or sub-question, all in one message and in the background, so they read in parallel while you keep working.
2. Judge what the readers quote. Follow every claim back to the source that owns it. When a reader quotes a secondary source, or comes back with nothing, send another at the primary source. This step is done when every claim you will write rests on a quote from its primary source.
3. Write the findings to a single Markdown file, citing each claim's source.
4. Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible and say where.
