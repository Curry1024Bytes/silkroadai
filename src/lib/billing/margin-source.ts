import 'server-only';
import { Pool } from 'pg';
import type { MarginEvent, MarginTask } from './actual-margin';

let pool: Pool | undefined;

export class MarginSourceError extends Error {
    constructor(public readonly reason: 'source_missing' | 'range_too_large' | 'source_unavailable') {
        super(reason);
    }
}

const EVENT_LIMIT = 80_000;

export async function loadMarginEvents(userIds: number[], start: number, end: number) {
    const url = process.env.NEWAPI_MARGIN_DATABASE_URL;
    if (!url) throw new MarginSourceError('source_missing');
    pool ??= new Pool({
        connectionString: url,
        max: 2,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 12_000,
        options: '-c default_transaction_read_only=on',
    });
    if (!userIds.length) return { events: [], tasks: [] };
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const events = (
            await client.query<MarginEvent>(
                'SELECT * FROM portal_margin.charge_events WHERE created_at >= $1 AND created_at < $2 AND user_id = ANY($3::bigint[]) ORDER BY id LIMIT $4',
                [start, end, userIds, EVENT_LIMIT + 1],
            )
        ).rows;
        if (events.length > EVENT_LIMIT) throw new MarginSourceError('range_too_large');
        const taskIds = [...new Set(events.flatMap((event) => (event.task_id ? [event.task_id] : [])))];
        const tasks = taskIds.length
            ? (
                  await client.query<MarginTask>(
                      `WITH spans AS (
                       SELECT user_id, task_id, channel_id, min(created_at) AS first_charge_at, max(created_at) AS last_charge_at
                       FROM portal_margin.charge_events
                       WHERE task_id = ANY($1::text[]) AND user_id = ANY($2::bigint[]) AND type IN (2, 6)
                       GROUP BY user_id, task_id, channel_id
                   )
                   SELECT t.*, s.first_charge_at, s.last_charge_at
                   FROM portal_margin.task_refs t LEFT JOIN spans s USING (user_id, task_id, channel_id)
                   WHERE t.task_id = ANY($1::text[]) AND t.user_id = ANY($2::bigint[])`,
                      [taskIds, userIds],
                  )
              ).rows
            : [];
        await client.query('COMMIT');
        return { events, tasks };
    } catch (error) {
        await client?.query('ROLLBACK').catch(() => {});
        if (error instanceof MarginSourceError) throw error;
        throw new MarginSourceError('source_unavailable');
    } finally {
        client?.release();
    }
}
