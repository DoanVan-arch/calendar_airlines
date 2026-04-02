import json
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .database import engine, SessionLocal
from .models import Base, Airport, BlockTimeRule, TATRule, Registration, User
from .routers import aircraft, sectors, rules, export, auth as auth_router
from .routers import seasons as seasons_router, maintenance as maintenance_router, audit as audit_router
from .routers import notes as notes_router
from .routers.auth import is_authenticated, ensure_admin_user

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def seed_defaults():
    """Seed airports, block-time rules, and TAT rules on first run."""
    db = SessionLocal()
    try:
        # Airports
        if db.query(Airport).count() == 0:
            airports_file = os.path.join(BASE_DIR, "data", "airports.json")
            with open(airports_file, encoding="utf-8") as f:
                airports_data = json.load(f)
            for ap in airports_data:
                db.add(Airport(code=ap["code"], name=ap["name"], timezone_offset=ap["timezone_offset"]))
            db.commit()

        # Default block-time rules (domestic VN + a few international)
        if db.query(BlockTimeRule).count() == 0:
            defaults = [
                ("SGN", "HAN", 120), ("HAN", "SGN", 120),
                ("SGN", "DAD", 75),  ("DAD", "SGN", 75),
                ("HAN", "DAD", 65),  ("DAD", "HAN", 65),
                ("SGN", "HPH", 130), ("HPH", "SGN", 130),
                ("HAN", "HPH", 45),  ("HPH", "HAN", 45),
                ("SGN", "HUI", 90),  ("HUI", "SGN", 90),
                ("HAN", "HUI", 60),  ("HUI", "HAN", 60),
                ("SGN", "CXR", 55),  ("CXR", "SGN", 55),
                ("HAN", "CXR", 85),  ("CXR", "HAN", 85),
                ("SGN", "PQC", 55),  ("PQC", "SGN", 55),
                ("HAN", "VCA", 115), ("VCA", "HAN", 115),
                ("SGN", "VCA", 40),  ("VCA", "SGN", 40),
                ("SGN", "DLI", 50),  ("DLI", "SGN", 50),
                ("SGN", "BMV", 55),  ("BMV", "SGN", 55),
                ("SGN", "UIH", 65),  ("UIH", "SGN", 65),
                ("SGN", "SZX", 155), ("SZX", "SGN", 155),
                ("HAN", "SZX", 135), ("SZX", "HAN", 135),
                ("SGN", "SIN", 110), ("SIN", "SGN", 110),
                ("HAN", "SIN", 185), ("SIN", "HAN", 185),
                ("SGN", "BKK", 95),  ("BKK", "SGN", 95),
                ("HAN", "BKK", 135), ("BKK", "HAN", 135),
                ("SGN", "HKG", 145), ("HKG", "SGN", 145),
                ("HAN", "HKG", 130), ("HKG", "HAN", 130),
                ("SGN", "KUL", 110), ("KUL", "SGN", 110),
                ("HAN", "NRT", 270), ("NRT", "HAN", 270),
                ("SGN", "NRT", 315), ("NRT", "SGN", 315),
                ("HAN", "ICN", 225), ("ICN", "HAN", 225),
                ("SGN", "ICN", 270), ("ICN", "SGN", 270),
            ]
            for orig, dest, bt in defaults:
                db.add(BlockTimeRule(origin=orig, destination=dest, block_time_minutes=bt))
            db.commit()

        # Default TAT rules — 40 min for all Vietnamese airports, 60 min international
        if db.query(TATRule).count() == 0:
            domestic = ["SGN", "HAN", "DAD", "HPH", "HUI", "VCA", "CXR", "DLI",
                        "PXU", "BMV", "UIH", "VDH", "VCS", "PQC", "VKG", "CAH",
                        "VCL", "VII", "TBB"]
            intl = ["SZX", "PEK", "HKG", "SIN", "BKK", "KUL", "NRT", "ICN", "CDG", "LHR", "DXB"]
            for st in domestic:
                db.add(TATRule(station=st, min_tat_minutes=40))
            for st in intl:
                db.add(TATRule(station=st, min_tat_minutes=60))
            # Mass TAT defaults
            db.add(TATRule(station="__DOMESTIC__", min_tat_minutes=40))
            db.add(TATRule(station="__INTL__", min_tat_minutes=60))
            db.commit()
        else:
            # Ensure mass TAT rules exist (migration for existing databases)
            if not db.query(TATRule).filter(TATRule.station == "__DOMESTIC__").first():
                db.add(TATRule(station="__DOMESTIC__", min_tat_minutes=40))
            if not db.query(TATRule).filter(TATRule.station == "__INTL__").first():
                db.add(TATRule(station="__INTL__", min_tat_minutes=60))
            db.commit()
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    _migrate_db()
    seed_defaults()
    db = SessionLocal()
    try:
        ensure_admin_user(db)
    finally:
        db.close()
    yield


def _migrate_db():
    """Apply lightweight column migrations for schema evolution."""
    from sqlalchemy import text
    with engine.connect() as conn:
        # Add ac_type column to aircraft table if it doesn't exist
        try:
            conn.execute(text("ALTER TABLE aircraft ADD COLUMN ac_type VARCHAR(50)"))
            conn.commit()
        except Exception:
            pass  # Column already exists
        
        # Create registrations table if it doesn't exist
        try:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS registrations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    registration VARCHAR(20) NOT NULL UNIQUE,
                    aircraft_model VARCHAR(100) NOT NULL,
                    seats INTEGER NOT NULL
                )
            """))
            conn.commit()
        except Exception:
            pass

        # Add is_domestic column to tat_rules if it doesn't exist
        try:
            conn.execute(text("ALTER TABLE tat_rules ADD COLUMN is_domestic BOOLEAN"))
            conn.commit()
        except Exception:
            pass  # Column already exists

        # Create users table if it doesn't exist
        try:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username VARCHAR(50) NOT NULL UNIQUE,
                    password_hash VARCHAR(200) NOT NULL,
                    role VARCHAR(20) NOT NULL DEFAULT 'viewer',
                    display_name VARCHAR(100)
                )
            """))
            conn.commit()
        except Exception:
            pass

        # Create seasons table
        try:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS seasons (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name VARCHAR(100) NOT NULL,
                    season_type VARCHAR(10) NOT NULL,
                    year INTEGER NOT NULL,
                    start_date VARCHAR(10) NOT NULL,
                    end_date VARCHAR(10) NOT NULL
                )
            """))
            conn.commit()
        except Exception:
            pass

        # Create maintenance_blocks table
        try:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS maintenance_blocks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    aircraft_id INTEGER NOT NULL,
                    label VARCHAR(100) NOT NULL DEFAULT 'Maintenance',
                    start_date VARCHAR(10) NOT NULL,
                    end_date VARCHAR(10) NOT NULL,
                    color VARCHAR(20) DEFAULT '#f59e0b'
                )
            """))
            conn.commit()
        except Exception:
            pass

        # Create audit_log table
        try:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS audit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp DATETIME NOT NULL,
                    username VARCHAR(50) NOT NULL,
                    action VARCHAR(50) NOT NULL,
                    entity VARCHAR(50) NOT NULL,
                    entity_id INTEGER,
                    detail VARCHAR(500)
                )
            """))
            conn.commit()
        except Exception:
            pass

        # Add color column to aircraft table
        try:
            conn.execute(text("ALTER TABLE aircraft ADD COLUMN color VARCHAR(20)"))
            conn.commit()
        except Exception:
            pass

        # Add color column to flight_sectors table
        try:
            conn.execute(text("ALTER TABLE flight_sectors ADD COLUMN color VARCHAR(20)"))
            conn.commit()
        except Exception:
            pass

        # Add dw_type column to registrations table
        try:
            conn.execute(text("ALTER TABLE registrations ADD COLUMN dw_type VARCHAR(10)"))
            conn.commit()
        except Exception:
            pass  # Column already exists

        # Add registration_id column to aircraft table
        try:
            conn.execute(text("ALTER TABLE aircraft ADD COLUMN registration_id INTEGER"))
            conn.commit()
        except Exception:
            pass  # Column already exists

        # Add start_time and end_time columns to maintenance_blocks
        try:
            conn.execute(text("ALTER TABLE maintenance_blocks ADD COLUMN start_time VARCHAR(5)"))
            conn.commit()
        except Exception:
            pass  # Column already exists
        try:
            conn.execute(text("ALTER TABLE maintenance_blocks ADD COLUMN end_time VARCHAR(5)"))
            conn.commit()
        except Exception:
            pass  # Column already exists

        # Create calendar_notes table
        try:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS calendar_notes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    note_date VARCHAR(10) NOT NULL,
                    start_time VARCHAR(5),
                    end_time VARCHAR(5),
                    content VARCHAR(1000) NOT NULL,
                    color VARCHAR(20) DEFAULT '#3b82f6'
                )
            """))
            conn.commit()
        except Exception:
            pass

        # Add mtow column to registrations table
        try:
            conn.execute(text("ALTER TABLE registrations ADD COLUMN mtow REAL"))
            conn.commit()
        except Exception:
            pass  # Column already exists

        # Add ats column to block_time_rules table
        try:
            conn.execute(text("ALTER TABLE block_time_rules ADD COLUMN ats VARCHAR(100)"))
            conn.commit()
        except Exception:
            pass  # Column already exists

        # Add note_end_date column to calendar_notes table
        try:
            conn.execute(text("ALTER TABLE calendar_notes ADD COLUMN note_end_date VARCHAR(10)"))
            conn.commit()
        except Exception:
            pass  # Column already exists


app = FastAPI(title="Airline Schedule Manager", lifespan=lifespan)

# ── Auth middleware ────────────────────────────────────────────────────────────
@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    # Public paths that don't require authentication
    public_paths = {"/login", "/api/auth/login", "/api/auth/logout"}
    path = request.url.path

    # Allow static files always
    if path.startswith("/static"):
        return await call_next(request)

    # Allow public API/pages
    if path in public_paths:
        return await call_next(request)

    # Check authentication
    if not is_authenticated(request):
        # For API calls return 401, for page requests redirect to login
        if path.startswith("/api/"):
            from fastapi.responses import JSONResponse
            return JSONResponse({"detail": "Not authenticated"}, status_code=401)
        return RedirectResponse(url="/login")

    return await call_next(request)

# ── Static files & templates ───────────────────────────────────────────────────
app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))

# ── Routers ────────────────────────────────────────────────────────────────────
app.include_router(auth_router.router,        prefix="/api/auth",        tags=["auth"])
app.include_router(aircraft.router,           prefix="/api/aircraft",    tags=["aircraft"])
app.include_router(sectors.router,            prefix="/api/sectors",     tags=["sectors"])
app.include_router(rules.router,              prefix="/api/rules",       tags=["rules"])
app.include_router(export.router,             prefix="/api/export",      tags=["export"])
app.include_router(seasons_router.router,     prefix="/api/seasons",     tags=["seasons"])
app.include_router(maintenance_router.router, prefix="/api/maintenance",  tags=["maintenance"])
app.include_router(audit_router.router,       prefix="/api/audit",       tags=["audit"])
app.include_router(notes_router.router,       prefix="/api/notes",       tags=["notes"])


@app.get("/login")
async def login_page(request: Request):
    # If already logged in, redirect to main app
    if is_authenticated(request):
        return RedirectResponse(url="/")
    return templates.TemplateResponse("login.html", {"request": request})


@app.get("/")
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})
