# Service images (context §16.3): distroless + Node 24, non-root, no shell, no package
# manager. Files are owned by root and read-only to the runtime user; run with a
# read-only root filesystem. Build one target at a time from the repository root:
#   docker build -f infra/docker/Dockerfile --target api -t rp-api .
# Base images are pinned by digest; Renovate proposes updates and a weekly CI rebuild
# picks up patched layers.

FROM docker.io/library/node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
ENV CI=true PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate
WORKDIR /src
# Dependencies first so source edits reuse the install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/checkout/package.json apps/checkout/
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
RUN pnpm exec tsc --build apps/api apps/worker apps/signer \
 && pnpm --filter @rp/checkout build
# Production-only trees: each app with its runtime dependencies and built workspace packages.
RUN for app in api worker signer; do \
      pnpm --filter "@rp/$app" deploy --legacy --prod "/out/$app" || exit 1; \
    done \
 && cp -r apps/checkout/dist /out/api/checkout

# distroless/cc (glibc + libstdc++, no shell) plus the exact Node binary from the build
# image: distroless/nodejs24 lagged behind (24.14.0 vs the pinned 24.21.0).
FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f AS runtime
COPY --from=build /usr/local/bin/node /nodejs/bin/node
WORKDIR /app
ENV NODE_ENV=production
USER 65532:65532
ENTRYPOINT ["/nodejs/bin/node"]

FROM runtime AS api
COPY --from=build /out/api /app
ENV CHECKOUT_ASSETS_DIR=/app/checkout
EXPOSE 8080
CMD ["dist/main.js"]

FROM runtime AS worker
COPY --from=build /out/worker /app
EXPOSE 9090
CMD ["dist/main.js"]

FROM runtime AS signer
COPY --from=build /out/signer /app
EXPOSE 9443
# Node permission model: reads limited to the app and the mounted secrets; no writes,
# no child processes, no workers, no addons (network is restricted by NetworkPolicy).
CMD ["--permission", "--allow-fs-read=/app", "--allow-fs-read=/run/secrets", "dist/main.js"]
