import OpenAI from "openai";
import { env } from "process";
import { Env } from "../../types";
import { getAIGatewayUrl } from "../utils/ai-gateway";

export const DEFAULT_OPENAI_MODEL = env.OPENAI_MODEL || "gpt-4o";

/**
 * Initialize OpenAI Client using Cloudflare AI Gateway
 */
export function createOpenAIClient(env: Env) {
    const apiKey = env.OPENAI_API_KEY;

    if (!apiKey || !env.CLOUDFLARE_ACCOUNT_ID) {
        throw new Error("Missing OPENAI_API_KEY or CLOUDFLARE_ACCOUNT_ID in environment variables");
    }

    return new OpenAI({
        apiKey: apiKey,
        baseURL: getAIGatewayUrl(env, { provider: "openai" }),
        defaultHeaders: {
            'cf-aig-authorization': `Bearer ${env.CF_AIG_TOKEN}`,
        },
    });
}

export function getOpenAIModel(env: Env): string {
    return env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
}

/**
 * Standard query to OpenAI
 */
export async function queryOpenAI(
    env: Env,
    prompt: string,
    systemPrompt?: string
): Promise<string> {
    const client = createOpenAIClient(env);
    const model = getOpenAIModel(env);

    try {
        const messages: any[] = [];
        if (systemPrompt) {
            messages.push({ role: "system", content: systemPrompt });
        }
        messages.push({ role: "user", content: prompt });

        const completion = await client.chat.completions.create({
            model: model,
            messages: messages,
        });

        return completion.choices[0].message.content || "";
    } catch (error) {
        console.error("OpenAI Query Error:", error);
        throw error;
    }
}
