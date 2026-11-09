from fastapi import APIRouter, Depends, HTTPException, Query, Request, UploadFile, File, Form
from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import ObjectDeletedError, StaleDataError
from typing import List, Optional
from datetime import datetime, timedelta
import io
import openpyxl

from ..database import get_db
from ..models import FlightSector, BlockTimeRule, TATRule, Aircraft, Airport, AuditLog
from ..schemas import FlightSectorCreate, FlightSectorUpdate, FlightSectorOut, SwapAircraftPayload, BulkCancelPayload
from .auth import get_session, require_mod_or_admin, require_editor
from .export import _read_sheet_indexed, _norm_time

router = APIRouter()


# ── helpers ────────────────────────────────────────────────────────────────────
def _audit(db: Session, request: Request, action: str, sector: FlightSector):
    sess = get_session(request)
    username = sess["username"] if sess else "system"
    detail = f"{sector.origin}→{sector.destination} {sector.flight_date} {sector.dep_utc}-{sector.arr_utc}"
    db.add(AuditLog(
        timestamp=datetime.utcnow(),
        username=username,
        action=action,
        entity="sector",
        entity_id=sector.id,
        detail=detail,
    ))
    db.commit()
def time_to_minutes(hhmm: str) -> int:
    h, m = map(int, hhmm.split(":"))
    return h * 60 + m


def _parse_date(value: str) -> datetime:
    """Parse a flight_date value into a datetime, tolerating legacy/malformed
    values (e.g. "2026-01-15 00:00:00" or "2026-01-15T00:00:00") that may have
    been stored by older/buggy import code instead of the expected plain
    "YYYY-MM-DD" string."""
    text = str(value).strip()
    if " " in text:
        text = text.split(" ")[0]
    if "T" in text:
        text = text.split("T")[0]
    return datetime.strptime(text, "%Y-%m-%d")


def block_time_minutes(dep: str, arr: str) -> int:
    d, a = time_to_minutes(dep), time_to_minutes(arr)
    if a < d:
        a += 1440  # overnight
    return a - d


def minutes_to_hhmm(m: int) -> str:
    m = m % 1440
    return f"{m // 60:02d}:{m % 60:02d}"


def _check_overlap(db: Session, aircraft_id: int, flight_date: str,
                   dep_utc: str, arr_utc: str, exclude_id: Optional[int] = None):
    """Raise HTTPException if the proposed sector overlaps any existing active
    sector on the same aircraft & date."""
    dep_min = time_to_minutes(dep_utc)
    arr_min = time_to_minutes(arr_utc)
    if arr_min <= dep_min:
        arr_min += 1440  # overnight

    existing = (
        db.query(FlightSector)
        .filter(
            FlightSector.aircraft_id == aircraft_id,
            FlightSector.flight_date == flight_date,
            FlightSector.status == "active",
        )
        .all()
    )
    for s in existing:
        if exclude_id and s.id == exclude_id:
            continue
        s_dep = time_to_minutes(s.dep_utc)
        s_arr = time_to_minutes(s.arr_utc)
        if s_arr <= s_dep:
            s_arr += 1440
        # Overlap check: two intervals [a,b) and [c,d) overlap iff a < d and c < b
        if dep_min < s_arr and s_dep < arr_min:
            raise HTTPException(
                409,
                f"Chặng bay bị trùng thời gian với {s.origin}→{s.destination} "
                f"({s.dep_utc}–{s.arr_utc}) trên cùng tàu bay."
            )


def add_tz(hhmm: str, offset_hours: float) -> str:
    mins = time_to_minutes(hhmm) + int(offset_hours * 60)
    return minutes_to_hhmm(mins)


# ── CRUD ───────────────────────────────────────────────────────────────────────
@router.get("/", response_model=List[FlightSectorOut])
def list_sectors(
    date: Optional[str] = Query(None),
    aircraft_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
):
    q = db.query(FlightSector)
    if date:
        q = q.filter(FlightSector.flight_date == date)
    if aircraft_id:
        q = q.filter(FlightSector.aircraft_id == aircraft_id)
    return q.order_by(FlightSector.aircraft_id, FlightSector.dep_utc).all()


@router.get("/period", response_model=List[FlightSectorOut])
def list_sectors_period(
    start: str = Query(...),
    end: str = Query(...),
    db: Session = Depends(get_db),
):
    return (
        db.query(FlightSector)
        .filter(FlightSector.flight_date >= start, FlightSector.flight_date <= end)
        .order_by(FlightSector.flight_date, FlightSector.aircraft_id, FlightSector.dep_utc)
        .all()
    )


@router.post("/", response_model=FlightSectorOut, status_code=201)
def create_sector(request: Request, payload: FlightSectorCreate, db: Session = Depends(get_db)):
    require_mod_or_admin(request)
    ac = db.query(Aircraft).filter(Aircraft.id == payload.aircraft_id).first()
    if not ac:
        raise HTTPException(404, "Aircraft not found")
    _check_overlap(db, payload.aircraft_id, payload.flight_date,
                   payload.dep_utc, payload.arr_utc)
    sector = FlightSector(**payload.model_dump())
    db.add(sector)
    db.commit()
    db.refresh(sector)
    _audit(db, request, "CREATE", sector)
    return sector


@router.put("/{sector_id}", response_model=FlightSectorOut)
def update_sector(request: Request, sector_id: int, payload: FlightSectorUpdate, db: Session = Depends(get_db)):
    require_editor(request)
    sector = db.query(FlightSector).filter(FlightSector.id == sector_id).first()
    if not sector:
        raise HTTPException(404, "Sector not found")
    # Apply updates to determine final values for overlap check
    # Use exclude_unset (not exclude_none) so explicit `null` values sent by the
    # client (e.g. color: null to reset to the aircraft's inherited color) are
    # still applied, while fields the client simply omitted stay untouched.
    updates = payload.model_dump(exclude_unset=True)
    ac_id = updates.get("aircraft_id", sector.aircraft_id)
    f_date = updates.get("flight_date", sector.flight_date)
    dep = updates.get("dep_utc", sector.dep_utc)
    arr = updates.get("arr_utc", sector.arr_utc)
    status = updates.get("status", sector.status)
    # Only check overlap for active sectors
    if status == "active" and dep and arr:
        _check_overlap(db, ac_id, f_date, dep, arr, exclude_id=sector_id)
    for field, value in updates.items():
        setattr(sector, field, value)
    db.commit()
    db.refresh(sector)
    _audit(db, request, "UPDATE", sector)
    return sector


@router.delete("/{sector_id}", status_code=204)
def delete_sector(request: Request, sector_id: int, db: Session = Depends(get_db)):
    require_editor(request)
    sector = db.query(FlightSector).filter(FlightSector.id == sector_id).first()
    if not sector:
        raise HTTPException(404, "Sector not found")
    _audit(db, request, "DELETE", sector)
    try:
        db.delete(sector)
        db.commit()
    except (ObjectDeletedError, StaleDataError):
        # The row was already deleted by a concurrent request (e.g. a
        # double-click on "Xoá lịch" firing two delete calls for the same
        # sector, or a slow request retried by the browser). Treat this as a
        # no-op success instead of a 500 — the end result (row gone) is the
        # same either way.
        db.rollback()


@router.post("/{sector_id}/cancel", response_model=FlightSectorOut)
def cancel_sector(request: Request, sector_id: int, db: Session = Depends(get_db)):
    require_editor(request)
    sector = db.query(FlightSector).filter(FlightSector.id == sector_id).first()
    if not sector:
        raise HTTPException(404, "Sector not found")
    sector.status = "cancelled"
    db.commit()
    db.refresh(sector)
    _audit(db, request, "CANCEL", sector)
    return sector


@router.post("/{sector_id}/restore", response_model=FlightSectorOut)
def restore_sector(request: Request, sector_id: int, db: Session = Depends(get_db)):
    require_editor(request)
    sector = db.query(FlightSector).filter(FlightSector.id == sector_id).first()
    if not sector:
        raise HTTPException(404, "Sector not found")
    sector.status = "active"
    db.commit()
    db.refresh(sector)
    _audit(db, request, "RESTORE", sector)
    return sector


@router.post("/bulk-cancel")
def bulk_cancel_sectors(request: Request, payload: BulkCancelPayload, db: Session = Depends(get_db)):
    """Cancel multiple sectors at once."""
    require_editor(request)
    sectors = db.query(FlightSector).filter(FlightSector.id.in_(payload.sector_ids)).all()
    results = []
    for sector in sectors:
        sector.status = "cancelled"
        results.append(sector.id)
    db.commit()
    for sector in sectors:
        _audit(db, request, "CANCEL", sector)
    return {"ok": True, "cancelled": results}


@router.post("/bulk-restore")
def bulk_restore_sectors(request: Request, payload: BulkCancelPayload, db: Session = Depends(get_db)):
    """Restore multiple cancelled sectors at once."""
    require_editor(request)
    sectors = db.query(FlightSector).filter(FlightSector.id.in_(payload.sector_ids)).all()
    results = []
    for sector in sectors:
        sector.status = "active"
        results.append(sector.id)
    db.commit()
    for sector in sectors:
        _audit(db, request, "RESTORE", sector)
    return {"ok": True, "restored": results}


# ── Swap aircraft lines ────────────────────────────────────────────────────────
@router.post("/swap-aircraft", status_code=200)
def swap_aircraft_sectors(request: Request, payload: SwapAircraftPayload, db: Session = Depends(get_db)):
    """Atomically swap all flight sectors between two aircraft.

    If payload.date is provided, only sectors on that date are swapped.
    If payload.start_date and end_date are provided, swap date range.
    Otherwise all dates are swapped.
    """
    require_editor(request)
    ac_a = db.query(Aircraft).filter(Aircraft.id == payload.aircraft_a_id).first()
    ac_b = db.query(Aircraft).filter(Aircraft.id == payload.aircraft_b_id).first()
    if not ac_a or not ac_b:
        raise HTTPException(404, "One or both aircraft not found")
    if payload.aircraft_a_id == payload.aircraft_b_id:
        raise HTTPException(400, "Cannot swap aircraft with itself")

    # Fetch sectors for each aircraft
    q_a = db.query(FlightSector).filter(FlightSector.aircraft_id == payload.aircraft_a_id)
    q_b = db.query(FlightSector).filter(FlightSector.aircraft_id == payload.aircraft_b_id)
    
    # Apply date filter
    date_str = "all dates"
    if payload.date:
        q_a = q_a.filter(FlightSector.flight_date == payload.date)
        q_b = q_b.filter(FlightSector.flight_date == payload.date)
        date_str = payload.date
    elif payload.start_date and payload.end_date:
        q_a = q_a.filter(FlightSector.flight_date >= payload.start_date, FlightSector.flight_date <= payload.end_date)
        q_b = q_b.filter(FlightSector.flight_date >= payload.start_date, FlightSector.flight_date <= payload.end_date)
        date_str = f"{payload.start_date} to {payload.end_date}"

    sectors_a = q_a.all()
    sectors_b = q_b.all()

    # Use sentinel=-1 to avoid unique constraint clashes during swap
    for s in sectors_a:
        s.aircraft_id = -1  # type: ignore[assignment]
    db.flush()

    for s in sectors_b:
        s.aircraft_id = payload.aircraft_a_id  # type: ignore[assignment]
    db.flush()

    for s in sectors_a:
        s.aircraft_id = payload.aircraft_b_id  # type: ignore[assignment]
    db.commit()

    # Audit
    sess = get_session(request)
    username = sess["username"] if sess else "system"
    db.add(AuditLog(
        timestamp=datetime.utcnow(),
        username=username,
        action="SWAP",
        entity="aircraft",
        entity_id=payload.aircraft_a_id,
        detail=(
            f"Swap lines: {ac_a.registration} ↔ {ac_b.registration} "
            f"({len(sectors_a)} + {len(sectors_b)} sectors, {date_str})"
        ),
    ))
    db.commit()

    return {
        "swapped_a": len(sectors_a),
        "swapped_b": len(sectors_b),
        "aircraft_a": ac_a.registration,
        "aircraft_b": ac_b.registration,
    }


# ── Clear sector colors for an aircraft ────────────────────────────────────────
@router.post("/clear-colors/aircraft/{ac_id}", status_code=200)
def clear_sector_colors(request: Request, ac_id: int, db: Session = Depends(get_db)):
    """Set color=NULL on all sectors of the given aircraft so they inherit ac color dynamically."""
    require_editor(request)
    db.query(FlightSector).filter(FlightSector.aircraft_id == ac_id).update({"color": None})
    db.commit()
    return {"ok": True}


# ── Warnings ───────────────────────────────────────────────────────────────────
@router.get("/warnings")
def get_warnings(
    date: str = Query(...),
    db: Session = Depends(get_db),
):
    """Return list of warnings for all aircraft on the given date."""
    warnings = []

    # Load reference rules
    bt_rules = {
        f"{r.origin}-{r.destination}": r.block_time_minutes
        for r in db.query(BlockTimeRule).all()
    }
    tat_map = {r.station: r.min_tat_minutes for r in db.query(TATRule).all()}
    # Mass TAT defaults
    default_tat_domestic = tat_map.pop("__DOMESTIC__", 40)
    default_tat_intl = tat_map.pop("__INTL__", 60)
    default_tat_dom_to_intl = tat_map.pop("__DOM_TO_INTL__", 60)
    default_tat_intl_to_dom = tat_map.pop("__INTL_TO_DOM__", 60)
    # Build airport timezone lookup for domestic/intl classification
    airport_tz = {ap.code: ap.timezone_offset for ap in db.query(Airport).all()}
    airport_dom = {ap.code: bool(ap.is_domestic) for ap in db.query(Airport).all()}

    def _get_tat(station: str, prev_origin, prev_dest,
                 next_origin, next_dest) -> int:
        """Get required TAT (minutes) with transition support.
        Transition TAT (DOM→INTL or INTL→DOM) takes priority over station-specific rules,
        because the type change requires a different handling regardless of the station.
        Unknown airports default to domestic to avoid false positives.
        """
        def is_dom(code):
            if not code:
                return True  # assume domestic if unknown
            return airport_dom.get(code, True)  # default domestic

        # Check transition first: inbound leg is domestic only if BOTH endpoints are domestic
        if prev_origin and prev_dest and next_origin and next_dest:
            inbound_dom  = is_dom(prev_origin) and is_dom(prev_dest)
            outbound_dom = is_dom(next_origin) and is_dom(next_dest)
            if inbound_dom != outbound_dom:
                return default_tat_dom_to_intl if (inbound_dom and not outbound_dom) else default_tat_intl_to_dom
        # Station-specific rule
        if station in tat_map:
            return tat_map[station]
        # Fallback: station-based domestic/intl default
        is_domestic = is_dom(station)
        return default_tat_domestic if is_domestic else default_tat_intl
    # Build curfew lookup: {code: (open, close)} — only airports with curfew set
    airport_curfew = {}
    for ap in db.query(Airport).all():
        if ap.curfew_open and ap.curfew_close:
            airport_curfew[ap.code] = (ap.curfew_open, ap.curfew_close)

    aircraft_list = db.query(Aircraft).order_by(Aircraft.line_order).all()

    for ac in aircraft_list:
        # Active sectors for this date, sorted by departure
        sectors = (
            db.query(FlightSector)
            .filter(
                FlightSector.aircraft_id == ac.id,
                FlightSector.flight_date == date,
                FlightSector.status == "active",
            )
            .order_by(FlightSector.dep_utc)
            .all()
        )

        for i, s in enumerate(sectors):
            key = f"{s.origin}-{s.destination}"
            actual_bt = block_time_minutes(s.dep_utc, s.arr_utc)

            # 1. Block-time mismatch
            if key in bt_rules:
                expected = bt_rules[key]
                diff = actual_bt - expected
                if abs(diff) > 0:
                    direction = "longer" if diff > 0 else "shorter"
                    warnings.append({
                        "type": "BLOCK_TIME",
                        "severity": "warning",
                        "sector_id": s.id,
                        "aircraft": ac.registration,
                        "message": (
                            f"{ac.registration} | {s.origin}→{s.destination} "
                            f"({s.dep_utc}-{s.arr_utc}): block time {abs(diff)} min "
                            f"{direction} than planned ({actual_bt} vs {expected} min)"
                        ),
                    })

            # 1b. Curfew check — departure at origin
            if s.origin in airport_curfew:
                curfew_open, curfew_close = airport_curfew[s.origin]
                dep_min = time_to_minutes(s.dep_utc)
                tz_offset = airport_tz.get(s.origin, 0)
                dep_local = (dep_min + int(tz_offset * 60)) % 1440
                c_open = time_to_minutes(curfew_open)
                c_close = time_to_minutes(curfew_close)
                # Check if departure is outside operating hours
                if c_open <= c_close:
                    outside = dep_local < c_open or dep_local >= c_close
                else:
                    outside = dep_local >= c_close and dep_local < c_open
                if outside:
                    dep_local_str = f"{dep_local // 60:02d}:{dep_local % 60:02d}"
                    warnings.append({
                        "type": "CURFEW",
                        "severity": "warning",
                        "sector_id": s.id,
                        "aircraft": ac.registration,
                        "message": (
                            f"{ac.registration} | Curfew {s.origin}: cất cánh lúc "
                            f"{dep_local_str} LCT ngoài giờ mở cửa "
                            f"{curfew_open}–{curfew_close}"
                        ),
                    })

            # 1c. Curfew check — arrival at destination
            if s.destination in airport_curfew:
                curfew_open, curfew_close = airport_curfew[s.destination]
                arr_min = time_to_minutes(s.arr_utc)
                tz_offset = airport_tz.get(s.destination, 0)
                arr_local = (arr_min + int(tz_offset * 60)) % 1440
                c_open = time_to_minutes(curfew_open)
                c_close = time_to_minutes(curfew_close)
                if c_open <= c_close:
                    outside = arr_local < c_open or arr_local >= c_close
                else:
                    outside = arr_local >= c_close and arr_local < c_open
                if outside:
                    arr_local_str = f"{arr_local // 60:02d}:{arr_local % 60:02d}"
                    warnings.append({
                        "type": "CURFEW",
                        "severity": "warning",
                        "sector_id": s.id,
                        "aircraft": ac.registration,
                        "message": (
                            f"{ac.registration} | Curfew {s.destination}: hạ cánh lúc "
                            f"{arr_local_str} LCT ngoài giờ mở cửa "
                            f"{curfew_open}–{curfew_close}"
                        ),
                    })

            # 2. TAT between consecutive sectors
            if i < len(sectors) - 1:
                next_s = sectors[i + 1]
                arr_min = time_to_minutes(s.arr_utc)
                dep_min = time_to_minutes(next_s.dep_utc)
                gap = dep_min - arr_min
                if gap < 0:
                    gap += 1440
                min_tat = _get_tat(s.destination, s.origin, s.destination,
                                   next_s.origin, next_s.destination)
                if gap < min_tat:
                    warnings.append({
                        "type": "TAT",
                        "severity": "error",
                        "sector_id": s.id,
                        "next_sector_id": next_s.id,
                        "aircraft": ac.registration,
                        "message": (
                            f"{ac.registration} | TAT at {s.destination} is {gap} min "
                            f"(minimum {min_tat} min) between "
                            f"{s.origin}→{s.destination} (arr {s.arr_utc}) "
                            f"and {next_s.origin}→{next_s.destination} (dep {next_s.dep_utc})"
                        ),
                    })

                # 3. Base mismatch: prev sector destination ≠ next sector origin
                if s.destination != next_s.origin:
                    warnings.append({
                        "type": "BASE_MISMATCH",
                        "severity": "warning",
                        "sector_id": s.id,
                        "next_sector_id": next_s.id,
                        "aircraft": ac.registration,
                        "message": (
                            f"{ac.registration} | Base mismatch: chặng {s.origin}→{s.destination} "
                            f"(arr {s.destination}) nhưng chặng tiếp theo xuất phát từ {next_s.origin}"
                        ),
                    })

        # ── Cross-day checks ──────────────────────────────────────────────
        # Find the most recent previous sector (any date before today)
        # and the earliest next sector (any date after today) for this aircraft.
        # This handles gaps of 2+ days between sectors.

        current_date_obj = _parse_date(date)

        if sectors:
            # --- Previous sector → today's first sector ---
            prev_sector = (
                db.query(FlightSector)
                .filter(
                    FlightSector.aircraft_id == ac.id,
                    FlightSector.flight_date < date,
                    FlightSector.status == "active",
                )
                .order_by(FlightSector.flight_date.desc(), FlightSector.arr_utc.desc())
                .first()
            )

            if prev_sector:
                first_today = sectors[0]
                prev_date_obj = _parse_date(prev_sector.flight_date)
                day_diff = (current_date_obj - prev_date_obj).days  # always >= 1

                # TAT gap: arrival on prev_date → departure on current date
                arr_min = time_to_minutes(prev_sector.arr_utc)
                dep_min = time_to_minutes(first_today.dep_utc)
                gap = (day_diff * 1440) - arr_min + dep_min

                min_tat = _get_tat(prev_sector.destination, prev_sector.origin, prev_sector.destination,
                                   first_today.origin, first_today.destination)

                if gap < min_tat:
                    warnings.append({
                        "type": "TAT",
                        "severity": "error",
                        "sector_id": prev_sector.id,
                        "next_sector_id": first_today.id,
                        "aircraft": ac.registration,
                        "message": (
                            f"{ac.registration} | TAT at {prev_sector.destination} is {gap} min "
                            f"(minimum {min_tat} min) between "
                            f"{prev_sector.origin}→{prev_sector.destination} "
                            f"({prev_sector.flight_date} arr {prev_sector.arr_utc}) "
                            f"and {first_today.origin}→{first_today.destination} "
                            f"({first_today.flight_date} dep {first_today.dep_utc})"
                        ),
                    })

                # Base mismatch: prev destination ≠ today's first origin
                if prev_sector.destination != first_today.origin:
                    warnings.append({
                        "type": "CONTINUITY",
                        "severity": "error",
                        "sector_id": prev_sector.id,
                        "next_sector_id": first_today.id,
                        "aircraft": ac.registration,
                        "message": (
                            f"{ac.registration} | Continuity break: {prev_sector.flight_date} "
                            f"ends at {prev_sector.destination} but {date} starts from "
                            f"{first_today.origin}"
                        ),
                    })

            # --- Today's last sector → next future sector ---
            next_sector = (
                db.query(FlightSector)
                .filter(
                    FlightSector.aircraft_id == ac.id,
                    FlightSector.flight_date > date,
                    FlightSector.status == "active",
                )
                .order_by(FlightSector.flight_date.asc(), FlightSector.dep_utc.asc())
                .first()
            )

            if next_sector:
                last_today = sectors[-1]
                next_date_obj = _parse_date(next_sector.flight_date)
                day_diff = (next_date_obj - current_date_obj).days  # always >= 1

                # Base mismatch: today's last destination ≠ next sector origin
                if last_today.destination != next_sector.origin:
                    warnings.append({
                        "type": "CONTINUITY",
                        "severity": "error",
                        "sector_id": last_today.id,
                        "next_sector_id": next_sector.id,
                        "aircraft": ac.registration,
                        "message": (
                            f"{ac.registration} | Continuity break: {date} ends at "
                            f"{last_today.destination} but {next_sector.flight_date} "
                            f"starts from {next_sector.origin}"
                        ),
                    })

    # ── Duplicate flight number check (across ALL aircraft on this date) ─────
    all_day_sectors = (
        db.query(FlightSector)
        .filter(
            FlightSector.flight_date == date,
            FlightSector.status == "active",
            FlightSector.flight_number.isnot(None),
            FlightSector.flight_number != "",
        )
        .all()
    )
    ac_map = {ac.id: ac.registration for ac in aircraft_list}
    fn_groups: dict = {}
    for s in all_day_sectors:
        fn_groups.setdefault(s.flight_number, []).append(s)
    for fn, group in fn_groups.items():
        if len(group) > 1:
            for s in group:
                others = [
                    f"{ac_map.get(o.aircraft_id, '?')} {o.origin}→{o.destination} {o.dep_utc}"
                    for o in group if o.id != s.id
                ]
                warnings.append({
                    "type": "DUPLICATE_FN",
                    "severity": "warning",
                    "sector_id": s.id,
                    "aircraft": ac_map.get(s.aircraft_id, "?"),
                    "message": (
                        f"{ac_map.get(s.aircraft_id, '?')} | Số hiệu {fn} trùng trong ngày {date}: "
                        + ", ".join(others)
                    ),
                })

    return {"date": date, "warnings": warnings}


# ── Import sectors from Excel template + date range / day-of-week pattern ──────
#
# Template columns (header row required, order flexible, Vietnamese/English
# header names both accepted):
#   Tail (registration) | From (origin) | To (destination) | Dep UTC | Arr UTC
#   | Flight No. | Day (digits 1-7, Monday=1 ... Sunday=7, e.g. "1357" means
#   the flight operates on Mon/Wed/Fri/Sun)
#
# For each row, a FlightSector is created on every date within
# [start_date, end_date] whose ISO weekday (Monday=1...Sunday=7, matching the
# convention already used for day_of_week in export.py) matches one of the
# digits in the row's "Day" column. Existing identical sectors (same
# aircraft/date/origin/destination/dep_utc) are skipped to avoid duplicates.

_IMPORT_PATTERN_HEADER_ALIASES = {
    "tail": "tail", "registration": "tail", "tau": "tail", "tàu": "tail", "số đăng bạ": "tail",
    "from": "from", "origin": "from", "điểm đi": "from",
    "to": "to", "destination": "to", "điểm đến": "to",
    "dep utc": "dep_utc", "dep_utc": "dep_utc", "giờ đi utc": "dep_utc", "gio di utc": "dep_utc",
    "arr utc": "arr_utc", "arr_utc": "arr_utc", "giờ đến utc": "arr_utc", "gio den utc": "arr_utc",
    "flight no.": "flight_no", "flight no": "flight_no", "flight_number": "flight_no",
    "số hiệu": "flight_no", "so hieu": "flight_no",
    "day": "day", "ngày": "day", "ngay": "day", "day of week": "day", "thứ": "day",
}


def _map_import_pattern_row(raw_row: dict) -> dict:
    """Normalize a raw Excel row dict (arbitrary header text) into the fixed
    keys: tail, from, to, dep_utc, arr_utc, flight_no, day."""
    mapped = {}
    for header, value in raw_row.items():
        key = _IMPORT_PATTERN_HEADER_ALIASES.get(str(header).strip().lower())
        if key:
            mapped[key] = value
    return mapped


@router.post("/import-pattern")
async def import_sectors_pattern(
    request: Request,
    file: UploadFile = File(...),
    start_date: str = Form(...),
    end_date: str = Form(...),
    db: Session = Depends(get_db),
):
    """Import flight sectors from an Excel template, expanded across every
    date in [start_date, end_date] whose weekday matches the row's "Day"
    pattern (e.g. "1357" = Mon/Wed/Fri/Sun)."""
    require_mod_or_admin(request)

    if not start_date or not end_date or end_date < start_date:
        raise HTTPException(400, "Khoảng ngày không hợp lệ")

    content = await file.read()
    try:
        wb = openpyxl.load_workbook(io.BytesIO(content), data_only=True)
    except Exception as e:
        raise HTTPException(400, f"Không đọc được file Excel: {e}")

    # Read first sheet regardless of its name (template has no fixed sheet title requirement)
    sheet_title = wb.sheetnames[0] if wb.sheetnames else None
    raw_rows = _read_sheet_indexed(wb, sheet_title) if sheet_title else []
    if not raw_rows:
        raise HTTPException(400, "File Excel không có dữ liệu")

    # Registration (tail number) -> aircraft_id lookup
    aircraft_id_by_reg = {
        a.registration.upper(): a.id
        for a in db.query(Aircraft).all()
        if a.registration
    }

    # Build the list of dates in range
    start_dt = datetime.strptime(start_date, "%Y-%m-%d")
    end_dt = datetime.strptime(end_date, "%Y-%m-%d")
    all_dates = []
    d = start_dt
    while d <= end_dt:
        all_dates.append(d)
        d += timedelta(days=1)

    created = 0
    skipped = 0
    errors = []

    for row_num, raw_row in raw_rows:
        try:
            row = _map_import_pattern_row(raw_row)

            tail_val   = row.get("tail")
            from_val   = row.get("from")
            to_val     = row.get("to")
            dep_val    = row.get("dep_utc")
            arr_val    = row.get("arr_utc")
            fn_val     = row.get("flight_no")
            day_val    = row.get("day")

            missing = [name for name, v in [
                ("Tail", tail_val), ("From", from_val), ("To", to_val),
                ("Dep UTC", dep_val), ("Arr UTC", arr_val), ("Day", day_val),
            ] if v in (None, "")]
            if missing:
                raise ValueError(f"Thiếu dữ liệu bắt buộc: {', '.join(missing)}")

            tail = str(tail_val).upper().strip()
            ac_id = aircraft_id_by_reg.get(tail)
            if ac_id is None:
                raise ValueError(f"Không tìm thấy tàu bay có số đăng bạ '{tail_val}'")

            origin = str(from_val).upper().strip()
            destination = str(to_val).upper().strip()
            dep_utc = _norm_time(dep_val)
            arr_utc = _norm_time(arr_val)
            if not dep_utc or not arr_utc:
                raise ValueError("Giờ đi/giờ đến không hợp lệ (định dạng HH:MM)")

            # Parse day-of-week digits (1=Mon...7=Sun), e.g. "1357" -> {1,3,5,7}
            day_digits = {int(ch) for ch in str(day_val).strip() if ch in "1234567"}
            if not day_digits:
                raise ValueError(f"Cột Day không hợp lệ: '{day_val}' (dùng chữ số 1-7, 1=Thứ 2...7=Chủ nhật)")

            flight_number = str(fn_val).strip() if fn_val not in (None, "") else None

            row_created = 0
            row_skipped = 0
            for dt in all_dates:
                if dt.isoweekday() not in day_digits:
                    continue
                flight_date = dt.strftime("%Y-%m-%d")

                dup = db.query(FlightSector).filter(
                    FlightSector.aircraft_id == ac_id,
                    FlightSector.flight_date == flight_date,
                    FlightSector.origin == origin,
                    FlightSector.destination == destination,
                    FlightSector.dep_utc == dep_utc,
                ).first()
                if dup:
                    row_skipped += 1
                    continue

                db.add(FlightSector(
                    aircraft_id=ac_id,
                    flight_date=flight_date,
                    origin=origin,
                    destination=destination,
                    dep_utc=dep_utc,
                    arr_utc=arr_utc,
                    flight_number=flight_number,
                    status="active",
                    sequence=0,
                    service_code="J",
                ))
                row_created += 1

            created += row_created
            skipped += row_skipped
        except Exception as e:
            errors.append({"row": row_num, "error": str(e)})

    db.commit()

    return {
        "ok": True,
        "created": created,
        "skipped": skipped,
        "errors": errors,
    }
