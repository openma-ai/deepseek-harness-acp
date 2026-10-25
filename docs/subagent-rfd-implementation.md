# DSH subagent RFD core slice — unreleased

Base: e771ecf6a6eec2dea0165cd061369060190d5e23 (package 0.4.39).
Official contract reviewed: https://agentclientprotocol.com/rfds/subagents

## Implemented
- v1 `clientCapabilities.subagents` object opt-in; missing/null retain legacy `_meta.dsh` lifecycle.
- Immediate-parent `subagent_update`, provider child conversation IDs retained across activations; no child cancel capability advertised.
- Automatic child-addressed text/thought/tool/plan/usage events and live assistant frames.
- Activation start/end and observed agent running/idle transitions, mapped stop reasons.
- Final text as child outgoing `session_message`; parent incoming view only on observed foreground structured tool result or durable attributed settlement message. Independent IDs with reciprocal references; no 20k tool-preview truncation of these messages.
- Permissions and elicitation for announced local child agents use child session IDs; always-allow updates the child, not its parent.
- SDK 2.0.2 `/unstable` app API migration. Latest RFD's reference fields are a narrow typed additive delta because SDK 2.0.2 predates them.
- No runtime dependency upgrades, version bump, commit, publish, or Backchat edits.

## Verification
Test-first evidence: rfd-red.log (four missing-behavior failures), rfd-second-red.log (receipt/work-state failures), rfd-third-red.log (foreground receipt failure).
Final typecheck: PASS (`node node_modules/typescript/bin/tsc --noEmit`).
Build: PASS (`node build.mjs`).
Non-e2e suite: 39 files, 310 tests PASS (`node node_modules/vitest/vitest.mjs run --exclude test/e2e.test.ts`).
Ten RFD tests use the real bridge, real SDK 2.0.2 app and real bidirectional JSON-RPC streams with controlled Cordis/mock host events; no model generation is involved.
Full-host stdio subagent tests: 2 FAIL at initialize timeout. Host reports failed imports for acp-plugin/acp-bridge and optional pi-ai/otel. No child traffic or live-model evidence was obtained. See artifacts/rfd-host-integration.log. The extended stdio tests remain in test/e2e.test.ts for a complete dependency installation.

## Remaining boundaries (not a complete RFD implementation)
- Host-profile stdio startup must be investigated and passed before release. Current checkout reuses read-only installed host packages through ignored node_modules symlinks; this is not a clean npm-ci validation.
- Early child traffic/permission arriving before subagent/start is not buffered/announced by this slice. Only announced local children are routed; no claim of full early-callback ordering support.
- No child config snapshots, history/reconnection association replay, requires_action/unknown state reporting, or child cancellation support.
- Directed messages are whole-message upserts, not session_message_chunk streaming. Generic received adjacent-agent messages are observable; outgoing instruction/report mirroring and reciprocal linking beyond final settlements are not implemented.
- This slice exposes textual final output. Non-text DSH attachment conversion is not implemented.
- Detached background job result receipts and failed foreground tool-result partial-output linking are not covered (the child's outgoing final text is retained when supplied by lifecycle).
- Live job-ring output for child tools is not added; ordinary child tool events/results are routed.
- No production live-model or packaged runtime smoke claim.

## Local reproduction
Dependencies used read-only DSH host cache: /Users/minimax/.cache/dsh-acp/0.2.0-rc.2-c0fe252b4d43/node_modules.
Only SDK 2.0.2 and the already-declared @types/semver 7.5.8 were downloaded into this repo for verification. Existing runtime/package*.json are unchanged.
Patch: artifacts/dsh-subagents-rfd-core.patch. Apply against the base with git apply --check then git apply. No git index changes are required.
