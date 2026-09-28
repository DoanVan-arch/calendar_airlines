"""
Auth router – username/password authentication with session cookies.

Users are stored in the SQLite database (users table).
The first admin account is bootstrapped from environment variables:
  APP_USERNAME  (default: admin)
  APP_PASSWORD  (default: admin123)

Roles:
  admin  – full read/write access, everywhere (all databases, users, db registry)
  mod    – permission depends on the currently selected database:
             - on the default/master database (airline_schedule.db): read-only,
               can export, and can create flight sectors (covers copy/paste of
               sectors) — but cannot edit/delete/cancel/restore/swap sectors,
               and cannot write to aircraft/rules/maintenance/seasons/notes.
             - on any other (demo) database: full read/write access, same as admin,
               for all content-management endpoints (sectors, aircraft, rules,
               maintenance, seasons, notes, service codes, etc). Mod can NEVER
               manage users or the database registry itself, regardless of
               which database is selected — that remains admin-only.
  viewer – read-only everywhere (cannot add/edit/delete)

Sessions are stored in a server-side dict (sufficient for single-process deployment).
"""

import hashlib
import os
import re
import unicodedata
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import session_store
from ..database import (
    MASTER_DB_FILENAME,
    create_database_file,
    db_path,
    drop_database_cache,
    get_master_db,
)
from ..models import AppDatabase, User
from ..schemas import (
    AppDatabaseCreate,
    AppDatabaseOut,
    AppDatabaseUpdate,
    SetDatabasePasswordPayload,
    UserCreate,
    UserOut,
)

router = APIRouter()

# ── Config ─────────────────────────────────────────────────────────────────────
APP_USERNAME = os.getenv("APP_USERNAME", "admin")
APP_PASSWORD = os.getenv("APP_PASSWORD", "admin123")
SESSION_TTL  = int(os.getenv("SESSION_TTL_HOURS", "8"))
COOKIE_NAME  = session_store.COOKIE_NAME


# ── Password hashing (SHA-256, no external deps) ───────────────────────────────
def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()


def verify_password(password: str, password_hash: str) -> bool:
    return hash_password(password) == password_hash


# ── Session helpers ────────────────────────────────────────────────────────────
def get_session(request: Request) -> Optional[dict]:
    """Return session dict if valid, else None."""
    return session_store.get_session_by_token(request)


def is_authenticated(request: Request) -> bool:
    return get_session(request) is not None


def get_current_role(request: Request) -> str:
    """Return 'admin'|'mod'|'viewer' for authenticated users, empty string if not auth."""
    sess = get_session(request)
    return sess["role"] if sess else ""


def is_master_db_session(request: Request) -> bool:
    """True if the current session's selected database is the default/master one."""
    sess = get_session(request)
    db_filename = (sess or {}).get("db_filename") or MASTER_DB_FILENAME
    return db_filename == MASTER_DB_FILENAME


def require_admin(request: Request) -> None:
    """Raise 403 if the current user is not admin.

    This is strictly for user-management / database-registry endpoints, which
    stay admin-only regardless of which database is currently selected.
    """
    sess = get_session(request)
    if not sess or sess.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Chỉ admin mới có quyền thực hiện thao tác này.")


def require_mod_or_admin(request: Request) -> None:
    """Raise 403 if the current user is not admin or mod.

    Use only for actions that mod should always be allowed to do, on any
    database (e.g. creating a sector, which covers copy/paste on the master DB).
    """
    sess = get_session(request)
    if not sess or sess.get("role") not in ("admin", "mod"):
        raise HTTPException(status_code=403, detail="Bạn không có quyền thực hiện thao tác này.")


def require_editor(request: Request) -> None:
    """Raise 403 unless the user has full write/edit access to the currently
    selected database's content (aircraft, sectors edits/deletes, rules,
    maintenance, seasons, notes, imports, etc).

    - admin: always allowed.
    - mod: allowed only when NOT on the default/master database (i.e. on a
      demo database, mod gets full admin-equivalent content permissions).
    - viewer / mod-on-master: denied.
    """
    sess = get_session(request)
    role = sess.get("role") if sess else None
    if role == "admin":
        return
    if role == "mod" and not is_master_db_session(request):
        return
    if is_master_db_session(request) and role == "mod":
        raise HTTPException(
            status_code=403,
            detail="Tài khoản Mod chỉ được xem và xuất dữ liệu trên cơ sở dữ liệu chính (chỉ được copy/paste chặng bay).",
        )
    raise HTTPException(status_code=403, detail="Bạn không có quyền thực hiện thao tác này.")


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


def ensure_default_database(db: Session) -> AppDatabase:
    """Called at startup: ensure the master db has a registry row for itself."""
    row = db.query(AppDatabase).filter(AppDatabase.filename == MASTER_DB_FILENAME).first()
    if not row:
        row = AppDatabase(
            name="Airline Schedule (LIVE)",
            filename=MASTER_DB_FILENAME,
            is_default=True,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def _slugify_filename(name: str) -> str:
    normalized = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", normalized).strip("_").lower() or "database"
    return slug


def _unique_filename(db: Session, base_slug: str) -> str:
    candidate = f"{base_slug}.db"
    n = 1
    existing = {row.filename for row in db.query(AppDatabase.filename).all()}
    while candidate in existing:
        n += 1
        candidate = f"{base_slug}_{n}.db"
    return candidate


def _db_out(row: AppDatabase) -> AppDatabaseOut:
    return AppDatabaseOut(
        id=row.id,
        name=row.name,
        filename=row.filename,
        is_default=row.is_default,
        has_password=bool(row.password_hash),
    )


# ── Schemas ────────────────────────────────────────────────────────────────────
class LoginPayload(BaseModel):
    username: str
    password: str
    database_id: Optional[int] = None
    db_password: Optional[str] = None


class SelectDatabasePayload(BaseModel):
    database_id: int
    db_password: Optional[str] = None


# ── Routes ─────────────────────────────────────────────────────────────────────
@router.get("/databases", response_model=list[AppDatabaseOut])
def list_databases(db: Session = Depends(get_master_db)):
    """Public: list of available databases, used by the login page and admin UI."""
    rows = db.query(AppDatabase).order_by(AppDatabase.is_default.desc(), AppDatabase.name).all()
    return [_db_out(r) for r in rows]


@router.post("/login")
def login(payload: LoginPayload, response: Response, db: Session = Depends(get_master_db)):
    user = db.query(User).filter(User.username == payload.username).first()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Tên đăng nhập hoặc mật khẩu không đúng.")

    db_filename = MASTER_DB_FILENAME
    if payload.database_id is not None:
        target = db.query(AppDatabase).filter(AppDatabase.id == payload.database_id).first()
        if not target:
            raise HTTPException(status_code=400, detail="Database không tồn tại.")
        if target.password_hash:
            if not payload.db_password or not verify_password(payload.db_password, target.password_hash):
                raise HTTPException(status_code=401, detail="Sai mật khẩu cơ sở dữ liệu.")
        db_filename = target.filename

    token = session_store.create_session(
        user_id=user.id,
        username=user.username,
        role=user.role,
        db_filename=db_filename,
        ttl_hours=SESSION_TTL,
    )

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
    token = session_store.get_token(request)
    session_store.remove_session_token(token)
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
            "db_filename": sess.get("db_filename"),
            "is_master_db": is_master_db_session(request),
        }
    raise HTTPException(status_code=401, detail="Not authenticated")


@router.post("/select-database")
def select_database(request: Request, payload: SelectDatabasePayload, db: Session = Depends(get_master_db)):
    """Switch the database used for the current session (any authenticated role)."""
    if not is_authenticated(request):
        raise HTTPException(status_code=401, detail="Not authenticated")
    target = db.query(AppDatabase).filter(AppDatabase.id == payload.database_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="Database không tồn tại.")
    if target.password_hash:
        if not payload.db_password or not verify_password(payload.db_password, target.password_hash):
            raise HTTPException(status_code=401, detail="Sai mật khẩu cơ sở dữ liệu.")
    session_store.set_session_database(request, target.filename)
    return {"ok": True, "database": _db_out(target)}


# ── Database management (admin only) ────────────────────────────────────────────
MAX_DATABASES = 10  # max number of non-default (demo/custom) databases allowed


@router.post("/databases", response_model=AppDatabaseOut, status_code=201)
def create_database(request: Request, payload: AppDatabaseCreate, db: Session = Depends(get_master_db)):
    require_admin(request)
    name = payload.name.strip()
    if not name:
        raise HTTPException(400, "Tên database không được để trống")
    existing_count = db.query(AppDatabase).filter(AppDatabase.is_default == False).count()  # noqa: E712
    if existing_count >= MAX_DATABASES:
        raise HTTPException(400, f"Đã đạt giới hạn tối đa {MAX_DATABASES} database. Vui lòng xóa bớt trước khi thêm mới.")
    filename = _unique_filename(db, _slugify_filename(name))
    create_database_file(filename)
    row = AppDatabase(name=name, filename=filename, is_default=False)
    db.add(row)
    db.commit()
    db.refresh(row)
    return _db_out(row)


@router.put("/databases/{database_id}", response_model=AppDatabaseOut)
def rename_database(request: Request, database_id: int, payload: AppDatabaseUpdate, db: Session = Depends(get_master_db)):
    require_admin(request)
    row = db.query(AppDatabase).filter(AppDatabase.id == database_id).first()
    if not row:
        raise HTTPException(404, "Không tìm thấy database")
    if row.is_default:
        raise HTTPException(400, "Không thể đổi tên database mặc định")
    name = payload.name.strip()
    if not name:
        raise HTTPException(400, "Tên database không được để trống")
    row.name = name
    db.commit()
    db.refresh(row)
    return _db_out(row)


@router.delete("/databases/{database_id}", status_code=204)
def delete_database(request: Request, database_id: int, db: Session = Depends(get_master_db)):
    require_admin(request)
    row = db.query(AppDatabase).filter(AppDatabase.id == database_id).first()
    if not row:
        raise HTTPException(404, "Không tìm thấy database")
    if row.is_default:
        raise HTTPException(400, "Không thể xóa database LIVE")
    filename = row.filename
    db.delete(row)
    db.commit()
    drop_database_cache(filename)
    session_store.reset_database_in_sessions(filename, MASTER_DB_FILENAME)
    try:
        path = db_path(filename)
        if os.path.exists(path):
            os.remove(path)
    except OSError:
        pass
    return None


@router.put("/databases/{database_id}/password", response_model=AppDatabaseOut)
def set_database_password(request: Request, database_id: int, payload: SetDatabasePasswordPayload, db: Session = Depends(get_master_db)):
    """Admin only: set (or replace) the access password required to select this database."""
    require_admin(request)
    row = db.query(AppDatabase).filter(AppDatabase.id == database_id).first()
    if not row:
        raise HTTPException(404, "Không tìm thấy database")
    if not payload.password:
        raise HTTPException(400, "Mật khẩu không được để trống")
    row.password_hash = hash_password(payload.password)
    db.commit()
    db.refresh(row)
    return _db_out(row)


@router.delete("/databases/{database_id}/password", response_model=AppDatabaseOut)
def clear_database_password(request: Request, database_id: int, db: Session = Depends(get_master_db)):
    """Admin only: remove the access password from this database."""
    require_admin(request)
    row = db.query(AppDatabase).filter(AppDatabase.id == database_id).first()
    if not row:
        raise HTTPException(404, "Không tìm thấy database")
    row.password_hash = None
    db.commit()
    db.refresh(row)
    return _db_out(row)


# ── User management (admin only) ───────────────────────────────────────────────
@router.get("/users", response_model=list[UserOut])
def list_users(request: Request, db: Session = Depends(get_master_db)):
    require_admin(request)
    return db.query(User).order_by(User.username).all()


@router.post("/users", response_model=UserOut, status_code=201)
def create_user(request: Request, payload: UserCreate, db: Session = Depends(get_master_db)):
    require_admin(request)
    if payload.role not in ("admin", "mod", "viewer"):
        raise HTTPException(400, "role phải là 'admin', 'mod' hoặc 'viewer'")
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
def update_user(request: Request, user_id: int, payload: UserCreate, db: Session = Depends(get_master_db)):
    require_admin(request)
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(404, "Không tìm thấy tài khoản")
    if payload.role not in ("admin", "mod", "viewer"):
        raise HTTPException(400, "role phải là 'admin', 'mod' hoặc 'viewer'")
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
def delete_user(request: Request, user_id: int, db: Session = Depends(get_master_db)):
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
    session_store.remove_sessions_for_user(user_id)
    db.delete(user)
    db.commit()
