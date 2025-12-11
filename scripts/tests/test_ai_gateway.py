import os
import sys
import json
import urllib.request
import urllib.error
import subprocess

# Add current directory to path to import shared_config
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.append(SCRIPT_DIR)

import shared_config

# --- Global Configuration ---
GATEWAY_BASE_PATTERN = "https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_name}"

# --- Helper: Visual Formatting ---
def print_header(provider, method, model=None):
    # Color coding: Gemini=Cyan, OpenAI=Green
    color = "\033[1;36m" if "GEMINI" in provider else "\033[1;32m"
    print(f"\n{color}{'='*70}\033[0m")
    print(f"{color}>>> TEST: {provider} via {method}\033[0m")
    if model:
        print(f"{color}>>> MODEL: {model}\033[0m")
    print(f"{color}{'='*70}\033[0m\n")

def load_dev_vars():
    """Parses .dev.vars file using path from shared_config."""
    vars_path = os.path.join(shared_config.PROJECT_ROOT, ".dev.vars")
    env_vars = {}
    
    if not os.path.exists(vars_path):
        shared_config.print_fail(f".dev.vars not found at {vars_path}")
        return env_vars

    try:
        with open(vars_path, 'r') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#'):
                    parts = line.split('=', 1)
                    if len(parts) == 2:
                        key, val = parts[0].strip(), parts[1].strip()
                        val = val.strip('"').strip("'")
                        env_vars[key] = val
    except Exception as e:
        shared_config.print_fail(f"Error reading .dev.vars: {e}")
    return env_vars

# --- HTTP / CURL Runners (Existing) ---

def run_python_test(url, headers, payload, response_parser):
    """Generic Python urllib tester"""
    shared_config.print_info(f"Sending Python Request...")
    try:
        req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers)
        with urllib.request.urlopen(req) as response:
            status_code = response.getcode()
            response_body = response.read().decode('utf-8')
            if status_code == 200:
                shared_config.print_success("Python Request: SUCCESS")
                try:
                    response_parser(json.loads(response_body))
                except:
                    print(response_body)
            else:
                shared_config.print_fail(f"Request Failed: {status_code}")
    except urllib.error.HTTPError as e:
        shared_config.print_fail(f"HTTP Error {e.code}: {e.reason}")
        print(f"Details: {e.read().decode('utf-8')}")
    except Exception as e:
        shared_config.print_fail(f"Python Error: {e}")

def run_curl_test(url, headers_dict, payload, response_parser):
    """Generic Subprocess Curl tester"""
    shared_config.print_info("Executing System Curl...")
    command = ["curl", "-s", url]
    for key, value in headers_dict.items():
        command.extend(["--header", f"{key}: {value}"])
    command.extend(["--data", json.dumps(payload)])

    try:
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode == 0:
            shared_config.print_success("Curl Command: SUCCESS")
            try:
                response_parser(json.loads(result.stdout))
            except:
                print(result.stdout)
        else:
            shared_config.print_fail(f"Curl Failed (Code {result.returncode})")
            print(result.stderr)
    except Exception as e:
        shared_config.print_fail(f"Subprocess Error: {e}")

# --- SDK Runners (New) ---

def run_gemini_sdk_test(api_key, base_url, aig_token, model_name):
    """Tests using the google.genai SDK"""
    shared_config.print_info("Initializing Google GenAI SDK...")
    try:
        from google import genai
        from google.genai import types

        # The Gateway URL for Gemini SDKs is often just the base:
        # https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/google-ai-studio
        # The SDK appends /v1/models/... automatically.
        sdk_base_url = f"{base_url}/google-ai-studio"

        client = genai.Client(
            api_key=api_key,
            http_options={
                'base_url': sdk_base_url,
                'headers': {'cf-aig-authorization': f'Bearer {aig_token}'}
            }
        )
        
        response = client.models.generate_content(
            model=model_name,
            contents='What is Cloudflare? One sentence.'
        )
        
        if response.text:
            shared_config.print_success("GenAI SDK: SUCCESS")
            print(f"\n💬 \033[1;36mSDK Response:\033[0m {response.text}\n")
        else:
            shared_config.print_fail("GenAI SDK: Empty response")

    except ImportError:
        shared_config.print_fail("google-genai library not installed. Run: pip install google-genai")
    except Exception as e:
        shared_config.print_fail(f"GenAI SDK Error: {e}")

def run_openai_sdk_test(api_key, base_url, aig_token, model_name):
    """Tests using the openai SDK"""
    shared_config.print_info("Initializing OpenAI SDK...")
    try:
        from openai import OpenAI

        # OpenAI SDK expects base_url to end with /v1 usually, 
        # but Cloudflare Gateway for OpenAI maps: .../openai -> https://api.openai.com/v1
        # So we point the SDK to .../openai
        sdk_base_url = f"{base_url}/openai"

        client = OpenAI(
            api_key=api_key,
            base_url=sdk_base_url,
            default_headers={"cf-aig-authorization": f"Bearer {aig_token}"}
        )

        completion = client.chat.completions.create(
            model=model_name,
            messages=[{"role": "user", "content": "What is Cloudflare? One sentence."}]
        )

        content = completion.choices[0].message.content
        if content:
            shared_config.print_success("OpenAI SDK: SUCCESS")
            print(f"\n💬 \033[1;32mSDK Response:\033[0m {content}\n")
        else:
            shared_config.print_fail("OpenAI SDK: Empty response")

    except ImportError:
        shared_config.print_fail("openai library not installed. Run: pip install openai")
    except Exception as e:
        shared_config.print_fail(f"OpenAI SDK Error: {e}")

# --- Response Parsers ---

def parse_gemini(json_resp):
    if 'candidates' in json_resp and json_resp['candidates']:
        try:
            text = json_resp['candidates'][0]['content']['parts'][0]['text']
            print(f"\n💬 \033[1;36mGemini Response:\033[0m {text}\n")
        except:
            print(json.dumps(json_resp, indent=2))
    else:
        print(json.dumps(json_resp, indent=2))

def parse_openai(json_resp):
    if 'choices' in json_resp and json_resp['choices']:
        try:
            text = json_resp['choices'][0]['message']['content']
            print(f"\n💬 \033[1;32mOpenAI Response:\033[0m {text}\n")
        except:
            print(json.dumps(json_resp, indent=2))
    else:
        print(json.dumps(json_resp, indent=2))

def main():
    # 1. Load Config
    dev_vars = load_dev_vars()
    wrangler_vars = shared_config.get_wrangler_vars() or {}

    account_id = dev_vars.get("CLOUDFLARE_ACCOUNT_ID") or dev_vars.get("CLODUFLARE_ACCOUNT_ID")
    aig_token = dev_vars.get("CF_AIG_TOKEN")
    gateway_name = wrangler_vars.get("AI_GATEWAY_NAME", "ask-cloudflare-mcp")

    if not account_id:
        shared_config.print_fail("Missing CLOUDFLARE_ACCOUNT_ID in .dev.vars")
        return

    gemini_key = dev_vars.get("GEMINI_API_KEY")
    openai_key = dev_vars.get("OPENAI_API_KEY")
    
    gemini_model = wrangler_vars.get("GEMINI_MODEL", "gemini-1.5-pro")
    openai_model = wrangler_vars.get("OPENAI_MODEL", "gpt-4o")
    
    ua_spoof = "Mozilla/5.0"
    base_gateway_url = GATEWAY_BASE_PATTERN.format(account_id=account_id, gateway_name=gateway_name)

    # ==========================================
    # TEST SUITE 1: GEMINI
    # ==========================================
    if gemini_key:
        print_header("GEMINI", "Setup", gemini_model)
        gemini_url = f"{base_gateway_url}/google-ai-studio/v1beta/models/{gemini_model}:generateContent"
        
        gemini_headers = {
            "Content-Type": "application/json",
            "cf-aig-authorization": f"Bearer {aig_token}",
            "x-goog-api-key": gemini_key,
            "User-Agent": ua_spoof
        }
        
        gemini_payload = {
            "contents": [{"role": "user", "parts": [{"text": "What is Cloudflare? One sentence."}]}]
        }

        print_header("GEMINI", "Python (urllib)", gemini_model)
        run_python_test(gemini_url, gemini_headers, gemini_payload, parse_gemini)

        print_header("GEMINI", "Curl (subprocess)", gemini_model)
        run_curl_test(gemini_url, gemini_headers, gemini_payload, parse_gemini)

        print_header("GEMINI", "Python SDK (google.genai)", gemini_model)
        run_gemini_sdk_test(gemini_key, base_gateway_url, aig_token, gemini_model)

    else:
        shared_config.print_fail("Skipping Gemini tests (GEMINI_API_KEY missing)")


    # ==========================================
    # TEST SUITE 2: OPENAI
    # ==========================================
    if openai_key:
        print_header("OPENAI", "Setup", openai_model)
        openai_url = f"{base_gateway_url}/openai/chat/completions"
        
        openai_headers = {
            "Content-Type": "application/json",
            "cf-aig-authorization": f"Bearer {aig_token}",
            "Authorization": f"Bearer {openai_key}",
            "User-Agent": ua_spoof
        }

        openai_payload = {
            "model": openai_model,
            "messages": [{"role": "user", "content": "What is Cloudflare? One sentence."}]
        }

        print_header("OPENAI", "Python (urllib)", openai_model)
        run_python_test(openai_url, openai_headers, openai_payload, parse_openai)

        print_header("OPENAI", "Curl (subprocess)", openai_model)
        run_curl_test(openai_url, openai_headers, openai_payload, parse_openai)

        print_header("OPENAI", "Python SDK (openai)", openai_model)
        run_openai_sdk_test(openai_key, base_gateway_url, aig_token, openai_model)

    else:
        shared_config.print_fail("Skipping OpenAI tests (OPENAI_API_KEY missing)")

if __name__ == "__main__":
    main()