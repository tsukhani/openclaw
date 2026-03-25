# OpenClaw Ontology Spec

> **Purpose:** Defines the core objects, relationships, actions, and composition rules of the OpenClaw system. This is the shared semantic contract between human developers and AI coding agents working on the codebase. Before adding features, refactoring, or fixing bugs — consult this spec to ensure changes align with the system's conceptual model.
>
> **Last updated:** 2026-03-24

---

## Core Objects (Nouns)

OpenClaw has **7 primary objects** that compose to form the entire system. Everything else is a specialization or configuration of these primitives.

### 1. Agent

The central actor. An agent is a configured AI persona with a model, workspace, tools, and identity.

| Property    | Description                                                               |
| ----------- | ------------------------------------------------------------------------- |
| `id`        | Unique identifier (e.g., `main`, `chetan`, `radha`)                       |
| `model`     | Primary LLM (with fallbacks)                                              |
| `workspace` | Root directory containing AGENTS.md, SOUL.md, IDENTITY.md, TOOLS.md, etc. |
| `skills`    | Available skill modules                                                   |
| `tools`     | Allowed tool set (exec, read, write, memory\_\*, etc.)                    |
| `sandbox`   | Isolation config (Docker, browser, filesystem scope)                      |
| `heartbeat` | Periodic check-in schedule and model                                      |

**Composition rules:**

- An Agent owns exactly one Workspace
- An Agent can have many Sessions (one per channel-peer combination)
- An Agent can spawn sub-Agents (via `sessions_spawn`)
- Agents are configured in `openclaw.json` under `agents.list`

---

### 2. Session

A conversation thread between a user and an agent. Sessions are the runtime container for all interaction.

| Property          | Description                                                              |
| ----------------- | ------------------------------------------------------------------------ |
| `sessionKey`      | Canonical identifier: `agent:<agentId>:<channel>:<chatType>:<peerId>`    |
| `sessionId`       | UUID for the current session instance (rotates on /new or /reset)        |
| `sessionFile`     | JSONL transcript file on disk                                            |
| `modelOverride`   | Per-session model override (user can switch models mid-conversation)     |
| `chatType`        | `direct`, `group`, `channel`                                             |
| `status`          | `running`, `done`, `failed`, `killed`, `timeout` (for subagent sessions) |
| `spawnDepth`      | 0 = main, 1 = sub-agent, 2 = sub-sub-agent                               |
| `compactionCount` | Number of times context was auto-compacted                               |

**Composition rules:**

- A Session belongs to exactly one Agent
- A Session is bound to one Channel + Peer combination (via Bindings)
- A Session accumulates Messages in a transcript file
- A Session can be compacted (context compressed) when it exceeds token limits
- Sessions can spawn child Sessions (sub-agents)

---

### 3. Message

The atomic unit of communication. Messages flow between users and agents through channels.

| Property    | Description                            |
| ----------- | -------------------------------------- |
| `role`      | `user`, `assistant`, `system`          |
| `content`   | Text, images, audio, or tool calls     |
| `channel`   | Origin channel (telegram, slack, etc.) |
| `sender`    | User metadata (id, name, username)     |
| `messageId` | Channel-native message identifier      |
| `replyTo`   | Optional reference to a parent message |

**Composition rules:**

- Messages are appended to a Session transcript
- Messages trigger the auto-reply pipeline (routing → agent invocation → response)
- After each agent turn, Messages are processed by auto-capture (memory extraction)
- Messages can contain tool calls and tool results (structured sub-objects)

---

### 4. Memory

A stored fact, preference, decision, or lesson extracted from conversations or manually saved.

| Property           | Description                                                           |
| ------------------ | --------------------------------------------------------------------- |
| `id`               | UUID                                                                  |
| `text`             | The memory content                                                    |
| `category`         | `core`, `fact`, `preference`, `decision`, `entity`, `lesson`, `other` |
| `importance`       | 0.0–1.0 score                                                         |
| `embedding`        | Vector representation for semantic search                             |
| `source`           | `user` (manual) or `auto-capture`                                     |
| `extractionStatus` | `pending`, `completed`, `failed`, `skipped`                           |
| `agentId`          | Owning agent                                                          |

**Composition rules:**

- Memories are stored in Neo4j as `Memory` nodes
- A Memory can have Entity nodes extracted from it (EXTRACTED_FROM relationship)
- Memories can supersede other Memories (contradiction resolution)
- Memories decay over time based on category-specific half-life curves
- `core` memories are auto-loaded into every session context
- Memories are searchable via 3-signal hybrid search (vector + BM25 + graph)

---

### 5. Channel

A messaging transport that connects OpenClaw to external platforms.

| Property      | Description                                                                   |
| ------------- | ----------------------------------------------------------------------------- |
| `type`        | `telegram`, `slack`, `discord`, `whatsapp`, `signal`, `irc`, `imessage`, etc. |
| `accounts`    | Multiple bot accounts per channel type                                        |
| `dmPolicy`    | `allowlist`, `pairing`, `open`                                                |
| `groupPolicy` | `allowlist`, `open`                                                           |
| `streaming`   | `partial`, `full`, `off`                                                      |

**Composition rules:**

- Channels receive Messages and deliver them to the routing layer
- The routing layer uses Bindings to map Channel+Peer → Agent
- Each Channel has channel-specific capabilities (reactions, buttons, threads, etc.)
- A Channel can have multiple accounts (e.g., separate Telegram bots for different agents)

---

### 6. Plugin

An extension module that adds capabilities to the system.

| Property | Description                                                   |
| -------- | ------------------------------------------------------------- |
| `id`     | Unique identifier (e.g., `memory-neo4j`, `telegram`, `slack`) |
| `type`   | `memory`, `channel`, `provider`, `utility`                    |
| `hooks`  | Event handlers (agent_start, agent_end, command, etc.)        |
| `config` | Plugin-specific configuration                                 |
| `slot`   | System slot the plugin fills (e.g., `memory` slot)            |

**Composition rules:**

- Plugins register hooks that fire at specific lifecycle events
- Only one Plugin can fill each system slot (e.g., one memory backend)
- Plugins can define CLI commands, tools, and provider integrations
- Plugins are loaded from `extensions/` directory
- Plugin config lives in `openclaw.json` under `plugins.entries.<pluginId>.config`

---

### 7. Skill

A reusable instruction module that teaches the agent how to perform specific tasks.

| Property      | Description                                 |
| ------------- | ------------------------------------------- |
| `name`        | Human-readable identifier                   |
| `description` | Used for automatic skill matching           |
| `location`    | Path to SKILL.md file                       |
| `references`  | Supporting files (scripts, templates, docs) |

**Composition rules:**

- Skills are scanned by description at every turn — the most relevant skill is loaded
- A Skill's SKILL.md is injected into context when matched
- Skills can reference scripts and binaries in their directory
- Skills are configured per-Agent (agents can have different skill sets)

---

## Relationships (How Objects Connect)

```
User ──[sends]──► Message ──[via]──► Channel
                     │
                     ▼
              Routing Layer ──[uses]──► Binding ──[maps to]──► Agent
                     │
                     ▼
                  Session ──[accumulates]──► Messages
                     │
                     ├──[invokes]──► Agent ──[uses]──► Model (LLM)
                     │                  │
                     │                  ├──[loads]──► Skills
                     │                  ├──[calls]──► Tools
                     │                  └──[reads]──► Workspace files
                     │
                     ├──[triggers]──► Auto-capture ──[creates]──► Memory
                     │                                              │
                     │                                    ┌─────────┤
                     │                                    ▼         ▼
                     │                                 Entity   Relationship
                     │                                (graph)    (graph)
                     │
                     └──[spawns]──► Child Session (sub-agent)
```

### Key Relationship Types

| Relationship       | From         | To        | Description                                       |
| ------------------ | ------------ | --------- | ------------------------------------------------- |
| **routes_to**      | Channel+Peer | Agent     | Bindings map inbound messages to agents           |
| **owns**           | Agent        | Session   | Agent manages all its sessions                    |
| **contains**       | Session      | Message[] | Session accumulates a transcript                  |
| **uses**           | Agent        | Model     | Agent calls an LLM provider                       |
| **loads**          | Agent        | Skill     | Skills are matched and injected per-turn          |
| **captures**       | Message      | Memory    | Auto-capture extracts memories from conversation  |
| **extracted_from** | Entity       | Memory    | Graph entities link back to source memory         |
| **supersedes**     | Memory       | Memory    | Newer facts replace older contradictions          |
| **spawns**         | Session      | Session   | Parent sessions spawn sub-agent sessions          |
| **fills**          | Plugin       | Slot      | A plugin occupies a system slot (memory, channel) |
| **fires**          | Plugin       | Hook      | Plugins respond to lifecycle events               |

---

## Actions (Verbs)

### Message Lifecycle

| Verb        | Subject | Object  | Description                                          |
| ----------- | ------- | ------- | ---------------------------------------------------- |
| **send**    | User    | Message | User sends a message via a Channel                   |
| **route**   | System  | Message | Route message to the correct Agent via Bindings      |
| **reply**   | Agent   | Message | Agent generates and sends a response                 |
| **react**   | Agent   | Message | Agent adds an emoji reaction                         |
| **stream**  | Agent   | Message | Agent sends partial response tokens as they generate |
| **compact** | System  | Session | Compress session context when token limit approached |

### Memory Lifecycle

| Verb            | Subject      | Object              | Description                                    |
| --------------- | ------------ | ------------------- | ---------------------------------------------- |
| **store**       | Agent/System | Memory              | Save a memory (manual or auto-captured)        |
| **recall**      | Agent        | Memory[]            | Search memories by semantic query              |
| **forget**      | Agent        | Memory              | Delete a specific memory                       |
| **extract**     | Sleep Cycle  | Entity+Relationship | Extract graph entities from pending memories   |
| **supersede**   | System       | Memory              | Mark a memory as replaced by a newer one       |
| **decay**       | Sleep Cycle  | Memory              | Reduce importance over time based on half-life |
| **deduplicate** | Sleep Cycle  | Memory              | Merge near-duplicate memories                  |
| **decompose**   | Auto-capture | Memory[]            | Split blob messages into atomic facts          |

### Agent Lifecycle

| Verb          | Subject | Object    | Description                                     |
| ------------- | ------- | --------- | ----------------------------------------------- |
| **spawn**     | Agent   | Session   | Create a sub-agent session                      |
| **steer**     | Agent   | Sub-agent | Send a follow-up message to a running sub-agent |
| **kill**      | Agent   | Sub-agent | Terminate a sub-agent session                   |
| **heartbeat** | System  | Agent     | Periodic check-in poll                          |
| **bootstrap** | System  | Agent     | Load workspace files into initial context       |

### System Lifecycle

| Verb         | Subject | Object       | Description                                                  |
| ------------ | ------- | ------------ | ------------------------------------------------------------ |
| **restart**  | System  | Gateway      | Reload config and re-initialize (SIGUSR1)                    |
| **sleep**    | System  | Memory Store | Run overnight consolidation (extract, dedup, decay, cleanup) |
| **schedule** | Cron    | Job          | Create a timed job (one-shot or recurring)                   |
| **wake**     | Cron    | Session      | Inject a system event into a session                         |

---

## Provenance (How Objects Transform)

### Memory Provenance

```
User message → Auto-capture gate → Importance rating → Dedup check
  → Store as Memory (extractionStatus: pending)
  → [Sleep cycle] Entity extraction → Knowledge graph
  → [Sleep cycle] Decay → Importance reduced over time
  → [Sleep cycle] Dedup → Merged with near-duplicates
  → [Superseded] Marked as replaced by newer contradicting fact
  → [Forgotten] Deleted by user or agent
```

### Session Provenance

```
First message → Session created (new sessionId, transcript file)
  → Messages accumulate in transcript
  → [Token limit approaching] Pre-compaction memory flush
  → [Token limit hit] Context compacted (summary replaces history)
  → [/new or /reset] Session rotated (SESSION_CONTEXT.md written, new sessionId)
  → [Gateway restart] Session survives (transcript file persisted)
```

### Message Provenance

```
User input → Channel receives → Routing resolves Agent
  → Queue check (interrupt mode: cancel in-flight, process new)
  → System prompt assembled (workspace files + skills + memories + tools)
  → Agent invoked (LLM call with streaming)
  → Response delivered to Channel
  → Auto-capture processes both user + assistant messages
```

---

## Composition Rules (The Grammar)

These rules define how objects compose and constrain each other:

1. **One memory backend per system.** The `memory` plugin slot accepts exactly one plugin. All memory operations route through it.

2. **Bindings are the routing table.** Every inbound message must match a Binding to reach an Agent. No binding = no response.

3. **Sessions are per-channel-peer.** Each unique Agent + Channel + Peer combination gets its own Session. DM with Tarun on Telegram ≠ DM with Tarun on Slack.

4. **Skills are matched, not called.** The system scans skill descriptions every turn and injects the best match. Skills don't have explicit invocation — they're discovered.

5. **Workspace files are the agent's identity.** AGENTS.md (procedures), SOUL.md (personality), IDENTITY.md (name/avatar), TOOLS.md (tool notes), USER.md (user info) — these bootstrap every session.

6. **Plugins extend via hooks, not patches.** Plugins register event handlers — they don't modify core code. The hook system (agent_start, agent_end, command, etc.) is the extension API.

7. **Sub-agents inherit workspace.** When an agent spawns a sub-agent, the child inherits the parent's workspace directory unless explicitly overridden.

8. **Config is the single source of truth.** `openclaw.json` defines everything: agents, channels, models, plugins, bindings, cron jobs, hooks. Runtime state lives in session stores and memory backends.

---

## Anti-Patterns (What NOT to Do)

| Anti-pattern                           | Why it's wrong                                                                               | Do this instead                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Adding a new "type" of session         | Sessions are generic containers — specialize via config, not subclasses                      | Use session metadata fields or agent-level config |
| Putting business logic in plugins      | Plugins are for infrastructure (memory, channels, providers)                                 | Use Skills for business logic                     |
| Hard-coding channel behavior           | Channels are transports — they shouldn't know about agent logic                              | Route through the generic message pipeline        |
| Creating new workspace bootstrap files | The bootstrap set is fixed (AGENTS, SOUL, IDENTITY, TOOLS, USER, HEARTBEAT, SESSION_CONTEXT) | Add content to existing files or use Skills       |
| Bypassing the routing layer            | Don't send messages directly to agents from channels                                         | Always route through Bindings                     |
| Storing state in memory files          | Memory is for facts/preferences, not runtime state                                           | Use session entries or plugin state               |

---

## Quick Reference: Where Things Live

| Concept             | Code Location                              | Config Location                       |
| ------------------- | ------------------------------------------ | ------------------------------------- |
| Agent definition    | `src/agents/`                              | `agents.list[]` in openclaw.json      |
| Session management  | `src/sessions/`, `src/config/sessions/`    | `session.*` in openclaw.json          |
| Message routing     | `src/routing/`, `src/bindings/`            | `bindings[]` in openclaw.json         |
| Auto-reply pipeline | `src/auto-reply/`                          | —                                     |
| Memory (core)       | `src/memory/`                              | `plugins.entries.memory-neo4j.config` |
| Memory (Neo4j)      | `extensions/memory-neo4j/`                 | `plugins.entries.memory-neo4j.config` |
| Channels            | `src/channels/`, `extensions/<channel>/`   | `channels.*` in openclaw.json         |
| Plugins             | `src/plugins/`, `src/plugin-sdk/`          | `plugins.*` in openclaw.json          |
| Skills              | `skills/`, `~/.openclaw/workspace/skills/` | `skills.*` in openclaw.json           |
| Cron                | `src/cron/`                                | `cron.*` in openclaw.json             |
| Hooks               | `src/hooks/`                               | `hooks.*` in openclaw.json            |
| Gateway             | `src/gateway/`                             | `gateway.*` in openclaw.json          |
| System prompt       | `src/agents/system-prompt.ts`              | —                                     |
| Workspace bootstrap | `src/agents/workspace.ts`                  | `agents.defaults.workspace`           |
| Context compaction  | `src/agents/pi-embedded-runner/compact.ts` | `agents.defaults.compaction`          |
| Tool definitions    | `src/agents/tools/`                        | `tools.*` in openclaw.json            |

---

_This ontology is a living document. Update it when core objects, relationships, or composition rules change._
