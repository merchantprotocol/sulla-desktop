import re

# Tool names that act outside the machine or destroy data. Matched on whole name segments.
BLOCKED = re.compile(r"(^|[/_.-])(send|post|publish|pay|charge|delete|remove|unpublish|create_release)($|[/_.-])", re.I)
# Read-only or local tools that share a word with the list above.
ALLOWED = {"chat/message_tab", "agents/send_job_message", "browser/tab"}


def handler(inputs: dict) -> dict:
    if inputs.get("hook") != "before_tool_call":
        return {}
    tool = str((inputs.get("payload") or {}).get("toolName", ""))
    if tool in ALLOWED or not BLOCKED.search(tool):
        return {}
    return {"denied": True, "reason": f"{tool} sends, posts, pays or deletes. Approve it by hand first."}
