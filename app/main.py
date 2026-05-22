import json
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .database import engine, SessionLocal
from .models import Base, Airport, BlockTimeRule, TATRule, Registration, User, RosterRule
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
            # Known international airport codes
            intl_set = {"SZX","PEK","HKG","SIN","BKK","KUL","NRT","ICN","CDG","LHR","DXB"}
            for ap in airports_data:
                db.add(Airport(
                    code=ap["code"], name=ap["name"],
                    timezone_offset=ap["timezone_offset"],
                    is_domestic=ap["code"] not in intl_set,
                ))
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

        # Roster rules – seed IATA FDP table if empty
        if db.query(RosterRule).count() == 0:
            def t(hhmm):
                h, m = map(int, hhmm.split(":"))
                return h * 60 + m
            # (fdp_from, fdp_to, 1-2, 3, 4, 5, 6, 7)
            roster_data = [
                ("06:00", "13:29", t("13:00"), t("12:30"), t("12:00"), t("11:30"), t("11:00"), t("10:30")),
                ("13:30", "13:59", t("12:45"), t("12:15"), t("11:45"), t("11:15"), t("10:45"), t("10:15")),
                ("14:00", "14:29", t("12:30"), t("12:00"), t("11:30"), t("11:00"), t("10:30"), t("10:00")),
                ("14:30", "14:59", t("12:15"), t("11:45"), t("11:15"), t("10:45"), t("10:15"),  t("9:45")),
                ("15:00", "15:29", t("12:00"), t("11:30"), t("11:00"), t("10:30"), t("10:00"),  t("9:30")),
                ("15:30", "15:59", t("11:45"), t("11:15"), t("10:45"), t("10:15"),  t("9:45"),  t("9:15")),
                ("16:00", "16:29", t("11:30"), t("11:00"), t("10:30"), t("10:00"),  t("9:30"),  t("9:00")),
                ("16:30", "16:59", t("11:15"), t("10:45"), t("10:15"),  t("9:45"),  t("9:15"),  t("9:00")),
                ("17:00", "04:59", t("11:00"), t("10:30"), t("10:00"),  t("9:30"),  t("9:00"),  t("9:00")),
                ("05:00", "05:14", t("12:00"), t("11:30"), t("11:00"), t("10:30"), t("10:00"),  t("9:30")),
                ("05:15", "05:29", t("12:15"), t("11:45"), t("11:15"), t("10:45"), t("10:15"),  t("9:45")),
                ("05:30", "05:44", t("12:30"), t("12:00"), t("11:30"), t("11:00"), t("10:30"), t("10:00")),
                ("05:45", "05:59", t("12:45"), t("12:15"), t("11:45"), t("11:15"), t("10:45"), t("10:15")),
            ]
            for fdp_from, fdp_to, f12, f3, f4, f5, f6, f7 in roster_data:
                db.add(RosterRule(
                    fdp_start_from=fdp_from, fdp_start_to=fdp_to,
                    max_fdp_1_2=f12, max_fdp_3=f3, max_fdp_4=f4,
                    max_fdp_5=f5, max_fdp_6=f6, max_fdp_7=f7,
                    sign_on_minutes=60, sign_off_minutes=30, no_crew_set=1
                ))
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

        # Create route_colors table
        try:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS route_colors (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    origin VARCHAR(10) NOT NULL,
                    destination VARCHAR(10) NOT NULL,
                    color VARCHAR(20) NOT NULL,
                    UNIQUE(origin, destination)
                )
            """))
            conn.commit()
        except Exception:
            pass

        # Create app_settings table
        try:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS app_settings (
                    key VARCHAR(100) PRIMARY KEY,
                    value VARCHAR(500)
                )
            """))
            conn.commit()
        except Exception:
            pass

        # Add curfew columns to airports table
        try:
            conn.execute(text("ALTER TABLE airports ADD COLUMN curfew_open VARCHAR(5)"))
            conn.commit()
        except Exception:
            pass
        try:
            conn.execute(text("ALTER TABLE airports ADD COLUMN curfew_close VARCHAR(5)"))
            conn.commit()
        except Exception:
            pass

        # Add distance_km column to block_time_rules table
        try:
            conn.execute(text("ALTER TABLE block_time_rules ADD COLUMN distance_km INTEGER"))
            conn.commit()
        except Exception:
            pass  # Column already exists

        # Add enabled column to route_colors table
        try:
            conn.execute(text("ALTER TABLE route_colors ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT 1"))
            conn.commit()
        except Exception:
            pass  # Column already exists

        # Create roster_rules table
        try:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS roster_rules (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    fdp_start_from VARCHAR(5) NOT NULL,
                    fdp_start_to VARCHAR(5) NOT NULL,
                    max_fdp_1_2 INTEGER,
                    max_fdp_3 INTEGER,
                    max_fdp_4 INTEGER,
                    max_fdp_5 INTEGER,
                    max_fdp_6 INTEGER,
                    max_fdp_7 INTEGER,
                    sign_on_minutes INTEGER NOT NULL DEFAULT 60,
                    sign_off_minutes INTEGER NOT NULL DEFAULT 30,
                    no_crew_set INTEGER NOT NULL DEFAULT 1
                )
            """))
            conn.commit()
        except Exception:
            pass

        # Add is_domestic column to airports table
        try:
            conn.execute(text("ALTER TABLE airports ADD COLUMN is_domestic BOOLEAN DEFAULT 1"))
            conn.commit()
        except Exception:
            pass  # Column already exists
        # Set international airports (known non-VN airports) to is_domestic=0
        intl_codes = ("SZX","PEK","HKG","SIN","BKK","KUL","NRT","ICN","CDG","LHR","DXB")
        for code in intl_codes:
            try:
                conn.execute(text("UPDATE airports SET is_domestic = 0 WHERE code = :c AND is_domestic = 1"), {"c": code})
            except Exception:
                pass
        try:
            conn.commit()
        except Exception:
            pass


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
