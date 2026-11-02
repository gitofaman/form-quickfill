"""Add leads from a CSV to the Notion Leads database, skipping sites it already has.

    python3 scripts/import_leads.py data/leads.csv [--dry-run]

CSV columns (header names in any case, spaces or underscores; only agency + website needed):

    agency, website, form_link, email, short_name, priority, form_type, country, directory_link

form_link is the contact page (the panel opens it; website when empty), form_type is
Contact or Careers, priority is a number (higher goes first). New rows get Status
"To contact". A row whose website or form link host is already in the database is skipped,
so the same CSV can be imported twice safely.
"""

import argparse
import csv
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "bridge")]
import notion  # noqa: E402
import schema as F  # noqa: E402


def url(u: str) -> str:
    u = (u or "").strip()
    return u if not u or re.match(r"https?://", u) else "https://" + u


def host(u: str) -> str:
    return urlparse(url(u)).netloc.lower().removeprefix("www.")


def props(r: dict) -> dict:
    p = {F.AGENCY: {"title": [{"text": {"content": r["agency"][:200]}}]},
         F.STATUS: {"select": {"name": F.TO_CONTACT}}}
    for col, name in (("website", F.WEBSITE), ("form_link", F.FORM_LINK), ("directory_link", F.DIRECTORY_LINK)):
        if r.get(col):
            p[name] = {"url": url(r[col])}
    if r.get("email"):
        p[F.CONTACT_EMAIL] = {"email": r["email"].strip()}
    for col, name in (("short_name", F.SHORT_NAME), ("country", F.COUNTRY)):
        if r.get(col):
            p[name] = notion.rich(r[col].strip())
    if (r.get("form_type") or "").strip().title() in ("Contact", "Careers"):
        p[F.FORM_TYPE] = {"select": {"name": r["form_type"].strip().title()}}
    try:
        p[F.PRIORITY] = {"number": float(r["priority"])}
    except (KeyError, TypeError, ValueError):
        pass
    return p


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv")
    ap.add_argument("--dry-run", action="store_true", help="say what would be added, add nothing")
    args = ap.parse_args()

    with open(args.csv, newline="", encoding="utf-8-sig") as f:
        rows = [{re.sub(r"[\s-]+", "_", (k or "").strip().lower()): (v or "").strip() for k, v in r.items()}
                for r in csv.DictReader(f)]
    if rows and "agency" not in rows[0]:
        sys.exit(f"The CSV needs an 'agency' column; it has: {', '.join(rows[0])}")

    have = set()
    for page in notion.query_all({}):
        pr = page["properties"]
        have |= {host(notion.text(pr.get(F.WEBSITE))), host(notion.text(pr.get(F.FORM_LINK)))}
    have.discard("")
    print(f"{len(rows)} rows in the CSV; the database already has {len(have)} sites")

    added = skipped = 0
    for r in rows:
        hosts = {host(r.get("website")), host(r.get("form_link"))} - {""}
        if not r.get("agency") or not hosts:
            print(f"  skip (no agency or site): {r}")
            skipped += 1
            continue
        if hosts & have:
            skipped += 1
            continue
        if not args.dry_run:
            notion.call("POST", "pages", {"parent": {"type": "data_source_id", "data_source_id": notion.ds()},
                                          "properties": props(r)})
            time.sleep(0.34)  # Notion allows ~3 requests a second
        have |= hosts
        added += 1
        print(f"  {'would add' if args.dry_run else 'added'}: {r['agency']}")
    print(f"{'Would add' if args.dry_run else 'Added'} {added}, skipped {skipped} (already there or incomplete)")


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as exc:
        sys.exit(str(exc))
