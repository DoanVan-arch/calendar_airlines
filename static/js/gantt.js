/* gantt.js – Renders the Gantt chart and handles drag-and-drop */

let DAYS_SHOWN  = 3;         // default number of days rendered in the infinite ruler
const MINUTES_PER_DAY = 1440;
function MINUTES_TOTAL() { return DAYS_SHOWN * MINUTES_PER_DAY; }  // computed dynamically
let PX_PER_MIN   = 2;       // zoom: 2px per minute → 2880px per day
const ROW_H        = 64;      // px (sector block + gap)
const LABEL_W      = 130;     // must match CSS --label-w

// Route colour palette (hash → colour)
const PALETTE = [
  "#2563eb","#16a34a","#d97706","#9333ea","#0891b2",
  "#be123c","#0f766e","#b45309","#1d4ed8","#15803d",
  "#0369a1","#7c3aed","#b91c1c","#047857","#92400e",
];

function routeColor(origin, dest) {
  const key = [origin, dest].sort().join("");
  let h = 0;
  for (const c of key) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

function timeToMin(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function minToTime(m) {
  m = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2,"0")}:${String(m % 60).padStart(2,"0")}`;
}

function applyTZ(hhmm, offsetHours) {
  return minToTime(timeToMin(hhmm) + Math.round(offsetHours * 60));
}

/** Convert any CSS colour (hex, rgb, etc.) to rgba() with given alpha */
function hexToRGBA(color, alpha) {
  // Handle hex colors
  if (color.startsWith("#")) {
    let hex = color.slice(1);
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    const r = parseInt(hex.slice(0,2), 16);
    const g = parseInt(hex.slice(2,4), 16);
    const b = parseInt(hex.slice(4,6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  // Handle rgb/rgba strings
  const m = color.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return `rgba(${m[1]},${m[2]},${m[3]},${alpha})`;
  // Fallback
  return color;
}

/** Return "#000" or "#fff" based on perceived luminance of the given colour */
function getContrastColor(color) {
  let r, g, b;
  if (color.startsWith("#")) {
    let hex = color.slice(1);
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    r = parseInt(hex.slice(0,2), 16);
    g = parseInt(hex.slice(2,4), 16);
    b = parseInt(hex.slice(4,6), 16);
  } else {
    const m = color.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) { r = +m[1]; g = +m[2]; b = +m[3]; }
    else return "#fff"; // fallback
  }
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return luminance > 186 ? "#000" : "#fff";
}

/** Format a duration in minutes:
 *  ≤ 60  → "45'"  (just minutes + apostrophe)
 *  > 60  → "1:25" (H:MM, no leading zero on hours)
 */
function formatDuration(minutes) {
  if (minutes <= 60) return `${minutes}'`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

class GanttChart {
  constructor({ labelCol, scrollArea, ruler, rows, onSectorClick, onSectorRightClick, onDrop, onTimeChange, onReorder, onRowDrop }) {
    this.$labelCol   = labelCol;
    this.$scrollArea = scrollArea;
    this.$ruler      = ruler;
    this.$rows       = rows;
    this.onSectorClick      = onSectorClick;
    this.onSectorRightClick = onSectorRightClick;
    this.onDrop             = onDrop;
    this.onTimeChange       = onTimeChange;  // callback(sectorId, newDepUtc, newArrUtc)
    this.onReorder          = onReorder;      // callback(orderedAcIds[])
    this.onRowDrop          = onRowDrop;      // callback(fromAcId, toAcId) — move ALL sectors

    this._dragSectorId   = null;
    this._dragAircraftId = null;
    this._dragSelectedIds= [];
    this._dragRowFromAcId= null;
    this._dragShiftRow   = false;   // true when Shift+dragging a sector (move whole row)
    this._warningIds    = new Set();
    this._errorIds      = new Set();
    this._timezone      = "UTC";
    this._airports      = {};

    // State for same-row time-drag
    this._timeDrag = null;  // { sector, el, startX, startDepMin, btMin, scrollStartX }

    // ── Multi-select state ─────────────────────────────────────────────────────
    this._selectedSectors = new Set(); // Set of sector IDs currently selected
    this._sectorEls       = new Map(); // sectorId → DOM element (rebuilt on render)

    // ── Row reorder state ──────────────────────────────────────────────────────
    this._rowDrag = null;

    this._syncScroll();
    this._bindTimeDragGlobal();
    this._bindRowDragGlobal();
    this._bindDragCleanup();
    this._bindZoom();
  }

  // ── Zoom (Ctrl+wheel) ─────────────────────────────────────────────────────
  _bindZoom() {
    const MIN_PX = 0.3;   // very zoomed out (≈ 432px per day)
    const MAX_PX = 8;     // very zoomed in (≈ 11520px per day)
    const STEP   = 1.15;  // 15% per notch

    this.$scrollArea.addEventListener("wheel", e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();

      // Where the cursor points in time (minutes from start)
      const rect     = this.$scrollArea.getBoundingClientRect();
      const cursorX  = e.clientX - rect.left + this.$scrollArea.scrollLeft;
      const cursorMin= cursorX / PX_PER_MIN;

      // Apply zoom
      const oldPx = PX_PER_MIN;
      if (e.deltaY < 0) {
        PX_PER_MIN = Math.min(MAX_PX, PX_PER_MIN * STEP);
      } else {
        PX_PER_MIN = Math.max(MIN_PX, PX_PER_MIN / STEP);
      }

      if (PX_PER_MIN === oldPx) return; // no change (clamped)

      // Re-render with stored data
      if (this._aircraft) {
        this._reRender();
      }

      // Restore scroll so the same minute stays under the cursor
      const newCursorX = cursorMin * PX_PER_MIN;
      this.$scrollArea.scrollLeft = newCursorX - (e.clientX - rect.left);

      // Update zoom indicator
      this._updateZoomIndicator();
    }, { passive: false });
  }

  _reRender() {
    this.render({
      aircraft   : this._aircraft,
      sectors    : this._sectors,
      airports   : this._airports,
      timezone   : this._timezone,
      warnings   : this._lastWarnings || [],
      maintenance: this._maintenance,
      currentDate: this._currentDate,
      routeColors: this._routeColorMap,
    });
  }

  _updateZoomIndicator() {
    const pct = Math.round((PX_PER_MIN / 2) * 100); // 2 is default
    const el = document.getElementById("zoomIndicator");
    if (el) el.textContent = `${pct}%`;
  }

  resetZoom() {
    PX_PER_MIN = 2;
    if (this._aircraft) this._reRender();
    this._updateZoomIndicator();
  }

  // ── Public render ───────────────────────────────────────────────────────────
  render({ aircraft, sectors, airports, timezone, warnings, maintenance, currentDate, prevDayLast, routeColors }) {
    this._aircraft    = aircraft;
    this._sectors     = sectors;
    this._airports    = airports;
    this._timezone    = timezone;
    this._maintenance = maintenance || [];
    this._currentDate = currentDate || "";
    this._lastWarnings = warnings || [];
    this._prevDayLast = prevDayLast || {}; // aircraft_id → last sector of previous day
    this._routeColorMap = routeColors || null; // "ORIG-DEST" → color (null = disabled)

    // Build aircraft color map: acId → color (null if not set)
    this._acColorMap = {};
    for (const ac of aircraft) {
      this._acColorMap[ac.id] = ac.color || null;
    }

    // Map warning sector ids
    this._warningIds = new Set();
    this._errorIds   = new Set();
    for (const w of warnings) {
      const target = w.severity === "error" ? this._errorIds : this._warningIds;
      if (w.sector_id)      target.add(w.sector_id);
      if (w.next_sector_id) target.add(w.next_sector_id);
    }

    const active    = aircraft.filter(ac => ac.id !== -1);
    const cancelled = sectors.filter(s => s.status === "cancelled");

    this.$labelCol.innerHTML = "";
    this.$rows.innerHTML     = "";

    // Rebuild ruler with current timezone (must come after label-col clear
    // because _buildRuler prepends the TZ header into label-col)
    this._buildRuler();

    // Reset element map (sectors are re-created on each render)
    this._sectorEls = new Map();

    // Active aircraft rows
    for (const ac of active) {
      this._addAircraftRow(ac, sectors.filter(s => s.aircraft_id === ac.id && s.status === "active"));
    }

    // Cancelled row
    if (cancelled.length > 0) {
      this._addCancelledRow(cancelled);
    }

    // Set total width — rows and ruler must match for column alignment
    const totalW = MINUTES_TOTAL() * PX_PER_MIN;
    this.$rows.style.width  = totalW + "px";
    this.$ruler.style.minWidth = totalW + "px";

    // Set dynamic hour width for grid lines (CSS variable)
    this.$rows.style.setProperty("--hour-w", (PX_PER_MIN * 60) + "px");
  }

  // ── Ruler (dual row: UTC top, LCT bottom, DAYS_SHOWN days wide) ──────────
  _buildRuler() {
    this.$ruler.innerHTML = "";
    const totalHours = DAYS_SHOWN * 24;  // always full days

    // Parse base date for date-change labels
    let baseDate = null;
    if (this._currentDate) {
      const parts = this._currentDate.split("-");
      if (parts.length === 3) baseDate = new Date(+parts[0], +parts[1]-1, +parts[2]);
    }
    const fmtDate = (d) => `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}`;
    const dayNames = ["D7","D1","D2","D3","D4","D5","D6"]; // 0=Sun
    const fmtDay = (d) => dayNames[d.getDay()];

    // Top row: UTC hours
    const utcRow = document.createElement("div");
    utcRow.className = "ruler-row ruler-row-utc";

    // Bottom row: LCT hours
    const lctRow = document.createElement("div");
    lctRow.className = "ruler-row ruler-row-lct";

    // Build TZ labels in the label-column header area (instead of inside ruler rows)
    // so the ruler hour cells align perfectly with the gantt-row grid lines.
    const labelHeader = document.createElement("div");
    labelHeader.className = "label-col-header";
    labelHeader.innerHTML = `
      <div class="ruler-tz-badge ruler-tz-badge-left">
        <span class="ruler-tz-label">UTC</span>${baseDate ? `<span class="ruler-tz-date">${fmtDate(baseDate)} (${fmtDay(baseDate)})</span>` : ""}
      </div>
      <div class="ruler-tz-badge ruler-tz-badge-left ruler-tz-badge-lct">
        <span class="ruler-tz-label">LCT+7</span>${baseDate ? `<span class="ruler-tz-date">${fmtDate(baseDate)} (${fmtDay(baseDate)})</span>` : ""}
      </div>`;
    this.$labelCol.prepend(labelHeader);

    for (let h = 0; h < totalHours; h++) {
      const utcH = h % 24;
      const lctH = (h + 7) % 24;
      const hourW = PX_PER_MIN * 60;  // dynamic width per hour

      // UTC cell — show prominent date chip at each day boundary (UTC midnight)
      const utcEl = document.createElement("div");
      utcEl.className = "ruler-hour";
      utcEl.style.width = hourW + "px";
      if (utcH === 0) {
        utcEl.classList.add("ruler-midnight");
        if (h === 0) {
          // First cell: just show time (date is in badge)
          utcEl.textContent = "00:00";
        } else if (baseDate) {
          const dayOff = Math.floor(h / 24);
          const nextD = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + dayOff);
          utcEl.innerHTML = `<span class="ruler-date-chip ruler-date-chip-day">${fmtDate(nextD)} (${fmtDay(nextD)})</span><span>00:00</span>`;
        } else {
          utcEl.textContent = "00:00";
        }
      } else {
        utcEl.textContent = String(utcH).padStart(2, "0") + ":00";
      }
      utcRow.appendChild(utcEl);

      // LCT cell — show date chip when rolling over to next LCT day (lctH === 0)
      const lctEl = document.createElement("div");
      lctEl.className = "ruler-hour ruler-hour-lct";
      lctEl.style.width = hourW + "px";
      if (lctH === 0) {
        lctEl.classList.add("ruler-midnight");
        if (h === 0) {
          lctEl.textContent = String((h + 7) % 24).padStart(2,"0") + ":00"; // won't be 0 at h=0
        } else if (baseDate) {
          const lctDayOffset = Math.floor((h + 7) / 24);
          const nextLctD = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + lctDayOffset);
          lctEl.innerHTML = `<span class="ruler-date-chip ruler-date-chip-day">${fmtDate(nextLctD)} (${fmtDay(nextLctD)})</span><span>00:00</span>`;
        } else {
          lctEl.textContent = "00:00";
        }
      } else {
        lctEl.textContent = String(lctH).padStart(2, "0") + ":00";
      }
      lctRow.appendChild(lctEl);
    }

    this.$ruler.appendChild(utcRow);
    this.$ruler.appendChild(lctRow);
  }

  // ── Row builders ────────────────────────────────────────────────────────────
  _addAircraftRow(ac, sectors) {
    // Filter sectors to only the current date (24h UTC) for BH and sector count
    const todaySectors = this._currentDate
      ? sectors.filter(s => s.flight_date === this._currentDate)
      : sectors;

    // Compute total block hours for this aircraft today (currentDate only)
    const totalBMin = todaySectors.reduce((sum, s) => {
      let d = timeToMin(s.dep_utc), a = timeToMin(s.arr_utc);
      if (a <= d) a += 1440;
      return sum + (a - d);
    }, 0);
    // Numeric hours format: e.g. "8.5h", "0.0h"
    const bhNum  = (totalBMin / 60).toFixed(1);
    const bhStr  = `${bhNum}h`;

    // Color swatch for aircraft
    const acColor = this._acColorMap[ac.id];
    const swatchHtml = acColor
      ? `<span class="color-swatch" style="background:${acColor};"></span>`
      : "";

    // Sector count (currentDate only)
    const sectorCount = todaySectors.length;

    // Label
    const lbl = document.createElement("div");
    lbl.className = "ac-label";
    lbl.dataset.acId = ac.id;
    if (acColor) lbl.style.borderLeft = `3px solid ${acColor}`;
    lbl.innerHTML = `
      <span class="ac-drag-handle" title="Kéo để đổi vị trí">⠿</span>
      ${swatchHtml}
      <span class="ac-reg">${ac.registration}</span>
      <span class="ac-sub">${ac.ac_type || ac.name || "&nbsp;"}</span>
      <span class="ac-bh" title="Tổng block hôm nay">${bhStr}</span>
      <span class="ac-sectors" title="Số chặng bay">${sectorCount} chặng</span>`;
    
    // Rich hover tooltip for registration info — appended to body to escape overflow:hidden
    if (ac.registration_info) {
      const tipHTML = `
        <div class="ac-tip-header">${ac.registration}</div>
        <div class="ac-tip-row"><span class="ac-tip-label">Mẫu máy bay</span><span class="ac-tip-val">${ac.registration_info.aircraft_model}</span></div>
        <div class="ac-tip-row"><span class="ac-tip-label">Số ghế</span><span class="ac-tip-val">${ac.registration_info.seats}</span></div>
        <div class="ac-tip-row"><span class="ac-tip-label">Số chặng</span><span class="ac-tip-val">${sectorCount}</span></div>
        <div class="ac-tip-row"><span class="ac-tip-label">Block hôm nay</span><span class="ac-tip-val">${bhStr}</span></div>`;

      let tip = null;
      const hideTip = () => { if (tip) { tip.remove(); tip = null; } };

      lbl.addEventListener("mouseenter", () => {
        hideTip(); // clear any leftover before creating a new one
        tip = document.createElement("div");
        tip.className = "ac-tooltip ac-tooltip-fixed";
        tip.innerHTML = tipHTML;
        document.body.appendChild(tip);
        const rect = lbl.getBoundingClientRect();
        tip.style.left = (rect.right + 8) + "px";
        tip.style.top  = (rect.top + rect.height / 2) + "px";
        tip.style.transform = "translateY(-50%)";
      });
      lbl.addEventListener("mouseleave", hideTip);
      // Drag suppresses mouseleave — hide tooltip explicitly on dragstart
      lbl.addEventListener("dragstart", hideTip);
      // Also hide on dragend in case it somehow reappears
      lbl.addEventListener("dragend", hideTip);
    } else {
      lbl.title = "Double-click để chỉnh sửa tàu bay";
    }

    lbl.addEventListener("dblclick", () => this._editAircraftLabel(ac));
    lbl.addEventListener("contextmenu", e => {
      e.preventDefault();
      e.stopPropagation();
      document.dispatchEvent(new CustomEvent("ac-rightclick", {
        detail: { ac, x: e.clientX, y: e.clientY }
      }));
    });

    // ── HTML5 drag on label: drag entire row (all sectors) to another row ────
    lbl.setAttribute("draggable", "true");
    lbl.addEventListener("dragstart", e => {
      // If the drag handle initiated a row-reorder, suppress HTML5 drag
      if (this._rowDrag) { e.preventDefault(); return; }
      this._dragRowFromAcId = ac.id;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("application/x-row-drag", String(ac.id));
      lbl.classList.add("row-dragging");
    });
    lbl.addEventListener("dragend", () => {
      lbl.classList.remove("row-dragging");
      this._dragRowFromAcId = null;
    });
    // Accept drops on labels too (row-level drop target)
    lbl.addEventListener("dragover", e => {
      // Only accept row-level drags (not sector drags)
      if (this._dragRowFromAcId != null && this._dragRowFromAcId !== ac.id) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        lbl.classList.add("row-drag-target");
      }
    });
    lbl.addEventListener("dragleave", () => lbl.classList.remove("row-drag-target"));
    lbl.addEventListener("drop", async e => {
      lbl.classList.remove("row-drag-target");
      const rowDragData = e.dataTransfer.getData("application/x-row-drag");
      if (rowDragData) {
        e.preventDefault();
        const fromAcId = parseInt(rowDragData, 10);
        if (fromAcId !== ac.id && this.onRowDrop) {
          await this.onRowDrop(fromAcId, ac.id);
        }
      }
    });

    // ── Row reorder: mousedown on drag handle ────────────────────────────────
    const handle = lbl.querySelector(".ac-drag-handle");
    if (handle) {
      handle.addEventListener("mousedown", e => {
        e.preventDefault();
        e.stopPropagation();
        this._startRowDrag(lbl, ac.id, e.clientY);
      });
    }

    this.$labelCol.appendChild(lbl);

    // Gantt row
    const row = document.createElement("div");
    row.className = "gantt-row";
    row.dataset.acId = ac.id;
    row.style.height = ROW_H + "px";
    row.style.minWidth = MINUTES_TOTAL() * PX_PER_MIN + "px";

    this._attachDropHandlers(row, ac.id);

    // ── Previous day connection indicator ────────────────────────────────────
    const prevSector = this._prevDayLast[ac.id];
    if (prevSector) {
      const connEl = this._makePrevDayConnection(prevSector, sectors);
      if (connEl) row.appendChild(connEl);
    }

    // Sort by effective departure time (accounting for day offset)
    const sorted = [...sectors].sort((a, b) => {
      const dayA = a._dayOffset || (a._nextDay ? 1 : 0);
      const dayB = b._dayOffset || (b._nextDay ? 1 : 0);
      const am = timeToMin(a.dep_utc) + dayA * MINUTES_PER_DAY;
      const bm = timeToMin(b.dep_utc) + dayB * MINUTES_PER_DAY;
      return am - bm;
    });
    for (let i = 0; i < sorted.length; i++) {
      row.appendChild(this._makeSectorBlock(sorted[i]));
      if (i < sorted.length - 1) {
        // Draw TAT gap for consecutive sectors (same-day or adjacent days)
        const gap = this._makeTATGap(sorted[i], sorted[i + 1]);
        if (gap) row.appendChild(gap);
      }
    }

    // Render maintenance blocks for each visible day
    const mxBlocks = (this._maintenance || []).filter(m => m.aircraft_id === ac.id);
    for (let dayOff = 0; dayOff < DAYS_SHOWN; dayOff++) {
      const dayDate = this._getDayDate(dayOff);
      for (const mx of mxBlocks) {
        if (mx.start_date <= dayDate && mx.end_date >= dayDate) {
          const mxEl = this._makeMaintenanceBlock(mx, dayDate, dayOff);
          row.appendChild(mxEl);
        }
      }
    }

    this.$rows.appendChild(row);
  }

  _addCancelledRow(cancelled) {
    const lbl = document.createElement("div");
    lbl.className = "ac-label ac-label-cancelled";
    lbl.innerHTML = `
      <span class="ac-reg">⊗ HUỶ</span>
      <span class="ac-sub">${cancelled.length} chuyến</span>
      <span class="ac-bh">cancelled</span>`;
    this.$labelCol.appendChild(lbl);

    const row = document.createElement("div");
    row.className = "gantt-row gantt-row-cancelled";
    row.style.height = ROW_H + "px";
    row.style.minWidth = MINUTES_TOTAL() * PX_PER_MIN + "px";

    const sorted = [...cancelled].sort((a, b) => timeToMin(a.dep_utc) - timeToMin(b.dep_utc));
    for (const s of sorted) row.appendChild(this._makeSectorBlock(s));
    this.$rows.appendChild(row);
  }

  // ── Helper: get the date string for a given day offset from currentDate ──
  _getDayDate(dayOff) {
    if (!this._currentDate) return "";
    const parts = this._currentDate.split("-");
    const d = new Date(+parts[0], +parts[1]-1, +parts[2]);
    d.setDate(d.getDate() + dayOff);
    const y = d.getFullYear();
    const mo = String(d.getMonth()+1).padStart(2,"0");
    const dy = String(d.getDate()).padStart(2,"0");
    return `${y}-${mo}-${dy}`;
  }

  // ── Maintenance block (positional bar respecting start/end time + day offset) ─
  _makeMaintenanceBlock(mx, dayDate, dayOff) {
    // dayDate: YYYY-MM-DD string for this particular day column
    // dayOff: integer day offset (0 = base date, 1 = next day, etc.)
    const colDate = dayDate || this._currentDate;
    const colOff  = dayOff  || 0;

    const el = document.createElement("div");
    el.className = "maintenance-block";
    const color = mx.color || "#f59e0b";
    el.style.background = color + "33";  // ~20% opacity background
    el.style.borderColor = color;

    // Determine position within this day's column (0..MINUTES_PER_DAY)
    const isStartDay = mx.start_date === colDate;
    const isEndDay   = mx.end_date   === colDate;

    let dayLeftMin  = 0;                // within the day (0..1440)
    let dayRightMin = MINUTES_PER_DAY; // within the day

    if (mx.start_time && isStartDay) {
      dayLeftMin = timeToMin(mx.start_time);
    }
    if (mx.end_time && isEndDay) {
      dayRightMin = timeToMin(mx.end_time);
    }

    // Clamp to valid range
    dayLeftMin  = Math.max(0, dayLeftMin);
    dayRightMin = Math.min(MINUTES_PER_DAY, dayRightMin);

    // Absolute position on the full multi-day canvas
    const absLeft  = colOff * MINUTES_PER_DAY + dayLeftMin;
    const absRight = colOff * MINUTES_PER_DAY + dayRightMin;

    el.style.left  = (absLeft  * PX_PER_MIN) + "px";
    el.style.width = (Math.max(absRight - absLeft, 1) * PX_PER_MIN) + "px";

    const timeLabel = (mx.start_time || mx.end_time)
      ? ` (${mx.start_time || "00:00"}–${mx.end_time || "--:--"})`
      : "";
    el.innerHTML = `<span class="mx-label"><i class="fas fa-wrench"></i> ${mx.label || "Maintenance"}${timeLabel}</span>`;
    el.title = `Bảo dưỡng: ${mx.label || "Maintenance"}\n${mx.start_date}${mx.start_time ? " " + mx.start_time : ""} → ${mx.end_date}${mx.end_time ? " " + mx.end_time : ""}`;
    // Allow admin to click to edit
    el.addEventListener("click", e => {
      e.stopPropagation();
      if (window.openMaintenanceModal) window.openMaintenanceModal(mx);
    });
    return el;
  }

  // ── TAT gap marker between two consecutive sectors ─────────────────────────
  _makeTATGap(prev, next) {
    // Account for day offset so TAT gaps position correctly on multi-day canvas
    const prevDayOff = prev._dayOffset !== undefined ? prev._dayOffset : (prev._nextDay ? 1 : 0);
    const nextDayOff = next._dayOffset !== undefined ? next._dayOffset : (next._nextDay ? 1 : 0);

    // Compute absolute arrival minute for 'prev' sector
    // Must mirror _makeSectorBlock logic: if arr <= dep within same day, it's overnight
    const prevDepMin = timeToMin(prev.dep_utc) + prevDayOff * MINUTES_PER_DAY;
    let   arrMin     = timeToMin(prev.arr_utc) + prevDayOff * MINUTES_PER_DAY;
    if (arrMin <= prevDepMin) arrMin += MINUTES_PER_DAY;

    // Compute absolute departure minute for 'next' sector
    const depMin = timeToMin(next.dep_utc) + nextDayOff * MINUTES_PER_DAY;

    const gapMin = depMin - arrMin;
    if (gapMin <= 0) return null;  // overlapping or no gap

    // Determine required TAT (transition takes priority over station-specific rule)
    const dest = prev.destination;
    let reqTAT;
    const mass = state.massTAT || { domestic: 40, international: 60, dom_to_intl: 60, intl_to_dom: 60 };
    // Check for transition TAT first (previous leg type ≠ next leg type)
    // A flight is domestic only if BOTH endpoints are domestic
    const apPrevOrig = state.airports && state.airports[prev.origin];
    const apPrevDest = state.airports && state.airports[prev.destination];
    const apNextOrig = state.airports && state.airports[next.origin];
    const apNextDest = state.airports && state.airports[next.destination];
    const inboundDom = apPrevOrig && apPrevDest && apPrevOrig.is_domestic && apPrevDest.is_domestic;
    const outboundDom = apNextOrig && apNextDest && apNextOrig.is_domestic && apNextDest.is_domestic;
    if (inboundDom !== outboundDom) {
      reqTAT = inboundDom ? (mass.dom_to_intl || mass.international) : (mass.intl_to_dom || mass.domestic);
    } else if (state.tatRules && state.tatRules[dest]) {
      reqTAT = state.tatRules[dest].min_tat_minutes;
    } else {
      const ap = state.airports && state.airports[dest];
      const isDomestic = ap && ap.is_domestic;
      reqTAT = isDomestic ? mass.domestic : mass.international;
    }

    const el = document.createElement("div");
    el.className = "tat-gap";
    if (reqTAT && gapMin < reqTAT) el.classList.add("tat-violation");
    el.style.left  = arrMin * PX_PER_MIN + "px";
    el.style.width = Math.max(gapMin * PX_PER_MIN, 2) + "px";
    if (gapMin >= 15) {
      const gh = Math.floor(gapMin / 60);
      const gm = gapMin % 60;
      el.textContent = gh > 0
        ? `${gh}:${String(gm).padStart(2,"0")}`
        : `${gm}'`;
    }
    el.title = `TAT tại ${dest}: ${gapMin} phút${reqTAT ? ` (yêu cầu ${reqTAT} phút)` : ""}`;
    return el;
  }

  // ── Previous day connection indicator ────────────────────────────────────
  _makePrevDayConnection(prevSector, todaySectors) {
    // Show a ghost indicator at the left edge showing the previous day's last sector
    // and a dashed connection line to today's first sector (if any)
    const el = document.createElement("div");
    el.className = "prev-day-conn";

    // Position: arrival time of prev sector mapped as negative offset from day 0
    // We show a small indicator pinned to the left edge (x=0)
    const arrMin = timeToMin(prevSector.arr_utc);
    const depDisp = this._displayTime(prevSector.dep_utc, prevSector.origin);
    const arrDisp = this._displayTime(prevSector.arr_utc, prevSector.destination);

    el.style.left = "0px";

    // Find today's first sector (day offset 0) for this aircraft
    const todayFirst = todaySectors
      .filter(s => (s._dayOffset === 0 || (!s._dayOffset && !s._nextDay)) && s.status === "active")
      .sort((a, b) => timeToMin(a.dep_utc) - timeToMin(b.dep_utc))[0];

    if (todayFirst) {
      const firstDepMin = timeToMin(todayFirst.dep_utc);
      // Width of the connection indicator: from 0 to first sector's departure
      const width = Math.max(firstDepMin * PX_PER_MIN, 40);
      el.style.width = width + "px";
    } else {
      el.style.width = "120px";
    }

    // Continuity check
    const isContinuous = todayFirst && prevSector.destination === todayFirst.origin;
    if (!isContinuous && todayFirst) {
      el.classList.add("conn-break");
    }

    const prevDate = prevSector.flight_date || "?";
    el.innerHTML = `<span class="prev-day-label">◂ ${prevSector.origin}→${prevSector.destination} ${arrDisp}</span>`;
    el.title = [
      `Chặng cuối ngày trước (${prevDate}):`,
      `${prevSector.origin} → ${prevSector.destination}`,
      `Dep: ${prevSector.dep_utc} UTC  Arr: ${prevSector.arr_utc} UTC`,
      todayFirst ? (isContinuous
        ? `✓ Nối tiếp: hạ cánh ${prevSector.destination} → cất cánh ${todayFirst.origin}`
        : `✗ Gián đoạn: hạ cánh ${prevSector.destination} ≠ cất cánh ${todayFirst.origin}`)
      : "Không có chặng bay hôm nay",
    ].join("\n");

    return el;
  }
  // ── Sector block ────────────────────────────────────────────────────────────
  _makeSectorBlock(sector) {
    // Support both _dayOffset (new) and _nextDay (legacy) for day positioning
    const dayOff   = sector._dayOffset !== undefined ? sector._dayOffset : (sector._nextDay ? 1 : 0);
    const isNonBase= dayOff > 0;
    const depMin = timeToMin(sector.dep_utc) + dayOff * MINUTES_PER_DAY;
    let   arrMin = timeToMin(sector.arr_utc) + dayOff * MINUTES_PER_DAY;
    if (arrMin <= depMin) arrMin += MINUTES_PER_DAY; // overnight flight
    const btMin = arrMin - depMin;

    const left  = depMin * PX_PER_MIN;
    const width = Math.max(btMin * PX_PER_MIN, 8);

    const el = document.createElement("div");
    el.className = "sector-block";
    if (sector.status === "cancelled")        el.classList.add("cancelled");
    if (this._errorIds.has(sector.id))        el.classList.add("has-error");
    else if (this._warningIds.has(sector.id)) el.classList.add("has-warning");
    // next-day sectors are styled identically to day-0 (no separate class)

    el.dataset.sectorId = sector.id;
    el.style.left  = left  + "px";
    el.style.width = width + "px";

    const rcKey = `${sector.origin}-${sector.destination}`;
    // When route coloring is enabled:
    //   - sectors WITH a matching route color → use that color
    //   - sectors WITHOUT a match → silver/grey to visually distinguish them
    // When disabled, normal priority: sector.color → ac.color → hash
    let bg;
    if (this._routeColorMap) {
      bg = this._routeColorMap[rcKey] || "#a0a0b0";
    } else {
      bg = sector.color
        || (this._acColorMap && this._acColorMap[sector.aircraft_id])
        || routeColor(sector.origin, sector.destination);
    }
    if (sector.status === "cancelled") {
      el.style.background = "rgba(60,60,70,0.8)";
    } else {
      el.style.background = bg;
    }

    // Auto text color based on background luminance
    const txtColor = sector.status === "cancelled" ? "#fff" : getContrastColor(bg);
    el.style.color = txtColor;
    // Adapt text-shadow: light shadow for dark text, dark shadow for light text
    el.style.textShadow = txtColor === "#000"
      ? "0 1px 2px rgba(255,255,255,0.3)"
      : "0 1px 2px rgba(0,0,0,0.4)";

    // Times display (LCT or UTC per selected mode)
    const depDisp = this._displayTime(sector.dep_utc, sector.origin);
    const arrDisp = this._displayTime(sector.arr_utc, sector.destination);

    // Block time string
    const btStr = formatDuration(btMin);

    // Adaptive content based on available width
    const showRoute = width >= 44;
    const showTime  = width >= 90;
    const showBT    = width >= 120;
    const showFN    = width >= 70 && sector.flight_number;

    // 2-column layout: left = route/time/BT (3 lines), right = flight number
    const leftParts = [];
    if (showRoute) leftParts.push(`<span class="sector-route">${sector.origin}→${sector.destination}</span>`);
    if (showTime)  leftParts.push(`<span class="sector-time">${depDisp}–${arrDisp}</span>`);
    if (showBT)    leftParts.push(`<span class="sector-bt">${btStr}</span>`);

    const rightPart = showFN ? `<div class="sector-col-right"><span class="sector-fn">${sector.flight_number}</span></div>` : "";

    el.innerHTML = `<div class="sector-col-left">${leftParts.join("")}</div>${rightPart}`;

    // Rich tooltip with both UTC and LCT per airport
    const depAp = this._airports[sector.origin];
    const arrAp = this._airports[sector.destination];
    const depOff = depAp ? depAp.timezone_offset : 7;
    const arrOff = arrAp ? arrAp.timezone_offset : 7;
    const depLCT = applyTZ(sector.dep_utc, depOff);
    const arrLCT = applyTZ(sector.arr_utc, arrOff);
    el.title = [
      `${sector.origin} → ${sector.destination}${sector.flight_number ? "  (" + sector.flight_number + ")" : ""}`,
      isNonBase ? `[Ngày +${dayOff} — ${sector.flight_date}]` : "",
      `Dep UTC:${sector.dep_utc}  LCT(+${depOff}): ${depLCT}`,
      `Arr UTC:${sector.arr_utc}  LCT(+${arrOff}): ${arrLCT}`,
      `Block: ${btMin}′ (${btStr})`,
      sector.status === "cancelled" ? "⊗ ĐÃ HUỶ" : "",
      sector.status !== "cancelled" ? "↔ Kéo để thay đổi giờ bay" : "",
      sector.status !== "cancelled" ? "⇧+Kéo sang dòng khác để chuyển cả line" : "",
    ].filter(Boolean).join("\n");

    // Register this element so we can re-apply selection state later
    this._sectorEls.set(sector.id, el);
    if (this._selectedSectors.has(sector.id)) el.classList.add("selected");

    // ── HTML5 drag for cross-row move ────────────────────────────────────────
    el.setAttribute("draggable", "true");
    el.addEventListener("dragstart", e => {
      // If time-drag has activated (mouse moved), suppress HTML5 drag
      if (this._timeDrag && this._timeDrag.activated) {
        e.preventDefault();
        return;
      }
      // Otherwise clear any pending time-drag state and proceed with cross-row drag
      if (this._timeDrag) {
        document.body.style.userSelect = "";
        this._timeDrag = null;
      }
      this._dragSectorId   = sector.id;
      this._dragAircraftId = sector.aircraft_id;

      // Shift+drag: move the ENTIRE ROW (all sectors of this aircraft)
      if (e.shiftKey) {
        this._dragShiftRow = true;
        this._clearSelection();
        this._dragSelectedIds = [];
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(sector.id));
        el.classList.add("dragging");
        // Visual cue: add row-dragging class to the label
        const lbl = this.$labelCol.querySelector(`.ac-label[data-ac-id="${sector.aircraft_id}"]`);
        if (lbl) lbl.classList.add("row-dragging");
        return;
      }

      this._dragShiftRow = false;

      // If this sector is part of the multi-selection, drag ALL selected.
      // Otherwise deselect all and drag only this one.
      if (this._selectedSectors.has(sector.id)) {
        this._dragSelectedIds = [...this._selectedSectors];
      } else {
        this._clearSelection();
        this._dragSelectedIds = [sector.id];
      }

      el.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(sector.id));
    });
    el.addEventListener("dragend", () => {
      el.classList.remove("dragging");
      if (this._dragShiftRow) {
        // Remove row-dragging from label
        const lbl = this.$labelCol.querySelector(`.ac-label[data-ac-id="${sector.aircraft_id}"]`);
        if (lbl) lbl.classList.remove("row-dragging");
        this._dragShiftRow = false;
      }
    });

    // ── Mouse-based time drag (drag within same row to shift time) ───────────
    if (sector.status !== "cancelled") {
      el.addEventListener("mousedown", e => this._onTimeDragStart(e, sector, el));
    }

    // Clicks (only fire if we didn't just do a time-drag)
    el.addEventListener("click", e => {
      e.stopPropagation();
      if (this._timeDragOccurred) { this._timeDragOccurred = false; return; }
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+click: toggle selection
        this._toggleSelect(sector.id, el);
        return;
      }
      // Normal click: clear selection, then open modal
      this._clearSelection();
      if (this.onSectorClick) this.onSectorClick(sector);
    });
    el.addEventListener("contextmenu", e => {
      e.preventDefault();
      e.stopPropagation();
      if (this.onSectorRightClick) this.onSectorRightClick(sector, e.clientX, e.clientY);
    });

    return el;
  }

  // ── Multi-select helpers ─────────────────────────────────────────────────────
  _toggleSelect(sectorId, el) {
    if (this._selectedSectors.has(sectorId)) {
      this._selectedSectors.delete(sectorId);
      el.classList.remove("selected");
    } else {
      this._selectedSectors.add(sectorId);
      el.classList.add("selected");
    }
    if (this.onSelectionChange) this.onSelectionChange(this._selectedSectors.size);
  }

  _clearSelection() {
    for (const id of this._selectedSectors) {
      const el = this._sectorEls.get(id);
      if (el) el.classList.remove("selected");
    }
    this._selectedSectors.clear();
    if (this.onSelectionChange) this.onSelectionChange(0);
  }

  // ── Same-row time drag ──────────────────────────────────────────────────────
  _onTimeDragStart(e, sector, el) {
    // Only left mouse button; ignore right-click / middle-click
    if (e.button !== 0) return;
    // Don't preventDefault here — let dragstart fire; we suppress it there if needed

    const dayOff = sector._dayOffset !== undefined ? sector._dayOffset : (sector._nextDay ? 1 : 0);
    const depMin = timeToMin(sector.dep_utc) + dayOff * MINUTES_PER_DAY;
    let   arrMin = timeToMin(sector.arr_utc) + dayOff * MINUTES_PER_DAY;
    if (arrMin <= depMin) arrMin += 1440;
    const btMin = arrMin - depMin;

    this._timeDrag = {
      sector,
      el,
      startX       : e.clientX,
      startDepMin  : depMin,
      btMin,
      dayOff,
      scrollLeft   : this.$scrollArea.scrollLeft,
      activated    : false,   // becomes true once mouse moves > threshold
    };

    document.body.style.userSelect = "none";
  }

  _bindTimeDragGlobal() {
    const DRAG_THRESHOLD = 5; // pixels before drag activates

    document.addEventListener("mousemove", e => {
      if (!this._timeDrag) return;
      const { sector, el, startX, startDepMin, btMin } = this._timeDrag;

      // Delta in pixels → minutes (account for scroll change)
      const scrollDelta = this.$scrollArea.scrollLeft - this._timeDrag.scrollLeft;
      const pxDelta = (e.clientX - startX) + scrollDelta;

      // Activate drag only after threshold is exceeded
      if (!this._timeDrag.activated) {
        if (Math.abs(pxDelta) < DRAG_THRESHOLD) return;
        this._timeDrag.activated = true;
        el.classList.add("time-dragging");
        document.body.style.cursor = "ew-resize";
        this._showTimeDragTooltip(el, sector.dep_utc, sector.arr_utc);
      }

      const minDelta = Math.round(pxDelta / PX_PER_MIN);

      // Snap to 5-minute increments
      const snappedDelta = Math.round(minDelta / 5) * 5;

      let newDepMin = startDepMin + snappedDelta;
      // Clamp within canvas
      newDepMin = Math.max(0, Math.min(MINUTES_TOTAL() - btMin, newDepMin));

      const newArrMin = newDepMin + btMin;
      const newDayOff = Math.floor(newDepMin / 1440);
      const newDepUtc = minToTime(newDepMin);
      const newArrUtc = minToTime(newArrMin);

      // Compute new flight_date if day offset changed
      const newFlightDate = this._getDayDate(newDayOff);

      // Check overlap with other sectors on the same row
      const overlap = this._checkTimeDragOverlap(sector, newDepMin, newArrMin);
      el.classList.toggle("overlap-blocked", overlap);

      // Update element position live
      el.style.left  = (newDepMin * PX_PER_MIN) + "px";
      el.style.width = (btMin * PX_PER_MIN) + "px";

      // Update tooltip
      this._updateTimeDragTooltip(newDepUtc, newArrUtc, snappedDelta);

      this._timeDrag._currentDepUtc = newDepUtc;
      this._timeDrag._currentArrUtc = newArrUtc;
      this._timeDrag._snappedDelta  = snappedDelta;
      this._timeDrag._newFlightDate = newFlightDate;

      if (Math.abs(snappedDelta) > 0) this._timeDragOccurred = true;
    });

    document.addEventListener("mouseup", async e => {
      if (!this._timeDrag) return;
      const { sector, el, _currentDepUtc, _currentArrUtc, activated, _snappedDelta, _newFlightDate } = this._timeDrag;

      el.classList.remove("time-dragging");
      el.classList.remove("overlap-blocked");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      this._hideTimeDragTooltip();
      this._timeDrag = null;

      // Block commit if overlap was detected
      if (activated && el.dataset.overlapBlocked === "1") {
        // Reset position
        const dOff = sector._dayOffset || 0;
        const origDep = timeToMin(sector.dep_utc) + dOff * MINUTES_PER_DAY;
        let origArr = timeToMin(sector.arr_utc) + dOff * MINUTES_PER_DAY;
        if (origArr <= origDep) origArr += 1440;
        el.style.left  = (origDep * PX_PER_MIN) + "px";
        el.style.width = ((origArr - origDep) * PX_PER_MIN) + "px";
        delete el.dataset.overlapBlocked;
        this._timeDragOccurred = false;
        return;
      }

      // Only save if drag was activated and position actually moved
      if (activated && _currentDepUtc && (_currentDepUtc !== sector.dep_utc || _newFlightDate !== sector.flight_date) && this.onTimeChange) {
        // Build list of sector IDs to shift: if dragged sector is in multi-select,
        // shift all selected; otherwise just the one sector.
        const idsToShift = this._selectedSectors.has(sector.id)
          ? [...this._selectedSectors]
          : [sector.id];

        // Fire onTimeChange for each; pass the delta minutes alongside so app.js can compute per-sector times
        if (idsToShift.length === 1) {
          await this.onTimeChange(sector.id, _currentDepUtc, _currentArrUtc, _snappedDelta, _newFlightDate);
        } else {
          // For multi-select time shift, call onTimeChange with the delta
          await this.onTimeChange(idsToShift, null, null, _snappedDelta);
        }
      }
    });

    // Cancel on Escape — also clears multi-select
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        // Clear multi-select
        this._clearSelection();

        if (this._timeDrag) {
          const { sector, el, dayOff } = this._timeDrag;
          // Reset position (account for dayOffset)
          const dOff = dayOff || 0;
          const depMin = timeToMin(sector.dep_utc) + dOff * MINUTES_PER_DAY;
          let arrMin = timeToMin(sector.arr_utc) + dOff * MINUTES_PER_DAY;
          if (arrMin <= depMin) arrMin += 1440;
          el.style.left  = (depMin * PX_PER_MIN) + "px";
          el.style.width = ((arrMin - depMin) * PX_PER_MIN) + "px";

          el.classList.remove("time-dragging");
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
          this._hideTimeDragTooltip();
          this._timeDrag = null;
          this._timeDragOccurred = false;
        }
      }
    });
  }

  _showTimeDragTooltip(el, depUtc, arrUtc) {
    let tip = document.getElementById("_ganttTimeDragTip");
    if (!tip) {
      tip = document.createElement("div");
      tip.id = "_ganttTimeDragTip";
      tip.className = "gantt-time-drag-tip";
      document.body.appendChild(tip);
    }
    this._updateTimeDragTooltip(depUtc, arrUtc, 0);
    tip.classList.add("visible");
  }

  _updateTimeDragTooltip(depUtc, arrUtc, deltaMin) {
    const tip = document.getElementById("_ganttTimeDragTip");
    if (!tip) return;

    const sign = deltaMin >= 0 ? "+" : "";
    tip.innerHTML = `
      <span class="tip-time">🛫 ${depUtc} UTC</span>
      <span class="tip-sep">→</span>
      <span class="tip-time">🛬 ${arrUtc} UTC</span>
      ${deltaMin !== 0 ? `<span class="tip-delta">${sign}${deltaMin} phút</span>` : ""}
    `;

    // Position near cursor
    tip.style.display = "flex";
  }

  _hideTimeDragTooltip() {
    const tip = document.getElementById("_ganttTimeDragTip");
    if (tip) { tip.classList.remove("visible"); tip.style.display = "none"; }
  }

  // ── Overlap check for time-drag (same aircraft row) ─────────────────────────
  _checkTimeDragOverlap(draggedSector, newDepMin, newArrMin) {
    const acId = draggedSector.aircraft_id;
    const sectors = this._sectors.filter(
      s => s.aircraft_id === acId && s.status === "active" && s.id !== draggedSector.id
    );
    for (const s of sectors) {
      const dayOff = s._dayOffset !== undefined ? s._dayOffset : 0;
      const sDep = timeToMin(s.dep_utc) + dayOff * MINUTES_PER_DAY;
      let   sArr = timeToMin(s.arr_utc) + dayOff * MINUTES_PER_DAY;
      if (sArr <= sDep) sArr += MINUTES_PER_DAY;
      // Overlap: [a,b) ∩ [c,d) ≠ ∅  ↔  a < d && c < b
      if (newDepMin < sArr && sDep < newArrMin) {
        // Tag the element so mouseup can detect it
        const el = this._timeDrag && this._timeDrag.el;
        if (el) el.dataset.overlapBlocked = "1";
        return true;
      }
    }
    const el = this._timeDrag && this._timeDrag.el;
    if (el) delete el.dataset.overlapBlocked;
    return false;
  }

  // ── Drag-drop handlers (cross-row: move to another aircraft) ────────────────
  _attachDropHandlers(row, targetAcId) {
    row.addEventListener("dragover", e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", async e => {
      e.preventDefault();
      row.classList.remove("drag-over");

      // ── Row-level drag (move ALL sectors from one aircraft to another) ──
      const rowDragData = e.dataTransfer.getData("application/x-row-drag");
      if (rowDragData) {
        const fromAcId = parseInt(rowDragData, 10);
        if (fromAcId !== targetAcId && this.onRowDrop) {
          await this.onRowDrop(fromAcId, targetAcId);
        }
        return;
      }

      // ── Shift+sector drag: treat as row-level drop ──────────────────────
      if (this._dragShiftRow) {
        const fromAcId = this._dragAircraftId;
        this._dragShiftRow = false;
        if (fromAcId != null && fromAcId !== targetAcId && this.onRowDrop) {
          await this.onRowDrop(fromAcId, targetAcId);
        }
        return;
      }

      // ── Sector-level drag (move individual sectors) ──
      const sId = this._dragSectorId;
      const fromAcId = this._dragAircraftId;
      if (!sId) return;

      // Collect sector IDs to move; skip if all are already on the target row
      const idsToMove = (this._dragSelectedIds && this._dragSelectedIds.length > 0)
        ? this._dragSelectedIds
        : [sId];

      // Filter out any sectors already on the target aircraft
      const filteredIds = idsToMove.filter(id => {
        const sec = this._sectors && this._sectors.find(s => s.id === id);
        return sec && sec.aircraft_id !== targetAcId;
      });

      if (filteredIds.length === 0) return;

      if (this.onDrop) await this.onDrop(filteredIds, fromAcId, targetAcId);
    });
  }

  // ── Time display helper ─────────────────────────────────────────────────────
  _displayTime(utcTime, airportCode) {
    if (this._timezone === "UTC") return utcTime;
    const ap = this._airports[airportCode];
    const offset = ap ? ap.timezone_offset : 7;
    return applyTZ(utcTime, offset);
  }

  // ── Sync label col scroll with rows ────────────────────────────────────────
  _syncScroll() {
    this.$scrollArea.addEventListener("scroll", () => {
      this.$labelCol.scrollTop = this.$scrollArea.scrollTop;
    });
  }

  // ── Row reorder (drag aircraft lines up/down) ──────────────────────────────
  _startRowDrag(lbl, acId, startY) {
    const labels = [...this.$labelCol.querySelectorAll(".ac-label:not(.ac-label-cancelled)")];
    const rows   = [...this.$rows.querySelectorAll(".gantt-row")];
    const idx    = labels.indexOf(lbl);
    if (idx === -1) return;

    lbl.classList.add("row-dragging");
    document.body.style.cursor = "grabbing";

    this._rowDrag = {
      lbl, acId, startY, idx, currentIdx: idx, labels, rows,
      labelH: lbl.offsetHeight,
    };
  }

  _bindRowDragGlobal() {
    document.addEventListener("mousemove", e => {
      if (!this._rowDrag) return;
      const { lbl, startY, idx, labels, labelH } = this._rowDrag;
      const dy = e.clientY - startY;
      const moveBy = Math.round(dy / labelH);
      let newIdx = idx + moveBy;
      newIdx = Math.max(0, Math.min(labels.length - 1, newIdx));

      if (newIdx !== this._rowDrag.currentIdx) {
        this._rowDrag.currentIdx = newIdx;
        // visual reorder: move label and gantt row in DOM
        const refLabel = newIdx < idx
          ? labels[newIdx]
          : (labels[newIdx + 1] || null);
        this.$labelCol.insertBefore(lbl, refLabel);

        // Also reorder the corresponding gantt row
        const rows = this._rowDrag.rows;
        const ganttRow = rows[idx];
        const refRow = newIdx < idx
          ? rows[newIdx]
          : (rows[newIdx + 1] || null);
        this.$rows.insertBefore(ganttRow, refRow);

        // Update the arrays to reflect the new order
        labels.splice(idx, 1);
        labels.splice(newIdx, 0, lbl);
        rows.splice(idx, 1);
        rows.splice(newIdx, 0, ganttRow);

        // Update idx to current position for next calculation
        this._rowDrag.idx = newIdx;
        this._rowDrag.startY = e.clientY;

        // Show drop indicator
        labels.forEach(l => l.classList.remove("row-drag-above", "row-drag-below"));
      }
    });

    document.addEventListener("mouseup", () => {
      if (!this._rowDrag) return;
      const { lbl } = this._rowDrag;
      lbl.classList.remove("row-dragging");
      document.body.style.cursor = "";

      // Read final order from DOM
      const finalLabels = [...this.$labelCol.querySelectorAll(".ac-label:not(.ac-label-cancelled)")];
      const orderedIds = finalLabels.map(l => parseInt(l.dataset.acId, 10));

      this._rowDrag = null;

      // Fire callback
      if (this.onReorder) this.onReorder(orderedIds);
    });
  }

  // ── Public: get currently selected sector IDs ───────────────────────────────
  getSelectedSectorIds() {
    return [...this._selectedSectors];
  }

  // ── Hide floating tooltips during any drag operation ───────────────────────
  _bindDragCleanup() {
    document.addEventListener("dragstart", () => {
      // Remove any lingering ac-tooltip that was appended to body
      document.querySelectorAll(".ac-tooltip-fixed").forEach(t => t.remove());
    });
  }

  _editAircraftLabel(ac) {
    // Delegate upward; App handles the modal
    document.dispatchEvent(new CustomEvent("edit-aircraft", { detail: ac }));
  }
}

