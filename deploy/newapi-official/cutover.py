#!/usr/bin/env python3
"""Production cutover primitives. Invoke only after the isolated rehearsal passes.

Backup must run after both applications stop. 'rollback' is only safe before the
new Portal accepts traffic; after that preserve data and assess new writes first.
All subprocess output and environment snapshots stay in the private evidence dir.
"""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import ssl
import subprocess
import sys
import time
import urllib.request
from invariants import capture, verify
import pricing_compat

OFFICIAL = 'calciumion/new-api:v1.0.0-rc.51@sha256:d6effcdbc58175494765c0cc5954bdacb2300516eec79ba1a9c61f9b9fae7b49'
OLD_NEWAPI = 'sha256:f468814239b28ee83479bb47422e2b1e39460f8c14f9e8c53b0e3628bd5fe673'
SOURCE_SHA = '7a65f7b644b53b7ba2be039d3e7932f1716faae7'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('root', type=Path)
parser.add_argument('phase', choices=['backup', 'official', 'portal', 'release', 'rollback'])
parser.add_argument('--portal-image')
parser.add_argument('--source-sha')
a = parser.parse_args()
os.umask(0o077)
root = a.root.resolve()
if root.parent != Path('/opt/new-api-migration') or not (root/'backup-online').is_dir():
    raise SystemExit('Invalid migration root')
ev = root/'cutover'
ev.mkdir(exist_ok=True, mode=0o700)


def run(args, **kwargs):
    proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
    if proc.returncode:
        # Do not propagate SQL, environment, or returned API bodies to the log.
        with (ev/'private-command-error.log').open('ab') as out:
            out.write(proc.stderr if isinstance(proc.stderr, bytes) else proc.stderr.encode())
        raise RuntimeError('Command failed; private diagnostics saved')
    return proc.stdout


def inspect(name):
    return json.loads(run(['docker','inspect',name], text=True))[0]


def sql(container, statement):
    return run(['docker','exec','-i',container,'sh','-lc',
        'exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],
        input=statement, text=True).strip()


def write_state(phase):
    (root/'phase').write_text(phase+'\n')
    print(json.dumps({'phase':phase,'utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}), flush=True)


def status_ready(url, expected=None):
    for _ in range(120):
        try:
            with urllib.request.urlopen(url,timeout=2) as res:
                body=res.read()
                if expected:
                    value=json.loads(body)
                    if value.get('success') and value.get('data',{}).get('version')==expected:
                        return
                elif res.status==200:
                    return
        except Exception:
            pass
        time.sleep(.5)
    raise RuntimeError('Runtime readiness timed out')


def newapi_compose():
    return ['docker','compose','--env-file','/opt/new-api/.env','-p','new-api','-f','/opt/new-api/docker-compose.yml']


def portal_compose(files=None):
    if files is None:
        files=json.loads((ev/'portal-files.json').read_text())
    cmd=['docker','compose','--project-directory','/opt/silkroadai-portal','--env-file','/opt/silkroadai-portal/.env','-p','silkroadai-portal']
    for file in files:
        cmd+=['-f',file]
    return cmd


def assert_idle():
    busy=sql('silkroadai-portal-db',"SELECT (SELECT count(*) FROM pricing_publish_coordinator WHERE active_job_id IS NOT NULL)+(SELECT count(*) FROM image_tasks WHERE status NOT IN ('SUCCESS','FAILURE'))+(SELECT count(*) FROM batches WHERE status NOT IN ('completed','failed','expired','cancelled'))+(SELECT count(*) FROM customer_provisioning_jobs WHERE status NOT IN ('completed','failed'))+(SELECT count(*) FROM channel_group_retirement_jobs WHERE status NOT IN ('succeeded','cancelled'))+(SELECT count(*) FROM seedance_video_tasks WHERE status NOT IN ('completed','failed'))+(SELECT count(*) FROM kling_video_tasks WHERE status NOT IN ('completed','failed'))+(SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NULL AND rolled_back_at IS NULL);")
    if busy!='0' or sql('postgres',"SELECT count(*) FROM tasks WHERE status NOT IN ('SUCCESS','FAILURE');")!='0':
        raise RuntimeError('Work remains in progress; refusing cutover')


def portal_credential_digest():
    return sql('silkroadai-portal-db', "SELECT md5(COALESCE(string_agg(md5(row_to_json(t)::text),',' ORDER BY id),'')) FROM (SELECT id,newapi_access_token FROM users) t;")


def assert_no_direct_connections():
    # The public Nginx gate cannot drain requests arriving through an SSH
    # forward. Require the new-api listener itself to have no connections.
    pid=inspect('new-api')['State']['Pid']
    quiet=0
    for _ in range(60):
        connections=run(['nsenter','-t',str(pid),'-n','ss','-Hnt','state',
                         'established','( sport = :3000 )'],text=True).strip()
        quiet=quiet+1 if not connections else 0
        if quiet>=3:
            return
        time.sleep(1)
    raise RuntimeError('Direct new-api connections remain; refusing shutdown')


def credential_ready():
    from migrate_credentials import env_values
    path=ev/'credential-migration/manifest.json'
    manifest=json.loads(path.read_text())
    if (manifest.get('status')!='complete' or
            manifest.get('config',{}).get('mode')!='production' or
            any(item['status'] not in ('portal_updated','pat_inserted') for item in manifest['entries'])):
        raise RuntimeError('Production credential migration is incomplete')
    admin=[item for item in manifest['entries'] if item['kind']=='admin']
    config=env_values(Path('/opt/silkroadai-portal/.env').read_text())
    if len(admin)!=1 or config.get('NEWAPI_ADMIN_TOKEN')!=admin[0]['new_token'] or config.get('NEWAPI_DISTRIBUTION')!='official':
        raise RuntimeError('Production credential environment is not installed')
    return manifest


def credential_acceptance():
    manifest=credential_ready()
    result=json.loads((ev/'credential-verification.json').read_text())
    count=sum(item['kind']=='customer' for item in manifest['entries'])
    original=json.loads((ev/'newapi-invariants.json').read_text())['tables']['tokens']['count']
    expected={'version':1,'success':True,'mode':'production','phase':'complete',
              'run_id':manifest['run_id'],
              'manifest_sha256':hashlib.sha256((ev/'credential-migration/manifest.json').read_bytes()).hexdigest(),
              'source_env_sha256':manifest['source_sha256'],'official_version':'v1.0.0-rc.51',
              'expected_version':'v1.0.0-rc.51','customers':count,
              'skipped_inactive':len(manifest['skipped_users']),'customer_gets':count*3,
              'customer_common_role_confirmed':count,'admin_gets':6,
              'customer_admin_denied':count,'original_inference_keys_unchanged':original,'model_calls':0}
    if any(result.get(key)!=value for key,value in expected.items()):
        raise RuntimeError('Production credential HTTP acceptance is missing or stale')
    if result.get('completed_at',0)<manifest['updated_at']:
        raise RuntimeError('Credential verification predates the migration')
    crud=result.get('temporary_key_crud')
    if not isinstance(crud,dict) or type(crud.get('requested')) is not bool:
        raise RuntimeError('Credential verification mode is missing')
    if crud['requested']:
        expected_crud={'requested':True,'success':True,'created':1,'deleted':1,
                       'active_remaining':0,'zero_quota':True,'short_lived':True}
        expected_calls=4
    else:
        expected_crud={'requested':False,'success':False}
        expected_calls=0
    if (set(crud)!=set(expected_crud) or
            any(type(crud.get(key)) is not type(value) or crud.get(key)!=value
                for key,value in expected_crud.items()) or
            type(result.get('mutating_http_calls')) is not int or
            result['mutating_http_calls']!=expected_calls):
        raise RuntimeError('Temporary credential Key verification or cleanup failed')


def assert_not_released():
    if (ev/'PORTAL_TRAFFIC_MAY_HAVE_STARTED').exists() or (ev/'BACKUP_ABORTED').exists():
        raise RuntimeError('This migration run is terminal; do not reuse its backup')


def maintenance_begin():
    paths=['/etc/nginx/conf.d/llmroute.club.conf','/etc/nginx/conf.d/llmroute-api.conf']
    manifest=[]
    for index,name in enumerate(paths):
        path=Path(name)
        value=path.read_text()
        if 'newapi-official-maintenance' in value:
            raise RuntimeError('A maintenance configuration already exists')
        saved=ev/('nginx-'+str(index)+'.conf')
        saved.write_text(value)
        manifest.append({'path':name,'backup':str(saved),'sha256':hashlib.sha256(value.encode()).hexdigest()})
    (ev/'nginx-files.json').write_text(json.dumps(manifest))
    try:
        for item in manifest:
            path=Path(item['path'])
            value=Path(item['backup']).read_text()
            changed,count=re.subn(r'(server_name\s+[^;]+;)',r'\1\n    return 503; # newapi-official-maintenance',value)
            if count!=2:
                raise RuntimeError('Unexpected Nginx server structure')
            path.write_text(changed)
        run(['nginx','-t'])
        old_workers=worker_pids()
        if not old_workers:
            raise RuntimeError('No original Nginx worker processes found')
        run(['systemctl','reload','nginx'])
        # Check the actual listeners: systemctl reload may return before the
        # master has processed HUP. An empty 'shutting down' list is not proof.
        for _ in range(30):
            if maintenance_http():
                break
            time.sleep(1)
        else:
            raise RuntimeError('The public maintenance listeners did not activate')
        # Nginx's old workers finish existing upstream requests while the new
        # workers reject new public work. Never force-kill a paid request.
        for _ in range(650):
            if not old_workers.intersection(worker_pids()):
                (ev/'MAINTENANCE_ACTIVE').write_text('New public requests blocked; old workers drained.\n')
                return
            time.sleep(1)
        raise RuntimeError('Existing Nginx workers did not drain')
    except BaseException:
        maintenance_end()
        raise


def worker_pids():
    output=run(['ps','-C','nginx','-o','pid=,args='],text=True)
    return {int(line.split()[0]) for line in output.splitlines()
            if 'worker process' in line}


def maintenance_http():
    for host in ['llmroute.club','www.llmroute.club','api.llmroute.club']:
        for secure in [False,True]:
            connection=(http.client.HTTPSConnection('127.0.0.1',443,timeout=2,
                        context=ssl._create_unverified_context()) if secure
                        else http.client.HTTPConnection('127.0.0.1',80,timeout=2))
            try:
                connection.request('GET','/login',headers={'Host':host})
                response=connection.getresponse()
                response.read()
                if response.status!=503:
                    return False
            except Exception:
                return False
            finally:
                connection.close()
    return True


def maintenance_end():
    manifest=ev/'nginx-files.json'
    if not manifest.exists():
        return
    for item in json.loads(manifest.read_text()):
        original=Path(item['backup']).read_bytes()
        if hashlib.sha256(original).hexdigest()!=item['sha256']:
            raise RuntimeError('Nginx backup checksum mismatch')
        Path(item['path']).write_bytes(original)
    run(['nginx','-t'])
    run(['systemctl','reload','nginx'])
    (ev/'MAINTENANCE_ACTIVE').unlink(missing_ok=True)


def verify_backups():
    for filename,expected in json.loads((ev/'SHA256SUMS.json').read_text()).items():
        path=ev/filename
        if not path.is_file() or path.stat().st_size!=expected['size'] or hashlib.sha256(path.read_bytes()).hexdigest()!=expected['sha256']:
            raise RuntimeError('Backup checksum mismatch; refusing destructive rollback')
    # Decode all archive entries and data, not only the table of contents.
    for name,filename in [('postgres','new-api.dump'),('silkroadai-portal-db','portal.dump')]:
        with (ev/filename).open('rb') as source:
            run(['docker','exec','-i',name,'pg_restore','--file=/dev/null'],stdin=source)
    run(['tar','-tzf',str(ev/'data.tar.gz')])


def rollback_preflight():
    verify_backups()
    old_portal=json.loads((ev/'silkroadai-portal.inspect.json').read_text())['Image']
    for image in [OLD_NEWAPI,old_portal]:
        available=json.loads(run(['docker','image','inspect',image],text=True))[0]
        if available['Id']!=image:
            raise RuntimeError('The immutable rollback image is unavailable')
    files=json.loads((ev/'portal-files.json').read_text())
    saved=[str(ev/('portal-compose-'+str(index)+Path(name).suffix))
           for index,name in enumerate(files)]
    run(portal_compose(saved+[str(ev/'rollback-images.json')])+['config','--quiet'])
    run(['docker','compose','--project-directory','/opt/new-api',
         '--env-file',str(ev/'new-api.env'),'-p','new-api','-f',str(ev/'new-api-compose.yml'),
         '-f',str(ev/'rollback-newapi-image.json'),'config','--quiet'])
    if (ev/'data-before-rollback').exists():
        raise RuntimeError('Rollback data staging directory already exists')


if a.phase=='backup':
    if (ev/'BACKUP_COMPLETE').exists() or (ev/'BACKUP_ABORTED').exists():
        raise SystemExit('Quiescent backup already exists; do not overwrite it')
    if inspect('new-api')['Image']!=OLD_NEWAPI:
        raise SystemExit('The live new-api image differs from the audited rollback baseline')
    assert_idle()
    if sql('postgres','SELECT count(*) FROM group_user_ratios;')!='0':
        raise SystemExit('Fork-only per-user ratios must be explicitly migrated')
    if (sql('postgres','SELECT count(*) FROM channels WHERE type NOT IN (1,65);')!='0'
            or sql('postgres','SELECT id FROM channels WHERE type=65 ORDER BY id;')!='13'):
        raise SystemExit('An unaudited channel type appeared')
    for name in ['new-api','postgres','redis','silkroadai-portal','silkroadai-portal-db']:
        (ev/(name+'.inspect.json')).write_text(json.dumps(inspect(name)))
    p=inspect('silkroadai-portal')
    if inspect('new-api')['Config']['Labels']['com.docker.compose.project.config_files']!='/opt/new-api/docker-compose.yml':
        raise SystemExit('Unexpected new-api Compose stack')
    files=p['Config']['Labels']['com.docker.compose.project.config_files'].split(',')
    (ev/'portal-files.json').write_text(json.dumps(files))
    for index,name in enumerate(files):
        shutil.copyfile(name,ev/('portal-compose-'+str(index)+Path(name).suffix))
    mounted={m['Destination']:m['Source'] for m in inspect('new-api')['Mounts']}
    if mounted.get('/data')!='/opt/new-api/data':
        raise SystemExit('Unexpected persistent data mount')
    rollback_override=ev/'rollback-images.json'
    rollback_override.write_text(json.dumps({'services':{'portal':{'image':p['Image']}}}))
    rollback_newapi=ev/'rollback-newapi-image.json'
    rollback_newapi.write_text(json.dumps({'services':{'new-api':{'image':OLD_NEWAPI}}}))
    for source,dest in [('/opt/new-api/.env','new-api.env'),('/opt/new-api/docker-compose.yml','new-api-compose.yml'),('/opt/silkroadai-portal/.env','portal.env')]:
        shutil.copyfile(source,ev/dest)
        os.chmod(ev/dest,0o600)
    run(['docker','tag',p['Image'],'silkroadai-portal-portal:rollback-official-newapi-20261117'])
    run(['docker','tag',OLD_NEWAPI,'new-api-custom:rollback-official-20261117'])
    write_state('stopping-for-quiescent-backup')
    try:
        maintenance_begin()
        assert_idle()
        run(['docker','stop','-t','630','silkroadai-portal'])
        assert_no_direct_connections()
        run(['docker','stop','-t','630','new-api'])
        assert_idle()
        for kind,db in [('newapi','postgres'),('portal','silkroadai-portal-db')]:
            (ev/(kind+'-invariants.json')).write_text(json.dumps(capture(db,kind),indent=2)+'\n')
        (ev/'portal-original-credentials.digest').write_text(portal_credential_digest()+'\n')
        for name,outname in [('postgres','new-api.dump'),('silkroadai-portal-db','portal.dump')]:
            with (ev/(outname+'.tmp')).open('wb') as out:
                result=subprocess.run(['docker','exec',name,'sh','-lc','exec pg_dump --format=custom --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],stdout=out,stderr=subprocess.PIPE)
            if result.returncode:
                raise RuntimeError('Database backup failed')
            # The same container supplies the correct PostgreSQL major version.
            with (ev/(outname+'.tmp')).open('rb') as source:
                run(['docker','exec','-i',name,'pg_restore','--list'],stdin=source)
            (ev/(outname+'.tmp')).replace(ev/outname)
        run(['tar','-C','/opt/new-api','-czf',str(ev/'data.tar.gz'),'data'])
        run(['tar','-tzf',str(ev/'data.tar.gz')])
        summary={}
        # Include every file needed to restore configuration and verify the
        # databases, so missing configuration is detected before DROP SCHEMA.
        for path in sorted(ev.iterdir()):
            if path.is_file() and path.name not in ['private-command-error.log','MAINTENANCE_ACTIVE','SHA256SUMS.json']:
                data=path.read_bytes()
                summary[path.name]={'size':len(data),'sha256':hashlib.sha256(data).hexdigest()}
        (ev/'SHA256SUMS.json').write_text(json.dumps(summary,indent=2)+'\n')
        verify_backups()
        (ev/'BACKUP_COMPLETE').write_text('Both applications stopped; backups validated.\n')
        write_state('quiescent-backup-complete')
    except BaseException:
        # The original services will accept new writes again. This snapshot
        # must never be reused as an automatic rollback point afterwards.
        (ev/'BACKUP_COMPLETE').unlink(missing_ok=True)
        (ev/'BACKUP_ABORTED').write_text('Original services resumed; do not reuse this run.\n')
        run(['docker','start','new-api'])
        run(['docker','start','silkroadai-portal'])
        maintenance_end()
        write_state('backup-failed-original-services-restarted')
        raise
elif a.phase=='official':
    assert_not_released()
    if not (ev/'BACKUP_COMPLETE').exists() or inspect('silkroadai-portal')['State']['Running'] or inspect('new-api')['State']['Running']:
        raise SystemExit('A quiescent backup and stopped Portal are required')
    if not (ev/'MAINTENANCE_ACTIVE').exists() or not maintenance_http():
        raise SystemExit('The public maintenance gate must remain active')
    compose=Path('/opt/new-api/docker-compose.yml')
    value=compose.read_text()
    needle='image: new-api-custom:latest'
    if value.count(needle)!=1:
        raise SystemExit('Unexpected Compose image declaration')
    value=value.replace(needle,'image: '+OFFICIAL)
    needle='      SESSION_COOKIE_SECURE: "false"'
    if value.count(needle)!=1:
        raise SystemExit('Unexpected Compose cookie declaration')
    value=value.replace(needle,needle+'\n      CHANNEL_TEST_ENABLED: "false"\n      CHANNEL_UPSTREAM_MODEL_UPDATE_TASK_ENABLED: "false"\n      CHANNEL_UPDATE_FREQUENCY: "0"')
    compose.write_text(value)
    os.chmod(compose,0o600)
    run(newapi_compose()+['config','--quiet'])
    changed=sql('postgres',"UPDATE channels SET type=61 WHERE type=65 RETURNING id;")
    if changed!='13':
        raise RuntimeError('Unexpected audited channel conversion')
    (ev/'channel-type-remap.txt').write_text(changed+'\n')
    pricing_compat.install(lambda statement: sql('postgres',statement))
    run(newapi_compose()+['up','-d','--no-deps','--no-build','--pull','never','new-api'])
    status_ready('http://172.17.0.1:3000/api/status','v1.0.0-rc.51')
    print(json.dumps(verify('postgres',json.loads((ev/'newapi-invariants.json').read_text()))))
    write_state('official-ready-portal-held')
elif a.phase=='portal':
    assert_not_released()
    if not (ev/'BACKUP_COMPLETE').exists() or not a.portal_image or not a.source_sha:
        raise SystemExit('Backup, verified Portal image and source SHA required')
    image=json.loads(run(['docker','image','inspect',a.portal_image],text=True))[0]
    if (a.source_sha!=SOURCE_SHA or image['Config'].get('Labels',{}).get('org.opencontainers.image.revision')!=a.source_sha or image['Architecture']!='amd64'):
        raise SystemExit('Portal image provenance check failed')
    if inspect('silkroadai-portal')['State']['Running']:
        raise SystemExit('Portal must remain stopped until credential installation is verified')
    status_ready('http://172.17.0.1:3000/api/status','v1.0.0-rc.51')
    credential_ready()
    if 'NEWAPI_DISTRIBUTION=official' not in Path('/opt/silkroadai-portal/.env').read_text().splitlines():
        raise SystemExit('Official distribution must be explicit')
    release=root/'portal-release.json'
    release.write_text(json.dumps({'services':{'portal':{'image':a.portal_image,'stop_grace_period':'630s'}}},indent=2)+'\n')
    files=json.loads((ev/'portal-files.json').read_text())
    files=files+[str(release)]
    run(portal_compose(files)+['config','--quiet'])
    print(json.dumps(verify('silkroadai-portal-db',json.loads((ev/'portal-invariants.json').read_text()))))
    pricing_compat.verify(lambda statement: sql('postgres',statement))
    if not (ev/'MAINTENANCE_ACTIVE').exists() or not maintenance_http():
        raise SystemExit('Public maintenance gate is required before starting Portal')
    run(portal_compose(files)+['up','-d','--no-deps','--no-build','--pull','never','-t','630','portal'])
    status_ready('http://127.0.0.1:3002/login')
    (ev/'portal-provenance.json').write_text(json.dumps({'image':a.portal_image,'image_id':image['Id'],'source_sha':a.source_sha})+'\n')
    write_state('portal-ready-verification-pending')
elif a.phase=='release':
    assert_not_released()
    live=inspect('silkroadai-portal')
    if not live['State']['Running'] or not (ev/'MAINTENANCE_ACTIVE').exists() or not maintenance_http():
        raise SystemExit('A healthy Portal behind maintenance is required')
    provenance=json.loads((ev/'portal-provenance.json').read_text())
    if provenance['source_sha']!=SOURCE_SHA or live['Image']!=provenance['image_id']:
        raise SystemExit('The tested Portal image differs from the running image')
    credential_ready()
    credential_acceptance()
    status_ready('http://172.17.0.1:3000/api/status','v1.0.0-rc.51')
    pricing_compat.verify(lambda statement: sql('postgres',statement))
    acceptance=json.loads((ev/'HTTP_ACCEPTANCE.json').read_text())
    if (acceptance.get('status')!='passed' or acceptance.get('source_sha')!=SOURCE_SHA
            or acceptance.get('image_id')!=live['Image'] or not acceptance.get('no_paid_requests')
            or not all(acceptance.get(key) for key in ['credentials_checked','portal_checked','invariants_checked'])):
        raise SystemExit('Independent HTTP and data acceptance is required before release')
    for name,expected in acceptance['evidence_sha256'].items():
        path=(ev/name).resolve()
        if not path.is_relative_to(ev) or hashlib.sha256(path.read_bytes()).hexdigest()!=expected:
            raise SystemExit('Acceptance evidence changed')
    status_ready('http://127.0.0.1:3002/login')
    # Once the public gate opens, database restoration must never silently
    # discard new customer writes. Post-release rollback requires an audit.
    (ev/'PORTAL_TRAFFIC_MAY_HAVE_STARTED').write_text(time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())+'\n')
    maintenance_end()
    write_state('official-released')
elif a.phase=='rollback':
    if (ev/'PORTAL_TRAFFIC_MAY_HAVE_STARTED').exists():
        raise SystemExit('Traffic may have resumed; assess new writes before restoring a database')
    if not (ev/'BACKUP_COMPLETE').exists():
        raise SystemExit('No complete quiescent backup to restore')
    rollback_preflight()
    if not (ev/'MAINTENANCE_ACTIVE').exists():
        raise SystemExit('Keep the public maintenance gate closed for rollback')
    for name in ['silkroadai-portal','new-api']:
        run(['docker','stop','-t','630',name])
    for name,filename in [('postgres','new-api.dump'),('silkroadai-portal-db','portal.dump')]:
        sql(name,'DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
        with (ev/filename).open('rb') as source:
            run(['docker','exec','-i',name,'sh','-lc','exec pg_restore --exit-on-error --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],stdin=source)
    for filename,dest in [('new-api.env','/opt/new-api/.env'),('new-api-compose.yml','/opt/new-api/docker-compose.yml'),('portal.env','/opt/silkroadai-portal/.env')]:
        shutil.copyfile(ev/filename,dest)
        os.chmod(dest,0o600)
    files=json.loads((ev/'portal-files.json').read_text())
    for index,name in enumerate(files):
        shutil.copyfile(ev/('portal-compose-'+str(index)+Path(name).suffix),name)
    shutil.move('/opt/new-api/data',ev/'data-before-rollback')
    run(['tar','-C','/opt/new-api','-xzf',str(ev/'data.tar.gz')])
    run(newapi_compose()+['-f',str(ev/'rollback-newapi-image.json'),'up','-d','--no-deps','--no-build','--pull','never','new-api'])
    status_ready('http://172.17.0.1:3000/api/status')
    for kind,db in [('newapi','postgres'),('portal','silkroadai-portal-db')]:
        print(json.dumps(verify(db,json.loads((ev/(kind+'-invariants.json')).read_text()))))
    if portal_credential_digest()!=(ev/'portal-original-credentials.digest').read_text().strip():
        raise RuntimeError('Original Portal credentials were not restored exactly')
    run(portal_compose(files+[str(ev/'rollback-images.json')])+['up','-d','--no-deps','--no-build','--pull','never','portal'])
    status_ready('http://127.0.0.1:3002/login')
    (ev/'PORTAL_TRAFFIC_MAY_HAVE_STARTED').write_text('Original services restored; rollback run is terminal.\n')
    maintenance_end()
    write_state('rolled-back-before-traffic')
