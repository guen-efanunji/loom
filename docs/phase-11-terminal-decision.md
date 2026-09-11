# Phase 11 Decision: Defer Workspace Terminal

Phase 11 is explicitly deferred for V2. Loom does not currently require interactive shell access to validate parallel AgentRun execution, and adding a PTY service would introduce process lifecycle, input handling, authorization, output bounding, and worktree escape risks without being required by the core loop.

The daemon exposes workspace and recovery state through existing APIs. A future terminal implementation must bind every PTY to a validated task workspace, enforce permission policy, bound output, and include lifecycle and security tests before approval.
