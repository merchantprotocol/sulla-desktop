# Sulla Postgres: the stock Alpine (musl) PostgreSQL 16 image plus pgvector.
#
# It must stay on postgres:16-alpine. The existing Desktop data directory was
# initialised by that image, and its text indexes are ordered by musl's
# collation. A glibc (Debian) image on the same data directory can sort text
# differently and silently corrupt those indexes. Same major version, same
# libc, same entrypoint, user and PGDATA layout: the volume mounts unchanged.
ARG POSTGRES_IMAGE=postgres:16-alpine

FROM ${POSTGRES_IMAGE} AS build
ARG PGVECTOR_VERSION=v0.8.7
ARG PGVECTOR_COMMIT=f37c13f68b57d2c3472b2214fbcff699d6d34876
RUN apk add --no-cache --virtual .build-deps build-base git
RUN git clone --depth 1 --branch "${PGVECTOR_VERSION}" https://github.com/pgvector/pgvector.git /src/pgvector \
  && test "$(git -C /src/pgvector rev-parse HEAD)" = "${PGVECTOR_COMMIT}"
# OPTFLAGS="" drops pgvector's default -march=native so the binary runs on any
# CPU of the target architecture. with_llvm=no skips JIT bitcode (needs clang).
RUN cd /src/pgvector \
  && make OPTFLAGS="" with_llvm=no \
  && make OPTFLAGS="" with_llvm=no install DESTDIR=/out

FROM ${POSTGRES_IMAGE}
COPY --from=build /out/usr/local/lib/postgresql/ /usr/local/lib/postgresql/
COPY --from=build /out/usr/local/share/postgresql/extension/ /usr/local/share/postgresql/extension/
LABEL org.opencontainers.image.source="https://github.com/merchantprotocol/sulla-desktop" \
      org.opencontainers.image.description="PostgreSQL 16 (Alpine/musl) with pgvector for Sulla Desktop"
