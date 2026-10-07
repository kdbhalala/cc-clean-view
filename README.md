# Clean View

Makes Claude Code calm and friendly for people who aren't technical. While Claude works, tool calls, file
changes and command output are hidden, and one plain checklist sits above the prompt:

```
╭──────────────────────────────────────────────────────────────────────╮
│ ● Build my landing page · step 2 of 4 · 1m 12s  [ ● Clean View: ON ] │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━──────────────────────  41%  │
│ ✓ Read your brand notes      ██████████  Done                        │
│ ▶ Build the pricing section  ██████▍░░░  64%                         │
│ ○ Add the contact form       ░░░░░░░░░░  Next                        │
│ ○ Polish the footer          ░░░░░░░░░░  Up next                     │
╰──────────────────────────────────────────────────────────────────────╯
```

When the job is done you get an honest receipt, counted from what Claude actually did:

```
✓ All done · Build my landing page · took 2m 14s · changed 2 files · created 1 file   [ Show changes ]
```

- **Quick questions stay plain chat.** No plan, no card. Claude only has to plan before it changes something.
- **"Needs you" says what for**, e.g. "Claude needs your OK to delete something".
- **Helpers show up too.** When Claude starts a helper (sub-agent), it appears under the step it's working on:
  `↳ Helper: Research competitor prices   working · 32s`, then `✓ done`. The job isn't "All done" until every
  helper has reported back, and their file changes count in the receipt.
- **Show changes** lists every file changed or created, and says plainly when commands ran that could change
  things it can't see.
- No extra AI calls: names, receipts and prompts are worked out locally.

## Install

In a Claude Code terminal session:

```
/plugin install clean-view --marketplace kdbhalala/cc-clean-view
```

Answer `y` to add the marketplace, then press Enter to install for your user.

## Use

- Click **[ ● Clean View: ON ]** above the prompt, or type `/simple on`, `/simple off`, or `/simple` to flip it.
- It starts on and remembers your choice.
- When it's off, every technical row comes back and Claude no longer has to plan first.

## Help make it better

It has not been tried by many people yet. If you set it up for someone non-technical, watch where they get
confused and open an issue.

## Develop

```
claude plugin validate .
claude plugin test .
```
