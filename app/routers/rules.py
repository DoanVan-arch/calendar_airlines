from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from typing import List
import csv
import io
import datetime
import openpyxl

from ..database import get_db
from ..models import TATRule, BlockTimeRule, Airport, Registration, RouteColor, AppSetting, RosterRule, ServiceCode
from ..schemas import (
    TATRuleCreate, TATRuleOut,
    BlockTimeRuleCreate, BlockTimeRuleOut,
    AirportCreate, AirportOut,
    RegistrationCreate, RegistrationUpdate, RegistrationOut,
    RouteColorCreate, RouteColorOut,
    RosterRuleCreate, RosterRuleOut,
    ServiceCodeCreate, ServiceCodeOut,
)
from .auth import require_editor

router = APIRouter()


# ── Airports ───────────────────────────────────────────────────────────────────
@router.get("/airports", response_model=List[AirportOut])
def list_airports(db: Session = Depends(get_db)):
    return db.query(Airport).order_by(Airport.code).all()


@router.post("/airports", response_model=AirportOut, status_code=201)
def create_airport(request: Request, payload: AirportCreate, db: Session = Depends(get_db)):
    require_editor(request)
    existing = db.query(Airport).filter(Airport.code == payload.code.upper()).first()
    if existing:
        raise HTTPException(400, f"Airport '{payload.code}' already exists")
    ap = Airport(code=payload.code.upper(), name=payload.name,
                 timezone_offset=payload.timezone_offset,
                 curfew_open=payload.curfew_open, curfew_close=payload.curfew_close)
    db.add(ap)
    db.commit()
    db.refresh(ap)
    return ap


@router.put("/airports/{code}", response_model=AirportOut)
def update_airport(request: Request, code: str, payload: AirportCreate, db: Session = Depends(get_db)):
    require_editor(request)
    ap = db.query(Airport).filter(Airport.code == code.upper()).first()
    if not ap:
        raise HTTPException(404, "Airport not found")
    ap.name = payload.name
    ap.timezone_offset = payload.timezone_offset
    ap.is_domestic = payload.is_domestic
    ap.curfew_open = payload.curfew_open
    ap.curfew_close = payload.curfew_close
    db.commit()
    db.refresh(ap)
    return ap


@router.delete("/airports/{code}", status_code=204)
def delete_airport(request: Request, code: str, db: Session = Depends(get_db)):
    require_editor(request)
    ap = db.query(Airport).filter(Airport.code == code.upper()).first()
    if not ap:
        raise HTTPException(404, "Airport not found")
    db.delete(ap)
    db.commit()


# ── TAT Rules ──────────────────────────────────────────────────────────────────
MASS_TAT_STATIONS = {"__DOMESTIC__", "__INTL__", "__DOM_TO_INTL__", "__INTL_TO_DOM__"}


@router.get("/tat", response_model=List[TATRuleOut])
def list_tat_rules(db: Session = Depends(get_db)):
    return db.query(TATRule).filter(TATRule.station.notin_(MASS_TAT_STATIONS)).order_by(TATRule.station).all()


@router.get("/tat/mass")
def get_mass_tat(db: Session = Depends(get_db)):
    """Return the mass (default) TAT rules for domestic, international, and transitions."""
    dom = db.query(TATRule).filter(TATRule.station == "__DOMESTIC__").first()
    intl = db.query(TATRule).filter(TATRule.station == "__INTL__").first()
    d2i = db.query(TATRule).filter(TATRule.station == "__DOM_TO_INTL__").first()
    i2d = db.query(TATRule).filter(TATRule.station == "__INTL_TO_DOM__").first()
    return {
        "domestic": dom.min_tat_minutes if dom else 40,
        "international": intl.min_tat_minutes if intl else 60,
        "dom_to_intl": d2i.min_tat_minutes if d2i else 60,
        "intl_to_dom": i2d.min_tat_minutes if i2d else 60,
    }


@router.put("/tat/mass")
def set_mass_tat(request: Request, payload: dict, db: Session = Depends(get_db)):
    """Save mass TAT defaults. Expects {domestic: int, international: int, dom_to_intl: int, intl_to_dom: int}."""
    require_editor(request)
    for key, station in [("domestic", "__DOMESTIC__"), ("international", "__INTL__"),
                         ("dom_to_intl", "__DOM_TO_INTL__"), ("intl_to_dom", "__INTL_TO_DOM__")]:
        minutes = payload.get(key)
        if minutes is None:
            continue
        existing = db.query(TATRule).filter(TATRule.station == station).first()
        if existing:
            existing.min_tat_minutes = int(minutes)
        else:
            db.add(TATRule(station=station, min_tat_minutes=int(minutes)))
    db.commit()
    return {"ok": True}


@router.post("/tat", response_model=TATRuleOut, status_code=201)
def create_tat_rule(request: Request, payload: TATRuleCreate, db: Session = Depends(get_db)):
    require_editor(request)
    existing = db.query(TATRule).filter(TATRule.station == payload.station.upper()).first()
    if existing:
        existing.min_tat_minutes = payload.min_tat_minutes
        existing.is_domestic = payload.is_domestic
        db.commit()
        db.refresh(existing)
        return existing
    rule = TATRule(
        station=payload.station.upper(),
        min_tat_minutes=payload.min_tat_minutes,
        is_domestic=payload.is_domestic,
    )
    db.add(rule)
    db.commit()
    db.refresh(rule)
    return rule


@router.put("/tat/{rule_id}", response_model=TATRuleOut)
def update_tat_rule(request: Request, rule_id: int, payload: TATRuleCreate, db: Session = Depends(get_db)):
    require_editor(request)
    rule = db.query(TATRule).filter(TATRule.id == rule_id).first()
    if not rule:
        raise HTTPException(404, "TAT rule not found")
    rule.station = payload.station.upper()
    rule.min_tat_minutes = payload.min_tat_minutes
    rule.is_domestic = payload.is_domestic
    db.commit()
    db.refresh(rule)
    return rule


@router.delete("/tat/{rule_id}", status_code=204)
def delete_tat_rule(request: Request, rule_id: int, db: Session = Depends(get_db)):
    require_editor(request)
    rule = db.query(TATRule).filter(TATRule.id == rule_id).first()
    if not rule:
        raise HTTPException(404, "TAT rule not found")
    db.delete(rule)
    db.commit()


# ── Block-time Rules ───────────────────────────────────────────────────────────
@router.get("/blocktime", response_model=List[BlockTimeRuleOut])
def list_block_time_rules(db: Session = Depends(get_db)):
    return db.query(BlockTimeRule).order_by(BlockTimeRule.origin, BlockTimeRule.destination).all()


@router.post("/blocktime", response_model=BlockTimeRuleOut, status_code=201)
def create_block_time_rule(request: Request, payload: BlockTimeRuleCreate, db: Session = Depends(get_db)):
    require_editor(request)
    orig = payload.origin.upper()
    dest = payload.destination.upper()
    existing = db.query(BlockTimeRule).filter(
        BlockTimeRule.origin == orig, BlockTimeRule.destination == dest
    ).first()
    if existing:
        raise HTTPException(409, f"Block time rule {orig}-{dest} đã tồn tại. Vui lòng sửa thay vì tạo mới.")
    rule = BlockTimeRule(origin=orig, destination=dest, block_time_minutes=payload.block_time_minutes, ats=payload.ats, distance_km=payload.distance_km)
    db.add(rule)
    db.commit()
    db.refresh(rule)
    return rule


@router.put("/blocktime/{rule_id}", response_model=BlockTimeRuleOut)
def update_block_time_rule(request: Request, rule_id: int, payload: BlockTimeRuleCreate, db: Session = Depends(get_db)):
    require_editor(request)
    rule = db.query(BlockTimeRule).filter(BlockTimeRule.id == rule_id).first()
    if not rule:
        raise HTTPException(404, "Block-time rule not found")
    orig = payload.origin.upper()
    dest = payload.destination.upper()
    # Check for duplicate: another rule with same origin-dest (different id)
    dup = db.query(BlockTimeRule).filter(
        BlockTimeRule.origin == orig,
        BlockTimeRule.destination == dest,
        BlockTimeRule.id != rule_id,
    ).first()
    if dup:
        raise HTTPException(409, f"Block time rule {orig}-{dest} đã tồn tại (ID {dup.id})")
    rule.origin = orig
    rule.destination = dest
    rule.block_time_minutes = payload.block_time_minutes
    rule.ats = payload.ats
    rule.distance_km = payload.distance_km
    db.commit()
    db.refresh(rule)
    return rule


@router.delete("/blocktime/{rule_id}", status_code=204)
def delete_block_time_rule(request: Request, rule_id: int, db: Session = Depends(get_db)):
    require_editor(request)
    rule = db.query(BlockTimeRule).filter(BlockTimeRule.id == rule_id).first()
    if not rule:
        raise HTTPException(404, "Block-time rule not found")
    db.delete(rule)
    db.commit()


# ── Excel Export/Import ────────────────────────────────────────────────────────
def minutes_to_hhmm(minutes: int) -> str:
    h = minutes // 60
    m = minutes % 60
    return f"{h:02d}:{m:02d}"


def minutes_to_decimal(minutes: int) -> str:
    h = minutes // 60
    frac = round((minutes % 60) / 60 * 100)
    return f"{h:02d}.{frac:02d}"


def hhmm_to_minutes(value) -> int:
    """Convert various representations of a time duration to total minutes.

    openpyxl may return a cell value as:
      - str  "01:30"  → 90 min
      - datetime.time  → hours*60 + minutes
      - float (Excel serial fraction of a day, e.g. 0.0625 = 1h30m) → *1440
    """
    if value is None or (isinstance(value, str) and not value.strip()):
        raise ValueError("Giá trị thời gian bị trống")
    if isinstance(value, datetime.time):
        return value.hour * 60 + value.minute
    if isinstance(value, (int, float)):
        # Excel stores time as fraction of 24h
        total_minutes = round(float(value) * 24 * 60)
        return total_minutes
    # fallback: treat as "HH:MM" string
    text = str(value).strip()
    parts = text.replace(",", ":").split(":")
    if len(parts) < 2 or not parts[0].strip().lstrip("-").isdigit() or not parts[1].strip().isdigit():
        raise ValueError(f"Định dạng thời gian không hợp lệ: '{value}' (yêu cầu HH:MM)")
    return int(parts[0]) * 60 + int(parts[1])


def _find_import_sheet(wb, preferred_title: str):
    """Prefer the sheet matching the export's title, but fall back to the
    active sheet so files saved/renamed by Excel still work."""
    if preferred_title in wb.sheetnames:
        return wb[preferred_title]
    return wb.active


def _header_index_map(ws) -> dict:
    """Map header text (stripped) -> column index, read from the first row.

    This makes import resilient to the user inserting/reordering/removing
    columns when manually editing the exported file.
    """
    header_row = next(ws.iter_rows(min_row=1, max_row=1, values_only=True), ())
    return {
        str(h).strip(): i
        for i, h in enumerate(header_row)
        if h is not None and str(h).strip()
    }


def _cell(row, idx):
    return row[idx] if idx is not None and idx < len(row) else None


@router.get("/tat/export")
def export_tat_excel(db: Session = Depends(get_db)):
    rules = db.query(TATRule).order_by(TATRule.station).all()
    
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "TAT Rules"
    
    # Header
    ws.append(["Station", "Min TAT"])
    
    # Data
    for r in rules:
        ws.append([r.station, minutes_to_hhmm(r.min_tat_minutes)])
    
    # Auto-width columns
    for col in ws.columns:
        max_length = 0
        for cell in col:
            if cell.value:
                max_length = max(max_length, len(str(cell.value)))
        ws.column_dimensions[col[0].column_letter].width = max_length + 2
    
    output = io.BytesIO()
    wb.save(output)
    output.seek(0)
    
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=tat_rules.xlsx"}
    )


@router.post("/tat/import")
async def import_tat_excel(request: Request, file: UploadFile = File(...), db: Session = Depends(get_db)):
    require_editor(request)
    content = await file.read()
    wb = openpyxl.load_workbook(io.BytesIO(content))
    ws = _find_import_sheet(wb, "TAT Rules")

    cols = _header_index_map(ws)
    idx_station = cols.get("Station")
    idx_time = cols.get("Min TAT")
    if idx_station is None or idx_time is None:
        raise HTTPException(400, "File Excel không đúng định dạng: thiếu cột 'Station' hoặc 'Min TAT'.")

    imported = 0
    errors = []
    for row_num, row in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
        station_val = _cell(row, idx_station)
        if not station_val:
            continue
        try:
            station = str(station_val).upper().strip()
            minutes = hhmm_to_minutes(_cell(row, idx_time))
            existing = db.query(TATRule).filter(TATRule.station == station).first()
            if existing:
                existing.min_tat_minutes = minutes
            else:
                db.add(TATRule(station=station, min_tat_minutes=minutes))
            imported += 1
        except Exception as e:
            errors.append({"row": row_num, "error": str(e)})

    db.commit()
    return {"imported": imported, "errors": errors}


@router.get("/blocktime/export")
def export_blocktime_excel(db: Session = Depends(get_db)):
    rules = db.query(BlockTimeRule).order_by(BlockTimeRule.origin, BlockTimeRule.destination).all()
    
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Block Time Rules"
    
    # Header
    ws.append(["Origin", "Destination", "Block Time", "Decimal", "ATS", "Distance (km)"])
    
    # Data
    for r in rules:
        ws.append([r.origin, r.destination, minutes_to_hhmm(r.block_time_minutes), minutes_to_decimal(r.block_time_minutes), r.ats or "", r.distance_km or ""])
    
    # Auto-width columns
    for col in ws.columns:
        max_length = 0
        for cell in col:
            if cell.value:
                max_length = max(max_length, len(str(cell.value)))
        ws.column_dimensions[col[0].column_letter].width = max_length + 2
    
    output = io.BytesIO()
    wb.save(output)
    output.seek(0)
    
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=blocktime_rules.xlsx"}
    )


@router.post("/blocktime/import")
async def import_blocktime_excel(request: Request, file: UploadFile = File(...), db: Session = Depends(get_db)):
    require_editor(request)
    content = await file.read()
    wb = openpyxl.load_workbook(io.BytesIO(content))
    ws = _find_import_sheet(wb, "Block Time Rules")

    cols = _header_index_map(ws)
    idx_origin = cols.get("Origin")
    idx_dest = cols.get("Destination")
    idx_time = cols.get("Block Time")
    idx_ats = cols.get("ATS")
    idx_dist = cols.get("Distance (km)")
    if idx_origin is None or idx_dest is None or idx_time is None:
        raise HTTPException(400, "File Excel không đúng định dạng: thiếu cột 'Origin', 'Destination' hoặc 'Block Time'.")

    imported = 0
    errors = []
    for row_num, row in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
        origin_val = _cell(row, idx_origin)
        dest_val = _cell(row, idx_dest)
        if not origin_val or not dest_val:
            continue
        try:
            origin = str(origin_val).upper().strip()
            dest = str(dest_val).upper().strip()
            minutes = hhmm_to_minutes(_cell(row, idx_time))
            ats_val = _cell(row, idx_ats)
            ats = str(ats_val).strip() if ats_val else None
            dist_val = _cell(row, idx_dist)
            distance_km = int(float(dist_val)) if dist_val not in (None, "") else None

            existing = db.query(BlockTimeRule).filter(
                BlockTimeRule.origin == origin,
                BlockTimeRule.destination == dest
            ).first()
            if existing:
                existing.block_time_minutes = minutes
                existing.ats = ats
                existing.distance_km = distance_km
            else:
                db.add(BlockTimeRule(origin=origin, destination=dest, block_time_minutes=minutes, ats=ats, distance_km=distance_km))
            imported += 1
        except Exception as e:
            errors.append({"row": row_num, "error": str(e)})

    db.commit()
    return {"imported": imported, "errors": errors}


# ── Registration ───────────────────────────────────────────────────────────────
@router.get("/registration", response_model=List[RegistrationOut])
def list_registrations(db: Session = Depends(get_db)):
    return db.query(Registration).order_by(Registration.registration).all()


@router.post("/registration", response_model=RegistrationOut, status_code=201)
def create_registration(request: Request, payload: RegistrationCreate, db: Session = Depends(get_db)):
    require_editor(request)
    reg = payload.registration.upper()
    existing = db.query(Registration).filter(Registration.registration == reg).first()
    if existing:
        raise HTTPException(400, f"Registration '{reg}' already exists")
    r = Registration(registration=reg, aircraft_model=payload.aircraft_model, seats=payload.seats, dw_type=payload.dw_type, mtow=payload.mtow)
    db.add(r)
    db.commit()
    db.refresh(r)
    return r


@router.put("/registration/{reg_id}", response_model=RegistrationOut)
def update_registration(request: Request, reg_id: int, payload: RegistrationUpdate, db: Session = Depends(get_db)):
    require_editor(request)
    r = db.query(Registration).filter(Registration.id == reg_id).first()
    if not r:
        raise HTTPException(404, "Registration not found")
    for field, value in payload.model_dump(exclude_none=True).items():
        setattr(r, field, value)
    db.commit()
    db.refresh(r)
    return r


@router.delete("/registration/{reg_id}", status_code=204)
def delete_registration(request: Request, reg_id: int, db: Session = Depends(get_db)):
    require_editor(request)
    r = db.query(Registration).filter(Registration.id == reg_id).first()
    if not r:
        raise HTTPException(404, "Registration not found")
    db.delete(r)
    db.commit()


@router.get("/registration/export/excel")
def export_registration_excel(db: Session = Depends(get_db)):
    regs = db.query(Registration).order_by(Registration.registration).all()

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Registrations"

    ws.append(["Số đăng bạ", "Mẫu máy bay", "Số ghế", "D/W", "MTOW"])
    for r in regs:
        ws.append([r.registration, r.aircraft_model, r.seats, r.dw_type or "", r.mtow or ""])

    for col in ws.columns:
        max_length = 0
        for cell in col:
            if cell.value:
                max_length = max(max_length, len(str(cell.value)))
        ws.column_dimensions[col[0].column_letter].width = max_length + 2

    output = io.BytesIO()
    wb.save(output)
    output.seek(0)

    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=registrations.xlsx"},
    )


@router.get("/registration/export/csv")
def export_registration_csv(db: Session = Depends(get_db)):
    regs = db.query(Registration).order_by(Registration.registration).all()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Số đăng bạ", "Mẫu máy bay", "Số ghế", "D/W", "MTOW"])
    for r in regs:
        writer.writerow([r.registration, r.aircraft_model, r.seats, r.dw_type or "", r.mtow or ""])

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=registrations.csv"},
    )


@router.post("/registration/import/excel")
async def import_registration_excel(request: Request, file: UploadFile = File(...), db: Session = Depends(get_db)):
    require_editor(request)
    content = await file.read()
    wb = openpyxl.load_workbook(io.BytesIO(content))
    ws = _find_import_sheet(wb, "Registrations")

    cols = _header_index_map(ws)
    idx_reg = cols.get("Số đăng bạ")
    idx_model = cols.get("Mẫu máy bay")
    idx_seats = cols.get("Số ghế")
    idx_dw = cols.get("D/W")
    idx_mtow = cols.get("MTOW")
    if idx_reg is None or idx_model is None or idx_seats is None:
        raise HTTPException(400, "File Excel không đúng định dạng: thiếu cột 'Số đăng bạ', 'Mẫu máy bay' hoặc 'Số ghế'.")

    imported = 0
    errors = []
    for row_num, row in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
        reg_val = _cell(row, idx_reg)
        if not reg_val:
            continue
        try:
            reg_code = str(reg_val).upper().strip()
            model_val = _cell(row, idx_model)
            model = str(model_val).strip() if model_val else ""
            seats_val = _cell(row, idx_seats)
            seats = int(float(seats_val)) if seats_val not in (None, "") else 0
            dw_val = _cell(row, idx_dw)
            dw = str(dw_val).strip() if dw_val else None
            mtow_val_raw = _cell(row, idx_mtow)
            mtow_val = float(mtow_val_raw) if mtow_val_raw not in (None, "") else None

            existing = db.query(Registration).filter(Registration.registration == reg_code).first()
            if existing:
                existing.aircraft_model = model
                existing.seats = seats
                existing.dw_type = dw if dw else None
                existing.mtow = mtow_val
            else:
                db.add(Registration(
                    registration=reg_code, aircraft_model=model, seats=seats,
                    dw_type=dw if dw else None, mtow=mtow_val,
                ))
            imported += 1
        except Exception as e:
            errors.append({"row": row_num, "error": str(e)})

    db.commit()
    return {"imported": imported, "errors": errors}


# ── Route Colors ───────────────────────────────────────────────────────────────
@router.get("/route-colors", response_model=List[RouteColorOut])
def list_route_colors(db: Session = Depends(get_db)):
    return db.query(RouteColor).order_by(RouteColor.origin, RouteColor.destination).all()


@router.post("/route-colors", response_model=RouteColorOut, status_code=201)
def create_route_color(request: Request, payload: RouteColorCreate, db: Session = Depends(get_db)):
    require_editor(request)
    orig = payload.origin.upper().strip()
    dest = payload.destination.upper().strip()
    existing = db.query(RouteColor).filter(
        RouteColor.origin == orig, RouteColor.destination == dest
    ).first()
    if existing:
        # Update color if route already exists
        existing.color = payload.color
        db.commit()
        db.refresh(existing)
        return existing
    rc = RouteColor(origin=orig, destination=dest, color=payload.color)
    db.add(rc)
    db.commit()
    db.refresh(rc)
    return rc


@router.put("/route-colors/{rc_id}", response_model=RouteColorOut)
def update_route_color(request: Request, rc_id: int, payload: RouteColorCreate, db: Session = Depends(get_db)):
    require_editor(request)
    rc = db.query(RouteColor).filter(RouteColor.id == rc_id).first()
    if not rc:
        raise HTTPException(404, "Route color not found")
    rc.origin = payload.origin.upper().strip()
    rc.destination = payload.destination.upper().strip()
    rc.color = payload.color
    db.commit()
    db.refresh(rc)
    return rc


@router.patch("/route-colors/{rc_id}", response_model=RouteColorOut)
def toggle_route_color_enabled(request: Request, rc_id: int, payload: dict, db: Session = Depends(get_db)):
    require_editor(request)
    rc = db.query(RouteColor).filter(RouteColor.id == rc_id).first()
    if not rc:
        raise HTTPException(404, "Route color not found")
    if "enabled" in payload:
        rc.enabled = bool(payload["enabled"])
    if "color" in payload:
        rc.color = payload["color"]
    db.commit()
    db.refresh(rc)
    return rc


@router.delete("/route-colors/{rc_id}", status_code=204)
def delete_route_color(request: Request, rc_id: int, db: Session = Depends(get_db)):
    require_editor(request)
    rc = db.query(RouteColor).filter(RouteColor.id == rc_id).first()
    if not rc:
        raise HTTPException(404, "Route color not found")
    db.delete(rc)
    db.commit()


# ── App Settings ───────────────────────────────────────────────────────────────
@router.get("/settings/{key}")
def get_setting(key: str, db: Session = Depends(get_db)):
    s = db.query(AppSetting).filter(AppSetting.key == key).first()
    return {"key": key, "value": s.value if s else None}


@router.put("/settings/{key}")
def set_setting(request: Request, key: str, payload: dict, db: Session = Depends(get_db)):
    require_editor(request)
    value = payload.get("value")
    s = db.query(AppSetting).filter(AppSetting.key == key).first()
    if s:
        s.value = value
    else:
        db.add(AppSetting(key=key, value=value))
    db.commit()
    return {"key": key, "value": value}


# ── Roster Rules ───────────────────────────────────────────────────────────────
@router.get("/roster", response_model=List[RosterRuleOut])
def list_roster_rules(db: Session = Depends(get_db)):
    return db.query(RosterRule).order_by(RosterRule.id).all()


@router.post("/roster", response_model=RosterRuleOut, status_code=201)
def create_roster_rule(request: Request, payload: RosterRuleCreate, db: Session = Depends(get_db)):
    require_editor(request)
    r = RosterRule(**payload.model_dump())
    db.add(r)
    db.commit()
    db.refresh(r)
    return r


@router.put("/roster/{rule_id}", response_model=RosterRuleOut)
def update_roster_rule(request: Request, rule_id: int, payload: RosterRuleCreate, db: Session = Depends(get_db)):
    require_editor(request)
    r = db.query(RosterRule).filter(RosterRule.id == rule_id).first()
    if not r:
        raise HTTPException(404, "Roster rule not found")
    for k, v in payload.model_dump().items():
        setattr(r, k, v)
    db.commit()
    db.refresh(r)
    return r


@router.delete("/roster/{rule_id}", status_code=204)
def delete_roster_rule(request: Request, rule_id: int, db: Session = Depends(get_db)):
    require_editor(request)
    r = db.query(RosterRule).filter(RosterRule.id == rule_id).first()
    if not r:
        raise HTTPException(404, "Roster rule not found")
    db.delete(r)
    db.commit()


# ── Service Codes ──────────────────────────────────────────────────────────────
@router.get("/service-codes", response_model=List[ServiceCodeOut])
def list_service_codes(db: Session = Depends(get_db)):
    return db.query(ServiceCode).order_by(ServiceCode.code).all()


@router.post("/service-codes", response_model=ServiceCodeOut, status_code=201)
def create_service_code(request: Request, payload: ServiceCodeCreate, db: Session = Depends(get_db)):
    require_editor(request)
    code = payload.code.upper().strip()
    if not code:
        raise HTTPException(400, "Mã service code không được để trống")
    existing = db.query(ServiceCode).filter(ServiceCode.code == code).first()
    if existing:
        raise HTTPException(400, f"Service code '{code}' đã tồn tại")
    sc = ServiceCode(code=code, status=payload.status.strip())
    db.add(sc)
    db.commit()
    db.refresh(sc)
    return sc


@router.put("/service-codes/{sc_id}", response_model=ServiceCodeOut)
def update_service_code(request: Request, sc_id: int, payload: ServiceCodeCreate, db: Session = Depends(get_db)):
    require_editor(request)
    sc = db.query(ServiceCode).filter(ServiceCode.id == sc_id).first()
    if not sc:
        raise HTTPException(404, "Service code not found")
    code = payload.code.upper().strip()
    dup = db.query(ServiceCode).filter(ServiceCode.code == code, ServiceCode.id != sc_id).first()
    if dup:
        raise HTTPException(400, f"Service code '{code}' đã tồn tại")
    sc.code = code
    sc.status = payload.status.strip()
    db.commit()
    db.refresh(sc)
    return sc


@router.delete("/service-codes/{sc_id}", status_code=204)
def delete_service_code(request: Request, sc_id: int, db: Session = Depends(get_db)):
    require_editor(request)
    sc = db.query(ServiceCode).filter(ServiceCode.id == sc_id).first()
    if not sc:
        raise HTTPException(404, "Service code not found")
    db.delete(sc)
    db.commit()
