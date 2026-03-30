from sqlalchemy import Column, Integer, String, Float, Boolean, UniqueConstraint, DateTime
from datetime import datetime
from .database import Base


class Airport(Base):
    __tablename__ = "airports"
    code = Column(String(10), primary_key=True)
    name = Column(String(200))
    timezone_offset = Column(Float, default=7.0)  # Hours from UTC


class Aircraft(Base):
    __tablename__ = "aircraft"
    id = Column(Integer, primary_key=True, autoincrement=True)
    registration = Column(String(20), unique=True, nullable=False)
    name = Column(String(50), nullable=True)
    ac_type = Column(String(50), nullable=True)   # e.g. A320, B737-800
    line_order = Column(Integer, default=0)
    color = Column(String(20), nullable=True)      # hex color e.g. "#2563eb"


class Registration(Base):
    """Aircraft registration details - stores aircraft specs"""
    __tablename__ = "registrations"
    id = Column(Integer, primary_key=True, autoincrement=True)
    registration = Column(String(20), unique=True, nullable=False)  # VN-A123
    aircraft_model = Column(String(100), nullable=False)  # Airbus 321
    seats = Column(Integer, nullable=False)  # 200


class FlightSector(Base):
    __tablename__ = "flight_sectors"
    id = Column(Integer, primary_key=True, autoincrement=True)
    aircraft_id = Column(Integer, nullable=False)
    flight_date = Column(String(10), nullable=False)  # YYYY-MM-DD
    origin = Column(String(10), nullable=False)
    destination = Column(String(10), nullable=False)
    dep_utc = Column(String(5), nullable=False)   # HH:MM in UTC
    arr_utc = Column(String(5), nullable=False)   # HH:MM in UTC
    flight_number = Column(String(20), nullable=True)
    status = Column(String(20), default="active")  # active | cancelled
    sequence = Column(Integer, default=0)
    color = Column(String(20), nullable=True)      # override color for this sector


class BlockTimeRule(Base):
    __tablename__ = "block_time_rules"
    __table_args__ = (UniqueConstraint("origin", "destination"),)
    id = Column(Integer, primary_key=True, autoincrement=True)
    origin = Column(String(10), nullable=False)
    destination = Column(String(10), nullable=False)
    block_time_minutes = Column(Integer, nullable=False)


class TATRule(Base):
    __tablename__ = "tat_rules"
    __table_args__ = (UniqueConstraint("station"),)
    id = Column(Integer, primary_key=True, autoincrement=True)
    station = Column(String(10), nullable=False)
    min_tat_minutes = Column(Integer, default=40)
    is_domestic = Column(Boolean, nullable=True)  # True=nội địa, False=quốc tế, None=chưa xác định


class User(Base):
    """Application user with role-based access control."""
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(50), unique=True, nullable=False)
    password_hash = Column(String(200), nullable=False)  # bcrypt hash
    role = Column(String(20), default="viewer")  # "admin" | "viewer"
    display_name = Column(String(100), nullable=True)


class Season(Base):
    """IATA season definition (Summer/Winter), admin-editable."""
    __tablename__ = "seasons"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(100), nullable=False)      # e.g. "Mùa hè 2026"
    season_type = Column(String(10), nullable=False) # "summer" | "winter"
    year = Column(Integer, nullable=False)
    start_date = Column(String(10), nullable=False)  # YYYY-MM-DD
    end_date = Column(String(10), nullable=False)    # YYYY-MM-DD


class MaintenanceBlock(Base):
    """A maintenance / ground block for an aircraft spanning multiple days."""
    __tablename__ = "maintenance_blocks"
    id = Column(Integer, primary_key=True, autoincrement=True)
    aircraft_id = Column(Integer, nullable=False)
    label = Column(String(100), nullable=False, default="Maintenance")
    start_date = Column(String(10), nullable=False)  # YYYY-MM-DD
    end_date = Column(String(10), nullable=False)    # YYYY-MM-DD
    color = Column(String(20), nullable=True, default="#f59e0b")


class AuditLog(Base):
    """Immutable log of changes made to flight sectors and aircraft."""
    __tablename__ = "audit_log"
    id = Column(Integer, primary_key=True, autoincrement=True)
    timestamp = Column(DateTime, default=datetime.utcnow, nullable=False)
    username = Column(String(50), nullable=False)
    action = Column(String(50), nullable=False)   # CREATE | UPDATE | DELETE | CANCEL | RESTORE
    entity = Column(String(50), nullable=False)   # sector | aircraft | maintenance
    entity_id = Column(Integer, nullable=True)
    detail = Column(String(500), nullable=True)   # human-readable summary
