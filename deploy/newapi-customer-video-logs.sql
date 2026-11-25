BEGIN;

CREATE OR REPLACE VIEW portal_sd_video.customer_tasks WITH (security_barrier = true) AS
SELECT t.task_id, t.user_id AS owner_id,
       t.properties::jsonb ->> 'origin_model_name' AS model,
       t.status, t.progress, t.submit_time, t.finish_time,
       -- AIGAS output_seconds may be copied from the requested length.
       CASE WHEN t.status = 'SUCCESS' AND t.platform IN ('doubao', 'llmroute_artsdance_flash')
           THEN t.data::jsonb ->> 'duration' END AS output_seconds,
       CASE WHEN t.status = 'SUCCESS' THEN t.data::jsonb ->> 'resolution' END AS output_resolution,
       CASE WHEN t.status = 'SUCCESS' THEN t.data::jsonb ->> 'ratio' END AS output_ratio,
       jsonb_build_object(
           'resolution', t.request_body::jsonb -> 'resolution',
           'ratio', COALESCE(t.request_body::jsonb -> 'ratio', t.request_body::jsonb -> 'aspect_ratio'),
           'duration', COALESCE(t.request_body::jsonb -> 'duration', t.request_body::jsonb -> 'seconds'),
           'generate_audio', t.request_body::jsonb -> 'generate_audio',
           'watermark', t.request_body::jsonb -> 'watermark',
           'seed', t.request_body::jsonb -> 'seed',
           'has_video', CASE WHEN jsonb_typeof(t.request_body::jsonb -> 'content') = 'array' THEN
               EXISTS (SELECT 1 FROM jsonb_array_elements(t.request_body::jsonb -> 'content') item
                       WHERE item ->> 'type' IN ('video_url', 'video')) END
       ) AS request_summary,
       CASE WHEN t.status = 'SUCCESS' THEN COALESCE(
           t.data::jsonb #>> '{metadata,url}', t.data::jsonb #>> '{content,video_url}'
       ) END AS media_url,
       CASE WHEN t.status = 'SUCCESS' THEN t.private_data::jsonb ->> 'result_url' END AS result_url
FROM public.tasks t
WHERE t.platform = 'doubao'
   OR (t.platform = 'aigas-seedance' AND t."group" = 'SD特惠')
   OR (t.platform = 'llmroute_artsdance_flash'
       AND t.properties::jsonb ->> 'origin_model_name' = 'artsdance-2-5-flash-261101');

REVOKE ALL ON portal_sd_video.customer_tasks FROM PUBLIC;
GRANT SELECT ON portal_sd_video.customer_tasks TO portal_sd_video_reader;

COMMIT;
