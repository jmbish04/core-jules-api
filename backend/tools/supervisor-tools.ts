
import { JulesClient } from '../integrations/jules/index';
import { SessionState } from '../integrations/jules/types';

export const getSupervisorTools = (apiKey: string) => {
    const client = new JulesClient(apiKey);

    return [
        {
            name: 'list_blocked_sessions',
            description: 'Returns sessions that are currently blocked and need intervention (AWAITING_PLAN_APPROVAL or AWAITING_USER_FEEDBACK).',
            parameters: {
                type: 'object',
                properties: {},
                required: [],
            },
            function: async () => {
                const response = await client.listSessions(50);
                const sessions = response.sessions || [];
                return sessions.filter(s =>
                    s.state === SessionState.AWAITING_PLAN_APPROVAL ||
                    s.state === SessionState.AWAITING_USER_FEEDBACK
                );
            },
        },
        {
            name: 'approve_plan',
            description: 'Approves the current plan for a given session.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'The ID of the session to approve the plan for.' },
                },
                required: ['sessionId'],
            },
            function: async ({ sessionId }: { sessionId: string }) => {
                await client.approvePlan(sessionId);
                return `Plan approved for session ${sessionId}`;
            },
        },
        {
            name: 'get_last_error_message',
            description: 'Retrieves the last message from the agent to understand context or errors.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'The ID of the session to inspect.' },
                },
                required: ['sessionId'],
            },
            function: async ({ sessionId }: { sessionId: string }) => {
                const activities = await client.listActivities(sessionId, 5);
                // Find the last relevant message
                const activity = activities.activities?.find(a => a.agentMessaged || a.sessionFailed || a.progressUpdated);
                return activity ? JSON.stringify(activity) : "No recent activity found.";
            },
        },
        {
            name: 'send_message_to_jules',
            description: 'Sends a message to Jules to provide feedback or answers.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'The ID of the session.' },
                    message: { type: 'string', description: 'The message to send.' },
                },
                required: ['sessionId', 'message'],
            },
            function: async ({ sessionId, message }: { sessionId: string, message: string }) => {
                await client.sendMessage(sessionId, message);
                return `Message sent to session ${sessionId}`;
            },
        },
        {
            name: 'query_cloudflare_docs',
            description: 'Queries Cloudflare documentation to answer technical questions.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'The search query for the documentation.' },
                },
                required: ['query'],
            },
            function: async ({ query }: { query: string }) => {
                try {
                    const response = await fetch('https://docs.mcp.cloudflare.com/query', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ query }),
                    });
                    if (!response.ok) {
                        return `Error querying docs: ${response.statusText}`;
                    }
                    const data = await response.text();
                    return data;
                } catch (error: any) {
                    return `Failed to query docs: ${error.message}`;
                }
            },
        },
    ];
};
