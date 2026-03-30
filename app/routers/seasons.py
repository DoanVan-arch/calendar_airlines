"""
Seasons router – CRUD for IATA season definitions.

IATA standard:
  Summer: last Sunday of March → last Saturday of October
  Winter: last Saturday of October → last Saturday of March (next year)

Admin can override dates freely.
"""

from datetime import date, timedelta
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Season
from ..routers.auth import require_admin
from ..schemas import SeasonCreate, SeasonOut

router = APIRouter()


# ── IATA date helpers ──────────────────────────────────────────────────────────

def _last_sunday_of_march(year: int) -> date:
    """Last Sunday of March = start of IATA Summer."""
    d = date(year, 3, 31)
    while d.weekday() != 6:  # 6 = Sunday
        d -= timedelta(days=1)
    return d


def _last_saturday_of_october(year: int) -> date:
    """Last Saturday of October = end of IATA Summer / start of Winter."""
    d = date(year, 10, 31)
    while d.weekday() != 5:  # 5 = Saturday
        d -= timedelta(days=1)
    return d


# ── Generate default IATA seasons ─────────────────────────────────────────────

@router.get("/defaults")
def get_iata_defaults(years: int = 3):
    """Return IATA season date ranges for the current and next N years."""
    import datetime as dt
    current_year = dt.date.today().year
    result = []
    for y in range(current_year - 1, current_year + years + 1):
        summer_start = _last_sunday_of_march(y)
        summer_end   = _last_saturday_of_october(y) - timedelta(days=1)
        winter_start = _last_saturday_of_october(y)
        winter_end   = _last_sunday_of_march(y + 1) - timedelta(days=1)
        result.append({
            "year": y,
            "summer": {
                "name": f"Mùa hè {y}",
                "season_type": "summer",
                "year": y,
                "start_date": summer_start.isoformat(),
                "end_date":   summer_end.isoformat(),
            },
            "winter": {
                "name": f"Mùa đông {y}/{y+1}",
                "season_type": "winter",
                "year": y,
                "start_date": winter_start.isoformat(),
                "end_date":   winter_end.isoformat(),
            },
        })
    return result


# ── CRUD ───────────────────────────────────────────────────────────────────────

@router.get("/", response_model=List[SeasonOut])
def list_seasons(db: Session = Depends(get_db)):
    return db.query(Season).order_by(Season.start_date).all()


@router.post("/", response_model=SeasonOut, status_code=201)
def create_season(request: Request, payload: SeasonCreate, db: Session = Depends(get_db)):
    require_admin(request)
    if payload.season_type not in ("summer", "winter"):
        raise HTTPException(400, "season_type phải là 'summer' hoặc 'winter'")
    season = Season(**payload.model_dump())
    db.add(season)
    db.commit()
    db.refresh(season)
    return season


@router.put("/{season_id}", response_model=SeasonOut)
def update_season(request: Request, season_id: int, payload: SeasonCreate, db: Session = Depends(get_db)):
    require_admin(request)
    season = db.query(Season).filter(Season.id == season_id).first()
    if not season:
        raise HTTPException(404, "Không tìm thấy mùa")
    for field, value in payload.model_dump().items():
        setattr(season, field, value)
    db.commit()
    db.refresh(season)
    return season


@router.delete("/{season_id}", status_code=204)
def delete_season(request: Request, season_id: int, db: Session = Depends(get_db)):
    require_admin(request)
    season = db.query(Season).filter(Season.id == season_id).first()
    if not season:
        raise HTTPException(404, "Không tìm thấy mùa")
    db.delete(season)
    db.commit()
