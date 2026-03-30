"""
Auth router – username/password authentication with session cookies.

Users are stored in the SQLite database (users table).
The first admin account is bootstrapped from environment variables:
  APP_USERNAME  (default: admin)
  APP_PASSWORD  (default: admin123)

Roles:
  admin  – full read/write access
  viewer – read-only (cannot add/edit/delete)

Sessions are stored in a server-side dict (sufficient for single-process deployment).
"""

import hashlib
import os
import secrets
from datetime import datetime, timedelta
from typing import Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import User
from ..schemas import UserCreate, UserOut

router = APIRouter()

# ── Config ─────────────────────────────────────────────────────────────────────
APP_USERNAME = os.getenv("APP_USERNAME", "admin")
APP_PASSWORD = os.getenv("APP_PASSWORD", "admin123")
SESSION_TTL  = int(os.getenv("SESSION_TTL_HOURS", "8"))
COOKIE_NAME  = "airsched_session"

# In-memory session store: token → {user_id, username, role, expiry}
_sessions: Dict[str, dict] = {}


# ── Password hashing (SHA-256, no external deps) ───────────────────────────────
def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()


def verify_password(password: str, password_hash: str) -> bool:
    return hash_password(password) == password_hash


# ── Session helpers ────────────────────────────────────────────────────────────
def _clean_sessions() -> None:
    now = datetime.utcnow()
    expired = [k for k, v in _sessions.items() if v["expiry"] < now]
    for k in expired:
        del _sessions[k]


def get_session(request: Request) -> Optional[dict]:
    """Return session dict if valid, else None."""
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return None
    sess = _sessions.get(token)
    if not sess or sess["expiry"] < datetime.utcnow():
        _sessions.pop(token, None)
        return None
    return sess


def is_authenticated(request: Request) -> bool:
    return get_session(request) is not None


def get_current_role(request: Request) -> str:
    """Return 'admin'|'viewer' for authenticated users, empty string if not auth."""
    sess = get_session(request)
    return sess["role"] if sess else ""


def require_admin(request: Request) -> None:
    """Raise 403 if the current user is not admin."""
    sess = get_session(request)
    if not sess or sess.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Chỉ admin mới có quyền thực hiện thao tác này.")


# ── Bootstrap first admin user ─────────────────────────────────────────────────
def ensure_admin_user(db: Session) -> None:
    """Called at startup: if no users exist, create the default admin from env."""
    if db.query(User).count() == 0:
        admin = User(
            username=APP_USERNAME,
            password_hash=hash_password(APP_PASSWORD),
            role="admin",
            display_name="Administrator",
        )
        db.add(admin)
        db.commit()


# ── Schemas ────────────────────────────────────────────────────────────────────
class LoginPayload(BaseModel):
    username: str
    password: str


# ── Routes ─────────────────────────────────────────────────────────────────────
@router.post("/login")
def login(payload: LoginPayload, response: Response, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == payload.username).first()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Tên đăng nhập hoặc mật khẩu không đúng.")

    _clean_sessions()
    token = secrets.token_urlsafe(32)
    _sessions[token] = {
        "user_id": user.id,
        "username": user.username,
        "role": user.role,
        "expiry": datetime.utcnow() + timedelta(hours=SESSION_TTL),
    }

    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        samesite="lax",
        max_age=SESSION_TTL * 3600,
    )
    return {"ok": True, "role": user.role, "username": user.username}


@router.post("/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE_NAME)
    if token:
        _sessions.pop(token, None)
    response.delete_cookie(COOKIE_NAME)
    return {"ok": True}


@router.get("/me")
def me(request: Request):
    sess = get_session(request)
    if sess:
        return {
            "authenticated": True,
            "username": sess["username"],
            "role": sess["role"],
        }
    raise HTTPException(status_code=401, detail="Not authenticated")


# ── User management (admin only) ───────────────────────────────────────────────
@router.get("/users", response_model=list[UserOut])
def list_users(request: Request, db: Session = Depends(get_db)):
    require_admin(request)
    return db.query(User).order_by(User.username).all()


@router.post("/users", response_model=UserOut, status_code=201)
def create_user(request: Request, payload: UserCreate, db: Session = Depends(get_db)):
    require_admin(request)
    if payload.role not in ("admin", "viewer"):
        raise HTTPException(400, "role phải là 'admin' hoặc 'viewer'")
    existing = db.query(User).filter(User.username == payload.username).first()
    if existing:
        raise HTTPException(400, f"Tên đăng nhập '{payload.username}' đã tồn tại")
    user = User(
        username=payload.username,
        password_hash=hash_password(payload.password),
        role=payload.role,
        display_name=payload.display_name or payload.username,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.put("/users/{user_id}", response_model=UserOut)
def update_user(request: Request, user_id: int, payload: UserCreate, db: Session = Depends(get_db)):
    require_admin(request)
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(404, "Không tìm thấy tài khoản")
    if payload.role not in ("admin", "viewer"):
        raise HTTPException(400, "role phải là 'admin' hoặc 'viewer'")
    # Prevent removing the last admin
    if user.role == "admin" and payload.role != "admin":
        admin_count = db.query(User).filter(User.role == "admin").count()
        if admin_count <= 1:
            raise HTTPException(400, "Không thể hạ quyền admin cuối cùng")
    user.username = payload.username
    if payload.password and payload.password != "UNCHANGED__placeholder":
        user.password_hash = hash_password(payload.password)
    user.role = payload.role
    user.display_name = payload.display_name or payload.username
    db.commit()
    db.refresh(user)
    return user


@router.delete("/users/{user_id}", status_code=204)
def delete_user(request: Request, user_id: int, db: Session = Depends(get_db)):
    require_admin(request)
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(404, "Không tìm thấy tài khoản")
    # Prevent deleting the last admin
    if user.role == "admin":
        admin_count = db.query(User).filter(User.role == "admin").count()
        if admin_count <= 1:
            raise HTTPException(400, "Không thể xóa admin cuối cùng")
    # Invalidate sessions for this user
    to_remove = [k for k, v in _sessions.items() if v.get("user_id") == user_id]
    for k in to_remove:
        del _sessions[k]
    db.delete(user)
    db.commit()
