# Agent notes

## Versioning policy (owner-mandated)

- **The minor version (`0.X.y`) is owned by the human maintainer.** Never
  bump it — not for features, not for anything — without explicit approval
  in the current conversation.
- Agents may release **patch versions only** (`0.4.3 → 0.4.4`), and only
  when there is a concrete reason to ship (bugfix, or the maintainer asked
  for a release).
- New features land on `main` and **accumulate unreleased**. They ride the
  next release the maintainer approves; do not tag a release per feature.
- Release mechanics: version bump commit + `git tag vX.Y.Z` + push tags →
  GitHub Actions publishes to npm via OIDC. Local `npm publish` is not used.

## Project shape (quick orientation)

- ACP (Agent Client Protocol) adapter for DeepSeek Harness (`dsh`); runs as
  standalone `dsh-acp` bin, as a dsh profile plugin, or linked for dev.
- `src/profile-boot.ts` boots the harness's own profile machinery in-process;
  `src/bridge/` is the ACP ↔ harness session bridge; `cordis.patch.yml` is
  the bundle patch mounted by `dsh plugin add`.
- Tests: `DSH_ACP_TEST_HOST=/tmp/dsh-probe npm test` (needs a dsh host tree).
- Standalone always uses the vendored runtime unless a harness is named
  explicitly (`--dsh-path`/`DSH_PATH`/`DSH_ACP_HOST`, or `bundled`);
  PATH/invoking-dir/global installs are never probed. Plugin mode uses the
  mounting host dsh. Both are checked against the `peerDependencies` floor
  (`>=`, mirrored in `engines.dsh`); newer dsh versions are attempted, with
  feature detection for API differences — never add an exact-version pin.
