"""PreToolUse gate for the sealed agy workspace.

    python3 -I ../../gate.py finish search_web:4 read_url_content:2

Allows only the tools named, each optionally capped at N calls per conversation,
and refuses everything else. agy runs it from the workspace's .agents/ directory
with the tool call as JSON on stdin and reads the decision from stdout.

sealed/.agents/hooks.json allows only `finish`. The caps are there for a workspace
that allows web search: Gemini will keep searching for things it already knows,
so once a cap is spent the refusal tells the model to answer with what it has.

Fails closed: anything unreadable is refused. Every decision is appended to
logs/gate.log, so "what did it try?" always has an answer.
"""

import json
import sys
import time
from pathlib import Path

LOG = Path(__file__).resolve().parent / "logs" / "gate.log"


def main() -> None:
    try:
        call = json.load(sys.stdin)
    except ValueError:
        call = {}
    tool = (call.get("toolCall") or {}).get("name") or ""
    args = (call.get("toolCall") or {}).get("args") or {}
    conversation = str(call.get("conversationId") or "")[:36]
    workspace = Path.cwd().parent.name

    caps = {}
    for spec in sys.argv[1:]:
        name, _, cap = spec.partition(":")
        caps[name] = int(cap) if cap.isdigit() else None

    decision, reason = "deny", (f"this is a sealed job session: {tool or 'that tool'} is not "
                                f"available, and neither is any other tool. Return your answer now.")
    if tool in caps:
        used = _count(conversation, tool) if conversation else 0
        if caps[tool] is None or used < caps[tool]:
            decision, reason = "allow", ""
        else:
            reason = (f"{tool} limit reached ({caps[tool]} per run). Do not search again: "
                      f"answer now with what you already know.")

    detail = str(args.get("query") or args.get("Query") or args.get("Url") or args.get("url") or "")
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with LOG.open("a") as f:
            f.write(f"{time.strftime('%F %T')} {workspace} {conversation[:8] or '-'} "
                    f"{tool or '?'} {decision} {detail[:120]!r}\n")
    except OSError:
        pass

    print(json.dumps({"decision": decision, **({"reason": reason} if reason else {})}))


def _count(conversation: str, tool: str) -> int:
    """Calls of `tool` this conversation has already been allowed."""
    try:
        lines = LOG.read_text().splitlines()[-2000:]
    except OSError:
        return 0
    key = f" {conversation[:8]} {tool} allow "
    return sum(1 for line in lines if key in line)


if __name__ == "__main__":
    try:
        main()
    except Exception:                       # noqa: BLE001 — a crashed gate must still say no
        print(json.dumps({"decision": "deny", "reason": "the tool gate failed"}))
