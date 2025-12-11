import { spawn } from "child_process";

async function runTests() {
  console.log("🚀 Starting Local MCP Connectivity Test...");
  console.log("   Target: Local Worker or Production?");
  console.log("   (Defaulting to expecting a running local worker at http://localhost:8787)");

  const API_URL = process.env.WORKER_URL || "http://localhost:8787";

  try {
    // 1. Test Health Endpoint (Manual Run)
    console.log(`\n1. Testing Health Check Endpoint (${API_URL}/api/health/run)...`);
    const healthRes = await fetch(`${API_URL}/api/health/run`, {
      method: "POST"
    });
    
    if (!healthRes.ok) {
      throw new Error(`Health check failed with status ${healthRes.status}`);
    }

    const healthData = await healthRes.json() as any;
    console.log("   Result:", JSON.stringify(healthData, null, 2));

    if (healthData.success) {
      console.log("   ✅ Health Check PASSED");
    } else {
      console.log("   ❌ Health Check FAILED");
      process.exit(1);
    }

    // 2. Test Simple Question (End-to-End)
    console.log(`\n2. Testing Simple Question Flow...`);
    const qRes = await fetch(`${API_URL}/api/questions/simple`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        questions: ["What are Cloudflare Durable Objects?"]
      })
    });

    if (!qRes.ok) {
      throw new Error(`Question query failed with status ${qRes.status}`);
    }

    const qData = await qRes.json() as any;
    console.log("   ✅ Response Received");
    console.log(`   - Answer Preview: ${qData.results[0].ai_analysis?.substring(0, 100)}...`);

  } catch (error) {
    console.error("\n💥 Test Failed:", error);
    process.exit(1);
  }
}

runTests();

