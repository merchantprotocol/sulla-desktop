FROM python:3.12.12-slim-bookworm AS build

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends build-essential libfuse3-dev pkg-config \
 && pip wheel --wheel-dir /wheels pyfuse3==3.3.0 trio==0.32.0 PyYAML==6.0.3 \
 && rm -rf /var/lib/apt/lists/*

FROM python:3.12.12-slim-bookworm

# Keep tini registered as a subreaper even if the runtime wraps the container entrypoint.
ENV TINI_SUBREAPER=1

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends ca-certificates fuse3 tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /wheels /wheels
RUN pip install --no-cache-dir /wheels/* && rm -rf /wheels
COPY --chmod=0755 services/sulla-files-fuse/entrypoint.sh /usr/local/bin/sulla-files-fuse-entrypoint
COPY --chmod=0755 services/sulla-files-fuse/sulla_files_fuse.py /usr/local/libexec/sulla-files-fuse.py
RUN install -d -m 0700 /run/sulla-files-fuse /mnt/sulla-files

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/sulla-files-fuse-entrypoint"]
