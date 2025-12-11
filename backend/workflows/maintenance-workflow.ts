import {
    WorkflowEntrypoint,
    WorkflowEvent,
    WorkflowStep,
} from "cloudflare:workers";
import { Env } from "../types";
import { CLOUDFLARE_BINDING_MAP } from "../utils/cloudflare-bindings";

interface MaintenanceParams {
    force?: boolean;
    tags?: string[];
}

export class MaintenanceWorkflow extends WorkflowEntrypoint<Env, MaintenanceParams> {
    async run(event: WorkflowEvent<MaintenanceParams>, step: WorkflowStep) {

        // Step 1: Gather all documentation targets from the static map
        const targets = await step.do("gather-doc-targets", async () => {
            const allTargets: { name: string; url: string; category: string }[] = [];

            // Iterate over the categories in your map
            for (const [category, bindings] of Object.entries(CLOUDFLARE_BINDING_MAP)) {
                for (const binding of bindings) {
                    if (binding.llmsTxtLink) {
                        allTargets.push({
                            name: binding.productName,
                            url: binding.llmsTxtLink,
                            category: category
                        });
                    }
                }
            }
            return allTargets;
        });

        // Step 2: Trigger Ingestion Workflows
        // We trigger a child workflow for every documentation URL found
        const results = await step.do("trigger-ingestion", async () => {
            const triggers = [];

            for (const target of targets) {
                // Generate a deterministic ID based on the URL to prevent duplicate runs 
                // if this maintenance workflow is triggered multiple times rapidly.
                // Or use randomUUID() if you prefer fresh runs every time.
                const runId = `ingest-${crypto.randomUUID().split('-')[0]}`;

                try {
                    const workflowInstance = await this.env.INGESTION_WORKFLOW.create({
                        id: runId,
                        params: {
                            url: target.url,
                            tags: ["official-docs", "maintenance-sync", target.category],
                            forceUpdate: event.payload.force ?? false
                        }
                    });

                    triggers.push({
                        status: "triggered",
                        product: target.name,
                        url: target.url,
                        workflowId: workflowInstance.id
                    });
                } catch (e) {
                    // Log failure but continue processing other docs
                    console.error(`Failed to trigger workflow for ${target.name}`, e);
                    triggers.push({
                        status: "failed",
                        product: target.name,
                        error: String(e)
                    });
                }
            }
            return triggers;
        });

        return {
            status: "complete",
            totalFound: targets.length,
            triggeredCount: results.filter(r => r.status === "triggered").length,
            results
        };
    }
}