import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { Env } from '../types';
import { generateText } from '../ai/providers/worker-ai';
import * as github from '../mcp/tools/git/github';

type GovernanceParams = {
    repoUrl: string;
};

export class GovernanceWorkflow extends WorkflowEntrypoint<Env, GovernanceParams> {
    async run(event: WorkflowEvent<GovernanceParams>, step: WorkflowStep) {
        const { repoUrl } = event.payload;
        const ai = this.env.AI;
        const token = this.env.GITHUB_TOKEN;

        // Extract Owner/Repo
        const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
        if (!match) throw new Error("Invalid GitHub URL");
        const owner = match[1];
        const repo = match[2];

        try {
            // Step 1: Audit Config
            const configFiles = await step.do('audit-config', async () => {
                const [wrangler, pkg, entry] = await Promise.all([
                    github.fetchGitHubFile(this.env, owner, repo, 'wrangler.jsonc').catch(() => github.fetchGitHubFile(this.env, owner, repo, 'wrangler.toml')),
                    github.fetchGitHubFile(this.env, owner, repo, 'package.json'),
                    github.fetchGitHubFile(this.env, owner, repo, 'src/index.ts')
                ]);
                return { wrangler, pkg, entry };
            });

            // Step 2: Synthesize Docs
            const newDocs = await step.do('synthesize-docs', async () => {
                const prompt = `
                    You are a Technical Writer.
                    
                    Context:
                    We have a Cloudflare Worker project.
                    AGENTS.md is the source of truth for bindings and architecture.
                    
                    Wrangler Config:
                    ${configFiles.wrangler}
                    
                    Package.json:
                    ${configFiles.pkg}
                    
                    Src/index.ts:
                    ${configFiles.entry.slice(0, 2000)}... (truncated)
                    
                    Task:
                    Generate a comprehensive AGENTS.md content.
                    - List all bindings (KV, D1, AI, Queue, etc).
                    - List key dependencies.
                    - Describe the entrypoint logic briefly.
                    - Use Markdown format.
                `;

                return await generateText(ai, prompt);
            });

            // Step 3: Check Drift & Commit
            const result = await step.do('commit-if-needed', async () => {
                const defaultBranch = await github.getDefaultBranch(this.env, owner, repo);
                let currentDocs = "";
                try {
                    currentDocs = await github.fetchGitHubFile(this.env, owner, repo, 'AGENTS.md');
                } catch (e) { }

                // Simple check: if length differs significantly or AI says so. 
                // For now, let's always open a PR for the user to review.

                const baseSha = await github.getRef(this.env, owner, repo, `heads/${defaultBranch}`);
                const branchName = `chore/update-agents-md-${Date.now()}`;

                await github.createBranch(this.env, owner, repo, branchName, baseSha);

                let fileSha: string | undefined;
                if (currentDocs) {
                    // Fetch actual SHA 
                    const url = `https://api.github.com/repos/${owner}/${repo}/contents/AGENTS.md?ref=${branchName}`;
                    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "User-Agent": "Cloudflare-Worker-MCP" } });
                    if (res.ok) {
                        const meta = await res.json() as any;
                        fileSha = meta.sha;
                    }
                }

                await github.createOrUpdateFile(
                    this.env,
                    owner,
                    repo,
                    'AGENTS.md',
                    newDocs,
                    'chore: update AGENTS.md to match configuration',
                    branchName,
                    fileSha
                );

                const pr = await github.createPullRequest(
                    this.env,
                    owner,
                    repo,
                    'chore: Update AGENTS.md',
                    'Automated documentation update based on configuration audit.',
                    branchName,
                    defaultBranch
                );

                return pr.html_url;
            });

            return { success: true, prUrl: result };

        } catch (e) {
            console.error(e);
            return { success: false, error: String(e) };
        }
    }
}
