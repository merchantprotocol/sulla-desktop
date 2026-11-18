# SPDX-License-Identifier: GPL-2.0-or-later
"""A capability rejection retries with the atomically refreshed token file."""
import json
import os
import tempfile
import unittest
from unittest.mock import patch

from test_directory_paging import load_adapter


class Response:
    def __init__(self, status, payload):
        self.status = status
        self.payload = payload
        self.headers = {}

    def read(self, _limit):
        return self.payload

    def release_conn(self):
        pass


class Http:
    def __init__(self):
        self.authorization = []
        self.responses = [Response(401, json.dumps({"error": "Capability expired"}).encode()), Response(200, b"ok")]

    def request(self, _method, _url, headers, **_kwargs):
        self.authorization.append(headers["Authorization"])
        return self.responses.pop(0)


class CapabilityRefreshTests(unittest.TestCase):
    # risk: mount availability — a refreshed signed credential must recover requests after Files rejects stale expiry.
    def test_401_retry_rereads_token_file_and_recovers(self):
        adapter, _ = load_adapter()
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "token")
            with open(path, "w") as token_file:
                token_file.write("old-capability")
            api = adapter.FilesApi("http://files", path)
            api.http = Http()

            def refresh_token(_delay):
                with open(path, "w") as token_file:
                    token_file.write("new-capability")

            with patch.object(adapter.time, "sleep", side_effect=refresh_token):
                status, _, body = api._request("/v1/fuse/directory")

            self.assertEqual((status, body), (200, b"ok"))
            self.assertEqual(api.http.authorization, ["Bearer old-capability", "Bearer new-capability"])


if __name__ == "__main__":
    unittest.main()
