import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { Env } from '../types';
import { queryMCP } from '../mcp/mcp-client';
import { VectorizeService } from '../data/vectorize_service';
import { generateStructured } from '../ai/providers/worker-ai';


type ResearchParams = {
    sessionId: string;
    query: string;
    mode: 'feasibility' | 'enrichment' | 'error_fix';
};

export class ResearchWorkflow extends WorkflowEntrypoint<Env, ResearchParams> {
    async run(event: WorkflowEvent<ResearchParams>, step: WorkflowStep) {
        const { sessionId, query, mode } = event.payload;
        const ai = this.env.AI;
        const kv = this.env.QUESTIONS_KV;

        // Helper to update status for the Frontend Visualizer
        const updateStatus = async (status: string, details?: string, data?: any) => {
            // We use step.do here to ensure status updates are durable
            await step.do(`update-status-${status}-${Date.now()}`, async () => {
                await kv.put(`research:${sessionId}`, JSON.stringify({
                    status,
                    details,
                    data,
                    timestamp: new Date().toISOString()
                }));
            });
        };

        await updateStatus('started', 'Initializing research parameters');

        // Step 1: Brainstorm
        await updateStatus('brainstorming', 'Generating targeted research questions');
        const subQueries = await step.do('brainstorm', async () => {
            const prompt = `Given the user query "${query}" and research mode "${mode}", generate 3 specific, targeted questions to ask the Cloudflare documentation.`;
            const schema = {
                type: "object",
                properties: {
                    questions: { type: "array", items: { type: "string" } }
                },
                required: ["questions"],
                additionalProperties: false
            };

            try {
                const result = await generateStructured<{ questions: string[] }>(
                    ai,
                    prompt,
                    schema,
                    { structuringInstruction: "Generate exactly 3 specific questions related to the user query." }
                );
                return result.questions;
            } catch (e) {
                console.error("Brainstorming failed:", e);
                return [query];
            }
        });

        // Step 2: Search Hybrid (Vector + Keyword)
        await updateStatus('searching_hybrid', `Searching Docs & Vector DB for ${query}`);
        const matches = await step.do("hybrid-search", async () => {
            const vectorService = new VectorizeService(this.env);
            return await vectorService.searchHybrid(query, { topK: 10 });
        });

        // Step 3: Synthesis (Structured Output)
        await updateStatus('synthesizing', 'Compiling report and code samples');
        const finalOutput = await step.do('synthesize', async () => {
            const context = JSON.stringify(matches);
            const prompt = `You are a Cloudflare Expert. Analyze the data and produce a response for: "${query}". Research Data: ${context}.`;

            const schema = {
                type: "object",
                properties: {
                    report: { type: "string", description: "Markdown analysis report" },
                    files: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                name: { type: "string" },
                                language: { type: "string" },
                                code: { type: "string" }
                            },
                            required: ["name", "language", "code"]
                        }
                    }
                },
                required: ["report", "files"],
                additionalProperties: false
            };

            try {
                return await generateStructured<{ report: string; files: any[] }>(
                    ai,
                    prompt,
                    schema,
                    { structuringInstruction: "Produce a detailed report and valid code files if applicable." }
                );
            } catch (e) {
                console.error("Synthesis failed:", e);
                return {
                    report: "Analysis failed due to model error.",
                    files: []
                };
            }
        });

        // Step 4: Save & Complete
        await step.do('save', async () => {
            await kv.put(`research:${sessionId}`, JSON.stringify({
                status: 'completed',
                report: finalOutput.report,
                files: finalOutput.files, // This feeds the CodebaseViewer
                timestamp: new Date().toISOString()
            }));
        });

        return finalOutput;
    }
}
