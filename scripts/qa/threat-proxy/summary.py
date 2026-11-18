#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Summarize per-run sampler and client evidence."""
import argparse
import csv
import json
import os
import statistics


class RunSummary:
    def __init__(self, samples, inspect, client, scenario):
        self.samples, self.inspect, self.client, self.scenario = samples, inspect, client, scenario

    @staticmethod
    def mib(value):
        try: return round(int(value) / (1024 * 1024), 2)
        except (TypeError, ValueError): return None

    def build(self):
        rows = list(csv.DictReader(open(self.samples)))
        currents = [self.mib(r.get("memory_current")) for r in rows]
        currents = [n for n in currents if n is not None]
        peaks = [self.mib(r.get("memory_peak")) for r in rows]
        peaks = [n for n in peaks if n is not None]
        load_currents = [self.mib(r.get("memory_current")) for r in rows if r.get("phase") == "load"]
        load_currents = [n for n in load_currents if n is not None]
        steady = statistics.median(load_currents[max(0, int(len(load_currents)*.75)):]) if load_currents else None
        settled_rows = [self.mib(r.get("memory_current")) for r in rows if r.get("phase") == "settled"]
        settled_rows = [n for n in settled_rows if n is not None]
        settled = statistics.median(settled_rows) if settled_rows else None
        try:
            info = json.load(open(self.inspect))[0]
            state = info.get("State", {})
            oom, alive = bool(state.get("OOMKilled")), bool(state.get("Running"))
            restarts, exit_code = info.get("RestartCount"), state.get("ExitCode")
        except (OSError, ValueError, IndexError): oom, alive, restarts, exit_code = None, False, None, None
        try: client = json.load(open(self.client))
        except (OSError, ValueError): client = {"errors": None, "security": {}}
        result = {"scenario":self.scenario,"samples":len(rows),"peak_mib":max(peaks) if peaks else (max(currents) if currents else None),
                  "steady_state_mib":steady,"settled_state_mib":settled,"oom_killed":oom,"proxy_alive_after":alive,"restart_count":restarts,
                  "exit_code":exit_code,"client_errors":client.get("errors"),"security_checks":client.get("security", {})}
        return result

    def write(self, out):
        result = self.build()
        with open(out, "w") as f: json.dump(result, f, indent=2)
        checks = result["security_checks"]
        check_text = ", ".join(f"{k}: {'PASS' if v else 'FAIL'}" for k,v in checks.items()) or "n/a"
        md = ("| Scenario | Peak MiB | Steady-state MiB* | OOMKilled | Proxy alive after | Client errors | Security checks |\n"
              "|---|---:|---:|:---:|:---:|---:|---|\n"
              f"| {self.scenario} | {result['peak_mib']} | {result['steady_state_mib']} | {result['oom_killed']} | {result['proxy_alive_after']} | {result['client_errors']} | {check_text} |\n\n"
              "* Median of the last 25% of sampler readings. Memory figures are cgroup bytes converted to MiB; blank when unavailable.\n")
        with open(os.path.join(os.path.dirname(out), "summary.md"), "w") as f: f.write(md)
        print(md, end="")


if __name__ == "__main__":
    p=argparse.ArgumentParser(); p.add_argument("--samples",required=True); p.add_argument("--inspect",required=True); p.add_argument("--client",required=True); p.add_argument("--scenario",required=True); p.add_argument("--output",required=True)
    a=p.parse_args(); RunSummary(a.samples,a.inspect,a.client,a.scenario).write(a.output)
