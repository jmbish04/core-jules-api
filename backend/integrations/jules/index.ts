import { AutomationMode, SessionState } from "./types";

// ==========================================
// Data Models
// ==========================================

export interface GitHubRepo {
    owner: string;
    repo: string;
    isPrivate?: boolean;
    defaultBranch?: { displayName: string };
    branches?: { displayName: string }[];
}

export interface Source {
    name: string; // "sources/{source}"
    id: string;
    githubRepo?: GitHubRepo;
}

export interface GitHubRepoContext {
    startingBranch: string;
}

export interface SourceContext {
    source: string; // "sources/{source_id}"
    githubRepoContext?: GitHubRepoContext;
}

export interface PullRequest {
    url: string;
    title: string;
    description: string;
}

export interface SessionOutput {
    pullRequest?: PullRequest;
}

export interface Session {
    name: string; // "sessions/{session}"
    id: string;
    prompt: string;
    sourceContext: SourceContext;
    title?: string;
    requirePlanApproval?: boolean;
    automationMode?: AutomationMode;
    createTime: string;
    updateTime: string;
    state: SessionState;
    url: string;
    outputs?: SessionOutput[];
}

// ==========================================
// Activity & Artifact Models
// ==========================================

export interface PlanStep {
    id: string;
    title: string;
    description: string;
    index: number;
}

export interface Plan {
    id: string;
    steps: PlanStep[];
    createTime: string;
}

export interface GitPatch {
    unidiffPatch: string;
    baseCommitId: string;
    suggestedCommitMessage?: string;
}

export interface ChangeSet {
    source: string;
    gitPatch?: GitPatch;
}

export interface BashOutput {
    command: string;
    output: string;
    exitCode: number;
}

export interface Media {
    data: string; // Base64
    mimeType: string;
}

export interface Artifact {
    changeSet?: ChangeSet;
    media?: Media;
    bashOutput?: BashOutput;
}

export interface Activity {
    name: string;
    id: string;
    description?: string;
    createTime: string;
    originator: "user" | "agent" | "system" | string;
    artifacts?: Artifact[];

    // Union fields (Activity Type)
    agentMessaged?: { agentMessage: string };
    userMessaged?: { userMessage: string };
    planGenerated?: { plan: Plan };
    planApproved?: { planId: string };
    progressUpdated?: { title: string; description: string };
    sessionCompleted?: {};
    sessionFailed?: { reason: string };
}

// ==========================================
// Request/Response Interfaces
// ==========================================

export interface ListSourcesResponse {
    sources: Source[];
    nextPageToken?: string;
}

export interface CreateSessionRequest {
    prompt: string;
    sourceContext: SourceContext;
    automationMode?: AutomationMode;
    requirePlanApproval?: boolean;
    title?: string;
}

export interface ListSessionsResponse {
    sessions: Session[];
    nextPageToken?: string;
}

export interface SendMessageRequest {
    prompt: string;
}

export interface ListActivitiesResponse {
    activities: Activity[];
    nextPageToken?: string;
}

// ==========================================
// Jules API Client
// ==========================================

export class JulesClient {
    private apiKey: string;
    private baseUrl: string;

    constructor(apiKey: string, baseUrl = "https://jules.googleapis.com/v1alpha") {
        this.apiKey = apiKey;
        this.baseUrl = baseUrl;
    }

    private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
        const url = `${this.baseUrl}${endpoint}`;
        const headers = {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": this.apiKey,
            ...options.headers,
        };

        const response = await fetch(url, {
            ...options,
            headers,
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Jules API Error (${response.status}): ${errorText}`);
        }

        return response.json() as Promise<T>;
    }

    /**
     * List all available sources (e.g., connected GitHub repos).
     */
    async listSources(pageSize?: number, pageToken?: string): Promise<ListSourcesResponse> {
        const params = new URLSearchParams();
        if (pageSize) params.append("pageSize", pageSize.toString());
        if (pageToken) params.append("pageToken", pageToken);

        return this.request<ListSourcesResponse>(`/sources?${params.toString()}`);
    }

    /**
     * Create a new Jules session.
     */
    async createSession(payload: CreateSessionRequest): Promise<Session> {
        return this.request<Session>("/sessions", {
            method: "POST",
            body: JSON.stringify(payload),
        });
    }

    /**
     * List existing sessions.
     */
    async listSessions(pageSize?: number, pageToken?: string): Promise<ListSessionsResponse> {
        const params = new URLSearchParams();
        if (pageSize) params.append("pageSize", pageSize.toString());
        if (pageToken) params.append("pageToken", pageToken);

        return this.request<ListSessionsResponse>(`/sessions?${params.toString()}`);
    }

    /**
     * Get a specific session by ID.
     * @param sessionId The ID or full resource name of the session.
     */
    async getSession(sessionId: string): Promise<Session> {
        const id = this.normalizeId(sessionId, "sessions");
        return this.request<Session>(`/${id}`);
    }

    /**
     * Approve the current plan in a session.
     * @param sessionId The ID or full resource name of the session.
     */
    async approvePlan(sessionId: string): Promise<void> {
        const id = this.normalizeId(sessionId, "sessions");
        // Returns empty body on success usually, but typed as void here.
        await this.request<any>(`/${id}:approvePlan`, {
            method: "POST",
        });
    }

    /**
     * Send a new message/prompt to an existing session.
     * @param sessionId The ID or full resource name of the session.
     * @param prompt The message content.
     */
    async sendMessage(sessionId: string, prompt: string): Promise<void> {
        const id = this.normalizeId(sessionId, "sessions");
        const payload: SendMessageRequest = { prompt };

        await this.request<any>(`/${id}:sendMessage`, {
            method: "POST",
            body: JSON.stringify(payload),
        });
    }

    /**
     * List activities (history) for a specific session.
     * @param sessionId The ID or full resource name of the session.
     */
    async listActivities(
        sessionId: string,
        pageSize?: number,
        pageToken?: string
    ): Promise<ListActivitiesResponse> {
        const id = this.normalizeId(sessionId, "sessions");
        const params = new URLSearchParams();
        if (pageSize) params.append("pageSize", pageSize.toString());
        if (pageToken) params.append("pageToken", pageToken);

        return this.request<ListActivitiesResponse>(`/${id}/activities?${params.toString()}`);
    }

    /**
     * Helper to ensure ID is formatted as "resource/id" or just returns if already formatted.
     * Note: The API usually returns "sessions/123", but accepts strict formatting.
     */
    private normalizeId(input: string, prefix: string): string {
        if (input.startsWith(`${prefix}/`)) return input;
        return `${prefix}/${input}`;
    }
}