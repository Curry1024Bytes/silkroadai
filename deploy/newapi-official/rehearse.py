#!/usr/bin/env python3
"""Run on the VPS: restore an online backup into an isolated, credential-free clone."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
import urllib.request

IMAGE = "calciumion/new-api:v1.0.0-rc.51@sha256:d6effcdbc58175494765c0cc5954bdacb2300516eec79ba1a9c61f9b9fae7b49"
ROOT = Path(sys.argv[1]).resolve()
if ROOT.parent != Path('/opt/new-api-migration') or not (ROOT / 'backup-online/new-api.dump').is_file():
    raise SystemExit('Expected an existing migration backup directory')
os.umask(0o077)
PREFIX = 'newapi-rc51-rehearsal'
DB = PREFIX + '-pg'
APP = PREFIX + '-app'
NET = PREFIX + '-net'


def run(args, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)


def query(sql):
    return run(['docker', 'exec', DB, 'psql', '-U', 'root', '-d', 'new-api', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], text=True).stdout


def invariant():
    # Compare all account balances, passwords, API credentials and consumption history,
    # without exporting any of their plaintext values to a terminal.
    sql = """select json_build_object(
      'users', (select count(*) from users),
      'user_money_hash', (select md5(string_agg(concat_ws('|',id,quota,used_quota,aff_quota,aff_history,password),',' order by id)) from users),
      'tokens', (select count(*) from tokens),
      'token_hash', (select md5(string_agg(concat_ws('|',id,key,status,remain_quota,used_quota,unlimited_quota,"group"),',' order by id)) from tokens),
      'logs', (select count(*) from logs),
      'log_hash', (select md5(string_agg(id::text || ':' || quota::text,',' order by id)) from logs),
      'tasks', (select count(*) from tasks),
      'task_hash', (select md5(string_agg(concat_ws('|',id,task_id,platform,status,quota),',' order by id)) from tasks),
      'quota_total', (select sum(quota) from users),
      'used_quota_total', (select sum(used_quota) from users))"""
    return json.loads(query(sql))


def verify():
    before = json.loads((ROOT / 'rehearsal/before.json').read_text())
    app = json.loads(run(['docker', 'inspect', APP], text=True).stdout)[0]
    ip = app['NetworkSettings']['Networks'][NET]['IPAddress']
    # Docker internal networks intentionally do not publish host ports.
    status = None
    for _ in range(90):
        try:
            with urllib.request.urlopen('http://' + ip + ':3000/api/status', timeout=2) as response:
                status = json.load(response)
            if status.get('success') is True:
                break
        except Exception:
            pass
        time.sleep(1)
    else:
        raise SystemExit('Official rehearsal app did not become ready; inspect its private logs')
    after = invariant()
    (ROOT / 'rehearsal/after.json').write_text(json.dumps(after, indent=2) + '\n')
    if before != after:
        raise SystemExit('Account / credential / history invariant changed in rehearsal')
    version = status.get('data', {}).get('version')
    if version != 'v1.0.0-rc.51':
        raise SystemExit('Unexpected official runtime version: ' + str(version))
    report = {'version': version, 'invariants_preserved': True, 'counts': {k: v for k, v in after.items() if not k.endswith('_hash')}, 'network_internal': True, 'provider_calls_disabled': True}
    (ROOT / 'rehearsal/result.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if '--verify-existing' in sys.argv:
    verify()
    raise SystemExit(0)


for name in (DB, APP):
    if subprocess.run(['docker', 'inspect', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        raise SystemExit('Rehearsal resources already exist; inspect them before retrying')
run(['docker', 'network', 'create', '--internal', NET])
stage = ROOT / 'rehearsal'
stage.mkdir(mode=0o700)
(stage / 'data').mkdir(mode=0o700)
(stage / 'logs').mkdir(mode=0o700)
password = secrets.token_hex(32)
(stage / 'postgres.env').write_text('POSTGRES_USER=root\nPOSTGRES_DB=new-api\nPOSTGRES_PASSWORD=' + password + '\n')
run(['docker', 'run', '-d', '--name', DB, '--network', NET, '--env-file', str(stage / 'postgres.env'), 'postgres:15'])
for _ in range(60):
    if subprocess.run(['docker', 'exec', DB, 'pg_isready', '-U', 'root', '-d', 'new-api'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        break
    time.sleep(1)
else:
    raise SystemExit('Rehearsal PostgreSQL did not become ready')
with (ROOT / 'backup-online/new-api.dump').open('rb') as backup:
    run(['docker', 'exec', '-i', DB, 'pg_restore', '--exit-on-error', '--no-owner', '-U', 'root', '-d', 'new-api'], stdin=backup)
before = invariant()
(stage / 'before.json').write_text(json.dumps(before, indent=2) + '\n')
if query("SELECT count(*) FROM information_schema.columns WHERE table_name='users' AND column_name IN ('quota','used_quota','aff_quota','aff_history') AND data_type='bigint'").strip() != '4':
    raise SystemExit('The four official user quota columns must be bigint before startup')
# The real upstream credentials are never made available to the rehearsal app.
# Together with an internal Docker network, this prevents startup jobs from
# reaching a provider (including adapters exposed on the Docker host).
query("UPDATE channels SET key='rehearsal-no-provider-credentials', base_url='http://127.0.0.1:9', header_override='', param_override='', setting=json_build_object('task_plugin_key',setting::json->>'task_plugin_key')::text, settings='{}'; UPDATE channels SET type=61 WHERE type=65; UPDATE tasks SET private_data=(private_data::jsonb - 'key')::json; DELETE FROM system_tasks;")
original = json.loads((ROOT / 'backup-online/new-api.inspect.json').read_text())[0]
old_env = dict(v.split('=', 1) for v in original['Config']['Env'] if '=' in v)
app_env = {k: old_env[k] for k in ('SESSION_SECRET', 'CRYPTO_SECRET', 'TZ') if k in old_env}
app_env.update(SQL_DSN='postgresql://root:' + password + '@' + DB + ':5432/new-api', REDIS_CONN_STRING='', UPDATE_TASK='false', NODE_TYPE='master', CHANNEL_TEST_ENABLED='false', CHANNEL_UPSTREAM_MODEL_UPDATE_TASK_ENABLED='false', CHANNEL_UPDATE_FREQUENCY='0', SESSION_COOKIE_SECURE='false')
(stage / 'app.env').write_text(''.join(k + '=' + v + '\n' for k, v in app_env.items()))
run(['docker', 'run', '-d', '--name', APP, '--network', NET, '--env-file', str(stage / 'app.env'), '-v', str(stage / 'data') + ':/data:Z', '-v', str(stage / 'logs') + ':/app/logs:Z', IMAGE, '--log-dir', '/app/logs'])
verify()
