#!/usr/bin/env bash
# Build Maple selfhost images on fxcompute-01.
# Root disk is ~95% full: all build state + contexts live on DeepVault NFS (/mnt/deepvault/maple-build);
# runtime images ship BUNDLES (bun build), never node_modules.
set -euo pipefail
SRC=${SRC:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}
OUT=${OUT:-/mnt/deepvault/maple-build}
BUN=${BUN:-$HOME/.bun/bin/bun}
mkdir -p $OUT/cargo-target $OUT/go $OUT/ctx
TAG=${TAG:-$(git -C "$SRC" rev-parse --short HEAD)}
echo "building tag=$TAG"
EXT=(-e "cloudflare:*" -e vite -e "@vitejs/*" -e vitest -e "@cloudflare/vite-plugin" -e wrangler -e miniflare -e esbuild -e rolldown -e lightningcss -e "@rolldown/*" -e "@alchemy.run/frontend-frameworks/astro/config" -e react-devtools-core)

build_selfhost() {
  echo "== selfhost bundles (api, alerting, electric-sync, scraper, status, pg-migrate, ch-migrate)"
  C=$OUT/ctx/selfhost; rm -rf $C; mkdir -p $C/app/db $C/app/ch
  cd $SRC
  $BUN build apps/selfhost/src/api.ts      --target=bun --outfile=$C/app/api.js      "${EXT[@]}" | tail -1
  $BUN build apps/selfhost/src/alerting.ts --target=bun --outfile=$C/app/alerting.js "${EXT[@]}" | tail -1
  $BUN build apps/selfhost/src/electric-sync.ts --target=bun --outfile=$C/app/electric-sync.js "${EXT[@]}" | tail -1
  # PATCHES #8/#9: uptime prober (apps/scraper, unmodified entry) + status-page server.
  ( cd packages/effect-sdk && $BUN run build >/dev/null 2>&1 )
  $BUN build apps/scraper/src/main.ts      --target=bun --outfile=$C/app/scraper.js  "${EXT[@]}" | tail -1
  $BUN build apps/selfhost/src/status.ts   --target=bun --outfile=$C/app/status.js   "${EXT[@]}" | tail -1
  # migrate.ts resolves ../drizzle from its own file -> place bundle at db/scripts/, assets at db/drizzle.
  mkdir -p $C/app/db/scripts
  $BUN build packages/db/scripts/migrate.ts --target=bun --outfile=$C/app/db/scripts/migrate.js "${EXT[@]}" | tail -1
  cp -r packages/db/drizzle $C/app/db/drizzle
  $BUN build packages/clickhouse-cli/src/cli.ts --target=bun --outfile=$C/app/ch/cli.js "${EXT[@]}" | tail -1
  cat > $C/Dockerfile <<'EOF'
FROM oven/bun:1.4.4-slim
WORKDIR /app
COPY app /app
USER bun
ENV NODE_ENV=production
EXPOSE 3472 3475 3476 3478 3480
CMD ["bun", "/app/api.js"]
EOF
  docker build -q -t maple-selfhost:$TAG $C
}

build_web() {
  echo "== web (vite build)"
  cd $SRC
  ( cd packages/effect-sdk && $BUN run build >/dev/null 2>&1 )
  VITE_MAPLE_LAB=${VITE_MAPLE_LAB:-on} VITE_API_BASE_URL=${VITE_API_BASE_URL:-/_api} VITE_MAPLE_AUTH_MODE=self_hosted VITE_MAPLE_OIDC="${VITE_MAPLE_OIDC:-Zitadel}" \
  VITE_ELECTRIC_SYNC_URL=${VITE_ELECTRIC_SYNC_URL:-/_sync} VITE_INGEST_URL=${VITE_INGEST_URL:-http://192.168.100.30:3474} VITE_MAPLE_REPLAY=off VITE_MAPLE_CAPTURE=${VITE_MAPLE_CAPTURE:-off} VITE_COMMIT_SHA=$TAG \
    $BUN run --cwd apps/web build 2>&1 | tail -3
  C=$OUT/ctx/web; rm -rf $C; mkdir -p $C
  cp -r apps/web/dist $C/dist; cp apps/web/nginx.conf $C/
  cat > $C/Dockerfile <<'EOF'
FROM nginx:alpine
COPY dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
EOF
  docker build -q -t maple-web:$TAG $C
}

build_collector() {
  echo "== otel-collector (ocb in golang container; go cache on DeepVault)"
  C=$OUT/ctx/collector; rm -rf $C; mkdir -p $C
  docker run --rm -u "$(id -u):$(id -g)" -e HOME=/go -e GOPATH=/go -e GOCACHE=/go/cache -e GOFLAGS=-buildvcs=false \
    -v $SRC/otel:/work/otel:ro -v $SRC/packages/otel-collector-maple-exporter:/work/packages/otel-collector-maple-exporter:ro \
    -v $OUT/go:/go -v $C:/out -w /tmp golang:1.26-alpine sh -c '
      set -e; mkdir -p /tmp/b/packages && cp /work/otel/builder-config.yaml /tmp/b/ && cp -r /work/packages/otel-collector-maple-exporter /tmp/b/packages/
      cd /tmp/b
      [ -x /go/bin/builder ] || CGO_ENABLED=0 go install go.opentelemetry.io/collector/cmd/builder@v0.151.0
      CGO_ENABLED=0 /go/bin/builder --config=builder-config.yaml >/tmp/ocb.log 2>&1 || { tail -40 /tmp/ocb.log; exit 1; }
      cp bin/otel-collector-maple /out/'
  cat > $C/Dockerfile <<'EOF'
FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY otel-collector-maple /usr/local/bin/otel-collector-maple
EXPOSE 4317 4318 13133
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/otel-collector-maple"]
CMD ["--config", "/etc/otelcol/config.yaml"]
EOF
  docker build -q -t maple-otel-collector:$TAG $C
}

build_ingest() {
  echo "== ingest (cargo on host, target dir on DeepVault)"
  ( cd $SRC/apps/ingest && CARGO_TARGET_DIR=$OUT/cargo-target nice ~/.cargo/bin/cargo build --release -j3 2>&1 | tail -3 )
  C=$OUT/ctx/ingest; rm -rf $C; mkdir -p $C
  cp $OUT/cargo-target/release/maple-ingest $C/
  cat > $C/Dockerfile <<'EOF'
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY maple-ingest /usr/local/bin/maple-ingest
EXPOSE 3474
USER 65532:65532
CMD ["maple-ingest"]
EOF
  docker build -q -t maple-ingest:$TAG $C
}

what=${1:-all}
case $what in
  selfhost) build_selfhost;; web) build_web;; collector) build_collector;; ingest) build_ingest;;
  all) build_selfhost; build_web; build_collector; build_ingest;;
esac
docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep "^maple-" || true
df -h / | tail -1
echo BUILD-DONE
