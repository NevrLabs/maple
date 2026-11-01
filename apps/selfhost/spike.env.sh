#!/usr/bin/env bash
# Spike env for the self-hosted api on fxcompute-01 (throwaway PG/CH containers). Test values only.
export PORT=3472
export MAPLE_AUTH_MODE=self_hosted
export MAPLE_ROOT_PASSWORD=spike-root-password
export MAPLE_DEFAULT_ORG_ID=default
export MAPLE_INTERNAL_ORG_ID=default
export MAPLE_ENVIRONMENT=selfhost
export MAPLE_PG_URL=postgres://maple:spikepw@127.0.0.1:55432/maple
export CLICKHOUSE_URL=http://127.0.0.1:58123
export CLICKHOUSE_PROVIDER=clickhouse
export CLICKHOUSE_USER=maple
export CLICKHOUSE_PASSWORD=spikech
export CLICKHOUSE_DATABASE=default
export TINYBIRD_HOST=http://unused.invalid
export TINYBIRD_TOKEN=unused
export MAPLE_INGEST_KEY_ENCRYPTION_KEY=$(head -c32 /dev/urandom | base64)
export MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY=$(head -c32 /dev/urandom | base64)
export MAPLE_SHARE_TOKEN_HMAC_KEY=$(head -c32 /dev/urandom | base64)
export MAPLE_APP_BASE_URL=http://maple.k3s.home
export MAPLE_API_BASE_URL=http://maple-api.k3s.home
export MAPLE_INGEST_PUBLIC_URL=http://maple-ingest.k3s.home
