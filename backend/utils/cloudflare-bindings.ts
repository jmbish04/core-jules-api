// src/consts/cloudflare-bindings.ts

// Helper to format the base URL
const BASE_DOCS_URL = "https://developers.cloudflare.com";

/**
 * Generates the llms-txt.txt URL based on the Wrangler Key, using a slugified version.
 * This is based on the inferred pattern: BASE_DOCS_URL + /<slugified_key>/llms-txt.txt
 * Note: Some keys (like 'ai') may not have a specific llms.txt, but this constructs the probable path.
 */
function createLlmsTxtLink(key: string): string {
    const slug = key.replace(/_/g, '-');
    return `${BASE_DOCS_URL}/${slug}/llms-txt.txt`;
}

// Local interface to replace the external dependency
interface BindingDetail {
    wranglerKey: string;
    productName: string;
    apiBindingName: string;
    llmsTxtLink: string;
}

export const CLOUDFLARE_BINDING_MAP: Record<string, BindingDetail[]> = {
    'Data Storage & Databases': [
        {
            wranglerKey: 'd1_databases',
            productName: 'D1 SQL database',
            apiBindingName: 'D1Database',
            llmsTxtLink: createLlmsTxtLink('d1-databases'),
        },
        {
            wranglerKey: 'kv_namespaces',
            productName: 'Workers KV (Key-Value Store)',
            apiBindingName: 'KVNamespace',
            llmsTxtLink: createLlmsTxtLink('workers-kv'),
        },
        {
            wranglerKey: 'durable_objects',
            productName: 'Durable Objects (Stateful Compute)',
            apiBindingName: 'DurableObjectNamespace',
            llmsTxtLink: createLlmsTxtLink('durable-objects'),
        },
        {
            wranglerKey: 'r2_buckets',
            productName: 'R2 Object Storage',
            apiBindingName: 'R2Bucket',
            llmsTxtLink: createLlmsTxtLink('r2'),
        },
        {
            wranglerKey: 'vectorize',
            productName: 'Vectorize (Vector Database)',
            apiBindingName: 'VectorizeIndex',
            llmsTxtLink: createLlmsTxtLink('vectorize'),
        },
        {
            wranglerKey: 'hyperdrive',
            productName: 'Hyperdrive (External DB Connector)',
            apiBindingName: 'Hyperdrive',
            llmsTxtLink: createLlmsTxtLink('hyperdrive'),
        },
        {
            wranglerKey: 'analytics_engine',
            productName: 'Analytics Engine (Data Ingestion/Query)',
            apiBindingName: 'AnalyticsEngine',
            llmsTxtLink: createLlmsTxtLink('analytics-engine'),
        },
    ],
    'AI & Machine Learning': [
        {
            wranglerKey: 'ai',
            productName: 'Workers AI (LLM/ML Inference)',
            apiBindingName: 'AI',
            llmsTxtLink: createLlmsTxtLink('workers-ai'),
        },
        {
            wranglerKey: 'ai_search',
            productName: 'AI Search (AutoRAG) (Beta)',
            apiBindingName: 'AI',
            llmsTxtLink: createLlmsTxtLink('ai-search'),
        },
        {
            wranglerKey: 'ai_gateway',
            productName: 'AI Gateway',
            apiBindingName: 'N/A',
            llmsTxtLink: createLlmsTxtLink('ai-gateway'),
        },
    ],
    'Compute, Orchestration & Networking': [
        {
            wranglerKey: 'services',
            productName: 'Service Bindings (Worker-to-Worker RPC/HTTP)',
            apiBindingName: 'WorkerEntrypoint or Fetcher',
            llmsTxtLink: createLlmsTxtLink('service-bindings'),
        },
        {
            wranglerKey: 'queues',
            productName: 'Workers Queues (Message Queue)',
            apiBindingName: 'Queue<T>',
            llmsTxtLink: createLlmsTxtLink('queues'),
        },
        {
            wranglerKey: 'workflows',
            productName: 'Workers Workflows (Durable State)',
            apiBindingName: 'WorkflowClient',
            llmsTxtLink: createLlmsTxtLink('workflows'),
        },
        {
            wranglerKey: 'vpc_services',
            productName: 'Workers VPC (Private Networking)',
            apiBindingName: 'Socket',
            llmsTxtLink: createLlmsTxtLink('vpc'),
        },
        {
            wranglerKey: 'dispatch_namespaces',
            productName: 'Workers for Platforms (Dispatcher)',
            apiBindingName: 'Fetcher',
            llmsTxtLink: createLlmsTxtLink('workers-for-platforms'),
        },
        {
            wranglerKey: 'containers',
            productName: 'Containers (Beta)',
            apiBindingName: 'N/A',
            llmsTxtLink: createLlmsTxtLink('containers'),
        },
    ],
    'Configuration & Assets': [
        {
            wranglerKey: 'vars',
            productName: 'Environment Variables',
            apiBindingName: 'string | number',
            llmsTxtLink: createLlmsTxtLink('workers/configuration'),
        },
        {
            wranglerKey: 'secrets',
            productName: 'Secrets (Encrypted Environment Variables)',
            apiBindingName: 'string',
            llmsTxtLink: createLlmsTxtLink('workers/configuration'),
        },
        {
            wranglerKey: 'assets',
            productName: 'Workers/Pages Static Assets',
            apiBindingName: 'Fetcher',
            llmsTxtLink: createLlmsTxtLink('pages/platform'),
        },
        {
            wranglerKey: 'browser_rendering',
            productName: 'Browser Rendering (Headless Browser)',
            apiBindingName: 'N/A',
            llmsTxtLink: createLlmsTxtLink('browser-rendering'),
        },
    ],
    'Media & Edge Services': [
        {
            wranglerKey: 'images',
            productName: 'Images (Optimization & Resizing)',
            apiBindingName: 'N/A',
            llmsTxtLink: createLlmsTxtLink('images'),
        },
        {
            wranglerKey: 'stream',
            productName: 'Stream (Video Streaming)',
            apiBindingName: 'N/A',
            llmsTxtLink: createLlmsTxtLink('stream'),
        },
        {
            wranglerKey: 'realtime',
            productName: 'Realtime (WebSockets)',
            apiBindingName: 'WebSocket',
            llmsTxtLink: createLlmsTxtLink('workers/runtime-apis/websockets'),
        },
    ],
    'Observability & Platform': [
        {
            wranglerKey: 'observability',
            productName: 'Observability (Logging/Metrics)',
            apiBindingName: 'N/A',
            llmsTxtLink: createLlmsTxtLink('workers/observability'),
        },
        {
            wranglerKey: 'workers_pages',
            productName: 'Workers & Pages (Platform)',
            apiBindingName: 'N/A',
            llmsTxtLink: createLlmsTxtLink('workers-and-pages'),
        },
    ],
};