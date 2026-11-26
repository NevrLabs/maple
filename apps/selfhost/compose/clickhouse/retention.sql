-- Homelab retention (owner decision 2026-11-26): raw logs/traces 30d, raw metrics 90d (Maple's own defaults),
-- hour-grain rollups 3 years. Supersedes BRIEF-v4 / BRIEF-uptime 4 (7/14/30 was the Ceph-era budget).
-- Idempotent; run after every schema migration (compose service `ch-retention`).
-- MODIFY TTL without materialization binds only NEW parts: with ttl_only_drop_parts=1, existing parts keep the
-- expiry stamped at write time. After RAISING a TTL here, recalculate existing parts once (no data rewrite):
--   ALTER TABLE t MODIFY SETTING materialize_ttl_recalculate_only = 1; ALTER TABLE t MATERIALIZE TTL;
--   ALTER TABLE t RESET SETTING materialize_ttl_recalculate_only
SET materialize_ttl_after_modify = 0;
ALTER TABLE maple.traces MODIFY TTL toDate(Timestamp) + toIntervalDay(30);
ALTER TABLE maple.logs MODIFY TTL toDate(TimestampTime) + toIntervalDay(30);
ALTER TABLE maple.service_map_spans MODIFY TTL toDate(Timestamp) + toIntervalDay(30);
ALTER TABLE maple.service_overview_spans MODIFY TTL toDate(Timestamp) + toIntervalDay(30);
ALTER TABLE maple.trace_index MODIFY TTL toDate(Bucket) + toIntervalDay(30);
ALTER TABLE maple.trace_list_mv MODIFY TTL toDate(Timestamp) + toIntervalDay(30);
ALTER TABLE maple.metrics_gauge MODIFY TTL toDate(TimeUnix) + toIntervalDay(90);
ALTER TABLE maple.metrics_sum MODIFY TTL toDate(TimeUnix) + toIntervalDay(90);
ALTER TABLE maple.metrics_histogram MODIFY TTL toDate(TimeUnix) + toIntervalDay(90);
ALTER TABLE maple.metrics_exponential_histogram MODIFY TTL toDate(TimeUnix) + toIntervalDay(90);
-- Hour-grain rollups: 3 years (upstream 365d).
ALTER TABLE maple.traces_aggregates_hourly MODIFY TTL toDate(Hour) + toIntervalDay(1095);
ALTER TABLE maple.logs_aggregates_hourly MODIFY TTL toDate(Hour) + toIntervalDay(1095);
ALTER TABLE maple.service_overview_hourly MODIFY TTL toDate(Hour) + toIntervalDay(1095);
ALTER TABLE maple.service_operations_hourly MODIFY TTL toDate(Hour) + toIntervalDay(1095);
ALTER TABLE maple.service_map_edges_hourly MODIFY TTL toDate(Hour) + toIntervalDay(1095);
ALTER TABLE maple.service_map_db_edges_hourly MODIFY TTL toDate(Hour) + toIntervalDay(1095);
ALTER TABLE maple.service_map_db_query_shapes_hourly MODIFY TTL toDate(Hour) + toIntervalDay(1095);
ALTER TABLE maple.service_external_edges_hourly MODIFY TTL toDate(Hour) + toIntervalDay(1095);
ALTER TABLE maple.service_platforms_hourly MODIFY TTL toDate(Hour) + toIntervalDay(1095);
ALTER TABLE maple.service_address_resolutions_hourly MODIFY TTL toDate(Hour) + toIntervalDay(1095);
ALTER TABLE maple.service_usage MODIFY TTL Hour + toIntervalDay(1095);
ALTER TABLE maple.span_metrics_calls_hourly MODIFY TTL toDate(Hour) + toIntervalDay(1095);
ALTER TABLE maple.aws_metrics_hourly MODIFY TTL toDate(Hour) + toIntervalDay(1095);
