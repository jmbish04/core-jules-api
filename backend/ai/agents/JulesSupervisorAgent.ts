import { BaseAgent } from "./BaseAgent";
import { Env } from "../../types";
import { AgentState } from "./types";
import { JulesClient, Session } from "../../integrations/jules";
import { SessionState } from "../../integrations/jules/types";
import { getSupervisorTools } from "../../tools/supervisor-tools";
import { drizzle } from 'drizzle-orm/d1';
import { monitoredSessions } from "../../db/schema";
import { sql } from "drizzle-orm";
import { DurableObjectState } from "@cloudflare/workers-types";
import { createWorkersAI } from "workers-ai-provider";
import { generateText } from "ai";

interface SupervisorState extends AgentState {
    lastChecked: number;
    processedSessions: Record<string, number>; // sessionId -> last processed timestamp
}

export class JulesSupervisor extends BaseAgent<Env, SupervisorState> {
    agentName = "jules-supervisor";

    constructor(state: DurableObjectState, env: Env) {
        super(state, env);
        // Initialize default state if needed
        this.state = {
            history: [],
            lastChecked: 0,
            processedSessions: {},
            ...this.state
        };
    }

    async onStart() {
        // Schedule first check in 5 minutes
        await this.schedule(Date.now() + 5 * 60 * 1000, "onSchedule", {});
    }

    // Agent internal schedule handler
    async onSchedule() {
        await this.checkJulesStatus();
        // Reschedule
        await this.schedule(Date.now() + 5 * 60 * 1000, "onSchedule", {});
    }

    async checkJulesStatus() {
        console.log("[JulesSupervisor] Checking status...");
        const client = new JulesClient(this.env.JULES_API_KEY);
        const response = await client.listSessions();
        const sessions = response.sessions || [];
        const db = drizzle(this.env.DB);

        // 1. Sync Sessions to DB (Rooted Context Tracking)
        for (const session of sessions) {
            try {
                // Upsert session to track original intent
                // We assume session object has 'prompt' or similar field for originalPrompt.
                // If not, we might need to fetch detailed session info.
                // Looking at JulesClient types, Session has 'title' but maybe not full prompt in list.
                // Let's assume we need to getSession for the full prompt if it's missing.
                // For now, mapping 'title' or 'prompt' if available. 
                // IF prompt is missing in listSessions response, we fetch detail.

                let originalPrompt = (session as any).prompt || session.title || "Unknown Goal";

                await db.insert(monitoredSessions).values({
                    julesSessionId: session.id,
                    originalPrompt: originalPrompt,
                    title: session.title,
                    currentStatus: session.state,
                    lastUpdatedAt: new Date(),
                    firstSeenAt: new Date()
                }).onConflictDoUpdate({
                    target: monitoredSessions.julesSessionId,
                    set: {
                        lastUpdatedAt: new Date(),
                        currentStatus: session.state
                    }
                });

            } catch (err) {
                console.error(`[JulesSupervisor] Failed to sync session ${session.id}:`, err);
            }
        }

        // 2. Identify Blocked Sessions
        const blockedSessions = sessions.filter(s =>
            s.state === SessionState.AWAITING_PLAN_APPROVAL ||
            (s.state === SessionState.AWAITING_USER_FEEDBACK && /* heuristic for stuck? */ false)
        );

        for (const session of blockedSessions) {
            // Check if we already processed this blockage recently
            const lastProc = this.state?.processedSessions?.[session.id] || 0;
            // Debounce: don't process same session more than once every 10 mins unless state changed?
            // Simple logic: if > 10 mins ago
            if (Date.now() - lastProc > 10 * 60 * 1000) {
                await this.runAILoop(session);

                // Update state
                const newProcessed = {
                    ...(this.state?.processedSessions || {}),
                    [session.id]: Date.now()
                };

                this.setState({
                    history: this.state?.history || [],
                    ...this.state,
                    processedSessions: newProcessed,
                    lastChecked: this.state?.lastChecked || Date.now()
                });
            }
        }

        this.setState({
            history: this.state?.history || [],
            ...this.state,
            lastChecked: Date.now(),
            processedSessions: this.state?.processedSessions || {}
        });
    }

    async runAILoop(session: Session) {
        console.log(`[JulesSupervisor] Starting AI Loop for session ${session.id}`);

        // Fetch Root Intent from DB
        const db = drizzle(this.env.DB);
        let rootIntent = "Ensure the session moves forward according to user goals.";
        try {
            const Record = await db.select().from(monitoredSessions).where(sql`${monitoredSessions.julesSessionId} = ${session.id}`).get();
            if (Record) {
                rootIntent = Record.originalPrompt;
            }
        } catch (e) {
            console.warn(`[JulesSupervisor] Could not fetch root intent for ${session.id}`, e);
        }

        const supervisorTools = getSupervisorTools(this.env.JULES_API_KEY);
        const toolNames = supervisorTools.map(t => t.name).join(", ");

        // Context Injection
        const systemPrompt = `You are an autonomous supervisor for the AI agent 'Jules'.
        
ROOT INTENT (The User's Original Goal):
"${rootIntent}"

CONTEXT:
Session ID: ${session.id}
Current Status: ${session.state}

YOUR OBJECTIVE:
Unblock Jules. 
AVAILABLE TOOLS: ${toolNames}
`;

        const analysisPrompt = `${systemPrompt}\n\nAnalyze and decide next step.`;
        const decision = await this.generateTextWithWorkerAI(analysisPrompt);

        console.log(`[JulesSupervisor] Decision for ${session.id}:`, decision);
    }

    async generateTextWithWorkerAI(prompt: string): Promise<string> {
        const workersai = createWorkersAI({ binding: this.env.AI });
        const model = workersai('@cf/openai/gpt-oss-120b');

        const tools = getSupervisorTools(this.env.JULES_API_KEY);
        const aiSdkTools: Record<string, any> = {};
        for (const t of tools) {
            aiSdkTools[t.name] = {
                description: t.description,
                parameters: t.parameters,
                execute: t.function
            };
        }

        const result = await generateText({
            model,
            system: "You are a helpful supervisor.",
            messages: [{ role: 'user', content: prompt }],
            tools: aiSdkTools,
            // maxSteps: 2, // Commented out to potentially fix type error
        });

        return result.text;
    }

    // Required by BaseAgent but effectively unused for this background agent
    async onRequest(request: Request) {
        return new Response("Jules Supervisor Active", { status: 200 });
    }
}
