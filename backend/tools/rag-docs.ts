// Tool to query the docs.mcp.cloudflare.com endpoint
export const queryCloudflareDocs = async (query: string) => {
    console.log(`[Docs Tool] Searching for: ${query}`);

    try {
        // Simulating the MCP Server interaction over HTTP
        // In a real scenario, you might use the Model Context Protocol SDK or a direct fetch
        const response = await fetch('https://docs.mcp.cloudflare.com/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query })
        });

        if (!response.ok) {
            // Fallback if MCP server is unreachable during dev
            return `Docs lookup failed for "${query}". Suggesting general debugging steps.`;
        }

        const data = await response.json() as { content: string };
        return data.content; // The relevant documentation snippet
    } catch (err) {
        return `Error connecting to Docs MCP: ${err}`;
    }
};