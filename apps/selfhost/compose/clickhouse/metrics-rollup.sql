-- Fork-owned (PATCHES #19): hourly per-series rollup of gauge + sum metrics, kept 3 years after raw metrics expire (90d).
-- Not an upstream migration: fork DDL stays out of the numbered sequence so upstream syncs never collide.
-- Idempotent; run by the `ch-retention` compose service after every schema migration. Read it with raw-SQL widgets
-- ($__orgFilter on OrgId). Gauges: avg = Sum / Count, plus Min / Max / Last.
-- Counters (MetricType 'sum'): cumulative (Temporality 2) -> increase = Last(hour) - Last(previous hour), a negative
-- difference is a reset; delta (Temporality 1) -> increase = Sum.
-- ponytail: histograms are not rolled up (no long-term percentiles); trace latency already has traces_aggregates_hourly
-- for 3 years. Add a bucket-merging histogram rollup if host-level latency history is needed.
CREATE TABLE IF NOT EXISTS maple.metrics_hourly
(
    OrgId LowCardinality(String),
    MetricName LowCardinality(String),
    ServiceName LowCardinality(String),
    MetricType LowCardinality(String),
    Temporality Int32,
    IsMonotonic Bool,
    MetricUnit LowCardinality(String),
    Attributes Map(LowCardinality(String), String),
    ResourceAttributes Map(LowCardinality(String), String),
    Hour DateTime,
    Min SimpleAggregateFunction(min, Float64),
    Max SimpleAggregateFunction(max, Float64),
    Sum SimpleAggregateFunction(sum, Float64),
    Count SimpleAggregateFunction(sum, UInt64),
    Last AggregateFunction(argMax, Float64, DateTime64(9))
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(Hour)
ORDER BY (OrgId, MetricName, ServiceName, MetricType, Temporality, IsMonotonic, MetricUnit, Attributes, ResourceAttributes, Hour)
TTL toDate(Hour) + toIntervalDay(1095)
SETTINGS ttl_only_drop_parts = 1;

CREATE MATERIALIZED VIEW IF NOT EXISTS maple.metrics_hourly_gauge_mv TO maple.metrics_hourly AS
SELECT OrgId, MetricName, ServiceName, 'gauge' AS MetricType, toInt32(0) AS Temporality, false AS IsMonotonic, MetricUnit,
       Attributes, ResourceAttributes, toStartOfHour(toDateTime(TimeUnix)) AS Hour,
       min(Value) AS Min, max(Value) AS Max, sum(Value) AS Sum, count() AS Count, argMaxState(Value, TimeUnix) AS Last
FROM maple.metrics_gauge
GROUP BY OrgId, MetricName, ServiceName, MetricUnit, Attributes, ResourceAttributes, Hour;

CREATE MATERIALIZED VIEW IF NOT EXISTS maple.metrics_hourly_sum_mv TO maple.metrics_hourly AS
SELECT OrgId, MetricName, ServiceName, 'sum' AS MetricType, AggregationTemporality AS Temporality, IsMonotonic, MetricUnit,
       Attributes, ResourceAttributes, toStartOfHour(toDateTime(TimeUnix)) AS Hour,
       min(Value) AS Min, max(Value) AS Max, sum(Value) AS Sum, count() AS Count, argMaxState(Value, TimeUnix) AS Last
FROM maple.metrics_sum
GROUP BY OrgId, MetricName, ServiceName, AggregationTemporality, IsMonotonic, MetricUnit, Attributes, ResourceAttributes, Hour;
