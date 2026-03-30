"""Audit log router – read-only access to the change history."""

from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import AuditLog
from ..schemas import AuditLogOut

router = APIRouter()


@router.get("/", response_model=List[AuditLogOut])
def list_audit_log(
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    username: Optional[str] = Query(None),
    entity: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    q = db.query(AuditLog)
    if username:
        q = q.filter(AuditLog.username == username)
    if entity:
        q = q.filter(AuditLog.entity == entity)
    return q.order_by(AuditLog.timestamp.desc()).offset(offset).limit(limit).all()
