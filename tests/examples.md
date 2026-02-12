# Multi-Protocol Worker API Usage Examples

This document provides examples of how to interact with the various protocols exposed by the worker.

## Prerequisites

1.  Start the worker in development mode:
    ```bash
    npx wrangler dev
    ```
2.  Set the base URL for the examples. The default is `http://localhost:8787`.
    ```bash
    export BASE="http://localhost:8787"
    ```

---

## 1. REST API

The REST API is available under the `/api` path.

### Create a Task

```bash
curl -sX POST "$BASE/api/tasks" \
  -H 'Content-Type: application/json' \
  -d '{"title": "My first task from REST"}' | jq
```

### List Tasks

```bash
curl -s "$BASE/api/tasks" | jq
```

### Run Analysis

```bash
# First, create a task to get a valid UUID
TASK_ID=$(curl -sX POST "$BASE/api/tasks" -H 'content-type: application/json' -d '{"title":"analyze me"}' | jq -r .task.id)

# Then, run analysis on it
curl -sX POST "$BASE/api/analyze" \
  -H 'Content-Type: application/json' \
  -d '{"taskId": "'"$TASK_ID"'", "depth": 3}' | jq
```

---

## 2. WebSocket API

The WebSocket API is available at `/ws`. You can connect to a specific room using the `projectId` query parameter.

### Browser Console Example

Open your browser's developer console on any page and run the following code:

```javascript
const ws = new WebSocket('ws://localhost:8787/ws?projectId=my-project');

ws.onopen = () => {
  console.log('WebSocket connection established.');
  ws.send(JSON.stringify({ type: 'greeting', payload: 'Hello from the browser!' }));
};

ws.onmessage = (event) => {
  console.log('Received message:', JSON.parse(event.data));
};

ws.onclose = () => {
  console.log('WebSocket connection closed.');
};

ws.onerror = (error) => {
  console.error('WebSocket error:', error);
};

// To send a message after connection:
// ws.send('{"type": "chat", "message": "This is a test"}');
```

### Node.js Example (using `ws` package)

```bash
# First, install the ws package if you don't have it
npm install -g ws

# Then, run the client from your terminal
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8787/ws?projectId=my-project');

ws.on('open', () => {
  console.log('Connected');
  ws.send('Hello from Node.js');
});

ws.on('message', (data) => {
  console.log('Received: %s', data);
});
"
```

---

## 3. RPC (via HTTP)

The `/rpc` endpoint provides a direct way to call the backend functions.

### Create a Task via RPC

```bash
curl -sX POST "$BASE/rpc" \
  -H 'Content-Type: application/json' \
  -d '{"method": "createTask", "params": {"title": "My first task from RPC"}}' | jq
```

### List Tasks via RPC

```bash
curl -sX POST "$BASE/rpc" \
  -H 'Content-Type: application/json' \
  -d '{"method": "listTasks", "params": {}}' | jq
```

---

## 4. MCP (Model Context Protocol)

The MCP endpoints are under `/mcp`.

### List Available Tools

This endpoint returns the list of tools that an MCP agent can use.

```bash
curl -s "$BASE/mcp/tools" | jq
```

### Execute a Tool

This endpoint executes a specific tool with the given parameters.

```bash
# Execute the 'createTask' tool
curl -sX POST "$BASE/mcp/execute" \
  -H 'Content-Type: application/json' \
  -d '{"tool": "createTask", "params": {"title": "A task from MCP"}}' | jq

# Execute the 'runAnalysis' tool by first creating a task
TASK_ID=$(curl -sX POST "$BASE/api/tasks" -H 'Content-Type: application/json' -d '{"title": "Task for MCP analysis"}' | jq -r .task.id)
curl -sX POST "$BASE/mcp/execute" \
  -H 'Content-Type: application/json' \
  -d '{"tool": "runAnalysis", "params": {"taskId": "'"$TASK_ID"'", "depth": 1}}' | jq
```

---

## 5. OpenAPI Specification

You can access the dynamically generated OpenAPI 3.1.0 specification.

### Get JSON Specification

```bash
curl -s "$BASE/openapi.json" | jq
```

### Get YAML Specification

```bash
curl -s "$BASE/openapi.yaml"
```
