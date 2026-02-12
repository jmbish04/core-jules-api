/**
 * @file src/flows/workflowTemplates.ts
 * @description GitHub Actions workflow templates for automated repository setup
 * @owner AI-Builder
 */

/**
 * GitHub Action workflow for extracting and summarizing PR comments
 * This helps AI bots fix all comments in one pass
 */
export const PR_COMMENT_EXTRACTOR_WORKFLOW = `name: Extract and Summarize PR Comments

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

permissions:
  pull-requests: write
  issues: read
  contents: read

concurrency:
  group: pr-comment-\${{ github.event.issue.number || github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  summarize-comments:
    if: >
      github.event.comment.user.login != 'jmbish04' &&
      github.event.issue.pull_request != null
    runs-on: ubuntu-latest

    steps:
      - name: Wait 30 seconds to batch comments
        run: sleep 30

      - name: Checkout
        uses: actions/checkout@v4

      - name: Install jq and gh
        run: sudo apt-get update && sudo apt-get install -y jq gh

      - name: Extract and sanitize PR comments
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          REPO: \${{ github.repository }}
          PR_NUMBER: \${{ github.event.issue.number || github.event.pull_request.number }}
        run: |
          echo "# Extracting comments for PR #$PR_NUMBER"

          # Fetch PR discussion comments (excluding you)
          gh api -H "Accept: application/vnd.github.v3+json" \\
            "/repos/$REPO/issues/$PR_NUMBER/comments" --paginate |
          jq -r '
            .[]
            | select(.user.login != "jmbish04")
            | .body
          ' > all_comments_raw.txt

          # Fetch inline code review comments
          gh api -H "Accept: application/vnd.github.v3+json" \\
            "/repos/$REPO/pulls/$PR_NUMBER/comments" --paginate |
          jq -r '
            .[]
            | select(.user.login != "jmbish04")
            | "### File: \\(.path)\\nLine: \\(.line // "N/A")\\n\\n" + (.body // "")
          ' >> all_comments_raw.txt

          # Clean text: remove badges, slash commands, bot names, etc.
          sed -E -i \\
            -e 's|!\\[[^]]*\\]\\([^)]*\\)||g' \\
            -e 's|@[A-Za-z0-9._-]+\\[bot\\]||g' \\
            -e 's|/gemini[^\\n]*||gi' \\
            -e 's|/colby[^\\n]*||gi' \\
            -e 's|@jules||gi' \\
            -e '/^$/N;/^\\n$/D' \\
            all_comments_raw.txt

          # Add a header
          {
            echo "# 🧠 Cleaned PR Feedback Summary"
            echo ""
            cat all_comments_raw.txt
          } > cleaned_comments.md

          echo "---- Cleaned Comments Preview ----"
          head -n 40 cleaned_comments.md || true

      - name: Post cleaned summary as PR comment
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          REPO: \${{ github.repository }}
          PR_NUMBER: \${{ github.event.issue.number || github.event.pull_request.number }}
        run: |
          gh pr comment "$PR_NUMBER" --repo "$REPO" --body-file cleaned_comments.md
`

/**
 * GitHub Action workflow for deploying Cloudflare Workers
 * Only runs if wrangler.toml or wrangler.jsonc exists
 */
export const CLOUDFLARE_DEPLOY_WORKFLOW = `
name: Deploy Worker
on:
  push:
    branches:
      - main
jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
      
      - name: Build & Deploy Worker
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
`

/**
 * GitHub Action workflow for auto-applying Gemini code suggestions
 * Automatically applies code suggestions from gemini-code-assist bot
 */
export const AUTO_APPLY_GEMINI_WORKFLOW = `
name: Auto-Apply Gemini Suggestions
on:
  pull_request_review_comment:
    types: [created]

permissions:
  contents: write
  pull-requests: write

jobs:
  auto-apply:
    if: github.event.comment.user.login == 'gemini-code-assist[bot]'
    runs-on: ubuntu-latest

    steps:
      - name: Wait 10 seconds to batch Gemini comments
        run: sleep 10

      - name: Checkout PR branch
        uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.ref }}
          repository: \${{ github.repository }}
          token: \${{ secrets.GITHUB_TOKEN }}

      - name: Fetch and process comment
        id: process
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          COMMENT_ID: \${{ github.event.comment.id }}
          REPO: \${{ github.repository }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
        run: |
          echo "🔍 Checking comment $COMMENT_ID from Gemini..."
          BODY=$(gh api /repos/$REPO/pulls/comments/$COMMENT_ID --jq '.body')
          FILE=$(gh api /repos/$REPO/pulls/comments/$COMMENT_ID --jq '.path')
          LINE=$(gh api /repos/$REPO/pulls/comments/$COMMENT_ID --jq '.line')

          echo "📄 File: $FILE (line $LINE)"
          echo "$BODY" | awk '/\\\`\\\`\\\`suggestion/,/\\\`\\\`\\\`/' | sed '/\\\`\\\`\\\`/d' > suggestion.patch

          if [ ! -s suggestion.patch ]; then
            echo "no_suggestion=true" >> $GITHUB_OUTPUT
            exit 0
          fi

          echo "no_suggestion=false" >> $GITHUB_OUTPUT
          echo "✅ Suggestion found:"
          cat suggestion.patch

          # Dry-run apply
          echo "🧪 Dry-run applying suggestion..."
          git apply --check suggestion.patch && echo "patch_valid=true" >> $GITHUB_OUTPUT || echo "patch_valid=false" >> $GITHUB_OUTPUT

      - name: Comment result on PR
        if: always()
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          REPO: \${{ github.repository }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
          COMMENT_ID: \${{ github.event.comment.id }}
          NO_SUGGESTION: \${{ steps.process.outputs.no_suggestion }}
          PATCH_VALID: \${{ steps.process.outputs.patch_valid }}
        run: |
          if [ "$NO_SUGGESTION" = "true" ]; then
            gh pr comment "$PR_NUMBER" --repo "$REPO" --body "✅ Action ran successfully but no \\\`\\\`\\\`suggestion\\\`\\\`\\\` code blocks were detected in Gemini's comment."
            exit 0
          fi

          if [ "$PATCH_VALID" = "false" ]; then
            gh pr comment "$PR_NUMBER" --repo "$REPO" --body "⚠️ Gemini suggestion found but could not apply cleanly. Please review the patch manually from comment $COMMENT_ID."
            exit 0
          fi

          # Apply, commit, and push the patch
          echo "🚀 Applying patch..."
          git apply suggestion.patch
          git add .
          git config user.name "auto-gemini-applier"
          git config user.email "bot@users.noreply.github.com"
          git commit -m "chore: apply Gemini suggestion from comment $COMMENT_ID"
          git push origin HEAD

          # Post confirmation with guidance
          cat <<EOF | gh pr comment "$PR_NUMBER" --repo "$REPO" --body-file -
          ✅ **Gemini suggestion applied automatically!**

          Applied suggestion from comment $COMMENT_ID and pushed to this PR.

          **Next Steps:**
          - Review the auto-applied changes
          - If the suggestion was incorrect, you can revert this commit
          - To disable auto-apply for future suggestions, add \\\`[skip-auto-apply]\\\` to your PR description

          ---
          _Automated by auto-gemini-applier workflow_
          EOF
`

/**
 * Workflow file definitions with their paths
 */
export interface WorkflowTemplate {
  path: string
  content: string
  description: string
}

export const DEFAULT_WORKFLOWS: WorkflowTemplate[] = [
  {
    path: '.github/workflows/pr-comment-extractor.yml',
    content: PR_COMMENT_EXTRACTOR_WORKFLOW,
    description: 'Extracts and summarizes PR comments for AI bot consumption'
  },
  {
    path: '.github/workflows/deploy-worker.yml',
    content: CLOUDFLARE_DEPLOY_WORKFLOW,
    description: 'Deploys Cloudflare Worker on push to main branch'
  },
  {
    path: '.github/workflows/auto-apply-gemini.yml',
    content: AUTO_APPLY_GEMINI_WORKFLOW,
    description: 'Automatically applies code suggestions from Gemini bot'
  }
]

/**
 * Checks if a repository likely needs the Cloudflare deploy workflow
 * by checking for wrangler configuration files
 */
export function shouldIncludeCloudflareWorkflow(files: string[]): boolean {
  return files.some(file => 
    file === 'wrangler.toml' || 
    file === 'wrangler.jsonc' ||
    file === 'wrangler.json'
  )
}
