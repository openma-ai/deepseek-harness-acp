# 贡献指南

**English.** Canonical contribution guide for the openma-ai org. It lives in `open-managed-agents` first; copy it to other org repos or an org `.github` repo and replace only **本仓库**. Shared rules: conventional-commit titles, squash merge, small PRs, green CI with a root cause for failures, a compatibility check on dependency bumps plus a follow-up bump downstream after release, private security reports, and an evidence report on every PR before merge.

以下各节是组织约定，从 `open-managed-agents` 的 `09bbbd37`（#240）原样复制。共享各节里的 PR 编号和例子仍指原文里的仓库。标题为「本仓库」的一节只适用于 `deepseek-harness-acp`。再复制到别的仓库时换掉这一节，并改掉文中指向该仓库文件的链接。

## 分支 / Branches

从 `main` 拉出。人工分支用小写：

```text
<type>/<kebab-summary>
```

`type` 与 PR 标题类型一致。近期合并：`fix/ci-minio-image`（#227）、`feat/sql-realtime-fanout`（#222）、`refactor/split-node-assembly`（#234）、`docs/discord-community`（#197）。关联 issue 时把编号放进名字，例如 `fix/196-session-update-idle`。

工具前缀保持原样：`dependabot/…`、`codex/…`、`cursor/…`。deepseek-harness-acp 的 dsh 升级分支是 `codex/bump-dsh-<version>`。

一个分支一件事。跟上 `main` 用 rebase。

## PR 标题与 squash / PR titles

标题用 [Conventional Commits](https://www.conventionalcommits.org/)。squash 之后它就是 `main` 上的提交说明，GitHub 再追加 `(#编号)`：

```text
<type>(<scope>): <祈使句，说明做了什么>
```

`scope` 可省略。常用 type：`feat` `fix` `refactor` `perf` `docs` `test` `ci` `chore`。依赖用 `chore(deps):`。一篇 PR 一个 type。近期合进去的标题也不都是这个格式：#224 是 `fix+feat(...)`；#237 是 `Workspace persistence semantics: durable_mount vs fenced checkpoint_restore, shared Session outputs`；#239 是 `CMA retry_status semantics + live-found fixes (...)`。新 PR 用单一 conventional type。

发版提交的主题是 `release: vX.Y.Z`（见「发布」），普通 PR 不用这个前缀。

合并方式是 **squash**。本仓库近期 `main` 上每篇 PR 是一个单父提交，主题即 PR 标题。#202 写明仓库不接受 merge commit，因此把多篇依赖 PR 合成一篇再 squash。deepseek-harness-acp 历史上有过 merge commit（#30）；新 PR 按 squash 合。

## 小 PR / Small PRs

一次改一个问题或一个职责。`main-node` 控制面拆分是一串短 PR（#225、#228–#234），每篇只动一层。文档、重命名、行为变更分开。

lockfile 冲突时可以把多篇依赖更新合成一篇，跑一次完整 CI（#202 包含 #201–#206）。描述里列出被包含的 PR。

## 证据报告 / Evidence report

**合并前，PR 描述或一条评论里必须有证据报告，并且对应当前 head SHA。** 缺段，或证据还停在旧 SHA 上，就不合并。仓库没有把这件事做成 status check：作者填写，维护者核对。模板是 `.github/pull_request_template.md`。

六段都要出现。没有内容就写「不适用」并给一句原因。

### 问题 / 动机

缺陷要有**在真实产品上**的复现：命令、版本、原样输出。只写推理不够。新能力写清谁在什么场景下需要它。

### 根因

写到代码或外部依赖的哪一层。上游变更（镜像仓库、npm 发布）和本仓库的缺陷分开写。

### 改动说明

做了什么、刻意没做什么。点名关键文件，不贴大段 diff。

### 验证证据

- 当前 head SHA。
- 该 SHA 上的 CI run 链接，写明 workflow 和 job。旧 push 的绿 run 不算。
- 跑过的测试名称和通过数（例如 `8 files / 42 tests`）。本地和 CI 都写。
- 改了 UI 或可见行为时，把截图或录屏嵌进 PR。可以直接拖进 GitHub。需要稳定链接时，推到孤立分支 `pr-assets`：

  ```bash
  git checkout --orphan pr-assets
  git rm -rf .
  mkdir -p pr-<编号>
  # 只放 png / webm。不要放密钥，也不要放未剪辑的大体积录屏。
  git add pr-<编号>
  git commit -m "pr-assets: <编号>"
  git push -u origin pr-assets
  ```

  链接形式：`https://raw.githubusercontent.com/openma-ai/<repo>/pr-assets/pr-<编号>/<file>`。`pr-assets` 只存证据，不在上面开发。

### 未验证的部分

写明没跑的检查和原因。作者自己的 mock、fixture、测试替身，与真实产品或上游行为分开。mock 通过不等于 KVM 沙箱、托管环境或下游仓库已经验证。

### 风险与回滚

最坏情况，以及怎么退回：revert 这篇 squash 提交，或发一个修复版本。发版和迁移要写用户会看到什么。

### 示例

#227 的缩写，只示范格式。新 PR 按自己的改动重写。

> **问题 / 动机。** `pnpm test:integration:storage` 在 CI run [36001613340](https://github.com/openma-ai/open-managed-agents/actions/runs/36001613340) 的 global setup 失败，测试还没开始。日志是 MinIO 匿名拉取 `401 unauthorized`。干净机器上 `docker pull quay.io/minio/minio@sha256:d249d1fb…` 同样 401。
>
> **根因。** 仓库代码没有变化。`quay.io/minio/minio` 停止匿名拉取。
>
> **改动说明。** 测试镜像改为可匿名拉取的 `cgr.dev/chainguard/minio`，并钉住 manifest digest。
>
> **验证证据。** 本地 `pnpm test:integration:storage`：8 files / 42 tests 通过。合并前该 PR head 上的 CI storage 步骤通过。
>
> **未验证的部分。** 这是 CI 用的 MinIO 镜像，不是产品运行时依赖。没有改 S3 条件写相关的产品代码，也就没有另做产品级 S3 手工验证。
>
> **风险与回滚。** 只影响存储集成测试。revert 该提交即回到旧镜像引用。

## CI / 必须是绿的

合并前，当前 head SHA 上该 PR 该跑的 CI 全部成功。失败先读日志，写出根因，再改代码或改测试。不要对同一 SHA 反复 Re-run，直到碰巧变绿再合。

Re-run 可以用来收集第二次日志。第一次红、第二次绿时，报告里写明两次差异（超时、外部注册表、被 concurrency 取消的 run）。说不清原因就继续查。#227 的处理是确认 MinIO 注册表 401，然后更换镜像。

`concurrency.cancel-in-progress: true` 会取消同一 ref 上还在跑的旧 workflow。被取消的 run 不是 flake；看新 SHA 上的 run。

## 依赖升级 / Dependency upgrades

Dependabot 和手工 lockfile 更新都要做兼容性检查。CI 变绿只是其中一步：

- 读上游 changelog / release notes，列出行为变化。
- 跑本仓库已有的兼容矩阵，而不是只跑默认单测。deepseek-harness-acp 的 job `dsh-compatibility` 按 `runtime/compatibility.json` 安装多个 `@deepseek-ai/dsh` 并做 profile smoke。定时 workflow `dsh-update.yml` 会打开 `chore: upgrade bundled dsh to <version>`。#33 给这个 workflow 加了 Cursor agent 复查；人仍然负责合并。
- 升级 PR 不顺便给本包打版本。dsh 自动 PR 的正文写明：This PR does not bump or release the ACP package。
- 适配修不好就不合并。

发布之后，下游另开 bump PR，把依赖改到刚发布的版本，并跑下游自己的 CI：

- Martty 的 `npm/package.json` 依赖 `@openma/deepseek-harness-acp`。CHANGELOG 记录过随 0.4.29、0.4.31 的升级；#135 跟上了 0.4.35 的打包修复。
- openma-common 打 tag 之后，两个消费仓库改到新 tag 并提交 lockfile（该仓库 `CONTRIBUTING.md` 的 release checklist）。

## 发布 / Release

以该仓库的 workflow 为准。组织里实际有两种。

**打 tag。** deepseek-harness-acp、Martty、openma-common：

1. 版本写进清单。Martty 还要求 tag、`npm/package.json`、`Cargo.toml` 一致（`scripts/check-release-tag.mjs`）。
2. dsh 与 Martty 在 `main` 上的发版提交主题为 `release: vX.Y.Z`（dsh `v0.4.36`、Martty `v0.3.0`）。openma-common 是发版 PR 合并后再打同名 tag。
3. `git tag vX.Y.Z && git push origin vX.Y.Z`。tag 指向 `main` 上的那次提交。
4. tag 触发发布：dsh `release.yml` 先确认 tag 在 `main` 上，再跑测试、dsh 兼容矩阵和 standalone smoke，然后用 npm OIDC 发布。Martty `package-npm.yml` 监听 `v*.*.*`。
5. openma-common 是 `private: true` 的 git 依赖：打 tag 后更新消费方，不发 npm。

**Changesets。** 用来发布 `@openma/cli` / `@openma/sdk`。步骤在「本仓库」。本仓库的 `version-pr` 会跑 MySQL 集成，但没有 `Enable KVM for Litebox`；没有 `/dev/kvm` 时 Litebox 用例会失败。

发版提交只含版本和 changelog。功能先进普通 PR。发版后按上一节给下游开 bump PR。

## 安全 / Security

私下报告，不要开公开 issue。本仓库走 [`SECURITY.md`](https://github.com/openma-ai/open-managed-agents/blob/09bbbd37b9cf3b2c62c4aa5df1298b2ff4c6043f/SECURITY.md) 和 [Private vulnerability reporting](https://github.com/openma-ai/open-managed-agents/security/advisories/new)。复制到别的仓库时改成那个仓库的私下渠道。

发行物里不带调试端口，也不带密钥：

- 发布的 Node 进程、镜像 `CMD`、安装包里不开 `--inspect`、`9229`，也不开 Chrome `--remote-debugging-port`。
- 镜像只暴露产品端口，不额外 `EXPOSE` 调试端口。
- `.env`、`.dev.vars`、token、keystore 不进 git、npm 包、GHCR 镜像或桌面安装包。

依赖安全公告单独修（Backchat 有 `chore: prepare Backchat v0.0.9 security release`）。修法仍走普通 PR 和证据报告；公告细节走私下渠道。

## 本仓库：deepseek-harness-acp

包名 `@openma/deepseek-harness-acp`（`package.json` 的 `name`），版本 `0.4.36`（同一文件的 `version`）。复制进来之前，仓库没有 `CONTRIBUTING.md`、`SECURITY.md`、`.github/pull_request_template.md` 或 `.github/ISSUE_TEMPLATE/`。也没有 `CHANGELOG.md` 或 `.changeset/`。

### 分支与合并

从 `main` 拉出。2026-10-02 的 `git log`：`#34`（`0d62a58`）、`#32`（`dd2c9e5`）、`#33`（`74633af`）、`#31`（`8f30336`）都是单父提交，主题即 PR 标题。`#30` 的合并提交 `e736798` 有两个父提交 `ddf4d2f` 和 `2dc7716`。新 PR 按 squash 合。

dsh 升级分支名是 `codex/bump-dsh-<version>`（`.github/workflows/dsh-update.yml` 的 `UPDATE_BRANCH`）。

### 工具链

Node 要求写在 `package.json` 的 `engines.node`：`>=22.15`。仓库没有 `.node-version`、`.nvmrc`，`package.json` 也没有 `packageManager`。

CI 安装 Node 22 和 24（`.github/workflows/ci.yml` 与 `release.yml` 的 `matrix.node`）。`ci.yml` 的矩阵注释写明：harness session store 用到的 `node:zlib` zstd API 需要 `>= 22.15`。

本仓库用 npm。锁文件是根目录 `package-lock.json`。`scripts/pack-runtime.mjs` 把 `runtime/package.json` 和 `runtime/package-lock.json` 复制到临时目录，再 `npm ci`，打出 `vendor/dsh-runtime.tgz`。CI 的安装命令是 `npm ci`。

`pnpm` 在 `package.json` 的 `devDependencies` 里钉为 `11.22.0`（`package-lock.json` 解析为同一版本）。`dsh-compatibility` 用 `npm exec -- pnpm --dir <临时目录> add ... "@deepseek-ai/dsh@<版本>"` 安装独立 host。

`package-lock.json` 锁定的版本：TypeScript `7.0.2`，Vitest `4.1.10`，esbuild `0.28.2`，tsx `4.23.12`。`package.json` 里对应的范围是 `typescript` `^7.0.2`、`vitest` `^4.1.10`、`esbuild` `^0.28.1`、`tsx` `^4.23.1`。

内置 dsh 两处都是 `0.2.0-rc.2`：`package.json` 的 `dshAcp.standaloneDsh`，以及 `runtime/package.json` 的依赖 `@deepseek-ai/dsh`。profile 矩阵是 `runtime/compatibility.json`：`0.1.7-rc.2`、`0.2.0-rc.1`、`0.2.0-rc.2`。

`README.md` 的 “DSH compatibility” 仍写 bundled runtime 是 DSH `0.1.5-rc.1`。版本以 `package.json` 的 `dshAcp.standaloneDsh` 为准。`ci.yml` 和 `release.yml` 仍有 `if: matrix.dsh == '0.1.5-rc.1'` 的迁移步骤；当前 `runtime/compatibility.json` 不含这个版本，该步骤不会执行。

### 本地命令

`README.md` 的 “Development” 与 `package.json` 的 `scripts`：

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # pretest 先执行 npm run build，再 vitest run
npm run build       # node build.mjs
```

和 CI 对齐时，安装用 `npm ci`，然后 `npm run typecheck` 与 `npm test`。`ci.yml` 的 `test` job 在 `npm test` 之后还会再跑一次 `npm run build`。

`README.md` 还写了对独立 host 再跑测试：

```bash
npm install --prefix /tmp/dsh-host @deepseek-ai/dsh
DSH_ACP_TEST_HOST=/tmp/dsh-host npm test
```

`AGENTS.md` 写的是 `DSH_ACP_TEST_HOST=/tmp/dsh-probe npm test`。变量名相同，路径是示例。`package.json` 另有 `test:host`：`vitest run test/e2e.test.ts -t "serves session controls through the host tree"`。

### CI

2026-10-02 `gh workflow list` 列出三个 workflow：`CI`（`.github/workflows/ci.yml`）、`Release`（`release.yml`）、`Update bundled dsh`（`dsh-update.yml`）。

`CI` 在 `main` 的 push、所有 `pull_request`，以及 `workflow_dispatch` 时跑。`ci.yml` 与 `release.yml` 都没有 `concurrency`。`test` job 没有 `timeout-minutes`。`standalone` 的 `timeout-minutes` 是 20。

| Job | 运行环境 | 步骤 |
|---|---|---|
| `test` | `ubuntu-latest`、`ubuntu-24.04-arm`、`macos-latest`、`windows-latest` × Node 22、24。显示名 `test (<os>, node <node>)`。`fail-fast: false` | `npm ci`，`npm run typecheck`，`npm test`，`npm run build`。只有 `ubuntu-latest` 且 Node 24 时再 `npm pack`，并把 `*.tgz` 上传为 artifact `package-tgz` |
| `standalone` | `needs: test`，`if: ${{ !cancelled() }}`，同一组 OS × Node，超时 20 分钟 | 下载 `package-tgz`，执行 `node scripts/standalone-smoke.mjs` |
| `compatibility-versions` | `ubuntu-latest` | 把 `runtime/compatibility.json` 写入 job output `versions` |
| `dsh-compatibility` | `needs: compatibility-versions`。显示名 `dsh --profile (<matrix.dsh>)`。`ubuntu-latest`，Node 24。`fail-fast: false` | `npm ci`，`npm run build`，pnpm 安装 `@deepseek-ai/dsh@${{ matrix.dsh }}`（该步骤 `timeout-minutes: 5`），`npm pack --ignore-scripts`，再 `npm exec -- node scripts/profile-smoke.mjs` |

`test/ci-workflows.test.ts` 检查：`ci.yml` 与 `release.yml` 的测试矩阵包含 `ubuntu-24.04-arm` 和 `windows-latest`；`dsh-compatibility` 的矩阵来自 `compatibility-versions` 的 output；`runtime/compatibility.json` 恰好三个互不相同的版本，且包含 `dshAcp.standaloneDsh`；profile 步骤调用 `scripts/profile-smoke.mjs` 和 `$RUNNER_TEMP/dsh-host/`。

### 依赖升级与 Cursor 复查

`dsh-update.yml` 的名字是 `Update bundled dsh`。`schedule` 的 cron 是 `17 */6 * * *`，也可以 `workflow_dispatch`。`concurrency.group` 是 `dsh-update`，`cancel-in-progress` 是 `false`。

没有输入 `review_pr` 时跑 `update`（`ubuntu-latest`，`timeout-minutes: 20`）：

1. `npm ci --ignore-scripts`，然后 `node scripts/update-dsh.mjs`。`dshAcp.standaloneDsh` 已经等于 npm `dist-tags.latest` 时，脚本打印 `Bundled dsh is already <version>` 并以状态 0 退出，不写 `changed=true`。
2. `changed == 'true'` 且 origin 上还没有 `codex/bump-dsh-<version>` 时，才更新 development 与 `runtime` 的 lockfile。这两步都是 `continue-on-error: true`。然后提交 `chore: upgrade bundled dsh to <version>` 并推送。提交包含 `package.json`、`package-lock.json`、`runtime/package.json`、`runtime/package-lock.json`、`runtime/compatibility.json`。
3. 该分支还没有 PR 时，`gh pr create`。标题与提交说明相同。正文模板写明从旧版本升到新版本、刷新最近三个 release/RC 的 profile 检查、两份 lockfile 步骤的 outcome，以及 “CI must pass before merging. This PR does not bump or release the ACP package.”
4. 接着 `gh workflow run ci.yml --ref <branch>`。同一段脚本的注释写明：`GITHUB_TOKEN` 创建的 PR 不会触发 `pull_request` workflow。
5. 仅当这次新建了 PR（`pr_created == 'true'`）时，步骤 “Dispatch Cursor cloud agent for compatibility review” 调用 `bash scripts/dispatch-cursor-review.sh`。这是 #33 加的。人合并。

`workflow_dispatch` 填了 `review_pr` 时只跑 `review` job（`timeout-minutes: 10`），对已有 PR 调用同一个脚本。

`scripts/dispatch-cursor-review.sh`：

- 没有 `CURSOR_API_KEY` 时打印 `::warning::CURSOR_API_KEY not set. Skipping automated compatibility review.` 并以状态 0 退出。
- 有 key 时 `POST https://api.cursor.com/v1/agents`。payload 含 `workOnCurrentBranch: true` 与 `autoCreatePR: false`。`README.md` 的 “Automated compatibility review” 写的是同一条 API。
- prompt 要求读 dsh 的 release notes、检查本适配器的用法、在可行时跑适配器，并把修复推到当前 PR 分支。其中一条是 “Never bump the ACP package version (this PR only upgrades the bundled dsh)”。也不要合并 PR。
- HTTP 状态不是 2xx，或响应里没有 `agent.id` 时，脚本打印错误并以状态 0 退出，PR 保持打开。成功时用 `gh pr comment` 留下 agent URL。
- #34 把 `${PREVIOUS_VERSION}`、`${DSH_VERSION}`、`${PR_HEAD_REF}` 的替换改成 jq 的哨兵替换。2026-10-02，`main` 的头是 `0d62a58`，主题 `fix: keep Cursor review prompt substitution literal (#34)`。

#32 是这样合进去的一篇：标题 `chore: upgrade bundled dsh to 0.2.0-rc.2`，正文含 “This PR does not bump or release the ACP package.”

### 发布

本仓库发版走 tag，文件是 `.github/workflows/release.yml`。文件头注释写明：在 `package.json` 里改版本，给该提交打 `vX.Y.Z`，推送 tag；测试通过后才发布；npm 认证是 OIDC trusted publishing，不使用 token。`AGENTS.md` 写的是同一条链路：版本提交，加上 `git tag vX.Y.Z`，推送 tag，由 GitHub Actions 用 OIDC 发到 npm。本地不使用 `npm publish`。

`AGENTS.md` 还写明：minor（`0.X.y`）由维护者决定；功能先进入 `main`，不按每个功能打 tag；有具体理由时才发 patch。

`main` 上最近一次发版提交是 `23a8fab`，主题 `release: v0.4.36`，diff 只有 `package.json` 和 `package-lock.json`。更早的主题还有 `chore: release 0.4.31`（`25bd365`）、`chore: release 0.4.30`（`946e4f5`）、`chore: release 0.4.29`（`2e68a2b`）。

`release.yml` 只在 tag `v*` 的 push 上跑。Job：

1. `verify-tag`（显示名 “verify tag is on main”）执行 `bash scripts/verify-release-tag.sh "$GITHUB_SHA" origin/main`。脚本用 `git merge-base --is-ancestor` 确认 tag 提交包含在 `origin/main` 里。
2. `test`、`compatibility-versions`、`package` 都 `needs: verify-tag`。`test` 的 OS × Node 矩阵与 `ci.yml` 相同，步骤是 `npm ci`、`npm run typecheck`、`npm test`。`package` 在 `ubuntu-latest`、Node 24 上 `npm pack`，上传 artifact `package-tgz`。
3. `dsh-compatibility` 与 `ci.yml` 使用同一份 `runtime/compatibility.json` 和 `scripts/profile-smoke.mjs`，Node 24，`needs: compatibility-versions`。
4. `standalone` `needs: package`，四个 OS × Node 22 和 24，超时 20 分钟，执行 `node scripts/standalone-smoke.mjs`。`test/ci-workflows.test.ts` 要求 `publish` 的 `needs` 包含 `standalone` 和 `dsh-compatibility`。
5. `publish` `needs: [test, dsh-compatibility, standalone]`。权限是 `id-token: write`（注释：npm OIDC trusted publishing）和 `contents: write`（注释：create the GitHub Release）。Node 24 的注释写明该版本自带 npm `>= 11.5.1`（能做 OIDC）。tag 名必须等于 `v` 加上 `package.json` 的 `version`，否则打印 `::error::tag <tag> != package.json <v版本>` 并失败。然后下载已测试的 tarball 并 `npm publish`。tag 匹配 `*-alpha.*`、`*-beta.*` 或 `*-rc.*` 时 dist-tag 为 `beta`，否则为 `latest`。最后 `gh release create "$GITHUB_REF_NAME" *.tgz --generate-notes --verify-tag`；tag 名含 `-` 时加上 `--prerelease`。仓库没有 `CHANGELOG.md`，Release 说明来自 `--generate-notes`。

已发生的 run，不是会自动更新的指针：

- tag `v0.4.36` 指向 `23a8fabe219f9982ab848e0dca59289cf70b1c53`。[Release run 36990439834](https://github.com/openma-ai/deepseek-harness-acp/actions/runs/36990439834) 在 2026-10-02 成功，其中 `publish` 成功。
- tag `v0.4.34` 的 [Release run 36557272543](https://github.com/openma-ai/deepseek-harness-acp/actions/runs/36557272543) 在 `publish` 失败，日志是 `npm error code ERR_STRING_TOO_LONG`。#31 的标题是 `Fix standalone runtime packaging for 0.4.35 release`。随后 tag `v0.4.35` 的 [Release run 36560346646](https://github.com/openma-ai/deepseek-harness-acp/actions/runs/36560346646) 成功。

上面「发布」里 `@openma/cli` / `@openma/sdk` 的 changesets 与 `version-pr` 是组织原文对 `open-managed-agents` 的描述。本仓库的发版步骤是这一节。

### 下游 Martty

本包发布之后，在 Martty（`openma-ai/Martty`）另开 PR，把 `npm/package.json` 的依赖 `@openma/deepseek-harness-acp` 改到刚发布的版本，并跑 Martty 自己的 CI。dsh 升级 PR 不升本包版本，见上一节引用的 workflow 正文和 `scripts/dispatch-cursor-review.sh`。

2026-10-02 在 Martty 仓库核对：

- `npm/package.json` 中 `"@openma/deepseek-harness-acp": "0.4.36"`。`AGENTS.md` 写明 TUI 的 npm 包 “deliberately carries `@openma/deepseek-harness-acp` as a runtime dependency”。
- `CHANGELOG.md` 的 `[Unreleased]` 写依赖 `@openma/deepseek-harness-acp` `0.4.36`。`[0.3.1] - 2026-09-30` 写升到 `0.4.31`，同节还有 bump 到 `0.4.29`。该文件没有出现 `0.4.35`。
- [#135](https://github.com/openma-ai/Martty/pull/135) 于 2026-09-29 合并，正文写把嵌入的 ACP adapter 更新到已发布的 `0.4.35`。[#137](https://github.com/openma-ai/Martty/pull/137) 于 2026-10-02 合并，标题 `Bump @openma/deepseek-harness-acp to 0.4.36`，正文写从 `0.4.35` 升到刚发布的 `0.4.36`（npm `latest`，tag [`v0.4.36`](https://github.com/openma-ai/deepseek-harness-acp/releases/tag/v0.4.36)）。

### 安全

根目录没有 `SECURITY.md`。2026-10-02 `GET /repos/openma-ai/deepseek-harness-acp/contents/SECURITY.md` 返回 404。同一天 `GET /repos/openma-ai/deepseek-harness-acp/private-vulnerability-reporting` 返回 `{"enabled":false}`。

上面「安全」里的 [`SECURITY.md`](https://github.com/openma-ai/open-managed-agents/blob/09bbbd37b9cf3b2c62c4aa5df1298b2ff4c6043f/SECURITY.md) 已从相对路径改成 `open-managed-agents` `09bbbd37` 上的文件。那份政策的 In scope 是 Open Managed Agents 的 runtime（`apps/agent`、`apps/main`、`apps/main-node`、`apps/integrations`、`apps/oma-vault`）、已发布的 `@openma/cli` 与 `@openma/sdk`，以及 `docs/self-host.md` 里的自部署路径。该清单没有写 `@openma/deepseek-harness-acp`。

不要为安全问题开公开 issue。本仓库没有另写的私下投递地址。

### Issue 与 PR 模板

`.github/pull_request_template.md` 与 `.github/ISSUE_TEMPLATE/bug_report.md` 从同一份 `09bbbd37` 复制。仓库里原先没有这两份文件，因此没有本地段落可合并。

Issue 模板里的运行方式列举包含 Cloudflare。本仓库 `README.md` 写的运行方式是 `dsh --profile acp`（profile 插件）和 `dsh-acp`（standalone）。可复现的缺陷用本仓库的 GitHub Issue（`package.json` 的 `bugs.url`：`https://github.com/openma-ai/deepseek-harness-acp/issues`）。
