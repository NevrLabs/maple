-- Proxmox backups snapshot (proxmox-route brief). Written every 15 min by /opt/maple/proxmox-backups.py
-- (cron, maple_ingest user); read by /infra/proxmox through the raw-SQL query engine ($__orgFilter on OrgId).
-- One row per archive and snapshot; ReplacingMergeTree keeps the newest snapshot per archive, and readers
-- take only rows from the newest SnapshotTime, so deleted archives drop out at once. Idempotent.
CREATE TABLE IF NOT EXISTS maple.proxmox_backups
(
    OrgId LowCardinality(String),
    SnapshotTime DateTime,
    Volid String,
    Storage LowCardinality(String),
    Node LowCardinality(String),
    Vmid String,
    GuestType LowCardinality(String),
    Ctime UInt32,
    SizeBytes UInt64,
    SizeKnown UInt8,
    Protected UInt8
)
ENGINE = ReplacingMergeTree(SnapshotTime)
ORDER BY (OrgId, Volid)
TTL SnapshotTime + toIntervalDay(30);

CREATE TABLE IF NOT EXISTS maple.proxmox_backup_jobs
(
    OrgId LowCardinality(String),
    SnapshotTime DateTime,
    JobId String,
    Schedule String,
    Storage LowCardinality(String),
    Vmids String,
    Enabled UInt8,
    Comment String
)
ENGINE = ReplacingMergeTree(SnapshotTime)
ORDER BY (OrgId, JobId)
TTL SnapshotTime + toIntervalDay(30);

CREATE TABLE IF NOT EXISTS maple.proxmox_storage
(
    OrgId LowCardinality(String),
    SnapshotTime DateTime,
    Storage String,
    Type LowCardinality(String),
    Shared UInt8,
    Content String,
    Nodes String
)
ENGINE = ReplacingMergeTree(SnapshotTime)
ORDER BY (OrgId, Storage)
TTL SnapshotTime + toIntervalDay(30);
