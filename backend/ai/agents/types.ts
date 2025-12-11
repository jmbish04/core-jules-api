
export interface AgentState {
    history: { role: string; content: string }[];
    // Base state can be extended
}
