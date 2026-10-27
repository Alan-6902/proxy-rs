#!/usr/bin/env python3
"""Read-only HTTP MCP acceptance check. Never starts or controls a server."""
import argparse
import json
import os
import re
from typing import Any
import urllib.error
import urllib.parse
import urllib.request

MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_REFERENCE_CHARS = 100_000
CORE_LANGUAGES = {"typescript", "vue", "java", "python", "rust", "go", "bash", "c", "cpp", "csharp"}


def tool_value(text):
    for _ in range(3):
        if not isinstance(text, str):
            return text
        try:
            value = json.loads(text)
        except (TypeError, ValueError):
            return text
        if isinstance(value, dict) and set(value) == {"result"}:
            text = value["result"]
        else:
            return value
    return text


class McpClient:
    def __init__(self, url):
        target = urllib.parse.urlparse(url)
        if (target.scheme != "http" or target.hostname != "127.0.0.1" or target.path != "/mcp"
                or target.username or target.password or target.query or target.fragment):
            raise ValueError("Only the registered loopback MCP endpoint is accepted")
        self.url = url
        self.counter = 0
        self.headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.tools = {}
        self.session_id = None

    def request(self, method, params, notification=False):
        self.counter += 1
        payload = {"jsonrpc": "2.0", "method": method, "params": params}
        if not notification:
            payload["id"] = self.counter
        req = urllib.request.Request(self.url, json.dumps(payload).encode(), self.headers, method="POST")
        with self.opener.open(req, timeout=240) as response:
            token = response.headers.get("Mcp-Session-Id")
            if token:
                self.headers["Mcp-Session-Id"] = token
            if notification:
                return {}
            if 'text/event-stream' not in response.headers.get('Content-Type', ''):
                raw = response.read(MAX_RESPONSE_BYTES + 1)
                if len(raw) > MAX_RESPONSE_BYTES:
                    raise RuntimeError('MCP response exceeds verification limit')
                decoded = json.loads(raw)
            else:
                decoded, frame, received = None, [], 0
                for encoded in response:
                    received += len(encoded)
                    if received > MAX_RESPONSE_BYTES:
                        raise RuntimeError('MCP response exceeds verification limit')
                    line = encoded.decode().rstrip('\r\n')
                    if line.startswith('data:'):
                        frame.append(line[5:].strip())
                    elif not line and frame:
                        message = json.loads('\n'.join(frame))
                        frame = []
                        if message.get('id') == payload['id']:
                            decoded = message
                            break
                if decoded is None:
                    raise RuntimeError('MCP stream ended before its response')
        if decoded.get('id') != payload['id'] or "error" in decoded:
            raise RuntimeError(f"MCP protocol error for {method}")
        return decoded["result"]

    def initialize(self):
        initialized = self.request("initialize", {"protocolVersion": "2025-11-25", "capabilities": {},
            "clientInfo": {"name": "serena-native-acceptance", "version": "2.0"}})
        self.headers["MCP-Protocol-Version"] = initialized["protocolVersion"]
        self.request("notifications/initialized", {}, notification=True)
        listed = self.request("tools/list", {})
        self.tools = {tool["name"]: tool for tool in listed["tools"]}
        return initialized

    def call(self, name, arguments):
        schema = self.tools[name].get("inputSchema", {})
        if "session_id" in schema.get("required", []) and "session_id" not in arguments:
            if not self.session_id:
                raise RuntimeError("No documented session ID was returned")
            arguments = {**arguments, "session_id": self.session_id}
        result = self.request("tools/call", {"name": name, "arguments": arguments})
        if result.get("isError"):
            raise RuntimeError(f"Semantic tool failed: {name}")
        text = "\n".join(part.get("text", "") for part in result.get("content", []) if part.get("type") == "text")
        value = tool_value(text)
        if isinstance(value, str) and re.match(r"\s*(Error|Traceback|Exception)", value):
            raise RuntimeError(f"Semantic tool failed: {name}")
        if name == "initial_instructions" and isinstance(value, str):
            match = re.search(r"session[ _-]?id[^\n]*?([0-9a-f]{8}(?:-[0-9a-f-]{27,})?)", value, re.I)
            if match:
                self.session_id = match.group(1)
        return value

    def close(self):
        if "Mcp-Session-Id" not in self.headers:
            return
        try:
            req = urllib.request.Request(self.url, headers=self.headers, method="DELETE")
            with self.opener.open(req, timeout=10):
                pass
        except urllib.error.HTTPError as error:
            if error.code not in (404, 405):
                raise
        finally:
            self.headers.pop("Mcp-Session-Id", None)


def returned_root(text):
    if not isinstance(text, str):
        raise RuntimeError("Binding output is not text")
    roots = re.findall(r"The project with name '[^']*' at (.+?) is activated\.", text)
    roots += re.findall(r"^Active project path:\s*(/.+?)\s*$", text, re.M)
    canonical = {os.path.realpath(value) for value in roots}
    if len(canonical) > 1:
        raise RuntimeError("Conflicting project bindings")
    return next(iter(canonical), None)


def overview_candidates(overview, prefix=''):
    if not isinstance(overview, dict):
        raise RuntimeError("Overview is not structured data")
    candidates = []
    priorities = {'Class': 0, 'Interface': 0, 'Enum': 0, 'Function': 1, 'Method': 1,
                  'Constant': 2, 'Variable': 2, 'Property': 3, 'Module': 9}
    for kind, values in overview.items():
        if not isinstance(values, list):
            continue
        for item in values:
            if isinstance(item, str):
                candidates.append((priorities.get(kind, 5), f'{prefix}/{item}' if prefix else item))
            elif isinstance(item, dict):
                for name, children in item.items():
                    path = f'{prefix}/{name}' if prefix else name
                    candidates.append((priorities.get(kind, 5), path))
                    if isinstance(children, dict):
                        candidates.extend(overview_candidates(children, path))
    return sorted(candidates, key=lambda item: item[0])


def overview_symbol(overview):
    candidates = overview_candidates(overview)
    return candidates[0][1] if candidates else None


def verify(url, root, checks=None):
    root = os.path.realpath(root)
    checks = checks or {
        "typescript": {"path": "proxy-rs/src/main/serena/management.ts", "symbol": "SerenaManagement", "reference": "proxy-rs/src/main/serena/ipc-handlers.ts"},
        "rust": {"path": "kiro-rs-src/src/main.rs"},
        "python": {"path": "proxy-rs/scripts/verify-serena-native.py"}
    }
    first, second = McpClient(url), McpClient(url)
    result: dict[str, Any] = {"languages": {}}
    try:
        initialized = first.initialize()
        result["server_version"] = initialized.get("serverInfo", {}).get("version")
        required = {"initial_instructions", "get_symbols_overview", "find_symbol", "find_referencing_symbols"}
        result["tools_mode"] = required.issubset(first.tools) and "activate_project" not in first.tools and "serena_repl" not in first.tools
        if not result["tools_mode"]:
            raise RuntimeError("Required tools mode/fixed-project tool set not present")
        binding = returned_root(first.call("initial_instructions", {}))
        if "get_current_config" in first.tools:
            additional = returned_root(first.call("get_current_config", {}))
            if binding and additional and binding != additional:
                raise RuntimeError("Conflicting project bindings")
            binding = binding or additional
        if binding != root:
            raise RuntimeError("Canonical project binding mismatch or missing")
        result["canonical_root_returned"] = True
        second.initialize()
        if returned_root(second.call("initial_instructions", {})) != root:
            raise RuntimeError("Second client project binding mismatch")
        first_path = None
        for language, sample in checks.items():
            path = sample["path"]
            absolute = os.path.realpath(os.path.join(root, path))
            if os.path.isabs(path) or os.path.commonpath([absolute, root]) != root:
                raise ValueError("Sample escapes the project")
            overview = first.call("get_symbols_overview", {"relative_path": path, "depth": 0})
            symbol_name = sample.get("symbol") or overview_symbol(overview)
            detail = {"path": path, "overview_parsed": isinstance(overview, dict), "symbol": symbol_name}
            if not detail["overview_parsed"] or (language in CORE_LANGUAGES and not symbol_name):
                raise RuntimeError(f"Semantic overview failed: {language}")
            if symbol_name:
                symbols = first.call("find_symbol", {"relative_path": path, "name_path_pattern": '/' + symbol_name.lstrip('/'), "include_info": True, "max_matches": 1})
                if not isinstance(symbols, list) or len(symbols) != 1 or symbols[0].get("relative_path") != path:
                    raise RuntimeError(f"Exact symbol failed: {language}")
                detail["symbol_verified"] = True
            if sample.get("reference"):
                refs = first.call("find_referencing_symbols", {"relative_path": path, "name_path": symbol_name, "max_answer_chars": MAX_REFERENCE_CHARS})
                if not isinstance(refs, dict) or not refs.get(sample["reference"]):
                    raise RuntimeError(f"Known reference failed: {language}")
                detail["reference_verified"] = True
            result["languages"][language] = detail
            first_path = first_path or path
        if not first_path:
            raise RuntimeError("No semantic sample supplied")
        first.close()
        overview = second.call("get_symbols_overview", {"relative_path": first_path, "depth": 0})
        result["second_client_survives_first_exit"] = isinstance(overview, dict)
        result["passed"] = result["server_version"] == "2.0.0" and result["second_client_survives_first_exit"]
        return result
    finally:
        first.close()
        second.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--samples", help="JSON map: language -> path, optional exact symbol and known reference")
    args = parser.parse_args()
    try:
        checks = None
        if args.samples:
            with open(args.samples, encoding="utf-8") as stream:
                checks = json.load(stream)
        report = verify(args.url, args.root, checks)
        print(json.dumps(report, ensure_ascii=False))
        raise SystemExit(0 if report["passed"] else 1)
    except Exception as error:
        print(json.dumps({"passed": False, "error_type": type(error).__name__, "stage": str(error) if isinstance(error, RuntimeError) else "validation"}))
        raise SystemExit(1)
