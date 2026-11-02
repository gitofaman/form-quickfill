"""Check the whole setup and say what's missing, in order.

    python3 scripts/doctor.py          # config, Notion, agy login, bridge
    python3 scripts/doctor.py --agy    # also run one real sealed agy turn (~15 s)

Exits 1 if anything failed, so it works as a gate in scripts too.
"""

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "bridge"), str(ROOT / "bridge" / "agy")]
import settings  # noqa: E402 — first: loads .env
import agy_session  # noqa: E402
import notion  # noqa: E402
import schema as F  # noqa: E402

failed = 0


def ok(msg):
    print(f"  ✓ {msg}")


def bad(msg, fix=""):
    global failed
    failed += 1
    print(f"  ✗ {msg}" + (f"\n      → {fix}" if fix else ""))


def check_config():
    print("Config")
    if not settings.ENV_FILE.exists():
        bad(".env is missing", "cp .env.example .env, then fill in NOTION_TOKEN")
    problems = settings.config_problems()
    for p in problems:
        bad(p)
    if not problems:
        p = settings.load_profile()
        f = settings.load_facts()
        ok(f"profile.json: {p['you']['full_name']} <{p['you']['email']}>, "
           f"{len(p.get('gmail_accounts') or [])} Gmail account(s)")
        ok(f"facts.json: {len(f['about'])} facts, {len(f['learned'])} learned")


def check_notion():
    print("Notion")
    if not os.environ.get("NOTION_TOKEN"):
        return bad("NOTION_TOKEN is not set in .env",
                   "make an internal integration at https://www.notion.so/profile/integrations")
    if not os.environ.get("NOTION_DATA_SOURCE"):
        return bad("NOTION_DATA_SOURCE is not set in .env", "python3 scripts/setup_notion.py <page link>")
    try:
        ds = notion.call("GET", f"data_sources/{notion.ds()}")
    except Exception as exc:  # noqa: BLE001
        return bad(f"can't open the Leads database: {exc}",
                   "is the integration added to it? Database ••• → Connections")
    have = {name: prop.get("type") for name, prop in (ds.get("properties") or {}).items()}
    missing = [n for n in F.TYPES if n not in have]
    wrong = [f"{n} is {have[n]}, needs {t}" for n, t in F.TYPES.items() if n in have and have[n] != t]
    if missing or wrong:
        bad("the database's columns don't match bridge/schema.py: "
            + "; ".join(([f"missing {', '.join(missing)}"] if missing else []) + wrong),
            "add/rename those columns in Notion, or change the names in bridge/schema.py")
    else:
        ok(f"database '{''.join(t.get('plain_text', '') for t in ds.get('title') or [])}' has every column")
    try:
        d = notion.call("POST", f"data_sources/{notion.ds()}/query", {"page_size": 100, "filter": {"and": [
            {"property": F.STATUS, "select": {"equals": F.TO_CONTACT}},
            {"property": F.HAND_SKIPPED, "checkbox": {"equals": False}}]}})
        n = f"{len(d['results'])}{'+' if d.get('has_more') else ''}"
        (ok if d["results"] else bad)(f"{n} leads with Status '{F.TO_CONTACT}'",
                                      *([] if d["results"] else ["python3 scripts/import_leads.py data/leads.csv"]))
    except Exception as exc:  # noqa: BLE001
        bad(f"querying the queue failed: {exc}")


def check_agy(run_turn: bool):
    print("agy")
    if not Path(agy_session.AGY_BIN).exists():
        return bad(f"agy not found at {agy_session.AGY_BIN}", "install agy, or set AGY_BIN in .env")
    ok(f"agy at {agy_session.AGY_BIN}")
    problem = agy_session.login_problem()
    if problem:
        return bad(problem)
    ok("agy is signed in")
    if run_turn:
        model = os.environ.get("QF_MODEL", "gemini-3.8-flash-low")
        try:
            answer, _ = agy_session.run('Reply with {"ok": true}.', schema={
                "type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]},
                model=model, timeout=120)
            (ok if answer.get("ok") is True else bad)(f"sealed agy turn on {model} answered {json.dumps(answer)}")
        except agy_session.AgyError as exc:
            bad(f"sealed agy turn on {model} failed: {exc}",
                "is QF_MODEL a model your agy accepts? See bridge/agy/logs/last-failure.log")


def check_bridge():
    print("Bridge")
    port = os.environ.get("QF_PORT", "8131")
    try:
        h = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5))
    except Exception:  # noqa: BLE001
        return bad(f"not answering on http://127.0.0.1:{port}",
                   "Mac: bash scripts/install_mac.sh. Elsewhere: python3 bridge/bridge.py")
    if h.get("ok"):
        ok(f"running, {h.get('queue')} leads queued, model {h.get('model')}")
    else:
        bad("running but unhappy: " + "; ".join(h.get("problems") or []),
            "restart it after fixing (Mac: bash scripts/install_mac.sh)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--agy", action="store_true", help="also run one real agy turn")
    args = ap.parse_args()
    check_config()
    check_notion()
    check_agy(args.agy)
    check_bridge()
    print("\nAll good." if not failed else f"\n{failed} problem(s) above.")
    sys.exit(1 if failed else 0)
