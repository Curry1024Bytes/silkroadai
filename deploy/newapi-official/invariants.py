#!/usr/bin/env python3
"""Capture/verify database digests without printing account or provider secrets.

Use while applications are stopped. The original columns are retained in the
manifest, so an upstream migration adding columns does not hide changed values.
New upstream option keys are allowed; every original option must remain exact.
The sole channel conversion (65 -> official TaskPlugin 61) is normalized.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess

NEWAPI_TABLES = ['users', 'tokens', 'channels', 'logs', 'tasks', 'group_user_ratios']
PORTAL_TABLES = [
    'users', 'accounts', 'ledger_entries', 'orders', 'recharge_logs',
    'newapi_tokens', 'channel_groups', 'catalog_models', 'catalog_prices',
    'pricing_cost_rules', 'pricing_cost_rule_revisions', 'pricing_sale_rules',
    'pricing_billing_groups', 'pricing_rule_publications', 'user_tier_multipliers',
    'system_configs', 'seedance_video_tasks', 'kling_video_tasks',
    'image_tasks', 'customer_provisioning_jobs', '_prisma_migrations',
]


def ident(value):
    return '"' + value.replace('"', '""') + '"'


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def sql(container, statement):
    proc = subprocess.run([
        'docker', 'exec', '-i', container, 'sh', '-lc',
        'exec psql -XqAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
    ], input="SET TIME ZONE 'UTC';\n" + statement, text=True, capture_output=True)
    if proc.returncode:
        raise RuntimeError('Database invariant query failed (details suppressed)')
    return json.loads(proc.stdout)


def digest(container, table, columns, kind, option_keys=None, row_ids=None):
    fields = []
    for column in columns:
        if kind == 'newapi' and table == 'channels' and column == 'type':
            fields.append('CASE WHEN type=65 THEN 61 ELSE type END AS type')
        elif kind == 'newapi' and table == 'options' and column == 'value':
            # The separately verified Astra override preserves the old actual
            # tariff under the official cache normalizer. Every other model
            # in these two dictionaries must retain its original value.
            fields.append("CASE WHEN key IN ('billing_setting.billing_expr','billing_setting.billing_mode') "
                          "THEN (value::jsonb - 'gpt-6-astra')::text ELSE value END AS value")
        else:
            fields.append(ident(column))
    where = ''
    if option_keys is not None:
        where = ' WHERE key IN (' + ','.join(literal(k) for k in option_keys) + ')'
    if row_ids is not None:
        where = ' WHERE id IN (' + ','.join(literal(k) for k in row_ids) + ')' if row_ids else ' WHERE false'
    query = 'SELECT ' + ','.join(fields) + ' FROM ' + ident(table) + where
    return sql(container, "SELECT json_build_object('count',count(*),'digest',"
               "md5(COALESCE(string_agg(md5(row_to_json(t)::text),',' "
               "ORDER BY md5(row_to_json(t)::text)),''))) FROM (" + query + ') t;')


def capture(container, kind):
    tables = NEWAPI_TABLES if kind == 'newapi' else PORTAL_TABLES
    result = {'format': 1, 'kind': kind, 'tables': {}}
    for table in tables + (['options'] if kind == 'newapi' else []):
        columns = sql(container, 'SELECT COALESCE(json_agg(column_name ORDER BY ordinal_position),'
                      "'[]'::json) FROM information_schema.columns WHERE table_schema='public' "
                      'AND table_name=' + literal(table) + ';')
        if not columns:
            raise RuntimeError('Missing protected table: ' + table)
        # Internal credentials intentionally rotate. All other user attributes,
        # including password, billing, balance, group and account status, stay exact.
        if kind == 'portal' and table == 'users':
            columns = [c for c in columns if c != 'newapi_access_token']
        entry = {'columns': columns}
        if table == 'options':
            entry['option_keys'] = sql(container, 'SELECT json_agg(key ORDER BY key) FROM options;')
        entry.update(digest(container, table, columns, kind, entry.get('option_keys')))
        if (kind,table) in [('newapi','tokens'),('portal','newapi_tokens')]:
            entry['row_ids']=sql(container, 'SELECT COALESCE(json_agg(id),\'[]\'::json) FROM '+ident(table)+';')
            entry['stable_columns']=[c for c in columns if not (kind=='newapi' and c=='accessed_time')]
            entry['stable_digest']=digest(container,table,entry['stable_columns'],kind,row_ids=entry['row_ids'])
        result['tables'][table] = entry
    return result


def verify(container, baseline, post_smoke=False):
    failures = []
    for table, expected in baseline['tables'].items():
        if post_smoke and 'row_ids' in expected:
            actual=digest(container,table,expected['stable_columns'],baseline['kind'],row_ids=expected['row_ids'])
            target=expected['stable_digest']
        else:
            actual = digest(container, table, expected['columns'], baseline['kind'], expected.get('option_keys'))
            target={k: expected[k] for k in ['count', 'digest']}
        if actual != target:
            failures.append(table)
    if failures:
        raise RuntimeError('Protected database values changed in: ' + ','.join(failures))
    return {'kind': baseline['kind'], 'protected_tables': len(baseline['tables']), 'unchanged': True,'post_smoke':post_smoke}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['capture', 'verify'])
    parser.add_argument('--container', required=True)
    parser.add_argument('--kind', choices=['newapi', 'portal'])
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--post-smoke', action='store_true', help='Allow added test Key audit rows and token access timestamps; protect every original Key value/quota/status')
    args = parser.parse_args()
    os.umask(0o077)
    if args.mode == 'capture':
        if not args.kind or args.manifest.exists():
            raise SystemExit('A kind and a new manifest path are required')
        result = capture(args.container, args.kind)
        args.manifest.write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({'kind': args.kind, 'captured_tables': len(result['tables'])}))
    else:
        print(json.dumps(verify(args.container, json.loads(args.manifest.read_text()),args.post_smoke)))
