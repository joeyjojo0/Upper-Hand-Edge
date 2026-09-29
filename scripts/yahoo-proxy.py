# Local Yahoo Finance relay for the GitHub data engine. Yahoo rejects plain Node/cURL clients (HTTP 429),
# so requests go through curl_cffi, which presents a real Chrome TLS fingerprint and keeps the cookie + crumb.
#   python3 scripts/yahoo-proxy.py 8765   ->   http://127.0.0.1:8765/v8/finance/chart/SPY?...
import sys, time, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qsl, urlencode
from curl_cffi import requests

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
S = requests.Session(impersonate="chrome")
LOCK = threading.Lock()
STATE = {"crumb": None, "at": 0}

def crumb(force=False):
    with LOCK:
        if not force and STATE["crumb"] and time.time() - STATE["at"] < 1500:
            return STATE["crumb"]
        try: S.get("https://fc.yahoo.com/", timeout=15, allow_redirects=True)
        except Exception: pass
        c = S.get("https://query2.finance.yahoo.com/v1/test/getcrumb", timeout=15).text.strip()
        STATE.update(crumb=c if c and "<" not in c and len(c) < 40 else None, at=time.time())
        return STATE["crumb"]

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        u = urlsplit(self.path)
        q = [(k, v) for k, v in parse_qsl(u.query, keep_blank_values=True) if k != "crumb"]
        body, status = b"", 502
        for attempt in range(4):
            params = list(q)
            if u.path.startswith("/v7/"):
                c = crumb(force=attempt > 0)
                if c: params.append(("crumb", c))
            host = "query1" if attempt % 2 == 0 else "query2"
            try:
                r = S.get(f"https://{host}.finance.yahoo.com{u.path}?{urlencode(params)}", timeout=20)
                status, body = r.status_code, r.content
                if status == 200: break
                if status in (401, 403, 429) or status >= 500: time.sleep(1.5 * (attempt + 1)); continue
                break
            except Exception as e:
                body = str(e).encode(); time.sleep(1)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
