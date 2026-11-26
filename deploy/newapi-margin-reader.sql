-- Run in the new-api PostgreSQL database with a role that owns public.logs and public.tasks.
-- Give the Portal's dedicated login membership in portal_margin_reader.
BEGIN;

DO $roles$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_margin_reader') THEN
        CREATE ROLE portal_margin_reader NOLOGIN;
    END IF;
END
$roles$;

CREATE SCHEMA IF NOT EXISTS portal_margin;
REVOKE ALL ON SCHEMA portal_margin FROM PUBLIC;
GRANT USAGE ON SCHEMA portal_margin TO portal_margin_reader;

-- Stored metadata is text. Unparseable historical rows still contribute their quota.
-- The exception block opens a subtransaction, so this helper must run outside parallel workers.
CREATE OR REPLACE FUNCTION portal_margin.log_meta(value text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE PARALLEL UNSAFE STRICT
SET search_path TO pg_catalog
AS $function$
BEGIN
    RETURN value::jsonb;
EXCEPTION WHEN data_exception THEN
    RETURN NULL;
END
$function$;

REVOKE ALL ON FUNCTION portal_margin.log_meta(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION portal_margin.log_meta(text) TO portal_margin_reader;

CREATE OR REPLACE VIEW portal_margin.charge_events WITH (security_barrier = true) AS
SELECT id, user_id, created_at, type, channel_id, channel_name, "group" AS group_name, model_name,
       quota, request_id, upstream_request_id,
       nullif(portal_margin.log_meta(other)->>'task_id','') AS task_id,
       coalesce(portal_margin.log_meta(other)->>'is_task' = 'true', false) AS is_task
FROM public.logs
WHERE type IN (2, 5, 6);

CREATE OR REPLACE VIEW portal_margin.task_refs WITH (security_barrier = true) AS
SELECT task_id, user_id, channel_id, submit_time, finish_time, status,
       coalesce(nullif(private_data->>'upstream_task_id',''),nullif(data->>'id','')) AS upstream_task_id
FROM public.tasks;

REVOKE ALL ON portal_margin.charge_events, portal_margin.task_refs FROM PUBLIC;
GRANT SELECT ON portal_margin.charge_events, portal_margin.task_refs TO portal_margin_reader;

COMMIT;
