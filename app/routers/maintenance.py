"""Maintenance blocks router – aircraft ground/maintenance periods spanning multiple days."""

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import MaintenanceBlock, Aircraft
from ..routers.auth import get_session, require_admin
from ..schemas import MaintenanceCreate, MaintenanceUpdate, MaintenanceOut

router = APIRouter()


@router.get("/", response_model=List[MaintenanceOut])
def list_maintenance(
    aircraft_id: Optional[int] = Query(None),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    q = db.query(MaintenanceBlock)
    if aircraft_id:
        q = q.filter(MaintenanceBlock.aircraft_id == aircraft_id)
    if start:
        q = q.filter(MaintenanceBlock.end_date >= start)
    if end:
        q = q.filter(MaintenanceBlock.start_date <= end)
    return q.order_by(MaintenanceBlock.start_date).all()


@router.post("/", response_model=MaintenanceOut, status_code=201)
def create_maintenance(request: Request, payload: MaintenanceCreate, db: Session = Depends(get_db)):
    require_admin(request)
    ac = db.query(Aircraft).filter(Aircraft.id == payload.aircraft_id).first()
    if not ac:
        raise HTTPException(404, "Aircraft not found")
    block = MaintenanceBlock(**payload.model_dump())
    db.add(block)
    db.commit()
    db.refresh(block)
    # Audit log
    _log(db, request, "CREATE", "maintenance", block.id,
         f"{ac.registration}: {block.label} {block.start_date}→{block.end_date}")
    return block


@router.put("/{block_id}", response_model=MaintenanceOut)
def update_maintenance(request: Request, block_id: int, payload: MaintenanceUpdate, db: Session = Depends(get_db)):
    require_admin(request)
    block = db.query(MaintenanceBlock).filter(MaintenanceBlock.id == block_id).first()
    if not block:
        raise HTTPException(404, "Không tìm thấy block bảo dưỡng")
    for field, value in payload.model_dump(exclude_none=True).items():
        setattr(block, field, value)
    db.commit()
    db.refresh(block)
    ac = db.query(Aircraft).filter(Aircraft.id == block.aircraft_id).first()
    _log(db, request, "UPDATE", "maintenance", block.id,
         f"{ac.registration if ac else '?'}: {block.label} {block.start_date}→{block.end_date}")
    return block


@router.delete("/{block_id}", status_code=204)
def delete_maintenance(request: Request, block_id: int, db: Session = Depends(get_db)):
    require_admin(request)
    block = db.query(MaintenanceBlock).filter(MaintenanceBlock.id == block_id).first()
    if not block:
        raise HTTPException(404, "Không tìm thấy block bảo dưỡng")
    ac = db.query(Aircraft).filter(Aircraft.id == block.aircraft_id).first()
    _log(db, request, "DELETE", "maintenance", block_id,
         f"{ac.registration if ac else '?'}: {block.label} {block.start_date}→{block.end_date}")
    db.delete(block)
    db.commit()


def _log(db: Session, request: Request, action: str, entity: str, entity_id: int, detail: str):
    from ..models import AuditLog
    from datetime import datetime
    sess = get_session(request)
    username = sess["username"] if sess else "system"
    db.add(AuditLog(
        timestamp=datetime.utcnow(),
        username=username,
        action=action,
        entity=entity,
        entity_id=entity_id,
        detail=detail,
    ))
    db.commit()
