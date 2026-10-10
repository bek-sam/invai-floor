# invai-floor: static SPA built with Vite, served by unprivileged nginx (T-30-3).
#
# Build context is the workspace root (the parent of all invai-* repos), not this directory:
# package.json links @invai/contracts and @invai/ui via `link:../<repo>`, sibling repos, so
# pnpm and the Vite build need them on disk at those relative paths. The root is not a git repo,
# so the ignore file is BuildKit's per-Dockerfile one, Dockerfile.dockerignore.
#   docker build -f invai-floor/Dockerfile --build-arg VITE_API_URL=http://localhost:3000 .
# VITE_API_URL is baked into the bundle and into the CSP connect-src at build time: a runtime
# env var changes nothing. Every base image is pinned by digest.

# ---- build ---------------------------------------------------------------------------------
FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /build
RUN corepack enable
# Contracts and UI ship TypeScript source: their own dependencies (zod, tw-animate-css, radix-ui,
# ...) must resolve from their own node_modules during the Vite build.
WORKDIR /build/invai-contracts
COPY invai-contracts/package.json invai-contracts/pnpm-lock.yaml invai-contracts/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY invai-contracts/. .
WORKDIR /build/invai-ui
COPY invai-ui/package.json invai-ui/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY invai-ui/. .
WORKDIR /build/invai-floor
COPY invai-floor/package.json invai-floor/pnpm-lock.yaml invai-floor/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY invai-floor/. .
ARG VITE_API_URL=http://localhost:3000
ENV VITE_API_URL=${VITE_API_URL}
RUN pnpm build
# nginx.conf's CSP connect-src is templated from the same VITE_API_URL the build just used
# (T-12-5 review r1), so the header nginx sends matches the origin the built app actually calls.
RUN node scripts/render-nginx-conf.ts
# The template listens on 80; the runtime user is not root, so move it to 8080.
RUN sed -i 's/listen 80;/listen 8080;/' nginx.conf && grep -q 'listen 8080;' nginx.conf

# ---- runtime: nginx as uid 101, no server version in headers -------------------------------
FROM nginxinc/nginx-unprivileged:alpine@sha256:b9241c6e7b8e9a862f129d8d4199ab64b10390949a78bdd5603379b32c844083
COPY --from=build /build/invai-floor/dist /usr/share/nginx/html
COPY --from=build /build/invai-floor/nginx.conf /etc/nginx/conf.d/default.conf
RUN echo 'server_tokens off;' > /etc/nginx/conf.d/00-server-tokens.conf
USER 101
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "--spider", "http://127.0.0.1:8080/"]
