#!/usr/bin/env node
/**
 * Configure fixed-price GPT Image 2 aliases on official new-api rc.23.
 *
 * Safe rollout:
 *   --phase=pricing  Add ModelPrice entries only.
 *   restart new-api Prove the option survived a process restart.
 *   --phase=prepare --pricing-snapshot=PATH
 *                    Add aliases/mappings while keeping gpt-image-2.
 *   --phase=cutover Remove gpt-image-2 only after the new Portal has passed quota tests.
 *   --phase=restore --snapshot=PATH
 *                    Restore the exact target state saved by an earlier apply.
 *   --phase=verify --snapshot=PATH --expect=before|after
 *                    After a restart, prove a snapshot state survived in MySQL.
 *
 * Every phase is a dry-run unless --apply is present. Apply writes a 0600 snapshot
 * before changing anything, verifies every write, and rolls this run back on error.
 * The new-api API has no transaction or ETag, so the admin UI must not be edited
 * concurrently while this script runs.
 *
 * Required environment:
 *   NEWAPI_ADMIN_TOKEN=<32-character root persistent access token>
 *   NEWAPI_IMAGE_CHANNEL_IDS=12
 *   NEWAPI_IMAGE_GROUP=<the exact channel group>
 *
 * Optional environment:
 *   NEWAPI_BASE_URL=http://127.0.0.1:3000
 *   NEWAPI_CONFIG_SNAPSHOT_DIR=/secure/local/path
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function argValue(name) {
    const prefix = `${name}=`;
    const arg = args.find((value) => value.startsWith(prefix));
    return arg ? arg.slice(prefix.length) : '';
}

const APPLY = args.includes('--apply');
const PHASE = argValue('--phase');
const RESTORE_SNAPSHOT = argValue('--snapshot');
const PRICING_SNAPSHOT = argValue('--pricing-snapshot');
const VERIFY_EXPECT = argValue('--expect');
const BASE = (process.env.NEWAPI_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const TOKEN = String(process.env.NEWAPI_ADMIN_TOKEN || '')
    .replace(/^Bearer\s+/i, '')
    .trim();
const EXPLICIT_GROUP = String(process.env.NEWAPI_IMAGE_GROUP || '').trim();
const CHANNEL_ID_PARTS = String(process.env.NEWAPI_IMAGE_CHANNEL_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
const INVALID_CHANNEL_IDS = CHANNEL_ID_PARTS.filter((value) => !/^\d+$/.test(value) || Number(value) <= 0);
const CHANNEL_IDS = [
    ...new Set(CHANNEL_ID_PARTS.filter((value) => /^\d+$/.test(value) && Number(value) > 0).map(Number)),
];
const SNAPSHOT_DIR = resolve(
    process.env.NEWAPI_CONFIG_SNAPSHOT_DIR || resolve(scriptDir, '..', '.newapi-config-snapshots'),
);

const CANONICAL = 'gpt-image-2';
const EXPECTED_NEW_API_VERSION = 'v1.0.0-rc.23';
const MIN_RESTART_AGE_SECONDS = 65;
const EXPECTED_QUOTA_PER_UNIT = 500_000;
const EXPECTED_GROUP_RATIO = 0.2;
const EXPECTED_CHANNEL_TYPE = 1;
const SKUS = [
    { alias: 'gpt-image-2-1k', price: 5, retailCny: 1, size: '1024x1024' },
    { alias: 'gpt-image-2-2k', price: 7.5, retailCny: 1.5, size: '2048x2048' },
    { alias: 'gpt-image-2-4k', price: 10, retailCny: 2, size: '3840x2160' },
];
const TARGET_MODELS = new Set([CANONICAL, ...SKUS.map((sku) => sku.alias)]);
const VOLATILE_CHANNEL_FIELDS = new Set([
    'models',
    'model_mapping',
    'test_time',
    'response_time',
    'balance',
    'balance_updated_time',
    'used_quota',
    'channel_info',
]);

function fail(message) {
    throw new Error(message);
}

function parseJsonObject(raw, label) {
    if (raw == null || raw === '') return {};
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') fail('not an object');
        return parsed;
    } catch (error) {
        throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function rawJsonObject(value, label) {
    if (value == null || value === '') return value == null ? null : '';
    if (typeof value === 'string') {
        parseJsonObject(value, label);
        return value;
    }
    parseJsonObject(value, label);
    return JSON.stringify(value);
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, canonicalize(value[key])]),
        );
    }
    return value;
}

function sameObject(a, b, label) {
    return (
        JSON.stringify(canonicalize(parseJsonObject(a, `${label} (left)`))) ===
        JSON.stringify(canonicalize(parseJsonObject(b, `${label} (right)`)))
    );
}

function channelModels(raw) {
    return String(raw || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
}

function optionMap(data) {
    if (!Array.isArray(data)) return data || {};
    return Object.fromEntries(data.map((item) => [item.key, item.value]));
}

function stateFrom(options, channels) {
    const modelPrice = rawJsonObject(options.ModelPrice, 'ModelPrice');
    return {
        model_price: modelPrice == null || modelPrice === '' ? '{}' : modelPrice,
        channels: channels.map((channel) => ({
            id: Number(channel.id),
            type: Number(channel.type),
            group: String(channel.group || ''),
            base_url: channel.base_url ?? null,
            models: String(channel.models || ''),
            model_mapping: rawJsonObject(channel.model_mapping, `channel ${channel.id} model_mapping`),
        })),
    };
}

function channelStableProjection(channel) {
    return canonicalize(
        Object.fromEntries(Object.entries(channel).filter(([key]) => !VOLATILE_CHANNEL_FIELDS.has(key))),
    );
}

function stateDiff(actual, expected) {
    const differences = [];
    if (!sameObject(actual.model_price, expected.model_price, 'ModelPrice')) differences.push('ModelPrice differs');
    const actualById = new Map(actual.channels.map((channel) => [Number(channel.id), channel]));
    for (const wanted of expected.channels) {
        const got = actualById.get(Number(wanted.id));
        if (!got) {
            differences.push(`channel #${wanted.id} is missing`);
            continue;
        }
        if (channelModels(got.models).join(',') !== channelModels(wanted.models).join(',')) {
            differences.push(`channel #${wanted.id} models differ`);
        }
        if (!sameObject(got.model_mapping, wanted.model_mapping, `channel #${wanted.id} model_mapping`)) {
            differences.push(`channel #${wanted.id} model_mapping differs`);
        }
        if (
            Number(got.type) !== Number(wanted.type) ||
            String(got.group || '') !== String(wanted.group || '') ||
            (got.base_url ?? null) !== (wanted.base_url ?? null)
        ) {
            differences.push(`channel #${wanted.id} type/group/base_url guard differs`);
        }
    }
    return differences;
}

async function api(path, init = {}) {
    const response = await fetch(`${BASE}${path}`, {
        ...init,
        headers: {
            Authorization: TOKEN,
            'Content-Type': 'application/json',
            ...(init.headers || {}),
        },
        signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let json;
    try {
        json = text ? JSON.parse(text) : {};
    } catch {
        json = { _raw: text.slice(0, 300) };
    }
    if (!response.ok || json?.success === false) {
        throw new Error(`${path} -> HTTP ${response.status}: ${json?.message || text.slice(0, 300)}`);
    }
    return json?.data ?? json;
}

async function readEnvironment(channelIds) {
    const [status, optionData, ...channels] = await Promise.all([
        api('/api/status'),
        api('/api/option/'),
        ...channelIds.map((id) => api(`/api/channel/${id}`)),
    ]);
    for (let index = 0; index < channels.length; index++) {
        if (Number(channels[index]?.id) !== Number(channelIds[index])) {
            fail(`channel #${channelIds[index]} returned an incomplete or mismatched object`);
        }
    }
    if (status?.version !== EXPECTED_NEW_API_VERSION) {
        fail(`new-api version=${status?.version ?? '(missing)'}; expected official ${EXPECTED_NEW_API_VERSION}`);
    }
    if (!Number.isFinite(Number(status?.start_time)) || Number(status.start_time) <= 0) {
        fail(`new-api returned invalid start_time=${status?.start_time ?? '(missing)'}`);
    }
    return { status, options: optionMap(optionData), channels };
}

async function listAllChannels() {
    const channels = [];
    for (let page = 1; page <= 100; page++) {
        const data = await api(`/api/channel/?p=${page}&page_size=100`);
        const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
        channels.push(...items);
        const total = Number(data?.total);
        if (items.length < 100 || (Number.isFinite(total) && channels.length >= total)) return channels;
    }
    fail('channel pagination exceeded 100 pages; refusing an incomplete exposure audit');
}

async function validateExclusiveTargetChannels(channelIds) {
    const targetIds = new Set(channelIds.map(Number));
    const reservedAliases = new Set(SKUS.map((sku) => sku.alias));
    const allChannels = await listAllChannels();
    const unexpected = [];
    const collisions = [];
    for (const channel of allChannels) {
        const mapping = parseJsonObject(channel.model_mapping, `channel ${channel.id} model_mapping`);
        for (const exposedModel of channelModels(channel.models)) {
            if (reservedAliases.has(exposedModel)) {
                const allowed = targetIds.has(Number(channel.id)) && mapping[exposedModel] === CANONICAL;
                if (!allowed) {
                    collisions.push(
                        `#${channel.id} ${exposedModel}->${String(mapping[exposedModel] ?? '(native/unmapped)')}`,
                    );
                }
            }
            let model = exposedModel;
            const seen = new Set();
            for (let hop = 0; hop < 32; hop++) {
                if (model === CANONICAL) {
                    const allowed = targetIds.has(Number(channel.id)) && TARGET_MODELS.has(exposedModel);
                    if (!allowed) unexpected.push(`#${channel.id} ${exposedModel}->${CANONICAL}`);
                    break;
                }
                if (seen.has(model)) break;
                seen.add(model);
                const next = mapping[model];
                if (typeof next !== 'string' || !next.trim()) break;
                model = next.trim();
            }
        }
    }
    if (collisions.length) {
        fail(`reserved fixed-price alias collision(s): ${collisions.join(', ')}`);
    }
    if (unexpected.length) {
        fail(`unexpected exposed model(s) resolve to ${CANONICAL}: ${unexpected.join(', ')}`);
    }
    console.log(`Validated exclusive GPT Image 2 target channel(s): ${channelIds.map((id) => `#${id}`).join(', ')}`);
}

function validatePricingPrerequisites(environment) {
    const { options, channels } = environment;
    if (options.ModelPrice == null || options.ModelPrice === '') {
        fail('ModelPrice option is missing or empty; refusing to construct a replacement price table');
    }
    parseJsonObject(options.ModelPrice, 'ModelPrice');
    const quotaPerUnit = Number(options.QuotaPerUnit);
    if (quotaPerUnit !== EXPECTED_QUOTA_PER_UNIT) {
        fail(`QuotaPerUnit=${options.QuotaPerUnit}; expected ${EXPECTED_QUOTA_PER_UNIT}. No changes were made.`);
    }

    const groups = [...new Set(channels.map((channel) => String(channel.group || '').trim()).filter(Boolean))];
    if (groups.length !== 1) fail(`target channels must share one non-empty group; got ${JSON.stringify(groups)}`);
    if (groups[0].includes(',')) fail(`multi-group channel value is not supported by this script: ${groups[0]}`);
    const imageGroup = EXPLICIT_GROUP || groups[0];
    if (EXPLICIT_GROUP && groups[0] !== EXPLICIT_GROUP) {
        fail(`NEWAPI_IMAGE_GROUP=${EXPLICIT_GROUP}, but target channel group is ${groups[0]}`);
    }
    for (const channel of channels) {
        if (Number(channel.type) !== EXPECTED_CHANNEL_TYPE) {
            fail(`channel #${channel.id} type=${channel.type}; expected OpenAI channel type ${EXPECTED_CHANNEL_TYPE}`);
        }
        if (!channelModels(channel.models).some((model) => TARGET_MODELS.has(model))) {
            fail(`channel #${channel.id} contains none of the GPT Image 2 target models`);
        }
    }

    const groupRatio = parseJsonObject(options.GroupRatio, 'GroupRatio');
    if (Number(groupRatio[imageGroup]) !== EXPECTED_GROUP_RATIO) {
        fail(
            `GroupRatio[${imageGroup}]=${groupRatio[imageGroup] ?? '(missing)'}; expected ${EXPECTED_GROUP_RATIO}. No changes were made.`,
        );
    }

    const groupGroupRatio = parseJsonObject(options.GroupGroupRatio, 'GroupGroupRatio');
    const conflicts = [];
    for (const [userGroup, usingGroups] of Object.entries(groupGroupRatio)) {
        if (!usingGroups || typeof usingGroups !== 'object' || Array.isArray(usingGroups)) continue;
        if (imageGroup in usingGroups && Number(usingGroups[imageGroup]) !== EXPECTED_GROUP_RATIO) {
            conflicts.push(`${userGroup}->${imageGroup}=${usingGroups[imageGroup]}`);
        }
    }
    if (conflicts.length) fail(`conflicting GroupGroupRatio override(s): ${conflicts.join(', ')}`);

    const billingModes = parseJsonObject(options['billing_setting.billing_mode'], 'billing_setting.billing_mode');
    const scheduledDiscounts = parseJsonObject(
        options['billing_setting.scheduled_discount'],
        'billing_setting.scheduled_discount',
    );
    const imageResolutionPrices = parseJsonObject(options.ImageResolutionPrice, 'ImageResolutionPrice');
    const billingOverrides = [];
    for (const sku of SKUS) {
        if (billingModes[sku.alias] === 'tiered_expr') {
            billingOverrides.push(`${sku.alias}:tiered_expr`);
        }
        if (scheduledDiscounts[sku.alias]?.enabled === true) {
            billingOverrides.push(`${sku.alias}:scheduled_discount`);
        }
        if (Object.prototype.hasOwnProperty.call(imageResolutionPrices, sku.alias)) {
            billingOverrides.push(`${sku.alias}:ImageResolutionPrice`);
        }
    }
    if (billingOverrides.length) {
        fail(`billing override(s) would bypass or alter the fixed ModelPrice: ${billingOverrides.join(', ')}`);
    }

    console.log(
        `Validated billing invariants: QuotaPerUnit=${quotaPerUnit}; channel group=${imageGroup}; ratio=${EXPECTED_GROUP_RATIO}`,
    );
}

function buildDesiredState(environment, phase) {
    const before = stateFrom(environment.options, environment.channels);
    const currentPrices = parseJsonObject(before.model_price, 'ModelPrice');
    const nextPrices = { ...currentPrices };

    if (phase === 'pricing') {
        for (const sku of SKUS) nextPrices[sku.alias] = sku.price;
    } else {
        for (const sku of SKUS) {
            if (Number(currentPrices[sku.alias]) !== sku.price) {
                fail(`ModelPrice[${sku.alias}]=${currentPrices[sku.alias] ?? '(missing)'}; run --phase=prepare first`);
            }
        }
    }

    const desiredChannels =
        phase === 'pricing'
            ? before.channels
            : environment.channels.map((channel) => {
                  const existingModels = channelModels(channel.models);
                  const mapping = parseJsonObject(channel.model_mapping, `channel ${channel.id} model_mapping`);
                  if (Object.prototype.hasOwnProperty.call(mapping, CANONICAL)) {
                      fail(
                          `channel #${channel.id} already maps ${CANONICAL} to ${String(mapping[CANONICAL])}; ` +
                              'remove or audit that mapping before configuring fixed-price aliases',
                      );
                  }
                  for (const sku of SKUS) {
                      const hasAliasMapping = Object.prototype.hasOwnProperty.call(mapping, sku.alias);
                      if (existingModels.includes(sku.alias) && !hasAliasMapping) {
                          fail(
                              `channel #${channel.id} already exposes ${sku.alias} without a model_mapping entry; ` +
                                  'refusing to repurpose an existing native model name',
                          );
                      }
                      if (hasAliasMapping && String(mapping[sku.alias]) !== CANONICAL) {
                          fail(
                              `channel #${channel.id} already maps ${sku.alias} to ${String(mapping[sku.alias])}; ` +
                                  `refusing to overwrite it with ${CANONICAL}`,
                          );
                      }
                  }
                  if (phase === 'cutover') {
                      for (const sku of SKUS) {
                          if (!existingModels.includes(sku.alias) || mapping[sku.alias] !== CANONICAL) {
                              fail(`channel #${channel.id} is not prepared for cutover; run --phase=prepare first`);
                          }
                      }
                  } else if (!existingModels.includes(CANONICAL)) {
                      fail(
                          `channel #${channel.id} no longer exposes ${CANONICAL}; prepare cannot reopen a cutover channel. ` +
                              'Use an explicit snapshot restore if rollback is intended.',
                      );
                  }

                  const unrelatedModels = existingModels.filter((model) => !TARGET_MODELS.has(model));
                  const models =
                      phase === 'prepare'
                          ? [...unrelatedModels, CANONICAL, ...SKUS.map((sku) => sku.alias)]
                          : [...unrelatedModels, ...SKUS.map((sku) => sku.alias)];
                  const nextMapping = { ...mapping };
                  for (const sku of SKUS) nextMapping[sku.alias] = CANONICAL;
                  return {
                      id: Number(channel.id),
                      type: Number(channel.type),
                      group: String(channel.group || ''),
                      base_url: channel.base_url ?? null,
                      models: models.join(','),
                      model_mapping: JSON.stringify(nextMapping),
                  };
              });

    const priceChanged = !sameObject(before.model_price, nextPrices, 'ModelPrice plan');
    return {
        before,
        after: {
            model_price: priceChanged ? JSON.stringify(nextPrices) : before.model_price,
            channels: desiredChannels,
        },
    };
}

function printPlan(phase, before, after) {
    console.log(`\nGPT Image 2 configuration phase=${phase} apply=${APPLY}`);
    console.log(`new-api: ${BASE}`);
    const beforePrices = parseJsonObject(before.model_price, 'ModelPrice before');
    const afterPrices = parseJsonObject(after.model_price, 'ModelPrice after');
    console.log('\nModelPrice (all unrelated entries are preserved):');
    for (const sku of SKUS) {
        console.log(
            `  ${sku.alias}: ${beforePrices[sku.alias] ?? '(missing)'} -> ${afterPrices[sku.alias]} ` +
                `(CNY ${sku.retailCny.toFixed(2)}, ${sku.size})`,
        );
    }
    const beforeById = new Map(before.channels.map((channel) => [Number(channel.id), channel]));
    for (const next of after.channels) {
        const current = beforeById.get(Number(next.id));
        const currentModels = channelModels(current?.models);
        const nextModels = channelModels(next.models);
        const added = nextModels.filter((model) => !currentModels.includes(model));
        const removed = currentModels.filter((model) => !nextModels.includes(model));
        const preservedNonTargets = currentModels.filter((model) => !TARGET_MODELS.has(model));
        console.log(`\nchannel #${next.id}:`);
        console.log(`  add models: ${added.join(',') || '(none)'}`);
        console.log(`  remove models: ${removed.join(',') || '(none)'}`);
        console.log(`  preserve non-target models: ${preservedNonTargets.join(',') || '(none)'}`);
        console.log(phase === 'pricing' ? '  channel unchanged in pricing phase' : `  aliases map to ${CANONICAL}`);
    }
}

function snapshotPath(phase) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return resolve(SNAPSHOT_DIR, `gpt-image-${phase}-${stamp}.json`);
}

function writeSnapshot(phase, before, after, runtimeStartTime) {
    mkdirSync(SNAPSHOT_DIR, { recursive: true, mode: 0o700 });
    const path = snapshotPath(phase.replace(/[^a-z0-9_-]/gi, '-'));
    const snapshot = {
        schema_version: 1,
        created_at: new Date().toISOString(),
        phase,
        newapi_base_url: BASE,
        runtime_start_time: runtimeStartTime,
        before,
        after,
    };
    writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return path;
}

function readSnapshot(path) {
    let snapshot;
    try {
        snapshot = JSON.parse(readFileSync(resolve(path), 'utf8'));
    } catch (error) {
        fail(`cannot read snapshot ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (snapshot?.schema_version !== 1 || !snapshot.before || !snapshot.after) fail('unsupported snapshot format');
    if (String(snapshot.newapi_base_url || '').replace(/\/+$/, '') !== BASE) {
        fail(`snapshot targets ${snapshot.newapi_base_url}, but NEWAPI_BASE_URL is ${BASE}`);
    }
    return snapshot;
}

function shellQuote(value) {
    return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function validateRestartAfterSnapshot(snapshot, status) {
    const previousStart = Number(snapshot.runtime_start_time);
    const currentStart = Number(status?.start_time);
    if (!Number.isFinite(previousStart) || !Number.isFinite(currentStart) || currentStart <= previousStart) {
        fail(
            `new-api restart is not proven: snapshot start_time=${snapshot.runtime_start_time}, ` +
                `current start_time=${status?.start_time}`,
        );
    }
    const processAge = Math.floor(Date.now() / 1000) - currentStart;
    if (!Number.isFinite(processAge) || processAge < MIN_RESTART_AGE_SECONDS) {
        fail(
            `new-api has been running for only ${processAge}s after restart; wait until at least ` +
                `${MIN_RESTART_AGE_SECONDS}s, then verify again so one database option sync has completed`,
        );
    }
    return { previousStart, currentStart };
}

function printRestartVerification(snapshot, expect, log = console.log) {
    log('Restart new-api, wait at least 65 seconds, then run:');
    log(
        `  node scripts/configure-gpt-image-resolution-skus.mjs --phase=verify ` +
            `--snapshot=${shellQuote(snapshot)} --expect=${expect}`,
    );
}

async function writeModelPrice(value) {
    await api('/api/option/', { method: 'PUT', body: JSON.stringify({ key: 'ModelPrice', value }) });
}

async function writeChannel(state) {
    // Official rc.23 rejects any channel PUT containing status. The three guard
    // fields are copied unchanged so its audit log does not falsely report that
    // type/group/base_url changed; every other field remains omitted.
    await api('/api/channel/', {
        method: 'PUT',
        body: JSON.stringify({
            id: Number(state.id),
            type: Number(state.type),
            group: state.group,
            base_url: state.base_url,
            models: state.models,
            model_mapping: state.model_mapping == null || state.model_mapping === '' ? '{}' : state.model_mapping,
        }),
    });
}

function changedChannel(before, after) {
    return (
        channelModels(before.models).join(',') !== channelModels(after.models).join(',') ||
        !sameObject(before.model_mapping, after.model_mapping, `channel #${before.id} plan`)
    );
}

function buildOperations(phase, before, after) {
    const operations = [];
    const beforeById = new Map(before.channels.map((channel) => [Number(channel.id), channel]));
    const channelOps = after.channels
        .map((next) => ({ kind: 'channel', before: beforeById.get(Number(next.id)), after: next }))
        .filter((operation) => operation.before && changedChannel(operation.before, operation.after));
    const optionChanged = !sameObject(before.model_price, after.model_price, 'ModelPrice plan');
    if (phase === 'prepare') {
        if (optionChanged) operations.push({ kind: 'option', before: before.model_price, after: after.model_price });
        operations.push(...channelOps);
    } else {
        operations.push(...channelOps);
        if (optionChanged) operations.push({ kind: 'option', before: before.model_price, after: after.model_price });
    }
    return operations;
}

async function verifyOperation(operation, channelIds) {
    const currentEnvironment = await readEnvironment(channelIds);
    const current = stateFrom(currentEnvironment.options, currentEnvironment.channels);
    if (operation.kind === 'option') {
        if (!sameObject(current.model_price, operation.after, 'ModelPrice verification'))
            fail('ModelPrice verification failed');
        return;
    }
    const got = current.channels.find((channel) => Number(channel.id) === Number(operation.after.id));
    if (!got || changedChannel(got, operation.after)) fail(`channel #${operation.after.id} verification failed`);
}

async function rollbackAttempts(attempts, channelIds, initial) {
    const errors = [];
    for (const operation of [...attempts].reverse()) {
        try {
            if (operation.kind === 'option') await writeModelPrice(operation.before);
            else await writeChannel(operation.before);
        } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
        }
    }
    try {
        const environment = await readEnvironment(channelIds);
        const differences = stateDiff(stateFrom(environment.options, environment.channels), initial);
        if (differences.length) errors.push(`rollback verification: ${differences.join('; ')}`);
    } catch (error) {
        errors.push(`rollback readback: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (errors.length) fail(`automatic rollback incomplete: ${errors.join(' | ')}`);
}

async function applyPlan(phase, environment, before, after, snapshot) {
    const channelIds = before.channels.map((channel) => Number(channel.id));
    const operations = buildOperations(phase, before, after);
    if (!operations.length) {
        console.log('\nAlready in the requested state. No writes needed.\n');
        return;
    }
    console.log(`\nSnapshot written before apply: ${snapshot}`);
    const attempts = [];
    try {
        for (const operation of operations) {
            attempts.push(operation);
            if (operation.kind === 'option') {
                await writeModelPrice(operation.after);
                console.log('PUT ModelPrice: ok');
            } else {
                await writeChannel(operation.after);
                console.log(`PUT channel #${operation.after.id}: ok`);
            }
            await verifyOperation(operation, channelIds);
        }

        const verifiedEnvironment = await readEnvironment(channelIds);
        const differences = stateDiff(stateFrom(verifiedEnvironment.options, verifiedEnvironment.channels), after);
        for (let index = 0; index < environment.channels.length; index++) {
            const beforeStable = channelStableProjection(environment.channels[index]);
            const afterStable = channelStableProjection(verifiedEnvironment.channels[index]);
            if (JSON.stringify(beforeStable) !== JSON.stringify(afterStable)) {
                differences.push(`channel #${channelIds[index]} unrelated fields changed`);
            }
        }
        if (differences.length) fail(`final verification failed: ${differences.join('; ')}`);
    } catch (error) {
        console.error(`\nApply failed: ${error instanceof Error ? error.message : String(error)}`);
        console.error('Rolling this run back in reverse order...');
        await rollbackAttempts(attempts, channelIds, before);
        if (attempts.some((operation) => operation.kind === 'option')) {
            console.error('Automatic rollback API state verified; ModelPrice durability is still pending.');
            printRestartVerification(snapshot, 'before', (line) => console.error(line));
        } else {
            console.error('Automatic rollback verified.');
        }
        throw error;
    }
    const optionTouched = operations.some((operation) => operation.kind === 'option');
    console.log(`\nPhase ${phase} API state verified. Keep snapshot for rollback: ${snapshot}`);
    if (optionTouched) {
        console.log('ModelPrice durability is pending until a post-restart verification succeeds.');
        printRestartVerification(snapshot, 'after');
        if (phase === 'pricing') {
            console.log('The prepare phase performs this same proof when given this file via --pricing-snapshot.');
        }
        console.log('');
    } else {
        console.log('');
    }
}

function validatePricingRestartProof(environment, channelIds, phase) {
    if (!PRICING_SNAPSHOT) fail(`--phase=${phase} requires --pricing-snapshot=/absolute/path.json`);
    const proof = readSnapshot(PRICING_SNAPSHOT);
    if (proof.phase !== 'pricing') fail(`pricing proof snapshot has phase=${proof.phase}, expected pricing`);
    const proofIds = proof.after.channels.map((channel) => Number(channel.id));
    if (proofIds.join(',') !== channelIds.join(',')) {
        fail(`pricing proof channels ${proofIds.join(',')} do not match target channels ${channelIds.join(',')}`);
    }
    const currentModelPrice = rawJsonObject(environment.options.ModelPrice, 'ModelPrice');
    if (!sameObject(currentModelPrice, proof.after.model_price, 'persisted ModelPrice')) {
        fail('pricing did not survive restart or the complete ModelPrice configuration drifted');
    }
    const { previousStart, currentStart } = validateRestartAfterSnapshot(proof, environment.status);
    console.log(`Validated persisted ModelPrice after new-api restart: ${previousStart} -> ${currentStart}`);
}

async function verifySnapshotAfterRestart() {
    if (APPLY) fail('--phase=verify is read-only; do not pass --apply');
    if (!RESTORE_SNAPSHOT) fail('--phase=verify requires --snapshot=/absolute/path.json');
    if (!['before', 'after'].includes(VERIFY_EXPECT)) {
        fail('--phase=verify requires --expect=before or --expect=after');
    }
    const snapshot = readSnapshot(RESTORE_SNAPSHOT);
    const expected = snapshot[VERIFY_EXPECT];
    const channelIds = expected.channels.map((channel) => Number(channel.id));
    if (CHANNEL_IDS.length && CHANNEL_IDS.join(',') !== channelIds.join(',')) {
        fail(
            `NEWAPI_IMAGE_CHANNEL_IDS=${CHANNEL_IDS.join(',')} does not match snapshot channels ${channelIds.join(',')}`,
        );
    }
    const environment = await readEnvironment(channelIds);
    const differences = stateDiff(stateFrom(environment.options, environment.channels), expected);
    if (differences.length) {
        fail(`post-restart ${VERIFY_EXPECT}-state verification failed: ${differences.join('; ')}`);
    }
    const { previousStart, currentStart } = validateRestartAfterSnapshot(snapshot, environment.status);
    console.log(
        `Verified snapshot ${VERIFY_EXPECT}-state after restart and database sync: ${previousStart} -> ${currentStart}`,
    );
}

async function main() {
    if (!PHASE) fail('--phase is required: pricing, prepare, cutover, restore, or verify');
    if (!['pricing', 'prepare', 'cutover', 'restore', 'verify'].includes(PHASE)) fail(`unsupported --phase=${PHASE}`);
    if (INVALID_CHANNEL_IDS.length) {
        fail(`NEWAPI_IMAGE_CHANNEL_IDS contains invalid value(s): ${INVALID_CHANNEL_IDS.join(', ')}`);
    }
    if (TOKEN.length !== 32) {
        fail('NEWAPI_ADMIN_TOKEN must be the 32-character persistent root access token, not a login JWT');
    }
    try {
        new URL(BASE);
    } catch {
        fail(`NEWAPI_BASE_URL is invalid: ${BASE}`);
    }
    if (PHASE === 'verify') {
        await verifySnapshotAfterRestart();
        return;
    }

    let phase = PHASE;
    let channelIds = CHANNEL_IDS;
    let before;
    let after;
    let environment;
    let restoreSourceChangesPrice = false;

    if (PHASE === 'restore') {
        if (!RESTORE_SNAPSHOT) fail('--phase=restore requires --snapshot=/absolute/path.json');
        const source = readSnapshot(RESTORE_SNAPSHOT);
        channelIds = source.before.channels.map((channel) => Number(channel.id));
        if (CHANNEL_IDS.length && CHANNEL_IDS.join(',') !== channelIds.join(',')) {
            fail(
                `NEWAPI_IMAGE_CHANNEL_IDS=${CHANNEL_IDS.join(',')} does not match snapshot channels ${channelIds.join(',')}`,
            );
        }
        environment = await readEnvironment(channelIds);
        before = stateFrom(environment.options, environment.channels);
        restoreSourceChangesPrice = !sameObject(
            source.before.model_price,
            source.after.model_price,
            'restore source ModelPrice',
        );
        if (stateDiff(before, source.before).length) {
            const drift = stateDiff(before, source.after);
            if (drift.length) {
                fail(`current configuration has drifted from the snapshot after-state: ${drift.join('; ')}`);
            }
        }
        after = source.before;
        phase = 'restore';
    } else {
        if (!channelIds.length) fail('NEWAPI_IMAGE_CHANNEL_IDS is required; refusing to guess a target channel');
        if (APPLY && !EXPLICIT_GROUP) fail('NEWAPI_IMAGE_GROUP is required with --apply');
        environment = await readEnvironment(channelIds);
        await validateExclusiveTargetChannels(channelIds);
        validatePricingPrerequisites(environment);
        if (PHASE === 'prepare' || PHASE === 'cutover') {
            validatePricingRestartProof(environment, channelIds, PHASE);
        }
        ({ before, after } = buildDesiredState(environment, PHASE));
    }

    printPlan(phase, before, after);
    if (!stateDiff(before, after).length) {
        if (APPLY && (PHASE === 'pricing' || restoreSourceChangesPrice)) {
            const snapshot = writeSnapshot(phase, before, after, Number(environment.status?.start_time));
            console.log(`\nAlready in the requested API state. Proof snapshot written: ${snapshot}`);
            printRestartVerification(snapshot, 'after');
            return;
        }
        console.log('\nAlready in the requested state. No writes needed.\n');
        return;
    }
    if (!APPLY) {
        console.log('\n[dry-run] No changes made. Re-run the same command with --apply after review.\n');
        return;
    }

    const snapshot = writeSnapshot(phase, before, after, Number(environment.status?.start_time));
    await applyPlan(phase, environment, before, after, snapshot);
}

main().catch((error) => {
    console.error(`\nERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
