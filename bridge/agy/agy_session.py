"""One sealed headless Antigravity (`agy`) turn: text in, JSON out.

`agy` has no --safe-mode / --disallowed-tools / --system-prompt /
--no-session-persistence, so those guarantees are rebuilt by hand:

  sealing      Every run happens inside the `sealed/` workspace next to this file.
               Its `.agents/hooks.json` runs a PreToolUse gate (gate.py) that refuses
               every tool except `finish`, which is how agy hands back --json-schema
               output. Headless agy already auto-denies shell and most file reads, but
               it does NOT deny reads under /tmp or web search on its own, so the gate
               is what makes it safe to feed it text from strangers' websites.
  system text  Prepended to the prompt. There is only one channel.
  no history   agy keeps every conversation (~425 KB each) under
               ~/.gemini/antigravity-cli. After each run this deletes that one
               conversation's files and summary row, so page text doesn't pile up on
               disk and your interactive conversation list stays yours.

The prompt goes on stdin: `-p <text>` puts it in argv, which caps out at 128 KB
and shows up in `ps`.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional, Tuple

HERE = Path(__file__).resolve().parent
AGY_BIN = os.environ.get("AGY_BIN") or shutil.which("agy") or str(Path.home() / ".local/bin/agy")
DEFAULT_MODEL = os.environ.get("AGY_MODEL", "gemini-3.8-flash-high")
STATE_DIR = Path.home() / ".gemini" / "antigravity-cli"
TOKEN_FILE = STATE_DIR / "antigravity-oauth-token"
FAILURE_LOG = HERE / "logs" / "last-failure.log"

WORKSPACES = {"none": HERE / "sealed"}


class AgyError(RuntimeError):
    """agy could not be run, timed out, or did not return a usable answer."""


def login_problem() -> Optional[str]:
    """Why agy can't run here, or None.

    Google's refresh token has no fixed expiry date, unlike Claude's, so there is
    no countdown to read — only whether a login exists at all. A revoked login
    still looks present here; that one shows up as a failed run instead.
    """
    host = socket.gethostname()
    try:
        blob = json.loads(TOKEN_FILE.read_text())
    except FileNotFoundError:
        return f"agy is signed out on {host}. Run `agy` once in a terminal and sign in."
    except (OSError, ValueError) as exc:
        return f"agy's login file on {host} is unreadable: {exc}"
    if not (blob.get("token") or {}).get("refresh_token"):
        return f"agy's login on {host} holds no refresh token. Run `agy` in a terminal and sign in again."
    return None


def run(
    prompt: str,
    *,
    system: Optional[str] = None,
    schema: Optional[dict] = None,
    model: Optional[str] = None,
    tools: str = "none",
    timeout: int = 600,
) -> Tuple[object, dict]:
    """Run one headless turn. Returns (answer, envelope).

    With a schema the answer is the parsed object; without one it is the reply
    text. Raises AgyError for every failure mode, so a caller that wants a run to
    survive a bad session catches that one exception.
    """
    if tools not in WORKSPACES:
        raise ValueError(f"tools must be one of {sorted(WORKSPACES)}, not {tools!r}")
    # Gemini in agy is an agent first: told nothing, it reaches for the shell to check
    # the date or open a link, gets refused by the gate, and sometimes never recovers.
    text = TOOL_NOTE[tools] + "\n\n" + (f"{system.strip()}\n\n---\n\n{prompt}" if system else prompt)

    deadline = time.monotonic() + timeout
    try:
        return _attempt(text, schema, model, tools, timeout)
    except AgyStall as first:
        left = int(deadline - time.monotonic())
        if left < 60:
            raise AgyError(str(first)) from first
        try:
            return _attempt(text, schema, model, tools, left)
        except AgyStall as second:
            raise AgyError(f"{second} (twice)") from second


TOOL_NOTE = {
    "none": "This session has no tools apart from the one that returns your answer. "
            "Do not run commands, read files, open links or search the web: answer from "
            "the text below alone.",
}


class AgyStall(AgyError):
    """agy went quiet mid-run — a hung model stream, not a slow one."""


def _attempt(text: str, schema, model, tools: str, timeout: int) -> Tuple[object, dict]:
    log_file = Path(tempfile.mkstemp(prefix="agy-run-", suffix=".log")[1])
    argv = [AGY_BIN, "--output-format", "json", "--model", model or DEFAULT_MODEL,
            "--log-file", str(log_file)]
    if schema is not None:
        argv += ["--json-schema", json.dumps(_gemini_schema(schema))]

    envelope: dict = {}
    ok = False
    try:
        stdout, stderr, code = _spawn(argv, text, timeout, WORKSPACES[tools], log_file)
        try:
            envelope = json.loads(stdout)
        except ValueError:
            raise AgyError(f"agy exited {code} without a JSON envelope: "
                           f"{(stderr or stdout).strip()[-600:] or 'no output'}")

        if envelope.get("status") != "SUCCESS":
            raise AgyError(str(envelope.get("error") or stderr.strip()
                               or f"agy reported {envelope.get('status')}")[:600])
        answer = _answer(envelope, schema)
        ok = True
        return answer, envelope
    finally:
        _forget(envelope.get("conversation_id"))
        _sweep_stale()
        _keep_or_drop_log(log_file, ok)


# agy logs every model call, and most land every 5-15 s, but a thinking turn on
# gemini-3.8-flash-high can sit silent for four minutes and still finish (measured
# 2026-10-28: 238 s with no log line, done at 423 s with a correct answer). So
# silence means a hang only once it outlasts that; a shorter cutoff kills good runs.
STALL_S = int(os.environ.get("AGY_STALL_SECONDS", "360"))


def _spawn(argv, text: str, timeout: int, cwd: Path, log_file: Path) -> Tuple[str, str, int]:
    """Run agy in its own process group, so a timeout takes its children too."""
    env = dict(os.environ)
    env.setdefault("HOME", str(Path.home()))
    try:
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, cwd=str(cwd), env=env,
                                start_new_session=True)
    except FileNotFoundError as exc:
        raise AgyError(f"agy not found at {AGY_BIN}") from exc

    deadline = time.monotonic() + timeout
    pending = text
    try:
        while True:
            try:
                out, err = proc.communicate(pending, timeout=10)
                return out, err, proc.returncode
            except subprocess.TimeoutExpired:
                pending = None                # sent once; retrying loses no output
            quiet = time.time() - _mtime(log_file)
            if quiet > STALL_S:
                raise AgyStall(f"agy stalled: nothing happened for {int(quiet)}s")
            if time.monotonic() > deadline:
                raise AgyError(f"agy timed out after {timeout}s")
    except BaseException:
        # Whatever went wrong here — a stall, the deadline, a crash in this loop, a
        # SIGTERM to the bridge — agy must not outlive it as an orphan.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.communicate()
        raise


def _mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return time.time()


def _gemini_schema(node):
    """The schema with every enum that lists null taken out.

    Gemini rejects null inside an enum (`enum[10]: cannot be empty`, 400), and with
    the null merely dropped it silently omits the items that needed it. Without the
    enum the type list (["string", "null"]) still lets null through, the allowed
    values are in the prompt, and every caller validates what comes back. Enums
    without a null are left exactly as strict as they were.
    """
    if isinstance(node, list):
        return [_gemini_schema(n) for n in node]
    if not isinstance(node, dict):
        return node
    return {k: _gemini_schema(v) for k, v in node.items()
            if not (k == "enum" and isinstance(v, list) and None in v)}


_FENCE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.S)


def _answer(envelope: dict, schema: Optional[dict]):
    reply = envelope.get("response") or ""
    denied = [d.get("action") for d in envelope.get("denied_actions") or []]
    if schema is None:
        if not reply.strip():
            raise AgyError("agy returned an empty reply"
                           + (f" (refused: {', '.join(denied)})" if denied else ""))
        return reply

    answer = envelope.get("structured_output")
    if isinstance(answer, dict):
        return answer
    # No structured_output means the model never called `finish`. Its reply often
    # still carries the object; take it rather than failing a whole batch.
    for candidate in [m.group(1) for m in _FENCE.finditer(reply)] + [reply.strip()]:
        try:
            parsed = json.loads(candidate)
        except ValueError:
            continue
        if isinstance(parsed, dict):
            return parsed
    raise AgyError("agy's answer was not a JSON object: " + (reply[:300] or "empty reply")
                   + (f" (refused: {', '.join(denied)})" if denied else ""))


def _forget(conversation_id: Optional[str]) -> None:
    """Delete one conversation's traces. Best effort: never fails a run."""
    if not conversation_id or not re.fullmatch(r"[0-9a-f-]{36}", conversation_id):
        return
    for path in (STATE_DIR / "conversations" / f"{conversation_id}.db",
                 STATE_DIR / "conversations" / f"{conversation_id}.db-wal",
                 STATE_DIR / "conversations" / f"{conversation_id}.db-shm",
                 STATE_DIR / "annotations" / f"{conversation_id}.pbtxt",
                 STATE_DIR / "presence" / f"{conversation_id}.lock"):
        try:
            path.unlink()
        except OSError:
            pass
    shutil.rmtree(STATE_DIR / "brain" / conversation_id, ignore_errors=True)
    try:
        with sqlite3.connect(STATE_DIR / "conversation_summaries.db", timeout=5) as db:
            db.execute("DELETE FROM conversation_summaries WHERE conversation_id = ?",
                       (conversation_id,))
    except sqlite3.Error:
        pass


def _sweep_stale(hours: int = 2) -> None:
    """Forget leftovers from runs that died before saying their id (a timeout).

    Only conversations in this module's own workspaces, and only old ones: a
    sibling job's run that is still in flight must not lose its files.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
    uris = [json.dumps([w.as_uri()]) for w in WORKSPACES.values()]
    try:
        with sqlite3.connect(STATE_DIR / "conversation_summaries.db", timeout=5) as db:
            stale = [row[0] for row in db.execute(
                f"SELECT conversation_id FROM conversation_summaries "
                f"WHERE workspace_uris IN ({','.join('?' * len(uris))}) "
                f"AND last_modified_time < ?", (*uris, cutoff))]
    except sqlite3.Error:
        return
    for conversation_id in stale:
        _forget(conversation_id)


def _keep_or_drop_log(log_file: Path, ok: bool) -> None:
    """A clean run's log is noise. The last failure's is worth keeping."""
    try:
        if ok:
            log_file.unlink()
        else:
            FAILURE_LOG.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(log_file), FAILURE_LOG)
    except OSError:
        pass
