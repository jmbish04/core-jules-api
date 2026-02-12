/**
 * @file jules.sdk.ts
 * @version 1.0.0
 * @summary TypeScript SDK for the Jules API (v1alpha).
 * @description
 * This file contains a lightweight, zero-dependency TypeScript client for interacting
 * with the experimental Jules API (jules.googleapis.com/v1alpha). It is designed
 * to be self-contained and easily used in modern TypeScript environments,
 * including serverless platforms like Cloudflare Workers.
 *
 * The SDK handles authentication via the 'X-Goog-Api-Key' header and provides
 * strongly-typed methods and interfaces for all major API resources.
 *
 * @warning
 * This SDK targets an 'alpha' API version. Endpoints, request bodies, and
 * response structures are experimental and may change without notice.
 * Always refer to the official documentation for the latest specifications.
 *
 * @see {@link https://developers.google.com/jules/api/reference/rest} Official Jules API Reference
 *
 * @example (Usage in a Cloudflare Worker `index.ts`)
 *
 * import { JulesSDK, AutomationMode, CreateSessionPayload } from './jules.sdk';
 *
 * // Define the environment interface for Cloudflare Worker bindings
 * export interface Env {
 * JULES_API_KEY: string;
 * }
 *
 * export default {
 * async fetch(request: Request, env: Env): Promise<Response> {
 * // 1. Instantiate the SDK with the API key from secrets
 * const jules = new JulesSDK(env.JULES_API_KEY);
 *
 * try {
 * // 2. Call an SDK method
 * const { sources } = await jules.listSources();
 *
 * // 3. Find a specific source
 * const mySource = sources.find(s => s.id === "github/your-user/your-repo");
 * if (!mySource) {
 * return new Response("Source not found", { status: 404 });
 * }
 *
 * // 4. Create a new session
 * const payload: CreateSessionPayload = {
 * prompt: "Refactor the main App component to use React Hooks.",
 * title: "Refactor Session (from Worker)",
 * sourceContext: {
 * source: mySource.name, // e.g., "sources/github/your-user/your-repo"
 * githubRepoContext: {
 * startingBranch: "main",
 * },
 * },
 * automationMode: AutomationMode.AUTO_CREATE_PR,
 * };
 *
 * const newSession = await jules.createSession(payload);
 *
 * // 5. Return the result
 * return new Response(JSON.stringify(newSession, null, 2), {
 * headers: { "Content-Type": "application/json" },
 * });
 *
 * } catch (error) {
 * console.error(error);
 * return new Response(JSON.stringify({ error: error.message }), { status: 500 });
 * }
 * }
 * };
 */

// --- API Resource Interfaces (v1alpha) ---
// These interfaces define the data structures returned by and sent to
// the Jules API. They are based on the official v1alpha REST reference.
// -------------------------------------------

/** A GitHub branch resource. */
export interface GitHubBranch {
    /** The name of the GitHub branch. @example "main" */
    displayName: string;
  }
  
  /**
   * A GitHub repository source.
   * This object is part of the `Source` resource union field.
   */
  export interface GitHubRepo {
    /** The owner of the repo; the `<owner>` in `https://github.com/<owner>/<repo>`. */
    owner: string;
    /** The name of the repo; the `<repo>` in `https://github.com/<owner>/<repo>`. */
    repo: string;
    /** Output only. Whether this repo is private. */
    isPrivate?: boolean;
    /** Output only. The default branch for this repo. */
    defaultBranch?: GitHubBranch;
    /** Output only. The list of active branches for this repo. */
    branches?: GitHubBranch[];
  }
  
  /**
   * An input source of data for a session.
   * @see {@link https://developers.google.com/jules/api/reference/rest/v1alpha/sources#Source}
   */
  export interface Source {
    /**
     * Identifier. The full resource name.
     * This is the value used in API calls.
     * @example "sources/github/bobalover/boba"
     */
    name: string;
    /**
     * Output only. The id of the source.
     * @example "github/bobalover/boba"
     */
    id: string;
    /**
     * A GitHub repo. This is a union field `source`.
     * Only one field in the `source` union will be present.
     */
    githubRepo?: GitHubRepo;
  }
  
  /**
   * Response object for the `listSources` method.
   */
  export interface ListSourcesResponse {
    /** A list of Source resources. */
    sources: Source[];
    /** A token to retrieve the next page of results. */
    nextPageToken?: string;
  }
  
  /**
   * Context to use a GitHubRepo in a session.
   * @see {@link https://developers.google.com/jules/api/reference/rest/v1alpha/sessions#GitHubRepoContext}
   */
  export interface GitHubRepoContext {
    /** Required. The name of the branch to start the session from. */
    startingBranch: string;
  }
  
  /**
   * Context for how to use a source in a session.
   * @see {@link https://developers.google.com/jules/api/reference/rest/v1alpha/sessions#SourceContext}
   */
  export interface SourceContext {
    /**
     * Required. The full resource name of the source this context is for.
     * Get this value from the `name` field of a `Source` object.
     * @example "sources/github/bobalover/boba"
     */
    source: string;
    /**
     * Context to use a GitHubRepo in a session.
     * This is a union field `context`.
     */
    githubRepoContext?: GitHubRepoContext;
  }
  
  /**
   * The automation mode of the session.
   * @see {@link https://developers.google.com/jules/api/reference/rest/v1alpha/sessions#AutomationMode}
   */
  export enum AutomationMode {
    /** The automation mode is unspecified. Defaults to no automation. */
    AUTOMATION_MODE_UNSPECIFIED = "AUTOMATION_MODE_UNSPECIFIED",
    /** Automatically create a branch and a pull request. */
    AUTO_CREATE_PR = "AUTO_CREATE_PR",
  }
  
  /**
   * State of a session.
   * @see {@link https://developers.google.com/jules/api/reference/rest/v1alpha/sessions#State}
   */
  export enum SessionState {
    STATE_UNSPECIFIED = "STATE_UNSPECIFIED",
    QUEUED = "QUEUED",
    PLANNING = "PLANNING",
    AWAITING_PLAN_APPROVAL = "AWAITING_PLAN_APPROVAL",
    AWAITING_USER_FEEDBACK = "AWAITING_USER_FEEDBACK",
    IN_PROGRESS = "IN_PROGRESS",
    PAUSED = "PAUSED",
    FAILED = "FAILED",
    COMPLETED = "COMPLETED",
  }
  
  /**
   * A pull request created by the session.
   * @see {@link https://developers.google.com/jules/api/reference/rest/v1alpha/sessions#PullRequest}
   */
  export interface PullRequest {
    /** The URL of the pull request. */
    url: string;
    /** The title of the pull request. */
    title: string;
    /** The description of the pull request. */
    description: string;
  }
  
  /**
   * An output of a session.
   * This is a union field `output`.
   * @see {@link https://developers.google.com/jules/api/reference/rest/v1alpha/sessions#SessionOutput}
   */
  export interface SessionOutput {
    /** A pull request created by the session, if applicable. */
    pullRequest?: PullRequest;
  }
  
  /**
   * A session is a contiguous amount of work within the same context.
   * @see {@link https://developers.google.com/jules/api/reference/rest/v1alpha/sessions#Session}
   */
  export interface Session {
    /**
     * Output only. Identifier. The full resource name.
     * This value is used to identify the session in subsequent API calls.
     * @example "sessions/31415926535897932384"
     */
    name: string;
    /**
     * Output only. The id of the session.
     * @example "31415926535897932384"
     */
    id: string;
    /** Required. The prompt to start the session with. */
    prompt: string;
    /** Required. The source to use in this session, with additional context. */
    sourceContext: SourceContext;
    /** Optional. If not provided, the system will generate one. */
    title: string;
    /**
     * Optional. Input only. If true, plans require explicit approval.
     * @default false
     */
    requirePlanApproval?: boolean;
    /** Optional. Input only. The automation mode of the session. */
    automationMode?: AutomationMode;
    /** Output only. The time the session was created (RFC 3339 timestamp). */
    createTime: string;
    /** Output only. The time the session was last updated (RFC 3339 timestamp). */
    updateTime: string;
    /** Output only. The state of the session. */
    state: SessionState;
    /** Output only. The URL of the session in the Jules web app. */
    url: string;
    /** Output only. The outputs of the session, if any. */
    outputs?: SessionOutput[];
  }
  
  /**
   * Defines the payload for creating a new session.
   * This is the request body for `sessions.create`.
   * @see {@link https://developers.google.com/jules/api/reference/rest/v1alpha/sessions/create}
   */
  export interface CreateSessionPayload {
    /** Required. The prompt to start the session with. */
    prompt: string;
    /** Required. The source to use in this session, with additional context. */
    sourceContext: SourceContext;
    /** Optional. If not provided, the system will generate one. */
    title?: string;
    /**
     * Optional. Input only. If true, plans require explicit approval.
     * @default false (plans are auto-approved)
     */
    requirePlanApproval?: boolean;
    /** Optional. Input only. The automation mode of the session. */
    automationMode?: AutomationMode;
  }
  
  /**
   * Query parameters for the `listSessions` method.
   * @see {@link https://developers.google.com/jules/api/reference/rest/v1alpha/sessions/list}
   */
  export interface ListSessionsParams {
    /** The maximum number of sessions to return. */
    pageSize?: number;
    /** A page token from a previous `listSessions` response. */
    pageToken?: string;
  }
  
  /**
   * Response object for the `listSessions` method.
   */
  export interface ListSessionsResponse {
    /** A list of Session resources. */
    sessions: Session[];
    /** A token to retrieve the next page of results. */
    nextPageToken?: string;
  }
  
  /**
   * Defines the payload for sending a message to a session.
   * This is the request body for `sessions.sendMessage`.
   * @see {@link https://developers.google.com/jules/api/reference/rest/v1alpha/sessions/sendMessage}
   */
  export interface SendMessagePayload {
    /** Required. The user prompt to send to the session. */
    prompt: string;
  }
  
  // --- Activity Resource Interfaces ---
  
  /**
   * A patch in Git format.
   * @see {@link https://developers.google.com/jules/api/reference/rest/v1alpha/sessions.activities#GitPatch}
   */
  export interface GitPatch {
    /** The patch in unidiff format. */
    unidiffPatch?: string;
    /** The base commit id of the patch. */
    baseCommitId?: string;
    /** A suggested commit message for the patch. */
    suggestedCommitMessage?: string;
  }
  
  /**
   * A set of changes to be applied to a source.
   * @see {@link https://developers.google.com/jules/api/reference/rest/v1alpha/sessions.activities#ChangeSet}
   */
  export interface ChangeSet {
    /**
     * The name of the source this change set applies to.
     * @example "sources/github/bobalover/boba"
     */
    source: string;
    /** A patch in Git format. This is a union field `changes`. */
    gitPatch?: GitPatch;
  }
  
  /**
  * A media output (e.g., an image).
  * @see {@link https://developers.google.com/jules/api/reference/rest/v1alpha/sessions.activities#Media}
  */
  export interface Media {
    /** The media data, as a base64-encoded string. */
    data: string;
    /** The media mime type. @example "image/png" */
    mimeType: string;
  }
  
  /**
  * A bash command output.
  * @see {@link https://developers.google.com/jules/api/reference/rest/v1alpha/sessions.activities#BashOutput}
  */
  export interface BashOutput {
    /** The bash command that was run. */
    command?: string;
    /** The output of the command (stdout and stderr). */
    output?: string;
    /** The exit code of the command. */
    exitCode?: number;
  }
  
  /**
  * An artifact produced by an activity.
  * This is a union field `content`.
  * @see {@link https://developers.google.com/jules/api/reference/rest/v1alpha/sessions.activities#Artifact}
  */
  export interface Artifact {
    /** A change set was produced (e.g. code changes). */
    changeSet?: ChangeSet;
    /** A media file was produced (e.g. image, video). */
    media?: Media;
    /** A bash output was produced. */
    bashOutput?: BashOutput;
  }
  
  /** The agent posted a message. */
  export interface AgentMessaged {
    agentMessage: string;
  }
  
  /** The user posted a message. */
  export interface UserMessaged {
    userMessage: string;
  }
  
  /** A step in a plan. */
  export interface PlanStep {
    id: string;
    title: string;
    description?: string;
    index?: number;
  }
  
  /** A plan is a sequence of steps for the agent. */
  export interface Plan {
    id: string;
    steps: PlanStep[];
    createTime: string; // RFC 3339 timestamp
  }
  
  /** A plan was generated. */
  export interface PlanGenerated {
    plan: Plan;
  }
  
  /** A plan was approved. */
  export interface PlanApproved {
    planId: string;
  }
  
  /** There was a progress update. */
  export interface ProgressUpdated {
    title: string;
    description?: string;
  }
  
  /** The session was completed. This type has no fields. */
  export interface SessionCompleted {}
  
  /** The session failed. */
  export interface SessionFailed {
    reason: string;
  }
  
  /**
   * An activity is a single unit of work within a session.
   * @see {@link https://developers.google.com/jules/api/reference/rest/v1alpha/sessions.activities#Activity}
   */
  export interface Activity {
    /**
     * Identifier. The full resource name.
     * @example "sessions/14550388554331055113/activities/02200cce44f746308651037e4a18caed"
     */
    name: string;
    /**
     * Output only. The id of the activity.
     * @example "02200cce44f746308651037e4a18caed"
     */
    id: string;
    /** Output only. A description of this activity. */
    description?: string;
    /** Output only. The time at which this activity was created (RFC 3339 timestamp). */
    createTime: string;
    /** The entity that this activity originated from (e.g. "user", "agent", "system"). */
    originator: string;
    /** Output only. The artifacts produced by this activity. */
    artifacts?: Artifact[];
  
    // --- Union field `activity` ---
    /** The agent posted a message. */
    agentMessaged?: AgentMessaged;
    /** The user posted a message. */
    userMessaged?: UserMessaged;
    /** A plan was generated. */
    planGenerated?: PlanGenerated;
    /** A plan was approved. */
    planApproved?: PlanApproved;
    /** There was a progress update. */
    progressUpdated?: ProgressUpdated;
    /** The session was completed. */
    sessionCompleted?: SessionCompleted;
    /** The session failed. */
    sessionFailed?: SessionFailed;
  }
  
  /**
   * Query parameters for the `listActivities` method.
   * @see {@link https://developers.google.com/jules/api/reference/rest/v1alpha/sessions.activities/list}
   */
  export interface ListActivitiesParams {
    /** The maximum number of activities to return. */
    pageSize?: number;
    /** A page token from a previous `listActivities` response. */
    pageToken?: string;
  }
  
  /**
   * Response object for the `listActivities` method.
   */
  export interface ListActivitiesResponse {
    /** A list of Activity resources. */
    activities: Activity[];
    /** A token to retrieve the next page of results. */
    nextPageToken?: string;
  }
  
  // --- Jules API SDK Class ---
  // Provides a reusable client for making authenticated API calls.
  // ---------------------------
  
  /**
   * Jules API SDK Client (v1alpha)
   *
   * This class provides a convenient wrapper around the Jules v1alpha API,
   * handling authentication, request formatting, and response parsing.
   *
   * @example
   * // In a Cloudflare Worker
   * const jules = new JulesSDK(env.JULES_API_KEY);
   * const sessions = await jules.listSessions();
   * console.log(sessions.sessions[0].name);
   */
  export class JulesSDK {
    private readonly apiKey: string;
    private readonly baseUrl: string = "https://jules.googleapis.com/v1alpha";
  
    /**
     * Creates a new instance of the JulesSDK.
     *
     * @param {string} apiKey Your Jules API Key. In a Cloudflare Worker,
     * this should come from `env.JULES_API_KEY`.
     * @throws {Error} If the API key is not provided (is null or empty).
     */
    constructor(apiKey: string) {
      if (!apiKey) {
        throw new Error(
          "Jules API key is required. It cannot be null or empty."
        );
      }
      this.apiKey = apiKey;
    }
  
    /**
     * Private helper method to execute authenticated API requests.
     * This method centralizes API key injection, Content-Type headers,
     * error handling, and JSON parsing.
     *
     * @template T The expected response type.
     * @param {string} endpoint The API endpoint (e.g., "/sources", "/sessions/123").
     * @param {RequestInit} [options={}] Standard `fetch` options (method, body, etc.).
     * @returns {Promise<T>} A promise that resolves to the parsed JSON response.
     * @throws {Error} If the network request fails or the API returns a non-OK status.
     * @private
     */
    private async request<T>(
      endpoint: string,
      options: RequestInit = {}
    ): Promise<T> {
      const url = `${this.baseUrl}${endpoint}`;
  
      const headers = new Headers(options.headers || {});
      headers.set("X-Goog-Api-Key", this.apiKey);
  
      // Set Content-Type only if a body is present
      if (options.body) {
        headers.set("Content-Type", "application/json");
      }
  
      const config: RequestInit = {
        ...options,
        headers: headers,
      };
  
      const response = await fetch(url, config);
  
      if (!response.ok) {
        // Try to get a meaningful error message from the API
        let errorBody = "No error details provided.";
        try {
          errorBody = await response.text();
        } catch (e) {}
        throw new Error(
          `Jules API Error (${response.status} ${response.statusText}) for ${
            options.method || "GET"
          } ${url}: ${errorBody}`
        );
      }
  
      // Handle empty responses (e.g., from POST actions like approvePlan)
      const text = await response.text();
      if (!text) {
        return {} as T;
      }
  
      // Parse the JSON response
      try {
        return JSON.parse(text) as T;
      } catch (e) {
        console.error("Failed to parse JSON response:", text);
        throw new Error(
          `Failed to parse API JSON response: ${e instanceof Error ? e.message : "Unknown error"}`
        );
      }
    }
    // --- 1. Source Methods ---
  
    /**
     * Lists all available sources (e.g., connected GitHub repos).
     * @see {@link https://developers.google.com/jules/api/reference/rest/v1alpha/sources/list}
     * @returns {Promise<ListSourcesResponse>} A paginated list of sources.
     * @example
     * const { sources } = await jules.listSources();
     * for (const source of sources) {
     * console.log(source.name); // "sources/github/user/repo"
     * }
     */
    async listSources(): Promise<ListSourcesResponse> {
      return this.request<ListSourcesResponse>("/sources");
    }
  
    /**
     * Gets a single source by its full resource name.
     * @see {@link https://developers.google.com/jules/api/reference/rest/v1alpha/sources/get}
     * @param {string} name The full resource name of the source.
     * This value comes from the `name` field of a Source object.
     * @example "sources/github/bobalover/boba"
     * @returns {Promise<Source>} The requested Source object.
     * @throws {Error} If the source is not found (404) or on API error.
     */
    async getSource(name: string): Promise<Source> {
      if (!name.startsWith("sources/")) {
        console.warn(
          `getSource: 'name' should be a full resource name (e.g., "sources/..."). Received: ${name}`
        );
      }
      return this.request<Source>(`/${name}`);
    }
  
    // --- 2. Session Methods ---
  
    /**
     * Creates a new session.
     * This initiates a new unit of work with the Jules agent.
     * @see {@link https://developers.google.com/jules/api/reference/rest/v1alpha/sessions/create}
     * @param {CreateSessionPayload} payload The configuration for the new session.
     * @returns {Promise<Session>} The newly created Session object.
     * @throws {Error} If the payload is invalid (400) or on API error.
     * @example
     * const newSession = await jules.createSession({
     * prompt: "Create a boba app!",
     * sourceContext: {
     * source: "sources/github/bobalover/boba",
     * githubRepoContext: {
     * startingBranch: "main"
     * }
     * },
     * automationMode: AutomationMode.AUTO_CREATE_PR
     * });
     * console.log(newSession.name); // "sessions/12345..."
     */
    async createSession(payload: CreateSessionPayload): Promise<Session> {
      return this.request<Session>("/sessions", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
  
    /**
     * Lists all sessions.
     * @see {@link https://developers.google.com/jules/api/reference/rest/v1alpha/sessions/list}
     * @param {ListSessionsParams} [params={}] Optional query parameters for pagination.
     * @returns {Promise<ListSessionsResponse>} A paginated list of sessions.
     * @example
     * const { sessions } = await jules.listSessions({ pageSize: 5 });
     * console.log(`Found ${sessions.length} sessions.`);
     */
    async listSessions(
      params: ListSessionsParams = {}
    ): Promise<ListSessionsResponse> {
      const query = new URLSearchParams();
      if (params.pageSize) query.set("pageSize", params.pageSize.toString());
      if (params.pageToken) query.set("pageToken", params.pageToken);
  
      const queryString = query.toString();
      return this.request<ListSessionsResponse>(
        `/sessions${queryString ? "?" + queryString : ""}`
      );
    }
  
    /**
     * Gets a single session by its full resource name.
     * Useful for polling the status of a session.
     * @see {@link https://developers.google.com/jules/api/reference/rest/v1alpha/sessions/get}
     * @param {string} name The full resource name of the session.
     * This value comes from the `name` field of a Session object.
     * @example "sessions/31415926535897932384"
     * @returns {Promise<Session>} The requested Session object.
     * @throws {Error} If the session is not found (404) or on API error.
     */
    async getSession(name: string): Promise<Session> {
      if (!name.startsWith("sessions/")) {
        console.warn(
          `getSession: 'name' should be a full resource name (e.g., "sessions/..."). Received: ${name}`
        );
      }
      return this.request<Session>(`/${name}`);
    }
  
    /**
     * Approves a plan for a session.
     * This is required if the session was created with `requirePlanApproval: true`
     * and is in the `AWAITING_PLAN_APPROVAL` state.
     *
     * @see {@link https://developers.google.com/jules/api/reference/rest/v1alpha/sessions/approvePlan}
     * @param {string} sessionName The full resource name of the session.
     * @example "sessions/31415926535897932384"
     * @returns {Promise<{}>} An empty object. The API returns an empty response body on success.
     * @throws {Error} If the session is not found or not in a state that can be approved.
     */
    async approvePlan(sessionName: string): Promise<{}> {
      if (!sessionName.startsWith("sessions/")) {
        throw new Error("Invalid sessionName. Must be in format 'sessions/ID'.");
      }
      return this.request<{}>(`/${sessionName}:approvePlan`, {
        method: "POST",
        body: JSON.stringify({}), // API requires an empty JSON body
      });
    }
  
    /**
     * Sends a message from the user to a session.
     * This is used to provide feedback or additional instructions to the agent
     * while a session is in progress (e.g., in state `AWAITING_USER_FEEDBACK`).
     *
     * @see {@link https://developers.google.com/jules/api/reference/rest/v1alpha/sessions/sendMessage}
     * @param {string} sessionName The full resource name of the session.
     * @param {SendMessagePayload} payload The message prompt to send.
     * @example
     * // sessionName = "sessions/31415926535897932384"
     * await jules.sendMessage(sessionName, {
     * prompt: "Can you make the app corgi themed?"
     * });
     * @returns {Promise<{}>} An empty object. The agent's response will come as a new Activity.
     * @throws {Error} If the session is not found or not in a state to receive messages.
     */
    async sendMessage(
      sessionName: string,
      payload: SendMessagePayload
    ): Promise<{}> {
      if (!sessionName.startsWith("sessions/")) {
        throw new Error("Invalid sessionName. Must be in format 'sessions/ID'.");
      }
      return this.request<{}>(`/${sessionName}:sendMessage`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
  
    // --- 3. Activity Methods ---
  
    /**
     * Lists activities for a specific session, in reverse chronological order.
     * This is the primary way to see the history and progress of a session.
     * @see {@link https://developers.google.com/jules/api/reference/rest/v1alpha/sessions.activities/list}
     * @param {string} parentSessionName The full resource name of the parent session.
     * @param {ListActivitiesParams} [params={}] Optional query parameters for pagination.
     * @example
     * // parentSessionName = "sessions/31415926535897932384"
     * const { activities } = await jules.listActivities(parentSessionName, { pageSize: 10 });
     * console.log(activities[0].name); // "sessions/123/activities/abc"
     * @returns {Promise<ListActivitiesResponse>} A paginated list of activities.
     * @throws {Error} If the parent session is not found.
     */
    async listActivities(
      parentSessionName: string,
      params: ListActivitiesParams = {}
    ): Promise<ListActivitiesResponse> {
      if (!parentSessionName.startsWith("sessions/")) {
        throw new Error(
          "Invalid parentSessionName. Must be in format 'sessions/ID'."
        );
      }
      const query = new URLSearchParams();
      if (params.pageSize) query.set("pageSize", params.pageSize.toString());
      if (params.pageToken) query.set("pageToken", params.pageToken);
  
      const queryString = query.toString();
      return this.request<ListActivitiesResponse>(
        `/${parentSessionName}/activities${queryString ? "?" + queryString : ""}`
      );
    }
  
    /**
     * Gets a single activity by its full resource name.
     * @see {@link https://developers.google.com/jules/api/reference/rest/v1alpha/sessions.activities/get}
     * @param {string} name The full resource name of the activity.
     * This value comes from the `name` field of an Activity object.
     * @example "sessions/14550388554331055113/activities/02200cce44f746308651037e4a18caed"
     * @returns {Promise<Activity>} The requested Activity object.
     * @throws {Error} If the activity is not found.
     */
    async getActivity(name: string): Promise<Activity> {
      if (!name.includes("/activities/")) {
        console.warn(
          `getActivity: 'name' should be a full resource name (e.g., "sessions/ID/activities/ID"). Received: ${name}`
        );
      }
      return this.request<Activity>(`/${name}`);
    }
  }