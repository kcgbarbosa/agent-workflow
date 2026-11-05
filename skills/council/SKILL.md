---
name: council
description: Get three independent Claude opinions on code, a UI, a plan, or a decision. Use when the user says 'council'.
---

# Council

Three Claude delegates give independent opinions on the user's request. They share one provider and so share blind spots. Each **seat** pairs a different model family (latest Fable, Opus, and Sonnet) with a different lens to pull their answers apart.

Pick the lenses that fit the work, one per seat.

Code or system design:

- **Breaker.** How does this fail?
- **Simplifier.** What can go?
- **Skeptic.** Does this solve what the user asked?

UI design:

- **Newcomer.** Read the design as a first-time user would. Is the next step obvious, and where does the design add friction? For each problem, explain why it trips a newcomer and propose a design change.
- **Critic.** Review the UI on your own taste. Say what looks wrong, weak, or generic, and what you would change first.
- **Scout.** Compare the UI with how leading software handles the same screens today. Find references with the Mobbin connector if you have it, otherwise on the websites of top software companies. Cite the screen or URL behind each finding. If you can reach no references, report that this lens could not run.

For other work, choose three questions that could each fail the work on their own, and name them in your report. If the user names members or lenses, use those.

## 1. Prepare

Address outstanding PR comments, fix known issues, and run relevant checks, so the council sees the updated implementation. If the user wants to discard the implementation and explore new ideas, skip fixes to code being replaced.

## 2. Convene

Start one delegate per seat, in parallel, at high effort, and read-only for review or feedback.

- In T3 Code, use `orchestrator_capabilities` to resolve each model on the Claude instance this thread runs on, then `delegate_task`.
- Elsewhere, use the harness's subagent tool with the model family and effort set.

If a seat's model is unavailable, report it and stop. The user decides who fills the seat.

Brief each delegate with the request, the material to judge, and its lens. For code, the material is the files or diff. For UI, it is screenshots of the screens under review, since code does not show how a screen looks. A UI review judges the design from those screens, and leaves functional testing out. Tell it to lead with its lens and still report anything serious outside it. Keep your own conclusions and the other seats' replies out of the brief, so each opinion stays independent.

For a code or UI review, ask each delegate for a score out of 10.

## 3. Weigh

Agreement between three Claudes is weak evidence, so check each finding against the work before accepting it. Sort every finding into one of these:

- **Accept**: in scope and correct.
- **Reject**: wrong, with the reason.
- **Out of scope**: real, but outside the request. List it for the user and leave the code alone. Repeated reviews tend to grow scope, and holding that line is your job.

Report the useful findings, disagreements, and recommended next steps.

## 4. Repeat

Apply the accepted findings, then convene a fresh round. Each new delegate gets the same seat and lens, the updated implementation, and the prior findings with their outcomes. A rejected finding comes back only with new evidence.

The council is done when a full round produces no finding you accept.

## Results

For a code or UI review, count each full review pass as one round, and record the scores:

```markdown
## Council review

Rounds: 2

| Delegate                 | Round 1 | Round 2 |
| ------------------------ | ------- | ------- |
| Claude Fable (Breaker)   | 7/10    | 9/10    |
| Claude Opus (Simplifier) | 8/10    | 10/10   |
| Claude Sonnet (Skeptic)  | 7/10    | 9/10    |
```

A delegate that gives no score gets `no score`.

If the work ends in a pull request, put this section at the end of the PR description, editing it if the PR is open. With no PR, put it in the final reply.
