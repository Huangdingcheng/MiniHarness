# MiniHarness

### A Small Agent Harness for Learning and Experimentation

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-ESM-339933?logo=nodedotjs&logoColor=white)
![pnpm](https://img.shields.io/badge/package%20manager-pnpm-F69220?logo=pnpm&logoColor=white)
![Vitest](https://img.shields.io/badge/tests-Vitest-6E9F18?logo=vitest&logoColor=white)
![Status](https://img.shields.io/badge/status-learning%20MVP-10A37F)

*A lightweight coding-agent harness — built to learn the engineering
around the model, not just the model API.*

[Architecture](#architecture) · [Quick Start](#quick-start) · [Execution
Flow](#execution-flow) · [Safety Boundaries](#safety-boundaries) ·
[Roadmap](#roadmap)

------------------------------------------------------------------------

## What is MiniHarness?

MiniHarness is a **learning-oriented Agent Harness MVP** written in
TypeScript. It connects an OpenAI-compatible model API to an agent loop,
a small tool system, execution controls, structured traces, and a local
workspace review/writeback workflow.

The goal is not to reproduce a full production coding agent. It is to
make the important moving parts visible and understandable:

- **Agent Loop** — request a model response, execute requested tools,
  feed tool results back, and continue until a stopping condition is
  reached.
- **Tool Registry and Policy** — separate tool descriptions from their
  implementations, and decide whether a call is allowed, requires
  approval, or must be denied.
- **Runtime controls** — run a small, fixed set of checks with timeouts
  and bounded output.
- **Execution traces** — record lifecycle events as JSONL for inspection
  and debugging.
- **Workspace isolation by copying** — let the agent work in a temporary
  project copy rather than editing the source tree directly.
- **Diff, baseline checks, and controlled writeback** — inspect changes,
  detect conflicts, ask for approval, and apply approved file operations
  back to the source project.

> **Scope:** this is a local learning project. Its temporary workspace
> is an application-level isolation mechanism, **not** a Docker
> container or a complete operating-system security sandbox.

## Why build a harness?

A model API call alone does not make a useful coding agent. A practical
agent also needs a control loop, tool execution, policy enforcement,
context management, observability, and a way to review its changes.

MiniHarness is a small environment for studying those concerns one
module at a time.

## Architecture

``` mermaid
flowchart TB
    U["User task"] --> CLI["CLI / composition root"]
    CLI --> AG["Agent Loop"]
    AG <--> P["Model Provider"]
    P <--> LLM["OpenAI-compatible LLM API"]

    AG --> REG["Tool Registry"]
    REG --> POL["Tool Policy"]
    POL -->|allow / approved| TOOL["Tool handlers"]
    POL -->|deny| DENY["Return a policy error"]
    TOOL --> FS["Filesystem tools"]
    TOOL --> CHECK["Fixed checks: typecheck / test"]
    CHECK --> RT["Process Runtime"]

    AG -. lifecycle events .-> TRACE["Trace Writer → JSONL"]
    TRACE --> TR["Trace Reader / summary"]

    CLI --> WS["Temporary workspace"]
    WS --> BASE["File baseline + SHA-256"]
    WS --> DIFF["Workspace diff"]
    BASE --> REVIEW["Writeback pre-check"]
    DIFF --> REVIEW
    REVIEW --> APPROVAL["Per-file approval"]
    APPROVAL --> WB["Controlled writeback"]
    WB --> VERIFY["Post-write verification"]
```

### Core modules

| Module                | Responsibility                                                                                                                         |
|-----------------------|----------------------------------------------------------------------------------------------------------------------------------------|
| **Agent Core**        | Maintains the per-run message history, calls the model, dispatches tool calls, handles tool results, and enforces stopping conditions. |
| **Model Provider**    | Adapts internal chat messages to an OpenAI-compatible HTTP API and validates the response shape.                                       |
| **Tool Registry**     | Maps a tool name to its definition and handler.                                                                                        |
| **Tool Policy**       | Applies `allow`, `ask`, and `deny` decisions before a tool executes.                                                                   |
| **Process Runtime**   | Runs supported checks, captures stdout/stderr, applies timeouts, and limits captured output.                                           |
| **Trace**             | Writes structured lifecycle events to JSONL and reads them back for a compact execution summary.                                       |
| **Workspace**         | Creates a temporary copy of the project while excluding selected generated, private, or unnecessary files.                             |
| **Diff and Baseline** | Detects added, modified, and deleted files, and checks whether source files changed after the workspace baseline was created.          |
| **Writeback**         | Re-checks changes, requests explicit approval, applies approved file operations, and verifies the result.                              |

## Execution flow

A typical task follows this path:

1.  **Receive a task** from the CLI.
2.  **Create a temporary workspace** from the current project and record
    a baseline.
3.  **Prepare dependencies** in the workspace when required.
4.  **Start the Agent Loop** with the task and the initial message
    history.
5.  **Call the model.** The model may return a final answer or
    structured tool calls.
6.  **Authorize each tool call** using the policy layer.
7.  **Execute the tool** and append its result to the message history.
8.  **Continue the loop** until the model finishes, an error occurs, or
    the step limit is reached.
9.  **Inspect the trace and workspace diff** to understand what
    happened.
10. **Optionally apply approved changes** to the original project
    through the writeback workflow.

The key design idea is that a model-generated tool call is only a
**request**. It is not evidence that the tool ran successfully. The
harness executes the tool, captures the actual result, and feeds that
result back into the conversation.

## Key capabilities

### Agent and model integration

- OpenAI-compatible HTTP provider.
- Scripted provider for deterministic tests.
- Typed chat-message and tool-call representations.
- Multi-step tool-calling loop with explicit stopping conditions.
- Lifecycle events for observing a run.

### Tools and execution

- Filesystem tools for inspecting and editing files in the workspace.
- A fixed check tool for `pnpm typecheck` and `pnpm test`.
- Tool policy with `allow`, `ask`, and `deny` decisions.
- Process timeout and bounded-output handling.

### Workspace review and writeback

- Temporary local project copy.
- Exclusion rules for selected dependency, build, Git, trace, and
  configuration paths.
- File manifest and SHA-256 baseline.
- Added / modified / deleted file detection.
- Text diff rendering with line-ending normalization.
- Pre-write conflict and path-safety checks.
- Explicit per-file approval.
- Post-write verification and best-effort rollback.

### Observability

- JSONL execution traces.
- Trace reader and summary statistics.
- Tests for core agent behavior, provider parsing, tools, runtime,
  workspace, diff, and writeback checks.

## Quick Start

### Prerequisites

- Node.js (use a version supported by the project's `package.json` and
  lockfile).
- pnpm.
- An OpenAI-compatible model API endpoint and API key.

### 1. Install dependencies

``` bash
pnpm install
```

### 2. Configure the model provider

Create a local `.env` file in the project root. **Do not commit this
file.**

``` dotenv
LLM_API_KEY=replace-with-your-api-key
LLM_BASE_URL=https://your-openai-compatible-endpoint/v1
LLM_MODEL=your-model-name
```

Use the endpoint format expected by your provider. Do not paste real
keys into issues, screenshots, logs, or commits.

### 3. Run checks

``` bash
pnpm typecheck
pnpm test
```

### 4. Run an agent task

``` bash
pnpm dev -- "Read src/agent/agent.ts and explain how the Agent Loop works. Do not modify any files."
```

The CLI prints the source and temporary workspace paths, the trace path,
tool calls and results, and the final run status. The exact workspace
directory is generated for each run; use the path printed by the CLI
rather than copying an example path.

### 5. Inspect changes

Use the actual workspace path printed by the previous run:

``` bash
pnpm dev -- --diff "PATH_TO_THE_TEMPORARY_WORKSPACE"
```

### 6. Apply reviewed changes

``` bash
pnpm dev -- --apply "PATH_TO_THE_TEMPORARY_WORKSPACE"
```

The apply workflow checks the current changes, reports whether each file
is ready or blocked, and asks for approval before applying eligible
operations. Review the displayed paths and diffs carefully before
approving anything.

### 7. Inspect execution traces

``` bash
pnpm trace
```

If the CLI supports an explicit trace path in your current checkout, you
can pass the path printed by the run as well.

## Repository guide

The code is organized around the responsibilities below. File names may
evolve as the project develops.

``` text
src/
├── agent/       # Agent loop and message/tool orchestration
├── model/       # Chat types and model-provider adapters
├── tools/       # Tool definitions, handlers, and policy
├── runtime/     # Process execution, workspace, diff, and writeback logic
└── cli.ts       # CLI entry point and dependency composition

tests/
└── unit/        # Unit tests for core modules and safety-related behavior

docs/
└── development-history.html  # Long-form, visual development notes (optional)
```

## Memory and traces

MiniHarness currently has **per-run working memory**: the message
history is held in memory during one `Agent.run(...)` call and is used
to build subsequent model requests.

Execution traces are different. They are persisted to JSONL for
inspection, but the current implementation does not automatically
retrieve old traces, extract reusable experiences, or inject them into
future tasks. In other words:

- **Working memory** keeps the current run coherent.
- **Trace** records what happened.
- **Long-term memory** would preserve and retrieve useful information
  across runs; it is a future extension, not a completed feature.

## Safety boundaries

The project includes useful defensive measures, but they should not be
confused with a hardened sandbox.

**Implemented safeguards include:**

- Operating on a temporary copy rather than directly editing the source
  through ordinary workspace tools.
- Excluding selected sensitive and generated paths during workspace
  preparation.
- Validating paths and checking file state before writeback.
- Requiring explicit approval for eligible file changes.
- Restricting the check tool to fixed commands instead of interpolating
  arbitrary model-provided shell strings.
- Limiting process duration and captured output.
- Recording execution events for review.

**Known limitations:**

- Local processes still run with the operating-system permissions of the
  current user.
- The workspace is not a Docker container, VM, or remote execution
  environment.
- Filesystem races (TOCTOU), process crashes, and rollback failures are
  not eliminated.
- Multi-file writeback is not a fully atomic transaction.
- Dependency installation may access the network and package registries.
- Trace redaction is best-effort and cannot guarantee that every
  possible secret is removed.

**Do not use this project to execute untrusted code under the assumption
that the temporary directory provides complete security isolation.**

## Tests

Run the project checks with:

``` bash
pnpm typecheck
pnpm test
```

The unit tests are intended to verify module behavior and important
failure cases. Passing unit tests do not by themselves prove
production-grade security, reliability, or task success across arbitrary
repositories.

## Development notes

A longer visual document can live at
[`docs/development-history.html`](docs/miniharness_development_history.html). It
describes the design decisions, module boundaries, debugging lessons,
workspace lifecycle, baseline and diff logic, writeback flow, current
limitations, and possible next steps.

GitHub does not execute arbitrary JavaScript embedded in a README, so a
Three.js scene cannot run *inside* this Markdown page. If an interactive
3D architecture view is desired, the clean approach is to build it as a
separate web page (for example, with Vite + Three.js) and publish it
with GitHub Pages, then link to it here. Keep the README fast,
accessible, and useful even when JavaScript is disabled.

## Roadmap

- [x] Core Agent Loop and model-provider abstraction
- [x] Tool registry and policy decisions
- [x] Fixed checks with process timeout and output limits
- [x] JSONL execution tracing
- [x] Temporary local workspace and file baseline
- [x] Diff review and controlled writeback workflow
- [ ] More integration and fault-injection tests
- [ ] Clearer recovery behavior for interrupted multi-file writeback
- [ ] Optional long-term memory store and retrieval
- [ ] Optional Docker execution backend
- [ ] Optional interactive architecture site using Three.js
- [ ] Task-level evaluation for completion rate, latency, tool failures,
  and cost

## Learning objectives

This project is a practical exercise in **Agent Harness engineering**:

- Separate the model interface from the agent control loop.
- Treat tool calls as untrusted requests that require validation and
  execution.
- Make tool policy explicit rather than hiding it inside handlers.
- Observe the agent through structured events rather than relying only
  on terminal prose.
- Separate experimental edits from the original project.
- Treat review, approval, conflict detection, and writeback as part of
  the agent lifecycle.

The most valuable outcome is not a large feature list. It is a clearer
understanding of the systems around an LLM that make agent behavior
executable, inspectable, and easier to control.

------------------------------------------------------------------------

**MiniHarness · Learn the harness around the model.**

Built as a learning and experimentation project.
