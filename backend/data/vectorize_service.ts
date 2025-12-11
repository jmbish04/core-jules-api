import { Env } from '../types';
import { generateEmbedding } from '../ai/providers/worker-ai';

export interface VectorQueryOptions {
    topK?: number;
    minScore?: number;
}

export class VectorizeService {
    constructor(
        private readonly env: Env
    ) { }

    async generateEmbedding(text: string): Promise<number[]> {
        return generateEmbedding(this.env, text);
    }

    async query(text: string, options: VectorQueryOptions = {}) {
        const vector = await this.generateEmbedding(text);
        return this.env.VECTORIZE_INDEX.query(vector, {
            topK: options.topK ?? 5,
            returnMetadata: "all",
        });
    }

    async upsert(id: string, text: string, metadata: Record<string, any>) {
        const values = await this.generateEmbedding(text);
        await this.env.VECTORIZE_INDEX.upsert([{ id, values, metadata }]);
    }

    async searchHybrid(query: string, options: VectorQueryOptions = {}) {
        // Parallel: Vector Search + Keyword Search (D1)
        const vectorPromise = this.query(query, options);

        // Keyword Search: Simple LIKE query on knowledge_base table
        // We need to inject DB client here or pass it in. Ideally VectorizeService depends on Env so it has DB access.
        // Let's assume Env has DB.
        const dbPromise = (async () => {
            // Basic keyword matching
            const { createDbClient } = await import("../db/client");
            const { knowledgeBase } = await import("../db/schema");
            const { ilike, or } = await import("drizzle-orm");

            const db = createDbClient(this.env.DB);
            // Search title or content
            const keywordResults = await db.select({
                id: knowledgeBase.id,
                content: knowledgeBase.content,
                title: knowledgeBase.title,
                url: knowledgeBase.url
            })
                .from(knowledgeBase)
                .where(or(
                    ilike(knowledgeBase.content, `%${query}%`),
                    ilike(knowledgeBase.title, `%${query}%`)
                ))
                .limit(5) // Limit keyword results
                .all();

            return keywordResults;
        })();

        const [vectorResults, keywordResults] = await Promise.all([vectorPromise, dbPromise]);

        // Merge Strategy:
        // 1. Convert everything to a common format
        // 2. Deduplicate by URL (if possible) or Content
        // 3. Prioritize Vector results but include keyword matches if they aren't in vector results

        const combined = [];
        const seenUrls = new Set<string>();

        // Process Vector Results
        for (const match of vectorResults.matches) {
            combined.push({
                source: 'vector',
                score: match.score,
                text: match.metadata?.text || '',
                url: match.metadata?.url || '',
                ...match.metadata
            });
            if (match.metadata?.url) seenUrls.add(String(match.metadata.url));
        }

        // Process Keyword Results
        for (const match of keywordResults) {
            if (!seenUrls.has(match.url)) {
                combined.push({
                    source: 'keyword',
                    score: 1.0, // Artificial high score for exact keyword match? Or treat separate.
                    text: match.content.substring(0, 1000), // Truncate for display
                    url: match.url,
                    title: match.title
                });
                seenUrls.add(match.url);
            }
        }

        return combined;
    }
}
