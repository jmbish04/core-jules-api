
/**
 * Cloudflare API Token Verification Utilities
 *
 * Capabilities:
 * - Verify USER token
 * - Verify ACCOUNT token
 * - Auto-detect token type
 * - Enforce expected token type
 */

export type CloudflareTokenType = "user" | "account" | "unknown" | "none";

export interface CloudflareTokenVerifyResult {
    success: boolean;
    status?: "active" | "disabled" | "revoked";
    token_id?: string;
    errors?: Array<{
        code: number;
        message: string;
    }>;
    raw?: unknown;
}

export interface CloudflareTokenTestResult {
    passed: boolean;
    reason:
    | "TOKEN_VALID_AND_TYPE_MATCHES"
    | "TOKEN_VALID_BUT_WRONG_TYPE"
    | "TOKEN_INVALID"
    | "TOKEN_MISSING";
    detectedType: CloudflareTokenType;
    details?: {
        user?: CloudflareTokenVerifyResult;
        account?: CloudflareTokenVerifyResult;
    };
}

/**
 * Verify a USER API token
 */
export async function verifyUserToken(
    token: string
): Promise<CloudflareTokenVerifyResult> {
    const res = await fetch(
        "https://api.cloudflare.com/client/v4/user/tokens/verify",
        {
            method: "GET",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            }
        }
    );

    const json = await res.json() as any;

    if (!res.ok || json.success !== true) {
        return {
            success: false,
            errors: json.errors ?? [
                { code: res.status, message: "User token verification failed" }
            ],
            raw: json
        };
    }

    return {
        success: true,
        status: json.result?.status,
        token_id: json.result?.id,
        raw: json
    };
}

/**
 * Verify an ACCOUNT-scoped API token
 */
export async function verifyAccountToken(
    token: string,
    accountId: string
): Promise<CloudflareTokenVerifyResult> {
    const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/verify`,
        {
            method: "GET",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            }
        }
    );

    const json = await res.json() as any;

    if (!res.ok || json.success !== true) {
        return {
            success: false,
            errors: json.errors ?? [
                { code: res.status, message: "Account token verification failed" }
            ],
            raw: json
        };
    }

    return {
        success: true,
        status: json.result?.status,
        token_id: json.result?.id,
        raw: json
    };
}

/**
 * Detect token type by testing both USER and ACCOUNT endpoints.
 */
export async function detectTokenType(
    token: string,
    accountId: string
): Promise<{
    detectedType: CloudflareTokenType;
    userResult: CloudflareTokenVerifyResult;
    accountResult: CloudflareTokenVerifyResult;
}> {
    const [userResult, accountResult] = await Promise.all([
        verifyUserToken(token),
        verifyAccountToken(token, accountId)
    ]);

    let detectedType: CloudflareTokenType = "unknown";

    if (userResult.success && !accountResult.success) {
        detectedType = "user";
    } else if (!userResult.success && accountResult.success) {
        detectedType = "account";
    } else if (!userResult.success && !accountResult.success) {
        detectedType = "unknown";
    } else if (userResult.success && accountResult.success) {
        // If both succeed (rare/weird?), prioritize account if explicitly checking account context, but here maybe just 'account' or 'user'?
        // The logic provided by user was strict: if user success & !account success -> user.
        // Let's stick to the user's logic provided in the prompt but fix the implicit case where both might match.
        // In Cloudflare, a token usually has specific permissions.
        // If it works for both, it's a very powerful token. Let's call it 'user' as it likely stems from user having access to account.
        detectedType = "user";
    }

    return {
        detectedType,
        userResult,
        accountResult
    };
}

/**
 * SINGLE ENTRY POINT
 *
 * Test a token against an expected type.
 *
 * Rules:
 * - If token is empty/null → FAIL (TOKEN_MISSING)
 * - If token is valid but wrong type → FAIL
 * - If token is valid and matches expected type → PASS
 * - If token is invalid → FAIL
 */
export async function testToken(
    token: string | null | undefined,
    expectedType: Exclude<CloudflareTokenType, "unknown" | "none">,
    accountId: string
): Promise<CloudflareTokenTestResult> {
    if (!token || token.trim() === "") {
        return {
            passed: false,
            reason: "TOKEN_MISSING",
            detectedType: "none"
        };
    }

    const { detectedType, userResult, accountResult } =
        await detectTokenType(token, accountId);

    if (detectedType === "unknown") {
        return {
            passed: false,
            reason: "TOKEN_INVALID",
            detectedType,
            details: {
                user: userResult,
                account: accountResult
            }
        };
    }

    if (detectedType !== expectedType) {
        return {
            passed: false,
            reason: "TOKEN_VALID_BUT_WRONG_TYPE",
            detectedType,
            details: {
                user: userResult,
                account: accountResult
            }
        };
    }

    return {
        passed: true,
        reason: "TOKEN_VALID_AND_TYPE_MATCHES",
        detectedType,
        details: {
            user: userResult,
            account: accountResult
        }
    };
}

/**
 * Test if a token is valid (either User OR Account)
 */
export async function testAnyValidToken(
    token: string | null | undefined,
    accountId: string
): Promise<CloudflareTokenTestResult> {
    if (!token || token.trim() === "") {
        return {
            passed: false,
            reason: "TOKEN_MISSING",
            detectedType: "none"
        };
    }

    const { detectedType, userResult, accountResult } =
        await detectTokenType(token, accountId);

    if (detectedType === "unknown") {
        return {
            passed: false,
            reason: "TOKEN_INVALID",
            detectedType,
            details: {
                user: userResult,
                account: accountResult
            }
        };
    }

    return {
        passed: true,
        reason: "TOKEN_VALID_AND_TYPE_MATCHES",
        detectedType,
        details: {
            user: userResult,
            account: accountResult
        }
    };
}
