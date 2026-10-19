# Testing

How a ticket proves what the user sees. `to-spec`, `to-tickets`, `tdd`, `implement`, `code-review`, the UI review, and the loop read this file.

## Acceptance tests

Each "What the user sees" line of a ticket is one acceptance test.

| Rule          | Value                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------ |
| Folder        | `<acceptance folder>`                                                                            |
| Title         | The line, word for word                                                                          |
| Tag           | The ticket key                                                                                   |
| Stack         | The real stack: <what is real>. No API is stubbed                                                |
| Data          | The seed. A line the seed cannot show changes the seed                                           |
| Run a ticket  | `<acceptance command>`. It saves no screenshot                                                   |
| UI review run | `<UI review run command>`: the same tests, with a screenshot of each step in the folder it names |
| List a ticket | `<list command>`, one title per line                                                             |
| Proof         | The screenshots of the UI review run, which `<UI review skill>` checks                           |

## Other tests

| Kind    | Where      | Use for                                                            |
| ------- | ---------- | ------------------------------------------------------------------ |
| Stubbed | `<folder>` | Only a state that the real stack cannot show, such as a load error |
| Unit    | `<folder>` | A rule with many cases, at the seam that the spec names            |

## Order in a ticket

1. Write the acceptance test of each line. It fails.
2. Build until it passes, with `/tdd` at the inner seams.
3. Run the ticket's acceptance tests, then the UI review when the diff touches the UI.
4. `/code-review` checks that each line has its test.
