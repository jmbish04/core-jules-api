import { Env } from "../../types";
import { HealthStepResult } from "../../core/health-check";
import { testToken } from "../../utils/cloudflare-token";

/**
 * Checks the health of AI Agents
 */
export async function checkHealth(env: Env): Promise<HealthStepResult> {
    const start = Date.now();
    const subChecks: Record<string, any> = {};

    // 1. Verify AI Gateway Token if present
    if (env.CF_AIG_TOKEN && env.CLOUDFLARE_ACCOUNT_ID) {
        const authResult = await testToken(env.CF_AIG_TOKEN, 'user', env.CLOUDFLARE_ACCOUNT_ID);
        if (!authResult.passed) {
            subChecks.aiGateway = {
                status: "FAILURE",
                message: "Invalid AI Gateway Token",
                reason: authResult.reason,
                details: authResult.details
            };
        } else {
            subChecks.aiGateway = {
                status: "OK",
                type: authResult.detectedType
            };
        }
    }

    try {
        if (env.CHAT_AGENT) {
            // 2. Comprehensive Agent Health Check (Worker AI + Tools + DB)
            try {
                const id = env.CHAT_AGENT.idFromName("health-check");
                const stub = env.CHAT_AGENT.get(id);
                const agentStart = Date.now();

                const response = await stub.fetch("https://agent/chat", {
                    method: "POST",
                    body: JSON.stringify({ health_check: true }),
                    headers: {
                        "Content-Type": "application/json",
                        "x-partykit-namespace": "health-check",
                        "x-partykit-room": "health-check-room"
                    }
                });

                if (response.ok) {
                    const healthData = await response.json() as any;
                    subChecks.chatAgent = {
                        status: healthData.status === 'OK' ? 'OK' : 'WARNING',
                        latency: Date.now() - agentStart,
                        details: healthData.checks
                    };
                } else {
                    const text = await response.text();
                    subChecks.chatAgent = { status: "FAILURE", statusCode: response.status, body: text.substring(0, 200) };
                }
            } catch (e) {
                subChecks.chatAgent = { status: "FAILURE", error: String(e) };
            }

            // 3. Simple Ping Checks for External Providers (Cost Saving)
            // Gemini Ping
            if (env.GEMINI_API_KEY) {
                subChecks.geminiPing = { status: "OK", type: "Configured" };
            } else {
                subChecks.geminiPing = { status: "SKIPPED", reason: "Missing Key" };
            }

            // OpenAI Ping
            if (env.OPENAI_API_KEY) {
                subChecks.openAIPing = { status: "OK", type: "Configured" };
            } else {
                subChecks.openAIPing = { status: "SKIPPED", reason: "Missing Key" };
            }

        } else {
            subChecks.chatAgent = { status: "SKIPPED", reason: "Binding missing" };
        }

        const subCheckValues = Object.values(subChecks);
        const hasFailure = subCheckValues.some(c => c.status === 'FAILURE');

        return {
            name: "Agents",
            status: hasFailure ? "failure" : "success",
            message: hasFailure ? "One or more checks failed" : "Agents Operational",
            durationMs: Date.now() - start,
            details: subChecks
        };
    } catch (error) {
        return {
            name: "Agents",
            status: "failure",
            message: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - start,
            details: subChecks
        };
    }
}
