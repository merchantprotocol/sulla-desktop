# Sulla Agents service

GPL-2.0-or-later Agents service used by Sulla Desktop. It authenticates the local Desktop API token and manages Desktop agent definitions; execution is coordinated through Desktop's local runtime and workflow manager. Worker containers continue to use the separate `SULLA_AGENT_MODE=transport` capability protocol.
