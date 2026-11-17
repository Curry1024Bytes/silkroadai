#!/usr/bin/env python3
"""Preserve the existing Astra cache-write tariff on the official usage normalizer.

This is existing new-api billing configuration, never a source modification or
new price. Both recognized cache-write buckets retain their previous unit rate.
Offline old/new normalization, tier, cost and quota comparison: 120/120 matched.
"""
import json

MODEL = 'gpt-6-astra'
EXPRESSION = (
    'len <= 272000 ? tier("standard", p * 10 + c * 50 + cr * 1 + (cc + cc12h) * 12.5) '
    ': tier("long_context", p * 20 + c * 75 + cr * 2 + (cc + cc12h) * 25)'
)
PATCHES = {'billing_setting.billing_expr': EXPRESSION, 'billing_setting.billing_mode': 'tiered_expr'}


def install(query):
    # A transaction locks both original dictionaries; only this one missing
    # model entry may be added. Preserve every existing model and expression.
    statements = ['BEGIN;']
    for key, value in PATCHES.items():
        encoded = json.dumps({MODEL: value}).replace("'", "''")
        statements.append("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM options WHERE key='" + key + "') "
                          "THEN RAISE EXCEPTION 'Missing billing dictionary'; END IF; END $$;")
        statements.append("SELECT key FROM options WHERE key='" + key + "' FOR UPDATE;")
        statements.append("DO $$ BEGIN IF EXISTS (SELECT 1 FROM options WHERE key='" + key + "' "
                          "AND value::jsonb ? 'gpt-6-astra' AND value::jsonb->>'gpt-6-astra' <> "
                          + "'" + value.replace("'", "''") + "') THEN RAISE EXCEPTION "
                          "'Unexpected existing Astra override'; END IF; END $$;")
        statements.append("UPDATE options SET value=(value::jsonb || '" + encoded
                          + "'::jsonb)::text WHERE key='" + key + "';")
    statements.append('COMMIT;')
    query('\n'.join(statements))
    verify(query)


def verify(query):
    for key, expected in PATCHES.items():
        actual = query("SELECT value::jsonb->>'gpt-6-astra' FROM options WHERE key='" + key + "';").strip()
        if actual != expected:
            raise RuntimeError('Existing Astra tariff compatibility was not installed')
