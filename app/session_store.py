"""
In-memory session store shared between the auth router and the database module.

Kept in its own module (instead of inside routers/auth.py) so that `database.py`
can read the currently selected business database for a request without
creating a circular import between `database.py` and `routers/auth.py`.
"""

import secrets
from datetime import datetime, timedelta
from typing import Dict, Optional

COOKIE_NAME = "airsched_session"

# token -> {user_id, username, role, db_filename, expiry}
_sessions: Dict[str, dict] = {}


def clean_sessions() -> None:
    now = datetime.utcnow()
    expired = [k for k, v in _sessions.items() if v["expiry"] < now]
    for k in expired:
        del _sessions[k]


def create_session(user_id: int, username: str, role: str, db_filename: str, ttl_hours: int) -> str:
    clean_sessions()
    token = secrets.token_urlsafe(32)
    _sessions[token] = {
        "user_id": user_id,
        "username": username,
        "role": role,
        "db_filename": db_filename,
        "expiry": datetime.utcnow() + timedelta(hours=ttl_hours),
    }
    return token


def get_session_by_token(request) -> Optional[dict]:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return None
    sess = _sessions.get(token)
    if not sess or sess["expiry"] < datetime.utcnow():
        _sessions.pop(token, None)
        return None
    return sess


def get_token(request) -> Optional[str]:
    return request.cookies.get(COOKIE_NAME)


def remove_session_token(token: Optional[str]) -> None:
    if token:
        _sessions.pop(token, None)


def remove_sessions_for_user(user_id: int) -> None:
    to_remove = [k for k, v in _sessions.items() if v.get("user_id") == user_id]
    for k in to_remove:
        del _sessions[k]


def set_session_database(request, db_filename: str) -> bool:
    """Update the active database filename for the caller's session. Returns True if updated."""
    token = request.cookies.get(COOKIE_NAME)
    if not token or token not in _sessions:
        return False
    _sessions[token]["db_filename"] = db_filename
    return True


def rename_database_in_sessions(old_filename: str, new_filename: str) -> None:
    for sess in _sessions.values():
        if sess.get("db_filename") == old_filename:
            sess["db_filename"] = new_filename


def reset_database_in_sessions(filename: str, fallback: str) -> None:
    """Called when a database is deleted; move any sessions pointing at it to fallback."""
    for sess in _sessions.values():
        if sess.get("db_filename") == filename:
            sess["db_filename"] = fallback
