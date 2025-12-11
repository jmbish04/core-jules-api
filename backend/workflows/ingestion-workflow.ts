import {
    WorkflowEntrypoint,
    WorkflowEvent,
    WorkflowStep,
} from "cloudflare:workers";
import { Env } from "../types";
import { BrowserTool } from "../mcp/tools/browser";
import { sanitizeAndFormatResponse } from "../ai/utils/sanitizer";
import { VectorizeService } from "../data/vectorize_service";
import { createDbClient } from "../db/client";
import { knowledgeBase } from "../db/schema";
import { sql } from "drizzle-orm";

interface IngestionParams {
    url: string;
    tags?: string[];
    forceUpdate?: boolean;
}

export class IngestionWorkflow extends WorkflowEntrypoint<Env, IngestionParams> {
    async run(event: WorkflowEvent<IngestionParams>, step: WorkflowStep) {
        const { url, tags = [] } = event.payload;

        // Step 1: Scrape
        const rawContent = await step.do("scrape-content", async () => {
            // Browser binding check logic usually inside BrowserTool, 
            // but we wrap here to be explicit about step failure
            const browser = new BrowserTool(this.env);
            const content = await browser.scrape(url);
            if (!content || content.length < 50) {
                throw new Error(`Scraped content too short or empty for ${url}`);
            }
            return content;
        });

        // Step 2: Clean
        const cleanedContent = await step.do("clean-content", async () => {
            // We use the sanitizer to get clean HTML/Text. 
            // Note: sanitizeAndFormatResponse is optimized for frontend display (HTML), 
            // but it cleans XSS and basic junk. ideally we'd want pure execution text, 
            // but this is a good baseline.
            // For purely RAG, we might strip tags later or rely on the embedder to handle it.
            // Let's stick to the sanitizer for safety.
            return sanitizeAndFormatResponse(rawContent);
        });

        // Step 3: Chunk (Simple Semantic)
        const chunks = await step.do("chunk-content", async () => {
            // Simple splitting by double newline or headers
            // Max 1000 chars roughly to avoid token limits
            const paragraphs = cleanedContent.split(/\n\s*\n/);
            const mergedChunks: string[] = [];
            let currentChunk = "";

            for (const p of paragraphs) {
                if ((currentChunk.length + p.length) > 1000) {
                    mergedChunks.push(currentChunk.trim());
                    currentChunk = "";
                }
                currentChunk += p + "\n\n";
            }
            if (currentChunk.trim().length > 0) {
                mergedChunks.push(currentChunk.trim());
            }
            return mergedChunks;
        });

        // Step 4: Save & Embed
        await step.do("save-and-embed", async () => {
            const db = createDbClient(this.env.DB);

            // Save to D1 (Upsert logic via Conflict)
            const result = await db.insert(knowledgeBase).values({
                url,
                content: cleanedContent,
                title: `Ingested: ${url}`, // Basic title, could be improved with metadata
                tags: JSON.stringify(tags),
                updatedAt: new Date().toISOString()
            }).onConflictDoUpdate({
                target: knowledgeBase.url,
                set: {
                    content: cleanedContent,
                    updatedAt: new Date().toISOString(),
                    tags: JSON.stringify(tags)
                }
            }).returning({ id: knowledgeBase.id });

            const docId = String(result[0].id);
            const vectorService = new VectorizeService(this.env);

            // Generate embeddings for chunks and upsert
            // We use a simple strategy: embedding each chunk and storing in Vectorize 
            // with metadata pointing back to the D1 record ID and URL.
            const vectors = [];
            for (const [index, chunk] of chunks.entries()) {
                // ID Format: docId_chunkIndex
                const vectorId = `${docId}_${index}`;
                const embedding = await vectorService.generateEmbedding(chunk);

                vectors.push({
                    id: vectorId,
                    values: embedding,
                    metadata: {
                        docId,
                        url,
                        chunkIndex: index,
                        text: chunk.substring(0, 1000) // Vectorize metadata limit is low (~10KB), be careful
                    }
                });
            }

            // Batch upsert (Vectorize limit is 1000 usually)
            if (vectors.length > 0) {
                await this.env.VECTORIZE_INDEX.upsert(vectors);
            }

            return { success: true, chunks: chunks.length };
        });

        return { status: "complete", url };
    }
}
