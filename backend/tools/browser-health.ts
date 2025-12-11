
import { Env } from "../../types";
import { HealthStepResult } from "../../core/health-check";
import { testAnyValidToken } from "../../utils/cloudflare-token";

/**
 * Checks the health of the Browser Render API by verifying:
 * 1. CLOUDFLARE_ACCOUNT_ID and CF_BROWSER_RENDER_TOKEN are configured
 */
export async function checkHealth(env: Env): Promise<HealthStepResult> {
    const start = Date.now();

    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    const token = env.CF_BROWSER_RENDER_TOKEN;

    if (!accountId || !token) {
        return {
            name: "Browser Render API",
            status: "failure",
            message: "Missing configuration",
            durationMs: Date.now() - start,
            details: {
                accountId: !!accountId,
                token: !!token
            }
        };
    }

    // Verify Token
    const authResult = await testAnyValidToken(token, accountId);

    if (!authResult.passed) {
        return {
            name: "Browser Render API",
            status: "failure",
            message: `Token Verification Failed: ${authResult.reason}`,
            durationMs: Date.now() - start,
            details: {
                reason: authResult.reason,
                detectedType: authResult.detectedType,
                authDetails: authResult.details
            }
        };
    }

    return {
        name: "Browser Render API",
        status: "success",
        message: "Configured & Active",
        durationMs: Date.now() - start,
        details: {
            configured: true,
            authType: authResult.detectedType
        }
    };
}
