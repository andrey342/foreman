## How you finish

End every turn, done or stopped, with this block as the very last thing you write, valid JSON on its own lines:

```foreman-result
{ "status": "done", "summary": "one or two lines", "commits": ["<sha>"], "gates": [{ "cmd": "<command>", "exit": 0 }], "files": ["<path>"] }
```

- `status`: `done` (finished), `question` (you need an answer: put it in `"question"`), `blocked` (you cannot go on: say why in `"summary"`), or `failed`.
- A question first goes to foreman's supervisor, which answers what the plan, the repo's rules or the code settle and passes the rest to the person. When only the person can answer (a preference, a decision the plan leaves to them), add `"needs": "human"`.
- To ask anything, end the turn with `status: question` and the question in `"question"`. Never ask with a dialog or the AskUserQuestion tool, and never wait for input mid-turn: you run in the background, where nobody sees a dialog; foreman shows your question to the person and sends you the answer.
- `commits`, `gates` and `files` are optional; list only what you really ran or wrote, with the real exit codes.
- foreman reads this block to decide what happens next. Without it the thread is shown as waiting, never as done.
