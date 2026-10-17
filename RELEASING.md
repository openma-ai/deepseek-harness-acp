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
