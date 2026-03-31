"""Calendar notes router – short notes attached to specific calendar dates."""

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import CalendarNote
from ..schemas import CalendarNoteCreate, CalendarNoteUpdate, CalendarNoteOut

router = APIRouter()


@router.get("/", response_model=List[CalendarNoteOut])
def list_notes(
    month: Optional[str] = Query(None),   # YYYY-MM  e.g. "2026-03"
    date: Optional[str] = Query(None),    # YYYY-MM-DD for single day
    start: Optional[str] = Query(None),   # YYYY-MM-DD range start (inclusive)
    end: Optional[str] = Query(None),     # YYYY-MM-DD range end (inclusive)
    db: Session = Depends(get_db),
):
    q = db.query(CalendarNote)
    if month:
        q = q.filter(CalendarNote.note_date.like(f"{month}%"))
    if date:
        q = q.filter(CalendarNote.note_date == date)
    if start and end:
        q = q.filter(CalendarNote.note_date >= start, CalendarNote.note_date <= end)
    return q.order_by(CalendarNote.note_date, CalendarNote.start_time).all()


@router.post("/", response_model=CalendarNoteOut, status_code=201)
def create_note(payload: CalendarNoteCreate, db: Session = Depends(get_db)):
    note = CalendarNote(**payload.model_dump())
    db.add(note)
    db.commit()
    db.refresh(note)
    return note


@router.put("/{note_id}", response_model=CalendarNoteOut)
def update_note(note_id: int, payload: CalendarNoteUpdate, db: Session = Depends(get_db)):
    note = db.query(CalendarNote).filter(CalendarNote.id == note_id).first()
    if not note:
        raise HTTPException(404, "Không tìm thấy ghi chú")
    for field, value in payload.model_dump(exclude_none=True).items():
        setattr(note, field, value)
    db.commit()
    db.refresh(note)
    return note


@router.delete("/{note_id}", status_code=204)
def delete_note(note_id: int, db: Session = Depends(get_db)):
    note = db.query(CalendarNote).filter(CalendarNote.id == note_id).first()
    if not note:
        raise HTTPException(404, "Không tìm thấy ghi chú")
    db.delete(note)
    db.commit()
