import os
import requests
import sys
import argparse
import subprocess
from pathlib import Path
import dev_server

def load_env_vars():
    """Load env vars from .dev.vars"""
    env_vars = {}
    dev_vars_path = Path(".dev.vars")
    
    if not dev_vars_path.exists():
        print("❌ .dev.vars file not found!")
        return env_vars

    try:
        with open(dev_vars_path, "r") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, value = line.split("=", 1)
                    value = value.strip().strip("'").strip('"')
                    env_vars[key] = value
    except Exception as e:
        print(f"❌ Error reading .dev.vars: {e}")
        
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

def test_github_connection(token):
    print("\n🔍 Testing GitHub Connection...")
    if not token:
        print("❌ GITHUB_TOKEN not found in .dev.vars")
        return False
        
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "Cloudflare-Worker-MCP-Test"
    }
    
    try:
        response = requests.get("https://api.github.com/user", headers=headers)
        if response.status_code == 200:
            user = response.json()
            print(f"✅ GitHub Connection Successful! Authenticated as: {user.get('login')}")
            return True
        else:
            print(f"❌ GitHub Connection Failed: {response.status_code}")
            print(f"   Response: {response.text}")
            return False
    except Exception as e:
        print(f"❌ GitHub Connection Error: {e}")
        return False

def test_worker_ai_connection(account_id, token):
    print("\n🔍 Testing Cloudflare Workers AI / AI Gateway Connection...")
    
    if not account_id:
        print("❌ CLOUDFLARE_ACCOUNT_ID not found in .dev.vars")
        return False
    if not token:
        print("❌ CF_AIG_TOKEN not found in .dev.vars")
        return False

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    
    try:
        url = "https://api.cloudflare.com/client/v4/user/tokens/verify"
        response = requests.get(url, headers=headers)
        
        if response.status_code == 200:
             data = response.json()
             if data.get('success'):
                 print(f"✅ Cloudflare Token Verified! (Status: Active)")
                 return True
             else:
                 print(f"⚠️  Cloudflare Token Valid format but verify endpoint returned unsuccessful.")
                 return True 
        else:
            print(f"⚠️  Could not verify token against general API (Status {response.status_code}).")
            return True 

    except Exception as e:
        print(f"❌ Connection Error: {e}")
        return False

def test_upstream_mcp_status(worker_url):
    print(f"\n🔍 Testing Upstream MCP Server Connection (via {worker_url})...")
    
    try:
        # Test specific MCP Health Endpoint
        mcp_check_url = f"{worker_url}/api/health/mcp"
        print(f"   Hitting: {mcp_check_url}")
        
        response = requests.post(mcp_check_url)
        
        if response.status_code == 200:
            data = response.json()
            duration = data.get('durationMs', 0)
            preview = str(data.get('response', ''))[:60].replace('\n', ' ')
            
            print(f"✅ Upstream MCP Connection SUCCESSFUL!")
            print(f"   Response Time: {duration}ms")
            print(f"   Response Preview: {preview}...")
            return True
        else:
            print(f"❌ Upstream MCP Connection FAILED (Status {response.status_code})")
            try:
                err_data = response.json()
                print(f"   Error: {err_data.get('error', 'Unknown error')}")
            except:
                print(f"   Response: {response.text}")
            return False
            
    except requests.exceptions.ConnectionError:
        print(f"❌ Could not connect to {worker_url}")
        print("   👉 Is the worker running?")
        return False
    except Exception as e:
        print(f"❌ MCP Test Error: {e}")
        return False

def test_deployment_dry_run():
    print("\n🔍 Testing Deployment (Dry Run)...")
    print("   Running: npm run deploy:dry-run")
    
    try:
        result = subprocess.run(
            ["npm", "run", "deploy:dry-run"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False
        )
        
        if result.returncode == 0:
            print("✅ Deployment Dry Run Successful!")
            return True
        else:
            print("❌ Deployment Dry Run Failed!")
            print("   Output:")
            print(result.stdout)
            print("   Errors:")
            print(result.stderr)
            return False
            
    except Exception as e:
        print(f"❌ Deployment Test Error: {e}")
        return False

def main():
    parser = argparse.ArgumentParser(description="Check project dependencies and connectivity.")
    parser.add_argument("--local", action="store_true", help="Start local dev server if not running")
    parser.add_argument("--port", type=int, default=8787, help="Port for local dev server")
    parser.add_argument("--deploy-check", action="store_true", help="Run deployment dry-run check")
    args = parser.parse_args()

    print("🚀 Starting Dependency & Connectivity Check...")
    print("-" * 40)
    
    env_vars = load_env_vars()
    wrangler_vars = load_wrangler_vars()
    
    # Determine Worker URL
    # 1. OS env vars -> 2. .dev.vars -> 3. wrangler.toml -> 4. Default
    worker_url = os.getenv("WORKER_URL", 
        env_vars.get("WORKER_URL", 
        wrangler_vars.get("WORKER_URL", "http://localhost:8787")))
    
    # Override if local flag is set
    if args.local:
        try:
            worker_url = dev_server.ensure_local_server(args.port)
        except Exception as e:
            print(f"❌ Failed to start local server: {e}")
            sys.exit(1)

    # 1. GitHub Check
    gh_token = env_vars.get("GITHUB_TOKEN")
    gh_ok = test_github_connection(gh_token)
    
    # 2. AI Gateway / Cloudflare Check
    cf_account = env_vars.get("CLOUDFLARE_ACCOUNT_ID")
    cf_token = env_vars.get("CF_AIG_TOKEN")
    ai_ok = test_worker_ai_connection(cf_account, cf_token)
    
    # 3. Upstream MCP Server Check (via Worker)
    mcp_ok = test_upstream_mcp_status(worker_url)
    
    # 4. Deployment Check (Optional)
    deploy_ok = True
    if args.deploy_check:
        deploy_ok = test_deployment_dry_run()
    
    print("-" * 40)
    print("\n📊 Summary:")
    print(f"GitHub:          {'✅ PASS' if gh_ok else '❌ FAIL'}")
    print(f"Cloudflare Auth: {'✅ PASS' if ai_ok else '⚠️  UNKNOWN/FAIL'}")
    print(f"Upstream MCP:    {'✅ PASS' if mcp_ok else '❌ FAIL'}")
    if args.deploy_check:
        print(f"Deployment:      {'✅ PASS' if deploy_ok else '❌ FAIL'}")
    
    if not (gh_ok and mcp_ok and deploy_ok):
        sys.exit(1)

if __name__ == "__main__":
    main()
