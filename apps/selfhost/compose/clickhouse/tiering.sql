-- BRIEF-perf B: hot (local NVMe ZFS on clickhouse-01) -> cold (Garage S3 on DeepVault) after 2 days for the raw tables.
-- Applied by ch-retention AFTER retention.sql, and only when Maple points at clickhouse-01 (the retired CT130 container has
-- no 'cold' volume). Delete horizons are the same as retention.sql. Cold parts are never merged (prefer_not_to_merge).
-- materialize_ttl_after_modify=0: re-running on every `up` must not rewrite parts; moves are evaluated by the background
-- move task. One-off after first apply: ALTER TABLE ... MATERIALIZE TTL (done at cutover).
SET materialize_ttl_after_modify = 0;
ALTER TABLE maple.traces MODIFY TTL toDate(Timestamp) + toIntervalDay(2) TO VOLUME 'cold', toDate(Timestamp) + toIntervalDay(14);
ALTER TABLE maple.logs MODIFY TTL toDate(TimestampTime) + toIntervalDay(2) TO VOLUME 'cold', toDate(TimestampTime) + toIntervalDay(7);
ALTER TABLE maple.service_map_spans MODIFY TTL toDate(Timestamp) + toIntervalDay(2) TO VOLUME 'cold', toDate(Timestamp) + toIntervalDay(14);
ALTER TABLE maple.service_overview_spans MODIFY TTL toDate(Timestamp) + toIntervalDay(2) TO VOLUME 'cold', toDate(Timestamp) + toIntervalDay(14);
ALTER TABLE maple.trace_index MODIFY TTL toDate(Bucket) + toIntervalDay(2) TO VOLUME 'cold', toDate(Bucket) + toIntervalDay(14);
ALTER TABLE maple.trace_list_mv MODIFY TTL toDate(Timestamp) + toIntervalDay(2) TO VOLUME 'cold', toDate(Timestamp) + toIntervalDay(14);
ALTER TABLE maple.metrics_gauge MODIFY TTL toDate(TimeUnix) + toIntervalDay(2) TO VOLUME 'cold', toDate(TimeUnix) + toIntervalDay(30);
ALTER TABLE maple.metrics_sum MODIFY TTL toDate(TimeUnix) + toIntervalDay(2) TO VOLUME 'cold', toDate(TimeUnix) + toIntervalDay(30);
ALTER TABLE maple.metrics_histogram MODIFY TTL toDate(TimeUnix) + toIntervalDay(2) TO VOLUME 'cold', toDate(TimeUnix) + toIntervalDay(30);
ALTER TABLE maple.metrics_exponential_histogram MODIFY TTL toDate(TimeUnix) + toIntervalDay(2) TO VOLUME 'cold', toDate(TimeUnix) + toIntervalDay(30);
