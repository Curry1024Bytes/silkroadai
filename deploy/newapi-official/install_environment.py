#!/usr/bin/env python3
"""Install the audited official-new-api Portal environment while traffic is held.

Production only. The default validates without installing; --apply deliberately
installs. The live env must still equal cutover/portal.env byte for byte. The
candidate is preserved, and only NEWAPI_ADMIN_TOKEN and NEWAPI_DISTRIBUTION may
change. A private report records hashes and booleans, never credentials.

The migration lock and live-file flock serialize cooperating migration tools.
Immediately before atomic replacement, file identity, contents, stopped Portal,
and maintenance/backup markers are checked again. An uncoordinated external env
writer must remain stopped during cutover; Unix rename is not a kernel-level
content compare-and-swap against an unrelated writer.
"""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import time

import migrate_credentials as migration


LIVE_ENV = Path('/opt/silkroadai-portal/.env')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def official_distribution(text):
    matches = 0
    lines = []
    for line in text.splitlines(keepends=True):
        if re.match(r'^\s*(?:export\s+)?NEWAPI_DISTRIBUTION=', line):
            matches += 1
            ending = '\r\n' if line.endswith('\r\n') else '\n' if line.endswith('\n') else ''
            lines.append('NEWAPI_DISTRIBUTION=official' + ending)
        else:
            lines.append(line)
    migration.require(matches <= 1, 'Duplicate distribution variable')
    result = ''.join(lines)
    if not matches:
        if result and not result.endswith('\n'):
            result += '\n'
        result += 'NEWAPI_DISTRIBUTION=official\n'
    return result


def held(root, portal_container):
    cutover = root / 'cutover'
    for name in ['BACKUP_COMPLETE', 'MAINTENANCE_ACTIVE']:
        migration.private_file(cutover / name)
    migration.require(not (cutover / 'PORTAL_TRAFFIC_MAY_HAVE_STARTED').exists() and
                      not (cutover / 'BACKUP_ABORTED').exists(),
                      'Cutover is terminal; environment installation is forbidden')
    migration.require(not migration.inspect(portal_container)['State']['Running'],
                      'Portal must remain stopped')


def replace_cas(path, expected, target, recheck):
    migration.private_file(path)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    temporary = path.with_name(path.name + '.newapi-' + secrets.token_hex(12))
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with os.fdopen(descriptor, 'rb', closefd=False) as current:
            before = os.fstat(descriptor)
            migration.require(current.read() == expected, 'Live environment differs from quiescent backup')
            output = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(output, 'wb') as stream:
                stream.write(target)
                stream.flush()
                os.fsync(stream.fileno())
            recheck()
            now = path.lstat()
            migration.require(stat.S_ISREG(now.st_mode) and
                              (now.st_dev, now.st_ino, now.st_uid, stat.S_IMODE(now.st_mode)) ==
                              (before.st_dev, before.st_ino, before.st_uid, 0o600),
                              'Live environment identity or permissions changed')
            current.seek(0)
            migration.require(current.read() == expected and path.read_bytes() == expected,
                              'Live environment CAS conflict')
            os.replace(temporary, path)
            directory = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        migration.private_file(path)
        migration.require(path.read_bytes() == target, 'Installed environment verification failed')
    finally:
        os.close(descriptor)
        temporary.unlink(missing_ok=True)


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('backup_dir', type=Path)
    parser.add_argument('--portal-container', required=True)
    parser.add_argument('--apply', action='store_true')
    return parser.parse_args()


def main():
    os.umask(0o077)
    args = arguments()
    root = args.backup_dir.resolve()
    migration.require(root.parent == Path('/opt/new-api-migration'), 'Unexpected backup root')
    report_path = root / 'cutover/environment-installation.json'
    report = {'version': 1, 'mode': 'production', 'success': False, 'installed': False,
              'dry_run': not args.apply, 'phase': 'preflight', 'run_id': None,
              'manifest_sha256': None, 'source_env_sha256': None, 'candidate_env_sha256': None,
              'before_sha256': None, 'after_sha256': None, 'changed_keys': [],
              'started_at': int(time.time()), 'completed_at': None}
    migration.atomic_private(report_path, json.dumps(report, indent=2) + '\n')
    phase = 'preflight'
    try:
        migration.require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', args.portal_container) is not None and
                          'rehearsal' not in args.portal_container, 'Production Portal container required')
        held(root, args.portal_container)
        state = root / 'cutover/credential-migration'
        migration.require(stat.S_IMODE(state.stat().st_mode) == 0o700 and
                          state.stat().st_uid == os.geteuid(), 'Credential state must remain private')
        lock_path = state / '.lock'
        migration.private_file(lock_path)
        with lock_path.open('a+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            path = state / 'manifest.json'
            candidate_path = state / 'portal.env.candidate'
            source_path = root / 'cutover/portal.env'
            for item in [path, candidate_path, source_path, LIVE_ENV]:
                migration.private_file(item)
            manifest_bytes = path.read_bytes()
            manifest = json.loads(manifest_bytes)
            config = manifest.get('config', {})
            migration.require(manifest.get('version') == migration.VERSION and manifest.get('status') == 'complete' and
                              config.get('mode') == 'production' and
                              config.get('portal_container') == args.portal_container and
                              config.get('env_source') == str(source_path), 'Production manifest differs')
            customers = [entry for entry in manifest['entries'] if entry['kind'] == 'customer']
            admins = [entry for entry in manifest['entries'] if entry['kind'] == 'admin']
            migration.require(bool(customers) and len(admins) == 1 and admins[0]['role'] == 100 and
                              admins[0]['status'] == 'pat_inserted' and
                              all(entry['status'] == 'portal_updated' and entry['role'] == 1 for entry in customers),
                              'Credential migration owners are not complete')
            admin = admins[0]
            migration.require(admin['scopes'] == migration.ADMIN_SCOPES and
                              migration.digest(admin['new_token']) == admin['token_hash'],
                              'Administrator PAT differs from the audited manifest')
            source = source_path.read_bytes()
            source_text = source.decode('utf-8')
            migration.require(migration.digest(source_path.read_text()) == manifest['source_sha256'],
                              'Backed-up environment changed')
            candidate = candidate_path.read_bytes()
            migration.require(candidate == migration.candidate_env(source_text, admin['new_token']).encode('utf-8'),
                              'Candidate differs beyond administrator token')
            target = official_distribution(candidate.decode('utf-8')).encode('utf-8')
            original_values = migration.env_values(source_text)
            expected_values = {**original_values, 'NEWAPI_ADMIN_TOKEN': admin['new_token'],
                               'NEWAPI_DISTRIBUTION': 'official'}
            migration.require(migration.env_values(target.decode('utf-8')) == expected_values,
                              'Unexpected environment variable change')
            changed = sorted(key for key in set(original_values) | set(expected_values)
                             if original_values.get(key) != expected_values.get(key))
            migration.require(set(changed).issubset({'NEWAPI_ADMIN_TOKEN', 'NEWAPI_DISTRIBUTION'}) and
                              'NEWAPI_ADMIN_TOKEN' in changed, 'Unexpected environment change set')
            before = LIVE_ENV.read_bytes()
            migration.require(before == source, 'Live environment differs from quiescent backup')
            report.update({'run_id': manifest['run_id'], 'manifest_sha256': digest(manifest_bytes),
                           'source_env_sha256': manifest['source_sha256'], 'candidate_env_sha256': digest(candidate),
                           'before_sha256': digest(before), 'after_sha256': digest(target), 'changed_keys': changed})

            def recheck():
                held(root, args.portal_container)
                migration.require(path.read_bytes() == manifest_bytes and source_path.read_bytes() == source and
                                  candidate_path.read_bytes() == candidate, 'Migration evidence changed during installation')

            if args.apply:
                phase = 'environment-cas'
                replace_cas(LIVE_ENV, source, target, recheck)
                report['installed'] = True
            report.update({'success': True, 'phase': 'installed' if args.apply else 'validated',
                           'completed_at': int(time.time())})
    except Exception:
        report['phase'] = phase
        migration.atomic_private(report_path, json.dumps(report, indent=2) + '\n')
        raise migration.MigrationError('Environment installation failed during ' + phase) from None
    migration.atomic_private(report_path, json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    try:
        main()
    except migration.MigrationError as error:
        print(json.dumps({'error': str(error)}), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print(json.dumps({'error': 'Environment installation stopped', 'error_type': type(error).__name__}),
              file=sys.stderr)
        sys.exit(1)
