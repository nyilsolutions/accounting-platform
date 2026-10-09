# syntax=docker/dockerfile:1.7
#
# Images for AWS (ADR 0030). One build, three targets:
#   api    - the API (default command), the worker (`node dist/worker.js`) and the release step
#            (`node dist/release.js`: app role, migrations, job queue), all from the same code.
#   web    - the Next.js standalone server.
#   clamd  - ClamAV from Debian's packages, the API's virus scanner beside it in each task.
# api and web run as the unprivileged `node` user with the application files owned by root
# (read-only); clamd runs as `clamav`.
#
#   docker build --target api -t acct-api .
#   docker build --target web --build-arg API_URL=http://api.acct.internal:4000 -t acct-web .
#   docker build --target clamd --build-arg SIGNATURES_DATE=$(date -u +%F) -t acct-clamd .
#
# Volumes: ECS mounts an empty volume over each VOLUME path with the image's ownership, so a
# path the app writes to (the root filesystem is read-only) is declared after it is chowned.

# Node 22 LTS and Debian 13, pinned by digest; Dependabot proposes updates
# (.github/dependabot.yml).
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
ARG DEBIAN_IMAGE=debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f

FROM ${NODE_IMAGE} AS build
ENV CI=true NEXT_TELEMETRY_DISABLED=1 TURBO_TELEMETRY_DISABLED=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
# Dependencies first, so they are cached until the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline
# The web app's rewrites send /api to this address, fixed at build time (next.config.ts).
ARG API_URL=http://api.acct.internal:4000
RUN API_URL=${API_URL} NEXT_OUTPUT=standalone pnpm turbo run build --filter=@acct/api... --filter=@acct/web...
# The API with its production dependencies only (workspace packages copied in).
RUN pnpm --filter @acct/api --prod deploy --legacy /out/api

FROM ${NODE_IMAGE} AS runtime
# Debian security updates published since the base image was built (the CI scan fails on
# fixable high and critical findings), then the Node package managers, which nothing uses at
# run time, are removed from what runs and what scanners report.
RUN apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

FROM runtime AS api
ENV NODE_ENV=production \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-ca.pem \
    TAX_DATA_DIR=/app/tax-data \
    API_PORT=4000
WORKDIR /app
# Amazon RDS certificate authorities (truststore.pki.rds.amazonaws.com/global/global-bundle.pem),
# so database connections can use sslmode=verify-full.
COPY docker/rds-global-bundle.pem /etc/ssl/certs/rds-ca.pem
COPY --from=build /out/api ./
COPY --from=build /repo/tax-data ./tax-data
COPY --from=build /repo/efile-ats ./efile-ats
USER node
VOLUME ["/tmp"]
EXPOSE 4000
# No image health check: the same image runs the worker, which has no port. The load balancer
# checks the API's /health/ready (ADR 0030).
CMD ["node", "dist/main.js"]

FROM runtime AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
# The only place the server writes (ECS mounts a volume here; the root filesystem is read-only).
RUN mkdir -p apps/web/.next/cache && chown node:node apps/web/.next/cache
USER node
VOLUME ["/app/apps/web/.next/cache"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]

FROM ${DEBIAN_IMAGE} AS clamd
# A fixed system user and group (999), so the task definition can name them.
RUN groupadd --system --gid 999 clamav \
  && useradd --system --uid 999 --gid clamav --home-dir /var/lib/clamav --no-create-home \
    --shell /usr/sbin/nologin clamav \
  && apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates clamav-daemon clamav-freshclam clamdscan \
  && rm -rf /var/lib/apt/lists/* /var/lib/clamav /var/log/clamav /run/clamav \
  && install -d -o clamav -g clamav /var/lib/clamav /usr/local/share/clamav/seed
COPY docker/clamd/clamd.conf docker/clamd/freshclam.conf /etc/clamav/
COPY docker/clamd/entrypoint.sh /usr/local/bin/clamd-entrypoint
USER clamav
# The signatures as of the build, copied into the volume when a task starts so clamd is ready at
# once; freshclam then fetches only what changed. The deploy passes the date, so the layer is
# downloaded again at most once a day (ClamAV's mirrors limit full downloads).
ARG SIGNATURES_DATE=unset
RUN echo "signatures of ${SIGNATURES_DATE}" \
  && freshclam --foreground --stdout --datadir=/usr/local/share/clamav/seed \
  && rm -f /usr/local/share/clamav/seed/freshclam.dat
VOLUME ["/var/lib/clamav", "/tmp"]
EXPOSE 3310
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=5 \
  CMD ["clamdscan", "--ping=1"]
ENTRYPOINT ["/usr/local/bin/clamd-entrypoint"]
