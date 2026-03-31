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
    for field, value in payload.model_dump(exclude_none=True).items():
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

        # 3. Overnight continuity – compare with next day's first sector
        try:
            next_date = (datetime.strptime(date, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
        except ValueError:
            continue

        next_day_sectors = (
            db.query(FlightSector)
            .filter(
                FlightSector.aircraft_id == ac.id,
                FlightSector.flight_date == next_date,
                FlightSector.status == "active",
            )
            .order_by(FlightSector.dep_utc)
            .all()
        )

        if sectors and next_day_sectors:
            last_dest = sectors[-1].destination
            next_origin = next_day_sectors[0].origin
            if last_dest != next_origin:
                warnings.append({
                    "type": "CONTINUITY",
                    "severity": "error",
                    "sector_id": sectors[-1].id,
                    "next_sector_id": next_day_sectors[0].id,
                    "aircraft": ac.registration,
                    "message": (
                        f"{ac.registration} | Continuity break: Day {date} ends at "
                        f"{last_dest} but Day {next_date} starts from {next_origin}"
                    ),
                })

    return {"date": date, "warnings": warnings}
