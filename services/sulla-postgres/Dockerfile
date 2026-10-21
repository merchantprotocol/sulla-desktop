ARG PG_MAJOR=16
ARG PGVECTOR_VERSION=0.8.1
FROM postgres:${PG_MAJOR}-alpine AS pgvector-builder
ARG PGVECTOR_VERSION
RUN apk add --no-cache build-base clang21 llvm21-dev git && \
    git clone --branch v${PGVECTOR_VERSION} --depth 1 https://github.com/pgvector/pgvector.git /src/pgvector && \
    make -C /src/pgvector OPTFLAGS="-O3" && make -C /src/pgvector install

FROM postgres:${PG_MAJOR}-alpine
COPY --from=pgvector-builder /usr/local/lib/postgresql/vector.so /usr/local/lib/postgresql/vector.so
COPY --from=pgvector-builder /usr/local/share/postgresql/extension/vector* /usr/local/share/postgresql/extension/
