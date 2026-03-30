/* gantt.js – Renders the Gantt chart and handles drag-and-drop */

const MINUTES_TOTAL = 1500;   // 25 h shown (covers slight overnight)
const PX_PER_MIN   = 2;       // zoom: 2px per minute → 3000px wide
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
  }

  // ── Public render ───────────────────────────────────────────────────────────
  render({ aircraft, sectors, airports, timezone, warnings, maintenance, currentDate }) {
    this._aircraft    = aircraft;
    this._sectors     = sectors;
    this._airports    = airports;
    this._timezone    = timezone;
    this._maintenance = maintenance || [];
    this._currentDate = currentDate || "";

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

    // Rebuild ruler with current timezone
    this._buildRuler();

    this.$labelCol.innerHTML = "";
    this.$rows.innerHTML     = "";

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

    // Set total width
    const totalW = MINUTES_TOTAL * PX_PER_MIN;
    this.$ruler.style.width = totalW + "px";
    this.$rows.style.width  = totalW + "px";
  }

  // ── Ruler (dual row: UTC top, LCT bottom) ──────────────────────────────────
  _buildRuler() {
    this.$ruler.innerHTML = "";
    const totalHours = Math.ceil(MINUTES_TOTAL / 60);

    // Top row: UTC hours
    const utcRow = document.createElement("div");
    utcRow.className = "ruler-row ruler-row-utc";

    // Bottom row: LCT hours
    const lctRow = document.createElement("div");
    lctRow.className = "ruler-row ruler-row-lct";

    for (let h = 0; h < totalHours; h++) {
      // UTC cell
      const utcEl = document.createElement("div");
      utcEl.className = "ruler-hour";
      utcEl.textContent = String(h % 24).padStart(2, "0") + ":00";
      if (h % 24 === 0 && h > 0) utcEl.classList.add("ruler-midnight");
      utcRow.appendChild(utcEl);

      // LCT cell (UTC+7)
      const lctEl = document.createElement("div");
      lctEl.className = "ruler-hour ruler-hour-lct";
      const lctH = (h + 7) % 24;
      lctEl.textContent = String(lctH).padStart(2, "0") + ":00";
      if (lctH === 0 && h > 0) lctEl.classList.add("ruler-midnight");
      lctRow.appendChild(lctEl);
    }

    // TZ labels at far-right
    const utcBadge = document.createElement("div");
    utcBadge.className = "ruler-tz-badge";
    utcBadge.textContent = "UTC";
    utcRow.appendChild(utcBadge);

    const lctBadge = document.createElement("div");
    lctBadge.className = "ruler-tz-badge ruler-tz-badge-lct";
    lctBadge.textContent = "LCT+7";
    lctRow.appendChild(lctBadge);

    this.$ruler.appendChild(utcRow);
    this.$ruler.appendChild(lctRow);
  }

  // ── Row builders ────────────────────────────────────────────────────────────
  _addAircraftRow(ac, sectors) {
    // Compute total block hours for this aircraft today
    const totalBMin = sectors.reduce((sum, s) => {
      let d = timeToMin(s.dep_utc), a = timeToMin(s.arr_utc);
      if (a <= d) a += 1440;
      return sum + (a - d);
    }, 0);
    const bh = Math.floor(totalBMin / 60);
    const bm = totalBMin % 60;
    const bhStr = `${bh}h${String(bm).padStart(2,"00")}m`;

    // Color swatch for aircraft
    const acColor = this._acColorMap[ac.id];
    const swatchHtml = acColor
      ? `<span class="color-swatch" style="background:${acColor};"></span>`
      : "";

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
      <span class="ac-bh" title="Tổng block hôm nay">${bhStr}</span>`;
    
    // Rich hover tooltip for registration info — appended to body to escape overflow:hidden
    if (ac.registration_info) {
      const tipHTML = `
        <div class="ac-tip-header">${ac.registration}</div>
        <div class="ac-tip-row"><span class="ac-tip-label">Mẫu máy bay</span><span class="ac-tip-val">${ac.registration_info.aircraft_model}</span></div>
        <div class="ac-tip-row"><span class="ac-tip-label">Số ghế</span><span class="ac-tip-val">${ac.registration_info.seats}</span></div>
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
    row.style.minWidth = MINUTES_TOTAL * PX_PER_MIN + "px";

    this._attachDropHandlers(row, ac.id);

    // Sort by dep time; render blocks + TAT gaps between consecutive sectors
    const sorted = [...sectors].sort((a, b) => timeToMin(a.dep_utc) - timeToMin(b.dep_utc));
    for (let i = 0; i < sorted.length; i++) {
      row.appendChild(this._makeSectorBlock(sorted[i]));
      if (i < sorted.length - 1) {
        const gap = this._makeTATGap(sorted[i], sorted[i + 1]);
        if (gap) row.appendChild(gap);
      }
    }

    // Render maintenance blocks for this aircraft on current date
    const mxBlocks = (this._maintenance || []).filter(m => m.aircraft_id === ac.id);
    for (const mx of mxBlocks) {
      if (mx.start_date <= this._currentDate && mx.end_date >= this._currentDate) {
        const mxEl = this._makeMaintenanceBlock(mx);
        row.appendChild(mxEl);
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
    row.style.minWidth = MINUTES_TOTAL * PX_PER_MIN + "px";

    const sorted = [...cancelled].sort((a, b) => timeToMin(a.dep_utc) - timeToMin(b.dep_utc));
    for (const s of sorted) row.appendChild(this._makeSectorBlock(s));
    this.$rows.appendChild(row);
  }

  // ── Maintenance block (full-width bar for the day) ─────────────────────────
  _makeMaintenanceBlock(mx) {
    const el = document.createElement("div");
    el.className = "maintenance-block";
    const color = mx.color || "#f59e0b";
    el.style.background = color + "33";  // ~20% opacity background
    el.style.borderColor = color;
    el.style.left  = "0px";
    el.style.width = (MINUTES_TOTAL * PX_PER_MIN) + "px";
    el.innerHTML = `<span class="mx-label"><i class="fas fa-wrench"></i> ${mx.label || "Maintenance"}</span>`;
    el.title = `Bảo dưỡng: ${mx.label || "Maintenance"}\n${mx.start_date} → ${mx.end_date}`;
    // Allow admin to click to edit
    el.addEventListener("click", e => {
      e.stopPropagation();
      if (window.openMaintenanceModal) window.openMaintenanceModal(mx);
    });
    return el;
  }

  // ── TAT gap marker between two consecutive sectors ─────────────────────────
  _makeTATGap(prev, next) {
    const arrMin = timeToMin(prev.arr_utc);
    let   depMin = timeToMin(next.dep_utc);
    if (depMin < arrMin) depMin += 1440;
    const gapMin = depMin - arrMin;
    if (gapMin <= 0) return null;

    // Determine required TAT (station-specific or mass default)
    const dest = prev.destination;
    let reqTAT;
    if (state.tatRules[dest]) {
      reqTAT = state.tatRules[dest].min_tat_minutes;
    } else {
      const ap = state.airports[dest];
      const isDomestic = ap && ap.timezone_offset === 7;
      reqTAT = isDomestic ? state.massTAT.domestic : state.massTAT.international;
    }

    const el = document.createElement("div");
    el.className = "tat-gap";
    if (gapMin < reqTAT) el.classList.add("tat-violation");
    el.style.left  = arrMin * PX_PER_MIN + "px";
    el.style.width = Math.max(gapMin * PX_PER_MIN, 2) + "px";
    if (gapMin >= 15) el.textContent = gapMin + "′";
    el.title = `TAT tại ${dest}: ${gapMin} phút (yêu cầu ${reqTAT} phút)`;
    return el;
  }

  // ── Sector block ────────────────────────────────────────────────────────────
  _makeSectorBlock(sector) {
    const depMin = timeToMin(sector.dep_utc);
    let   arrMin = timeToMin(sector.arr_utc);
    if (arrMin <= depMin) arrMin += 1440; // overnight
    const btMin = arrMin - depMin;

    const left  = depMin * PX_PER_MIN;
    const width = Math.max(btMin * PX_PER_MIN, 8);

    const el = document.createElement("div");
    el.className = "sector-block";
    if (sector.status === "cancelled")        el.classList.add("cancelled");
    if (this._errorIds.has(sector.id))        el.classList.add("has-error");
    else if (this._warningIds.has(sector.id)) el.classList.add("has-warning");

    el.dataset.sectorId = sector.id;
    el.style.left  = left  + "px";
    el.style.width = width + "px";

    const bg = sector.color
      || (this._acColorMap && this._acColorMap[sector.aircraft_id])
      || routeColor(sector.origin, sector.destination);
    el.style.background = sector.status === "cancelled"
      ? "rgba(60,60,70,0.8)"
      : bg;

    // Times display (LCT or UTC per selected mode)
    const depDisp = this._displayTime(sector.dep_utc, sector.origin);
    const arrDisp = this._displayTime(sector.arr_utc, sector.destination);

    // Block time string
    const bh = Math.floor(btMin / 60);
    const bm = btMin % 60;
    const btStr = `${bh}h${String(bm).padStart(2,"00")}m`;

    // Adaptive content based on available width
    const showRoute = width >= 44;
    const showTime  = width >= 90;
    const showBT    = width >= 120;
    const showFN    = width >= 70 && sector.flight_number;

    el.innerHTML = `
      ${showRoute ? `<span class="sector-route">${sector.origin}→${sector.destination}</span>` : ""}
      ${showTime  ? `<span class="sector-time">${depDisp}–${arrDisp}</span>` : ""}
      ${showBT    ? `<span class="sector-bt">${btStr}</span>` : ""}
      ${showFN    ? `<span class="sector-fn">${sector.flight_number}</span>` : ""}
    `;

    // Rich tooltip with both UTC and LCT per airport
    const depAp = this._airports[sector.origin];
    const arrAp = this._airports[sector.destination];
    const depOff = depAp ? depAp.timezone_offset : 7;
    const arrOff = arrAp ? arrAp.timezone_offset : 7;
    const depLCT = applyTZ(sector.dep_utc, depOff);
    const arrLCT = applyTZ(sector.arr_utc, arrOff);
    el.title = [
      `${sector.origin} → ${sector.destination}${sector.flight_number ? "  (" + sector.flight_number + ")" : ""}`,
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
  }

  _clearSelection() {
    for (const id of this._selectedSectors) {
      const el = this._sectorEls.get(id);
      if (el) el.classList.remove("selected");
    }
    this._selectedSectors.clear();
  }

  // ── Same-row time drag ──────────────────────────────────────────────────────
  _onTimeDragStart(e, sector, el) {
    // Only left mouse button; ignore right-click / middle-click
    if (e.button !== 0) return;
    // Don't preventDefault here — let dragstart fire; we suppress it there if needed

    const depMin = timeToMin(sector.dep_utc);
    let   arrMin = timeToMin(sector.arr_utc);
    if (arrMin <= depMin) arrMin += 1440;
    const btMin = arrMin - depMin;

    this._timeDrag = {
      sector,
      el,
      startX       : e.clientX,
      startDepMin  : depMin,
      btMin,
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
      // Clamp within 25h canvas
      newDepMin = Math.max(0, Math.min(MINUTES_TOTAL - btMin, newDepMin));

      const newArrMin = newDepMin + btMin;
      const newDepUtc = minToTime(newDepMin);
      const newArrUtc = minToTime(newArrMin);

      // Update element position live
      el.style.left  = (newDepMin * PX_PER_MIN) + "px";
      el.style.width = (btMin * PX_PER_MIN) + "px";

      // Update tooltip
      this._updateTimeDragTooltip(newDepUtc, newArrUtc, snappedDelta);

      this._timeDrag._currentDepUtc = newDepUtc;
      this._timeDrag._currentArrUtc = newArrUtc;
      this._timeDrag._snappedDelta  = snappedDelta;

      if (Math.abs(snappedDelta) > 0) this._timeDragOccurred = true;
    });

    document.addEventListener("mouseup", async e => {
      if (!this._timeDrag) return;
      const { sector, el, _currentDepUtc, _currentArrUtc, activated, _snappedDelta } = this._timeDrag;

      el.classList.remove("time-dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      this._hideTimeDragTooltip();
      this._timeDrag = null;

      // Only save if drag was activated and position actually moved
      if (activated && _currentDepUtc && _currentDepUtc !== sector.dep_utc && this.onTimeChange) {
        // Build list of sector IDs to shift: if dragged sector is in multi-select,
        // shift all selected; otherwise just the one sector.
        const idsToShift = this._selectedSectors.has(sector.id)
          ? [...this._selectedSectors]
          : [sector.id];

        // Fire onTimeChange for each; pass the delta minutes alongside so app.js can compute per-sector times
        if (idsToShift.length === 1) {
          await this.onTimeChange(sector.id, _currentDepUtc, _currentArrUtc);
        } else {
          // For multi-select time shift, call onTimeChange with the delta
          // We pass an array signature: onTimeChange(ids, deltaMin)
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
          const { sector, el } = this._timeDrag;
          // Reset position
          const depMin = timeToMin(sector.dep_utc);
          let arrMin = timeToMin(sector.arr_utc);
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

