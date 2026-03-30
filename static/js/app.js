/* app.js – Main application controller */

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  currentDate : todayStr(),
  timezone    : "LCT",
  viewMode    : "day",   // "day" | "week" | "month"
  aircraft    : [],
  sectors     : [],
  airports    : {},             // keyed by code
  blockTimeRules: {},           // keyed by "ORIG-DEST"
  tatRules    : {},             // keyed by station
  massTAT     : { domestic: 40, international: 60 },
  warnings    : [],
  seasons     : [],             // Season objects from API
  maintenance : [],             // MaintenanceBlock objects
  currentSeason: null,          // currently active Season or null
  lastExportData : null,
  lastReportData : null,
  userRole    : "viewer",       // "admin" | "viewer" — loaded from /api/auth/me
  username    : "",
  clipboard   : null,           // { type:'sectors'|'line', sectors:[...], sourceAcId, sourceDate }
};

const history = new HistoryManager();

// ─── Sector modal TZ mode ────────────────────────────────────────────────────
// Tracks whether the sector modal time inputs are in UTC or LCT mode.
let sectorModalTZ = "UTC";

// ─── Gantt instance ──────────────────────────────────────────────────────────
let gantt;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function timeToMin(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function minToTime(m) {
  m = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Convert minutes to decimal hours string, e.g. 90 → "01,50", 165 → "02,75" */
function minToDecimal(m) {
  const hours = Math.floor(m / 60);
  const frac  = Math.round((m % 60) / 60 * 100);
  return `${String(hours).padStart(2, "0")},${String(frac).padStart(2, "0")}`;
}

function blockMin(dep, arr) {
  let d = timeToMin(dep), a = timeToMin(arr);
  if (a <= d) a += 1440;
  return a - d;
}

function applyTZ(hhmm, offset) {
  return minToTime(timeToMin(hhmm) + Math.round(offset * 60));
}

function formatBH(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h${String(m).padStart(2,"0")}m`;
}

function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  try {
  gantt = new GanttChart({
    labelCol   : document.getElementById("ganttLabelCol"),
    scrollArea : document.getElementById("ganttScrollArea"),
    ruler      : document.getElementById("ganttRuler"),
    rows       : document.getElementById("ganttRows"),
    onSectorClick      : handleSectorClick,
    onSectorRightClick : handleSectorRightClick,
    onDrop             : handleSectorDrop,
    onTimeChange       : handleSectorTimeChange,
    onReorder          : handleAircraftReorder,
    onRowDrop          : handleRowDrop,
  });

  history.onchange = (canUndo, canRedo) => {
    document.getElementById("btnUndo").disabled = !canUndo;
    document.getElementById("btnRedo").disabled = !canRedo;
  };

  // Set today
  document.getElementById("currentDate").value = state.currentDate;
  updateDateLabel();

  await loadCurrentUser();
  await loadReferenceData();
  await refreshView();

  bindUI();
  } catch (err) {
    console.error("INIT CRASH:", err);
    alert("Lỗi khởi động ứng dụng: " + err.message);
  }
}

// ─── Data loading ─────────────────────────────────────────────────────────────
async function loadCurrentUser() {
  try {
    const me = await fetch("/api/auth/me").then(r => r.json());
    state.userRole = me.role || "viewer";
    state.username = me.username || "";
    applyRoleUI();
  } catch {}
}

function applyRoleUI() {
  const isAdmin = state.userRole === "admin";
  // Show/hide all .admin-only elements
  document.querySelectorAll(".admin-only").forEach(el => {
    el.style.display = isAdmin ? "" : "none";
  });
  // Show/hide toolbar buttons that require admin
  const adminToolbarBtns = ["btnAddAircraft", "btnAddSector"];
  adminToolbarBtns.forEach(id => {
    const el = doc(id);
    if (el) el.style.display = isAdmin ? "" : "none";
  });
}

async function loadReferenceData() {
  const [aircraft, airports, btRules, tatRules, massTAT, seasons] = await Promise.all([
    API.getAircraft(),
    API.getAirports(),
    API.getBlockTimeRules(),
    API.getTATRules(),
    API.getMassTAT().catch(() => ({ domestic: 40, international: 60 })),
    API.getSeasons().catch(() => []),
  ]);

  state.aircraft = aircraft;

  state.airports = {};
  for (const ap of airports) state.airports[ap.code] = ap;

  state.blockTimeRules = {};
  for (const r of btRules) state.blockTimeRules[`${r.origin}-${r.destination}`] = r;

  state.tatRules = {};
  for (const r of tatRules) state.tatRules[r.station] = r;

  state.massTAT = massTAT;
  state.seasons = seasons;
  updateSeasonBadge();
}

async function refreshGantt() {
  const [sectors, { warnings }, maintenance] = await Promise.all([
    API.getSectors(state.currentDate).catch(() => []),
    API.getWarnings(state.currentDate).catch(() => ({ warnings: [] })),
    API.getMaintenance({ start: state.currentDate, end: state.currentDate }).catch(() => []),
  ]);

  state.sectors    = sectors;
  state.warnings   = warnings;
  state.maintenance= maintenance;

  gantt.render({
    aircraft    : state.aircraft,
    sectors     : state.sectors,
    airports    : state.airports,
    timezone    : state.timezone,
    warnings    : state.warnings,
    maintenance : state.maintenance,
    currentDate : state.currentDate,
  });

  renderWarnings();
}

// ─── Warnings panel ───────────────────────────────────────────────────────────
function renderWarnings() {
  const list  = document.getElementById("warningList");
  const badge = document.getElementById("warningBadge");
  badge.textContent = state.warnings.length;

  if (state.warnings.length === 0) {
    list.innerHTML = '<div class="no-warnings">Không có cảnh báo</div>';
    return;
  }
  list.innerHTML = "";
  for (const w of state.warnings) {
    const div = document.createElement("div");
    div.className = "warning-item" + (w.severity === "error" ? " error" : "");
    div.innerHTML = `<div class="w-type">${w.type}</div>${w.message}`;
    div.addEventListener("click", () => highlightSector(w.sector_id));
    list.appendChild(div);
  }
}

function highlightSector(sectorId) {
  // Scroll Gantt to bring the sector into view
  const el = document.querySelector(`.sector-block[data-sector-id="${sectorId}"]`);
  if (el) el.scrollIntoView({ behavior: "smooth", inline: "center" });
}

// ─── Season badge ─────────────────────────────────────────────────────────────
function updateSeasonBadge() {
  const badge = doc("seasonBadge");
  const label = doc("seasonLabel");
  const icon  = doc("seasonIcon");
  if (!badge) return;

  const d = state.currentDate;
  const season = state.seasons.find(s => s.start_date <= d && s.end_date >= d);
  state.currentSeason = season || null;

  if (season) {
    label.textContent = season.name;
    icon.className = season.season_type === "summer" ? "fas fa-sun" : "fas fa-snowflake";
    badge.title = `${season.name}: ${season.start_date} → ${season.end_date}`;
  } else {
    label.textContent = "--";
    icon.className = "fas fa-calendar";
    badge.title = "Không có mùa bay được định nghĩa cho ngày này";
  }
}

// ─── Audit log modal ──────────────────────────────────────────────────────────
async function openAuditModal() {
  doc("auditModalOverlay").classList.remove("hidden");
  await renderAuditLog();
}

async function renderAuditLog() {
  const entity = doc("auditFilterEntity").value;
  const params = {};
  if (entity) params.entity_type = entity;
  params.limit = 200;

  try {
    const logs = await API.getAuditLog(params);
    const tbody = doc("auditTableBody");
    tbody.innerHTML = "";
    if (!logs.length) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">Không có lịch sử</td></tr>`;
      return;
    }
    for (const log of logs) {
      const ts = new Date(log.timestamp).toLocaleString("vi-VN");
      const tr = document.createElement("tr");
      const actionClass = log.action === "delete" ? "tag-danger" :
                          log.action === "create" ? "tag-domestic" :
                          log.action === "update" ? "tag-intl" : "";
      tr.innerHTML = `
        <td style="white-space:nowrap">${ts}</td>
        <td>${log.username || "—"}</td>
        <td><span class="${actionClass}">${log.action}</span></td>
        <td>${log.entity_type} #${log.entity_id}</td>
        <td style="font-size:11px;color:var(--text-muted);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(log.detail||"").replace(/"/g,"&quot;")}">${log.detail || ""}</td>`;
      tbody.appendChild(tr);
    }
  } catch (e) {
    doc("auditTableBody").innerHTML = `<tr><td colspan="5" style="color:var(--danger)">Lỗi: ${e.message}</td></tr>`;
  }
}

// ─── Maintenance modal ────────────────────────────────────────────────────────
function openMaintenanceModal(block = null) {
  // Populate aircraft select
  const sel = doc("mxAircraft");
  sel.innerHTML = state.aircraft.map(ac =>
    `<option value="${ac.id}">${ac.registration}${ac.name ? " – " + ac.name : ""}</option>`
  ).join("");

  doc("mxId").value        = block ? block.id : "";
  doc("mxLabel").value     = block ? (block.label || "") : "";
  doc("mxStartDate").value = block ? block.start_date : state.currentDate;
  doc("mxEndDate").value   = block ? (block.end_date || state.currentDate) : state.currentDate;
  doc("mxColor").value     = block ? (block.color || "#f59e0b") : "#f59e0b";
  if (block) sel.value     = block.aircraft_id;

  doc("maintenanceModalTitle").innerHTML = block
    ? '<i class="fas fa-wrench"></i> Chỉnh sửa bảo dưỡng'
    : '<i class="fas fa-wrench"></i> Thêm bảo dưỡng';

  const delBtn = doc("btnDeleteMaintenance");
  if (block) delBtn.classList.remove("hidden");
  else delBtn.classList.add("hidden");

  doc("maintenanceModalOverlay").classList.remove("hidden");
}

async function saveMaintenance() {
  const id       = doc("mxId").value;
  const acId     = parseInt(doc("mxAircraft").value, 10);
  const label    = doc("mxLabel").value.trim() || "Maintenance";
  const startDate= doc("mxStartDate").value;
  const endDate  = doc("mxEndDate").value;
  const color    = doc("mxColor").value;

  if (!acId || !startDate || !endDate) {
    alert("Vui lòng điền đầy đủ thông tin bắt buộc."); return;
  }
  if (endDate < startDate) {
    alert("Ngày kết thúc phải sau ngày bắt đầu."); return;
  }

  try {
    const payload = { aircraft_id: acId, label, start_date: startDate, end_date: endDate, color };
    if (id) await API.updateMaintenance(parseInt(id, 10), payload);
    else    await API.createMaintenance(payload);
    closeModal("maintenanceModalOverlay");
    await refreshGantt();
  } catch (e) {
    alert("Lỗi: " + e.message);
  }
}

async function deleteMaintenance() {
  const id = doc("mxId").value;
  if (!id) return;
  if (!confirm("Xoá block bảo dưỡng này?")) return;
  try {
    await API.deleteMaintenance(parseInt(id, 10));
    closeModal("maintenanceModalOverlay");
    await refreshGantt();
  } catch (e) {
    alert("Lỗi: " + e.message);
  }
}

// ─── Season management (inside Rules modal) ────────────────────────────────────
async function renderSeasonTable() {
  const seasons = await API.getSeasons().catch(() => []);
  state.seasons = seasons;
  updateSeasonBadge();

  const isAdmin = state.userRole === "admin";
  const tbody = doc("seasonTableBody");
  tbody.innerHTML = "";
  if (!seasons.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">Chưa có mùa nào. Dùng "Tải mùa IATA" để tạo tự động.</td></tr>`;
    return;
  }
  for (const s of seasons) {
    const typeLabel = s.season_type === "summer" ? "Hè" : "Đông";
    const typeClass = s.season_type === "summer" ? "tag-domestic" : "tag-intl";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${s.name}</strong></td>
      <td>${s.start_date}</td>
      <td>${s.end_date}</td>
      <td><span class="${typeClass}">${typeLabel}</span></td>
      <td class="action-cell">
        <button class="btn btn-secondary btn-sm" onclick="editSeason(${s.id},'${s.name}','${s.season_type}','${s.start_date}','${s.end_date}')">Sửa</button>
        <button class="btn btn-danger btn-sm" onclick="deleteSeason(${s.id})">Xoá</button>
      </td>`;
    tbody.appendChild(tr);
  }
}

function editSeason(id, name, type, start, end) {
  doc("seasonId").value    = id;
  doc("seasonName").value  = name;
  doc("seasonType").value  = type;
  doc("seasonStart").value = start;
  doc("seasonEnd").value   = end;
  doc("seasonFormTitle").textContent = "Chỉnh sửa mùa bay";
  doc("seasonFormModal").classList.remove("hidden");
}

async function deleteSeason(id) {
  if (!confirm("Xoá mùa bay này?")) return;
  await API.deleteSeason(id).catch(e => alert("Lỗi: " + e.message));
  await renderSeasonTable();
}

async function saveSeason() {
  const id    = doc("seasonId").value;
  const name  = doc("seasonName").value.trim();
  const type  = doc("seasonType").value;
  const start = doc("seasonStart").value;
  const end   = doc("seasonEnd").value;
  if (!name || !start || !end) { alert("Điền đầy đủ thông tin"); return; }
  if (end < start) { alert("Ngày kết thúc phải sau ngày bắt đầu"); return; }
  const year = parseInt(start.slice(0, 4), 10);
  const payload = { name, season_type: type, start_date: start, end_date: end, year };
  try {
    if (id) await API.updateSeason(parseInt(id,10), payload);
    else    await API.createSeason(payload);
    doc("seasonFormModal").classList.add("hidden");
    await renderSeasonTable();
  } catch (e) { alert("Lỗi: " + e.message); }
}

async function loadDefaultSeasons() {
  try {
    const defaults = await API.getSeasonDefaults();
    if (!defaults.length) { alert("Không tìm thấy mùa IATA mặc định."); return; }
    // defaults = [{year, summer:{...}, winter:{...}}, ...]
    const items = [];
    for (const d of defaults) {
      if (d.summer) items.push(d.summer);
      if (d.winter) items.push(d.winter);
    }
    if (!confirm(`Tạo ${items.length} mùa IATA? Nếu trùng tên sẽ bỏ qua.`)) return;
    let created = 0;
    for (const s of items) {
      try {
        await API.createSeason(s);
        created++;
      } catch { /* skip duplicates */ }
    }
    alert(`Đã tạo ${created} mùa IATA.`);
    await renderSeasonTable();
  } catch (e) { alert("Lỗi: " + e.message); }
}

// ─── Date navigation ─────────────────────────────────────────────────────────
function updateDateLabel() {
  const d = new Date(state.currentDate + "T00:00:00");
  if (state.viewMode === "day") {
    document.getElementById("dateLabel").textContent =
      d.toLocaleDateString("vi-VN", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
  } else if (state.viewMode === "week") {
    const weekDates = getWeekDates(state.currentDate);
    const first = weekDates[0];
    const last  = weekDates[6];
    document.getElementById("dateLabel").textContent =
      `${first.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" })} – ${last.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" })}`;
  } else {
    document.getElementById("dateLabel").textContent =
      d.toLocaleDateString("vi-VN", { month: "long", year: "numeric" });
  }
}

function navigateDate(delta) {
  const d = new Date(state.currentDate + "T00:00:00");
  if (state.viewMode === "day")   d.setDate(d.getDate() + delta);
  else if (state.viewMode === "week")  d.setDate(d.getDate() + delta * 7);
  else if (state.viewMode === "month") d.setMonth(d.getMonth() + delta);
  state.currentDate = d.toISOString().slice(0, 10);
  document.getElementById("currentDate").value = state.currentDate;
  updateDateLabel();
  updateSeasonBadge();
  refreshView();
}

// ─── View mode switching ──────────────────────────────────────────────────────
function setViewMode(mode) {
  state.viewMode = mode;

  // Toggle panel visibility
  doc("ganttWrapper").classList.toggle("hidden", mode !== "day");
  doc("weekView").classList.toggle("hidden",  mode !== "week");
  doc("monthView").classList.toggle("hidden", mode !== "month");

  // Toggle button active state
  ["day", "week", "month"].forEach(m => {
    doc(`btnView${m.charAt(0).toUpperCase() + m.slice(1)}`).classList.toggle("active", m === mode);
  });

  updateDateLabel();
  refreshView();
}

async function refreshView() {
  if (state.viewMode === "day") {
    await refreshGantt();
  } else if (state.viewMode === "week") {
    await refreshWeekView();
  } else if (state.viewMode === "month") {
    await refreshMonthView();
  }
}

// ─── Week helpers ─────────────────────────────────────────────────────────────
function getWeekDates(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  // Start from Monday
  const dow = (d.getDay() + 6) % 7;  // Mon=0 ... Sun=6
  const monday = new Date(d);
  monday.setDate(d.getDate() - dow);
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    return day;
  });
}

function dateToStr(d) {
  return d.toISOString().slice(0, 10);
}

// ─── Week view renderer ───────────────────────────────────────────────────────
async function refreshWeekView() {
  const weekDates = getWeekDates(state.currentDate);
  const start = dateToStr(weekDates[0]);
  const end   = dateToStr(weekDates[6]);
  const today = todayStr();

  const sectors = await API.getSectorsPeriod(start, end);
  const grid = doc("weekGrid");
  grid.innerHTML = "";

  const DOW_NAMES = ["Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7", "CN"];

  // Header row: empty label + 7 day headers
  const emptyHdr = document.createElement("div");
  emptyHdr.className = "week-header-cell";
  emptyHdr.textContent = "Tàu";
  grid.appendChild(emptyHdr);

  weekDates.forEach((d, i) => {
    const cell = document.createElement("div");
    cell.className = "week-header-cell" + (dateToStr(d) === today ? " today" : "");
    cell.innerHTML = `
      <div style="font-size:11px;color:var(--text-muted)">${DOW_NAMES[i]}</div>
      <div class="wh-date">${d.getDate()}</div>
      <div style="font-size:10px;color:var(--text-muted)">${d.toLocaleDateString("vi-VN",{month:"short"})}</div>
    `;
    cell.addEventListener("click", () => {
      state.currentDate = dateToStr(d);
      doc("currentDate").value = state.currentDate;
      setViewMode("day");
    });
    grid.appendChild(cell);
  });

  // One row per aircraft
  for (const ac of state.aircraft) {
    // Label
    const lbl = document.createElement("div");
    lbl.className = "week-ac-label";
    lbl.textContent = ac.registration;
    grid.appendChild(lbl);

    // 7 day cells
    weekDates.forEach(d => {
      const ds = dateToStr(d);
      const cell = document.createElement("div");
      cell.className = "week-cell" + (ds === today ? " today-col" : "");
      cell.addEventListener("click", () => {
        state.currentDate = ds;
        doc("currentDate").value = ds;
        setViewMode("day");
      });

      const daySectors = sectors.filter(s => s.aircraft_id === ac.id && s.flight_date === ds && s.status === "active");
      if (daySectors.length === 0) {
        // Empty
      } else {
        const sorted = [...daySectors].sort((a, b) => a.dep_utc.localeCompare(b.dep_utc));
        for (const s of sorted) {
          const pill = document.createElement("div");
          pill.className = "week-sector-pill";
          const depDisp = state.timezone === "LCT"
            ? applyTZDisplay(s.dep_utc, s.origin)
            : s.dep_utc;
          pill.style.background = routeColorFromSector(s);
          pill.textContent = `${s.origin}→${s.destination} ${depDisp}`;
          pill.title = `${s.origin}→${s.destination}  ${s.dep_utc}–${s.arr_utc} UTC${s.flight_number ? "  " + s.flight_number : ""}`;
          pill.addEventListener("click", e => {
            e.stopPropagation();
            // Navigate to that day and open sector
            state.currentDate = ds;
            doc("currentDate").value = ds;
            setViewMode("day");
          });
          cell.appendChild(pill);
        }
      }
      grid.appendChild(cell);
    });
  }

  grid.style.gridTemplateColumns = `var(--label-w) repeat(7, 1fr)`;
  updateDateLabel();
}

// ─── Month view renderer ──────────────────────────────────────────────────────
async function refreshMonthView() {
  const d     = new Date(state.currentDate + "T00:00:00");
  const year  = d.getFullYear();
  const month = d.getMonth();
  const today = todayStr();

  // First day of month, last day
  const firstDay = new Date(year, month, 1);
  const lastDay  = new Date(year, month + 1, 0);

  // Pad to Monday start
  const startPad = (firstDay.getDay() + 6) % 7;  // Mon=0
  const totalCells = startPad + lastDay.getDate();
  const rows = Math.ceil(totalCells / 7);

  // Fetch sectors for whole month (+padding days)
  const calStart = new Date(firstDay);
  calStart.setDate(calStart.getDate() - startPad);
  const calEnd   = new Date(calStart);
  calEnd.setDate(calStart.getDate() + rows * 7 - 1);

  const startStr = dateToStr(calStart);
  const endStr   = dateToStr(calEnd);
  const sectors  = await API.getSectorsPeriod(startStr, endStr);

  // Group by date
  const byDate = {};
  for (const s of sectors) {
    if (s.status !== "active") continue;
    if (!byDate[s.flight_date]) byDate[s.flight_date] = [];
    byDate[s.flight_date].push(s);
  }

  const grid = doc("monthGrid");
  grid.innerHTML = "";

  const DOW_NAMES = ["Th 2", "Th 3", "Th 4", "Th 5", "Th 6", "Th 7", "CN"];
  DOW_NAMES.forEach(name => {
    const hdr = document.createElement("div");
    hdr.className = "month-dow-header";
    hdr.textContent = name;
    grid.appendChild(hdr);
  });

  // Calendar cells
  for (let i = 0; i < rows * 7; i++) {
    const cellDate = new Date(calStart);
    cellDate.setDate(calStart.getDate() + i);
    const ds = dateToStr(cellDate);
    const isThisMonth = cellDate.getMonth() === month;

    const cell = document.createElement("div");
    cell.className = "month-day" +
      (!isThisMonth ? " other-month" : "") +
      (ds === today ? " is-today" : "");

    const numDiv = document.createElement("div");
    numDiv.className = "month-day-num";
    numDiv.textContent = cellDate.getDate();
    cell.appendChild(numDiv);

    // Sector pills (max 3, then "+N more")
    const daySectors = (byDate[ds] || []).sort((a, b) => a.dep_utc.localeCompare(b.dep_utc));
    const MAX_PILLS = 3;
    daySectors.slice(0, MAX_PILLS).forEach(s => {
      const pill = document.createElement("div");
      pill.className = "month-sector-pill";
      pill.style.background = routeColorFromSector(s);
      const depDisp = state.timezone === "LCT"
        ? applyTZDisplay(s.dep_utc, s.origin)
        : s.dep_utc;
      pill.textContent = `${s.origin}→${s.destination} ${depDisp}`;
      pill.title = `${s.origin}→${s.destination}  ${s.dep_utc}–${s.arr_utc} UTC${s.flight_number ? "  " + s.flight_number : ""}`;
      pill.addEventListener("click", e => {
        e.stopPropagation();
        state.currentDate = ds;
        doc("currentDate").value = ds;
        setViewMode("day");
      });
      cell.appendChild(pill);
    });

    if (daySectors.length > MAX_PILLS) {
      const more = document.createElement("div");
      more.className = "month-more";
      more.textContent = `+${daySectors.length - MAX_PILLS} chặng`;
      cell.appendChild(more);
    }

    cell.addEventListener("click", () => {
      state.currentDate = ds;
      doc("currentDate").value = ds;
      setViewMode("day");
    });

    grid.appendChild(cell);
  }

  updateDateLabel();
}

// ─── Display helpers (used by week/month views) ───────────────────────────────
function applyTZDisplay(utcTime, airportCode) {
  const ap = state.airports[airportCode];
  const offset = ap ? ap.timezone_offset : 7;
  return applyTZ(utcTime, offset);
}

// Simple route color (shared with gantt.js palette)
const _PALETTE = [
  "#2563eb","#16a34a","#d97706","#9333ea","#0891b2",
  "#be123c","#0f766e","#b45309","#1d4ed8","#15803d",
  "#0369a1","#7c3aed","#b91c1c","#047857","#92400e",
];
function routeColorFromSector(s) {
  const key = [s.origin, s.destination].sort().join("");
  let h = 0;
  for (const c of key) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0;
  return _PALETTE[Math.abs(h) % _PALETTE.length];
}

// ─── Sector modal ─────────────────────────────────────────────────────────────
function openSectorModal(sector = null) {
  const modal  = document.getElementById("sectorModalOverlay");
  const title  = document.getElementById("sectorModalTitle");
  const acSel  = document.getElementById("sectorAircraftId");

  // Populate aircraft select
  acSel.innerHTML = state.aircraft.map(ac =>
    `<option value="${ac.id}">${ac.registration}${ac.name ? " – " + ac.name : ""}</option>`
  ).join("");

  document.getElementById("sectorId").value       = sector ? sector.id : "";
  document.getElementById("sectorDate").value     = sector ? sector.flight_date : state.currentDate;
  document.getElementById("sectorOrigin").value   = sector ? sector.origin  : "";
  document.getElementById("sectorDest").value     = sector ? sector.destination : "";
  document.getElementById("sectorFlightNum").value= sector ? (sector.flight_number || "") : "";
  document.getElementById("sectorWarningBox").classList.add("hidden");
  document.getElementById("sectorWarningBox").textContent = "";

  // Color picker — use sector color, or aircraft color, or default
  const sectorColorEl = doc("sectorColor");
  if (sector && sector.color) {
    sectorColorEl.value = sector.color;
    sectorColorEl.dataset.hasColor = "1";
  } else {
    // Default to aircraft color if available
    const acId = sector ? sector.aircraft_id : parseInt(acSel.value, 10);
    const ac = state.aircraft.find(a => a.id === acId);
    sectorColorEl.value = (ac && ac.color) ? ac.color : "#2563eb";
    sectorColorEl.dataset.hasColor = "0";
  }

  // Reset to UTC first so setSectorModalTZ can convert correctly
  sectorModalTZ = "UTC";

  if (sector) {
    acSel.value = sector.aircraft_id;
    // Always populate as UTC, then let setSectorModalTZ convert if needed
    document.getElementById("sectorDep").value = sector.dep_utc;
    document.getElementById("sectorArr").value = sector.arr_utc;
    const bt = blockMin(sector.dep_utc, sector.arr_utc);
    document.getElementById("sectorBlockTime").value = bt;
    title.textContent = "Chỉnh sửa chặng bay";
  } else {
    document.getElementById("sectorDep").value = "";
    document.getElementById("sectorArr").value = "";
    document.getElementById("sectorBlockTime").value = "";
    title.textContent = "Thêm chặng bay";
  }

  // Switch modal to the current global TZ (converts time inputs if needed)
  setSectorModalTZ(state.timezone);

  modal.classList.remove("hidden");
}

// Auto-fill arrival based on block time rule or entered block time
function autoFillArr() {
  const dep  = document.getElementById("sectorDep").value;
  const orig = document.getElementById("sectorOrigin").value.toUpperCase();
  const dest = document.getElementById("sectorDest").value.toUpperCase();
  const btInput = document.getElementById("sectorBlockTime").value;

  if (!dep) { updateTimeHints(); return; }

  // Convert dep to UTC for rule lookup (rules always stored in UTC)
  const depUTC = sectorModalTZ === "LCT" ? applyTZ(dep, -getOriginOffset()) : dep;

  let btMin = parseInt(btInput, 10);
  const ruleKey = `${orig}-${dest}`;
  const rule = state.blockTimeRules[ruleKey];

  if (!btMin && rule) {
    btMin = rule.block_time_minutes;
    document.getElementById("sectorBlockTime").value = btMin;
  }

  if (btMin > 0) {
    const arrUTC  = minToTime(timeToMin(depUTC) + btMin);
    const arrDisp = sectorModalTZ === "LCT" ? applyTZ(arrUTC, getDestOffset()) : arrUTC;
    document.getElementById("sectorArr").value = arrDisp;
  }

  // Warn if arr differs from rule (compare in UTC)
  if (rule && doc("sectorArr").value) {
    const arrVal   = doc("sectorArr").value;
    const arrUTC2  = sectorModalTZ === "LCT" ? applyTZ(arrVal, -getDestOffset()) : arrVal;
    const enteredBT = blockMin(depUTC, arrUTC2);
    const diff = enteredBT - rule.block_time_minutes;
    if (diff !== 0) {
      const box = document.getElementById("sectorWarningBox");
      box.classList.remove("hidden");
      box.textContent = `⚠ Block time nhập ${Math.abs(diff)} phút ${diff > 0 ? "dài hơn" : "ngắn hơn"} kế hoạch ` +
                        `(${enteredBT} vs ${rule.block_time_minutes} phút)`;
    } else {
      document.getElementById("sectorWarningBox").classList.add("hidden");
    }
  }
  updateTimeHints();
}

function doc(id) { return document.getElementById(id); }

// ─── Sector modal TZ helpers ─────────────────────────────────────────────────
function getOriginOffset() {
  const ap = state.airports[(doc("sectorOrigin").value || "").toUpperCase().trim()];
  return ap ? ap.timezone_offset : 7;
}

function getDestOffset() {
  const ap = state.airports[(doc("sectorDest").value || "").toUpperCase().trim()];
  return ap ? ap.timezone_offset : 7;
}

function setSectorModalTZ(tz) {
  // Convert existing dep/arr inputs to the new timezone before switching
  const prevDep = doc("sectorDep").value;
  const prevArr = doc("sectorArr").value;

  if (prevDep && prevDep !== sectorModalTZ) {
    if (tz === "LCT" && sectorModalTZ === "UTC") {
      // UTC → LCT
      doc("sectorDep").value = applyTZ(prevDep, getOriginOffset());
      if (prevArr) doc("sectorArr").value = applyTZ(prevArr, getDestOffset());
    } else if (tz === "UTC" && sectorModalTZ === "LCT") {
      // LCT → UTC
      doc("sectorDep").value = applyTZ(prevDep, -getOriginOffset());
      if (prevArr) doc("sectorArr").value = applyTZ(prevArr, -getDestOffset());
    }
  }

  sectorModalTZ = tz;
  doc("sectorTZUtc").classList.toggle("active", tz === "UTC");
  doc("sectorTZLct").classList.toggle("active", tz === "LCT");
  doc("sectorDepLabel").textContent = tz === "UTC" ? "Gi\u1EDD c\u1EA5t c\u00E1nh (UTC) *" : "Gi\u1EDD c\u1EA5t c\u00E1nh (LCT) *";
  doc("sectorArrLabel").textContent = tz === "UTC" ? "Gi\u1EDD h\u1EA1 c\u00E1nh (UTC)" : "Gi\u1EDD h\u1EA1 c\u00E1nh (LCT)";
  updateTimeHints();
}

function updateTimeHints() {
  const dep = doc("sectorDep").value;
  const arr = doc("sectorArr").value;
  const depHint = doc("sectorDepHint");
  const arrHint = doc("sectorArrHint");

  if (!dep) { depHint.textContent = ""; arrHint.textContent = ""; return; }

  if (sectorModalTZ === "UTC") {
    const depOff = getOriginOffset();
    const arrOff = getDestOffset();
    depHint.textContent = `= ${applyTZ(dep, depOff)} LCT (+${depOff}h)`;
    if (arr) {
      const bt = blockMin(dep, arr);
      arrHint.textContent = `= ${applyTZ(arr, arrOff)} LCT (+${arrOff}h) \u2502 Block: ${bt} ph\u00fat`;
    } else {
      arrHint.textContent = "";
    }
  } else {
    const depOff = getOriginOffset();
    const arrOff = getDestOffset();
    const depUTC = applyTZ(dep, -depOff);
    depHint.textContent = `= ${depUTC} UTC`;
    if (arr) {
      const arrUTC = applyTZ(arr, -arrOff);
      const bt = blockMin(depUTC, arrUTC);
      arrHint.textContent = `= ${arrUTC} UTC \u2502 Block: ${bt} ph\u00fat`;
    } else {
      arrHint.textContent = "";
    }
  }
}

async function saveSector() {
  const id       = doc("sectorId").value;
  const acId     = parseInt(doc("sectorAircraftId").value, 10);
  const date     = doc("sectorDate").value;
  const origin   = doc("sectorOrigin").value.toUpperCase().trim();
  const dest     = doc("sectorDest").value.toUpperCase().trim();
  let   dep      = doc("sectorDep").value;
  let   arr      = doc("sectorArr").value;
  const fn       = doc("sectorFlightNum").value.toUpperCase().trim() || null;

  if (!acId || !date || !origin || !dest || !dep || !arr) {
    alert("Vui l\u00F2ng \u0111i\u1EC1n \u0111\u1EA7y \u0111\u1EE7 th\u00F4ng tin b\u1EAFt bu\u1ED9c."); return;
  }

  // If modal is in LCT mode, convert times back to UTC before saving
  if (sectorModalTZ === "LCT") {
    dep = applyTZ(dep, -getOriginOffset());
    arr = applyTZ(arr, -getDestOffset());
  }

  const payload = { aircraft_id: acId, flight_date: date, origin, destination: dest,
                    dep_utc: dep, arr_utc: arr, flight_number: fn,
                    color: doc("sectorColor").dataset.hasColor === "1" ? doc("sectorColor").value : null };

  try {
    if (id) {
      const prev = state.sectors.find(s => s.id === parseInt(id, 10));
      const updated = await API.updateSector(parseInt(id, 10), payload);
      history.push({
        label: `Edit sector ${origin}→${dest}`,
        undo: async () => { await API.updateSector(updated.id, prev); await refreshGantt(); },
        redo: async () => { await API.updateSector(updated.id, payload); await refreshGantt(); },
      });
    } else {
      const created = await API.createSector(payload);
      history.push({
        label: `Add sector ${origin}→${dest}`,
        undo: async () => { await API.deleteSector(created.id); await refreshGantt(); state.aircraft = await API.getAircraft(); },
        redo: async () => { await API.createSector(payload); await refreshGantt(); },
      });
    }
    closeModal("sectorModalOverlay");
    await refreshGantt();
  } catch (e) {
    alert("Lỗi: " + e.message);
  }
}

// ─── Aircraft modal ───────────────────────────────────────────────────────────
function openAircraftModal(ac = null) {
  doc("aircraftId").value    = ac ? ac.id : "";
  doc("aircraftReg").value   = ac ? ac.registration : "";
  doc("aircraftType").value  = ac ? (ac.ac_type || "") : "";
  doc("aircraftName").value  = ac ? (ac.name || "") : "";
  doc("aircraftColor").value = (ac && ac.color) ? ac.color : "#2563eb";
  doc("aircraftColor").dataset.hasColor = (ac && ac.color) ? "1" : "0";
  doc("aircraftModalTitle").textContent = ac ? "Chỉnh sửa tàu bay" : "Thêm tàu bay";
  doc("aircraftModalOverlay").classList.remove("hidden");
}

async function saveAircraft() {
  const id   = doc("aircraftId").value;
  const reg  = doc("aircraftReg").value.toUpperCase().trim();
  const type = doc("aircraftType").value.trim() || null;
  const nm   = doc("aircraftName").value.trim() || null;
  const color = doc("aircraftColor").dataset.hasColor === "1" ? doc("aircraftColor").value : null;

  if (!reg) { alert("Vui lòng nhập số hiệu tàu."); return; }

  try {
    if (id) {
      await API.updateAircraft(parseInt(id, 10), { registration: reg, ac_type: type, name: nm, color });
    } else {
      const created = await API.createAircraft({ registration: reg, ac_type: type, name: nm, color, line_order: state.aircraft.length });
      history.push({
        label: `Add aircraft ${reg}`,
        undo: async () => { await API.deleteAircraft(created.id); state.aircraft = await API.getAircraft(); await refreshGantt(); },
        redo: async () => { await API.createAircraft({ registration: reg, ac_type: type, name: nm, color }); state.aircraft = await API.getAircraft(); await refreshGantt(); },
      });
    }
    state.aircraft = await API.getAircraft();
    closeModal("aircraftModalOverlay");
    await refreshGantt();
  } catch (e) {
    alert("Lỗi: " + e.message);
  }
}

// ─── Sector right-click context menu ─────────────────────────────────────────
let _ctxSector = null;

function handleSectorClick(sector) {
  openSectorModal(sector);
}

function handleSectorRightClick(sector, x, y) {
  _ctxSector = sector;
  const cm = doc("contextMenu");
  cm.style.left = x + "px";
  cm.style.top  = y + "px";
  cm.classList.remove("hidden");

  doc("cmEdit").classList.remove("hidden");
  if (sector.status === "cancelled") {
    doc("cmCancel").classList.add("hidden");
    doc("cmRestore").classList.remove("hidden");
  } else {
    doc("cmCancel").classList.remove("hidden");
    doc("cmRestore").classList.add("hidden");
  }
}

document.addEventListener("click", () => doc("contextMenu").classList.add("hidden"));

// ─── Row reorder (change aircraft line order) ──────────────────────────────────
async function handleAircraftReorder(orderedAcIds) {
  const order = orderedAcIds.map((id, i) => ({ id, line_order: i }));
  try {
    await API.reorderAircraft(order);
    // Update local state to match new order
    state.aircraft.sort((a, b) => {
      const ai = orderedAcIds.indexOf(a.id);
      const bi = orderedAcIds.indexOf(b.id);
      return ai - bi;
    });
  } catch (e) {
    console.error("Reorder failed:", e);
    alert("Lỗi đổi vị trí: " + e.message);
    await refreshGantt();
  }
}

// ─── Row drop (move ALL sectors from one aircraft to another) ────────────────
async function handleRowDrop(fromAcId, toAcId) {
  const fromAc = state.aircraft.find(a => a.id === fromAcId);
  const toAc   = state.aircraft.find(a => a.id === toAcId);
  const nameA  = fromAc ? fromAc.registration : fromAcId;
  const nameB  = toAc   ? toAc.registration   : toAcId;

  // Get all sectors of source aircraft on current date
  const sectorsToMove = state.sectors.filter(s => s.aircraft_id === fromAcId && s.status === "active");
  if (sectorsToMove.length === 0) {
    showToast(`${nameA} không có chặng bay nào để di chuyển.`, "warn");
    return;
  }

  const ok = await showConfirm(
    `Di chuyển ${sectorsToMove.length} chặng bay của ${nameA} sang ${nameB}?`,
    "Chuyển cả line"
  );
  if (!ok) return;

  const ids = sectorsToMove.map(s => s.id);
  await handleSectorDrop(ids, fromAcId, toAcId);
}

// ─── Drag-and-drop (cross-row: change aircraft) ───────────────────────────────
async function handleSectorDrop(sectorIds, fromAcId, toAcId) {
  // sectorIds is now always an array (from multi-select support)
  const ids = Array.isArray(sectorIds) ? sectorIds : [sectorIds];
  const moved = [];
  const failed = [];

  for (const sectorId of ids) {
    const sector = state.sectors.find(s => s.id === sectorId);
    if (!sector) continue;
    try {
      await API.updateSector(sectorId, { aircraft_id: toAcId });
      moved.push({ sectorId, prevAcId: sector.aircraft_id, sector });
    } catch (e) {
      failed.push(`${sector.origin}→${sector.destination}: ${e.message}`);
    }
  }

  if (moved.length > 0) {
    const label = moved.length === 1
      ? `Move sector ${moved[0].sector.origin}→${moved[0].sector.destination}`
      : `Move ${moved.length} sectors to another aircraft`;
    history.push({
      label,
      undo: async () => {
        for (const { sectorId, prevAcId } of moved) await API.updateSector(sectorId, { aircraft_id: prevAcId });
        await refreshGantt();
      },
      redo: async () => {
        for (const { sectorId } of moved) await API.updateSector(sectorId, { aircraft_id: toAcId });
        await refreshGantt();
      },
    });
    await refreshGantt();
  }

  if (failed.length > 0) {
    alert("Lỗi kéo thả:\n" + failed.join("\n"));
  }
}

// ─── Time drag (same-row: change departure/arrival time) ─────────────────────
async function handleSectorTimeChange(sectorIdOrIds, newDepUtc, newArrUtc, deltaMin) {
  // Multi-select time shift: sectorIdOrIds is an array, deltaMin is provided
  if (Array.isArray(sectorIdOrIds)) {
    const ids = sectorIdOrIds;
    if (!deltaMin) return;
    const updates = [];
    for (const sectorId of ids) {
      const sector = state.sectors.find(s => s.id === sectorId);
      if (!sector) continue;
      const dep = timeToMin(sector.dep_utc);
      let   arr = timeToMin(sector.arr_utc);
      if (arr <= dep) arr += 1440;
      const bt = arr - dep;
      const newDep = Math.max(0, Math.min(MINUTES_TOTAL - bt, dep + deltaMin));
      const newArr = newDep + bt;
      updates.push({
        sectorId,
        prevDep: sector.dep_utc,
        prevArr: sector.arr_utc,
        newDep: minToTime(newDep),
        newArr: minToTime(newArr),
      });
    }
    if (updates.length === 0) return;
    try {
      for (const u of updates) {
        await API.updateSector(u.sectorId, { dep_utc: u.newDep, arr_utc: u.newArr });
      }
      history.push({
        label: `Đổi giờ ${updates.length} chuyến: ${deltaMin > 0 ? "+" : ""}${deltaMin} phút`,
        undo: async () => {
          for (const u of updates) await API.updateSector(u.sectorId, { dep_utc: u.prevDep, arr_utc: u.prevArr });
          await refreshGantt();
        },
        redo: async () => {
          for (const u of updates) await API.updateSector(u.sectorId, { dep_utc: u.newDep, arr_utc: u.newArr });
          await refreshGantt();
        },
      });
      await refreshGantt();
    } catch (e) {
      alert("Lỗi cập nhật giờ bay: " + e.message);
      await refreshGantt();
    }
    return;
  }

  // Single sector time shift
  const sectorId = sectorIdOrIds;
  const sector = state.sectors.find(s => s.id === sectorId);
  if (!sector) return;
  const prevDep = sector.dep_utc;
  const prevArr = sector.arr_utc;
  try {
    await API.updateSector(sectorId, { dep_utc: newDepUtc, arr_utc: newArrUtc });
    history.push({
      label: `Đổi giờ ${sector.origin}→${sector.destination}: ${newDepUtc}–${newArrUtc}`,
      undo: async () => { await API.updateSector(sectorId, { dep_utc: prevDep, arr_utc: prevArr }); await refreshGantt(); },
      redo: async () => { await API.updateSector(sectorId, { dep_utc: newDepUtc, arr_utc: newArrUtc }); await refreshGantt(); },
    });
    await refreshGantt();
  } catch (e) {
    alert("Lỗi cập nhật giờ bay: " + e.message);
    await refreshGantt(); // reset visual
  }
}

// ─── Rules modal ──────────────────────────────────────────────────────────────
async function openRulesModal() {
  doc("rulesModalOverlay").classList.remove("hidden");
  applyRoleUI();
  await loadMassTAT();
  await Promise.all([
    renderTATTable(),
    renderBTTable(),
    renderRegTable(),
    renderAirportTable(),
  ]);
  if (state.userRole === "admin") {
    await Promise.all([renderUserTable(), renderSeasonTable()]);
  }
}

async function loadMassTAT() {
  try {
    const mass = await API.getMassTAT();
    doc("massTATDomestic").value = minToTime(mass.domestic);
    doc("massTATIntl").value = minToTime(mass.international);
  } catch { /* defaults from HTML */ }
}

async function saveMassTAT() {
  const domTime = doc("massTATDomestic").value;
  const intlTime = doc("massTATIntl").value;
  if (!domTime || !intlTime) { alert("Điền đầy đủ thông tin"); return; }
  try {
    await API.setMassTAT({
      domestic: timeToMin(domTime),
      international: timeToMin(intlTime)
    });
    alert("Đã lưu rule mặc định!");
  } catch (err) {
    alert("Lỗi: " + err.message);
  }
}

async function renderTATTable() {
  const rules = await API.getTATRules();
  state.tatRules = {};
  for (const r of rules) state.tatRules[r.station] = r;

  const isAdmin = state.userRole === "admin";
  const tbody = doc("tatTableBody");
  tbody.innerHTML = "";

  // Auto-sync is_domestic from airports for any mismatches (silently, admin only)
  if (isAdmin) {
    for (const r of rules) {
      const ap = state.airports[r.station];
      if (ap) {
        const shouldBeDom = ap.timezone_offset === 7;
        if (r.is_domestic !== shouldBeDom) {
          // Silently fix the mismatch
          API.updateTATRule(r.id, { station: r.station, min_tat_minutes: r.min_tat_minutes, is_domestic: shouldBeDom })
            .catch(() => {});
          r.is_domestic = shouldBeDom; // update local copy immediately
        }
      }
    }
  }

  for (const r of rules) {
    const timeStr = minToTime(r.min_tat_minutes);
    // Prefer airport-derived type if airport is known
    const ap = state.airports[r.station];
    let resolvedDomestic = r.is_domestic;
    if (ap) resolvedDomestic = ap.timezone_offset === 7;

    let typeLabel, typeClass;
    if (resolvedDomestic === true) {
      typeLabel = "Nội địa"; typeClass = "tag-domestic";
    } else if (resolvedDomestic === false) {
      typeLabel = "Quốc tế"; typeClass = "tag-intl";
    } else {
      typeLabel = "Chưa xác định"; typeClass = "tag-unknown";
    }
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.station}</td>
      <td><span class="${typeClass}">${typeLabel}</span></td>
      <td>${timeStr}</td>
      <td class="action-cell admin-only" style="display:${isAdmin ? "" : "none"}">
        <button class="btn btn-secondary btn-sm" onclick="editTAT(${r.id},'${r.station}',${r.min_tat_minutes},${resolvedDomestic})">Sửa</button>
        <button class="btn btn-danger btn-sm" onclick="deleteTAT(${r.id})">Xoá</button>
      </td>`;
    tbody.appendChild(tr);
  }
}

async function renderBTTable() {
  const rules = await API.getBlockTimeRules();
  state.blockTimeRules = {};
  for (const r of rules) state.blockTimeRules[`${r.origin}-${r.destination}`] = r;

  const isAdmin = state.userRole === "admin";
  const tbody = doc("btTableBody");
  tbody.innerHTML = "";
  for (const r of rules) {
    const timeStr = minToTime(r.block_time_minutes);
    const decStr  = minToDecimal(r.block_time_minutes);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.origin}</td>
      <td>${r.destination}</td>
      <td>${timeStr}</td>
      <td class="decimal-cell">${decStr}</td>
      <td class="action-cell admin-only" style="display:${isAdmin ? "" : "none"}">
        <button class="btn btn-secondary btn-sm" onclick="editBT(${r.id},'${r.origin}','${r.destination}',${r.block_time_minutes})">Sửa</button>
        <button class="btn btn-danger btn-sm" onclick="deleteBT(${r.id})">Xoá</button>
      </td>`;
    tbody.appendChild(tr);
  }
}

function editTAT(id, station, min, isDomestic) {
  doc("tatId").value = id;
  doc("tatStation").value = station;
  doc("tatTime").value = minToTime(min);
  // isDomestic: true/false/null from DB
  const sel = doc("tatIsDomestic");
  if (isDomestic === true || isDomestic === "true") sel.value = "true";
  else if (isDomestic === false || isDomestic === "false") sel.value = "false";
  else sel.value = "";
  doc("tatFormTitle").textContent = "Chỉnh sửa TAT Rule";
  doc("tatFormModal").classList.remove("hidden");
}

function editBT(id, orig, dest, min) {
  doc("btId").value = id;
  doc("btOrigin").value = orig;
  doc("btDest").value = dest;
  doc("btTime").value = minToTime(min);
  doc("btFormTitle").textContent = "Chỉnh sửa Block Time Rule";
  doc("btFormModal").classList.remove("hidden");
}

async function deleteTAT(id) {
  if (!confirm("Xoá TAT rule này?")) return;
  await API.deleteTATRule(id).catch(e => { alert("Lỗi: " + e.message); return; });
  await renderTATTable();
  await refreshGantt(); // re-render TAT gap indicators
}

async function deleteBT(id) {
  if (!confirm("Xoá block time rule này?")) return;
  await API.deleteBlockTimeRule(id);
  await renderBTTable();
}

async function saveTAT() {
  const id  = doc("tatId").value;
  const st  = doc("tatStation").value.toUpperCase().trim();
  const timeStr = doc("tatTime").value;
  if (!st || !timeStr) { alert("Điền đầy đủ thông tin"); return; }
  const min = timeToMin(timeStr);
  // Auto-derive is_domestic from airport data
  const ap = state.airports[st];
  let is_domestic;
  const isDomRaw = doc("tatIsDomestic").value;
  if (ap) {
    is_domestic = ap.timezone_offset === 7;
  } else if (isDomRaw !== "") {
    is_domestic = isDomRaw === "true";
  } else {
    alert("Sân bay chưa có trong hệ thống. Vui lòng chọn phân loại Nội địa/Quốc tế."); return;
  }
  try {
    if (id) await API.updateTATRule(parseInt(id,10), { station: st, min_tat_minutes: min, is_domestic });
    else    await API.createTATRule({ station: st, min_tat_minutes: min, is_domestic });
    doc("tatFormModal").classList.add("hidden");
    await renderTATTable();
    await refreshGantt();
  } catch (e) { alert("Lỗi: " + e.message); }
}

async function saveBT() {
  const id   = doc("btId").value;
  const orig = doc("btOrigin").value.toUpperCase().trim();
  const dest = doc("btDest").value.toUpperCase().trim();
  const timeStr = doc("btTime").value;
  if (!orig || !dest || !timeStr) { alert("Điền đầy đủ thông tin"); return; }
  const min = timeToMin(timeStr);
  if (id) await API.updateBlockTimeRule(parseInt(id,10), { origin: orig, destination: dest, block_time_minutes: min });
  else    await API.createBlockTimeRule({ origin: orig, destination: dest, block_time_minutes: min });
  doc("btFormModal").classList.add("hidden");
  await renderBTTable();
}

// ─── Excel export/import for TAT ──────────────────────────────────────────────
async function exportTATExcel() {
  window.location.href = "/api/rules/tat/export";
}

async function importTATExcel(e) {
  const file = e.target.files[0];
  if (!file) return;
  
  const formData = new FormData();
  formData.append("file", file);
  
  try {
    const response = await fetch("/api/rules/tat/import", {
      method: "POST",
      body: formData
    });
    if (!response.ok) throw new Error("Import failed");
    const result = await response.json();
    alert(`Đã nhập ${result.imported} TAT rules từ Excel`);
    await renderTATTable();
  } catch (err) {
    alert("Lỗi: " + err.message);
  }
  e.target.value = "";
}

// ─── Excel export/import for Block Time ───────────────────────────────────────
async function exportBTExcel() {
  window.location.href = "/api/rules/blocktime/export";
}

async function importBTExcel(e) {
  const file = e.target.files[0];
  if (!file) return;
  
  const formData = new FormData();
  formData.append("file", file);
  
  try {
    const response = await fetch("/api/rules/blocktime/import", {
      method: "POST",
      body: formData
    });
    if (!response.ok) throw new Error("Import failed");
    const result = await response.json();
    alert(`Đã nhập ${result.imported} Block Time rules từ Excel`);
    await renderBTTable();
  } catch (err) {
    alert("Lỗi: " + err.message);
  }
  e.target.value = "";
}

// ─── Registration management ──────────────────────────────────────────────────
async function renderRegTable() {
  const registrations = await API.getRegistrations();
  const tbody = doc("regTableBody");
  tbody.innerHTML = "";
  for (const reg of registrations) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${reg.registration}</td>
      <td>${reg.aircraft_model}</td>
      <td>${reg.seats}</td>
      <td class="action-cell">
        <button class="btn btn-secondary btn-sm" onclick="editReg(${reg.id},'${reg.registration}','${reg.aircraft_model}',${reg.seats})">Sửa</button>
        <button class="btn btn-danger btn-sm" onclick="deleteReg(${reg.id})">Xoá</button>
      </td>`;
    tbody.appendChild(tr);
  }
}

function editReg(id, registration, model, seats) {
  doc("regId").value = id;
  doc("regNumber").value = registration;
  doc("regModel").value = model;
  doc("regSeats").value = seats;
  doc("regForm").classList.remove("hidden");
}

async function deleteReg(id) {
  if (!confirm("Xoá registration này?")) return;
  await API.deleteRegistration(id);
  await renderRegTable();
}

async function saveReg() {
  try {
    const id = doc("regId").value;
    const registration = doc("regNumber").value.toUpperCase().trim();
    const aircraft_model = doc("regModel").value.trim();
    const seats = parseInt(doc("regSeats").value, 10);
    
    if (!registration || !aircraft_model || !seats) {
      alert("Điền đầy đủ thông tin");
      return;
    }
    
    const data = { registration, aircraft_model, seats };
    if (id) await API.updateRegistration(parseInt(id, 10), data);
    else await API.createRegistration(data);
    
    doc("regForm").classList.add("hidden");
    doc("regId").value = "";
    doc("regNumber").value = "";
    doc("regModel").value = "";
    doc("regSeats").value = "";
    await renderRegTable();
  } catch (err) {
    alert("Lỗi: " + err.message);
  }
}

// ─── User management (admin only) ────────────────────────────────────────────
async function renderUserTable() {
  try {
    const users = await fetch("/api/auth/users").then(r => r.json());
    const tbody = doc("userTableBody");
    tbody.innerHTML = "";
    for (const u of users) {
      const roleLabel = u.role === "admin"
        ? '<span class="tag-domestic">Admin</span>'
        : '<span class="tag-intl">Viewer</span>';
      const isSelf = u.username === state.username;
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${u.username}${isSelf ? ' <span class="tag-unknown">(bạn)</span>' : ""}</td>
        <td>${u.display_name || ""}</td>
        <td>${roleLabel}</td>
        <td class="action-cell">
          <button class="btn btn-secondary btn-sm" onclick="editUser(${u.id},'${u.username}','${u.display_name || ""}','${u.role}')">Sửa</button>
          ${!isSelf ? `<button class="btn btn-danger btn-sm" onclick="deleteUser(${u.id})">Xoá</button>` : ""}
        </td>`;
      tbody.appendChild(tr);
    }
  } catch {}
}

function editUser(id, username, displayName, role) {
  doc("userId").value = id;
  doc("userUsername").value = username;
  doc("userPassword").value = "";
  doc("userDisplayName").value = displayName;
  doc("userRole").value = role;
  doc("userFormTitle").textContent = "Chỉnh sửa tài khoản";
  doc("userFormModal").classList.remove("hidden");
}

async function deleteUser(id) {
  if (!confirm("Xoá tài khoản này?")) return;
  try {
    const res = await fetch(`/api/auth/users/${id}`, { method: "DELETE" });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.detail || "Lỗi"); }
    await renderUserTable();
  } catch (err) { alert("Lỗi: " + err.message); }
}

async function saveUser() {
  const id = doc("userId").value;
  const username = doc("userUsername").value.trim();
  const password = doc("userPassword").value;
  const display_name = doc("userDisplayName").value.trim();
  const role = doc("userRole").value;
  if (!username || !role) { alert("Điền đầy đủ thông tin"); return; }
  if (!id && !password) { alert("Mật khẩu không được để trống khi tạo tài khoản mới"); return; }
  try {
    const body = { username, password: password || "UNCHANGED__placeholder", display_name, role };
    const method = id ? "PUT" : "POST";
    const url = id ? `/api/auth/users/${id}` : "/api/auth/users";
    const res = await fetch(url, {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.detail || "Lỗi"); }
    doc("userFormModal").classList.add("hidden");
    await renderUserTable();
  } catch (err) { alert("Lỗi: " + err.message); }
}

// ─── Airports tab (inside Rules modal) ───────────────────────────────────────
async function renderAirportTable() {
  const isAdmin = state.userRole === "admin";
  const tbody = doc("airportTableBody");
  tbody.innerHTML = "";
  for (const ap of Object.values(state.airports)) {
    const isDom = ap.timezone_offset === 7;
    const typeLabel = isDom ? "Nội địa" : "Quốc tế";
    const typeClass = isDom ? "tag-domestic" : "tag-intl";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${ap.code}</strong></td>
      <td>${ap.name}</td>
      <td>+${ap.timezone_offset}</td>
      <td><span class="${typeClass}">${typeLabel}</span></td>
      <td class="action-cell admin-only" style="display:${isAdmin ? "" : "none"}">
        <button class="btn btn-secondary btn-sm" onclick="editAirport('${ap.code}','${ap.name}',${ap.timezone_offset})">Sửa</button>
        <button class="btn btn-danger btn-sm" onclick="deleteAirport('${ap.code}')">Xoá</button>
      </td>`;
    tbody.appendChild(tr);
  }
}

function editAirport(code, name, tz) {
  doc("apCode").value = code;
  doc("apCodeInput").value = code;
  doc("apCodeInput").disabled = true;
  doc("apName").value = name;
  doc("apTZ").value = tz;
  doc("apType").value = tz === 7 ? "domestic" : "international";
  doc("airportForm").classList.remove("hidden");
}

async function deleteAirport(code) {
  if (!confirm(`Xoá sân bay ${code}?`)) return;
  await API.deleteAirport(code).catch(e => { alert("Lỗi: " + e.message); return; });
  state.airports = Object.fromEntries((await API.getAirports()).map(ap => [ap.code, ap]));
  await renderAirportTable();
  await refreshGantt();
}

async function saveAirport() {
  const code = doc("apCodeInput").value.toUpperCase().trim();
  const name = doc("apName").value.trim();
  const tz   = parseFloat(doc("apTZ").value);
  if (!code || !name || isNaN(tz)) { alert("Điền đầy đủ thông tin"); return; }
  const existing = doc("apCode").value;
  try {
    if (existing) await API.updateAirport(existing, { code, name, timezone_offset: tz });
    else          await API.createAirport({ code, name, timezone_offset: tz });
    doc("airportForm").classList.add("hidden");
    doc("apCodeInput").disabled = false;
    doc("apCode").value = "";
    state.airports = Object.fromEntries((await API.getAirports()).map(ap => [ap.code, ap]));
    // Sync TAT rules: update is_domestic for TAT rules matching this airport code
    const isDom = tz === 7;
    const tatRule = state.tatRules[code];
    if (tatRule && tatRule.is_domestic !== isDom) {
      await API.updateTATRule(tatRule.id, { station: code, min_tat_minutes: tatRule.min_tat_minutes, is_domestic: isDom }).catch(() => {});
    }
    await Promise.all([renderAirportTable(), renderTATTable()]);
    await refreshGantt();
  } catch (e) { alert("Lỗi: " + e.message); }
}

// ─── Export timetable modal ───────────────────────────────────────────────────
async function openExportModal() {
  const today = state.currentDate;
  const firstOfMonth = today.slice(0, 8) + "01";
  const lastOfMonth  = new Date(new Date(today).getFullYear(), new Date(today).getMonth() + 1, 0)
                         .toISOString().slice(0, 10);
  doc("expStart").value = firstOfMonth;
  doc("expEnd").value   = lastOfMonth;
  doc("exportModalOverlay").classList.remove("hidden");
  doc("exportResult").innerHTML = "";
}

async function runExport() {
  const params = {
    period_start: doc("expStart").value,
    period_end  : doc("expEnd").value,
    mode        : doc("expMode").value,
    timezone    : doc("expTZ").value,
  };
  try {
    const data = await API.exportTimetable(params);
    state.lastExportData = data;
    renderTimetableTable(data);
  } catch (e) {
    alert("Lỗi: " + e.message);
  }
}

function renderTimetableTable(data) {
  const el = doc("exportResult");
  el.innerHTML = "";

  if (data.mode === "daily") {
    const hdr = `<tr>
      <th>Ngày</th><th>Tàu</th><th>Điểm đi</th><th>Điểm đến</th>
      <th>Cất (${data.timezone})</th><th>Hạ (${data.timezone})</th>
      <th>Block (phút)</th><th>Chuyến</th></tr>`;
    const rows = data.rows.map(r => `<tr>
      <td>${r.flight_date}</td><td>${r.aircraft_reg}</td>
      <td>${r.origin}</td><td>${r.destination}</td>
      <td>${r.dep_display}</td><td>${r.arr_display}</td>
      <td>${r.block_time_minutes}</td><td>${r.flight_number || ""}</td></tr>`).join("");
    el.innerHTML = `<table class="tt-table"><thead>${hdr}</thead><tbody>${rows}</tbody></table>`;
  } else {
    const hdr = `<tr>
      <th>Điểm đi</th><th>Điểm đến</th>
      <th>Cất (${data.timezone})</th><th>Hạ (${data.timezone})</th>
      <th>Block (phút)</th><th>Ngày bay</th><th>Số CB</th><th>Tàu</th></tr>`;
    const rows = data.rows.map(r => `<tr>
      <td>${r.origin}</td><td>${r.destination}</td>
      <td>${r.dep_display}</td><td>${r.arr_display}</td>
      <td>${r.block_time_minutes}</td>
      <td>${r.date_range}</td><td>${r.flight_count}</td>
      <td>${r.aircraft.join(", ")}</td></tr>`).join("");
    el.innerHTML = `<table class="tt-table"><thead>${hdr}</thead><tbody>${rows}</tbody></table>`;
  }
}

// ─── Report modal ─────────────────────────────────────────────────────────────
async function openReportModal() {
  const today = state.currentDate;
  const firstOfMonth = today.slice(0, 8) + "01";
  const lastOfMonth  = new Date(new Date(today).getFullYear(), new Date(today).getMonth() + 1, 0)
                         .toISOString().slice(0, 10);
  doc("rptStart").value = firstOfMonth;
  doc("rptEnd").value   = lastOfMonth;
  doc("reportModalOverlay").classList.remove("hidden");
  doc("reportResult").innerHTML = "";
}

async function runReport() {
  const params = {
    period_start: doc("rptStart").value,
    period_end  : doc("rptEnd").value,
    sort_by     : doc("rptSortBy").value,
    timezone    : doc("rptTZ").value,
  };
  try {
    const data = await API.exportReport(params);
    state.lastReportData = data;
    renderReport(data);
  } catch (e) {
    alert("Lỗi: " + e.message);
  }
}

function renderReport(data) {
  const el = doc("reportResult");
  el.innerHTML = "";

  const summary = `
    <div class="report-summary">
      <div class="stat-item">
        <div class="stat-value">${data.summary.total_block_hours}h</div>
        <div class="stat-label">Tổng Block Hours</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${data.summary.avg_per_aircraft_block_hours}h</div>
        <div class="stat-label">Trung bình / tàu</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${data.period_days}</div>
        <div class="stat-label">Số ngày</div>
      </div>
    </div>`;

  let table = "";
  if (data.sort_by === "aircraft" && data.aircraft_rows) {
    const hdr = `<tr><th>#</th><th>Tàu</th><th>Loại</th>
      <th>Total BH</th><th>BH/ngày</th><th>Số chặng</th></tr>`;
    const rows = data.aircraft_rows.map(r => `<tr>
      <td>${r.line_order}</td><td><strong>${r.registration}</strong></td><td>${r.name}</td>
      <td>${r.total_block_hours}h</td><td>${r.avg_daily_block_hours}h</td>
      <td>${r.sector_count}</td></tr>`).join("");
    table = `<table class="tt-table"><thead>${hdr}</thead><tbody>${rows}</tbody></table>`;
  } else if (data.route_rows) {
    const hdr = `<tr><th>Đường bay</th><th>Total BH</th><th>Số chặng</th><th>Ngày bay</th></tr>`;
    const rows = data.route_rows.map(r => `<tr>
      <td><strong>${r.route}</strong></td><td>${r.total_block_hours}h</td>
      <td>${r.sector_count}</td><td>${r.unique_dates}</td></tr>`).join("");
    table = `<table class="tt-table"><thead>${hdr}</thead><tbody>${rows}</tbody></table>`;
  }

  el.innerHTML = summary + table;
}

// ─── Import / Export file ─────────────────────────────────────────────────────
async function saveScheduleFile() {
  try {
    const data = await API.exportSchedule();
    downloadJSON(data, `schedule_${state.currentDate}.json`);
  } catch (e) {
    alert("Lỗi xuất lịch: " + e.message);
  }
}

function openImportFile() {
  doc("importFileInput").click();
}

async function handleImportFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const replace = confirm("Thay thế toàn bộ dữ liệu hiện tại?\n(Chọn Cancel để gộp dữ liệu)");
    data.replace_all = replace;
    await API.importSchedule(data);
    history.clear();
    await loadReferenceData();
    await refreshGantt();
    alert("Import thành công!");
  } catch (e) {
    alert("Lỗi import: " + e.message);
  }
  e.target.value = "";
}

// ─── Modal helpers ────────────────────────────────────────────────────────────
function closeModal(overlayId) {
  doc(overlayId).classList.add("hidden");
}

/**
 * Custom confirm dialog (replaces native confirm() to avoid ghost-click /
 * focus bugs that cause the rules modal to open after drag-drop).
 * Returns a Promise<boolean>.
 */
function showConfirm(msg, title = "Xác nhận") {
  return new Promise(resolve => {
    doc("confirmModalTitle").innerHTML = `<i class="fas fa-question-circle"></i> ${title}`;
    doc("confirmModalMsg").textContent = msg;
    doc("confirmModalOverlay").classList.remove("hidden");

    function cleanup(result) {
      doc("confirmModalOverlay").classList.add("hidden");
      doc("btnConfirmModalOk").removeEventListener("click", onOk);
      doc("btnConfirmModalCancel").removeEventListener("click", onCancel);
      doc("confirmModalOverlay").removeEventListener("click", onBackdrop);
      resolve(result);
    }
    function onOk()       { cleanup(true);  }
    function onCancel()   { cleanup(false); }
    function onBackdrop(e) { if (e.target === doc("confirmModalOverlay")) cleanup(false); }

    doc("btnConfirmModalOk").addEventListener("click", onOk);
    doc("btnConfirmModalCancel").addEventListener("click", onCancel);
    doc("confirmModalOverlay").addEventListener("click", onBackdrop);
  });
}

function bindCloseButtons() {
  document.querySelectorAll("[data-close]").forEach(btn => {
    btn.addEventListener("click", () => closeModal(btn.dataset.close));
  });
  document.querySelectorAll(".modal-overlay").forEach(overlay => {
    // confirmModalOverlay manages its own backdrop click via showConfirm()
    if (overlay.id === "confirmModalOverlay") return;
    overlay.addEventListener("click", e => {
      if (e.target === overlay) closeModal(overlay.id);
    });
  });
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function bindTabs() {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tabId = btn.dataset.tab;
      btn.closest(".modal-body, .tabs")
         .closest(".modal-body")
         .querySelectorAll(".tab-content").forEach(tc => tc.classList.remove("active"));
      btn.closest(".modal-body")
         .querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      doc(tabId).classList.add("active");
      btn.classList.add("active");
    });
  });
}

// ─── Context-menu actions ─────────────────────────────────────────────────────
function bindContextMenu() {
  doc("cmEdit").addEventListener("click", () => {
    if (_ctxSector) openSectorModal(_ctxSector);
  });

  doc("cmCopy").addEventListener("click", () => {
    if (!_ctxSector) return;
    // Copy either the multi-selection or just this sector
    const selectedIds = gantt.getSelectedSectorIds();
    if (selectedIds.length > 1 && selectedIds.includes(_ctxSector.id)) {
      copySelectedSectors();
    } else {
      state.clipboard = {
        type      : "sectors",
        sectors   : [{ ..._ctxSector }],
        sourceAcId: _ctxSector.aircraft_id,
        sourceDate: _ctxSector.flight_date,
      };
      showToast("Đã copy 1 chặng bay", "info");
    }
  });

  doc("cmCancel").addEventListener("click", async () => {
    if (!_ctxSector) return;
    const s = _ctxSector;
    await API.cancelSector(s.id);
    history.push({
      label: `Cancel sector ${s.origin}→${s.destination}`,
      undo: async () => { await API.restoreSector(s.id); await refreshGantt(); },
      redo: async () => { await API.cancelSector(s.id);  await refreshGantt(); },
    });
    await refreshGantt();
  });

  doc("cmRestore").addEventListener("click", async () => {
    if (!_ctxSector) return;
    const s = _ctxSector;
    await API.restoreSector(s.id);
    history.push({
      label: `Restore sector ${s.origin}→${s.destination}`,
      undo: async () => { await API.cancelSector(s.id);  await refreshGantt(); },
      redo: async () => { await API.restoreSector(s.id); await refreshGantt(); },
    });
    await refreshGantt();
  });

  doc("cmDelete").addEventListener("click", async () => {
    if (!_ctxSector) return;
    const s = _ctxSector;
    if (!confirm(`Xoá chặng ${s.origin}→${s.destination}?`)) return;
    await API.deleteSector(s.id);
    history.push({
      label: `Delete sector ${s.origin}→${s.destination}`,
      undo: async () => { await API.createSector({ aircraft_id: s.aircraft_id, flight_date: s.flight_date,
        origin: s.origin, destination: s.destination, dep_utc: s.dep_utc, arr_utc: s.arr_utc,
        flight_number: s.flight_number, status: s.status }); await refreshGantt(); },
      redo: async () => { await API.deleteSector(s.id); await refreshGantt(); },
    });
    await refreshGantt();
  });
}

// ─── Copy / Paste ─────────────────────────────────────────────────────────────

/** Show a brief toast message at the bottom of the screen */
function showToast(msg, type = "info") {
  let toast = doc("_ganttToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "_ganttToast";
    toast.className = "gantt-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = "gantt-toast gantt-toast-" + type + " visible";
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.add("hiding");
    toast._timer2 = setTimeout(() => {
      toast.classList.remove("visible", "hiding");
    }, 220);
  }, 2500);
}

/** Ctrl+C: copy selected sectors or last clicked sector */
function copySelectedSectors() {
  if (state.userRole !== "admin") return;
  const selectedIds = gantt.getSelectedSectorIds();
  let sectors;
  if (selectedIds.length > 0) {
    sectors = state.sectors.filter(s => selectedIds.includes(s.id) && s.status === "active");
  } else if (_ctxSector && _ctxSector.status === "active") {
    sectors = [_ctxSector];
  } else {
    showToast("Chưa chọn chặng nào để copy (Ctrl+Click để chọn)", "warn");
    return;
  }
  if (sectors.length === 0) return;
  state.clipboard = {
    type      : "sectors",
    sectors   : sectors.map(s => ({ ...s })),
    sourceAcId: sectors[0].aircraft_id,
    sourceDate: sectors[0].flight_date,
  };
  showToast(`Đã copy ${sectors.length} chặng bay`, "info");
}

/** Copy all sectors of a given aircraft (for "Copy line") */
function copyAircraftLine(acId, acName) {
  if (state.userRole !== "admin") return;
  const sectors = state.sectors.filter(s => s.aircraft_id === acId && s.status === "active");
  if (sectors.length === 0) {
    showToast(`${acName} không có chặng nào để copy`, "warn");
    return;
  }
  state.clipboard = {
    type      : "line",
    sectors   : sectors.map(s => ({ ...s })),
    sourceAcId: acId,
    sourceDate: state.currentDate,
  };
  showToast(`Đã copy ${sectors.length} chặng của ${acName}`, "info");
}

/** Open paste modal (Ctrl+V) */
function openPasteModal() {
  if (state.userRole !== "admin") return;
  if (!state.clipboard) {
    showToast("Chưa có dữ liệu trong clipboard (dùng Ctrl+C trước)", "warn");
    return;
  }
  const { type, sectors, sourceAcId, sourceDate } = state.clipboard;

  // Populate form
  doc("pasteDate").value = state.currentDate;

  // Aircraft select — show all aircraft
  const sel = doc("pasteAircraftId");
  sel.innerHTML = state.aircraft.map(ac =>
    `<option value="${ac.id}"${ac.id === sourceAcId ? " selected" : ""}>${ac.registration}${ac.ac_type ? " (" + ac.ac_type + ")" : ""}</option>`
  ).join("");

  // Summary of what will be pasted
  const srcAc = state.aircraft.find(a => a.id === sourceAcId);
  const label = type === "line"
    ? `Cả line của ${srcAc ? srcAc.registration : sourceAcId} (${sectors.length} chặng)`
    : `${sectors.length} chặng bay`;
  doc("pasteSummary").textContent = `Sắp paste: ${label} — nguồn: ${sourceDate}`;

  // Build preview list
  const list = doc("pastePreviewList");
  list.innerHTML = sectors.map(s =>
    `<div class="paste-preview-row"><span class="paste-sector-route">${s.origin}→${s.destination}</span>` +
    `<span class="paste-sector-time">${s.dep_utc}–${s.arr_utc} UTC</span></div>`
  ).join("");

  // Show "replace" option only when copying a full line
  const replaceRow = doc("pasteReplaceRow");
  if (type === "line") {
    replaceRow.classList.remove("hidden");
    doc("pasteReplace").checked = true;   // default: replace existing on target date
  } else {
    replaceRow.classList.add("hidden");
    doc("pasteReplace").checked = false;
  }

  doc("pasteModalOverlay").classList.remove("hidden");
}

/** Execute the paste operation */
async function confirmPaste() {
  if (!state.clipboard) return;
  const { type, sectors } = state.clipboard;
  const targetDate  = doc("pasteDate").value;
  const targetAcId  = parseInt(doc("pasteAircraftId").value, 10);
  const doReplace   = doc("pasteReplace").checked;

  if (!targetDate || !targetAcId) {
    alert("Chọn ngày và tàu bay đích"); return;
  }

  const created  = [];
  const failed   = [];
  const deleted  = [];

  // If "replace" is checked (only available for type=line), delete existing active sectors first
  if (type === "line" && doReplace) {
    const existing = state.sectors.filter(
      s => s.aircraft_id === targetAcId && s.flight_date === targetDate && s.status === "active"
    );
    for (const s of existing) {
      try {
        await API.deleteSector(s.id);
        deleted.push(s);
      } catch (e) {
        console.warn("Could not delete sector", s.id, e);
      }
    }
  }

  for (const s of sectors) {
    const payload = {
      aircraft_id : targetAcId,
      flight_date : targetDate,
      origin      : s.origin,
      destination : s.destination,
      dep_utc     : s.dep_utc,
      arr_utc     : s.arr_utc,
      flight_number: s.flight_number || null,
      color       : s.color || null,
    };
    try {
      const result = await API.createSector(payload);
      created.push(result);
    } catch (e) {
      failed.push(`${s.origin}→${s.destination}: ${e.message}`);
    }
  }

  closeModal("pasteModalOverlay");

  if (created.length > 0) {
    const targetAc = state.aircraft.find(a => a.id === targetAcId);
    const deletedCopy = [...deleted];
    history.push({
      label: `Paste ${created.length} chặng vào ${targetAc ? targetAc.registration : targetAcId} (${targetDate})`,
      undo: async () => {
        for (const c of created) await API.deleteSector(c.id).catch(() => {});
        // Restore deleted sectors if replace was used
        for (const s of deletedCopy) await API.createSector({
          aircraft_id: s.aircraft_id, flight_date: s.flight_date,
          origin: s.origin, destination: s.destination,
          dep_utc: s.dep_utc, arr_utc: s.arr_utc,
          flight_number: s.flight_number || null, color: s.color || null,
        }).catch(() => {});
        await refreshGantt();
      },
      redo: async () => {
        for (const s of deletedCopy) await API.deleteSector(s.id).catch(() => {});
        for (const s of sectors) await API.createSector({
          aircraft_id: targetAcId, flight_date: targetDate,
          origin: s.origin, destination: s.destination,
          dep_utc: s.dep_utc, arr_utc: s.arr_utc,
          flight_number: s.flight_number || null, color: s.color || null,
        }).catch(() => {});
        await refreshGantt();
      },
    });

    // Navigate to the pasted date if different
    if (targetDate !== state.currentDate) {
      state.currentDate = targetDate;
      doc("currentDate").value = targetDate;
      updateDateLabel();
      updateSeasonBadge();
    }
    await refreshGantt();
    const replaceMsg = deleted.length > 0 ? ` (đã xóa ${deleted.length} chặng cũ)` : "";
    showToast(`Đã paste ${created.length} chặng bay${replaceMsg}`, "success");
  }

  if (failed.length > 0) {
    alert("Paste thất bại:\n" + failed.join("\n"));
  }
}

// ─── Aircraft label context menu (right-click on ac-label) ───────────────────
let _ctxAircraft = null;

function bindAcContextMenu() {
  // Right-click handler is attached in gantt.js via dispatch event
  document.addEventListener("ac-rightclick", e => {
    _ctxAircraft = e.detail.ac;
    const cm = doc("acContextMenu");
    cm.style.left = e.detail.x + "px";
    cm.style.top  = e.detail.y + "px";
    cm.classList.remove("hidden");
  });

  document.addEventListener("click", () => {
    const cm = doc("acContextMenu");
    if (cm) cm.classList.add("hidden");
  });

  doc("acCmSwap").addEventListener("click", () => {
    if (_ctxAircraft) openSwapModal(_ctxAircraft);
  });
  doc("acCmEdit").addEventListener("click", () => {
    if (_ctxAircraft) openAircraftModal(_ctxAircraft);
  });
  doc("acCmCopy").addEventListener("click", () => {
    if (_ctxAircraft) copyAircraftLine(_ctxAircraft.id, _ctxAircraft.registration);
  });
}

function openSwapModal(ac) {
  // Close any open modal overlays and inline forms first
  document.querySelectorAll(".modal-overlay:not(.hidden)").forEach(m => m.classList.add("hidden"));
  document.querySelectorAll(".inline-form:not(.hidden)").forEach(f => f.classList.add("hidden"));

  doc("swapAcAId").value   = ac.id;
  doc("swapAcAName").value = ac.registration + (ac.ac_type ? ` (${ac.ac_type})` : "");
  doc("swapDateScope").value = "day";

  // Populate target aircraft dropdown (exclude self)
  const sel = doc("swapAcBId");
  sel.innerHTML = "";
  for (const a of state.aircraft) {
    if (a.id === ac.id || a.id === -1) continue;
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = a.registration + (a.ac_type ? ` (${a.ac_type})` : "");
    sel.appendChild(opt);
  }

  const updateHint = () => {
    const scope = doc("swapDateScope").value;
    const hint = scope === "day"
      ? `Sẽ hoán đổi tất cả chuyến bay của ${ac.registration} và tàu được chọn trong ngày ${state.currentDate}.`
      : `Sẽ hoán đổi tất cả chuyến bay trong TOÀN BỘ lịch bay của hai tàu.`;
    doc("swapHintText").textContent = hint;
  };
  updateHint();
  doc("swapDateScope").onchange = updateHint;

  doc("swapAircraftModal").classList.remove("hidden");
}

async function confirmSwap() {
  const acAId = parseInt(doc("swapAcAId").value, 10);
  const acBId = parseInt(doc("swapAcBId").value, 10);
  const scope  = doc("swapDateScope").value;
  const date   = scope === "day" ? state.currentDate : null;

  const acA = state.aircraft.find(a => a.id === acAId);
  const acB = state.aircraft.find(a => a.id === acBId);
  const nameA = acA ? acA.registration : acAId;
  const nameB = acB ? acB.registration : acBId;

  if (!confirm(`Hoán đổi toàn bộ tuyến bay giữa ${nameA} và ${nameB}${date ? " (ngày " + date + ")" : " (tất cả ngày)"}?`)) return;

  try {
    const result = await API.swapAircraft({ aircraft_a_id: acAId, aircraft_b_id: acBId, date });
    doc("swapAircraftModal").classList.add("hidden");
    await refreshGantt();
    alert(`Đã hoán đổi: ${result.swapped_a} chuyến của ${result.aircraft_a} ↔ ${result.swapped_b} chuyến của ${result.aircraft_b}`);
  } catch (err) {
    alert("Lỗi hoán đổi: " + err.message);
  }
}

// ─── Edit aircraft from Gantt label ──────────────────────────────────────────
document.addEventListener("edit-aircraft", e => openAircraftModal(e.detail));

// ─── Main UI bindings ─────────────────────────────────────────────────────────
function bindUI() {
  // Header navigation
  doc("btnPrevPeriod").addEventListener("click", () => navigateDate(-1));
  doc("btnNextPeriod").addEventListener("click", () => navigateDate(+1));
  doc("currentDate").addEventListener("change", e => {
    state.currentDate = e.target.value;
    updateDateLabel();
    updateSeasonBadge();
    refreshView();
  });

  // View mode toggle
  doc("btnViewDay").addEventListener("click",   () => setViewMode("day"));
  doc("btnViewWeek").addEventListener("click",  () => setViewMode("week"));
  doc("btnViewMonth").addEventListener("click", () => setViewMode("month"));

  // Timezone toggle
  doc("btnLCT").addEventListener("click", () => {
    state.timezone = "LCT";
    doc("btnLCT").classList.add("active");
    doc("btnUTC").classList.remove("active");
    refreshView();
  });
  doc("btnUTC").addEventListener("click", () => {
    state.timezone = "UTC";
    doc("btnUTC").classList.add("active");
    doc("btnLCT").classList.remove("active");
    refreshView();
  });

  // Undo / Redo
  doc("btnUndo").addEventListener("click", () => history.undo().then(refreshGantt));
  doc("btnRedo").addEventListener("click", () => history.redo().then(refreshGantt));

  // Logout
  doc("btnLogout").addEventListener("click", async () => {
    if (!confirm("Đăng xuất khỏi hệ thống?")) return;
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", e => {
    // Ignore shortcuts when typing in inputs/textareas/selects
    const tag = e.target.tagName;
    const inInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

    if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
      e.preventDefault(); history.undo().then(refreshGantt);
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
      e.preventDefault(); history.redo().then(refreshGantt);
    }

    // Copy (Ctrl+C): copy selected sectors
    if ((e.ctrlKey || e.metaKey) && e.key === "c" && !inInput) {
      copySelectedSectors();
    }

    // Paste (Ctrl+V): open paste modal
    if ((e.ctrlKey || e.metaKey) && e.key === "v" && !inInput) {
      e.preventDefault();
      openPasteModal();
    }

    if (e.key === "Escape") {
      document.querySelectorAll(".modal-overlay:not(.hidden)").forEach(m => m.classList.add("hidden"));
      doc("contextMenu").classList.add("hidden");
      const _acCm = doc("acContextMenu");
      if (_acCm) _acCm.classList.add("hidden");
    }
  });

  // Toolbar buttons
  doc("btnAddAircraft").addEventListener("click", () => openAircraftModal());
  doc("btnAddSector").addEventListener("click",   () => openSectorModal());
  doc("btnRules").addEventListener("click",       openRulesModal);
  doc("btnReport").addEventListener("click",      openReportModal);
  doc("btnExport").addEventListener("click",      openExportModal);
  doc("btnSaveFile").addEventListener("click",    saveScheduleFile);
  doc("btnImportFile").addEventListener("click",  openImportFile);
  doc("btnAuditLog").addEventListener("click",    openAuditModal);
  if (doc("btnAddMaintenance")) {
    doc("btnAddMaintenance").addEventListener("click", () => openMaintenanceModal());
  }

  // Sector modal
  doc("btnSaveSector").addEventListener("click", saveSector);
  doc("sectorColor").addEventListener("input", () => {
    doc("sectorColor").dataset.hasColor = "1";
  });
  doc("btnResetSectorColor").addEventListener("click", () => {
    // Reset to aircraft color or default
    const acId = parseInt(doc("sectorAircraftId").value, 10);
    const ac = state.aircraft.find(a => a.id === acId);
    doc("sectorColor").value = (ac && ac.color) ? ac.color : "#2563eb";
    doc("sectorColor").dataset.hasColor = "0";
  });
  doc("sectorDep").addEventListener("change",    autoFillArr);
  doc("sectorDep").addEventListener("input",     updateTimeHints);
  doc("sectorBlockTime").addEventListener("input",autoFillArr);
  doc("sectorOrigin").addEventListener("change", () => { autoFillArr(); updateTimeHints(); });
  doc("sectorDest").addEventListener("change",   () => { autoFillArr(); updateTimeHints(); });
  doc("sectorArr").addEventListener("change",    () => {
    const dep  = doc("sectorDep").value;
    const arr  = doc("sectorArr").value;
    if (dep && arr) {
      // Compute block time in UTC
      const depUTC = sectorModalTZ === "LCT" ? applyTZ(dep, -getOriginOffset()) : dep;
      const arrUTC = sectorModalTZ === "LCT" ? applyTZ(arr, -getDestOffset())   : arr;
      doc("sectorBlockTime").value = blockMin(depUTC, arrUTC);
    }
    autoFillArr();
  });
  doc("sectorArr").addEventListener("input", updateTimeHints);
  // TZ toggle buttons in sector modal
  doc("sectorTZUtc").addEventListener("click", () => setSectorModalTZ("UTC"));
  doc("sectorTZLct").addEventListener("click", () => setSectorModalTZ("LCT"));

  // Aircraft modal
  doc("btnSaveAircraft").addEventListener("click", saveAircraft);
  doc("aircraftColor").addEventListener("input", () => {
    doc("aircraftColor").dataset.hasColor = "1";
  });
  doc("btnResetAircraftColor").addEventListener("click", () => {
    doc("aircraftColor").value = "#2563eb";
    doc("aircraftColor").dataset.hasColor = "0";
  });

  // Rules modal buttons
  doc("btnSaveMassTAT").addEventListener("click", saveMassTAT);
  doc("btnAddTAT").addEventListener("click", () => {
    doc("tatId").value = "";
    doc("tatStation").value = "";
    doc("tatTime").value = "00:40";
    doc("tatIsDomestic").value = "";
    doc("tatFormTitle").textContent = "Thêm TAT Rule";
    doc("tatFormModal").classList.remove("hidden");
  });
  doc("btnSaveTAT").addEventListener("click", saveTAT);
  // Auto-fill is_domestic when station matches a known airport
  doc("tatStation").addEventListener("input", () => {
    const code = doc("tatStation").value.toUpperCase().trim();
    const ap = state.airports[code];
    if (ap) {
      doc("tatIsDomestic").value = ap.timezone_offset === 7 ? "true" : "false";
    }
  });
  doc("btnExportTAT").addEventListener("click", exportTATExcel);
  doc("btnImportTAT").addEventListener("click", () => doc("tatFileInput").click());
  doc("tatFileInput").addEventListener("change", importTATExcel);

  doc("btnAddBT").addEventListener("click", () => {
    doc("btId").value = "";
    doc("btOrigin").value = "";
    doc("btDest").value = "";
    doc("btTime").value = "01:30";
    doc("btFormTitle").textContent = "Thêm Block Time Rule";
    doc("btFormModal").classList.remove("hidden");
  });
  doc("btnSaveBT").addEventListener("click", saveBT);
  doc("btnExportBT").addEventListener("click", exportBTExcel);
  doc("btnImportBT").addEventListener("click", () => doc("btFileInput").click());
  doc("btFileInput").addEventListener("change", importBTExcel);

  doc("btnAddReg").addEventListener("click", () => {
    doc("regId").value = "";
    doc("regNumber").value = "";
    doc("regModel").value = "";
    doc("regSeats").value = "";
    doc("regForm").classList.remove("hidden");
  });
  doc("btnSaveReg").addEventListener("click", saveReg);
  doc("btnCancelReg").addEventListener("click", () => doc("regForm").classList.add("hidden"));

  // User management
  doc("btnAddUser").addEventListener("click", () => {
    doc("userId").value = "";
    doc("userUsername").value = "";
    doc("userPassword").value = "";
    doc("userDisplayName").value = "";
    doc("userRole").value = "viewer";
    doc("userFormTitle").textContent = "Thêm tài khoản";
    doc("userFormModal").classList.remove("hidden");
  });
  doc("btnSaveUser").addEventListener("click", saveUser);

  // Airport modal
  doc("btnAddAirport").addEventListener("click", () => {
    doc("apCode").value = "";
    doc("apCodeInput").value = "";
    doc("apCodeInput").disabled = false;
    doc("apName").value = "";
    doc("apTZ").value = "7";
    doc("apType").value = "domestic";
    doc("airportForm").classList.remove("hidden");
  });
  doc("btnSaveAirport").addEventListener("click", saveAirport);
  doc("btnCancelAirport").addEventListener("click", () => {
    doc("airportForm").classList.add("hidden");
    doc("apCodeInput").disabled = false;
  });

  // Export modal
  doc("btnRunExport").addEventListener("click", runExport);
  doc("btnDownloadTT").addEventListener("click", () => {
    if (state.lastExportData) downloadJSON(state.lastExportData, "timetable.json");
    else alert("Hãy xem trước rồi tải.");
  });

  // Report modal
  doc("btnRunReport").addEventListener("click", runReport);
  doc("btnDownloadReport").addEventListener("click", () => {
    if (state.lastReportData) downloadJSON(state.lastReportData, "report.json");
    else alert("Hãy xem trước rồi tải.");
  });

  // File import
  doc("importFileInput").addEventListener("change", handleImportFile);

  // Audit log modal
  const _btnRefreshAudit = doc("btnRefreshAudit");
  if (_btnRefreshAudit) _btnRefreshAudit.addEventListener("click", renderAuditLog);
  const _auditFilterEntity = doc("auditFilterEntity");
  if (_auditFilterEntity) _auditFilterEntity.addEventListener("change", renderAuditLog);

  // Maintenance modal
  const _btnSaveMx = doc("btnSaveMaintenance");
  if (_btnSaveMx) _btnSaveMx.addEventListener("click", saveMaintenance);
  const _btnDelMx = doc("btnDeleteMaintenance");
  if (_btnDelMx) _btnDelMx.addEventListener("click", deleteMaintenance);

  // Season form modal
  if (doc("btnSaveSeason")) doc("btnSaveSeason").addEventListener("click", saveSeason);
  if (doc("btnAddSeason")) doc("btnAddSeason").addEventListener("click", () => {
    doc("seasonId").value    = "";
    doc("seasonName").value  = "";
    doc("seasonType").value  = "summer";
    doc("seasonStart").value = "";
    doc("seasonEnd").value   = "";
    doc("seasonFormTitle").textContent = "Thêm mùa bay";
    doc("seasonFormModal").classList.remove("hidden");
  });
  if (doc("btnLoadDefaultSeasons")) doc("btnLoadDefaultSeasons").addEventListener("click", loadDefaultSeasons);

  // Context menu
  bindContextMenu();
  bindAcContextMenu();
  bindCloseButtons();
  bindTabs();

  // Swap modal confirm
  const _btnConfirmSwap = doc("btnConfirmSwap");
  if (_btnConfirmSwap) _btnConfirmSwap.addEventListener("click", confirmSwap);

  // Paste modal confirm
  const _btnConfirmPaste = doc("btnConfirmPaste");
  if (_btnConfirmPaste) _btnConfirmPaste.addEventListener("click", confirmPaste);
}

// ─── Expose helpers used from inline onclick attributes ───────────────────────
window.editTAT      = editTAT;
window.deleteTAT    = deleteTAT;
window.editBT       = editBT;
window.deleteBT     = deleteBT;
window.editReg      = editReg;
window.deleteReg    = deleteReg;
window.editAirport  = editAirport;
window.deleteAirport= deleteAirport;
window.editUser     = editUser;
window.deleteUser   = deleteUser;
window.editSeason   = editSeason;
window.deleteSeason = deleteSeason;
window.openMaintenanceModal = openMaintenanceModal;
window.openSwapModal        = openSwapModal;
window.openPasteModal       = openPasteModal;

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", init);
