import requests
import json
import os
import sys
import time
import argparse
import dev_server
import shared_config

# Configuration
def load_env_vars():
    """Load env vars from .dev.vars"""
    env_vars = {}
    try:
        with open(".dev.vars", "r") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, value = line.split("=", 1)
                    value = value.strip("'").strip('"')
                    env_vars[key] = value
    except FileNotFoundError:
        pass
    return env_vars

def load_wrangler_vars():
    """Load vars section from wrangler.toml"""
    wrangler_vars = {}
    try:
        with open("wrangler.toml", "r") as f:
            in_vars = False
            for line in f:
                line = line.strip()
                if line == "[vars]":
                    in_vars = True
                    continue
                elif line.startswith("[") and in_vars:
                    break
                
                if in_vars and "=" in line:
                    key, value = line.split("=", 1)
                    key = key.strip()
                    value = value.strip().strip("'").strip('"')
                    wrangler_vars[key] = value
    except FileNotFoundError:
        pass
    return wrangler_vars

# Load config
DEV_VARS = load_env_vars()
WRANGLER_VARS = load_wrangler_vars()

EXAMPLES_DIR = "examples"

def print_separator():
    print("-" * 60)

def load_example(filename):
    filepath = os.path.join(EXAMPLES_DIR, filename)
    if not os.path.exists(filepath):
        print(f"Error: File not found: {filepath}")
        sys.exit(1)
    with open(filepath, "r") as f:
        return json.load(f)

def test_endpoint(base_url, method, endpoint, payload=None, description="", stream=True, allow_large_output=False):
    # Add stream parameter to URL if it's a POST request (where our API supports it)
    if stream and method == "POST":
        separator = "&" if "?" in endpoint else "?"
        url = f"{base_url}{endpoint}{separator}stream=true"
    else:
        url = f"{base_url}{endpoint}"

    print_separator()
    print(f"Testing: {description}")
    print(f"URL: {method} {url}")
    print(f"Mode: {'Streaming' if stream and method == 'POST' else 'Standard JSON'}")
    
    try:
        start_time = time.time()
        
        headers = {}
        api_key = DEV_VARS.get("WORKER_API_KEY", WRANGLER_VARS.get("WORKER_API_KEY"))
        if api_key and api_key != "(hidden)":
             headers["x-api-key"] = api_key

        if method == "GET":
            response = requests.get(url, headers=headers)
        elif method == "POST":
            response = requests.post(url, json=payload, headers=headers, stream=stream and method == "POST")
        else:
            print(f"Unsupported method: {method}")
            return None

        print(f"Status Code: {response.status_code}")
        
        if stream and method == "POST":
            print("--- Streaming Output ---")
            content_buffer = []
            for line in response.iter_lines():
                if line:
                    decoded_line = line.decode('utf-8')
                    print(decoded_line)
                    content_buffer.append(decoded_line)
            
            duration = time.time() - start_time
            print(f"\nTime: {duration:.2f}s")
            return content_buffer
        else:
            duration = time.time() - start_time
            print(f"Time: {duration:.2f}s")
            try:
                data = response.json()
                
                # Helper to recursively parse JSON strings
                def recursive_json_parse(obj):
                    if isinstance(obj, dict):
                        for k, v in obj.items():
                            obj[k] = recursive_json_parse(v)
                    elif isinstance(obj, list):
                        for i in range(len(obj)):
                            obj[i] = recursive_json_parse(obj[i])
                    elif isinstance(obj, str):
                        try:
                            # Try to parse string as JSON
                            # We only want to parse objects/lists, not simple strings like "success"
                            if (obj.strip().startswith('{') and obj.strip().endswith('}')) or \
                               (obj.strip().startswith('[') and obj.strip().endswith(']')):
                                parsed = json.loads(obj)
                                return recursive_json_parse(parsed)
                        except (json.JSONDecodeError, TypeError):
                            pass
                    return obj

                # Clean up data for display
                display_data = recursive_json_parse(data.copy() if isinstance(data, dict) else data)

                # Print first few lines of JSON to avoid spamming
                json_str = json.dumps(display_data, indent=2)
                lines = json_str.split("\n")
                if len(lines) > 50 and not allow_large_output: # Allow more lines for health check or if requested
                    print("\nResponse Preview:")
                    print("\n".join(lines[:50]))
                    print(f"... ({len(lines) - 50} more lines) ...")
                else:
                    print("\nResponse:")
                    print(json_str)
                return data
            except ValueError:
                print("\nResponse (Text):")
                print(response.text[:500])
                return response.text

    except requests.exceptions.ConnectionError:
        print(f"\nError: Could not connect to {base_url}")
        print("Make sure the worker is running (e.g., 'npm start' or 'wrangler dev')")
        return None
    except Exception as e:
        print(f"\nError: {str(e)}")
        return None

def main():
    parser = argparse.ArgumentParser(description="Test API endpoints.")
    parser.add_argument("--local", action="store_true", help="Start local dev server if not running")
    parser.add_argument("--port", type=int, default=None, help="Port for local dev server (default: from wrangler.jsonc)")
    parser.add_argument("--health", action="store_true", help="Run only health checks")
    args = parser.parse_args()

    # Determine Port
    target_port = args.port if args.port is not None else shared_config.get_wrangler_port()

    # Determine Worker URL
    default_url = f"http://localhost:{target_port}"
    base_url = os.getenv("WORKER_URL", 
        DEV_VARS.get("WORKER_URL", 
        WRANGLER_VARS.get("WORKER_URL", default_url)))

    # Override if local flag is set or connection fails
    try:
        # User requested: "always supposed to ... start dev"
        # We try to ensure local server is running by default
        base_url = dev_server.ensure_local_server(target_port)
    except Exception as e:
        print(f"❌ Failed to start local server: {e}")
        sys.exit(1)

    print(f"Starting API Tests against {base_url}")
    
    # 0. Health Check (Root) - Latest + Instructions
    test_endpoint(base_url, "GET", "/api/health", description="Get Health Root (Latest + Instructions)", stream=False, allow_large_output=True)

    # 1. Health Check (Latest) - GET doesn't stream
    test_endpoint(base_url, "GET", "/api/health/latest", description="Get Latest Health Check (Raw)", stream=False, allow_large_output=args.health)

    # 2. Run Health Check (Manual) - Supports streaming
    if args.health:
        print("\nSkipping other tests (Health check only requested).")
        test_endpoint(base_url, "POST", "/api/health/run", description="Run Manual Health Check", allow_large_output=True)
        return

    # 2. Run Health Check (Manual) - Supports streaming
    test_endpoint(base_url, "POST", "/api/health/run", description="Run Manual Health Check")

    # 3. Simple Questions
    simple_payload = load_example("simple-questions.json")
    test_endpoint(base_url, "POST", "/api/questions/simple", payload=simple_payload, description="Simple Questions (Default/Worker AI)")

    # 3b. Simple Questions (Gemini)
    print("\nAdding Gemini Test Case...")
    gemini_payload = {
        "questions": ["What is Cloudflare Workers AI?"],
        "use_gemini": True
    }
    test_endpoint(base_url, "POST", "/api/questions/simple", payload=gemini_payload, description="Simple Question (Google Gemini)")

    # 4. Detailed Questions
    detailed_payload = load_example("detailed-questions.json")
    test_endpoint(base_url, "POST", "/api/questions/detailed", payload=detailed_payload, description="Detailed Questions")

    # 5. Auto Analyze
    auto_analyze_payload = load_example("auto-analyze.json")
    test_endpoint(base_url, "POST", "/api/questions/auto-analyze", payload=auto_analyze_payload, description="Auto Analyze Repository")

    # 6. List Sessions
    sessions_data = test_endpoint(base_url, "GET", "/api/sessions", description="List Sessions", stream=False)

    # 7. Get Session Details
    if sessions_data and "sessions" in sessions_data and len(sessions_data["sessions"]) > 0:
        session_id = sessions_data["sessions"][0]["sessionId"]
        test_endpoint(base_url, "GET", f"/api/sessions/{session_id}", description=f"Get Session Details ({session_id})", stream=False)
    else:
        print_separator()
        print("Skipping Session Details test (no sessions found)")

    print_separator()
    print("Tests Completed.")

if __name__ == "__main__":
    main()
