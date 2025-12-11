import { Env } from "../types";
import { HealthStepResult } from "../core/health-check";

/**
 * Checks the health of Workflows
 */
export async function checkHealth(env: Env): Promise<HealthStepResult> {
    const start = Date.now();
    const subChecks: Record<string, any> = {};

    try {
        const workflows = [
            { key: 'RESEARCH_WORKFLOW', name: 'Research' },
            { key: 'ENGINEER_WORKFLOW', name: 'Engineer' },
            { key: 'GOVERNANCE_WORKFLOW', name: 'Governance' },
            { key: 'INGESTION_WORKFLOW', name: 'Ingestion' },
            { key: 'MAINTENANCE_WORKFLOW', name: 'Maintenance' },
        ];

        for (const wf of workflows) {
            // @ts-ignore - dynamic access to Env
            const binding = env[wf.key];
            if (binding) {
                // For a simplistic check, existence is good enough for bindings.
                // We can't easily "run" a workflow without side effects.
                subChecks[wf.name] = "OK";
            } else {
                subChecks[wf.name] = { status: "WARNING", message: "Binding missing" };
            }
        }

        return {
            name: "Workflows",
            status: "success",
            message: "Workflow bindings operational",
            durationMs: Date.now() - start,
            details: subChecks
        };
    } catch (error) {
        return {
            name: "Workflows",
            status: "failure",
            message: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - start,
            details: subChecks
        };
    }
}
