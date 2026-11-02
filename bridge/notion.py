"""Tiny Notion API client (stdlib only). Token and data source id come from .env."""

import json
import os
import time
import urllib.error
import urllib.request

import settings  # noqa: F401 — loads .env

VERSION = "2025-09-03"


def ds() -> str:
    """The Leads data source id, or a clear error saying how to get one."""
    value = os.environ.get("NOTION_DATA_SOURCE", "")
    if not value:
        raise RuntimeError("NOTION_DATA_SOURCE is not set in .env: run scripts/setup_notion.py")
    return value


def call(method: str, path: str, body=None):
    token = os.environ.get("NOTION_TOKEN", "")
    if not token:
        raise RuntimeError("NOTION_TOKEN is not set in .env (see README, Notion step)")
    req = urllib.request.Request(f"https://api.notion.com/v1/{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {token}", "Notion-Version": VERSION,
                                          "Content-Type": "application/json"})
    for attempt in range(6):
        try:
            return json.load(urllib.request.urlopen(req, timeout=60))
        except urllib.error.HTTPError as exc:
            if exc.code in (429, 502, 503, 504) and attempt < 5:
                time.sleep(float(exc.headers.get("Retry-After") or 2 * (attempt + 1)))
                continue
            raise RuntimeError(f"Notion {exc.code}: {exc.read().decode()[:300]}") from exc
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            # Wi-Fi blips (DNS "nodename nor servname") clear in seconds
            if attempt >= 2:
                raise
            time.sleep(2 * (attempt + 1))


def query_all(body: dict) -> list:
    """Every page of a data source query, following the cursor."""
    rows, cur = [], None
    while True:
        d = call("POST", f"data_sources/{ds()}/query",
                 {**body, "page_size": 100, **({"start_cursor": cur} if cur else {})})
        rows += d["results"]
        if not d.get("has_more"):
            return rows
        cur = d["next_cursor"]


def text(prop) -> str:
    if not prop:
        return ""
    kind = prop.get("type")
    if kind in ("rich_text", "title"):
        return "".join(x["plain_text"] for x in prop[kind])
    if kind in ("url", "email"):
        return prop[kind] or ""
    if kind == "select":
        return (prop["select"] or {}).get("name", "")
    return ""


def rich(s: str):
    return {"rich_text": [{"text": {"content": s[i:i + 1900]}} for i in range(0, len(s), 1900)] if s else []}
