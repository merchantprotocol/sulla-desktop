---
slug: sulla-inventory-network
label: Inventory reachable network devices safely
trigger_when: When the human wants to discover devices on the local network or check an old server without assuming the VM can reach the host LAN.
trigger_actions: [scan local network, list devices, check old server, inspect network reachability]
trigger_phrases: [what devices are on my network, scan my network, help me get into this old server, find devices on Wi-Fi, check a server]
scope: [sulla-vm, tool-docker]
---

**When:** Establish network scope before scanning and never turn discovery into unauthorized access.

**Do:**
1. Check the VM interfaces and routes read-only: `sulla meta/exec '{"command":"ip -brief addr; printf \"\nROUTES\n\"; ip route"}'`.
2. Scan only the CIDR and devices the human identifies as theirs. Prefer a disposable scanner container via `sulla docker/run '{"image":"<scanner-image>","name":"network-inventory","command":"<approved scan command>","options":"<approved network options>"}'`; verify its output with `sulla docker/logs '{"container":"network-inventory","tail":200}'`.
3. If no scanner image is available, state that the catalog has no dedicated network-inventory tool and ask the human to connect/use an approved scanner; do not invent host-LAN visibility.
4. For an old server, identify its address and service from the scan, then use only an explicitly authorized, non-destructive check. Do not guess passwords or bypass access controls.
5. Stop the named temporary scanner after collecting results: `sulla docker/stop '{"container":"network-inventory"}'`; removal waits for approval because it deletes container data.

**Check:** Report the scan range, timestamp, reachable addresses, and uncertainty caused by VM isolation. A discovered device is not proof of ownership or authorization.

**Cleanup:** Stop temporary scanners and preserve only the requested inventory. Do not delete data or alter discovered devices.

**Traps:** The VM may have private networking and may not see the Mac's LAN. Smart-TV control is not a shipped capability; use `sulla-know-what-you-cannot-do` and offer the vendor's approved app/integration.
