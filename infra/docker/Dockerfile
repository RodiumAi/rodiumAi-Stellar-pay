# Service images (context §16.3): distroless + Node 24, non-root, no shell, no package
# manager. Files are owned by root and read-only to the runtime user; run with a
# read-only root filesystem. Build one target at a time from the repository root:
#   docker build -f infra/docker/Dockerfile --target api -t rp-api .
# Base images are pinned by digest; Renovate proposes updates and a weekly CI rebuild
# picks up patched layers.

FROM docker.io/library/node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS build
ENV CI=true PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate
WORKDIR /src
# Dependencies first so source edits reuse the install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/admin/package.json apps/admin/
COPY apps/api/package.json apps/api/
COPY apps/checkout/package.json apps/checkout/
COPY apps/docs/package.json apps/docs/
COPY apps/signer/package.json apps/signer/
COPY apps/worker/package.json apps/worker/
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/security/package.json packages/security/
COPY packages/stellar/package.json packages/stellar/
COPY packages/telemetry/package.json packages/telemetry/
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm exec tsc --build apps/api apps/worker apps/signer apps/admin \
 && pnpm --filter @rp/checkout build \
 && pnpm --filter @rp/docs build
# Production-only trees: each app with its runtime dependencies and built workspace packages.
RUN for app in api worker signer admin; do \
      pnpm --filter "@rp/$app" deploy --legacy --prod "/out/$app" || exit 1; \
    done \
 && cp -r apps/checkout/dist /out/api/checkout \
 && cp -r apps/docs/dist /out/api/docs
# Node's C++ runtime libraries, kept at their multiarch paths for the runtime image.
# (relative to / because cp --parents resolves parent directories from the working dir)
RUN mkdir -p /out/syslib \
 && cd / && cp -a --parents usr/lib/*-linux-gnu/libstdc++.so.6* usr/lib/*-linux-gnu/libgcc_s.so.1 /out/syslib/ \
 && ls -l /out/syslib/usr/lib/*-linux-gnu/

# distroless/base-nossl (glibc, CA certificates, no shell, no libssl) plus the two C++
# runtime libraries and the exact Node binary from the build image. Node links OpenSSL
# statically, so the system libssl3 that distroless/cc ships was never loaded and only
# brought its CVEs. distroless/nodejs24 lagged behind the pinned Node version.
FROM gcr.io/distroless/base-nossl-debian12:nonroot@sha256:be40c00dfabd86576d92666e87e406714d5618342de1a0c213ad232de255172e AS runtime
COPY --from=build /out/syslib/ /
COPY --from=build /usr/local/bin/node /nodejs/bin/node
WORKDIR /app
ENV NODE_ENV=production
USER 65532:65532
ENTRYPOINT ["/nodejs/bin/node"]

FROM runtime AS api
COPY --from=build /out/api /app
# Public Supabase root CA for sslmode=verify-full (sslrootcert=/app/certs/…).
COPY infra/supabase/supabase-root-2021-ca.crt /app/certs/supabase-root-2021-ca.crt
ENV CHECKOUT_ASSETS_DIR=/app/checkout DOCS_ASSETS_DIR=/app/docs
EXPOSE 8080
CMD ["dist/main.js"]

FROM runtime AS worker
COPY --from=build /out/worker /app
COPY infra/supabase/supabase-root-2021-ca.crt /app/certs/supabase-root-2021-ca.crt
EXPOSE 9090
CMD ["dist/main.js"]

FROM runtime AS admin
COPY --from=build /out/admin /app
COPY infra/supabase/supabase-root-2021-ca.crt /app/certs/supabase-root-2021-ca.crt
EXPOSE 8081
CMD ["dist/main.js"]

FROM runtime AS signer
COPY --from=build /out/signer /app
EXPOSE 9443
# Node permission model: reads limited to the app and the mounted secrets; no writes,
# no child processes, no workers, no addons (network is restricted by NetworkPolicy).
CMD ["--permission", "--allow-fs-read=/app", "--allow-fs-read=/run/secrets", "dist/main.js"]
