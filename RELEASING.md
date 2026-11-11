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

`release.yml` packs both in the `package` job, verifies they are a matched
pair (same version, identical `runtime.json`, sha256 of the packed archive),
uploads them as the `package-tgz` and `runtime-tgz` artifacts, and attaches
both tarballs to the GitHub Release. The standalone launcher fetches the
runtime by that exact version — never `latest`.

**Publish order:** the runtime package is published first, then the shell.
That way a slim shell never lands on the registry without its runtime (a
user who upgrades in that window would otherwise get a 404 on first
standalone start). The publish job re-runs the pair check immediately
before `npm publish`.

**Do not republish `0.4.41`.** That version is already on npm as the fat
shell that embeds `vendor/dsh-runtime.tgz`. This change must ship as a new
patch (for example `0.4.42`) in a separate release PR; the version bump is
not part of the packaging-split PR.

Prerequisites for the runtime package (user action, not done by this PR):

- On npmjs, add a **trusted publisher** (GitHub Actions OIDC) for the new
  package `@openma/deepseek-harness-acp-runtime`, same repository
  (`openma-ai/deepseek-harness-acp`) and the same `Release` workflow already
  used by the shell. Do this **before** pushing the release tag. This PR
  does not create the npm package, does not configure OIDC, and does not
  publish.
- The version pair and archive sha256 are generated at pack time from
  `package.json` and the built `dsh-runtime.tgz`, then checked by
  `scripts/verify-release-artifacts.mjs`. A stale `vendor/` tree will fail
  that check rather than publish a mismatched pair.

Until `@openma/deepseek-harness-acp-runtime` is actually on the public
registry (it is a 404 today), the public path “npm install the slim shell
→ first standalone start fetches the runtime from npmjs” is **unverified**.
Local pack artifacts and a fake registry in unit tests are not that path.
A slim install plus an offline first start, with no prefetch and no local
artifact, fails by design; after the cache is warm, offline start works as
before.
