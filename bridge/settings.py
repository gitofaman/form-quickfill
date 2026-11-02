"""Paths, .env and the two config files, shared by the bridge and the scripts.

Importing this loads .env into os.environ (without overriding anything already set),
so import it before agy_session, which reads AGY_BIN / AGY_MODEL when it loads.
"""

import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config"
DATA = ROOT / "data"            # sent-log.tsv, pending-sent.json, bridge.log (all gitignored)
PROFILE = CONFIG / "profile.json"
FACTS = CONFIG / "facts.json"
ENV_FILE = ROOT / ".env"

# Left in a config file, any of these means it was copied from the example and never filled in.
PLACEHOLDER = re.compile(r"YOUR-[A-Z]|Your Name|you@example\.com|your-site\.com")


def _load_env() -> None:
    if not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            if value.strip():
                os.environ.setdefault(key.strip(), value.strip().strip("'\""))


def set_env(key: str, value: str) -> None:
    """Write key=value into .env, replacing the line if it's there."""
    lines = ENV_FILE.read_text().splitlines() if ENV_FILE.exists() else []
    out, found = [], False
    for line in lines:
        if line.split("=", 1)[0].strip() == key:
            out.append(f"{key}={value}")
            found = True
        else:
            out.append(line)
    if not found:
        out.append(f"{key}={value}")
    ENV_FILE.write_text("\n".join(out) + "\n")
    os.environ[key] = value


def _read(path: Path) -> dict:
    if not path.exists():
        raise RuntimeError(f"config/{path.name} is missing: copy config/{path.stem}.example.json "
                           f"to config/{path.name} and fill it in")
    try:
        return json.loads(path.read_text())
    except ValueError as exc:
        raise RuntimeError(f"config/{path.name} is not valid JSON: {exc}") from exc


def load_profile() -> dict:
    return _read(PROFILE)


def load_facts() -> dict:
    f = _read(FACTS)
    for key in ("about", "never", "learned"):
        f.setdefault(key, [])
    return f


def save_facts(f: dict) -> None:
    FACTS.write_text(json.dumps(f, indent=1, ensure_ascii=False))


def config_problems() -> list:
    """What's wrong with profile.json / facts.json, in plain words. Empty when fine."""
    problems = []
    for path, load in ((PROFILE, load_profile), (FACTS, load_facts)):
        try:
            load()
        except RuntimeError as exc:
            problems.append(str(exc))
            continue
        hits = sorted(set(m.group(0) for m in PLACEHOLDER.finditer(path.read_text())))
        if hits:
            problems.append(f"config/{path.name} still has example values ({', '.join(hits)})")
    if not problems:
        p = load_profile()
        missing = [k for k in ("pitch", "subject", "message") if not p.get(k)]
        missing += [f"you.{k}" for k in ("full_name", "first_name", "email") if not (p.get("you") or {}).get(k)]
        if missing:
            problems.append(f"config/profile.json is missing {', '.join(missing)}")
    return problems


_load_env()
DATA.mkdir(exist_ok=True)
