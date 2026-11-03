-- BRIEF-v4 retention for the Ceph-backed CT: raw traces 14d, raw metrics 30d.
-- BRIEF-uptime 4: raw logs 7d (only important logs are kept, see otel-collector.yaml filter/important-logs).
-- Idempotent; run after every schema migration (compose service `ch-retention`).
ALTER TABLE maple.traces MODIFY TTL toDate(Timestamp) + toIntervalDay(14);
ALTER TABLE maple.logs MODIFY TTL toDate(TimestampTime) + toIntervalDay(7);
ALTER TABLE maple.service_map_spans MODIFY TTL toDate(Timestamp) + toIntervalDay(14);
ALTER TABLE maple.service_overview_spans MODIFY TTL toDate(Timestamp) + toIntervalDay(14);
ALTER TABLE maple.trace_index MODIFY TTL toDate(Bucket) + toIntervalDay(14);
ALTER TABLE maple.trace_list_mv MODIFY TTL toDate(Timestamp) + toIntervalDay(14);
ALTER TABLE maple.metrics_gauge MODIFY TTL toDate(TimeUnix) + toIntervalDay(30);
ALTER TABLE maple.metrics_sum MODIFY TTL toDate(TimeUnix) + toIntervalDay(30);
ALTER TABLE maple.metrics_histogram MODIFY TTL toDate(TimeUnix) + toIntervalDay(30);
ALTER TABLE maple.metrics_exponential_histogram MODIFY TTL toDate(TimeUnix) + toIntervalDay(30);
