#!/usr/bin/env python3
"""One-time native migration operator. Explicit --confirm is required for changes."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import shutil
import subprocess
import time

HOME = Path.home()
NATIVE = HOME / '.local/share/serena-native'
CLI = NATIVE / 'tools/serena-native.cjs'
COMMAND_LOCALE = 'en_US.UTF-8'
SOURCE_ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('native_acceptance', Path(__file__).with_name('verify-serena-native.py'))
assert SPEC is not None and SPEC.loader is not None
ACCEPTANCE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ACCEPTANCE)
LEGACY_PATHS = [str(HOME / '.local/bin' / name) for name in
                ('serena', 'serena-guard', 'serena-auth-server', 'serena-stdio-proxy', 'serena-healthcheck')]
LEGACY_SOURCE = str(HOME / 'cache/sparrow-doc/@AI/rules/refs/serena-runtime')


def run(argv, **kwargs):
    return subprocess.run(argv, capture_output=True, text=True, timeout=kwargs.pop('timeout', 30), **kwargs)


def save(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.new')
    with open(temporary, 'w', encoding='utf-8') as stream:
        os.chmod(temporary, 0o600)
        json.dump(data, stream, ensure_ascii=False, indent=2)
    temporary.replace(path)


def processes():
    result = run(['/bin/ps', '-axo', 'pid=,ppid=,lstart=,command='], env={**os.environ, 'LC_ALL': COMMAND_LOCALE, 'LANG': COMMAND_LOCALE})
    if result.returncode:
        raise RuntimeError('Process inventory unavailable')
    found = {}
    pattern = r'^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$'
    for line in result.stdout.splitlines():
        match = re.match(pattern, line)
        if match:
            pid = int(match[1])
            found[pid] = dict(pid=pid, ppid=int(match[2]), start=' '.join(match[3].split()), command=match[4])
    return found


def legacy(process):
    entries = process['command'].split(None, 2)[:2]
    return any(entry in LEGACY_PATHS or entry in [f'{LEGACY_SOURCE}/{name}' for name in
               ('serena-guard', 'serena-stdio-proxy', 'serena-auth-server', 'serena-healthcheck')]
               for entry in entries)


def project_argument(command):
    match = re.search(r' --project(?:=| )(.+?)(?= --[a-zA-Z]|$)', command)
    return str(Path(match[1]).resolve()) if match else None


def cwd(pid):
    result = run(['/usr/sbin/lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'])
    paths = [line[1:] for line in result.stdout.splitlines() if line.startswith('n')]
    return str(Path(paths[0]).resolve()) if result.returncode == 0 and len(paths) == 1 else None


def belongs(process, root):
    command = process['command']
    key = hashlib.sha256(root.encode()).hexdigest()
    if project_argument(command) == root:
        return True
    if f'--project-root={root} --state-dir=' in command:
        return True
    if f'/.serena/guard/instances/{key}' in command:
        return True
    return 'start-mcp-server' in command and '--project-from-cwd' in command and cwd(process['pid']) == root


def stop_legacy(root, evidence):
    current = processes()
    selected = {pid for pid, process in current.items() if legacy(process) and belongs(process, root)}
    # Stop the matching client's launcher too, but never its host application.
    for pid in list(selected):
        parent = current.get(current[pid]['ppid'])
        while parent and legacy(parent) and 'serena-guard' in parent['command']:
            selected.add(parent['pid'])
            parent = current.get(parent['ppid'])
    changed = True
    while changed:
        changed = False
        for pid, process in current.items():
            if process['ppid'] in selected and pid not in selected:
                other = project_argument(process['command'])
                if other and other != root:
                    raise RuntimeError('Refuse mixed-project process tree')
                selected.add(pid)
                changed = True
    witnesses = [current[pid] for pid in sorted(selected)]
    save(evidence / 'legacy-processes.json', witnesses)
    # Launchers/supervisors go first so they cannot respawn a backend during shutdown.
    ordered = sorted(witnesses, key=lambda item: (not ('serena-guard' in item['command']), item['pid']))
    for witness in ordered:
        fresh = processes().get(witness['pid'])
        if fresh and fresh['start'] == witness['start'] and fresh['command'] == witness['command']:
            os.kill(witness['pid'], signal.SIGTERM)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        fresh = processes()
        survivors = [item['pid'] for item in witnesses if fresh.get(item['pid'], {}).get('start') == item['start']]
        if not survivors:
            break
        time.sleep(0.5)
    else:
        raise RuntimeError('Legacy processes did not exit; no force kill attempted')
    if any(legacy(item) and belongs(item, root) for item in processes().values()):
        raise RuntimeError('Legacy backend respawned; native startup blocked')
    return bool(witnesses)


def native_job(root):
    key = hashlib.sha256(root.encode()).hexdigest()
    directory = NATIVE / 'services' / key
    return directory, f'com.proxy-rs.serena.{key[:16]}'


def stop_native(root):
    directory, label = native_job(root)
    job = run(['/bin/launchctl', 'print', f'gui/{os.getuid()}/{label}'])
    match = re.search(r'^\s*pid = (\d+)\s*$', job.stdout, re.M)
    before = processes()
    owned = {int(match[1])} if match else set()
    if job.returncode == 0 and f'path = {directory / "service.plist"}' not in job.stdout:
        raise RuntimeError('Native launchd ownership is unverified')
    expanded = True
    while expanded:
        children = {pid for pid, process in before.items() if process['ppid'] in owned}
        expanded = bool(children - owned)
        owned.update(children)
    witness_file = directory / 'stop-witness.json'
    previous = json.loads(witness_file.read_text()) if witness_file.exists() else []
    witnesses = {item['pid']: item['start'] for item in previous if before.get(item['pid'], {}).get('start') == item['start']}
    witnesses.update({pid: before[pid]['start'] for pid in owned if pid in before})
    save(witness_file, [{'pid': pid, 'start': start} for pid, start in witnesses.items()])
    result = run(['/bin/launchctl', 'bootout', f'gui/{os.getuid()}/{label}'])
    if result.returncode not in (0, 3, 113):
        raise RuntimeError('Native bootout failed')
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        remaining = [item for item in processes().values()
                     if witnesses.get(item['pid']) == item['start'] or str(directory) in item['command']
                     or ('start-mcp-server' in item['command'] and project_argument(item['command']) == root)]
        if not remaining:
            save(directory / 'stop-witness.json', [])
            return
        time.sleep(0.5)
    raise RuntimeError('Native descendants remain after bootout')


def graph_scope(root, path, evidence):
    if not (Path(root) / '.git').exists():
        save(evidence / 'graph.json', {'skipped': '非 git 仓库'})
        return
    executable = shutil.which('graphify-ready')
    if not executable:
        save(evidence / 'graph.json', {'skipped': 'graphify 不可用'})
        return
    excluded = run(['git', '-C', root, 'rev-parse', '--git-path', 'info/exclude'])
    if excluded.returncode:
        raise RuntimeError('Cannot locate graph exclusion file')
    target = Path(excluded.stdout.strip())
    if not target.is_absolute():
        target = Path(root) / target
    old = target.read_text() if target.exists() else ''
    if '/graphify-out/' not in old.splitlines() and 'graphify-out/' not in old.splitlines():
        with open(target, 'a', encoding='utf-8') as stream:
            stream.write('\n/graphify-out/\n')
    result = run([executable, 'affected', path, '--depth', '1'], cwd=root, timeout=240)
    save(evidence / 'graph.json', {'file': path, 'exit': result.returncode, 'output': result.stdout, 'stderr': result.stderr})
    if result.returncode or any(text in result.stdout for text in ['No node matching', 'No unique node match', 'Ambiguous']):
        raise RuntimeError('Graph scope query needs verification before semantic sampling')


def choose_samples(url, root, candidates, evidence):
    client = ACCEPTANCE.McpClient(url)
    try:
        client.initialize()
        if ACCEPTANCE.returned_root(client.call('initial_instructions', {})) != root:
            raise RuntimeError('Project binding mismatch')
        chosen = {}
        scoped = False
        for language, paths in candidates.items():
            if not paths:
                raise RuntimeError(f'No candidate for declared language: {language}')
            if language == 'vue':
                paths = sorted(paths, key=lambda value: not value.endswith('.vue'))
            if not scoped:
                graph_scope(root, paths[0], evidence)
                scoped = True
            sample = None
            for path in paths:
                overview = client.call('get_symbols_overview', {'relative_path': path, 'depth': 1})
                name = ACCEPTANCE.overview_symbol(overview)
                if not name:
                    if language not in ACCEPTANCE.CORE_LANGUAGES:
                        sample = {'path': path}
                        break
                    continue
                definitions = client.call('find_symbol', {'relative_path': path, 'name_path_pattern': '/' + name, 'include_info': True, 'max_matches': 1})
                if not isinstance(definitions, list) or len(definitions) != 1:
                    raise RuntimeError(f'Exact symbol could not be verified: {language}')
                sample = {'path': path, 'symbol': definitions[0]['name_path']}
                if language in ('java', 'vue', 'typescript'):
                    refs = client.call('find_referencing_symbols', {'relative_path': path, 'name_path': sample['symbol'], 'max_answer_chars': ACCEPTANCE.MAX_REFERENCE_CHARS})
                    if not isinstance(refs, dict):
                        raise RuntimeError(f'Reference result is not structured: {language}')
                    reference = next((name for name, value in refs.items() if value), None)
                    if reference:
                        sample['reference'] = reference
                        break
                    sample = None
                    continue
                break
            if sample is None:
                raise RuntimeError(f'No nonempty semantic/reference sample: {language}')
            chosen[language] = sample
        save(evidence / 'samples.json', chosen)
        return chosen
    finally:
        client.close()


def prepare_dependencies(root, languages, evidence):
    directory, _ = native_job(root)
    environment = {**os.environ, 'SERENA_HOME': str(directory / 'home'),
                   'SSL_CERT_FILE': str(NATIVE / 'runtime/2.0.0/lib/python3.13/site-packages/certifi/cacert.pem')}
    result = run([str(NATIVE / 'runtime/2.0.0/bin/serena'), 'download-ls-dependencies', *languages],
                 env=environment, timeout=1800)
    save(evidence / 'dependencies.json', {'exit': result.returncode})
    if result.returncode:
        raise RuntimeError('Native language dependencies could not be prepared before cutover')


def migrate(base, root):
    inventory = json.loads((base / 'inventory.json').read_text())
    row = next((item for item in inventory['projects'] if item['root'] == root), None)
    if row is None or root == str(SOURCE_ROOT):
        raise RuntimeError('Root not in approved migration or is the preserved current service')
    key = hashlib.sha256(root.encode()).hexdigest()
    evidence = base / 'projects' / key
    if (evidence / 'result.json').exists() and json.loads((evidence / 'result.json').read_text()).get('passed'):
        raise RuntimeError('Already verified; do not replay migration')
    candidates = json.loads((base / 'candidate-samples.json').read_text())[root]
    current = processes()
    directory, label = native_job(root)
    witness_path = directory / 'stop-witness.json'
    if witness_path.exists():
        witnesses = json.loads(witness_path.read_text())
        if any(current.get(item['pid'], {}).get('start') == item['start'] for item in witnesses):
            raise RuntimeError('Previously recorded native children are still alive; startup blocked')
    job = run(['/bin/launchctl', 'print', f'gui/{os.getuid()}/{label}'])
    adopted = job.returncode == 0
    if adopted:
        match = re.search(r'^\s*pid = (\d+)\s*$', job.stdout, re.M)
        process = current.get(int(match[1])) if match else None
        if (not any(line.strip() == f'path = {directory / "service.plist"}' for line in job.stdout.splitlines())
                or not process or str(NATIVE / 'runtime/2.0.0/bin/serena') not in process['command']
                or project_argument(process['command']) != root):
            raise RuntimeError('Existing native service ownership could not be verified')
    elif job.returncode != 113:
        raise RuntimeError('Native launchd state could not be verified')
    was_running = adopted or any(legacy(item) and 'start-mcp-server' in item['command'] and belongs(item, root) for item in current.values())
    if (evidence / 'state.json').exists():
        previous = json.loads((evidence / 'state.json').read_text())
        if previous.get('root') != root:
            raise RuntimeError('Migration state root mismatch')
        was_running = adopted or previous['wasRunning']
    save(evidence / 'state.json', {'root': root, 'wasRunning': was_running, 'stage': 'preflight'})
    preview = ['node', str(CLI), 'preview', '--root', root, '--languages', ','.join(row['languages'])]
    extra = []
    if root == str(HOME / '.claude'):
        extra = ['--exclude-external-links', '--exclude-paths', 'plugins/claude-hud/context-cache,plugins/claude-hud/transcript-cache']
    checked = run(preview + extra, timeout=120)
    if checked.returncode:
        raise RuntimeError('Project admission preflight failed: ' + checked.stderr.strip())
    save(evidence / 'admission.json', json.loads(checked.stdout))
    if not adopted:
        prepare_dependencies(root, row['languages'], evidence)
    stop_legacy(root, evidence)
    save(evidence / 'state.json', {'root': root, 'wasRunning': was_running, 'stage': 'legacy-stopped'})
    registry = json.loads((NATIVE / 'registry.json').read_text())
    existing = next((item for item in registry['services'] if item['root'] == root), None)
    if existing:
        if existing['port'] != row['port'] or existing['version'] != '2.0.0':
            raise RuntimeError('Existing native registration differs from approved migration')
    else:
        registered = run(['node', str(CLI), 'register', '--root', root, '--languages', ','.join(row['languages']), '--port', str(row['port']), '--confirm'] + extra, timeout=120)
        if registered.returncode:
            raise RuntimeError('Native registration failed: ' + registered.stderr.strip())
        save(evidence / 'registration.json', json.loads(registered.stdout))
    matching = [item for item in processes().values() if 'start-mcp-server' in item['command'] and project_argument(item['command']) == root]
    if (not adopted and matching) or (adopted and len(matching) != 1):
        raise RuntimeError('A conflicting backend uses the project; refusing duplicate startup')
    if not adopted:
        started = run(['/bin/launchctl', 'bootstrap', f'gui/{os.getuid()}', str(directory / 'service.plist')])
        if started.returncode:
            raise RuntimeError('Native bootstrap failed')
    url = f"http://127.0.0.1:{row['port']}/mcp"
    save(evidence / 'state.json', {'root': root, 'wasRunning': was_running, 'stage': 'native-started', 'url': url})
    try:
        # Only transport readiness may be retried. Semantic failures are never replayed.
        deadline = time.monotonic() + 180
        while True:
            try:
                import socket
                with socket.create_connection(('127.0.0.1', row['port']), timeout=1):
                    break
            except OSError:
                if time.monotonic() >= deadline:
                    raise RuntimeError('Native transport startup timed out')
                time.sleep(1)
        samples = choose_samples(url, root, candidates, evidence)
        result = ACCEPTANCE.verify(url, root, samples)
        if not result.get('passed'):
            raise RuntimeError('Native acceptance did not pass')
        result.update(root=root, retainedRunning=was_running)
        if not was_running:
            stop_native(root)
        save(evidence / 'result.json', result)
        save(evidence / 'state.json', {'root': root, 'wasRunning': was_running, 'stage': 'verified'})
        print(json.dumps({'root': root, 'passed': True, 'retainedRunning': was_running}), flush=True)
    except Exception as error:
        failure = {'error_type': type(error).__name__, 'error': str(error) if isinstance(error, RuntimeError) else 'acceptance failed'}
        save(evidence / 'failure.json', failure)
        if not adopted:
            try:
                stop_native(root)
            except Exception as shutdown_error:
                save(evidence / 'state.json', {'root': root, 'wasRunning': was_running, 'stage': 'failed-stopping', **failure, 'shutdown_error': str(shutdown_error)})
                raise RuntimeError('Acceptance failed; native shutdown still needs verification; see failure.json') from error
        save(evidence / 'state.json', {'root': root, 'wasRunning': was_running, 'stage': 'failed-adopted-running' if adopted else 'failed-native-stopped'})
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--migration', required=True)
    parser.add_argument('--root', required=True)
    parser.add_argument('--confirm', action='store_true')
    args = parser.parse_args()
    try:
        if not args.confirm:
            raise RuntimeError('Explicit maintenance-window confirmation is required')
        migrate(Path(args.migration).resolve(), str(Path(args.root).resolve()))
    except Exception as error:
        print(json.dumps({'passed': False, 'error': str(error) if isinstance(error, RuntimeError) else type(error).__name__}), flush=True)
        raise SystemExit(1)
