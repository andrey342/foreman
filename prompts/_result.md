## How you finish

End every turn, done or stopped, with this block as the very last thing you write, valid JSON on its own lines:

```foreman-result
{ "status": "done", "summary": "one or two lines", "commits": ["<sha>"], "gates": [{ "cmd": "<command>", "exit": 0 }], "files": ["<path>"] }
```

- `status`: `done` (finished), `question` (you need an answer: put it in `"question"`), `blocked` (you cannot go on: say why in `"summary"`), or `failed`.
- `commits`, `gates` and `files` are optional; list only what you really ran or wrote, with the real exit codes.
- foreman reads this block to decide what happens next. Without it the thread is shown as waiting, never as done.
