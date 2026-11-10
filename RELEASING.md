# Releasing dsh-acp

Every change to `main` — releases included — has an issue and a pull request.
Nobody pushes to `main` directly. (The 0.4.39-beta.1, 0.4.39-beta.2 and 0.4.39
release commits `051fc1e`, `954c138`, `13a1464` were pushed directly; #46 is
their retroactive record. History was not rewritten.)

Versioning policy is unchanged (see AGENTS.md): agents release patch versions
only; the minor version belongs to the maintainer.

1. **Release issue** `Release X.Y.Z`: what ships (merged PRs) and how it will be
   verified.
2. **Release PR** from an up-to-date `main`:

   ```sh
   git switch -c release/vX.Y.Z
   npm version X.Y.Z --no-git-tag-version   # package.json + package-lock.json
   git commit -am "release: vX.Y.Z"
   git push -u origin release/vX.Y.Z
   gh pr create --title "release: vX.Y.Z" --body "Closes #<release issue>"
   ```

   Wait for CI (including `release check` and the `dsh --profile` matrix) and
   squash-merge normally.
3. **Tag the merged commit** — never a local, unmerged one:

   ```sh
   git switch main && git pull
   test "$(node -p 'require("./package.json").version')" = X.Y.Z
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

   `release.yml` verifies the tag is on `main`, reruns the matrix, and publishes
   via OIDC (`-alpha`/`-beta`/`-rc` tags → npm `beta`, otherwise `latest`).
4. **Record**: post the publish result and any downstream verification on the
   release issue.

## The runtime package

The shell no longer carries the private runtime. A release therefore publishes
**two** npm packages, both at the shell's version:

- `@openma/deepseek-harness-acp` — the slim shell (the pinned manifest
  `vendor/runtime.json` travels with it).
- `@openma/deepseek-harness-acp-runtime` — the runtime archive
  (`dsh-runtime.tgz` + the manifest), built by `npm run runtime:pack`.

`release.yml` packs both in the `package` job, uploads them as the
`package-tgz` and `runtime-tgz` artifacts, publishes both with the same
dist-tag, and attaches both tarballs to the GitHub Release. The standalone
launcher fetches the runtime by that exact version — never `latest`.

Prerequisites for the runtime package:

- npm trusted publishing (OIDC) must be configured for
  `@openma/deepseek-harness-acp-runtime` in the same repository, next to the
  shell's configuration.
- The version pair is generated, not hand-written: the runtime manifest is
  built from `package.json`'s version at pack time, so a release cannot ship a
  mismatched pair.

Until the runtime package is published, a standalone first start needs either
the network (the published artifact) or a local artifact handed over with
`DSH_ACP_RUNTIME_TARBALL` / `DSH_ACP_RUNTIME_PACK`.
