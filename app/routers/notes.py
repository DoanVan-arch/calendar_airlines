"""Calendar notes router – short notes attached to calendar dates or date ranges."""

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session
from sqlalchemy import or_, and_

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
        # A note is visible in a month if:
        # - note_date is in that month, OR
        # - note spans into that month (note_date <= last day of month AND note_end_date >= first day of month)
        month_start = f"{month}-01"
        # Calculate last day of month
        year, mon = int(month[:4]), int(month[5:7])
        if mon == 12:
            month_end = f"{year + 1}-01-01"
        else:
            month_end = f"{year}-{mon + 1:02d}-01"
        # Use string comparison (works with YYYY-MM-DD format)
        import datetime as _dt
        last_day = (_dt.date(int(month_end[:4]), int(month_end[5:7]), 1) - _dt.timedelta(days=1)).isoformat()

        q = q.filter(
            or_(
                # Single-day note in this month
                and_(CalendarNote.note_end_date.is_(None), CalendarNote.note_date.like(f"{month}%")),
                # Range note overlapping this month
                and_(
                    CalendarNote.note_end_date.isnot(None),
                    CalendarNote.note_date <= last_day,
                    CalendarNote.note_end_date >= month_start,
                ),
            )
        )
    if date:
        q = q.filter(
            or_(
                # Single-day note on this date
                and_(CalendarNote.note_end_date.is_(None), CalendarNote.note_date == date),
                # Range note spanning this date
                and_(
                    CalendarNote.note_end_date.isnot(None),
                    CalendarNote.note_date <= date,
                    CalendarNote.note_end_date >= date,
                ),
            )
        )
    if start and end:
        q = q.filter(
            or_(
                # Single-day note within the range
                and_(CalendarNote.note_end_date.is_(None),
                     CalendarNote.note_date >= start, CalendarNote.note_date <= end),
                # Range note overlapping the query range
                and_(
                    CalendarNote.note_end_date.isnot(None),
                    CalendarNote.note_date <= end,
                    CalendarNote.note_end_date >= start,
                ),
            )
        )
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
    data = payload.model_dump(exclude_unset=True)
    for field, value in data.items():
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
