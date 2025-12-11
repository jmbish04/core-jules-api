import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { Env } from '../types';
import { generateStructured } from '../ai/providers/worker-ai';
import * as github from '../mcp/tools/git/github';

type EngineerParams = {
    sessionId: string;
    repoUrl: string; // e.g., https://github.com/owner/repo
    filePath: string;
    currentCode?: string; // If not provided, will fetch
    instruction: string; // What to fix
};

type EngineerResult = {
    success: boolean;
    prUrl?: string;
    error?: string;
};

export class EngineerWorkflow extends WorkflowEntrypoint<Env, EngineerParams> {
    async run(event: WorkflowEvent<EngineerParams>, step: WorkflowStep) {
        const { sessionId, repoUrl, filePath, instruction } = event.payload;
        let { currentCode } = event.payload;
        const ai = this.env.AI;
        const kv = this.env.QUESTIONS_KV; // Reusing KV for status updates if needed

        // Extract Owner/Repo
        const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
        if (!match) throw new Error("Invalid GitHub URL");
        const owner = match[1];
        const repo = match[2];
        const token = this.env.GITHUB_TOKEN;

        const updateStatus = async (status: string, message: string) => {
            await step.do(`status-${status}-${Date.now()}`, async () => {
                // We can re-use the research status key or a new key
                // For now, let's just log. In a real app we'd emit an event.
                console.log(`[Engineer] ${status}: ${message}`);
            });
        };

        try {
            // Step 1: Init Workspace
            await updateStatus('init', 'Validating workspace');
            const defaultBranch = await step.do('get-default-branch', async () => {
                return await github.getDefaultBranch(this.env, owner, repo);
            });

            // If currentCode missing, fetch it
            if (!currentCode) {
                await updateStatus('fetch', `Fetching ${filePath}`);
                currentCode = await step.do('fetch-file', async () => {
                    try {
                        return await github.fetchGitHubFile(this.env, owner, repo, filePath);
                    } catch (e) {
                        // File might not exist (new file creation)
                        return "";
                    }
                });
            }

            // Step 2: Plan Changes (AI)
            await updateStatus('planning', 'Generating code fix');
            const plan = await step.do('plan-changes', async () => {
                const prompt = `
                    You are a Senior Software Engineer.
                    Task: Implement the requested change to the file.
                    
                    File: ${filePath}
                    Instruction: ${instruction}
                    
                    Current Code:
                    ${currentCode || "(New File)"}
                    
                    Output the FULL new content of the file. Do not use diffs.
                `;

                const schema = {
                    type: "object",
                    properties: {
                        newContent: { type: "string", description: "The complete new source code for the file" },
                        prTitle: { type: "string" },
                        prBody: { type: "string", description: "Detailed description of changes for the PR" }
                    },
                    required: ["newContent", "prTitle", "prBody"]
                };

                return await generateStructured<{ newContent: string; prTitle: string; prBody: string }>(
                    ai,
                    prompt,
                    schema
                );
            });

            // Step 3: Execute Git Ops
            await updateStatus('executing', 'Pushing changes to GitHub');
            const prUrl = await step.do('git-ops', async () => {
                const baseSha = await github.getRef(this.env, owner, repo, `heads/${defaultBranch}`);

                // Unique branch name
                const branchName = `fix/ai-${sessionId}-${Date.now().toString().slice(-4)}`;

                // Create Branch
                await github.createBranch(this.env, owner, repo, branchName, baseSha);

                // Check if file exists to get SHA for update (if not new)
                let fileSha: string | undefined;
                if (currentCode) {
                    try {
                        // We need the metadata to get the sha, fetchGitHubFile only returns content string
                        // So we use getRepoStructure for a single file check or just capture it differently
                        // Actually active engineering usually implies we might need the SHA.
                        // Let's do a quick metadata fetch.
                        // Optimization: github.ts doesn't expose a specific getSha tool yet.
                        // Let's reuse fetch but raw? Or just fail if no sha?
                        // createOrUpdateFile needs sha if updating.

                        // Re-fetching strictly for SHA to be safe
                        const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branchName}`;
                        const res = await fetch(url, {
                            headers: {
                                Authorization: `Bearer ${token}`,
                                "User-Agent": "Cloudflare-Worker-MCP"
                            }
                        });
                        if (res.ok) {
                            const meta = await res.json() as any;
                            fileSha = meta.sha;
                        }
                    } catch (e) { /* ignore, assume new */ }
                }

                // Commit File
                await github.createOrUpdateFile(
                    this.env,
                    owner,
                    repo,
                    filePath,
                    plan.newContent,
                    `feat: ${plan.prTitle}`,
                    branchName,
                    fileSha
                );

                // Open PR
                const pr = await github.createPullRequest(
                    this.env,
                    owner,
                    repo,
                    plan.prTitle,
                    plan.prBody + `\n\n*Generated by Cloudflare Worker MCP*`,
                    branchName,
                    defaultBranch
                );

                return pr.html_url;
            });

            await updateStatus('complete', `PR Created: ${prUrl}`);

            return {
                success: true,
                prUrl
            };

        } catch (error) {
            console.error("Engineer Workflow Failed:", error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }
}
