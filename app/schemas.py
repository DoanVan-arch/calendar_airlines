from pydantic import BaseModel, field_validator
from typing import Optional, List
from datetime import datetime
import re


# ── Line Swap ──────────────────────────────────────────────────────────────────
class SwapAircraftPayload(BaseModel):
    aircraft_a_id: int
    aircraft_b_id: int
    date: Optional[str] = None   # YYYY-MM-DD; if None → swap ALL dates


# ── Airport ────────────────────────────────────────────────────────────────────
class AirportBase(BaseModel):
    code: str
    name: str
    timezone_offset: float = 7.0


class AirportCreate(AirportBase):
    pass


class AirportOut(AirportBase):
    model_config = {"from_attributes": True}


# ── Aircraft ───────────────────────────────────────────────────────────────────
class AircraftBase(BaseModel):
    registration: str
    name: Optional[str] = None
    ac_type: Optional[str] = None
    line_order: int = 0
    color: Optional[str] = None
    registration_id: Optional[int] = None  # FK to registrations.id; None = TẠM


class AircraftCreate(AircraftBase):
    pass


class AircraftUpdate(BaseModel):
    registration: Optional[str] = None
    name: Optional[str] = None
    ac_type: Optional[str] = None
    line_order: Optional[int] = None
    color: Optional[str] = None
    registration_id: Optional[int] = None  # FK to registrations.id; None = TẠM


class AircraftOut(AircraftBase):
    id: int
    registration_info: Optional[dict] = None  # {aircraft_model, seats} from Registration table
    model_config = {"from_attributes": True}


# ── Flight Sector ──────────────────────────────────────────────────────────────
_TIME_RE = re.compile(r"^\d{2}:\d{2}$")


class FlightSectorBase(BaseModel):
    aircraft_id: int
    flight_date: str       # YYYY-MM-DD
    origin: str
    destination: str
    dep_utc: str           # HH:MM
    arr_utc: str           # HH:MM
    flight_number: Optional[str] = None
    status: str = "active"
    sequence: int = 0
    color: Optional[str] = None

    @field_validator("dep_utc", "arr_utc")
    @classmethod
    def validate_time(cls, v: str) -> str:
        if not _TIME_RE.match(v):
            raise ValueError("Time must be HH:MM")
        return v


class FlightSectorCreate(FlightSectorBase):
    pass


class FlightSectorUpdate(BaseModel):
    aircraft_id: Optional[int] = None
    flight_date: Optional[str] = None
    origin: Optional[str] = None
    destination: Optional[str] = None
    dep_utc: Optional[str] = None
    arr_utc: Optional[str] = None
    flight_number: Optional[str] = None
    status: Optional[str] = None
    sequence: Optional[int] = None
    color: Optional[str] = None


class FlightSectorOut(FlightSectorBase):
    id: int
    model_config = {"from_attributes": True}


# ── Block-time rule ────────────────────────────────────────────────────────────
class BlockTimeRuleBase(BaseModel):
    origin: str
    destination: str
    block_time_minutes: int
    ats: Optional[str] = None  # ATS route (đường bay không lưu)


class BlockTimeRuleCreate(BlockTimeRuleBase):
    pass


class BlockTimeRuleOut(BlockTimeRuleBase):
    id: int
    model_config = {"from_attributes": True}


# ── TAT rule ───────────────────────────────────────────────────────────────────
class TATRuleBase(BaseModel):
    station: str
    min_tat_minutes: int = 40
    is_domestic: Optional[bool] = None  # True=nội địa, False=quốc tế, None=chưa xác định


class TATRuleCreate(TATRuleBase):
    pass


class TATRuleOut(TATRuleBase):
    id: int
    model_config = {"from_attributes": True}


# ── User ───────────────────────────────────────────────────────────────────────
class UserCreate(BaseModel):
    username: str
    password: str
    role: str = "viewer"  # "admin" | "viewer"
    display_name: Optional[str] = None


class UserOut(BaseModel):
    id: int
    username: str
    role: str
    display_name: Optional[str] = None
    model_config = {"from_attributes": True}


# ── Registration ───────────────────────────────────────────────────────────────
class RegistrationBase(BaseModel):
    registration: str
    aircraft_model: str
    seats: int
    dw_type: Optional[str] = None  # "Dry", "Wet", or None
    mtow: Optional[float] = None   # Maximum Take-Off Weight (tonnes)


class RegistrationCreate(RegistrationBase):
    pass


class RegistrationUpdate(BaseModel):
    registration: Optional[str] = None
    aircraft_model: Optional[str] = None
    seats: Optional[int] = None
    dw_type: Optional[str] = None  # "Dry", "Wet", or None
    mtow: Optional[float] = None   # Maximum Take-Off Weight (tonnes)


class RegistrationOut(RegistrationBase):
    id: int
    model_config = {"from_attributes": True}


# ── Export / Report params ─────────────────────────────────────────────────────
class TimetableExportParams(BaseModel):
    mode: str = "daily"          # "daily" | "group"
    period_start: str            # YYYY-MM-DD
    period_end: str              # YYYY-MM-DD
    timezone: str = "LCT"        # "LCT" | "UTC"


class ReportParams(BaseModel):
    period_start: str
    period_end: str
    timezone: str = "LCT"
    sort_by: str = "aircraft"    # "aircraft" | "route"


class ImportPayload(BaseModel):
    version: str = "1.0"
    airports: List[AirportBase] = []
    aircraft: List[AircraftBase] = []
    sectors: List[FlightSectorBase] = []
    block_time_rules: List[BlockTimeRuleBase] = []
    tat_rules: List[TATRuleBase] = []
    replace_all: bool = False


# ── Season ─────────────────────────────────────────────────────────────────────
class SeasonBase(BaseModel):
    name: str
    season_type: str          # "summer" | "winter"
    year: int
    start_date: str           # YYYY-MM-DD
    end_date: str             # YYYY-MM-DD


class SeasonCreate(SeasonBase):
    pass


class SeasonOut(SeasonBase):
    id: int
    model_config = {"from_attributes": True}


# ── Maintenance block ──────────────────────────────────────────────────────────
class MaintenanceBase(BaseModel):
    aircraft_id: int
    label: str = "Maintenance"
    start_date: str           # YYYY-MM-DD
    end_date: str             # YYYY-MM-DD
    start_time: Optional[str] = None   # HH:MM UTC (None = full day)
    end_time: Optional[str] = None     # HH:MM UTC (None = full day)
    color: Optional[str] = "#f59e0b"


class MaintenanceCreate(MaintenanceBase):
    pass


class MaintenanceUpdate(BaseModel):
    label: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    color: Optional[str] = None


class MaintenanceOut(MaintenanceBase):
    id: int
    model_config = {"from_attributes": True}


# ── Audit log ──────────────────────────────────────────────────────────────────
class AuditLogOut(BaseModel):
    id: int
    timestamp: datetime
    username: str
    action: str
    entity: str
    entity_id: Optional[int] = None
    detail: Optional[str] = None
    model_config = {"from_attributes": True}


# ── Calendar notes ──────────────────────────────────────────────────────────────
class CalendarNoteBase(BaseModel):
    note_date: str               # YYYY-MM-DD (start date)
    note_end_date: Optional[str] = None  # YYYY-MM-DD (end date, None = single day)
    start_time: Optional[str] = None   # HH:MM
    end_time: Optional[str] = None     # HH:MM
    content: str
    color: Optional[str] = "#3b82f6"


class CalendarNoteCreate(CalendarNoteBase):
    pass


class CalendarNoteUpdate(BaseModel):
    note_date: Optional[str] = None
    note_end_date: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    content: Optional[str] = None
    color: Optional[str] = None


class CalendarNoteOut(CalendarNoteBase):
    id: int
    model_config = {"from_attributes": True}


# ── Route colors ───────────────────────────────────────────────────────────────
class RouteColorBase(BaseModel):
    origin: str
    destination: str
    color: str


class RouteColorCreate(RouteColorBase):
    pass


class RouteColorOut(RouteColorBase):
    id: int
    model_config = {"from_attributes": True}
