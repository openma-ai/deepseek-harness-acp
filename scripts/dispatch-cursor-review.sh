#!/usr/bin/env bash
# Dispatch a Cursor cloud agent to review dsh compatibility on a PR
# Usage: dispatch-cursor-review.sh PR_NUMBER REPO_URL [DSH_VERSION] [PREVIOUS_VERSION]
# Set DRY_RUN=1 to print the payload without making API calls

set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: $0 PR_NUMBER REPO_URL [DSH_VERSION] [PREVIOUS_VERSION]" >&2
  exit 1
fi

PR_NUMBER="$1"
REPO_URL="$2"
DSH_VERSION="${3:-[new version]}"
PREVIOUS_VERSION="${4:-[previous version]}"

if [ -z "${CURSOR_API_KEY:-}" ]; then
  echo "::warning::CURSOR_API_KEY not set. Skipping automated compatibility review."
  exit 0
fi

# In dry run mode, allow stub values for gh CLI results
if [ "${DRY_RUN:-0}" = "1" ]; then
  PR_URL="${PR_URL:-https://github.com/example/repo/pull/$PR_NUMBER}"
  PR_HEAD_REF="${PR_HEAD_REF:-cursor/test-branch}"
else
  if [ -z "${GH_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ]; then
    echo "::error::GH_TOKEN or GITHUB_TOKEN required for gh CLI"
    exit 1
  fi
  
  # Get PR details
  PR_URL=$(gh pr view "$PR_NUMBER" --json url --jq .url)
  PR_HEAD_REF=$(gh pr view "$PR_NUMBER" --json headRefName --jq .headRefName)
fi

echo "Dispatching agent for PR #$PR_NUMBER ($PR_URL)"
echo "Branch: $PR_HEAD_REF"
echo "dsh version: $PREVIOUS_VERSION -> $DSH_VERSION"

# Export variables for envsubst
export PREVIOUS_VERSION DSH_VERSION PR_HEAD_REF

# Build the agent prompt with variable substitution
AGENT_PROMPT=$(envsubst <<PROMPT_EOF
Goal: Review ACP compatibility with the bundled dsh upgrade from ${PREVIOUS_VERSION} to ${DSH_VERSION} and push any necessary fixes directly to this PR branch.

## Tasks

1. **Read release context**: Fetch and read dsh release notes, changelogs, and API diffs between ${PREVIOUS_VERSION} and ${DSH_VERSION}. Focus on:
   - Breaking changes to session/agent APIs
   - Changes to model IDs, options, or parameters
   - Tool output format changes
   - Permission/sandbox modifications
   - Profile/plugin lifecycle changes

2. **Analyze ACP adapter usage**: Search this codebase for every dsh API this adapter uses:
   - Session create/load/resume lifecycle
   - Agent composition and model catalog
   - Tool calls and display terminals
   - Permission presets and sandboxing
   - MCP server mounting
   - Credential store access
   - Profile boot and Cordis tree composition

3. **Test the adapter**: Where feasible, exercise the ACP adapter over stdio:
   - Start \`dsh-acp\` (standalone or via profile)
   - Send basic ACP requests (initialize, session/new, simple prompts)
   - Verify tool calls, streaming, and session persistence work
   - Check that the adapter starts without errors

4. **Fix breakages**: If you find incompatibilities:
   - Update imports, API calls, or type signatures as needed
   - Add compatibility shims if the adapter must support multiple dsh versions
   - Update tests to cover the changes
   - Commit fixes with clear messages
   - Push directly to this PR branch (no force push, no new branches)

5. **Run tests**: Execute \`npm test\` to ensure the test suite passes. If tests fail due to your changes, fix them.

6. **Ensure CI runs**: After pushing fixes, verify CI is running. If the push didn't trigger CI (unlikely but possible), manually trigger it with \`gh workflow run ci.yml --ref ${PR_HEAD_REF}\`.

7. **Post a verdict**: Comment on this PR with your assessment:
   - **Safe to merge**: No compatibility issues found, or all issues fixed and tests pass
   - **Safe after fixes**: Issues found and fixed; human should verify the fixes before merging
   - **Not safe**: Breaking changes that require human design decisions
   
   Include in your comment:
   - Summary of API changes reviewed
   - Any fixes you made (with commit SHAs)
   - What a human should test in a real ACP client (Zed, Backchat, etc.)
   - Link to test results

## Guidelines

- Never bump the ACP package version (this PR only upgrades the bundled dsh)
- Never merge the PR or enable auto-merge
- Push commits normally; do not force push
- If you're uncertain about a fix, document the tradeoffs in the PR comment and mark as "Not safe"

Release notes for dsh ${DSH_VERSION} should be available at:
- GitHub: https://github.com/deepseek-ai/deepseek-harness/releases
- npm: https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions
PROMPT_EOF
)

# Build the API request payload with jq
API_PAYLOAD=$(jq -n \
  --arg prompt_text "$AGENT_PROMPT" \
  --arg repo_url "$REPO_URL" \
  --arg pr_url "$PR_URL" \
  --arg name "Review dsh $DSH_VERSION compatibility" \
  '{
    prompt: {
      text: $prompt_text
    },
    repos: [
      {
        url: $repo_url,
        prUrl: $pr_url
      }
    ],
    workOnCurrentBranch: true,
    autoCreatePR: false,
    name: $name
  }')

# Dry run mode: print payload and exit
if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "=== DRY RUN MODE ==="
  echo "Would POST to: https://api.cursor.com/v1/agents"
  echo ""
  echo "=== API Payload ==="
  echo "$API_PAYLOAD" | jq .
  echo ""
  echo "=== Prompt Preview (first 20 lines) ==="
  echo "$AGENT_PROMPT" | head -20
  echo ""
  echo "Would post PR comment on #$PR_NUMBER"
  exit 0
fi

# Make the API request with separate status and body capture
HTTP_RESPONSE=$(mktemp)
HTTP_STATUS=$(curl -s -w '%{http_code}' -o "$HTTP_RESPONSE" \
  --request POST \
  --url https://api.cursor.com/v1/agents \
  --user "${CURSOR_API_KEY}:" \
  --header 'Content-Type: application/json' \
  --data "$API_PAYLOAD")

# Check HTTP status
if [ "$HTTP_STATUS" -lt 200 ] || [ "$HTTP_STATUS" -ge 300 ]; then
  echo "::error::Failed to launch Cursor cloud agent (HTTP $HTTP_STATUS)"
  echo "API Response:"
  cat "$HTTP_RESPONSE"
  rm -f "$HTTP_RESPONSE"
  echo ""
  echo "The PR is still open; manual review is required."
  exit 0
fi

# Parse response
AGENT_ID=$(jq -r '.agent.id // empty' "$HTTP_RESPONSE")
AGENT_URL=$(jq -r '.agent.url // empty' "$HTTP_RESPONSE")

if [ -z "$AGENT_ID" ]; then
  echo "::error::API response missing agent.id field"
  echo "API Response:"
  cat "$HTTP_RESPONSE"
  rm -f "$HTTP_RESPONSE"
  exit 0
fi

if [ -z "$AGENT_URL" ]; then
  # URL might not be in response; construct it from ID
  AGENT_URL="https://cursor.com/agents/$AGENT_ID"
fi

rm -f "$HTTP_RESPONSE"

echo "Successfully launched Cursor cloud agent:"
echo "  ID: $AGENT_ID"
echo "  URL: $AGENT_URL"

# Post a comment on the PR
gh pr comment "$PR_NUMBER" --body "🤖 **Automated compatibility review launched**

A Cursor cloud agent is reviewing ACP compatibility with dsh $DSH_VERSION.

**Agent:** $AGENT_URL

The agent will:
- Review dsh release notes and API changes
- Test the ACP adapter with the new dsh version
- Push fixes directly to this branch if needed
- Post a verdict comment when complete

You can monitor progress at the agent link above."

echo "Posted comment on PR #$PR_NUMBER"
