---
name: coding-agent
description: "Delegate feature work, PR review, refactors, or iterative coding to background Codex, Claude Code, or Pi agents."
metadata:
  {
    "openclaw":
      {
        "emoji": "🧩",
        "requires": { "anyBins": ["claude", "codex", "opencode", "pi"] },
        "install":
          [
            {
              "id": "node-claude",
              "kind": "node",
              "package": "@anthropic-ai/claude-code",
              "bins": ["claude"],
              "label": "Install Claude Code CLI (npm)",
            },
            {
              "id": "node-codex",
              "kind": "node",
              "package": "@openai/codex",
              "bins": ["codex"],
              "label": "Install Codex CLI (npm)",
            },
          ],
      },
  }
---

# Coding Agent (Claude Relay Service)

**⚠️ MANDATORY: All coding requests MUST use the Claude relay service.**

The Claude Code relay service provides:

- Remote monitoring via Slack threads
- Telegram notifications for all events
- Two-way control (reply in Slack to inject commands)
- Automatic session tracking and status updates

**Service Status:** `systemctl --user status claude-relay.service` (should be active)

## How to Use the Relay

All Claude Code sessions automatically notify via the relay when run through the standard Claude Code hooks. Simply run Claude Code normally and the relay will:

1. Create a Slack thread for the session
2. Send Telegram notifications for prompts/responses
3. Allow you to reply in Slack to control the session

## Quick Start

## ⚠️ PTY Mode: Codex/Pi/OpenCode yes, Claude Code no

For **Codex, Pi, and OpenCode**, PTY is still required (interactive terminal apps):

```bash
# ✅ Correct for Codex/Pi/OpenCode
bash pty:true command:"codex exec 'Your prompt'"
```

For **Claude Code** (`claude` CLI), use `--print --permission-mode bypassPermissions` instead.
`--dangerously-skip-permissions` with PTY can exit after the confirmation dialog.
`--print` mode keeps full tool access and avoids interactive confirmation:

```bash
# ✅ Correct for Claude Code (no PTY needed)
cd /path/to/project && claude --permission-mode bypassPermissions --print 'Your task'

# For background execution: use background:true on the exec tool

# ❌ Wrong for Claude Code
bash pty:true command:"claude --dangerously-skip-permissions 'task'"
```

### Bash Tool Parameters

| Parameter    | Type    | Description                                                                 |
| ------------ | ------- | --------------------------------------------------------------------------- |
| `command`    | string  | The shell command to run                                                    |
| `pty`        | boolean | **Use for coding agents!** Allocates a pseudo-terminal for interactive CLIs |
| `workdir`    | string  | Working directory (agent sees only this folder's context)                   |
| `background` | boolean | Run in background, returns sessionId for monitoring                         |
| `timeout`    | number  | Timeout in seconds (kills process on expiry)                                |
| `elevated`   | boolean | Run on host instead of sandbox (if allowed)                                 |

### Process Tool Actions (for background sessions)

| Action      | Description                                          |
| ----------- | ---------------------------------------------------- |
| `list`      | List all running/recent sessions                     |
| `poll`      | Check if session is still running                    |
| `log`       | Get session output (with optional offset/limit)      |
| `write`     | Send raw data to stdin                               |
| `submit`    | Send data + newline (like typing and pressing Enter) |
| `send-keys` | Send key tokens or hex bytes                         |
| `paste`     | Paste text (with optional bracketed mode)            |
| `kill`      | Terminate the session                                |

---

## Quick Start: One-Shot Tasks

For quick prompts/chats, use Claude Code with the relay service:

```bash
# Quick task - relay will notify Slack/Telegram automatically
cd /path/to/project && claude --permission-mode bypassPermissions --print "Your task here"

# Background task with relay monitoring
bash workdir:~/Projects/myproject background:true command:"claude --permission-mode bypassPermissions --print 'Your task here'"
```

**Relay notifications include:**

- Session start (Slack thread created)
- Every prompt submitted
- Tool errors (if any)
- Response ready
- Session end (with cost, tokens, duration)

---

## The Pattern: workdir + background + relay

For longer tasks, use background mode with relay monitoring:

```bash
# Start Claude Code in target directory (relay auto-notifies!)
bash workdir:~/project background:true command:"claude --permission-mode bypassPermissions --print 'Build a snake game'"
# Returns sessionId for tracking

# Monitor via Slack thread (created automatically)
# Reply in Slack with:
#   /status - Check session status
#   /stop - Stop the session
#   <any text> - Inject text into Claude Code

# Or monitor via process tool
process action:log sessionId:XXX
process action:poll sessionId:XXX

# Kill if needed
process action:kill sessionId:XXX
```

**Why workdir matters:** Agent wakes up in a focused directory, doesn't wander off reading unrelated files.

---

## Claude Code CLI

**Default Model:** Claude Sonnet 4.6

### Flags

| Flag                                  | Effect                                    |
| ------------------------------------- | ----------------------------------------- |
| `--print`                             | Non-interactive mode (required for relay) |
| `--permission-mode bypassPermissions` | Auto-approve tool permissions             |

### Building/Creating

```bash
# Quick one-shot with relay monitoring
cd ~/project && claude --permission-mode bypassPermissions --print 'Build a dark mode toggle'

# Background for longer work (relay auto-notifies!)
bash workdir:~/project background:true command:"claude --permission-mode bypassPermissions --print 'Refactor the auth module'"
```

### Reviewing PRs

**⚠️ CRITICAL: Never review PRs in OpenClaw's own project folder!**
Clone to temp folder or use git worktree.

```bash
# Clone to temp for safe review
REVIEW_DIR=$(mktemp -d)
git clone https://github.com/user/repo.git $REVIEW_DIR
cd $REVIEW_DIR && gh pr checkout 130
bash workdir:$REVIEW_DIR command:"claude --permission-mode bypassPermissions --print 'Review this PR and suggest improvements'"
# Clean up after: trash $REVIEW_DIR

# Or use git worktree (keeps main intact)
git worktree add /tmp/pr-130-review pr-130-branch
bash workdir:/tmp/pr-130-review command:"claude --permission-mode bypassPermissions --print 'Review the changes in this PR'"
```

### Batch PR Reviews (parallel)

```bash
# Fetch all PR refs first
git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'

# Deploy multiple Claude sessions (relay monitors all!)
bash workdir:~/project background:true command:"claude --permission-mode bypassPermissions --print 'Review PR #86. git diff origin/main...origin/pr/86'"
bash workdir:~/project background:true command:"claude --permission-mode bypassPermissions --print 'Review PR #87. git diff origin/main...origin/pr/87'"

# Monitor all via Slack threads (created automatically)
```

---

## Claude Code

```bash
# Foreground
bash workdir:~/project command:"claude --permission-mode bypassPermissions --print 'Your task'"

# Background
bash workdir:~/project background:true command:"claude --permission-mode bypassPermissions --print 'Your task'"
```

---

## OpenCode

```bash
bash pty:true workdir:~/project command:"opencode run 'Your task'"
```

---

## Pi Coding Agent

```bash
# Install: npm install -g @mariozechner/pi-coding-agent
bash pty:true workdir:~/project command:"pi 'Your task'"

# Non-interactive mode (PTY still recommended)
bash pty:true command:"pi -p 'Summarize src/'"

# Different provider/model
bash pty:true command:"pi --provider openai --model gpt-4o-mini -p 'Your task'"
```

**Note:** Pi now has Anthropic prompt caching enabled (PR #584, merged Jan 2026)!

---

## Parallel Issue Fixing with git worktrees

For fixing multiple issues in parallel, use git worktrees:

```bash
# 1. Create worktrees for each issue
git worktree add -b fix/issue-78 /tmp/issue-78 main
git worktree add -b fix/issue-99 /tmp/issue-99 main

# 2. Launch Codex in each (background + PTY!)
bash pty:true workdir:/tmp/issue-78 background:true command:"pnpm install && codex --yolo 'Fix issue #78: <description>. Commit and push.'"
bash pty:true workdir:/tmp/issue-99 background:true command:"pnpm install && codex --yolo 'Fix issue #99 from the approved ticket summary. Implement only the in-scope edits and commit after review.'"

# 3. Monitor progress
process action:list
process action:log sessionId:XXX

# 4. Create PRs after fixes
cd /tmp/issue-78 && git push -u origin fix/issue-78
gh pr create --repo user/repo --head fix/issue-78 --title "fix: ..." --body "..."

# 5. Cleanup
git worktree remove /tmp/issue-78
git worktree remove /tmp/issue-99
```

---

## ⚠️ Rules

1. **Use the right execution mode per agent**:
   - Codex/Pi/OpenCode: `pty:true`
   - Claude Code: `--print --permission-mode bypassPermissions` (no PTY required)
2. **Respect tool choice** - if user asks for Codex, use Codex.
   - Orchestrator mode: do NOT hand-code patches yourself.
   - If an agent fails/hangs, respawn it or ask the user for direction, but don't silently take over.
3. **Be patient** - don't kill sessions because they're "slow"
4. **Monitor with process:log** - check progress without interfering
5. **--full-auto for building** - auto-approves changes
6. **vanilla for reviewing** - no special flags needed
7. **Parallel is OK** - run many Codex processes at once for batch work
8. **NEVER start Codex inside your OpenClaw state directory** (`$OPENCLAW_STATE_DIR`, default `~/.openclaw`) - it'll read your soul docs and get weird ideas about the org chart!
9. **NEVER checkout branches in ~/Projects/openclaw/** - that's the LIVE OpenClaw instance!

---

## Progress Updates (Critical)

When you spawn coding agents in the background, keep the user in the loop.

- Send 1 short message when you start (what's running + where).
- Then only update again when something changes:
  - a milestone completes (build finished, tests passed)
  - the agent asks a question / needs input
  - you hit an error or need user action
  - the agent finishes (include what changed + where)
- If you kill a session, immediately say you killed it and why.

This prevents the user from seeing only "Agent failed before reply" and having no idea what happened.

---

## Auto-Notify on Completion

For long-running background tasks, append a wake trigger to your prompt so OpenClaw gets notified immediately when the agent finishes (instead of waiting for the next heartbeat):

```
... your task here.

When completely finished, run this command to notify me:
openclaw system event --text "Done: [brief summary of what was built]" --mode now
```

**Example:**

```bash
bash pty:true workdir:~/project background:true command:"codex --yolo exec 'Build a REST API for todos.

When completely finished, run: openclaw system event --text \"Done: Built todos REST API with CRUD endpoints\" --mode now'"
```

This triggers an immediate wake event — Skippy gets pinged in seconds, not 10 minutes.

---

## Learnings (Jan 2026)

- **PTY is essential:** Coding agents are interactive terminal apps. Without `pty:true`, output breaks or agent hangs.
- **Git repo required:** Codex won't run outside a git directory. Use `mktemp -d && git init` for scratch work.
- **exec is your friend:** `codex exec "prompt"` runs and exits cleanly - perfect for one-shots.
- **submit vs write:** Use `submit` to send input + Enter, `write` for raw data without newline.
- **Sass works:** Codex responds well to playful prompts. Asked it to write a haiku about being second fiddle to a space lobster, got: _"Second chair, I code / Space lobster sets the tempo / Keys glow, I follow"_ 🦞
