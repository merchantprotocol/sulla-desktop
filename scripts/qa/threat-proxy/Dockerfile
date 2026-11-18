# SPDX-License-Identifier: GPL-2.0-or-later
FROM python:3.13-slim
WORKDIR /harness
RUN pip install --no-cache-dir "websockets==15.0.1" "cryptography==46.0.3"
COPY origin.py client.py summary.py /harness/
ENTRYPOINT ["python3"]
