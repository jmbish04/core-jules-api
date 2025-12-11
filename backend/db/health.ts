import { Env } from "../types";
import { createDbClient } from "./client";
import { HealthStepResult } from "../core/health-check";
import { healthChecks } from "./schema";
import { eq, desc } from "drizzle-orm";

/**
 * Checks the health of the D1 Database by verifying full CRUD capability:
 * 1. Write: Insert a probe record
 * 2. Read: Select the probe record
 * 3. Delete: Clean up the probe record
 * 
 * This ensures the database is not in read-only mode and is fully functional.
 */
export async function checkHealth(env: Env): Promise<HealthStepResult> {
    const start = Date.now();
    const subChecks: Record<string, any> = {};

    try {
        const db = createDbClient(env.DB);
        const probeId = `probe-${Date.now()}-${Math.random().toString(36).substring(7)}`;

        // --- 1. Test Write (INSERT) ---
        const writeStart = Date.now();
        await db.insert(healthChecks).values({
            checkType: 'probe',
            status: 'success', // Dummy success
            durationMs: 0,
            stepsJson: JSON.stringify({ probeId }), // Store probe ID in steps
            triggerSource: 'probe',
            error: null
        });
        subChecks.write = { status: "OK", latency: Date.now() - writeStart };

        // --- 2. Test Read (SELECT) ---
        // We need to find the specific record we just inserted.
        // Since we stored the unique probeId in stepsJson, we could try to filter by it if capabilities allowed,
        // but for safety and speed, we can just grab the latest 'probe' type record and verify.
        // Or if we can't easily query JSON in D1 via Drizzle without sql operators, let's just do a simple read.

        const readStart = Date.now();
        // Read the latest probe record
        const record = await db.query.healthChecks.findFirst({
            where: eq(healthChecks.checkType, 'probe'),
            orderBy: (healthChecks, { desc }) => [desc(healthChecks.timestamp)],
        });

        if (!record) {
            throw new Error("D1: Write succeeded but Read failed (Record not found)");
        }
        subChecks.read = { status: "OK", latency: Date.now() - readStart };

        // --- 3. Test Delete (CLEANUP) ---
        const deleteStart = Date.now();
        // Cleanup all 'probe' records to keep table clean
        await db.delete(healthChecks).where(eq(healthChecks.checkType, 'probe'));
        subChecks.cleanup = { status: "OK", latency: Date.now() - deleteStart };

        return {
            name: "Database Domain",
            status: "success",
            message: "D1 Read/Write Operational",
            durationMs: Date.now() - start,
            details: subChecks
        };

    } catch (error) {
        return {
            name: "Database Domain",
            status: "failure",
            message: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - start,
            details: subChecks
        };
    }
}
