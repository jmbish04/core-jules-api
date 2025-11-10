import { unstable_dev } from "wrangler";
import type { Unstable_DevWorker } from "wrangler";

describe("Worker", () => {
  let worker: Unstable_DevWorker;

  beforeAll(async () => {
    worker = await unstable_dev("src/index.ts", {
      experimental: { disableExperimentalWarning: true },
    });
  });

  afterAll(async () => {
    await worker.stop();
  });

  it("should return 200 for GET /", async () => {
    const resp = await worker.fetch("/");
    expect(resp.status).toBe(200);
    const json: any = await resp.json();
    expect(json.ok).toBe(true);
  });

  it("should create a task", async () => {
    const resp = await worker.fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "test task" }),
    });
    expect(resp.status).toBe(200);
    const json: any = await resp.json();
    expect(json.success).toBe(true);
    expect(json.task.title).toBe("test task");
  });

  it("should list tasks", async () => {
    // First create a task
    const taskTitle = "another test task";
    const createResp = await worker.fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: taskTitle }),
    });
    const { task: createdTask } = await createResp.json() as any;

    const resp = await worker.fetch("/api/tasks");
    expect(resp.status).toBe(200);
    const json: any = await resp.json();
    expect(json.success).toBe(true);
    expect(json.tasks.some((t: any) => t.id === createdTask.id)).toBe(true);
  });
});
