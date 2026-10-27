"""Offline regression tests for native MCP acceptance evidence."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/verify-serena-native.py"
spec = importlib.util.spec_from_file_location("native_verifier", SCRIPT)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeClient:
    binding = "/projects/example"
    overview = {"Class": ["Example"]}
    references = {"src/caller.ts": {"Function": [{"name_path": "call"}]}}

    def __init__(self, _url):
        self.tools = {name: {} for name in ["initial_instructions", "get_symbols_overview", "find_symbol", "find_referencing_symbols"]}

    def initialize(self):
        return {"serverInfo": {"version": "2.0.0"}}

    def call(self, name, arguments):
        if name == "initial_instructions":
            return f"The project with name 'example' at {self.binding} is activated."
        if name == "get_symbols_overview":
            return self.overview
        if name == "find_symbol":
            if arguments["name_path_pattern"] != "/Example":
                raise RuntimeError("Class and constructor would both match a relative name")
            return [{"name_path": "Example", "relative_path": arguments["relative_path"]}]
        if name == "find_referencing_symbols":
            return self.references
        raise AssertionError(name)

    def close(self):
        pass


class VerifierTest(unittest.TestCase):
    def setUp(self):
        self.mock = patch.object(module, "McpClient", FakeClient)
        self.mock.start()
        self.addCleanup(self.mock.stop)
        self.samples = {"typescript": {"path": "src/example.ts", "symbol": "Example", "reference": "src/caller.ts"}}

    def verify(self):
        return module.verify("http://127.0.0.1:39101/mcp", "/projects/example", self.samples)

    def test_valid_structured_evidence(self):
        self.assertTrue(self.verify()["passed"])

    def test_path_prefix_is_not_a_binding(self):
        with patch.object(FakeClient, "binding", "/projects/example-other"):
            with self.assertRaisesRegex(RuntimeError, "binding mismatch"):
                self.verify()

    def test_conflicting_roots_are_not_accepted(self):
        text = "The project with name 'one' at /one is activated.\nActive project path: /two"
        with self.assertRaisesRegex(RuntimeError, "Conflicting"):
            module.returned_root(text)

    def test_nonempty_error_text_is_not_an_overview(self):
        with patch.object(FakeClient, "overview", "Backend error"):
            with self.assertRaisesRegex(RuntimeError, "overview failed"):
                self.verify()

    def test_empty_core_language_result_is_not_health(self):
        with patch.object(FakeClient, "overview", {}):
            self.samples["typescript"].pop("symbol")
            with self.assertRaisesRegex(RuntimeError, "overview failed"):
                self.verify()

    def test_missing_known_reference_fails(self):
        with patch.object(FakeClient, "references", {}):
            with self.assertRaisesRegex(RuntimeError, "Known reference failed"):
                self.verify()

    def test_result_wrapper_is_decoded(self):
        self.assertEqual(module.tool_value('{"result":"{\\"Class\\":[\\"Example\\"]}"}'), {"Class": ["Example"]})

    def test_vue_selects_a_scoped_function_instead_of_the_template_container(self):
        symbols = {'Module': ['template', {'script setup': {'Function': ['handleResize']}}]}
        self.assertEqual(module.overview_symbol(symbols), 'script setup/handleResize')

    def test_sample_cannot_escape_root(self):
        self.samples["typescript"]["path"] = "../outside.ts"
        with self.assertRaisesRegex(ValueError, "escapes"):
            self.verify()


if __name__ == "__main__":
    unittest.main()
