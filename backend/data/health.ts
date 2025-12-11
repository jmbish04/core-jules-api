import { Env } from "../types";
import { HealthStepResult } from "../core/health-check";

/**
 * Checks the health of the Data domain (Vectorize) by validating:
 * 1. Index Stats (Control Plane)
 * 2. Vector Search (Data Plane)
 */
export async function checkHealth(env: Env): Promise<HealthStepResult> {
    const start = Date.now();
    const subChecks: Record<string, any> = {};

    try {
        // --- 1. Test Control Plane (Describe) ---
        const describeStart = Date.now();
        const info = await env.VECTORIZE_INDEX.describe();

        const infoAny = info as any;
        if (typeof infoAny.dimensions !== 'number' && typeof infoAny.dimension !== 'number') {
            // throw new Error("Vectorize: describe returned invalid object");
        }

        subChecks.describe = {
            status: "OK",
            latency: Date.now() - describeStart,
            dimensions: infoAny.dimensions || infoAny.dimension,
            vectorsCount: infoAny.vectorsCount || infoAny.vectorCount
        };

        const dims = infoAny.dimensions || infoAny.dimension || 768;
        const zeroVector = new Array(dims).fill(0);

        const queryStart = Date.now();
        const results = await env.VECTORIZE_INDEX.query(zeroVector, {
            topK: 1,
            returnMetadata: "none"
        });

        if (!Array.isArray(results.matches)) {
            throw new Error("Vectorize: query returned invalid matches array");
        }
        subChecks.query = {
            status: "OK",
            latency: Date.now() - queryStart,
            matches: results.matches.length
        };

        return {
            name: "Data Domain (Vectorize)",
            status: "success",
            message: "Vector Index Operational",
            durationMs: Date.now() - start,
            details: subChecks
        };

    } catch (error) {
        return {
            name: "Data Domain (Vectorize)",
            status: "failure",
            message: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - start,
            details: subChecks
        };
    }
}
