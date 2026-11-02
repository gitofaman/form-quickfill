"""Create the Leads database in Notion and save its id to .env.

    python3 scripts/setup_notion.py <Notion page link> [--title "Shopify Leads"]
    python3 scripts/setup_notion.py --existing <Notion database link>

Before running:
  1. Make an internal integration at https://www.notion.so/profile/integrations and put
     its secret in .env as NOTION_TOKEN=...
  2. Open the Notion page the database should live under, click ••• (top right) ->
     Connections, and add the integration. (For --existing, do that on the database.)

The new database has the columns in bridge/schema.py. --existing adopts a database you
already have; run scripts/doctor.py afterwards to see which columns it's missing.
"""

import argparse
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "bridge")]
import settings  # noqa: E402
import notion  # noqa: E402
import schema as F  # noqa: E402


def notion_id(link: str) -> str:
    """The 32-hex id in a Notion link (taken from the path, not from ?v=... view ids), or a bare id."""
    path = urlparse(link).path if "/" in link else link
    ids = re.findall(r"[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", path.lower())
    if not ids:
        sys.exit(f"No Notion id in {link!r}. Copy the page link from Notion (Share -> Copy link).")
    return ids[-1].replace("-", "")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("page", nargs="?", help="link to the page the new database goes under")
    ap.add_argument("--title", default="Leads")
    ap.add_argument("--existing", metavar="DATABASE", help="use this database instead of creating one")
    ap.add_argument("--force", action="store_true", help="replace NOTION_DATA_SOURCE even if .env has one")
    args = ap.parse_args()
    if not (args.page or args.existing):
        ap.error("give a page link, or --existing <database link>")

    if os.environ.get("NOTION_DATA_SOURCE") and not args.force:
        sys.exit(f".env already has NOTION_DATA_SOURCE={os.environ['NOTION_DATA_SOURCE']}. "
                 f"Add --force to replace it.")

    if args.existing:
        db = notion.call("GET", f"databases/{notion_id(args.existing)}")
        verb = "Using"
    else:
        db = notion.call("POST", "databases", {
            "parent": {"type": "page_id", "page_id": notion_id(args.page)},
            "title": [{"type": "text", "text": {"content": args.title}}],
            "initial_data_source": {"properties": F.properties()},
        })
        verb = "Created"
    sources = db.get("data_sources") or []
    if not sources:
        sys.exit("Notion returned a database without a data source; check the link.")
    settings.set_env("NOTION_DATA_SOURCE", sources[0]["id"])
    title = "".join(t.get("plain_text", "") for t in db.get("title") or []) or args.title
    print(f"{verb} '{title}': {db.get('url', '')}")
    print(f"Saved NOTION_DATA_SOURCE={sources[0]['id']} to .env")
    if len(sources) > 1:
        print(f"Note: that database has {len(sources)} data sources; using the first ({sources[0].get('name')}).")


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as exc:
        sys.exit(str(exc))
