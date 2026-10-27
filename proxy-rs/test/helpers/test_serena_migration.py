"""Offline tests for the migration operator's process boundary."""
import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/migrate-serena-native.py'
spec = importlib.util.spec_from_file_location('migration_operator', SCRIPT)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MigrationTest(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp(prefix='serena-migration-test-'))
        self.addCleanup(lambda: shutil.move(str(self.temp), str(Path.home() / '.Trash' / self.temp.name)))

    def process(self, root='/projects/example', pid=111, ppid=1):
        return {'pid': pid, 'ppid': ppid, 'start': 'Mon Oct 19 01:00:00 2026',
                'command': f'python {module.HOME}/.local/bin/serena start-mcp-server --project {root} --context ide'}

    def test_legacy_requires_an_executable_position(self):
        process = self.process()
        self.assertTrue(module.legacy(process))
        process['command'] = f'node -e console.log("{module.HOME}/.local/bin/serena start-mcp-server")'
        self.assertFalse(module.legacy(process))
        process['command'] = f'python {module.NATIVE}/runtime/2.0.0/bin/serena start-mcp-server --project /projects/example'
        self.assertFalse(module.legacy(process))

    def test_process_inventory_preserves_unicode_project_paths(self):
        from types import SimpleNamespace
        output = '111 1 Mon Oct 19 01:00:00 2026 python /native/serena --project /projects/治理 --context ide\n'
        with patch.object(module, 'run', return_value=SimpleNamespace(returncode=0, stdout=output)) as run:
            snapshot = module.processes()
            self.assertEqual(module.project_argument(snapshot[111]['command']), '/projects/治理')
            self.assertEqual(run.call_args.kwargs['env']['LC_ALL'], 'en_US.UTF-8')

    def test_project_argument_preserves_spaces(self):
        self.assertEqual(module.project_argument(self.process('/projects/space project')['command']), '/projects/space project')

    def test_only_fingerprinted_owned_process_receives_sigterm(self):
        process = self.process()
        with patch.object(module, 'processes', side_effect=[{111: process}, {111: process}, {}, {}]), patch.object(module.os, 'kill') as kill:
            self.assertTrue(module.stop_legacy('/projects/example', self.temp))
            kill.assert_called_once_with(111, module.signal.SIGTERM)

    def test_pid_reuse_is_not_terminated(self):
        old = self.process()
        reused = {**old, 'start': 'new start', 'command': 'unrelated-process'}
        with patch.object(module, 'processes', side_effect=[{111: old}, {111: reused}, {111: reused}, {111: reused}]), patch.object(module.os, 'kill') as kill:
            module.stop_legacy('/projects/example', self.temp)
            kill.assert_not_called()

    def test_mixed_project_descendants_block_before_signals(self):
        parent = self.process()
        child = self.process('/projects/other', 222, 111)
        with patch.object(module, 'processes', return_value={111: parent, 222: child}), patch.object(module.os, 'kill') as kill:
            with self.assertRaisesRegex(RuntimeError, 'mixed-project'):
                module.stop_legacy('/projects/example', self.temp)
            kill.assert_not_called()


if __name__ == '__main__':
    unittest.main()
