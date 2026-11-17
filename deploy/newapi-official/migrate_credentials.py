#!/usr/bin/env python3
"""Offline, resumable legacy-token -> scoped PAT migration for official rc.51.

Run on the Docker host. This does not reset passwords, touch inference keys,
change balances, or edit a live env file. It writes a 0600 manifest containing
recovery credentials BEFORE the first database write, and a separate candidate
env with only NEWAPI_ADMIN_TOKEN replaced. Keep that directory private.

Example rehearsal (the default is read-only; --apply is deliberate)::

    python3 migrate_credentials.py /opt/new-api-migration/<run> \
      --mode rehearsal --newapi-db newapi-rc51-rehearsal-pg \
      --portal-db newapi-rc51-rehearsal-portal-pg \
      --env-source /opt/new-api-migration/<run>/backup-online/portal.env --apply

Production additionally requires a quiescent cutover/BACKUP_COMPLETE backup,
an explicitly named stopped Portal container, and non-rehearsal DB containers.
The operator installs the candidate env only after reviewing the result.

Each owner's PAT insertion is serialized with SELECT ... FOR UPDATE, counts all
PAT rows (including expired rows), and preserves the official maximum of 20.
Cross-database writes cannot be atomic: the manifest makes crashes resumable;
Portal compares old -> new (or accepts already-new), and never blindly updates.
On a conflict, resolve it or run --rollback --apply while Portal remains stopped.
Rollback CAS-restores the old Portal values before deleting only this run's PATs.
Do not rollback after production traffic resumes; that also requires retaining
the new credentials and assessing writes made after cutover.

No subprocess stderr, SQL, token, HTTP response, or env value is printed.
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
import string
import subprocess
import sys
import time


CUSTOMER_SCOPES = sorted(['api_key:read', 'api_key:reveal', 'api_key:write', 'profile:read'])
ADMIN_SCOPES = sorted(['user:read', 'user:write', 'log:read', 'channel:read',
                       'channel:write', 'option:read', 'option:write', 'profile:read'])
MAX_PATS = 20
VERSION = 1


class MigrationError(Exception):
    """A deliberately non-sensitive diagnostic."""


def require(condition, message):
    if not condition:
        raise MigrationError(message)


def run(command, *, data=None):
    result = subprocess.run(command, input=data, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True)
    if result.returncode:
        raise MigrationError('Docker/database command failed (exit %d)' % result.returncode)
    return result.stdout.strip()


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


def literal(value):
    if value is None:
        return 'NULL'
    return "'" + str(value).replace("'", "''") + "'"


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


class Database:
    def __init__(self, name):
        self.name = name

    def sql(self, statement):
        # Credentials are resolved in-container, SQL is stdin, never argv.
        if '$migration$' in statement:
            require(statement.count('$migration$') == 2, 'Unexpected SQL block delimiter in source data')
            tag = '$m_' + secrets.token_hex(16) + '$'
            require(tag not in statement, 'SQL block delimiter collision')
            statement = statement.replace('$migration$', tag)
        return run(['docker', 'exec', '-i', self.name, 'sh', '-lc',
                    'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],
                   data='SET standard_conforming_strings=on;\n' + statement)

    def json(self, statement):
        return json.loads(self.sql(statement))


def atomic_private(path, content):
    path = Path(path)
    temporary = path.with_name(path.name + '.tmp-' + secrets.token_hex(8))
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary.exists():
            temporary.unlink()


def env_values(text):
    result = {}
    for line in text.splitlines():
        match = re.match(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)=(.*)$', line)
        if match:
            key, value = match.groups()
            require(key not in result, 'Duplicate env variable')
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            result[key] = value
    return result


def candidate_env(source, token):
    matches = 0
    result = []
    for line in source.splitlines(keepends=True):
        if re.match(r'^\s*(?:export\s+)?NEWAPI_ADMIN_TOKEN=', line):
            ending = '\r\n' if line.endswith('\r\n') else '\n' if line.endswith('\n') else ''
            result.append('NEWAPI_ADMIN_TOKEN=' + token + ending)
            matches += 1
        else:
            result.append(line)
    require(matches == 1, 'Expected exactly one admin token in env source')
    return ''.join(result)


def new_pat():
    alphabet = string.ascii_letters + string.digits
    return 'nap_' + ''.join(secrets.choice(alphabet) for _ in range(43))


def get_portal_users(db):
    return db.json('''SELECT COALESCE(json_agg(x ORDER BY id), '[]'::json) FROM (
      SELECT id::text, status::text, newapi_user_id, newapi_username, newapi_access_token
      FROM users WHERE newapi_user_id IS NOT NULL) x;''')


def get_owners(db):
    return db.json('''SELECT COALESCE(json_agg(x ORDER BY id), '[]'::json) FROM (
      SELECT id,username,status,role,(SELECT count(*) FROM user_access_tokens p
      WHERE p.user_id=users.id) AS pat_count FROM users WHERE deleted_at IS NULL) x;''')


def owner_guard(entry):
    return ('id=%d AND username=%s AND status=1 AND deleted_at IS NULL AND role=%d' %
            (entry['newapi_user_id'], literal(entry['username']), entry['role']))


def token_details(db, entry):
    return db.json('''SELECT COALESCE(json_agg(x), '[]'::json) FROM (
      SELECT id,user_id,name,token_hash,token_hint,scopes,expires_at
      FROM user_access_tokens WHERE token_hash=%s) x;''' % literal(entry['token_hash']))


def validate_existing(entry, records):
    if not records:
        return None
    require(len(records) == 1, 'PAT hash is not unique')
    item = records[0]
    require(item['user_id'] == entry['newapi_user_id'] and
            item['name'] == entry['name'] and item['token_hint'] == entry['new_token'][-4:] and
            item['expires_at'] == 0 and sorted(json.loads(item['scopes'])) == entry['scopes'],
            'Existing PAT differs from persisted manifest')
    return item['id']


def insert_pat(db, entry):
    # A separate conditional insert also makes replay safe when commit happened
    # before the caller could persist its per-user progress to the manifest.
    db.sql('''BEGIN;
      SELECT id FROM users WHERE %s FOR UPDATE;
      DO $migration$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM users WHERE %s) THEN
          RAISE EXCEPTION 'PAT owner changed';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM user_access_tokens WHERE token_hash=%s) THEN
          IF (SELECT count(*) FROM user_access_tokens WHERE user_id=%d) >= %d THEN
            RAISE EXCEPTION 'PAT row limit reached';
          END IF;
          INSERT INTO user_access_tokens
            (user_id,name,token_hash,token_hint,scopes,expires_at,last_used_at,last_used_ip,created_at)
          VALUES (%d,%s,%s,%s,%s,0,0,'',%d);
        END IF;
      END $migration$;
      COMMIT;''' % (owner_guard(entry), owner_guard(entry), literal(entry['token_hash']),
                     entry['newapi_user_id'], MAX_PATS, entry['newapi_user_id'],
                     literal(entry['name']), literal(entry['token_hash']),
                     literal(entry['new_token'][-4:]), literal(json.dumps(entry['scopes'])),
                     entry['created_at']))
    return validate_existing(entry, token_details(db, entry))


def portal_current(db, entry):
    records = db.json('''SELECT COALESCE(json_agg(x), '[]'::json) FROM (
      SELECT status::text,newapi_user_id,newapi_username,newapi_access_token FROM users
      WHERE id=%s::uuid) x;''' % literal(entry['portal_user_id']))
    require(len(records) == 1, 'Portal owner missing')
    item = records[0]
    require(item['status'] == 'active' and
            item['newapi_user_id'] == entry['newapi_user_id'] and
            item['newapi_username'] == entry['username'], 'Portal owner mapping changed')
    return item['newapi_access_token']


def portal_cas(db, entry, rollback=False):
    expected = entry['new_token'] if rollback else entry['old_token']
    target = entry['old_token'] if rollback else entry['new_token']
    db.sql('''BEGIN;
      SELECT id FROM users WHERE id=%s::uuid FOR UPDATE;
      DO $migration$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM users WHERE id=%s::uuid AND status::text='active' AND newapi_user_id=%d
          AND newapi_username IS NOT DISTINCT FROM %s
          AND (newapi_access_token IS NOT DISTINCT FROM %s
               OR newapi_access_token IS NOT DISTINCT FROM %s)) THEN
          RAISE EXCEPTION 'Portal credential CAS conflict';
        END IF;
        UPDATE users SET newapi_access_token=%s WHERE id=%s::uuid
          AND newapi_access_token IS NOT DISTINCT FROM %s;
      END $migration$;
      COMMIT;''' % (literal(entry['portal_user_id']), literal(entry['portal_user_id']),
                     entry['newapi_user_id'], literal(entry['username']), literal(expected),
                     literal(target), literal(target), literal(entry['portal_user_id']),
                     literal(expected)))
    require(portal_current(db, entry) == target, 'Portal CAS verification failed')


def save_manifest(path, manifest):
    manifest['updated_at'] = int(time.time())
    atomic_private(path, json.dumps(manifest, indent=2) + '\n')


def private_file(path):
    item = path.lstat()
    require(stat.S_ISREG(item.st_mode) and item.st_uid == os.geteuid() and
            stat.S_IMODE(item.st_mode) == 0o600, 'Private file must be owned by current user and mode 0600')


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('backup_dir', type=Path)
    parser.add_argument('--mode', required=True, choices=['rehearsal', 'production'])
    parser.add_argument('--newapi-db', required=True)
    parser.add_argument('--portal-db', required=True)
    parser.add_argument('--portal-container')
    parser.add_argument('--env-source', required=True, type=Path)
    parser.add_argument('--state-dir', type=Path)
    parser.add_argument('--admin-user-id', type=int)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--rollback', action='store_true')
    return parser.parse_args()


def validate_environment(args):
    root = args.backup_dir.resolve()
    require(root.parent == Path('/opt/new-api-migration'), 'Unexpected backup root')
    backup = root / ('backup-online' if args.mode == 'rehearsal' else 'cutover')
    for filename in ['portal.dump', 'new-api.dump', 'portal.env']:
        require((backup / filename).is_file(), 'Required database/env backup missing')
    source = args.env_source.resolve()
    require(source == backup / 'portal.env', 'Use the matching backed-up Portal env source')
    private_file(source)
    for name in [args.newapi_db, args.portal_db]:
        require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', name) is not None, 'Invalid container name')
    require(args.newapi_db != args.portal_db, 'Database containers must differ')
    containers = [inspect(args.newapi_db), inspect(args.portal_db)]
    require(all(item['State']['Running'] for item in containers), 'Database container is not running')
    if args.mode == 'rehearsal':
        require(all(name.startswith('newapi-rc51-rehearsal-') for name in
                    [args.newapi_db, args.portal_db]), 'Rehearsal cannot target production containers')
        for item in containers:
            networks = item['NetworkSettings']['Networks']
            require(len(networks) == 1 and not item['HostConfig'].get('PortBindings'),
                    'Rehearsal database must have one network and no published ports')
            for name in networks:
                require(json.loads(run(['docker', 'network', 'inspect', name]))[0]['Internal'],
                        'Rehearsal network must be internal')
    else:
        require(not any('rehearsal' in name for name in [args.newapi_db, args.portal_db]),
                'Production mode cannot use rehearsal database containers')
        require((backup / 'BACKUP_COMPLETE').is_file(), 'Quiescent backup marker is required')
        require(not (backup / 'PORTAL_TRAFFIC_MAY_HAVE_STARTED').exists(),
                'Portal traffic may have resumed; assess writes before credential migration/rollback')
        require(bool(args.portal_container), 'Production requires explicit Portal container')
        require(not inspect(args.portal_container)['State']['Running'], 'Portal must be stopped')
    state_dir = (args.state_dir or root / ('rehearsal' if args.mode == 'rehearsal' else 'cutover') /
                 'credential-migration').resolve()
    require(state_dir.is_relative_to(root) and state_dir != backup,
            'Credential state must be in a separate directory beneath backup root')
    return root, source, state_dir


def plan(args, source_text, newapi, portal, config):
    values = env_values(source_text)
    require('NEWAPI_ADMIN_TOKEN' in values, 'Admin token is absent from env source')
    env_admin_id = values.get('NEWAPI_ADMIN_USER_ID', '1')
    require(env_admin_id.isdigit(), 'Admin user ID is invalid')
    admin_id = args.admin_user_id if args.admin_user_id is not None else int(env_admin_id)
    require(admin_id == int(env_admin_id), 'Explicit admin ID differs from env source')
    owners = {item['id']: item for item in get_owners(newapi)}
    users = get_portal_users(portal)
    require(bool(users), 'No mapped Portal users found')
    admin = owners.get(admin_id)
    require(admin is not None and admin['status'] == 1 and admin['role'] == 100,
            'Configured admin must be an active root account')
    run_id = secrets.token_hex(8)
    entries = []
    skipped = []
    counts = {}
    for user in users:
        if user['status'] != 'active':
            skipped.append({'portal_user_id': user['id'], 'newapi_user_id': user['newapi_user_id'],
                            'username': user['newapi_username'], 'portal_status': user['status'],
                            'upstream_missing': user['newapi_user_id'] not in owners,
                            'reason': 'Portal account is not active; no PAT issued'})
            continue
        owner = owners.get(user['newapi_user_id'])
        require(owner is not None and owner['status'] == 1 and owner['role'] == 1 and
                owner['username'] == user['newapi_username'], 'Customer mapping/status mismatch')
        require(owner['id'] != admin_id, 'Root admin is also mapped as a Portal customer')
        token = new_pat()
        entries.append({'kind': 'customer', 'portal_user_id': user['id'],
                        'newapi_user_id': owner['id'], 'username': owner['username'],
                        'role': owner['role'], 'old_token': user['newapi_access_token'],
                        'new_token': token, 'token_hash': digest(token), 'scopes': CUSTOMER_SCOPES,
                        'name': 'portal-migrate-' + run_id, 'created_at': int(time.time()),
                        'status': 'planned'})
        require(owner['id'] not in counts, 'Multiple active Portal customers share one upstream owner')
        counts[owner['id']] = 1
    token = new_pat()
    entries.append({'kind': 'admin', 'newapi_user_id': admin_id, 'username': admin['username'],
                    'role': admin['role'], 'old_token': values['NEWAPI_ADMIN_TOKEN'],
                    'new_token': token, 'token_hash': digest(token), 'scopes': ADMIN_SCOPES,
                    'name': 'portal-admin-' + run_id, 'created_at': int(time.time()),
                    'status': 'planned'})
    counts[admin_id] = counts.get(admin_id, 0) + 1
    require(all(owners[user_id]['pat_count'] + count <= MAX_PATS for user_id, count in counts.items()),
            'Official PAT row limit would be exceeded')
    return {'version': VERSION, 'run_id': run_id, 'config': config,
            'source_sha256': digest(source_text), 'status': 'planned', 'entries': entries,
            'skipped_users': skipped,
            'created_at': int(time.time())}


def preflight_manifest(manifest, source_text, config, newapi, portal, rollback):
    require(manifest.get('version') == VERSION and manifest.get('config') == config,
            'Manifest target/config mismatch')
    require(manifest.get('source_sha256') == digest(source_text), 'Backed-up env source changed')
    owners = {item['id']: item for item in get_owners(newapi)}
    mapped = get_portal_users(portal)
    planned_ids = {entry['portal_user_id'] for entry in manifest['entries'] if entry['kind'] == 'customer'}
    skipped = {entry['portal_user_id']: entry for entry in manifest.get('skipped_users', [])}
    require({item['id'] for item in mapped} == planned_ids | skipped.keys(), 'Mapped Portal user set changed')
    for item in mapped:
        if item['id'] in skipped:
            saved = skipped[item['id']]
            require(item['status'] != 'active' and item['newapi_user_id'] == saved['newapi_user_id'] and
                    item['newapi_username'] == saved['username'] and
                    (item['newapi_user_id'] not in owners) == saved['upstream_missing'],
                    'Skipped Portal owner/status/upstream presence changed')
        else:
            require(item['status'] == 'active', 'Planned Portal customer is no longer active')
    additions = {}
    for entry in manifest['entries']:
        require(re.fullmatch(r'nap_[A-Za-z0-9]{43}', entry['new_token']) is not None and
                digest(entry['new_token']) == entry['token_hash'], 'Manifest PAT integrity failed')
        expected = CUSTOMER_SCOPES if entry['kind'] == 'customer' else ADMIN_SCOPES
        require(entry['scopes'] == expected, 'Manifest scope grant differs from audited set')
        owner = owners.get(entry['newapi_user_id'])
        require(owner and owner['username'] == entry['username'] and owner['role'] == entry['role'] and
                owner['status'] == 1, 'Manifest owner changed')
        present = validate_existing(entry, token_details(newapi, entry))
        if not present and not rollback:
            additions[owner['id']] = additions.get(owner['id'], 0) + 1
        if entry['kind'] == 'customer':
            require(portal_current(portal, entry) in (entry['old_token'], entry['new_token']),
                    'Portal credential CAS conflict (no credentials were overwritten)')
    require(all(owners[user_id]['pat_count'] + count <= MAX_PATS for user_id, count in additions.items()),
            'Official PAT row limit would be exceeded')


def main():
    os.umask(0o077)
    args = parse_args()
    _, source, state_dir = validate_environment(args)
    newapi, portal = Database(args.newapi_db), Database(args.portal_db)
    source_text = source.read_text()
    config = {'mode': args.mode, 'newapi_db': args.newapi_db, 'portal_db': args.portal_db,
              'portal_container': args.portal_container, 'env_source': str(source)}
    if not args.apply:
        preview = plan(args, source_text, newapi, portal, config)
        print(json.dumps({'dry_run': True, 'customers': len(preview['entries']) - 1,
                          'skipped_inactive': len(preview['skipped_users']),
                          'admin': 1, 'database_writes': False}))
        return
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    require(stat.S_IMODE(state_dir.stat().st_mode) == 0o700 and state_dir.stat().st_uid == os.geteuid(),
            'State directory must be owned by current user and mode 0700')
    lock_path = state_dir / '.lock'
    with lock_path.open('a+') as lock:
        os.chmod(lock_path, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        path = state_dir / 'manifest.json'
        if path.exists():
            private_file(path)
            manifest = json.loads(path.read_text())
        else:
            require(not args.rollback, 'No manifest is available for rollback')
            manifest = plan(args, source_text, newapi, portal, config)
            save_manifest(path, manifest)
        preflight_manifest(manifest, source_text, config, newapi, portal, args.rollback)
        require(args.rollback or manifest['status'] != 'rolled_back',
                'This run was rolled back; use a new state directory for a new migration')
        if args.rollback:
            for entry in reversed(manifest['entries']):
                if entry['kind'] == 'customer':
                    portal_cas(portal, entry, rollback=True)
                if validate_existing(entry, token_details(newapi, entry)):
                    newapi.sql('''BEGIN; SELECT id FROM users WHERE %s FOR UPDATE;
                      DELETE FROM user_access_tokens WHERE user_id=%d AND token_hash=%s
                        AND name=%s; COMMIT;''' % (owner_guard(entry), entry['newapi_user_id'],
                        literal(entry['token_hash']), literal(entry['name'])))
                entry['status'] = 'rolled_back'
                save_manifest(path, manifest)
            candidate = state_dir / 'portal.env.candidate'
            if candidate.exists():
                candidate.unlink()
            manifest['status'] = 'rolled_back'
        else:
            for entry in manifest['entries']:
                entry['pat_id'] = insert_pat(newapi, entry)
                entry['status'] = 'pat_inserted'
                save_manifest(path, manifest)
                if entry['kind'] == 'customer':
                    portal_cas(portal, entry)
                    entry['status'] = 'portal_updated'
                    save_manifest(path, manifest)
            admin = next(entry for entry in manifest['entries'] if entry['kind'] == 'admin')
            atomic_private(state_dir / 'portal.env.candidate', candidate_env(source_text, admin['new_token']))
            manifest['status'] = 'complete'
        save_manifest(path, manifest)
        print(json.dumps({'status': manifest['status'], 'customers': len(manifest['entries']) - 1,
                          'skipped_inactive': len(manifest['skipped_users']), 'admin': 1,
                          'manifest_private': True, 'candidate_env_private': not args.rollback}))


if __name__ == '__main__':
    try:
        main()
    except MigrationError as error:
        print(json.dumps({'error': str(error)}), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        # Do not accidentally expose subprocess input or source data via repr.
        print(json.dumps({'error': 'Migration stopped', 'error_type': type(error).__name__}), file=sys.stderr)
        sys.exit(1)
