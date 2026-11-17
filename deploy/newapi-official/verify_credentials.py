#!/usr/bin/env python3
"""HTTP/DB verification of one persisted scoped-PAT migration.

Run beside migrate_credentials.py on the Docker host. No model requests, user
creation, forced legacy retirement, or production env editing occur. Default
verification does not mutate inference keys. --temporary-key-crud explicitly
creates one zero-quota, restricted, short-lived key and deletes it, including
when a subsequent check fails. Original inference keys are never mutated.
Official GET endpoints may update their own PAT last-used/audit
metadata. Reports contain only version, run identity, counts and booleans.

The original inference-key bytes are compared in memory against the matching
database dump, without printing either side. Successful reports are written
atomically with mode 0600; a failed run replaces any previous success report.
"""

import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import migrate_credentials as migration


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('backup_dir', type=Path)
    parser.add_argument('--mode', required=True, choices=['rehearsal', 'production'])
    parser.add_argument('--newapi-db', required=True)
    parser.add_argument('--portal-db', required=True)
    parser.add_argument('--newapi-app', required=True)
    parser.add_argument('--state-dir', type=Path)
    parser.add_argument('--base-url', help='Optional explicit HTTP origin on this Docker host')
    parser.add_argument('--expected-version', default='v1.0.0-rc.51')
    parser.add_argument('--temporary-key-crud', action='store_true',
                        help='Explicitly test create/reveal/rename/delete of one restricted zero-quota key')
    return parser.parse_args()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward an Authorization header to an unexpected origin.
        return None


def temporary_key_crud(db, entry, user, good, report):
    name = 'pat-check-' + secrets.token_hex(12)
    renamed = name + '-ok'
    owner = entry['newapi_user_id']
    result = {'requested': True, 'success': False, 'created': 0, 'deleted': 0,
              'active_remaining': None, 'zero_quota': True, 'short_lived': True}
    report['temporary_key_crud'] = result

    def rows():
        return db.json('''SELECT COALESCE(json_agg(x), '[]'::json) FROM (
          SELECT id,name,key,remain_quota,unlimited_quota,expired_time,
                 model_limits_enabled,model_limits,allow_ips,deleted_at
          FROM tokens WHERE user_id=%d AND name IN (%s,%s)) x;''' %
                       (owner, migration.literal(name), migration.literal(renamed)))

    migration.require(not rows(), 'Temporary inference-key name already exists')
    try:
        expires = int(time.time()) + 120
        payload = {'name': name, 'expired_time': expires, 'remain_quota': 0,
                   'unlimited_quota': False, 'model_limits_enabled': True,
                   'model_limits': name, 'allow_ips': '127.0.0.1/32',
                   'group': user['group']}
        good('/api/token/', entry, 'POST', payload)
        found = rows()
        migration.require(len(found) == 1 and found[0]['deleted_at'] is None,
                          'Temporary inference key was not uniquely created')
        record = found[0]
        result['created'] = 1
        migration.require(record['remain_quota'] == 0 and record['unlimited_quota'] is False and
                          record['expired_time'] == expires and record['model_limits_enabled'] is True and
                          record['model_limits'] == name and record['allow_ips'] == '127.0.0.1/32',
                          'Temporary inference-key restrictions differ')
        identity = record['id']
        listed = good('/api/token/search?keyword=' + name + '&p=1&page_size=100', entry)
        migration.require(sum(item.get('id') == identity for item in listed['items']) == 1,
                          'Temporary inference key is absent from its owner list')
        revealed = good('/api/token/' + str(identity) + '/key', entry, 'POST')
        if isinstance(revealed, dict):
            revealed = revealed.get('key')
        migration.require(isinstance(revealed, str) and revealed == record['key'],
                          'Temporary inference-key reveal differs')
        original = good('/api/token/' + str(identity), entry)
        update = {key: original[key] for key in
                  ['id', 'expired_time', 'remain_quota', 'unlimited_quota', 'model_limits_enabled',
                   'model_limits', 'allow_ips', 'group']}
        update['name'] = renamed
        good('/api/token/', entry, 'PUT', update)
        migration.require(good('/api/token/' + str(identity), entry)['name'] == renamed,
                          'Temporary inference-key rename differs')
        result['success'] = True
    finally:
        # Query by a random exact owner/name pair even if POST timed out after
        # committing. Delete only this run's key through its owner's API.
        found = rows()
        result['created'] = len(found)
        for record in found:
            if record['deleted_at'] is None:
                good('/api/token/' + str(record['id']), entry, 'DELETE')
        remaining = rows()
        result['deleted'] = sum(record['deleted_at'] is not None for record in remaining)
        result['active_remaining'] = sum(record['deleted_at'] is None for record in remaining)
        migration.require(result['active_remaining'] == 0, 'Temporary inference-key cleanup failed')
        migration.require(not result['success'] or result['created'] == result['deleted'] == 1,
                          'Unexpected temporary inference-key cleanup count')


def original_inference_keys(db, dump):
    with dump.open('rb') as source:
        result = subprocess.run(
            ['docker', 'exec', '-i', db.name, 'pg_restore', '--data-only', '--table=tokens', '--file=-'],
            stdin=source, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
    migration.require(result.returncode == 0, 'Cannot read inference-key backup')
    expected = {}
    columns = None
    for line in result.stdout.decode().splitlines():
        if columns is None:
            match = re.match(r'COPY public\.tokens \((.*)\) FROM stdin;', line)
            if match:
                columns = [column.strip().strip('"') for column in match.group(1).split(',')]
            continue
        if line == r'\.':
            break
        row = dict(zip(columns, line.split('\t')))
        migration.require(row['id'].isdigit(), 'Invalid original inference-key identity')
        expected[row['id']] = row['key']
    migration.require(columns is not None and expected, 'Inference-key backup is empty or unsupported')
    # COPY uses exactly the same escaping as the dump. Keys remain private.
    actual = {}
    sql = 'COPY (SELECT id,key FROM tokens WHERE id IN (%s) ORDER BY id) TO STDOUT;' % ','.join(expected)
    for line in db.sql(sql).splitlines():
        identity, key = line.split('\t')
        actual[identity] = key
    migration.require(actual == expected, 'Original inference keys changed or disappeared')
    return len(expected)


def main():
    os.umask(0o077)
    args = arguments()
    root = args.backup_dir.resolve()
    migration.require(root.parent == Path('/opt/new-api-migration'), 'Unexpected backup root')
    section = 'rehearsal' if args.mode == 'rehearsal' else 'cutover'
    backup = root / ('backup-online' if args.mode == 'rehearsal' else 'cutover')
    state = (args.state_dir or root / section / 'credential-migration').resolve()
    report_path = root / section / 'credential-verification.json'
    report = {'version': 1, 'success': False, 'mode': args.mode, 'run_id': None,
              'manifest_sha256': None, 'source_env_sha256': None, 'official_version': None,
              'expected_version': args.expected_version, 'phase': 'preflight',
              'started_at': int(time.time()), 'completed_at': None, 'model_calls': 0,
              'mutating_http_calls': 0, 'temporary_key_crud': {'requested': args.temporary_key_crud,
                                                            'success': False}}
    # Invalidate old success before any manifest/target/HTTP check can fail.
    migration.atomic_private(report_path, json.dumps(report, indent=2) + '\n')
    phase = 'preflight'
    try:
        migration.require(state.is_relative_to(root), 'Manifest must be beneath the backup root')
        path = state / 'manifest.json'
        migration.private_file(path)
        manifest_text = path.read_text()
        manifest = json.loads(manifest_text)
        report['run_id'] = manifest['run_id']
        report['manifest_sha256'] = migration.digest(manifest_text)
        report['source_env_sha256'] = manifest['source_sha256']
        config = manifest.get('config', {})
        migration.require(manifest.get('status') == 'complete' and manifest.get('version') == migration.VERSION,
                          'Migration manifest is not complete')
        migration.require(config.get('mode') == args.mode and config.get('newapi_db') == args.newapi_db and
                          config.get('portal_db') == args.portal_db and
                          config.get('env_source') == str(backup / 'portal.env'), 'Manifest target differs')
        if args.mode == 'production':
            migration.require((backup / 'BACKUP_COMPLETE').is_file(), 'Quiescent backup marker missing')
        names = [args.newapi_db, args.portal_db, args.newapi_app]
        for name in names:
            migration.require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', name) is not None,
                              'Invalid container name')
            migration.require(args.mode != 'rehearsal' or name.startswith('newapi-rc51-rehearsal-'),
                              'Rehearsal cannot target production containers')
            migration.require(args.mode != 'production' or 'rehearsal' not in name,
                              'Production cannot target rehearsal containers')
        app = migration.inspect(args.newapi_app)
        migration.require(app['State']['Running'], 'Official app is not running')
        if args.mode == 'rehearsal':
            networks = app['NetworkSettings']['Networks']
            migration.require(len(networks) == 1 and not app['HostConfig'].get('PortBindings'),
                              'Rehearsal app must have one network and no published ports')
            for network in networks:
                migration.require(json.loads(migration.run(['docker', 'network', 'inspect', network]))[0]['Internal'],
                                  'Rehearsal network must be internal')
        if args.base_url:
            origin = urllib.parse.urlsplit(args.base_url)
            migration.require(origin.scheme == 'http' and origin.hostname and not origin.username and
                              not origin.password and origin.path in ('', '/') and not origin.query and
                              not origin.fragment, 'Base URL must be a plain Docker-host HTTP origin')
            address = ipaddress.ip_address(origin.hostname)
            migration.require(address.is_private or address.is_loopback, 'Base URL must address a private Docker host')
            base = args.base_url.rstrip('/')
        else:
            networks = app['NetworkSettings']['Networks']
            migration.require(len(networks) == 1, 'Multiple app networks require an explicit base URL')
            address = next(iter(networks.values()))['IPAddress']
            migration.require(bool(address), 'App has no IPv4 address; supply a base URL')
            base = 'http://' + address + ':3000'
        source = backup / 'portal.env'
        migration.private_file(source)
        newapi, portal = migration.Database(args.newapi_db), migration.Database(args.portal_db)
        migration.preflight_manifest(manifest, source.read_text(), config, newapi, portal, False)
        customers = [entry for entry in manifest['entries'] if entry['kind'] == 'customer']
        admins = [entry for entry in manifest['entries'] if entry['kind'] == 'admin']
        migration.require(bool(customers) and len(admins) == 1, 'Unexpected manifest owner counts')
        migration.require(all(entry['role'] == 1 for entry in customers), 'Customer is not a common user')
        migration.require(len({entry['newapi_user_id'] for entry in customers}) == len(customers),
                          'Customer owners are not unique')
        admin = admins[0]
        migration.require(admin['role'] == 100, 'Administrator is not root')
        for entry in manifest['entries']:
            migration.require(migration.validate_existing(entry, migration.token_details(newapi, entry)) is not None,
                              'Manifest PAT is absent')
            if entry['kind'] == 'customer':
                migration.require(migration.portal_current(portal, entry) == entry['new_token'],
                                  'Portal credential is not the migrated PAT')
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

        def request(endpoint, entry=None, method='GET', payload=None):
            headers = {}
            if entry:
                headers = {'Authorization': 'Bearer ' + entry['new_token'],
                           'New-Api-User': str(entry['newapi_user_id'])}
            data = None
            if payload is not None:
                headers['Content-Type'] = 'application/json'
                data = json.dumps(payload).encode()
            if method != 'GET':
                report['mutating_http_calls'] += 1
            req = urllib.request.Request(base + endpoint, headers=headers, method=method, data=data)
            try:
                with opener.open(req, timeout=15) as response:
                    return response.status, json.loads(response.read())
            except urllib.error.HTTPError as response:
                return response.code, json.loads(response.read())

        def good(endpoint, entry=None, method='GET', payload=None):
            status, body = request(endpoint, entry, method, payload)
            migration.require(status == 200 and body.get('success') is True, 'HTTP verification failed')
            return body.get('data')

        phase = 'official-version'
        version = good('/api/status').get('version')
        migration.require(isinstance(version, str) and version.lstrip('v') == args.expected_version.lstrip('v'),
                          'Unexpected official version')
        report['official_version'] = version
        phase = 'customer-authentication'
        for entry in customers:
            user = good('/api/user/self', entry)
            migration.require(user.get('id') == entry['newapi_user_id'] and
                              user.get('username') == entry['username'] and user.get('role') == 1,
                              'Customer authenticated as a different owner or role')
            migration.require(isinstance(good('/api/token/?p=1&page_size=100', entry).get('items'), list),
                              'Invalid customer inference-key list')
            good('/api/user/self/groups', entry)
        if args.temporary_key_crud:
            phase = 'temporary-inference-key-crud'
            entry = customers[0]
            temporary_key_crud(newapi, entry, good('/api/user/self', entry), good, report)
        phase = 'administrator-authentication'
        admin_user = good('/api/user/self', admin)
        migration.require(admin_user.get('id') == admin['newapi_user_id'] and
                          admin_user.get('username') == admin['username'] and admin_user.get('role') == 100,
                          'Administrator authenticated as a different owner or role')
        admin_routes = ['/api/user/?p=1&page_size=100', '/api/channel/?p=1&page_size=100',
                        '/api/channel/models_enabled', '/api/option/', '/api/log/?p=1&page_size=1']
        for endpoint in admin_routes:
            good(endpoint, admin)
        phase = 'scope-isolation'
        for entry in customers:
            migration.require(request('/api/user/?p=1&page_size=1', entry)[0] == 403,
                              'Customer can access administrator route')
        phase = 'original-inference-keys'
        count = original_inference_keys(newapi, backup / 'new-api.dump')
        migration.require(path.read_text() == manifest_text, 'Migration manifest changed during verification')
        report.update({'success': True, 'phase': 'complete', 'customers': len(customers),
                       'skipped_inactive': len(manifest['skipped_users']), 'customer_gets': len(customers) * 3,
                       'customer_common_role_confirmed': len(customers), 'admin_gets': len(admin_routes) + 1,
                       'customer_admin_denied': len(customers), 'original_inference_keys_unchanged': count,
                       'completed_at': int(time.time())})
    except Exception:
        report['phase'] = phase
        migration.atomic_private(report_path, json.dumps(report, indent=2) + '\n')
        raise migration.MigrationError('Credential verification failed during ' + phase) from None
    migration.atomic_private(report_path, json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    try:
        main()
    except migration.MigrationError as error:
        print(json.dumps({'error': str(error)}), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print(json.dumps({'error': 'Credential verification stopped', 'error_type': type(error).__name__}),
              file=sys.stderr)
        sys.exit(1)
