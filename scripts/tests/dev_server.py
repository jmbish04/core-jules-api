import os
import subprocess
import time
import requests
import signal
import atexit
from pathlib import Path

import shared_config

class DevServer:
    def __init__(self, port=None):
        # Use shared config if port not provided, otherwise use provided, defaulting to wrangler logic
        if port is None:
            self.port = shared_config.get_wrangler_port()
        else:
            self.port = port
            
        self.process = None
        self.url = f"http://localhost:{self.port}"

    def is_running(self):
        """Check if the server is responding at the expected URL."""
        try:
            # Try hitting the health endpoint or root
            response = requests.get(f"{self.url}/api/health/latest", timeout=1)
            return True
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout):
            return False

    def start(self):
        """Start the local worker dev server in a subprocess."""
        if self.is_running():
            print(f"✅ Local worker already running at {self.url}")
            return

        print(f"🧹 Ensuring port {self.port} is clear...")
        shared_config.kill_process_on_port(self.port)

        print(f"🚀 Starting local worker on port {self.port}...")
        
        # Command to run wrangler dev
        cmd = ["npx", "wrangler", "dev", "--port", str(self.port)]
        
        # Start process
        # process_group=True (setsid) ensures we can kill the whole tree if needed
        self.process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            preexec_fn=os.setsid,
            universal_newlines=True
        )

        # Wait for server to become ready
        print("⏳ Waiting for server to be ready...")
        max_retries = 30
        for i in range(max_retries):
            if self.is_running():
                print(f"✅ Server ready at {self.url}")
                # Register cleanup only if we started it
                atexit.register(self.stop)
                return
            
            # Check if process died early
            if self.process.poll() is not None:
                stdout, stderr = self.process.communicate()
                print(f"❌ Server failed to start (Exit Code: {self.process.returncode})")
                print(f"Stdout: {stdout}")
                print(f"Stderr: {stderr}")
                raise RuntimeError("Server process terminated unexpectedly")
                
            time.sleep(1)
            print(f"   ...waiting ({i+1}/{max_retries})")

        self.stop()
        raise TimeoutError("Server failed to start within expected time")

    def stop(self):
        """Stop the server if we started it."""
        if self.process:
            print("🛑 Stopping local worker...")
            try:
                os.killpg(os.getpgid(self.process.pid), signal.SIGTERM)
                self.process.wait(timeout=5)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                pass # Process already gone or forced kill needed
            self.process = None

def ensure_local_server(port=None):
    """Convenience function to ensure a server is running."""
    if port is None:
        port = shared_config.get_wrangler_port()
    server = DevServer(port)
    server.start()
    return server.url

