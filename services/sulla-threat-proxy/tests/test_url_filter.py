# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.

"""URL filter verdict logic. Run with SULLA_PROXY_NO_AUTOLOAD=1 and the addons on PYTHONPATH."""

import json
import os
import tempfile
import time
import unittest

STATE = tempfile.mkdtemp(prefix="sulla-threat-proxy-test-")
os.environ["SULLA_PROXY_STATE_DIR"] = STATE
os.environ["SULLA_PROXY_NO_AUTOLOAD"] = "1"
for sub in ("config", "cache", "blocklist"):
    os.makedirs(os.path.join(STATE, sub), exist_ok=True)

from mitmproxy.test import tflow  # noqa: E402

import common  # noqa: E402
import url_filter  # noqa: E402

CONFIG = os.path.join(STATE, "config", "proxy.json")
BLOCKLIST = os.path.join(STATE, "blocklist", "urlhaus.txt")


def write_config(**values):
    tmp = CONFIG + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(values, fh)
    os.replace(tmp, CONFIG)
    # Force a distinct mtime even on coarse filesystems.
    stamp = time.time() + write_config.bump
    write_config.bump += 1
    os.utime(CONFIG, (stamp, stamp))


write_config.bump = 1


def flow(host, path="/", header_host=None, dst_ip="93.184.215.14", scheme="https"):
    f = tflow.tflow()
    f.request.scheme = scheme
    f.request.host = host
    f.request.port = 443 if scheme == "https" else 80
    f.request.path = path
    f.request.headers["Host"] = header_host or host
    f.server_conn.address = (dst_ip, f.request.port)
    f.server_conn.sni = None
    f.client_conn.sni = None
    return f


class URLFilterTest(unittest.TestCase):
    def setUp(self):
        with open(BLOCKLIST, "w", encoding="utf-8") as fh:
            fh.write("# URLhaus hostfile\n127.0.0.1\tbad.example\n0.0.0.0 evil-parent.test\n203.0.113.66\n")
        write_config(blockMode="block", allowlist="", safeBrowsingApiKey="", virusTotalApiKey="")
        self.cache = common.VerdictCache(path=os.path.join(STATE, "cache", f"{self.id()}.sqlite"))
        self.filter = url_filter.URLFilter(config=common.ProxyConfig(check_secs=0), cache=self.cache)

    def test_blocklisted_host_gets_451(self):
        f = flow("bad.example", "/payload.exe")
        self.filter.request(f)
        self.assertIsNotNone(f.response)
        self.assertEqual(f.response.status_code, 451)
        body = json.loads(f.response.get_text())
        self.assertEqual(body["blocked_by"], "sulla-threat-proxy")
        self.assertIn("urlhaus:exact", body["detectors"])

    def test_subdomain_of_blocklisted_parent_is_blocked(self):
        f = flow("cdn.evil-parent.test")
        self.filter.request(f)
        self.assertEqual(f.response.status_code, 451)
        self.assertIn("urlhaus:parent:evil-parent.test", f.response.headers["X-Sulla-Threat"])

    def test_clean_host_passes_without_api_keys(self):
        f = flow("example.org")
        self.filter.request(f)
        self.assertIsNone(f.response)

    def test_spoofed_internal_host_header_does_not_bypass(self):
        # A public destination listed by IP, sent with Host: localhost.
        f = flow("localhost", header_host="localhost", dst_ip="203.0.113.66", scheme="http")
        self.filter.request(f)
        self.assertIsNotNone(f.response)
        self.assertEqual(f.response.status_code, 451)

    def test_sni_mismatch_is_checked(self):
        f = flow("example.org")
        f.client_conn.sni = "bad.example"
        self.filter.request(f)
        self.assertEqual(f.response.status_code, 451)

    def test_user_allowlist_bypasses_when_every_name_matches(self):
        write_config(blockMode="block", allowlist="bad.example")
        f = flow("bad.example", dst_ip="bad.example")
        self.filter.request(f)
        self.assertIsNone(f.response)

    def test_warn_mode_tags_instead_of_blocking(self):
        write_config(blockMode="warn")
        f = flow("bad.example")
        self.filter.request(f)
        self.assertIsNone(f.response)
        self.assertIn("urlhaus:exact", f.request.headers["X-Sulla-Threat"])

    def test_config_change_is_picked_up_without_restart(self):
        f = flow("bad.example")
        self.filter.request(f)
        self.assertEqual(f.response.status_code, 451)
        write_config(blockMode="off")
        g = flow("bad.example")
        self.filter.request(g)
        self.assertIsNone(g.response)

    def test_unknown_block_mode_falls_back_to_block(self):
        write_config(blockMode="bogus")
        f = flow("bad.example")
        self.filter.request(f)
        self.assertEqual(f.response.status_code, 451)


class ProxyConfigTest(unittest.TestCase):
    def test_invalid_file_keeps_previous_values(self):
        write_config(blockMode="warn", allowlist="a.test,b.test")
        config = common.ProxyConfig(check_secs=0)
        self.assertEqual(config.get("blockMode"), "warn")
        with open(CONFIG, "w", encoding="utf-8") as fh:
            fh.write("{not json")
        stamp = time.time() + 100
        os.utime(CONFIG, (stamp, stamp))
        self.assertFalse(config.refresh())
        self.assertEqual(config.get("blockMode"), "warn")
        self.assertEqual(common.split_list(config.get("allowlist")), ["a.test", "b.test"])

    def test_allowlist_private_ranges(self):
        self.assertTrue(common.is_allowlisted("10.1.2.3"))
        self.assertTrue(common.is_allowlisted("172.20.0.1"))
        self.assertFalse(common.is_allowlisted("172.32.0.1"))
        self.assertTrue(common.is_allowlisted("api.example.com", ["example.com"]))
        self.assertFalse(common.is_allowlisted("example.com.evil.test", ["example.com"]))


if __name__ == "__main__":
    unittest.main()
