#!/usr/bin/env python3
"""Verify an internal Portal after rehearsal/cutover, without inference calls.

Default mode only reads public pages, authenticated catalog/Key/admin APIs and
the Portal database. --apply-smoke additionally creates one randomly named Key,
reveals it, changes its alias, and revokes that same Key in a finally block.
Portal's normal create handler can refresh group-mirror metadata; business group
configuration and every pre-existing Key are checked for unexpected changes.

Run on the Docker host, for example::

    python3 verify_portal.py /opt/new-api-migration/<run> \
      --base-url http://127.0.0.1:3002 --portal-db silkroadai-portal-db \
      --env-source /opt/silkroadai-portal/.env --apply-smoke

Only loopback HTTP targets are accepted. Five-minute session JWTs and existing
API Keys stay in memory. The evidence and cleanup journal contain no credentials
and are written atomically with mode 0600. No login password, OAuth, payment,
model-generation request, group-sync admin endpoint or existing-Key mutation is
performed. An interrupted/uncertain create is never automatically repeated.
"""

import argparse
import base64
import hashlib
import hmac
import json
from pathlib import Path
import re
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import migrate_credentials as migration


PLATFORM = '00000000-0000-0000-0000-000000000001'
MAX_BODY = 16 * 1024 * 1024
def json_text(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'))


def fingerprint(rows):
    return hashlib.sha256(json_text(sorted(rows, key=lambda row: row['id'])).encode()).hexdigest()


def is_uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        return False


def wire_key(value):
    migration.require(isinstance(value, str) and bool(value.strip()), 'API Key is missing')
    return value if value.startswith('sk-') else 'sk-' + value


def sign_session(secret, user, now=None):
    migration.require(isinstance(secret, str) and bool(secret), 'Session secret is missing')
    migration.require(is_uuid(user.get('id')) and type(user.get('session_token_version')) is int,
                      'Invalid session identity')
    now = int(time.time()) if now is None else now
    encode = lambda value: base64.urlsafe_b64encode(value).rstrip(b'=').decode('ascii')
    payload = {'sub': user['id'], 'tv': user['session_token_version'],
               'iss': 'silkroadai-portal', 'iat': now, 'exp': now + 300}
    message = encode(json_text({'alg': 'HS256'}).encode()) + '.' + encode(json_text(payload).encode())
    return message + '.' + encode(hmac.new(secret.encode(), message.encode(), hashlib.sha256).digest())


def validate_base_url(value):
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
    except ValueError:
        raise migration.MigrationError('Invalid internal Portal URL') from None
    migration.require(parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', 'localhost', '::1')
                      and parsed.username is None and parsed.password is None
                      and parsed.path in ('', '/') and not parsed.query and not parsed.fragment
                      and (port is None or 1 <= port <= 65535),
                      'Portal URL must be a loopback HTTP origin')
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, '', '', ''))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):
        return None


class InternalHTTP:
    def __init__(self, base_url, timeout=30):
        self.base_url = validate_base_url(base_url)
        self.timeout = timeout
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, method, path, *, session=None, bearer=None, body=None):
        allowed = path in ('/login', '/models', '/pricing', '/docs', '/v1/models',
                           '/api/portal/keys', '/api/portal/models/pricing',
                           '/api/admin/customers?page=1&page_size=1',
                           '/api/admin/dashboard?days=1')
        allowed = allowed or re.fullmatch(r'/api/portal/keys/[0-9a-f-]{36}(?:/key)?', path) is not None
        migration.require(allowed, 'Unexpected Portal smoke endpoint')
        migration.require(method in ('GET', 'POST', 'PATCH', 'DELETE'), 'Unexpected HTTP method')
        headers = {'Accept': 'application/json', 'Cache-Control': 'no-cache'}
        if session:
            headers['Cookie'] = 'silkroad_session=' + session
        if bearer:
            headers['Authorization'] = 'Bearer ' + bearer
        if method != 'GET':
            headers.update({'Origin': self.base_url, 'Referer': self.base_url + '/keys',
                            'Content-Type': 'application/json'})
        data = json_text(body).encode() if body is not None else None
        request = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            try:
                response = self.opener.open(request, timeout=self.timeout)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                content = response.read(MAX_BODY + 1)
                migration.require(len(content) <= MAX_BODY, 'Portal response exceeds size limit')
                return response.code, response.headers.get('Content-Type', ''), content
        except migration.MigrationError:
            raise
        except (OSError, urllib.error.URLError, ValueError):
            raise migration.MigrationError('Internal Portal HTTP request failed') from None


class PortalDatabase:
    """All script-side SQL is explicitly read-only; HTTP owns temporary Key CRUD."""

    def __init__(self, container):
        self.database = migration.Database(container)

    def query(self, name, statement):
        return self.database.json('BEGIN READ ONLY;\n/* portal-smoke:' + name + ' */\n'
                                  + statement + '\nCOMMIT;')

    def identities(self, customer_id=None):
        selected = ' AND u.id=' + migration.literal(customer_id) + '::uuid' if customer_id else ''
        return self.query('identities', """
SELECT json_build_object(
 'customer', (SELECT row_to_json(p) FROM (
  SELECT u.id, u.role::text, u.tenant_id, u.session_token_version, u.allowed_tier_keys
  FROM users u WHERE u.status='active' AND u.role='customer'
  AND coalesce(u.tenant_id, '%s'::uuid)='%s'::uuid
  AND u.newapi_user_id IS NOT NULL AND nullif(u.newapi_access_token,'') IS NOT NULL
  AND EXISTS (SELECT 1 FROM newapi_tokens k WHERE k.user_id=u.id AND k.status='active'
              AND k.key_alias NOT LIKE 'portal-internal%%')%s
  ORDER BY u.created_at,u.id LIMIT 1) p),
 'admin', (SELECT row_to_json(p) FROM (
  SELECT id, role::text, tenant_id, session_token_version FROM users
  WHERE status='active' AND role IN ('admin','superadmin')
  AND coalesce(tenant_id,'%s'::uuid)='%s'::uuid
  ORDER BY CASE WHEN role='superadmin' THEN 0 ELSE 1 END,created_at,id LIMIT 1) p));
""" % (PLATFORM, PLATFORM, selected, PLATFORM, PLATFORM))

    def keys(self, user_id):
        return self.query('keys', """
SELECT coalesce(json_agg(t ORDER BY t.id),'[]'::json) FROM (
 SELECT id,user_id,newapi_token_id,newapi_token_value,key_alias,status::text,tier,
        model_limits_enabled,model_limits
 FROM newapi_tokens WHERE user_id=%s::uuid) t;
""" % migration.literal(user_id))

    def groups(self):
        return self.query('groups', """
SELECT coalesce(json_agg(t ORDER BY t.id),'[]'::json) FROM (
 SELECT id,key,display_name,newapi_group,enabled,is_default,newapi_channel_ids,tier_level,
        upstream_present,purchase_rate::text
 FROM channel_groups WHERE tenant_id='%s'::uuid) t;
""" % PLATFORM)


class PortalSmoke:
    def __init__(self, database, http, secret, evidence_dir, *, apply=False, customer_id=None):
        self.database, self.http, self.secret = database, http, secret
        self.evidence_dir = Path(evidence_dir)
        self.apply, self.customer_id = apply, customer_id
        self.report = {'version': 1, 'started_at': int(time.time()),
                       'mode': 'temporary-key-crud' if apply else 'read-only',
                       'inference_requests': 0, 'checks': [], 'cleanup_pending': False,
                       'session_authentication': 'short-lived-jwt; password/OAuth login not exercised',
                       'csrf': 'SameSite=Lax session cookie; no separate CSRF endpoint in current Portal'}
        if hasattr(http, 'base_url'):
            self.report['base_url'] = http.base_url
        self.phase = 'preflight'
        self.baseline_keys = None
        self.baseline_groups = None
        self.customer = None
        self.customer_session = None
        self.journal = None
        self.journal_path = None

    def check(self, name, condition, **facts):
        self.report['checks'].append({'check': name, 'passed': bool(condition), **facts})
        migration.require(condition, 'Portal check failed: ' + name)

    def request_json(self, name, method, path, *, expected=200, **kwargs):
        self.phase = name
        status, content_type, content = self.http.request(method, path, **kwargs)
        self.check(name + '_status', status == expected, status=status, expected=expected)
        self.check(name + '_content_type', 'application/json' in content_type.lower())
        try:
            payload = json.loads(content)
        except (ValueError, UnicodeError):
            raise migration.MigrationError('Portal returned invalid JSON: ' + name) from None
        self.check(name + '_object', isinstance(payload, dict))
        return payload

    def save_journal(self):
        self.journal['updated_at'] = int(time.time())
        migration.atomic_private(self.journal_path, json.dumps(self.journal, indent=2) + '\n')

    def prepare(self):
        identities = self.database.identities(self.customer_id)
        self.customer = identities.get('customer')
        admin = identities.get('admin')
        self.check('active_customer_and_admin_available', bool(self.customer) and bool(admin))
        self.customer_session = sign_session(self.secret, self.customer)
        self.admin_session = sign_session(self.secret, admin)
        self.baseline_keys = self.database.keys(self.customer['id'])
        self.baseline_groups = self.database.groups()
        self.baseline_ids = {row['id'] for row in self.baseline_keys}
        groups = [row for row in self.baseline_groups if row['enabled']]
        self.check('enabled_groups_available', bool(groups))
        self.check('one_default_group', sum(bool(row['is_default']) for row in groups) == 1)
        self.check('groups_have_channels', all(row['newapi_channel_ids'] for row in groups))
        self.check('unique_upstream_group_ownership',
                   len({row['newapi_group'] for row in groups}) == len(groups))
        channels = [channel for row in groups for channel in row['newapi_channel_ids']]
        self.check('unique_channel_ownership', len(channels) == len(set(channels)))
        allowed = self.customer['allowed_tier_keys']
        available = [row for row in groups if not allowed or row['key'] in allowed]
        self.check('customer_has_enabled_group', bool(available))
        self.tier = next((row['key'] for row in available if row['is_default']), available[0]['key'])
        self.expected_tiers = {row['key'] for row in groups}
        eligible = [row for row in self.baseline_keys if row['status'] == 'active'
                    and not row['key_alias'].startswith('portal-internal')
                    and row['tier'] in {group['key'] for group in available}]
        self.check('existing_customer_api_key_available', bool(eligible))
        self.existing_key = wire_key(eligible[0]['newapi_token_value'])
        self.report.update({'existing_key_count': len(self.baseline_keys),
                            'enabled_group_count': len(groups)})

    def read_checks(self):
        for path in ('/login', '/models', '/pricing', '/docs'):
            self.phase = 'public_' + path[1:]
            status, content_type, content = self.http.request('GET', path)
            self.check(self.phase, status == 200 and 'text/html' in content_type.lower()
                       and b'<html' in content.lower(), status=status)
        self.request_json('anonymous_keys_denied', 'GET', '/api/portal/keys', expected=401)
        payload = self.request_json('customer_key_list', 'GET', '/api/portal/keys',
                                    session=self.customer_session)
        expected = {row['id'] for row in self.baseline_keys if row['status'] == 'active'
                    and not row['key_alias'].startswith('portal-internal')}
        self.check('customer_key_list_matches_database', isinstance(payload.get('tokens'), list)
                   and {row.get('id') for row in payload['tokens']} == expected)
        self.check('customer_list_does_not_reveal_keys', all('key' not in row and
                   'newapi_token_value' not in row for row in payload['tokens']))
        for name, session, viewer in [('public_catalog', None, 'anonymous'),
                                      ('customer_catalog', self.customer_session, self.customer['id'])]:
            payload = self.request_json(name, 'GET', '/api/portal/models/pricing', session=session)
            self.check(name + '_models', payload.get('success') is True
                       and isinstance(payload.get('data'), list) and bool(payload['data']),
                       model_count=len(payload.get('data', [])) if isinstance(payload.get('data'), list) else 0)
            self.check(name + '_viewer', payload.get('portal_viewer_key') == viewer)
            self.check(name + '_groups', isinstance(payload.get('portal_tiers'), list)
                       and {row.get('key') for row in payload['portal_tiers']} == self.expected_tiers
                       and isinstance(payload.get('usable_group'), dict)
                       and set(payload['usable_group']) == self.expected_tiers)
        self.request_json('invalid_api_key_denied', 'GET', '/v1/models', expected=401,
                          bearer='sk-invalid-portal-smoke-' + secrets.token_hex(16))
        payload = self.request_json('existing_api_key_models', 'GET', '/v1/models', bearer=self.existing_key)
        self.check('existing_api_key_model_list', payload.get('object') == 'list'
                   and isinstance(payload.get('data'), list) and bool(payload['data']),
                   model_count=len(payload.get('data', [])) if isinstance(payload.get('data'), list) else 0)
        self.request_json('customer_admin_denied', 'GET', '/api/admin/customers?page=1&page_size=1',
                          expected=401, session=self.customer_session)
        payload = self.request_json('admin_customers', 'GET', '/api/admin/customers?page=1&page_size=1',
                                    session=self.admin_session)
        self.check('admin_customers_structure', isinstance(payload.get('customers'), list)
                   and type(payload.get('total')) is int)
        payload = self.request_json('admin_dashboard', 'GET', '/api/admin/dashboard?days=1',
                                    session=self.admin_session)
        self.check('admin_dashboard_structure', isinstance(payload.get('summary'), dict)
                   and isinstance(payload.get('dailySeries'), list))

    def temporary_candidates(self):
        aliases = {self.journal['alias'], self.journal['renamed_alias']}
        return [row for row in self.database.keys(self.customer['id']) if row['key_alias'] in aliases]

    def owned_temporary(self, candidates):
        self.check('temporary_key_unambiguous', len(candidates) == 1)
        row = candidates[0]
        self.check('temporary_key_ownership', is_uuid(row['id']) and row['id'] not in self.baseline_ids
                   and row['user_id'] == self.customer['id']
                   and row['key_alias'] in (self.journal['alias'], self.journal['renamed_alias'])
                   and (not self.journal.get('created_id') or self.journal['created_id'] == row['id']))
        return row

    def write_checks(self):
        suffix = secrets.token_hex(14)
        alias = 'migration-smoke-' + suffix
        self.journal_path = self.evidence_dir / ('portal-key-smoke-' + suffix + '.json')
        self.journal = {'version': 1, 'owner_id': self.customer['id'], 'alias': alias,
                        'renamed_alias': 'migration-renamed-' + suffix, 'tier': self.tier,
                        'state': 'planned', 'cleanup_pending': True}
        self.report['cleanup_journal'] = self.journal_path.name
        self.save_journal()  # Durable, non-secret recovery identity before POST.
        self.report['cleanup_pending'] = True
        primary_error = None
        try:
            self.journal['state'] = 'create-requested'
            self.save_journal()
            payload = self.request_json('temporary_key_create', 'POST', '/api/portal/keys',
                                        session=self.customer_session, body={'alias': alias, 'tier': self.tier})
            self.check('temporary_key_create_structure', is_uuid(payload.get('id'))
                       and payload.get('key_alias') == alias and payload.get('tier') == self.tier
                       and payload.get('quota_unlimited') is True)
            row = self.owned_temporary(self.temporary_candidates())
            self.check('temporary_key_create_identity', row['id'] == payload['id'] and row['status'] == 'active'
                       and hmac.compare_digest(wire_key(row['newapi_token_value']), wire_key(payload.get('key'))))
            self.journal.update({'created_id': row['id'], 'state': 'created'})
            self.save_journal()
            key = wire_key(payload['key'])
            path = '/api/portal/keys/' + row['id']
            payload = self.request_json('temporary_key_reveal', 'GET', path + '/key', session=self.customer_session)
            self.check('temporary_key_reveal_matches', hmac.compare_digest(key, wire_key(payload.get('key'))))
            payload = self.request_json('temporary_key_alias_patch', 'PATCH', path, session=self.customer_session,
                                        body={'alias': self.journal['renamed_alias']})
            self.check('temporary_key_alias_result', payload.get('ok') is True
                       and payload.get('key_alias') == self.journal['renamed_alias'])
            row = self.owned_temporary(self.temporary_candidates())
            self.check('temporary_key_alias_persisted', row['key_alias'] == self.journal['renamed_alias'])
            self.journal['state'] = 'renamed'
            self.save_journal()
        except (Exception, KeyboardInterrupt) as caught:
            primary_error = caught
            self.report['mutation_error_type'] = type(caught).__name__
            self.report['mutation_failed_phase'] = self.phase
            raise
        finally:
            try:
                self.cleanup_temporary()
            except (Exception, KeyboardInterrupt) as caught:
                self.report['cleanup_error_type'] = type(caught).__name__
                if primary_error is None:
                    raise

    def cleanup_temporary(self):
        self.phase = 'temporary_key_cleanup'
        # A lost POST response may still have committed. Search only both exact
        # per-run random aliases, for this owner, never by prefix or another ID.
        candidates = self.temporary_candidates()
        if not candidates:
            for delay in (1, 2, 4):
                time.sleep(delay)
                candidates = self.temporary_candidates()
                if candidates:
                    break
        if not candidates:
            self.journal['state'] = 'create-outcome-uncertain'
            self.save_journal()
            raise migration.MigrationError('Temporary create outcome uncertain; inspect private cleanup journal')
        row = self.owned_temporary(candidates)
        self.journal.update({'created_id': row['id'], 'state': 'cleanup-requested'})
        self.save_journal()
        if row['status'] != 'disabled':
            self.check('temporary_key_active_before_cleanup', row['status'] == 'active')
            payload = self.request_json('temporary_key_delete', 'DELETE', '/api/portal/keys/' + row['id'],
                                        session=self.customer_session)
            self.check('temporary_key_delete_result', payload.get('ok') is True)
        row = self.owned_temporary(self.temporary_candidates())
        self.check('temporary_key_disabled_in_database', row['status'] == 'disabled')
        payload = self.request_json('temporary_key_list_after_delete', 'GET', '/api/portal/keys',
                                    session=self.customer_session)
        self.check('temporary_key_absent_from_active_list', isinstance(payload.get('tokens'), list)
                   and all(token.get('id') != row['id'] for token in payload['tokens']))
        self.journal.update({'state': 'cleaned', 'cleanup_pending': False})
        self.save_journal()
        self.report['cleanup_pending'] = False

    def verify_preserved(self):
        if self.baseline_keys is not None:
            current = {row['id']: row for row in self.database.keys(self.customer['id'])}
            original = [current[key] for key in self.baseline_ids if key in current]
            self.check('preexisting_keys_preserved', len(original) == len(self.baseline_keys)
                       and fingerprint(original) == fingerprint(self.baseline_keys))
        if self.baseline_groups is not None:
            self.check('group_business_configuration_preserved',
                       fingerprint(self.database.groups()) == fingerprint(self.baseline_groups))

    def run(self):
        error = None
        try:
            self.prepare()
            self.read_checks()
            if self.apply:
                self.write_checks()
        except (Exception, KeyboardInterrupt) as caught:
            error = caught
            self.report['failed_phase'] = self.phase
            self.report['error_type'] = type(caught).__name__
        finally:
            try:
                self.verify_preserved()
            except Exception as caught:
                self.report['preservation_error_type'] = type(caught).__name__
                error = error or caught
            self.report.update({'finished_at': int(time.time()),
                                'passed': error is None and not self.report['cleanup_pending']})
            migration.atomic_private(self.evidence_dir / 'portal-verification.json',
                                     json.dumps(self.report, indent=2) + '\n')
        return self.report


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--base-url', default='http://127.0.0.1:3002')
    parser.add_argument('--portal-db', default='silkroadai-portal-db')
    parser.add_argument('--env-source', type=Path, default=Path('/opt/silkroadai-portal/.env'))
    parser.add_argument('--section', choices=('cutover', 'rehearsal'), default='cutover')
    parser.add_argument('--customer-id')
    parser.add_argument('--timeout', type=int, default=30)
    parser.add_argument('--apply-smoke', action='store_true')
    return parser.parse_args()


def main():
    args = parse_args()
    try:
        root = args.root.resolve()
        migration.require(root.parent == Path('/opt/new-api-migration') and root.is_dir(),
                          'Expected an existing run under /opt/new-api-migration')
        evidence = root / args.section
        evidence.mkdir(mode=0o700, exist_ok=True)
        migration.require(not evidence.is_symlink() and evidence.resolve().parent == root,
                          'Evidence directory must be directly below the run root')
        migration.require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', args.portal_db) is not None,
                          'Invalid Portal database container name')
        migration.require(args.customer_id is None or is_uuid(args.customer_id), 'Invalid customer ID')
        migration.require(1 <= args.timeout <= 60, 'HTTP timeout must be between 1 and 60 seconds')
        for path in evidence.glob('portal-key-smoke-*.json'):
            migration.private_file(path)
            try:
                journal = json.loads(path.read_text())
            except (ValueError, OSError):
                raise migration.MigrationError('Unreadable earlier cleanup journal') from None
            migration.require(journal.get('cleanup_pending') is False,
                              'Earlier temporary Key needs cleanup; inspect its private journal')
        migration.private_file(args.env_source)
        values = migration.env_values(args.env_source.read_text())
        secret = values.get('PORTAL_JWT_SECRET')
        migration.require(bool(secret), 'PORTAL_JWT_SECRET is absent from env source')
        smoke = PortalSmoke(PortalDatabase(args.portal_db), InternalHTTP(args.base_url, args.timeout),
                            secret, evidence, apply=args.apply_smoke, customer_id=args.customer_id)
        report = smoke.run()
        passed = sum(check['passed'] for check in report['checks'])
        print('Portal verification: %s; checks=%d/%d; temporary_key_crud=%s; cleanup_pending=%s' %
              ('PASS' if report['passed'] else 'FAIL', passed, len(report['checks']),
               'enabled' if args.apply_smoke else 'disabled', str(report['cleanup_pending']).lower()))
        return 0 if report['passed'] else 1
    except migration.MigrationError as error:
        print('Portal verification preflight failed: ' + str(error), file=sys.stderr)
        return 1
    except Exception as error:
        print('Portal verification failed: ' + type(error).__name__, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
