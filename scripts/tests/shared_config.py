import os
import json
import re

# Resolve Project Roots
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
# Go up two levels: scripts/tests/ -> scripts/ -> project root
PROJECT_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
WRANGLER_PATH = os.path.join(PROJECT_ROOT, "wrangler.jsonc")

def print_info(msg):
    print(f"ℹ️  {msg}")

def print_success(msg):
    print(f"✅ {msg}")

def print_fail(msg):
    print(f"❌ {msg}")

def get_wrangler_port(default_port=8787):
    """
    Parses wrangler.jsonc to find dev.port using robust regex.
    Returns default_port if not found or parsing fails.
    """
    print_info(f"Reading port from {WRANGLER_PATH}...")
    
    try:
        if not os.path.exists(WRANGLER_PATH):
            print_fail(f"wrangler.jsonc not found at {WRANGLER_PATH}")
            return default_port

        with open(WRANGLER_PATH, 'r') as f:
            text = f.read()
        
        # Regex to remove comments (// ... and /* ... */)
        pattern = re.compile(r'//.*?$|/\*.*?\*/', re.MULTILINE | re.DOTALL)
        clean_text = re.sub(pattern, '', text)
        
        # 1. Try JSON Parsing
        try:
            wrangler_config = json.loads(clean_text)
            if "dev" in wrangler_config and "port" in wrangler_config["dev"]:
                 port = wrangler_config["dev"]["port"]
                 print_success(f"Found Cloudflare Worker PORT (JSON): {port}")
                 return int(port)
        except json.JSONDecodeError:
            pass # Fallthrough
        
        # 2. Fallback: Regex Search
        match = re.search(r'"port"\s*:\s*(\d+)', clean_text)
        if match:
            port = int(match.group(1))
            print_success(f"Found Cloudflare Worker PORT (Regex): {port}")
            return port
            
    except Exception as e:
        print_fail(f"Failed to parse wrangler.jsonc: {e}")
    
    print_info(f"Using default port {default_port}")
    return default_port

def kill_process_on_port(port):
    """Kills any process listening on the specified port"""
    import subprocess
    import signal
    
    try:
        # lsof to find PID
        cmd = ["lsof", "-t", "-i", f":{port}"]
        result = subprocess.run(cmd, capture_output=True, text=True)
        
        if result.returncode == 0 and result.stdout.strip():
            pids = result.stdout.strip().split('\n')
            for pid in pids:
                pid = int(pid)
                print_info(f"Killing process {pid} on port {port}")
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            return True
    except Exception as e:
        print_fail(f"Failed to clear port {port}: {e}")
        return False

def get_wrangler_vars():
    """
    Parses wrangler.jsonc to extract the 'vars' object.
    Handles JSONC comments (// and /* */) and inline comments.
    """
    config_vars = {}
    
    if not os.path.exists(WRANGLER_PATH):
        print_fail(f"wrangler.jsonc not found at {WRANGLER_PATH}")
        return config_vars

    try:
        with open(WRANGLER_PATH, 'r') as f:
            text = f.read()
        
        # Step 1: Remove block comments /* ... */
        text = re.sub(r'/\*.*?\*/', '', text, flags=re.DOTALL)
        
        # Step 2: Remove line comments // ... but preserve strings
        # This regex preserves content inside quotes
        lines = []
        for line in text.split('\n'):
            # Find // outside of quotes
            in_string = False
            quote_char = None
            comment_start = -1
            
            for i, char in enumerate(line):
                if char in ('"', "'") and (i == 0 or line[i-1] != '\\'):
                    if not in_string:
                        in_string = True
                        quote_char = char
                    elif char == quote_char:
                        in_string = False
                        quote_char = None
                elif char == '/' and i + 1 < len(line) and line[i + 1] == '/' and not in_string:
                    comment_start = i
                    break
            
            if comment_start >= 0:
                lines.append(line[:comment_start])
            else:
                lines.append(line)
        
        clean_text = '\n'.join(lines)
        
        # Step 3: Parse JSON
        data = json.loads(clean_text)
        config_vars = data.get("vars", {})
        
    except json.JSONDecodeError as e:
        print_fail(f"Error parsing wrangler.jsonc: {e}")
    except Exception as e:
        print_fail(f"Unexpected error reading wrangler.jsonc: {e}")
        
    return config_vars

