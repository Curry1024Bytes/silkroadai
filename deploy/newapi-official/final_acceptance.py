#!/usr/bin/env python3
"""Audit original rows and temporary Key cleanup before opening public traffic.

All database operations are reads. Portal user cache timestamps can refresh as a
normal consequence of the startup balance scheduler; compare every original user
field against the checksummed dump and report that narrow metadata difference.
Never print database rows, tokens, environment values, or private command output.
"""
import argparse
import collections
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

import invariants
import migrate_credentials as migration
import pricing_compat


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def command(args, stdin=None):
    result = subprocess.run(args, stdin=stdin, capture_output=True)
    require(result.returncode == 0, 'Private database read failed')
    return result.stdout


def user_rows(data):
    lines = data.decode().splitlines()
    starts = [i for i, line in enumerate(lines) if line.startswith('COPY public.users (')]
    require(len(starts) == 1, 'Unexpected user archive structure')
    start = starts[0]
    columns = lines[start].split('(', 1)[1].split(') FROM stdin;')[0].split(', ')
    rows = {}
    for line in lines[start + 1:]:
        if line == '\\.':
            return columns, rows
        values = line.split('\t')
        require(len(values) == len(columns), 'Unexpected user archive row')
        row = dict(zip(columns, values))
        require(row['id'] not in rows, 'Duplicate user archive identity')
        rows[row['id']] = row
    raise RuntimeError('User archive terminator missing')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    root = args.root.resolve()
    require(root.parent == Path('/opt/new-api-migration'), 'Unexpected migration root')
    evidence = root / 'cutover'
    require((evidence / 'MAINTENANCE_ACTIVE').exists() and
            not (evidence / 'PORTAL_TRAFFIC_MAY_HAVE_STARTED').exists(), 'Public traffic must remain held')
    checksums = json.loads((evidence / 'SHA256SUMS.json').read_text())
    for name, expected in checksums.items():
        path = evidence / name
        require(path.stat().st_size == expected['size'] and
                hashlib.sha256(path.read_bytes()).hexdigest() == expected['sha256'], 'Backup evidence differs')
    manifest = json.loads((evidence / 'credential-migration/manifest.json').read_text())
    http = json.loads((evidence / 'portal-verification.json').read_text())
    require(http['passed'] and not http['cleanup_pending'] and http['inference_requests'] == 0 and
            all(check['passed'] for check in http['checks']), 'Portal HTTP verification did not pass')
    credential = json.loads((evidence / 'credential-verification.json').read_text())
    require(credential['success'] and credential['model_calls'] == 0 and
            credential['mutating_http_calls'] == 0, 'Credential verification did not pass')

    with (evidence / 'portal.dump').open('rb') as source:
        before_columns, before = user_rows(command(['docker', 'exec', '-i', 'silkroadai-portal-db',
            'pg_restore', '--data-only', '--table=users', '--file=-'], stdin=source))
    after_columns, after = user_rows(command(['docker', 'exec', 'silkroadai-portal-db', 'sh', '-lc',
        'exec pg_dump --data-only --table=users --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"']))
    require(before_columns == after_columns and set(before) == set(after), 'User identities or columns changed')
    customers = {entry['portal_user_id']: entry for entry in manifest['entries'] if entry['kind'] == 'customer'}
    started = datetime.fromisoformat(json.loads(command(['docker', 'inspect', '--format',
        '{{json .State.StartedAt}}', 'silkroadai-portal']))[:26]).replace(tzinfo=timezone.utc)
    def timestamp(value):
        return datetime.fromisoformat(value).replace(tzinfo=timezone.utc)
    changes = collections.Counter()
    metadata_users = 0
    for user_id, original in before.items():
        actual = after[user_id]
        metadata = set()
        for column in before_columns:
            if actual[column] == original[column]:
                continue
            changes[column] += 1
            if column == 'newapi_access_token':
                require(user_id in customers and actual[column] == customers[user_id]['new_token'],
                        'A user credential differs from the authorized migration')
            else:
                require(column in ('updated_at', 'newapi_cached_at'), 'A protected user field changed')
                metadata.add(column)
        if metadata:
            require(metadata == {'updated_at', 'newapi_cached_at'}, 'Unexpected cache metadata change')
            cached = timestamp(actual['newapi_cached_at'])
            updated = timestamp(actual['updated_at'])
            require(original['status'] == 'active' and original['newapi_user_id'] != '\\N' and
                    original['balance_alert_threshold_cny'] != '\\N' and
                    Decimal(original['balance_alert_threshold_cny']) > 0 and
                    (original['balance_alert_last_sent_at'] == '\\N' or
                     timestamp(original['balance_alert_last_sent_at']) < started - timedelta(days=1)),
                    'Cache refresh does not match a startup scheduler candidate')
            require(started <= cached <= updated <= datetime.now(timezone.utc) and
                    updated - cached < timedelta(minutes=1), 'Cache refresh timestamps differ from startup')
            metadata_users += 1
    require(changes['newapi_access_token'] == len(customers), 'Customer credential count differs')
    users = {'user_count': len(before), 'business_fields_preserved': True,
             'changed_column_counts': dict(changes),
             'cache_metadata_users': metadata_users,
             'cache_metadata': 'Startup balance scheduler candidates refreshed only cached_at and Prisma updated_at',
             'cache_scheduler_candidates_and_times_verified': True}

    baseline_newapi = json.loads((evidence / 'newapi-invariants.json').read_text())
    baseline_portal = json.loads((evidence / 'portal-invariants.json').read_text())
    newapi = invariants.verify('postgres', baseline_newapi, post_smoke=True)
    other_portal = {**baseline_portal, 'tables': {k: v for k, v in baseline_portal['tables'].items() if k != 'users'}}
    portal = invariants.verify('silkroadai-portal-db', other_portal, post_smoke=True)
    portal.update({'protected_tables': len(baseline_portal['tables']), 'user_business_audit': users})

    journal = json.loads((evidence / http['cleanup_journal']).read_text())
    require(journal['state'] == 'cleaned' and not journal['cleanup_pending'], 'Temporary Key cleanup incomplete')
    pdb = migration.Database('silkroadai-portal-db')
    ndb = migration.Database('postgres')
    portal_ids = baseline_portal['tables']['newapi_tokens']['row_ids']
    newapi_ids = baseline_newapi['tables']['tokens']['row_ids']
    portal_extra = pdb.json("BEGIN READ ONLY; SELECT coalesce(json_agg(t),'[]'::json) FROM ("
        "SELECT k.id::text,k.user_id::text,k.newapi_token_id,k.key_alias,k.status::text,u.newapi_user_id "
        "FROM newapi_tokens k JOIN users u ON u.id=k.user_id WHERE k.id NOT IN (" +
        ','.join(migration.literal(i) + '::uuid' for i in portal_ids) + ')) t; COMMIT;')
    require(len(portal_extra) == 1, 'Unexpected added Portal Key rows')
    key = portal_extra[0]
    require(key['id'] == journal['created_id'] and key['user_id'] == journal['owner_id'] and
            key['key_alias'] == journal['renamed_alias'] and key['status'] == 'disabled',
            'Added Portal Key ownership or cleanup differs')
    upstream_extra = ndb.json("BEGIN READ ONLY; SELECT coalesce(json_agg(t),'[]'::json) FROM ("
        "SELECT id,user_id,name,deleted_at IS NOT NULL AS deleted,used_quota,unlimited_quota FROM tokens "
        'WHERE id NOT IN (' + ','.join(str(int(i)) for i in newapi_ids) + ')) t; COMMIT;')
    require(len(upstream_extra) == 1, 'Unexpected added upstream Key rows')
    key_upstream = upstream_extra[0]
    require(key_upstream['id'] == key['newapi_token_id'] and key_upstream['user_id'] == key['newapi_user_id'] and
            key_upstream['name'] in (journal['alias'], journal['renamed_alias']) and key_upstream['deleted'] and
            key_upstream['used_quota'] == 0 and key_upstream['unlimited_quota'],
            'Added upstream Key ownership or cleanup differs')
    migration_status = pdb.json('''BEGIN READ ONLY; SELECT json_build_object(
        'applied', count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
        'unfinished', count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL),
        'historical_rolled_back', count(*) FILTER (WHERE rolled_back_at IS NOT NULL))
        FROM "_prisma_migrations"; COMMIT;''')
    require(migration_status['applied'] == 93 and migration_status['unfinished'] == 0,
            'Unexpected Portal migration state')
    pricing_compat.verify(lambda sql: ndb.sql(sql).strip())
    result = {'success': True, 'completed_at': int(time.time()), 'model_calls': 0,
              'newapi': newapi, 'portal': portal, 'migrations': migration_status,
              'original_upstream_keys': len(newapi_ids), 'original_portal_keys': len(portal_ids),
              'added_upstream_keys': 1, 'added_portal_keys': 1, 'added_keys_owner_confirmed': True,
              'added_keys_used_quota': 0, 'added_active_keys_remaining': 0, 'astra_compatibility_verified': True}
    migration.atomic_private(evidence / 'data-acceptance.json', json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'success': False, 'error_type': type(error).__name__,
                          'error': str(error) if isinstance(error, RuntimeError) else 'Private audit failed'}))
        raise SystemExit(1)
