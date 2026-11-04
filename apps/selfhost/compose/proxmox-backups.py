#!/usr/bin/env python3
"""Proxmox backups -> ClickHouse maple.proxmox_backups (CT130, cron every 15 min). Read-only PVE token (PVEAuditor).

Why not `storage/<s>/content`: PVE hides backup volumes from that listing unless the caller holds
Datastore.AllocateSpace + VM.Backup (write privileges). The Audit-only sources are:
  - GET nodes/<n>/storage/<s>/prunebackups  -> every archive (volid, vmid, ctime, type)  [Datastore.Audit]
  - GET nodes/<n>/tasks?typefilter=vzdump + task logs -> "archive file size: 1.75GB"     [Sys.Audit]
  - GET cluster/backup                        -> jobs                                    [Sys.Audit]
  - GET storage                               -> storage type/shared (not in PVE's OTel)  [Datastore.Audit]
Sizes come from the vzdump task log (3 significant digits). An archive whose task log PVE no longer keeps
gets size 0 + size_known 0; the UI says so. Parsed task logs are cached in CACHE so each log is read once.
Fail-loud: any API/CH error -> stderr + exit 1, and the table keeps the last good snapshot.
"""
import json, os, re, ssl, subprocess, sys, time, urllib.parse, urllib.request

API = os.environ["MAPLE_PVE_API"].rstrip("/")
AUTH = f"PVEAPIToken={os.environ['MAPLE_PVE_TOKEN_ID']}={os.environ['MAPLE_PVE_TOKEN_SECRET']}"
CACHE = os.environ.get("PROXMOX_BACKUPS_CACHE", "/srv/maple/proxmox-backups-cache.json")
ORG = os.environ.get("MAPLE_ORG_ID", "default")
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE  # PVE self-signed cert on the LAN

UNITS = {"B": 1, "KB": 1024, "KiB": 1024, "MB": 1024**2, "MiB": 1024**2, "GB": 1024**3, "GiB": 1024**3, "TB": 1024**4, "TiB": 1024**4}


def get(path):
    req = urllib.request.Request(API + "/api2/json" + path, headers={"Authorization": AUTH})
    with urllib.request.urlopen(req, context=CTX, timeout=30) as r:
        return json.load(r)["data"]


def size_of(text):
    m = re.match(r"([\d.]+)\s*([KMGT]i?B|B)", text.strip())
    return int(float(m.group(1)) * UNITS[m.group(2)]) if m else 0


def main():
    cache = {}
    if os.path.exists(CACHE):
        cache = json.load(open(CACHE))
    sizes = cache.setdefault("sizes", {})  # archive path basename -> bytes
    seen = set(cache.setdefault("upids", []))

    nodes = [n["node"] for n in get("/nodes") if n.get("status") == "online"]
    storages = [s for s in get("/storage") if "backup" in s.get("content", "")]

    # Task logs -> archive sizes (new tasks only).
    for node in nodes:
        for task in get(f"/nodes/{node}/tasks?typefilter=vzdump&limit=10000&source=all"):
            upid = task["upid"]
            # Only a finished task's log is final: one read mid-run has "creating archive" but no size yet.
            if upid in seen or not task.get("endtime") or not task.get("status"):
                continue
            log = get(f"/nodes/{node}/tasks/{urllib.parse.quote(upid)}/log?limit=100000")
            current, unsized = None, 0
            for line in log:
                t = line.get("t", "")
                m = re.search(r"creating (?:vzdump )?archive '([^']+)'", t)
                if m:
                    if current:
                        unsized += 1
                    current = os.path.basename(m.group(1))
                m = re.search(r"archive file size: (.+)$", t)
                if m and current:
                    sizes[current] = size_of(m.group(1))
                    current = None
            if current:
                unsized += 1
            # A failed guest in a multi-guest job leaves an archive unsized for good; anything else retries next run.
            if unsized == 0 or task.get("status") != "OK":
                seen.add(upid)

    # Archives: shared stores once, local ones per node.
    rows, done = [], set()
    for st in storages:
        on = nodes if not st.get("shared") else nodes[:1]
        allowed = st.get("nodes", "").split(",") if st.get("nodes") else nodes
        for node in on:
            if node not in allowed:
                continue
            key = st["storage"] if st.get("shared") else f"{st['storage']}@{node}"
            if key in done:
                continue
            done.add(key)
            for b in get(f"/nodes/{node}/storage/{st['storage']}/prunebackups?prune-backups=keep-all%3D1"):
                volid = b["volid"]
                base = os.path.basename(volid.split(":", 1)[1])
                size = sizes.get(base)
                rows.append({
                    "OrgId": ORG, "Volid": volid, "Storage": st["storage"], "Node": "" if st.get("shared") else node,
                    "Vmid": str(b.get("vmid", "")), "GuestType": b.get("type", ""), "Ctime": int(b["ctime"]),
                    "SizeBytes": size or 0, "SizeKnown": 1 if size else 0,
                    "Protected": 1 if b.get("mark") == "protected" else 0,  # keep-all: marks are keep/protected/renamed
                })

    jobs = [{
        "OrgId": ORG, "JobId": j["id"], "Schedule": str(j.get("schedule", "")), "Storage": str(j.get("storage", "")),
        "Vmids": str(j.get("vmid") or ("all" if j.get("all") else "")), "Enabled": 1 if int(j.get("enabled", 1)) == 1 else 0,
        "Comment": str(j.get("comment", ""))[:120],
    } for j in get("/cluster/backup")]

    stores = [{
        "OrgId": ORG, "Storage": st["storage"], "Type": st.get("type", ""), "Shared": 1 if st.get("shared") else 0,
        "Content": st.get("content", ""), "Nodes": st.get("nodes", ""),
    } for st in get("/storage")]

    if not rows:
        raise SystemExit("no backup archives returned; refusing to overwrite the last snapshot")

    snap = int(time.time())
    for r in rows:
        r["SnapshotTime"] = snap
    for j in jobs + stores:
        j["SnapshotTime"] = snap

    def insert(table, data):
        body = "\n".join(json.dumps(x) for x in data)
        # maple_ingest has INSERT on maple.*. ClickHouse = shared clickhouse-01 (MAPLE_CH_URL from .env, BRIEF-perf B).
        q = urllib.parse.urlencode({"query": f"INSERT INTO maple.{table} FORMAT JSONEachRow"})
        req = urllib.request.Request(f"{os.environ['MAPLE_CH_URL'].rstrip('/')}/?{q}", data=body.encode(), method="POST",
                                     headers={"X-ClickHouse-User": "maple_ingest", "X-ClickHouse-Key": os.environ["CH_INGEST_PASSWORD"]})
        with urllib.request.urlopen(req, timeout=60) as r:
            r.read()

    insert("proxmox_backups", rows)
    insert("proxmox_backup_jobs", jobs)
    insert("proxmox_storage", stores)

    cache["upids"] = sorted(seen)
    tmp = CACHE + ".tmp"
    json.dump(cache, open(tmp, "w"))
    os.replace(tmp, CACHE)
    known = sum(r["SizeKnown"] for r in rows)
    print(f"{time.strftime('%FT%TZ', time.gmtime())} ok archives={len(rows)} sized={known} jobs={len(jobs)} storages={len(stores)} bytes={sum(r['SizeBytes'] for r in rows)}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # fail loud, keep last data
        print(f"{time.strftime('%FT%TZ', time.gmtime())} FAIL {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)
