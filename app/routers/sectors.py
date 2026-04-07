from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session
from typing import List, Optional
from datetime import datetime, timedelta

from ..database import get_db
from ..models import FlightSector, BlockTimeRule, TATRule, Aircraft, Airport, AuditLog
from ..schemas import FlightSectorCreate, FlightSectorUpdate, FlightSectorOut, SwapAircraftPayload
from .auth import get_session

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
    sector = db.query(FlightSector).filter(FlightSector.id == sector_id).first()
    if not sector:
        raise HTTPException(404, "Sector not found")
    # Apply updates to determine final values for overlap check
    updates = payload.model_dump(exclude_none=True)
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
    sector = db.query(FlightSector).filter(FlightSector.id == sector_id).first()
    if not sector:
        raise HTTPException(404, "Sector not found")
    _audit(db, request, "DELETE", sector)
    db.delete(sector)
    db.commit()


@router.post("/{sector_id}/cancel", response_model=FlightSectorOut)
def cancel_sector(request: Request, sector_id: int, db: Session = Depends(get_db)):
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
    sector = db.query(FlightSector).filter(FlightSector.id == sector_id).first()
    if not sector:
        raise HTTPException(404, "Sector not found")
    sector.status = "active"
    db.commit()
    db.refresh(sector)
    _audit(db, request, "RESTORE", sector)
    return sector


# ── Swap aircraft lines ────────────────────────────────────────────────────────
@router.post("/swap-aircraft", status_code=200)
def swap_aircraft_sectors(request: Request, payload: SwapAircraftPayload, db: Session = Depends(get_db)):
    """Atomically swap all flight sectors between two aircraft.

    If payload.date is provided, only sectors on that date are swapped.
    Otherwise all dates are swapped.
    """
    ac_a = db.query(Aircraft).filter(Aircraft.id == payload.aircraft_a_id).first()
    ac_b = db.query(Aircraft).filter(Aircraft.id == payload.aircraft_b_id).first()
    if not ac_a or not ac_b:
        raise HTTPException(404, "One or both aircraft not found")
    if payload.aircraft_a_id == payload.aircraft_b_id:
        raise HTTPException(400, "Cannot swap aircraft with itself")

    # Fetch sectors for each aircraft
    q_a = db.query(FlightSector).filter(FlightSector.aircraft_id == payload.aircraft_a_id)
    q_b = db.query(FlightSector).filter(FlightSector.aircraft_id == payload.aircraft_b_id)
    if payload.date:
        q_a = q_a.filter(FlightSector.flight_date == payload.date)
        q_b = q_b.filter(FlightSector.flight_date == payload.date)

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
    date_str = payload.date or "all dates"
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
    # Build airport timezone lookup for domestic/intl classification
    airport_tz = {ap.code: ap.timezone_offset for ap in db.query(Airport).all()}

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

            # 2. TAT between consecutive sectors
            if i < len(sectors) - 1:
                next_s = sectors[i + 1]
                arr_min = time_to_minutes(s.arr_utc)
                dep_min = time_to_minutes(next_s.dep_utc)
                gap = dep_min - arr_min
                if gap < 0:
                    gap += 1440
                min_tat = tat_map.get(s.destination, None)
                if min_tat is None:
                    # Use mass TAT: domestic if tz == 7, else international
                    tz = airport_tz.get(s.destination, 0)
                    min_tat = default_tat_domestic if tz == 7 else default_tat_intl
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

        current_date_obj = datetime.strptime(date, "%Y-%m-%d")

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
                prev_date_obj = datetime.strptime(prev_sector.flight_date, "%Y-%m-%d")
                day_diff = (current_date_obj - prev_date_obj).days  # always >= 1

                # TAT gap: arrival on prev_date → departure on current date
                arr_min = time_to_minutes(prev_sector.arr_utc)
                dep_min = time_to_minutes(first_today.dep_utc)
                gap = (day_diff * 1440) - arr_min + dep_min

                min_tat = tat_map.get(prev_sector.destination, None)
                if min_tat is None:
                    tz = airport_tz.get(prev_sector.destination, 0)
                    min_tat = default_tat_domestic if tz == 7 else default_tat_intl

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
                next_date_obj = datetime.strptime(next_sector.flight_date, "%Y-%m-%d")
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
