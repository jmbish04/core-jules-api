import requests
import json
import time
import sys
import os
import argparse
import subprocess
import socket
import re

# Get absolute path to ask-cloudflare-mcp root


import shared_config

# --- HELPER FUNCTIONS ---
def print_header(title):
    print(f"\n{'-'*60}")
    print(f"🔹 {title}")
    print(f"{'-'*60}")

# Re-use shared prints to avoid duplication/confusion, but keeping local style overrides if needed
# Actually, let's just use local wrappers calling shared or keep independent if simple
def print_success(msg):
    shared_config.print_success(msg)

def print_fail(msg):
    shared_config.print_fail(msg)

def print_info(msg):
    shared_config.print_info(msg)

def kill_port(port):
    """Kills any process listening on the specified port."""
    print_info(f"Checking for processes on port {port}...")
    try:
        # Find PID using lsof
        cmd = ["lsof", "-t", "-i", f":{port}"]
        result = subprocess.run(cmd, capture_output=True, text=True)
        pids = result.stdout.strip().split('\n')
        
        if any(pids) and pids[0]:
            for pid in pids:
                if pid:
                    print_info(f"Killing process {pid} on port {port}...")
                    subprocess.run(["kill", "-9", pid], check=True)
            print_success(f"Port {port} cleared.")
        else:
            print_info(f"Port {port} is already free.")
    except Exception as e:
        print_fail(f"Error clearing port {port}: {e}")

def wait_for_server(url, timeout=30):
    """Waits for the server to become responsive."""
    print_info(f"Waiting for server at {url}...")
    start_time = time.time()
    while time.time() - start_time < timeout:
        try:
            requests.get(url, timeout=1)
            print_success("Server is up!")
            return True
        except requests.exceptions.RequestException:
            time.sleep(1)
            print(".", end="", flush=True)
    print("")
    print_fail("Server timeout.")
    return False

def check_response(response, expected_status=200):
    if response.status_code == expected_status:
        try:
            return response.json()
        except ValueError:
            return response.text
    else:
        print_fail(f"Status: {response.status_code}")
        print_fail(f"Response: {response.text}")
        return None

# --- CONFIGURATION HELPERS ---
def load_env_file(filepath):
    """Simple .env loader to avoid dependencies"""
    config = {}
    if os.path.exists(filepath):
        print_info(f"Loading config from {filepath}")
        with open(filepath, 'r') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, value = line.split('=', 1)
                    config[key.strip()] = value.strip()
    return config

# --- LOAD CONFIGURATION NOW ---
ENV_CONFIG = load_env_file(os.path.join(shared_config.SCRIPT_DIR, ".env.test"))
LOCAL_PORT = shared_config.get_wrangler_port()
LOCAL_URL = f"http://localhost:{LOCAL_PORT}"
PROJECT_ROOT = shared_config.PROJECT_ROOT # Ensure consistency


def get_deployed_url():
    """Fetches the deployed worker URL."""
    print_info("Fetching deployed URL...")
    # Check Env First
    url = os.getenv("WORKER_URL")
    if url: 
        return url
        
    # Check .env.test specific logic
    if "WORKER_URL" in ENV_CONFIG:
        return ENV_CONFIG["WORKER_URL"]
        
    default_url = "https://ask-cloudflare-mcp.hacolby.workers.dev"
    print_info(f"Using default known URL: {default_url}")
    return default_url




# --- TEST SUITE ---
def run_tests(base_url, headers):
    print_header(f"🚀 Starting Tests against {base_url}")

    # 1. Health Check
    print_header("Deep System Diagnostics")
    print_info("Triggering Deep Health Check (/api/health/run)...")
    try:
        start = time.time()
        res = requests.post(f"{base_url}/api/health/run", headers=headers)
        data = check_response(res)
        duration = time.time() - start
        
        if data:
            print_success(f"Health Check completed in {duration:.2f}s")
            success = data.get("success", False)
            if success:
                print_success("Overall Status: HEALTHY")
            else:
                print_fail("Overall Status: UNHEALTHY") 
                if "error" in data:
                     print_fail(f"Error: {data['error']}")
            
            if "steps" in data:
                print("\nStep Results:")
                for step in data["steps"]:
                    status_icon = "✅" if step["status"] == "success" else "❌"
                    print(f"  {status_icon} [{step['name']}] {step['message']}")
    except Exception as e:
        print_fail(f"Health check execution failed: {e}")

    # 2. Research Workflow
    print_header("Deep Research Workflow")
    payload = {
        "query": "How do I use Cloudflare Vectorize depending on python?",
        "mode": "feasibility"
    }
    print_info(f"Dispatching Research Task: {payload['query']}")
    try:
        res = requests.post(f"{base_url}/api/research", json=payload, headers=headers)
        data = check_response(res)
        
        if data and "sessionId" in data:
            session_id = data["sessionId"]
            print_success(f"Task Queued! Session ID: {session_id}")
            
            print_info("Polling for status (Timeout: 45s)...")
            start_poll = time.time()
            finished = False
            while time.time() - start_poll < 45:
                res = requests.get(f"{base_url}/api/research/{session_id}", headers=headers)
                status_data = check_response(res)
                
                if status_data:
                    status = status_data.get("status", "unknown")
                    print(f"  ... Status: {status}")
                    if status == "completed":
                        print_success("Research Completed!")
                        finished = True
                        break
                    elif status == "failed":
                        print_fail("Research Failed.")
                        finished = True
                        break
                time.sleep(2)
            if not finished:
                print_fail("Polling timed out.")
        else:
            print_fail("Failed to dispatch research task.")
    except Exception as e:
        print_fail(f"Research workflow test failed: {e}")

    # 3. Engineer Agent
    print_header("Active Engineering Agent")
    payload = {
        "sessionId": "test-session-local",
        "repoUrl": "https://github.com/example/repo",
        "filePath": "src/index.ts",
        "instruction": "Fix the typo",
        "currentCode": "console.log('helo world');"
    }
    print_info("Dispatching Engineering Fix...")
    try:
        res = requests.post(f"{base_url}/api/engineer/fix", json=payload, headers=headers)
        data = check_response(res)
        if data and data.get("status") == "queued":
            print_success(f"Engineer Agent Dispatched. Workflow ID: {data.get('id')}")
        else:
            print_fail("Failed to dispatch Engineer Agent.")
    except Exception as e:
        print_fail(f"Engineer agent test failed: {e}")

    # 4. Governance Sync
    print_header("Governance Workflow")
    print_info("Dispatching Documentation Sync...")
    try:
        res = requests.post(f"{base_url}/api/governance/sync", json={"repoUrl": "https://github.com/example/repo"}, headers=headers)
        data = check_response(res)
        if data and data.get("status") == "queued":
            print_success(f"Governance Sync Dispatched. Workflow ID: {data.get('id')}")
        else:
             print_fail("Failed to dispatch Governance Sync.")
    except Exception as e:
        print_fail(f"Governance sync test failed: {e}")


def main():
    parser = argparse.ArgumentParser(description="Comprehensive API Tester for Cloudflare Workers")
    parser.add_argument("--env", choices=["local", "deployed"], default="local", help="Target environment")
    parser.add_argument("--url", help="Override target URL")
    args = parser.parse_args()

    base_url = ""
    dev_process = None

    try:
        if args.env == "local":
            # 1. Kill Port
            kill_port(LOCAL_PORT)
            
            # 2. Start Dev Server
            print_info(f"Starting 'wrangler dev' on port {LOCAL_PORT}...")
            # We use bunx wrangler dev
            dev_process = subprocess.Popen(
                ["bunx", "wrangler", "dev"],
                cwd=PROJECT_ROOT,
                stdout=subprocess.DEVNULL, # Suppress stdout to keep test output clean
                stderr=subprocess.PIPE     # Keep stderr for debug if needed
            )
            
            if not wait_for_server(LOCAL_URL, timeout=60):
                print_fail("Could not start local server.")
                if dev_process.poll() is not None:
                    # Process exited
                    stdout, stderr = dev_process.communicate()
                    print_fail(f"Arguments: {dev_process.args}")
                    if stderr:
                         print_fail(f"STDERR:\n{stderr}")
                else:
                    # Start debug... kill it and read
                    dev_process.terminate()
                    stdout, stderr = dev_process.communicate()
                    if stderr:
                         print_fail(f"STDERR (Partial):\n{stderr}")
                sys.exit(1)
            
            base_url = LOCAL_URL
                
        else:
            # Deployed Mode
            base_url = args.url if args.url else get_deployed_url()
            if not base_url:
                print_fail("No deployed URL found. Provide one with --url")
                sys.exit(1)
            print_info(f"Targeting Deployed Environment: {base_url}")

        # Run the tests
        run_tests(base_url, {"Content-Type": "application/json"})

    except KeyboardInterrupt:
        print("\n⚠️  Interrupted.")
    finally:
        # Cleanup
        if dev_process:
            print_info("Stopping local dev server...")
            dev_process.terminate()
            dev_process.wait()
            kill_port(LOCAL_PORT) # Double check

if __name__ == "__main__":
    main()
