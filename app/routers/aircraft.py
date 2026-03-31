from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List

from ..database import get_db
from ..models import Aircraft, FlightSector, Registration
from ..schemas import AircraftCreate, AircraftUpdate, AircraftOut

router = APIRouter()


@router.get("/", response_model=List[AircraftOut])
def list_aircraft(db: Session = Depends(get_db)):
    aircraft_list = db.query(Aircraft).order_by(Aircraft.line_order, Aircraft.id).all()
    result = []
    for ac in aircraft_list:
        ac_dict = {
            "id": ac.id,
            "registration": ac.registration,
            "name": ac.name,
            "ac_type": ac.ac_type,
            "line_order": ac.line_order,
            "color": ac.color,
            "registration_id": ac.registration_id,
            "registration_info": None,
        }
        # If registration_id is set, look up by id; otherwise fall back to matching by registration string
        reg = None
        if ac.registration_id:
            reg = db.query(Registration).filter(Registration.id == ac.registration_id).first()
        if not reg:
            reg = db.query(Registration).filter(Registration.registration == ac.registration).first()
        if reg:
            ac_dict["registration_info"] = {
                "aircraft_model": reg.aircraft_model,
                "seats": reg.seats,
                "dw_type": reg.dw_type,
            }
        result.append(ac_dict)
    return result


@router.post("/", response_model=AircraftOut, status_code=201)
def create_aircraft(payload: AircraftCreate, db: Session = Depends(get_db)):
    existing = db.query(Aircraft).filter(Aircraft.registration == payload.registration).first()
    if existing:
        raise HTTPException(400, f"Registration '{payload.registration}' already exists")
    # Auto-assign line_order if not provided
    max_order = db.query(Aircraft).count()
    ac = Aircraft(
        registration=payload.registration,
        name=payload.name,
        ac_type=payload.ac_type,
        line_order=payload.line_order if payload.line_order else max_order,
        color=payload.color,
        registration_id=payload.registration_id,
    )
    db.add(ac)
    db.commit()
    db.refresh(ac)
    return ac


@router.put("/{aircraft_id}", response_model=AircraftOut)
def update_aircraft(aircraft_id: int, payload: AircraftUpdate, db: Session = Depends(get_db)):
    ac = db.query(Aircraft).filter(Aircraft.id == aircraft_id).first()
    if not ac:
        raise HTTPException(404, "Aircraft not found")
    data = payload.model_dump(exclude_unset=True)
    for field, value in data.items():
        setattr(ac, field, value)
    db.commit()
    db.refresh(ac)
    return ac


@router.delete("/{aircraft_id}", status_code=204)
def delete_aircraft(aircraft_id: int, db: Session = Depends(get_db)):
    ac = db.query(Aircraft).filter(Aircraft.id == aircraft_id).first()
    if not ac:
        raise HTTPException(404, "Aircraft not found")
    # Delete all sectors belonging to this aircraft first
    db.query(FlightSector).filter(FlightSector.aircraft_id == aircraft_id).delete()
    db.delete(ac)
    db.commit()


@router.put("/reorder/batch", status_code=200)
def reorder_aircraft(order: List[dict], db: Session = Depends(get_db)):
    """Accepts [{id, line_order}, ...] and updates line_order for each aircraft."""
    for item in order:
        ac = db.query(Aircraft).filter(Aircraft.id == item["id"]).first()
        if ac:
            ac.line_order = item["line_order"]
    db.commit()
    return {"ok": True}
