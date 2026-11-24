-- Run in the new-api PostgreSQL database as an operator after creating the
-- dedicated portal_sd_video_reader login with a password held outside Git.
-- The Portal connection selects from this view. Base-table permissions are unnecessary.
BEGIN;
CREATE SCHEMA IF NOT EXISTS portal_sd_video;
REVOKE ALL ON SCHEMA portal_sd_video FROM PUBLIC;

CREATE OR REPLACE VIEW portal_sd_video.delivery_tasks WITH (security_barrier = true) AS
SELECT t.task_id, t.user_id AS owner_id, t.properties::jsonb ->> 'origin_model_name' AS sku,
       t.status, t.progress, t.submit_time, t.finish_time,
       CASE WHEN t.status = 'SUCCESS' THEN t.data::jsonb #>> '{metadata,url}' END AS media_url
FROM public.tasks t
WHERE t.platform = 'aigas-seedance' AND t."group" = 'SD特惠';

REVOKE ALL ON portal_sd_video.delivery_tasks FROM PUBLIC;
GRANT USAGE ON SCHEMA portal_sd_video TO portal_sd_video_reader;
GRANT SELECT ON portal_sd_video.delivery_tasks TO portal_sd_video_reader;
COMMIT;
