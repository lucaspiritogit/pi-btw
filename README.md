# btw

`btw` is a Pi extension for asking a side question without derailing the session you are in.

It forks the current conversation into a throwaway side chat. The side chat sees everything the main
conversation has seen, but it has **no tools** — it cannot read or write files, run commands, or
steer the main conversation. You ask, you read the answer, you close it. The main session is
untouched.

This `btw` implementation was inspired by Ben's setup: https://www.youtube.com/watch?v=5Qu2SkSQeBU
It removes subagent functionality and includes fixes so it can be reused across environments.

## Installation

```sh
pi install npm:@lpirito/pi-btw
```
## Commands

| Command          | What it does                                                       |
| ---------------- | ------------------------------------------------------------------ |
| `/btw <question>` | Open a side chat forked from the current conversation              |
| `/btw`           | Same, but prompts you for the question                              |
| `/btws`          | List every side chat from this session and reopen one               |

Both commands are **TUI-only**. In non-interactive modes they no-op with a notice.

## The side chat view

The overlay is a normal back-and-forth chat — you can keep asking follow-ups in the same forked
context.

| Key            | Action                                    |
| -------------- | ----------------------------------------- |
| `submit`       | Send the message                          |
| `interrupt`    | Close the overlay (the chat keeps running) |
| `clear`        | Cancel the in-flight response              |
| `↑` / `↓`      | Scroll the transcript                     |
| `pgup` / `pgdn`| Page through the transcript               |

Keys follow your Pi keybindings, so the footer shows whatever you have `tui.input.submit`,
`app.interrupt`, and `app.clear` bound to.


## Development

```bash
npm install
npm run typecheck
npm test
```