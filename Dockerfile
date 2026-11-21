# SPDX-License-Identifier: AGPL-3.0-only
#
# The game's image: keel and the page it serves, built from the repository
# alone. The page is built once, on the machine that builds, whatever the
# image's platform; keel is cross-compiled for it.
#
#   docker buildx build --platform linux/arm64 --build-arg BUILD=<id> -t keel:<id> .
#
# go run ./tools/cluster -deploy builds it so for the local cluster.

ARG GO_IMAGE=golang:1.27.4-trixie@sha256:f18c3d73a184fb0582828510722e723b63a93f7188d11dd223d9be6f6880e65d
ARG NODE_IMAGE=node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc
ARG BASE_IMAGE=gcr.io/distroless/static-debian13:nonroot@sha256:e2e927ec666bae08560abb3c55d0659eceabb657f56b6782ab500a9fc7f555e3

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS node

# The page: the physics module built with the pinned TinyGo, then Vite's
# build, as CI builds it, and the world page's after it, into dist/owner/,
# which keel serves on its internal listener alone.
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS client
COPY --from=node /usr/local/bin/ /usr/local/bin/
COPY --from=node /usr/local/lib/node_modules/ /usr/local/lib/node_modules/
WORKDIR /src
COPY client/package.json client/package-lock.json client/.npmrc client/
COPY client/build/npm.mjs client/build/
# npm as client/package.json pins it, checked against its hash.
RUN --mount=type=cache,id=keel-npm,target=/root/.npm \
    node client/build/npm.mjs && cd client && npm ci
COPY go.mod go.sum ./
RUN --mount=type=cache,id=keel-gomod,target=/root/go/pkg/mod \
    go mod download
COPY . .
# The build ID, which the page sends with its hello and names its caches by.
ARG BUILD=dev
ENV KEEL_BUILD=$BUILD
# The service worker: off builds the worker that takes itself and its
# caches away, and a page that registers none (docs/development.md, "The
# service worker").
ARG SW=on
ENV KEEL_SW=$SW
# TinyGo is downloaded into .dev once and kept in the cache.
RUN --mount=type=cache,id=keel-gomod,target=/root/go/pkg/mod \
    --mount=type=cache,id=keel-gobuild-client,target=/root/.cache/go-build \
    --mount=type=cache,id=keel-tinygo,target=/src/.dev \
    go run ./tools/physics \
    && cd client && npx --no-install vite build && npx --no-install vite build -c vite.owner.config.ts

# keel, static, for the image's platform.
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,id=keel-gomod,target=/root/go/pkg/mod \
    go mod download
COPY cmd/ cmd/
COPY internal/ internal/
# The contributor agreement's texts, which keel agreement serves.
COPY legal/ legal/
ARG TARGETOS TARGETARCH
# The build ID: the image has no VCS information of its own.
ARG BUILD=dev
RUN --mount=type=cache,id=keel-gomod,target=/root/go/pkg/mod \
    --mount=type=cache,id=keel-gobuild-$TARGETARCH,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-X main.buildOverride=$BUILD" -o /out/keel ./cmd/keel

FROM ${BASE_IMAGE}
ARG BUILD=dev
LABEL org.opencontainers.image.title="keel" \
      org.opencontainers.image.description="Keel Over the Edge: the game server and its page" \
      org.opencontainers.image.source="https://github.com/daneelvt/keel-over-the-edge" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="$BUILD"
COPY --from=server /out/keel /keel
COPY --from=client /src/client/dist/ /srv/keel/client/
ENV KEEL_CLIENT_DIR=/srv/keel/client
USER 65532:65532
ENTRYPOINT ["/keel"]
CMD ["serve"]
