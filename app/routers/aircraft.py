from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List

from ..database import get_db
from ..models import Aircraft, Registration
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
            "registration_info": None
        }
        # Try to find matching registration details
        reg = db.query(Registration).filter(Registration.registration == ac.registration).first()
        if reg:
            ac_dict["registration_info"] = {
                "aircraft_model": reg.aircraft_model,
                "seats": reg.seats
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
    for field, value in payload.model_dump(exclude_none=True).items():
        setattr(ac, field, value)
    db.commit()
    db.refresh(ac)
    return ac


@router.delete("/{aircraft_id}", status_code=204)
def delete_aircraft(aircraft_id: int, db: Session = Depends(get_db)):
    ac = db.query(Aircraft).filter(Aircraft.id == aircraft_id).first()
    if not ac:
        raise HTTPException(404, "Aircraft not found")
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
