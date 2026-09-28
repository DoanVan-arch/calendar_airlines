import os
from typing import Dict

from fastapi import Request
from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

from . import session_store

# ── Master database ─────────────────────────────────────────────────────────────
# The master database always holds `users` and the `app_databases` registry.
# It cannot be renamed or deleted by the admin UI.
MASTER_DB_FILENAME = "airline_schedule.db"

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def db_path(filename: str) -> str:
    return os.path.join(BASE_DIR, filename)


def make_db_url(filename: str) -> str:
    return f"sqlite:///./{filename}"


SQLALCHEMY_DATABASE_URL = make_db_url(MASTER_DB_FILENAME)

engine = create_engine(
    SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False}
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


# ── Per-file engine/session cache (multi-database support) ─────────────────────
_engines: Dict[str, Engine] = {MASTER_DB_FILENAME: engine}
_session_factories: Dict[str, sessionmaker] = {MASTER_DB_FILENAME: SessionLocal}


def get_engine_for_file(filename: str) -> Engine:
    eng = _engines.get(filename)
    if eng is None:
        eng = create_engine(make_db_url(filename), connect_args={"check_same_thread": False})
        _engines[filename] = eng
    return eng


def get_session_factory(filename: str) -> sessionmaker:
    factory = _session_factories.get(filename)
    if factory is None:
        factory = sessionmaker(autocommit=False, autoflush=False, bind=get_engine_for_file(filename))
        _session_factories[filename] = factory
    return factory


DEFAULT_SERVICE_CODES = [
    ("J", "Regular"),
    ("C", "Charter"),
    ("P", "Ferry"),
]


def create_database_file(filename: str) -> None:
    """Create a new SQLite file (if missing) with the full app schema, no data
    (except a few required default reference rows, e.g. service codes).

    Also safe to call repeatedly on an already-existing database file: it will
    retrofit any missing tables/columns added by later features (e.g. adding
    `service_code` to `flight_sectors`, or the `service_codes` table itself)
    and seed default rows only if they are missing.
    """
    eng = get_engine_for_file(filename)
    Base.metadata.create_all(bind=eng)

    from sqlalchemy import text
    with eng.connect() as conn:
        try:
            conn.execute(text("ALTER TABLE flight_sectors ADD COLUMN service_code VARCHAR(10) DEFAULT 'J'"))
            conn.commit()
        except Exception:
            pass  # column already exists

    # Local import to avoid a circular import between database.py and models.py
    from .models import ServiceCode

    factory = get_session_factory(filename)
    session = factory()
    try:
        if session.query(ServiceCode).count() == 0:
            for code, status in DEFAULT_SERVICE_CODES:
                session.add(ServiceCode(code=code, status=status))
            session.commit()
    finally:
        session.close()


def drop_database_cache(filename: str) -> None:
    """Dispose and forget a cached engine (used before deleting/renaming a db file)."""
    eng = _engines.pop(filename, None)
    if eng is not None:
        eng.dispose()
    _session_factories.pop(filename, None)


def get_master_db():
    """Dependency: always yields a session on the master database (users, db registry)."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_db(request: Request):
    """Dependency: yields a session on the database currently selected for this session.

    Falls back to the master database if there is no session yet (e.g. login page).
    """
    sess = session_store.get_session_by_token(request)
    filename = (sess or {}).get("db_filename") or MASTER_DB_FILENAME
    factory = get_session_factory(filename)
    db = factory()
    try:
        yield db
    finally:
        db.close()
