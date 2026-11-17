#!/usr/bin/env python3
"""Exercise the upgrade and complete restore on a second isolated database pair.

Never addresses production containers or published ports. Provider credentials
are removed before either application is started. Keep all evidence private.
"""
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
import urllib.request

from invariants import capture, verify
import pricing_compat

ROOT=Path(sys.argv[1]).resolve()
if ROOT.parent!=Path('/opt/new-api-migration') or not (ROOT/'backup-online/portal.dump').is_file():
    raise SystemExit('An existing migration backup directory is required')
os.umask(0o077)
STAGE=ROOT/'rollback-rehearsal'
STAGE.mkdir(mode=0o700)
PREFIX='newapi-rc51-rollback'
NET=PREFIX+'-net'
NA=PREFIX+'-pg'
PG=PREFIX+'-portal-pg'
APP=PREFIX+'-app'
OFFICIAL='calciumion/new-api:v1.0.0-rc.51@sha256:d6effcdbc58175494765c0cc5954bdacb2300516eec79ba1a9c61f9b9fae7b49'
OLD='sha256:f468814239b28ee83479bb47422e2b1e39460f8c14f9e8c53b0e3628bd5fe673'


def run(args,**kwargs):
    proc=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,**kwargs)
    if proc.returncode:
        (STAGE/'private-error.log').write_bytes(proc.stderr if isinstance(proc.stderr,bytes) else proc.stderr.encode())
        raise RuntimeError('Rehearsal command failed; diagnostics private')
    return proc.stdout


def sql(name,statement):
    return run(['docker','exec','-i',name,'sh','-lc',
        'exec psql -XqAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],
        input=statement,text=True).strip()


def ready():
    app=json.loads(run(['docker','inspect',APP],text=True))[0]
    ip=app['NetworkSettings']['Networks'][NET]['IPAddress']
    for _ in range(120):
        try:
            with urllib.request.urlopen('http://'+ip+':3000/api/status',timeout=2) as response:
                result=json.load(response)
            if result.get('success'):
                return result['data']['version']
        except Exception:
            pass
        time.sleep(.5)
    raise RuntimeError('Isolated application did not become ready')


run(['docker','network','create','--internal',NET])
password=secrets.token_hex(32)
for name,image,db in [(NA,'postgres:15','new-api'),(PG,'postgres:16-alpine','portal')]:
    env=STAGE/(name+'.env')
    env.write_text('POSTGRES_USER=root\nPOSTGRES_DB='+db+'\nPOSTGRES_PASSWORD='+password+'\n')
    run(['docker','run','-d','--name',name,'--network',NET,'--env-file',str(env),image])
    for _ in range(60):
        if subprocess.run(['docker','exec',name,'pg_isready','-U','root','-d',db],capture_output=True).returncode==0:
            break
        time.sleep(.5)
    else:
        raise RuntimeError('Isolated database did not become ready')
    filename='new-api.dump' if name==NA else 'portal.dump'
    with (ROOT/'backup-online'/filename).open('rb') as source:
        run(['docker','exec','-i',name,'pg_restore','--exit-on-error','--no-owner','-U','root','-d',db],stdin=source)

# Capture AFTER sanitizing confidential provider settings, BEFORE the upgrade.
sql(NA,"UPDATE channels SET key='rollback-no-provider-credentials',base_url='http://127.0.0.1:9',header_override='',param_override='',setting=json_build_object('task_plugin_key',setting::json->>'task_plugin_key')::text,settings='{}'; UPDATE tasks SET private_data=(private_data::jsonb-'key')::json; DELETE FROM system_tasks;")
baselines={}
for kind,name in [('newapi',NA),('portal',PG)]:
    baseline=capture(name,kind)
    baselines[kind]=baseline
    (STAGE/(kind+'-before.json')).write_text(json.dumps(baseline,indent=2)+'\n')
    dump=STAGE/(kind+'.dump')
    with dump.open('wb') as output:
        proc=subprocess.run(['docker','exec',name,'sh','-lc',
            'exec pg_dump --format=custom --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],stdout=output,stderr=subprocess.PIPE)
        if proc.returncode:
            raise RuntimeError('Isolated quiescent dump failed')
    with dump.open('rb') as source:
        run(['docker','exec','-i',name,'pg_restore','--file=/dev/null'],stdin=source)

sql(NA,'UPDATE channels SET type=61 WHERE type=65;')
pricing_compat.install(lambda statement:sql(NA,statement))
original=json.loads((ROOT/'backup-online/new-api.inspect.json').read_text())[0]
oldenv=dict(value.split('=',1) for value in original['Config']['Env'] if '=' in value)
appenv={key:oldenv[key] for key in ['SESSION_SECRET','CRYPTO_SECRET','TZ'] if key in oldenv}
appenv.update(SQL_DSN='postgresql://root:'+password+'@'+NA+':5432/new-api',REDIS_CONN_STRING='',
    UPDATE_TASK='false',NODE_TYPE='master',CHANNEL_TEST_ENABLED='false',
    CHANNEL_UPSTREAM_MODEL_UPDATE_TASK_ENABLED='false',CHANNEL_UPDATE_FREQUENCY='0',SESSION_COOKIE_SECURE='false')
env=STAGE/'app.env'
env.write_text(''.join(key+'='+value+'\n' for key,value in appenv.items()))


def start(image):
    run(['docker','run','-d','--name',APP,'--network',NET,'--env-file',str(env),image])
    return ready()


if start(OFFICIAL)!='v1.0.0-rc.51':
    raise RuntimeError('Wrong official image in isolated rehearsal')
pricing_compat.verify(lambda statement:sql(NA,statement))
upgrade=verify(NA,baselines['newapi'])
# Deliberately exercise writes in BOTH databases before restoring the pair.
# These are only isolated copies; original rows must be exact after restore.
sql(NA,"UPDATE users SET quota=quota+1 WHERE id=1;")
sql(PG,"UPDATE users SET newapi_access_token='rollback-rehearsal-only' WHERE newapi_user_id IS NOT NULL;")
run(['docker','stop','-t','630',APP])
run(['docker','rm',APP])
restored=[]
for kind,name in [('newapi',NA),('portal',PG)]:
    dump=STAGE/(kind+'.dump')
    expected=hashlib.sha256(dump.read_bytes()).hexdigest()
    with dump.open('rb') as source:
        run(['docker','exec','-i',name,'pg_restore','--file=/dev/null'],stdin=source)
    if hashlib.sha256(dump.read_bytes()).hexdigest()!=expected:
        raise RuntimeError('Isolated backup changed before restore')
    sql(name,'DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
    with dump.open('rb') as source:
        run(['docker','exec','-i',name,'sh','-lc',
            'exec pg_restore --exit-on-error --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],stdin=source)
    restored.append(verify(name,baselines[kind]))
if sql(NA,"SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='user_access_tokens';")!='0':
    raise RuntimeError('Official-only PAT table survived the old-schema restore')
old_version=start(OLD)
for kind,name in [('newapi',NA),('portal',PG)]:
    verify(name,baselines[kind])
result={'official_upgrade':upgrade,'restored':restored,'custom_version_after_restore':old_version,
        'old_image_started':True,'official_only_table_removed':True,'provider_calls_disabled':True}
(STAGE/'result.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
