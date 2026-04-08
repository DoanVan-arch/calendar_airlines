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
  registrations: [],            // Registration objects from API
  maintenance : [],             // MaintenanceBlock objects
  currentSeason: null,          // currently active Season or null
  lastExportData : null,
  lastReportData : null,
  userRole    : "viewer",       // "admin" | "viewer" — loaded from /api/auth/me
  username    : "",
  clipboard   : null,           // { type:'sectors'|'line', sectors:[...], sourceAcId, sourceDate }
  routeColors : {},             // keyed by "ORIG-DEST" → color string
  routeColorEnabled : false,    // toggle for route-based coloring
};

const history = new HistoryManager();

// ─── Sector modal TZ mode ────────────────────────────────────────────────────
// Tracks whether the sector modal time inputs are in UTC or LCT mode.
let sectorModalTZ = "UTC";

// ─── Gantt instance ──────────────────────────────────────────────────────────
let gantt;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function todayStr() {
  return dateToStr(new Date());
}

function timeToMin(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function minToTime(m) {
  m = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Convert minutes to decimal hours string, e.g. 90 → "01.50", 165 → "02.75" */
function minToDecimal(m) {
  const hours = Math.floor(m / 60);
  const frac  = Math.round((m % 60) / 60 * 100);
  return `${String(hours).padStart(2, "0")}.${String(frac).padStart(2, "0")}`;
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

function minToHHMM(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
}

/**
 * Check if a proposed sector overlaps any existing active sector
 * on the same aircraft & date. Returns true if overlap found.
 */
function _checkSectorOverlap(acId, date, depUtc, arrUtc, excludeId) {
  const pool = state.allSectors || state.sectors || [];
  const depMin = timeToMin(depUtc);
  let arrMin = timeToMin(arrUtc);
  if (arrMin <= depMin) arrMin += 1440;

  for (const s of pool) {
    if (s.aircraft_id !== acId) continue;
    if (s.status !== "active") continue;
    if (s.flight_date !== date) continue;
    if (excludeId && s.id === excludeId) continue;

    const sDep = timeToMin(s.dep_utc);
    let sArr = timeToMin(s.arr_utc);
    if (sArr <= sDep) sArr += 1440;

    if (depMin < sArr && sDep < arrMin) return true;
  }
  return false;
}

function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function downloadExcel(data, filename) {
  if (typeof XLSX === "undefined") { alert("Thư viện XLSX chưa tải xong."); return; }
  const wb = XLSX.utils.book_new();
  let rows;
  if (data.mode === "daily") {
    rows = data.rows.map(r => ({
      "Tàu":         r.aircraft_reg,
      "Chặng bay":   r.route || (r.origin + "-" + r.destination),
      "Điểm đi":    r.origin,
      "Điểm đến":   r.destination,
      [`Cất (${data.timezone})`]:  r.dep_display,
      [`Hạ (${data.timezone})`]:   r.arr_display,
      "Block":       minToHHMM(r.block_time_minutes),
      "DAY":         r.day_of_week || "",
      "Chuyến":      r.flight_number || "",
      "Ngày bay":    r.date_range || r.flight_date || "",
      "Số CB":       r.flight_count || 1,
      "Ghế":         r.total_seats || 0,
    }));
  } else {
    rows = data.rows.map(r => ({
      "Chặng bay":   r.route || (r.origin + "-" + r.destination),
      "Điểm đi":    r.origin,
      "Điểm đến":   r.destination,
      [`Cất (${data.timezone})`]:  r.dep_display,
      [`Hạ (${data.timezone})`]:   r.arr_display,
      "Block":       minToHHMM(r.block_time_minutes),
      "DAY":         r.day_of_week || "",
      "Ngày bay":    r.date_range,
      "Số CB":       r.flight_count,
      "Ghế":         r.total_seats || 0,
      "Tàu":         r.aircraft.join(", "),
    }));
  }
  const ws = XLSX.utils.json_to_sheet(rows);
  // Auto-size columns
  const colWidths = Object.keys(rows[0] || {}).map(k => {
    const maxLen = Math.max(k.length, ...rows.map(r => String(r[k] || "").length));
    return { wch: Math.min(maxLen + 2, 30) };
  });
  ws["!cols"] = colWidths;
  XLSX.utils.book_append_sheet(wb, ws, data.mode === "daily" ? "Timetable" : "Grouped");
  XLSX.writeFile(wb, filename);
}

function downloadReportExcel(data, filename) {
  if (typeof XLSX === "undefined") { alert("Thư viện XLSX chưa tải xong."); return; }
  const wb = XLSX.utils.book_new();
  let rows;
  if (data.sort_by === "aircraft" && data.aircraft_rows) {
    rows = data.aircraft_rows.map(r => ({
      "#":            r.line_order,
      "Tàu":         r.registration,
      "Loại":        r.name,
      "Total BH":    r.total_block_hours + "h",
      "BH/ngày":     r.avg_daily_block_hours + "h",
      "Số chặng":    r.sector_count,
      "Ghế/chặng":   r.seats || 0,
      "Tổng ghế":    r.total_seats || 0,
    }));
  } else if (data.route_rows) {
    rows = data.route_rows.map(r => ({
      "Đường bay":   r.route,
      "Total BH":    r.total_block_hours + "h",
      "Số chặng":    r.sector_count,
      "Ngày bay":    r.unique_dates,
      "Ghế":         r.total_seats || 0,
    }));
  }
  if (!rows || rows.length === 0) { alert("Không có dữ liệu."); return; }
  const ws = XLSX.utils.json_to_sheet(rows);
  const colWidths = Object.keys(rows[0] || {}).map(k => {
    const maxLen = Math.max(k.length, ...rows.map(r => String(r[k] || "").length));
    return { wch: Math.min(maxLen + 2, 30) };
  });
  ws["!cols"] = colWidths;
  XLSX.utils.book_append_sheet(wb, ws, data.sort_by === "aircraft" ? "Aircraft" : "Routes");
  XLSX.writeFile(wb, filename);
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
  const [aircraft, airports, btRules, tatRules, massTAT, seasons, registrations, routeColors, rcEnabledSetting] = await Promise.all([
    API.getAircraft(),
    API.getAirports(),
    API.getBlockTimeRules(),
    API.getTATRules(),
    API.getMassTAT().catch(() => ({ domestic: 40, international: 60 })),
    API.getSeasons().catch(() => []),
    API.getRegistrations().catch(() => []),
    API.getRouteColors().catch(() => []),
    API.getSetting("route_color_enabled").catch(() => ({ key: "route_color_enabled", value: null })),
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
  state.registrations = registrations;

  // Route colors map: "ORIG-DEST" → color
  state.routeColors = {};
  for (const rc of routeColors) state.routeColors[`${rc.origin}-${rc.destination}`] = rc.color;
  state.routeColorEnabled = rcEnabledSetting.value === "true";
  doc("chkRouteColorEnabled").checked = state.routeColorEnabled;

  updateSeasonBadge();
}

async function refreshGantt() {
  // Build date strings for all days shown in the ruler
  const datesToFetch = [];
  const baseD = new Date(state.currentDate + "T00:00:00");
  for (let i = 0; i < DAYS_SHOWN; i++) {
    const d = new Date(baseD);
    d.setDate(d.getDate() + i);
    const y = d.getFullYear(), mo = String(d.getMonth()+1).padStart(2,"0"), dy = String(d.getDate()).padStart(2,"0");
    datesToFetch.push(`${y}-${mo}-${dy}`);
  }

  // Previous day (for showing connection from previous day's last sector)
  const prevD = new Date(baseD);
  prevD.setDate(prevD.getDate() - 1);
  const prevDateStr = `${prevD.getFullYear()}-${String(prevD.getMonth()+1).padStart(2,"0")}-${String(prevD.getDate()).padStart(2,"0")}`;

  // Fetch sectors for each visible day + previous day + warnings + maintenance
  const endDate = datesToFetch[datesToFetch.length - 1];
  const [sectorsByDay, prevDaySectors, warningsByDay, maintenance] = await Promise.all([
    Promise.all(datesToFetch.map(d => API.getSectors(d).catch(() => []))),
    API.getSectors(prevDateStr).catch(() => []),
    Promise.all(datesToFetch.map(d => API.getWarnings(d).then(r => r.warnings || []).catch(() => []))),
    API.getMaintenance({ start: state.currentDate, end: endDate }).catch(() => []),
  ]);

  // Merge and deduplicate warnings across all days (by sector_id + type)
  const seenWarnings = new Set();
  const mergedWarnings = [];
  for (let i = 0; i < warningsByDay.length; i++) {
    for (const w of warningsByDay[i]) {
      const key = `${w.type}|${w.sector_id || ""}|${w.next_sector_id || ""}`;
      if (!seenWarnings.has(key)) {
        seenWarnings.add(key);
        mergedWarnings.push({ ...w, _date: datesToFetch[i] });
      }
    }
  }

  // Tag each sector with its _dayOffset
  const allSectors = [];
  for (let i = 0; i < datesToFetch.length; i++) {
    for (const s of sectorsByDay[i]) {
      allSectors.push({ ...s, _dayOffset: i });
    }
  }

  // Build prevDayLastSector map: aircraft_id → last sector of previous day
  const prevDayLast = {};
  for (const s of prevDaySectors) {
    if (s.status !== "active") continue;
    const existing = prevDayLast[s.aircraft_id];
    if (!existing || s.arr_utc > existing.arr_utc) {
      prevDayLast[s.aircraft_id] = s;
    }
  }

  state.sectors    = sectorsByDay[0];   // day-0 sectors for clipboard/paste logic
  state.allSectors = allSectors;       // all visible sectors (all days) for drag-drop/lookup
  state.warnings   = mergedWarnings;
  state.maintenance= maintenance;

  gantt.render({
    aircraft      : state.aircraft,
    sectors       : allSectors,
    airports      : state.airports,
    timezone      : state.timezone,
    warnings      : state.warnings,
    maintenance   : state.maintenance,
    currentDate   : state.currentDate,
    prevDayLast   : prevDayLast,
    routeColors   : state.routeColorEnabled ? state.routeColors : null,
  });

  renderWarnings();
}

// ─── Warnings panel ───────────────────────────────────────────────────────────
function renderWarnings() {
  const list  = document.getElementById("warningList");
  const badge = document.getElementById("warningBadge");
  const toggleBadge = document.getElementById("warningBadgeToggle");
  badge.textContent = state.warnings.length;
  toggleBadge.textContent = state.warnings.length;

  if (state.warnings.length === 0) {
    list.innerHTML = '<div class="no-warnings">Không có cảnh báo</div>';
    return;
  }
  list.innerHTML = "";

  if (DAYS_SHOWN > 1) {
    // Group warnings by date
    const grouped = {};
    for (const w of state.warnings) {
      const d = w._date || "unknown";
      if (!grouped[d]) grouped[d] = [];
      grouped[d].push(w);
    }
    // Render each day group with a header
    for (const [date, warnings] of Object.entries(grouped)) {
      const header = document.createElement("div");
      header.className = "warning-day-header";
      header.innerHTML = `<span class="warning-day-label">${date}</span><span class="badge warning-day-badge">${warnings.length}</span>`;
      list.appendChild(header);

      for (const w of warnings) {
        const div = document.createElement("div");
        div.className = "warning-item" + (w.severity === "error" ? " error" : "");
        div.innerHTML = `<div class="w-type">${w.type}</div>${w.message}`;
        div.addEventListener("click", () => highlightSector(w.sector_id));
        list.appendChild(div);
      }
    }
  } else {
    // Single day — flat list (no headers)
    for (const w of state.warnings) {
      const div = document.createElement("div");
      div.className = "warning-item" + (w.severity === "error" ? " error" : "");
      div.innerHTML = `<div class="w-type">${w.type}</div>${w.message}`;
      div.addEventListener("click", () => highlightSector(w.sector_id));
      list.appendChild(div);
    }
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
  doc("mxStartTime").value = block ? (block.start_time || "") : "";
  doc("mxEndTime").value   = block ? (block.end_time || "") : "";
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
  const startTime= doc("mxStartTime").value || null;
  const endTime  = doc("mxEndTime").value || null;
  const color    = doc("mxColor").value;

  if (!acId || !startDate || !endDate) {
    alert("Vui lòng điền đầy đủ thông tin bắt buộc."); return;
  }
  if (endDate < startDate) {
    alert("Ngày kết thúc phải sau ngày bắt đầu."); return;
  }

  try {
    const payload = { aircraft_id: acId, label, start_date: startDate, end_date: endDate, start_time: startTime, end_time: endTime, color };
    if (id) await API.updateMaintenance(parseInt(id, 10), payload);
    else    await API.createMaintenance(payload);
    closeModal("maintenanceModalOverlay");
    await refreshView();
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
    await refreshView();
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
  // Use local date parts to avoid UTC offset shifting the day
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dy = String(d.getDate()).padStart(2, "0");
  state.currentDate = `${y}-${mo}-${dy}`;
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

  // Days-shown selector only relevant in day view
  const daysCtrl = doc("daysShownCtrl");
  if (daysCtrl) daysCtrl.style.display = mode === "day" ? "" : "none";

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
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ─── Week view renderer ───────────────────────────────────────────────────────
async function refreshWeekView() {
  const weekDates = getWeekDates(state.currentDate);
  const start = dateToStr(weekDates[0]);
  const end   = dateToStr(weekDates[6]);
  const today = todayStr();

  // Fetch sectors, maintenance, and notes for the week
  const [sectors, maintenance, notes] = await Promise.all([
    API.getSectorsPeriod(start, end),
    API.getMaintenance({ start, end }).catch(() => []),
    API.getNotes({ start, end }).catch(() => []),
  ]);

  // Index maintenance by aircraft_id
  const mxByAc = {};
  for (const mx of maintenance) {
    if (!mxByAc[mx.aircraft_id]) mxByAc[mx.aircraft_id] = [];
    mxByAc[mx.aircraft_id].push(mx);
  }

  // Index notes by date (expand range notes across all days they span)
  const notesByDate = {};
  for (const n of notes) {
    const endDate = n.note_end_date || n.note_date;
    let cur = new Date(n.note_date + "T00:00:00");
    const last = new Date(endDate + "T00:00:00");
    while (cur <= last) {
      const ds2 = dateToStr(cur);
      if (!notesByDate[ds2]) notesByDate[ds2] = [];
      notesByDate[ds2].push(n);
      cur.setDate(cur.getDate() + 1);
    }
  }

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
    // Day header notes chips
    const dayNotes = notesByDate[dateToStr(d)] || [];
    for (const note of dayNotes) {
      const chip = document.createElement("div");
      chip.className = "week-note-chip";
      if (note.note_end_date && note.note_end_date !== note.note_date) chip.classList.add("note-range");
      chip.style.background = (note.color || "#3b82f6") + "cc";
      chip.style.borderLeft = `3px solid ${note.color || "#3b82f6"}`;
      const timePrefix = note.start_time ? `${note.start_time} ` : "";
      chip.textContent = timePrefix + note.content;
      const dateInfo = note.note_end_date && note.note_end_date !== note.note_date
        ? `\n${note.note_date} → ${note.note_end_date}` : "";
      chip.title = note.content + (note.start_time ? `\n${note.start_time}–${note.end_time || ""}` : "") + dateInfo;
      chip.addEventListener("click", e => {
        e.stopPropagation();
        openNoteModal(note, dateToStr(d));
      });
      cell.appendChild(chip);
    }
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

      // Maintenance bars for this aircraft on this day
      const acMx = (mxByAc[ac.id] || []).filter(mx => mx.start_date <= ds && mx.end_date >= ds);
      for (const mx of acMx) {
        const bar = document.createElement("div");
        bar.className = "week-mx-bar";
        bar.style.background = (mx.color || "#f59e0b") + "33";
        bar.style.borderLeft = `3px solid ${mx.color || "#f59e0b"}`;
        bar.textContent = mx.label || "MX";
        bar.title = `Bảo dưỡng: ${mx.label || "Maintenance"} (${mx.start_date}→${mx.end_date})`;
        if (state.userRole === "admin") {
          bar.addEventListener("click", e => {
            e.stopPropagation();
            openMaintenanceModal(mx);
          });
        }
        cell.appendChild(bar);
      }

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
          const sColor = routeColorFromSector(s);
          pill.style.borderLeft = `4px solid ${sColor}`;
          pill.style.background = sColor;
          const pillTxt = getContrastColor(sColor);
          pill.style.color = pillTxt;
          pill.style.textShadow = pillTxt === "#000"
            ? "0 1px 2px rgba(255,255,255,0.3)"
            : "0 1px 2px rgba(0,0,0,0.5)";
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

// ─── Month view renderer ──────────────────────────────────────────────────
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

  const calStart = new Date(firstDay);
  calStart.setDate(calStart.getDate() - startPad);
  const calEnd   = new Date(calStart);
  calEnd.setDate(calStart.getDate() + rows * 7 - 1);

  const startStr = dateToStr(calStart);
  const endStr   = dateToStr(calEnd);
  const monthStr = `${year}-${String(month+1).padStart(2,"0")}`;

  // Fetch maintenance blocks + notes for this month range
  const [maintenance, notes] = await Promise.all([
    API.getMaintenance({ start: startStr, end: endStr }).catch(() => []),
    API.getNotes({ month: monthStr }).catch(() => []),
  ]);

  // Index maintenance by aircraft_id
  const mxByAc = {};
  for (const mx of maintenance) {
    if (!mxByAc[mx.aircraft_id]) mxByAc[mx.aircraft_id] = [];
    mxByAc[mx.aircraft_id].push(mx);
  }

  // Index notes by date (expand range notes across all days they span)
  const notesByDate = {};
  for (const n of notes) {
    const endDate = n.note_end_date || n.note_date;
    let cur = new Date(n.note_date + "T00:00:00");
    const last = new Date(endDate + "T00:00:00");
    while (cur <= last) {
      const ds2 = dateToStr(cur);
      if (!notesByDate[ds2]) notesByDate[ds2] = [];
      notesByDate[ds2].push(n);
      cur.setDate(cur.getDate() + 1);
    }
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

    // Maintenance bars: one bar per aircraft that has active maintenance this day
    const mxBarsDiv = document.createElement("div");
    mxBarsDiv.className = "month-mx-bars";
    for (const ac of state.aircraft) {
      const acMx = (mxByAc[ac.id] || []).filter(mx => mx.start_date <= ds && mx.end_date >= ds);
      for (const mx of acMx) {
        const bar = document.createElement("div");
        bar.className = "month-mx-bar";
        bar.style.background = (mx.color || "#f59e0b") + "cc";
        bar.style.borderLeft  = `3px solid ${mx.color || "#f59e0b"}`;
        bar.title = `${ac.registration}: ${mx.label || "Maintenance"} (${mx.start_date}→${mx.end_date})`;
        bar.textContent = `${ac.registration} – ${mx.label || "MX"}`;
        if (state.userRole === "admin") {
          bar.addEventListener("click", e => {
            e.stopPropagation();
            openMaintenanceModal(mx);
          });
        }
        mxBarsDiv.appendChild(bar);
      }
    }
    if (mxBarsDiv.children.length > 0) cell.appendChild(mxBarsDiv);

    // Notes chips
    const dayNotes = notesByDate[ds] || [];
    for (const note of dayNotes) {
      const chip = document.createElement("div");
      chip.className = "month-note-chip";
      if (note.note_end_date && note.note_end_date !== note.note_date) chip.classList.add("note-range");
      chip.style.background = (note.color || "#3b82f6") + "cc";
      chip.style.borderLeft  = `3px solid ${note.color || "#3b82f6"}`;
      const timePrefix = note.start_time ? `${note.start_time} ` : "";
      chip.textContent = timePrefix + note.content;
      const dateInfo = note.note_end_date && note.note_end_date !== note.note_date
        ? `\n${note.note_date} → ${note.note_end_date}` : "";
      chip.title = note.content + (note.start_time ? `\n${note.start_time}–${note.end_time || ""}` : "") + dateInfo;
      chip.addEventListener("click", e => {
        e.stopPropagation();
        openNoteModal(note, ds);
      });
      cell.appendChild(chip);
    }

    // Add note button (always visible)
    const addNoteBtn = document.createElement("div");
    addNoteBtn.className = "month-add-note";
    addNoteBtn.innerHTML = `<i class="fas fa-plus"></i>`;
    addNoteBtn.title = "Thêm ghi chú";
    addNoteBtn.addEventListener("click", e => {
      e.stopPropagation();
      openNoteModal(null, ds);
    });
    cell.appendChild(addNoteBtn);

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
function _hashRouteColor(origin, dest) {
  const key = [origin, dest].sort().join("");
  let h = 0;
  for (const c of key) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0;
  return _PALETTE[Math.abs(h) % _PALETTE.length];
}
function routeColorFromSector(s) {
  // When route coloring is enabled, route color takes top priority
  if (state.routeColorEnabled) {
    const rc = state.routeColors[`${s.origin}-${s.destination}`];
    if (rc) return rc;
  }
  // Per-sector color override
  if (s.color) return s.color;
  // Per-aircraft/line color
  const ac = state.aircraft.find(a => a.id === s.aircraft_id);
  if (ac && ac.color) return ac.color;
  // Hash fallback
  return _hashRouteColor(s.origin, s.destination);
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
  // Pre-fill flight number: strip VU prefix for the number-only field
  const rawFN = sector ? (sector.flight_number || "") : "";
  const fnDigits = rawFN.toUpperCase().startsWith("VU") ? rawFN.slice(2) : rawFN;
  document.getElementById("sectorFlightNum").value = fnDigits;
  document.getElementById("sectorWarningBox").classList.add("hidden");
  document.getElementById("sectorWarningBox").textContent = "";

  // Repeat panel — only available when adding a new sector
  const repeatMode = document.getElementById("sectorRepeatMode");
  const repeatPanel = document.getElementById("sectorRepeatPanel");
  const repeatToggleRow = document.getElementById("sectorRepeatToggleRow");
  if (sector) {
    // Editing existing: hide repeat controls entirely
    repeatToggleRow.classList.add("hidden");
    repeatPanel.classList.add("hidden");
    repeatMode.checked = false;
  } else {
    // New sector: show toggle, hide panel, pre-fill date range from current date
    repeatToggleRow.classList.remove("hidden");
    repeatMode.checked = false;
    repeatPanel.classList.add("hidden");
    document.getElementById("sectorDateFrom").value = state.currentDate;
    document.getElementById("sectorDateTo").value   = state.currentDate;
    // Reset DOW checkboxes to all checked
    document.querySelectorAll(".dow-cb").forEach(cb => { cb.checked = true; });
  }

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

  // Always default to UTC when opening the sector modal (UTC is the base)
  setSectorModalTZ("UTC");

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
  const fnRaw   = doc("sectorFlightNum").value.trim();
  const fn       = fnRaw ? ("VU" + fnRaw.toUpperCase()) : null;

  if (!acId || !origin || !dest || !dep || !arr) {
    alert("Vui l\u00F2ng \u0111i\u1EC1n \u0111\u1EA7y \u0111\u1EE7 th\u00F4ng tin b\u1EAFt bu\u1ED9c."); return;
  }

  // If modal is in LCT mode, convert times back to UTC before saving
  if (sectorModalTZ === "LCT") {
    dep = applyTZ(dep, -getOriginOffset());
    arr = applyTZ(arr, -getDestOffset());
  }

  const sectorColor = doc("sectorColor").dataset.hasColor === "1" ? doc("sectorColor").value : null;

  // ── Overlap check (frontend) ──────────────────────────────────────────
  const editId = id ? parseInt(id, 10) : null;
  if (_checkSectorOverlap(acId, date, dep, arr, editId)) {
    alert("Chặng bay bị trùng thời gian với chặng khác trên cùng tàu bay. Không thể lưu.");
    return;
  }

  try {
    if (id) {
      // ── Edit existing sector ────────────────────────────────────────
      if (!date) { alert("Vui lòng chọn ngày bay."); return; }
      const payload = { aircraft_id: acId, flight_date: date, origin, destination: dest,
                        dep_utc: dep, arr_utc: arr, flight_number: fn, color: sectorColor };
      const prev = state.sectors.find(s => s.id === parseInt(id, 10))
                 || (state.allSectors && state.allSectors.find(s => s.id === parseInt(id, 10)));
      const updated = await API.updateSector(parseInt(id, 10), payload);
      history.push({
        label: `Edit sector ${origin}→${dest}`,
        undo: async () => { await API.updateSector(updated.id, prev); await refreshGantt(); },
        redo: async () => { await API.updateSector(updated.id, payload); await refreshGantt(); },
      });
      closeModal("sectorModalOverlay");
      await refreshGantt();
    } else {
      // ── New sector(s) ───────────────────────────────────────────────
      const repeatMode = doc("sectorRepeatMode").checked;

      if (repeatMode) {
        // Date-range + DOW repeat
        const dateFrom = doc("sectorDateFrom").value;
        const dateTo   = doc("sectorDateTo").value;
        if (!dateFrom || !dateTo) { alert("Vui lòng chọn khoảng ngày."); return; }
        if (dateTo < dateFrom)    { alert("Ngày kết thúc phải sau ngày bắt đầu."); return; }

        const selectedDOWs = new Set(
          [...document.querySelectorAll(".dow-cb:checked")].map(cb => parseInt(cb.value, 10))
        );
        if (selectedDOWs.size === 0) { alert("Chọn ít nhất một ngày trong tuần."); return; }

        // Iterate through date range
        const createdIds = [];
        let cur = new Date(dateFrom + "T00:00:00");
        const end = new Date(dateTo   + "T00:00:00");
        while (cur <= end) {
          const dow = cur.getDay();  // 0=Sun, 1=Mon, ..., 6=Sat
          if (selectedDOWs.has(dow)) {
            const flightDate = dateToStr(cur);
            const payload = { aircraft_id: acId, flight_date: flightDate, origin, destination: dest,
                              dep_utc: dep, arr_utc: arr, flight_number: fn, color: sectorColor };
            try {
              const created = await API.createSector(payload);
              createdIds.push(created.id);
            } catch (e) {
              console.warn(`Skip ${flightDate}:`, e.message);
            }
          }
          cur.setDate(cur.getDate() + 1);
        }

        if (createdIds.length === 0) {
          showToast("Không có ngày nào phù hợp trong khoảng đã chọn.", "warn");
          return;
        }

        history.push({
          label: `Add ${createdIds.length} sectors ${origin}→${dest}`,
          undo: async () => {
            for (const sid of createdIds) { try { await API.deleteSector(sid); } catch {} }
            await refreshGantt();
          },
          redo: async () => {
            // best-effort redo
            let cur2 = new Date(dateFrom + "T00:00:00");
            const end2 = new Date(dateTo + "T00:00:00");
            while (cur2 <= end2) {
              if (selectedDOWs.has(cur2.getDay())) {
                const fd = dateToStr(cur2);
                try { await API.createSector({ aircraft_id: acId, flight_date: fd, origin, destination: dest, dep_utc: dep, arr_utc: arr, flight_number: fn, color: sectorColor }); } catch {}
              }
              cur2.setDate(cur2.getDate() + 1);
            }
            await refreshGantt();
          },
        });

        showToast(`Đã tạo ${createdIds.length} chặng bay ${origin}→${dest}.`, "success");
        closeModal("sectorModalOverlay");
        await refreshGantt();
      } else {
        // Single sector
        if (!date) { alert("Vui lòng chọn ngày bay."); return; }
        const payload = { aircraft_id: acId, flight_date: date, origin, destination: dest,
                          dep_utc: dep, arr_utc: arr, flight_number: fn, color: sectorColor };
        const created = await API.createSector(payload);
        history.push({
          label: `Add sector ${origin}→${dest}`,
          undo: async () => { await API.deleteSector(created.id); await refreshGantt(); state.aircraft = await API.getAircraft(); },
          redo: async () => { await API.createSector(payload); await refreshGantt(); },
        });
        closeModal("sectorModalOverlay");
        await refreshGantt();
      }
    }
  } catch (e) {
    alert("Lỗi: " + e.message);
  }
}

// ─── Chain flight entry ───────────────────────────────────────────────────────
function openChainModal() {
  const acSel = doc("chainAircraftId");
  acSel.innerHTML = state.aircraft.map(ac =>
    `<option value="${ac.id}">${ac.registration}${ac.name ? " – " + ac.name : ""}</option>`
  ).join("");
  doc("chainDepTime").value = "";
  doc("chainRoutes").value = "";
  doc("chainDateFrom").value = state.currentDate;
  doc("chainDateTo").value = state.currentDate;
  document.querySelectorAll(".chain-dow-cb").forEach(cb => { cb.checked = true; });
  doc("chainPreviewBox").classList.add("hidden");
  doc("chainPreviewError").classList.add("hidden");
  doc("chainModalOverlay").classList.remove("hidden");
}

function _parseChainRoutes() {
  const text = doc("chainRoutes").value.trim();
  if (!text) return [];
  return text.split(/\n/).map(line => {
    const clean = line.trim().toUpperCase();
    if (!clean) return null;
    // Format: SGN-HAN.VU101  or  SGN-HAN  (flight number optional, separated by .)
    const parts = clean.split(/\./);
    const routePart = parts[0].trim();
    const fnPart = parts[1] ? parts[1].trim() : null;
    const m = routePart.match(/^([A-Z]{3})\s*[-–→>]\s*([A-Z]{3})$/);
    if (!m) return null;
    return { origin: m[1], destination: m[2], flightNumber: fnPart || null };
  }).filter(Boolean);
}

function _getTATForStation(station) {
  if (state.tatRules && state.tatRules[station]) {
    return state.tatRules[station].min_tat_minutes;
  }
  const ap = state.airports && state.airports[station];
  const isDomestic = ap && ap.timezone_offset === 7;
  const mass = state.massTAT || { domestic: 40, international: 60 };
  return isDomestic ? mass.domestic : mass.international;
}

function _buildChainPreview() {
  const routes = _parseChainRoutes();
  const depStr = doc("chainDepTime").value.trim();

  if (routes.length === 0) return { error: "Chưa có chặng bay hợp lệ.", rows: [] };
  if (!depStr) return { error: "Chưa nhập giờ khởi hành.", rows: [] };

  const rows = [];
  let errors = [];
  let currentTimeMin = timeToMin(depStr); // in UTC minutes (may exceed 1440 for next-day)

  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    const ruleKey = `${r.origin}-${r.destination}`;
    const rule = state.blockTimeRules[ruleKey];

    if (!rule) {
      errors.push(`Chặng ${r.origin}-${r.destination}: chưa có block time rule.`);
      break;
    }

    const depMin = currentTimeMin;
    const arrMin = depMin + rule.block_time_minutes;
    const depUTC = minToTime(depMin);
    const arrUTC = minToTime(arrMin);

    // TAT for this station (after arrival)
    let tatMin = 0;
    if (i < routes.length - 1) {
      tatMin = _getTATForStation(r.destination);
    }

    rows.push({
      origin: r.origin,
      destination: r.destination,
      flightNumber: r.flightNumber || null,
      depUTC,
      arrUTC,
      blockMin: rule.block_time_minutes,
      tatMin,
      _depAbsMin: depMin,
      _arrAbsMin: arrMin,
    });

    // Next sector starts after arrival + TAT
    currentTimeMin = arrMin + tatMin;
  }

  // Continuity check: each sector's origin must match previous destination
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].origin !== rows[i - 1].destination) {
      errors.push(`Chặng #${i + 1} ${rows[i].origin}-${rows[i].destination}: điểm đi không khớp với điểm đến chặng trước (${rows[i - 1].destination}).`);
    }
  }

  // Check if flights extend past 24h — informational only
  if (rows.length > 0 && rows[rows.length - 1]._arrAbsMin > 1440) {
    const extraDays = Math.floor(rows[rows.length - 1]._arrAbsMin / 1440);
    errors.push(`Lưu ý: chuỗi bay kéo dài sang +${extraDays} ngày kế tiếp.`);
  }

  return { rows, errors };
}

function previewChain() {
  const { rows, errors } = _buildChainPreview();
  const tbody = doc("chainPreviewBody");
  const errBox = doc("chainPreviewError");
  tbody.innerHTML = "";

  if (rows.length === 0 && errors.length > 0) {
    errBox.textContent = errors.join(" ");
    errBox.classList.remove("hidden");
    doc("chainPreviewBox").classList.remove("hidden");
    return;
  }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const dayOff = Math.floor(r._depAbsMin / 1440);
    const dayTag = dayOff > 0 ? ` <span style="color:#fbbf24;font-size:10px;font-weight:600;">+${dayOff}d</span>` : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${r.origin}→${r.destination}</td>
      <td>${r.flightNumber || "—"}</td>
      <td>${r.depUTC}${dayTag}</td>
      <td>${r.arrUTC}</td>
      <td>${minToTime(r.blockMin)} (${r.blockMin}')</td>
      <td>${r.tatMin > 0 ? r.tatMin + "'" : "—"}</td>`;
    tbody.appendChild(tr);
  }

  if (errors.length > 0) {
    errBox.innerHTML = errors.map(e => `<div>${e}</div>`).join("");
    errBox.classList.remove("hidden");
  } else {
    errBox.classList.add("hidden");
  }

  doc("chainPreviewBox").classList.remove("hidden");
}

async function saveChain() {
  const { rows, errors } = _buildChainPreview();

  // Filter out informational notes, only block on hard errors (missing block time rules)
  const hardErrors = errors.filter(e => !e.startsWith("Cảnh báo:") && !e.startsWith("Lưu ý:"));
  if (hardErrors.length > 0) {
    alert(hardErrors.join("\n"));
    return;
  }
  if (rows.length === 0) {
    alert("Không có chặng bay hợp lệ để tạo.");
    return;
  }

  const acId    = parseInt(doc("chainAircraftId").value, 10);
  const dateFrom = doc("chainDateFrom").value;
  const dateTo   = doc("chainDateTo").value;
  if (!acId || !dateFrom || !dateTo) {
    alert("Vui lòng điền đầy đủ thông tin.");
    return;
  }
  if (dateTo < dateFrom) {
    alert("Ngày kết thúc phải sau ngày bắt đầu.");
    return;
  }

  const selectedDOWs = new Set(
    [...document.querySelectorAll(".chain-dow-cb:checked")].map(cb => parseInt(cb.value, 10))
  );
  if (selectedDOWs.size === 0) {
    alert("Chọn ít nhất một ngày trong tuần.");
    return;
  }

  // Get aircraft color for new sectors
  const ac = state.aircraft.find(a => a.id === acId);
  const sectorColor = (ac && ac.color) ? ac.color : null;

  const createdIds = [];
  let cur = new Date(dateFrom + "T00:00:00");
  const end = new Date(dateTo + "T00:00:00");

  while (cur <= end) {
    const dow = cur.getDay();
    if (selectedDOWs.has(dow)) {
      const baseDate = dateToStr(cur);
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        // Compute which day this leg falls on relative to chain start
        const dayOffset = Math.floor(r._depAbsMin / 1440);
        const sectorDate = _addDaysStr(baseDate, dayOffset);
        const payload = {
          aircraft_id: acId,
          flight_date: sectorDate,
          origin: r.origin,
          destination: r.destination,
          dep_utc: r.depUTC,
          arr_utc: r.arrUTC,
          flight_number: r.flightNumber || null,
          color: sectorColor,
        };
        try {
          const created = await API.createSector(payload);
          createdIds.push(created.id);
        } catch (e) {
          console.warn(`Skip chain sector ${r.origin}-${r.destination} on ${sectorDate}:`, e.message);
        }
      }
    }
    cur.setDate(cur.getDate() + 1);
  }

  if (createdIds.length === 0) {
    showToast("Không tạo được chặng bay nào.", "warn");
    return;
  }

  history.push({
    label: `Add chain ${rows.length} legs x ${Math.ceil(createdIds.length / rows.length)} days`,
    undo: async () => {
      for (const sid of createdIds) { try { await API.deleteSector(sid); } catch {} }
      await refreshGantt();
    },
    redo: async () => { /* complex redo - skip */ await refreshGantt(); },
  });

  const daysCount = Math.ceil(createdIds.length / rows.length);
  showToast(`Đã tạo ${createdIds.length} chặng bay (${rows.length} chặng × ${daysCount} ngày).`, "success");
  closeModal("chainModalOverlay");
  await refreshGantt();
}
function openAircraftModal(ac = null) {
  doc("aircraftId").value    = ac ? ac.id : "";
  doc("aircraftName").value  = ac ? (ac.name || "") : "";
  doc("aircraftColor").value = (ac && ac.color) ? ac.color : "#2563eb";
  doc("aircraftColor").dataset.hasColor = (ac && ac.color) ? "1" : "0";
  doc("aircraftModalTitle").textContent = ac ? "Chỉnh sửa tàu bay" : "Thêm tàu bay";

  // Populate registration select dropdown
  const sel = doc("aircraftRegSelect");
  sel.innerHTML = '<option value="">TẠM (không liên kết)</option>';
  for (const r of (state.registrations || [])) {
    const opt = document.createElement("option");
    opt.value = r.id;
    opt.textContent = `${r.registration} — ${r.aircraft_model} (${r.seats} ghế)${r.dw_type ? " [" + r.dw_type + "]" : ""}`;
    sel.appendChild(opt);
  }
  sel.value = (ac && ac.registration_id) ? ac.registration_id : "";

  // Sync type field and free-text reg field based on current selection
  _syncAircraftModalFromRegSelect(ac);

  doc("aircraftModalOverlay").classList.remove("hidden");
}

/** Sync AC Type and free-text reg field from the current aircraftRegSelect value */
function _syncAircraftModalFromRegSelect(ac) {
  const sel = doc("aircraftRegSelect");
  const regId = sel.value ? parseInt(sel.value, 10) : null;
  const reg = regId ? (state.registrations || []).find(r => r.id === regId) : null;
  const typeEl = doc("aircraftType");
  if (reg) {
    typeEl.value = reg.aircraft_model || "";
    typeEl.readOnly = true;
    typeEl.style.background = "var(--bg-surface2)";
    typeEl.style.cursor = "default";
    doc("regFreeTextGroup").style.display = "none";
    doc("aircraftReg").value = "";
  } else {
    // TẠM: show free-text field, pre-fill with existing reg string if editing
    typeEl.value = (ac && ac.ac_type) ? ac.ac_type : "";
    typeEl.readOnly = false;
    typeEl.style.background = "";
    typeEl.style.cursor = "";
    doc("regFreeTextGroup").style.display = "";
    doc("aircraftReg").value = ac ? (ac.registration || "") : "";
  }
}

async function saveAircraft() {
  const id   = doc("aircraftId").value;
  const nm   = doc("aircraftName").value.trim() || null;
  const color = doc("aircraftColor").dataset.hasColor === "1" ? doc("aircraftColor").value : null;
  const regSelVal = doc("aircraftRegSelect").value;
  const registration_id = regSelVal ? parseInt(regSelVal, 10) : null;

  // Derive registration string and ac_type from linked Registration, or free-text when TẠM
  let reg, type;
  if (registration_id) {
    const linked = (state.registrations || []).find(r => r.id === registration_id);
    if (!linked) { alert("Không tìm thấy Registration đã chọn."); return; }
    reg  = linked.registration;
    type = linked.aircraft_model || null;
  } else {
    reg  = doc("aircraftReg").value.toUpperCase().trim();
    type = doc("aircraftType").value.trim() || null;
    if (!reg) { alert("Vui lòng nhập số hiệu tàu hoặc chọn một Registration."); return; }
  }

  try {
    if (id) {
      await API.updateAircraft(parseInt(id, 10), { registration: reg, ac_type: type, name: nm, color, registration_id });
    } else {
      const created = await API.createAircraft({ registration: reg, ac_type: type, name: nm, color, line_order: state.aircraft.length, registration_id });
      history.push({
        label: `Add aircraft ${reg}`,
        undo: async () => { await API.deleteAircraft(created.id); state.aircraft = await API.getAircraft(); await refreshGantt(); },
        redo: async () => { await API.createAircraft({ registration: reg, ac_type: type, name: nm, color, registration_id }); state.aircraft = await API.getAircraft(); await refreshGantt(); },
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

  // Get all sectors of source aircraft across all visible days
  const pool = state.allSectors || state.sectors;
  const sectorsToMove = pool.filter(s => s.aircraft_id === fromAcId && s.status === "active");
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
    const sector = state.sectors.find(s => s.id === sectorId)
                || (state.allSectors && state.allSectors.find(s => s.id === sectorId));
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
      const sector = state.sectors.find(s => s.id === sectorId)
                  || (state.allSectors && state.allSectors.find(s => s.id === sectorId));
      if (!sector) continue;
      const dep = timeToMin(sector.dep_utc);
      let   arr = timeToMin(sector.arr_utc);
      if (arr <= dep) arr += 1440;
      const bt = arr - dep;
      const newDep = Math.max(0, Math.min(MINUTES_TOTAL() - bt, dep + deltaMin));
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
  const sector = state.sectors.find(s => s.id === sectorId)
              || (state.allSectors && state.allSectors.find(s => s.id === sectorId));
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
    const syncPromises = [];
    for (const r of rules) {
      const ap = state.airports[r.station];
      if (ap) {
        const shouldBeDom = ap.timezone_offset === 7;
        if (r.is_domestic !== shouldBeDom) {
          syncPromises.push(
            API.updateTATRule(r.id, { station: r.station, min_tat_minutes: r.min_tat_minutes, is_domestic: shouldBeDom }).catch(() => {})
          );
          r.is_domestic = shouldBeDom; // update local copy immediately
        }
      }
    }
    if (syncPromises.length > 0) await Promise.all(syncPromises);
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
      <td>${r.ats || ""}</td>
      <td class="action-cell admin-only" style="display:${isAdmin ? "" : "none"}">
        <button class="btn btn-secondary btn-sm" onclick="editBT(${r.id},'${r.origin}','${r.destination}',${r.block_time_minutes},'${(r.ats || "").replace(/'/g, "\\'")}')">Sửa</button>
        <button class="btn btn-danger btn-sm" onclick="deleteBT(${r.id})">Xoá</button>
      </td>`;
    tbody.appendChild(tr);
  }
}

function editTAT(id, station, min, isDomestic) {
  doc("tatId").value = id;
  doc("tatStation").value = station;
  doc("tatTime").value = minToTime(min);
  // Auto-derive from airport if known; otherwise use DB value
  const sel = doc("tatIsDomestic");
  const ap = state.airports[station];
  if (ap) {
    const derived = ap.timezone_offset === 7;
    sel.value = derived ? "true" : "false";
    sel.disabled = true;
    sel.title = "Tự động từ múi giờ sân bay";
  } else {
    if (isDomestic === true || isDomestic === "true") sel.value = "true";
    else if (isDomestic === false || isDomestic === "false") sel.value = "false";
    else sel.value = "";
    sel.disabled = false;
    sel.title = "";
  }
  doc("tatFormTitle").textContent = "Chỉnh sửa TAT Rule";
  doc("tatFormModal").classList.remove("hidden");
}

function editBT(id, orig, dest, min, ats) {
  doc("btId").value = id;
  doc("btOrigin").value = orig;
  doc("btDest").value = dest;
  doc("btTime").value = minToTime(min);
  doc("btATS").value = ats || "";
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
  const ats  = doc("btATS").value.trim();
  if (!orig || !dest || !timeStr) { alert("Điền đầy đủ thông tin"); return; }
  const min = timeToMin(timeStr);
  const data = { origin: orig, destination: dest, block_time_minutes: min, ats: ats || null };
  try {
    if (id) await API.updateBlockTimeRule(parseInt(id,10), data);
    else    await API.createBlockTimeRule(data);
    doc("btFormModal").classList.add("hidden");
    await renderBTTable();
  } catch (e) {
    alert("Lỗi: " + e.message);
  }
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
  state.registrations = registrations;  // keep state in sync for aircraft modal dropdown
  const tbody = doc("regTableBody");
  tbody.innerHTML = "";
  for (const reg of registrations) {
    const dwLabel = reg.dw_type || "-";
    const mtowLabel = reg.mtow != null ? reg.mtow : "-";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${reg.registration}</td>
      <td>${reg.aircraft_model}</td>
      <td>${reg.seats}</td>
      <td>${dwLabel}</td>
      <td>${mtowLabel}</td>
      <td class="action-cell admin-only">
        <button class="btn btn-secondary btn-sm" onclick="editReg(${reg.id},'${reg.registration}','${reg.aircraft_model}',${reg.seats},'${reg.dw_type || ''}',${reg.mtow != null ? reg.mtow : 'null'})">Sửa</button>
        <button class="btn btn-danger btn-sm" onclick="deleteReg(${reg.id})">Xoá</button>
      </td>`;
    tbody.appendChild(tr);
  }
}

function editReg(id, registration, model, seats, dw, mtow) {
  doc("regId").value = id;
  doc("regNumber").value = registration;
  doc("regModel").value = model;
  doc("regSeats").value = seats;
  doc("regDW").value = dw || "";
  doc("regMTOW").value = mtow != null ? mtow : "";
  doc("regFormTitle").textContent = "Chỉnh sửa Registration";
  doc("regFormModal").classList.remove("hidden");
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
    const dw_type = doc("regDW").value || null;
    const mtowStr = doc("regMTOW").value.trim();
    const mtow = mtowStr ? parseFloat(mtowStr) : null;
    
    if (!registration || !aircraft_model || !seats) {
      alert("Điền đầy đủ thông tin");
      return;
    }
    
    const data = { registration, aircraft_model, seats, dw_type, mtow };
    if (id) await API.updateRegistration(parseInt(id, 10), data);
    else await API.createRegistration(data);
    
    doc("regFormModal").classList.add("hidden");
    doc("regId").value = "";
    doc("regNumber").value = "";
    doc("regModel").value = "";
    doc("regSeats").value = "";
    doc("regDW").value = "";
    doc("regMTOW").value = "";
    await renderRegTable();
  } catch (err) {
    alert("Lỗi: " + err.message);
  }
}

// ─── Excel import for Registration ────────────────────────────────────────────
async function importRegExcel(e) {
  const file = e.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append("file", file);

  try {
    const response = await fetch("/api/rules/registration/import/excel", {
      method: "POST",
      body: formData
    });
    if (!response.ok) throw new Error("Import failed");
    const result = await response.json();
    alert(`Đã nhập ${result.imported} registrations từ Excel`);
    await renderRegTable();
  } catch (err) {
    alert("Lỗi: " + err.message);
  }
  e.target.value = "";
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
  doc("airportFormTitle").textContent = "Chỉnh sửa sân bay";
  doc("airportFormModal").classList.remove("hidden");
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
    doc("airportFormModal").classList.add("hidden");
    doc("apCodeInput").disabled = false;
    doc("apCode").value = "";
    state.airports = Object.fromEntries((await API.getAirports()).map(ap => [ap.code, ap]));
    // Sync TAT rules: update is_domestic for ALL TAT rules matching this airport code
    const isDom = tz === 7;
    const allTatRules = await API.getTATRules().catch(() => []);
    const syncPromises = [];
    for (const r of allTatRules) {
      if (r.station === code && r.is_domestic !== isDom) {
        syncPromises.push(
          API.updateTATRule(r.id, { station: r.station, min_tat_minutes: r.min_tat_minutes, is_domestic: isDom }).catch(() => {})
        );
      }
    }
    if (syncPromises.length > 0) await Promise.all(syncPromises);
    await Promise.all([renderAirportTable(), renderTATTable()]);
    await refreshGantt();
  } catch (e) { alert("Lỗi: " + e.message); }
}

// ─── Export timetable modal ───────────────────────────────────────────────────
async function openExportModal() {
  const today = state.currentDate;
  const firstOfMonth = today.slice(0, 8) + "01";
  const lastOfMonth  = dateToStr(new Date(new Date(today).getFullYear(), new Date(today).getMonth() + 1, 0));
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

  // Sort buttons bar
  const sortBar = document.createElement("div");
  sortBar.style.cssText = "margin:8px 0;display:flex;gap:6px;align-items:center;";
  sortBar.innerHTML = `
    <span style="font-size:11px;color:var(--text-muted);">Sắp xếp:</span>
    <button class="btn btn-secondary btn-sm tt-sort-btn" data-sort="default">Mặc định (Tàu → Chặng)</button>
    <button class="btn btn-secondary btn-sm tt-sort-btn" data-sort="route">Theo đường bay</button>
  `;
  el.appendChild(sortBar);

  // Store data for re-sorting
  state._ttDisplayData = data;

  // Bind sort buttons
  sortBar.querySelectorAll(".tt-sort-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const sortMode = btn.dataset.sort;
      const d = state._ttDisplayData;
      if (!d || !d.rows || d.rows.length === 0) return;
      const sorted = [...d.rows];
      if (sortMode === "route") {
        // Pair routes together, then sub-group by aircraft within each pair
        // e.g. BKK-HAN (tàu A), HAN-BKK (tàu A), BKK-HAN (tàu B), HAN-BKK (tàu B), ...
        const _pairKey = (r) => {
          const o = r.origin || r.route.split("-")[0];
          const d = r.destination || r.route.split("-")[1];
          return [o, d].sort().join("-");
        };
        const _isOutbound = (r) => {
          const o = r.origin || r.route.split("-")[0];
          const d = r.destination || r.route.split("-")[1];
          return o < d ? 0 : 1; // outbound (alphabetically first origin) = 0, return = 1
        };
        sorted.sort((a, b) => {
          const pkA = _pairKey(a);
          const pkB = _pairKey(b);
          if (pkA !== pkB) return pkA.localeCompare(pkB);
          // Sub-group by aircraft within the same route pair
          const acA = a.aircraft_reg || "";
          const acB = b.aircraft_reg || "";
          if (acA !== acB) return acA.localeCompare(acB);
          // Outbound before return within same aircraft
          const obA = _isOutbound(a);
          const obB = _isOutbound(b);
          if (obA !== obB) return obA - obB;
          return (a.dep_utc || "").localeCompare(b.dep_utc || "");
        });
      } else {
        // default: aircraft (by line_order) → dep time (same order as Gantt line)
        sorted.sort((a, b) => {
          const loA = a.line_order ?? 0;
          const loB = b.line_order ?? 0;
          if (loA !== loB) return loA - loB;
          const acA = a.aircraft_reg || (a.aircraft ? a.aircraft.join(",") : "");
          const acB = b.aircraft_reg || (b.aircraft ? b.aircraft.join(",") : "");
          if (acA !== acB) return acA.localeCompare(acB);
          return (a.dep_utc || "").localeCompare(b.dep_utc || "");
        });
      }
      _renderTTRows(el, { ...d, rows: sorted });
      // Update active button
      sortBar.querySelectorAll(".tt-sort-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });
  // Mark default as active
  sortBar.querySelector('[data-sort="default"]').classList.add("active");

  _renderTTRows(el, data);
}

function _renderTTRows(container, data) {
  // Remove existing table if any
  const oldTable = container.querySelector(".tt-table");
  if (oldTable) oldTable.remove();

  if (data.mode === "daily") {
    const hdr = `<tr>
      <th>Tàu</th><th>Chặng bay</th><th>Điểm đi</th><th>Điểm đến</th>
      <th>Cất (${data.timezone})</th><th>Hạ (${data.timezone})</th>
      <th>Block</th><th>DAY</th><th>Chuyến</th><th>Ngày bay</th><th>Số CB</th><th>Ghế</th></tr>`;
    const rows = data.rows.map(r => `<tr>
      <td>${r.aircraft_reg}</td>
      <td>${r.route || r.origin + "-" + r.destination}</td>
      <td>${r.origin}</td><td>${r.destination}</td>
      <td>${r.dep_display}</td><td>${r.arr_display}</td>
      <td>${minToHHMM(r.block_time_minutes)}</td><td>${r.day_of_week}</td>
      <td>${r.flight_number || ""}</td>
      <td>${r.date_range || r.flight_date || ""}</td>
      <td>${r.flight_count || 1}</td>
      <td>${r.total_seats || 0}</td></tr>`).join("");
    container.insertAdjacentHTML("beforeend",
      `<table class="tt-table"><thead>${hdr}</thead><tbody>${rows}</tbody></table>`);
  } else {
    const hdr = `<tr>
      <th>Chặng bay</th><th>Điểm đi</th><th>Điểm đến</th>
      <th>Cất (${data.timezone})</th><th>Hạ (${data.timezone})</th>
      <th>Block</th><th>DAY</th><th>Ngày bay</th><th>Số CB</th><th>Ghế</th><th>Tàu</th></tr>`;
    const rows = data.rows.map(r => `<tr>
      <td>${r.route || r.origin + "-" + r.destination}</td>
      <td>${r.origin}</td><td>${r.destination}</td>
      <td>${r.dep_display}</td><td>${r.arr_display}</td>
      <td>${minToHHMM(r.block_time_minutes)}</td><td>${r.day_of_week}</td>
      <td>${r.date_range}</td><td>${r.flight_count}</td>
      <td>${r.total_seats || 0}</td>
      <td>${r.aircraft.join(", ")}</td></tr>`).join("");
    container.insertAdjacentHTML("beforeend",
      `<table class="tt-table"><thead>${hdr}</thead><tbody>${rows}</tbody></table>`);
  }
}

// ─── Report modal ─────────────────────────────────────────────────────────────
async function openReportModal() {
  const today = state.currentDate;
  const firstOfMonth = today.slice(0, 8) + "01";
  const lastOfMonth  = dateToStr(new Date(new Date(today).getFullYear(), new Date(today).getMonth() + 1, 0));
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
      <div class="stat-item">
        <div class="stat-value">${data.summary.total_sectors || 0}</div>
        <div class="stat-label">Tổng chặng</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${(data.summary.total_seats || 0).toLocaleString()}</div>
        <div class="stat-label">Tổng ghế</div>
      </div>
    </div>`;

  let table = "";
  if (data.sort_by === "aircraft" && data.aircraft_rows) {
    const hdr = `<tr><th>#</th><th>Tàu</th><th>Loại</th>
      <th>Total BH</th><th>BH/ngày</th><th>Số chặng</th><th>Ghế/chặng</th><th>Tổng ghế</th></tr>`;
    const rows = data.aircraft_rows.map(r => `<tr>
      <td>${r.line_order}</td><td><strong>${r.registration}</strong></td><td>${r.name}</td>
      <td>${r.total_block_hours}h</td><td>${r.avg_daily_block_hours}h</td>
      <td>${r.sector_count}</td><td>${r.seats || 0}</td><td>${r.total_seats || 0}</td></tr>`).join("");
    table = `<table class="tt-table"><thead>${hdr}</thead><tbody>${rows}</tbody></table>`;
  } else if (data.route_rows) {
    const hdr = `<tr><th>Đường bay</th><th>Total BH</th><th>Số chặng</th><th>Ngày bay</th><th>Ghế</th></tr>`;
    const rows = data.route_rows.map(r => `<tr>
      <td><strong>${r.route}</strong></td><td>${r.total_block_hours}h</td>
      <td>${r.sector_count}</td><td>${r.unique_dates}</td><td>${r.total_seats || 0}</td></tr>`).join("");
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
        sourceDate: state.currentDate,
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
    const selectedIds = gantt.getSelectedSectorIds();
    const toDelete = (selectedIds.length > 1 && selectedIds.includes(_ctxSector.id))
      ? state.sectors.filter(s => selectedIds.includes(s.id))
      : [_ctxSector];
    const label = toDelete.length > 1
      ? `${toDelete.length} chặng đã chọn`
      : `${toDelete[0].origin}→${toDelete[0].destination}`;
    if (!confirm(`Xoá ${label}?`)) return;
    const deletedCopy = toDelete.map(s => ({ ...s }));
    for (const s of toDelete) await API.deleteSector(s.id);
    history.push({
      label: `Delete ${toDelete.length} sector(s)`,
      undo: async () => {
        for (const s of deletedCopy) {
          await API.createSector({ aircraft_id: s.aircraft_id, flight_date: s.flight_date,
            origin: s.origin, destination: s.destination, dep_utc: s.dep_utc, arr_utc: s.arr_utc,
            flight_number: s.flight_number, status: s.status });
        }
        await refreshGantt();
      },
      redo: async () => {
        for (const s of deletedCopy) await API.deleteSector(s.id);
        await refreshGantt();
      },
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
    sectors = (state.allSectors || state.sectors).filter(s => selectedIds.includes(s.id) && s.status === "active");
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
    sourceDate: state.currentDate,
  };
  showToast(`Đã copy ${sectors.length} chặng bay`, "info");
}

/** Copy all sectors of a given aircraft (for "Copy line") */
function copyAircraftLine(acId, acName) {
  if (state.userRole !== "admin") return;
  const sectors = (state.allSectors || state.sectors).filter(s => s.aircraft_id === acId && s.status === "active");
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

  // Single-date default
  doc("pasteDate").value = state.currentDate;
  doc("pasteMultiFrom").value = state.currentDate;
  doc("pasteMultiTo").value   = state.currentDate;

  // Reset multi-mode off
  doc("pasteMultiMode").checked = false;
  doc("pasteSingleDateSection").classList.remove("hidden");
  doc("pasteMultiSection").classList.add("hidden");

  // Wire up multi-mode toggle (remove old listeners by cloning)
  const multiToggle = doc("pasteMultiMode");
  const newToggle = multiToggle.cloneNode(true);
  multiToggle.parentNode.replaceChild(newToggle, multiToggle);
  newToggle.addEventListener("change", () => {
    if (newToggle.checked) {
      doc("pasteSingleDateSection").classList.add("hidden");
      doc("pasteMultiSection").classList.remove("hidden");
    } else {
      doc("pasteSingleDateSection").classList.remove("hidden");
      doc("pasteMultiSection").classList.add("hidden");
    }
    _updatePasteMultiPreview();
  });

  // Wire range+DOW changes to update preview count
  ["pasteMultiFrom","pasteMultiTo"].forEach(id => {
    const el = doc(id);
    const nel = el.cloneNode(true);
    el.parentNode.replaceChild(nel, el);
    nel.addEventListener("change", _updatePasteMultiPreview);
  });
  document.querySelectorAll(".paste-dow-cb").forEach(cb => {
    const nc = cb.cloneNode(true);
    cb.parentNode.replaceChild(nc, cb);
    nc.addEventListener("change", _updatePasteMultiPreview);
  });

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
  list.innerHTML = sectors.map(s => {
    const dayTag = (s._dayOffset > 0) ? `<span class="paste-day-offset">+${s._dayOffset}d</span>` : "";
    return `<div class="paste-preview-row"><span class="paste-sector-route">${s.origin}→${s.destination}</span>` +
      `<span class="paste-sector-time">${s.dep_utc}–${s.arr_utc} UTC</span>${dayTag}</div>`;
  }).join("");

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
  _updatePasteMultiPreview();
}

/** Compute the list of dates that match the multi-date paste settings */
function _pasteMultiDates() {
  const from = doc("pasteMultiFrom").value;
  const to   = doc("pasteMultiTo").value;
  if (!from || !to || to < from) return [];
  const selectedDOW = new Set(
    [...document.querySelectorAll(".paste-dow-cb")]
      .filter(cb => cb.checked)
      .map(cb => parseInt(cb.value, 10))
  );
  const dates = [];
  const cur = new Date(from + "T00:00:00");
  const end = new Date(to + "T00:00:00");
  while (cur <= end) {
    if (selectedDOW.has(cur.getDay())) {
      dates.push(dateToStr(cur));
    }
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function _updatePasteMultiPreview() {
  const preview = doc("pasteMultiPreviewCount");
  if (!preview) return;
  const dates = _pasteMultiDates();
  preview.textContent = dates.length > 0
    ? `Sẽ paste vào ${dates.length} ngày: ${dates.slice(0, 5).join(", ")}${dates.length > 5 ? "…" : ""}`
    : "Không có ngày nào phù hợp";
}

/** Add N days to a "YYYY-MM-DD" string and return "YYYY-MM-DD" */
function _addDaysStr(dateStr, n) {
  if (!n) return dateStr;
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return dateToStr(d);
}

/** Execute the paste operation */
async function confirmPaste() {
  if (!state.clipboard) return;
  const { type, sectors } = state.clipboard;
  const targetAcId  = parseInt(doc("pasteAircraftId").value, 10);
  const doReplace   = doc("pasteReplace").checked;
  const isMulti     = doc("pasteMultiMode").checked;

  // Determine target date(s)
  let targetDates;
  if (isMulti) {
    targetDates = _pasteMultiDates();
    if (targetDates.length === 0) {
      alert("Không có ngày nào phù hợp với điều kiện đã chọn."); return;
    }
  } else {
    const singleDate = doc("pasteDate").value;
    if (!singleDate) { alert("Chọn ngày đích"); return; }
    targetDates = [singleDate];
  }

  if (!targetAcId) {
    alert("Chọn tàu bay đích"); return;
  }

  // Compute the max day offset among copied sectors
  const maxOffset = sectors.reduce((mx, s) => Math.max(mx, s._dayOffset || 0), 0);

  const created  = [];
  const failed   = [];
  const deleted  = [];

  for (const targetDate of targetDates) {
    // If "replace" is checked (only available for type=line), delete existing active sectors
    // on target date AND any offset dates (next-day sectors)
    if (type === "line" && doReplace) {
      const datesToClear = new Set();
      for (let off = 0; off <= maxOffset; off++) {
        datesToClear.add(_addDaysStr(targetDate, off));
      }
      const existing = (state.allSectors || state.sectors).filter(
        s => s.aircraft_id === targetAcId && datesToClear.has(s.flight_date) && s.status === "active"
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
      const dayOffset = s._dayOffset || 0;
      const sectorDate = _addDaysStr(targetDate, dayOffset);
      const payload = {
        aircraft_id : targetAcId,
        flight_date : sectorDate,
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
        failed.push(`${sectorDate} ${s.origin}→${s.destination}: ${e.message}`);
      }
    }
  }

  closeModal("pasteModalOverlay");

  if (created.length > 0) {
    const targetAc = state.aircraft.find(a => a.id === targetAcId);
    const deletedCopy = [...deleted];
    const dateLabel = targetDates.length === 1 ? targetDates[0] : `${targetDates.length} ngày`;
    history.push({
      label: `Paste ${created.length} chặng vào ${targetAc ? targetAc.registration : targetAcId} (${dateLabel})`,
      undo: async () => {
        for (const c of created) await API.deleteSector(c.id).catch(() => {});
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
        for (const date of targetDates) {
          for (const s of sectors) {
            const dayOff = s._dayOffset || 0;
            await API.createSector({
              aircraft_id: targetAcId, flight_date: _addDaysStr(date, dayOff),
              origin: s.origin, destination: s.destination,
              dep_utc: s.dep_utc, arr_utc: s.arr_utc,
              flight_number: s.flight_number || null, color: s.color || null,
            }).catch(() => {});
          }
        }
        await refreshGantt();
      },
    });

    // Navigate to the first pasted date if different
    const firstDate = targetDates[0];
    if (firstDate !== state.currentDate) {
      state.currentDate = firstDate;
      doc("currentDate").value = firstDate;
      updateDateLabel();
      updateSeasonBadge();
    }
    await refreshGantt();
    const replaceMsg = deleted.length > 0 ? ` (đã xóa ${deleted.length} chặng cũ)` : "";
    showToast(`Đã paste ${created.length} chặng bay vào ${dateLabel}${replaceMsg}`, "success");
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
  doc("acCmDelete").addEventListener("click", async () => {
    if (!_ctxAircraft) return;
    const ac = _ctxAircraft;
    const sectorCount = state.sectors.filter(s => s.aircraft_id === ac.id).length;
    const label = sectorCount > 0
      ? `${ac.registration} và ${sectorCount} chặng bay sẽ bị xoá vĩnh viễn.`
      : `${ac.registration}`;
    if (!confirm(`Xoá tàu bay ${label}?`)) return;
    try {
      await API.deleteAircraft(ac.id);
      state.aircraft = await API.getAircraft();
      await refreshGantt();
    } catch (e) {
      alert("Lỗi xoá tàu bay: " + e.message);
    }
  });
}

function openSwapModal(ac) {
  // Close any open modal overlays, inline forms, and context menus first
  document.querySelectorAll(".modal-overlay:not(.hidden)").forEach(m => m.classList.add("hidden"));
  document.querySelectorAll(".inline-form:not(.hidden)").forEach(f => f.classList.add("hidden"));
  const cm = doc("acContextMenu");
  if (cm) cm.classList.add("hidden");

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
    showToast(`Đã hoán đổi: ${result.swapped_a} chuyến của ${result.aircraft_a} ↔ ${result.swapped_b} chuyến của ${result.aircraft_b}`, "success");
  } catch (err) {
    alert("Lỗi hoán đổi: " + err.message);
  }
}

// ─── Edit aircraft from Gantt label ──────────────────────────────────────────
document.addEventListener("edit-aircraft", e => openAircraftModal(e.detail));

// ─── Main UI bindings ─────────────────────────────────────────────────────────
function bindUI() {
  // ── 24h time input auto-format for all .time-input-24h fields ────────────
  document.querySelectorAll(".time-input-24h").forEach(inp => {
    inp.addEventListener("input", e => {
      let v = e.target.value.replace(/[^\d]/g, ""); // digits only
      if (v.length >= 3) v = v.slice(0, 2) + ":" + v.slice(2, 4);
      if (v.length > 5) v = v.slice(0, 5);
      e.target.value = v;
    });
    inp.addEventListener("blur", e => {
      const v = e.target.value.trim();
      if (!v) return;
      const prev = e.target.value;
      const m = v.match(/^(\d{1,2}):?(\d{2})$/);
      if (m) {
        const h = Math.min(23, parseInt(m[1], 10));
        const min = Math.min(59, parseInt(m[2], 10));
        e.target.value = String(h).padStart(2, "0") + ":" + String(min).padStart(2, "0");
      } else {
        e.target.value = "";
      }
      // Always fire change so autoFillArr / updateTimeHints pick up the value
      if (e.target.value !== prev || e.target.value) {
        e.target.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
  });

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

  // Days-shown selector (Gantt day count)
  const daysSelect = doc("daysShownSelect");
  if (daysSelect) {
    daysSelect.addEventListener("change", e => {
      DAYS_SHOWN = parseInt(e.target.value, 10) || 3;
      if (state.viewMode === "day") refreshGantt();
    });
  }

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

  // Zoom buttons
  doc("btnZoomIn").addEventListener("click", () => {
    PX_PER_MIN = Math.min(8, PX_PER_MIN * 1.3);
    if (gantt._aircraft) gantt._reRender();
    gantt._updateZoomIndicator();
  });
  doc("btnZoomOut").addEventListener("click", () => {
    PX_PER_MIN = Math.max(0.3, PX_PER_MIN / 1.3);
    if (gantt._aircraft) gantt._reRender();
    gantt._updateZoomIndicator();
  });
  doc("btnZoomReset").addEventListener("click", () => gantt.resetZoom());

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
  doc("btnAddChain").addEventListener("click",    openChainModal);
  doc("btnChainPreview").addEventListener("click", previewChain);
  doc("btnSaveChain").addEventListener("click",   saveChain);
  doc("btnRules").addEventListener("click",       openRulesModal);
  doc("btnReport").addEventListener("click",      openReportModal);
  doc("btnExport").addEventListener("click",      openExportModal);
  doc("btnSaveFile").addEventListener("click",    saveScheduleFile);
  doc("btnImportFile").addEventListener("click",  openImportFile);
  doc("btnAuditLog").addEventListener("click",    openAuditModal);
  if (doc("btnAddMaintenance")) {
    doc("btnAddMaintenance").addEventListener("click", () => openMaintenanceModal());
  }

  // Route color modal & toggle
  doc("btnRouteColors").addEventListener("click", openRouteColorModal);
  doc("chkRouteColorEnabled").addEventListener("change", async (e) => {
    state.routeColorEnabled = e.target.checked;
    await API.setSetting("route_color_enabled", e.target.checked ? "true" : "false");
    refreshView();
  });
  doc("btnAddRouteColor").addEventListener("click", addRouteColor);

  // Sector modal
  doc("btnSaveSector").addEventListener("click", saveSector);
  doc("sectorRepeatMode").addEventListener("change", () => {
    const checked = doc("sectorRepeatMode").checked;
    doc("sectorRepeatPanel").classList.toggle("hidden", !checked);
    // When switching to repeat mode, sync dateFrom to current sectorDate value
    if (checked) {
      const d = doc("sectorDate").value || state.currentDate;
      doc("sectorDateFrom").value = d;
      if (!doc("sectorDateTo").value || doc("sectorDateTo").value < d) {
        doc("sectorDateTo").value = d;
      }
    }
  });
  doc("sectorColor").addEventListener("input", () => {
    doc("sectorColor").dataset.hasColor = "1";
  });
  doc("sectorColor").addEventListener("change", () => {
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
  doc("aircraftRegSelect").addEventListener("change", () => _syncAircraftModalFromRegSelect(null));
  doc("aircraftColor").addEventListener("input", () => {
    doc("aircraftColor").dataset.hasColor = "1";
  });
  doc("aircraftColor").addEventListener("change", () => {
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
    doc("tatIsDomestic").disabled = false;
    doc("tatIsDomestic").title = "";
    doc("tatFormTitle").textContent = "Thêm TAT Rule";
    doc("tatFormModal").classList.remove("hidden");
  });
  doc("btnSaveTAT").addEventListener("click", saveTAT);
  // Auto-fill is_domestic when station matches a known airport
  doc("tatStation").addEventListener("input", () => {
    const code = doc("tatStation").value.toUpperCase().trim();
    const ap = state.airports[code];
    const sel = doc("tatIsDomestic");
    if (ap) {
      sel.value = ap.timezone_offset === 7 ? "true" : "false";
      sel.disabled = true;
      sel.title = "Tự động từ múi giờ sân bay";
    } else {
      sel.disabled = false;
      sel.title = "";
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
    doc("btATS").value = "";
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
    doc("regDW").value = "";
    doc("regMTOW").value = "";
    doc("regFormTitle").textContent = "Thêm Registration";
    doc("regFormModal").classList.remove("hidden");
  });
  doc("btnSaveReg").addEventListener("click", saveReg);
  doc("btnExportRegExcel").addEventListener("click", () => { window.location.href = "/api/rules/registration/export/excel"; });
  doc("btnImportRegExcel").addEventListener("click", () => doc("regFileInput").click());
  doc("regFileInput").addEventListener("change", importRegExcel);
  doc("btnExportRegCsv").addEventListener("click",   () => { window.location.href = "/api/rules/registration/export/csv"; });

  // ── Warning panel collapse/expand ─────────────────────────────────────────
  const warningPanel = doc("warningPanel");
  const toggleBtn    = doc("btnToggleWarnings");
  const collapseBtn  = doc("btnCollapseWarnings");

  // Restore saved state
  if (localStorage.getItem("warningPanelCollapsed") === "true") {
    warningPanel.classList.add("collapsed");
    toggleBtn.classList.add("visible");
  }

  collapseBtn.addEventListener("click", () => {
    warningPanel.classList.add("collapsed");
    toggleBtn.classList.add("visible");
    localStorage.setItem("warningPanelCollapsed", "true");
  });

  toggleBtn.addEventListener("click", () => {
    warningPanel.classList.remove("collapsed");
    toggleBtn.classList.remove("visible");
    localStorage.setItem("warningPanelCollapsed", "false");
  });

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
    doc("airportFormTitle").textContent = "Thêm sân bay";
    doc("airportFormModal").classList.remove("hidden");
  });
  doc("btnSaveAirport").addEventListener("click", saveAirport);

  // Export modal
  doc("btnRunExport").addEventListener("click", runExport);
  doc("btnDownloadTT").addEventListener("click", () => {
    if (state.lastExportData) downloadJSON(state.lastExportData, "timetable.json");
    else alert("Hãy xem trước rồi tải.");
  });
  doc("btnDownloadExcel").addEventListener("click", () => {
    if (state.lastExportData) downloadExcel(state.lastExportData, "timetable.xlsx");
    else alert("Hãy xem trước rồi tải.");
  });

  // Report modal
  doc("btnRunReport").addEventListener("click", runReport);
  doc("btnDownloadReport").addEventListener("click", () => {
    if (state.lastReportData) downloadJSON(state.lastReportData, "report.json");
    else alert("Hãy xem trước rồi tải.");
  });
  doc("btnDownloadReportExcel").addEventListener("click", () => {
    if (state.lastReportData) downloadReportExcel(state.lastReportData, "report.xlsx");
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

  // Note modal
  const _btnSaveNote = doc("btnSaveNote");
  if (_btnSaveNote) _btnSaveNote.addEventListener("click", saveNote);
  const _btnDeleteNote = doc("btnDeleteNote");
  if (_btnDeleteNote) _btnDeleteNote.addEventListener("click", deleteNoteById);
}

// ─── Note modal ──────────────────────────────────────────────────────────────

function openNoteModal(note, dateStr) {
  // note: existing CalendarNote object, or null for new
  // dateStr: "YYYY-MM-DD"
  const isEdit = !!note;
  doc("noteModalTitle").innerHTML = isEdit
    ? '<i class="fas fa-sticky-note"></i> Sửa ghi chú'
    : '<i class="fas fa-sticky-note"></i> Thêm ghi chú';
  doc("noteId").value        = isEdit ? note.id        : "";
  doc("noteDate").value      = isEdit ? note.note_date : (dateStr || "");
  doc("noteEndDate").value   = isEdit ? (note.note_end_date || "") : "";
  doc("noteContent").value   = isEdit ? note.content   : "";
  doc("noteStartTime").value = isEdit ? (note.start_time || "") : "";
  doc("noteEndTime").value   = isEdit ? (note.end_time   || "") : "";
  doc("noteColor").value     = isEdit ? (note.color || "#3b82f6") : "#3b82f6";

  const btnDel = doc("btnDeleteNote");
  if (btnDel) {
    btnDel.classList.toggle("hidden", !isEdit || state.userRole !== "admin");
  }

  doc("noteModalOverlay").classList.remove("hidden");
  doc("noteContent").focus();
}

async function saveNote() {
  const content = (doc("noteContent").value || "").trim();
  if (!content) { alert("Vui lòng nhập nội dung ghi chú."); return; }

  const id            = doc("noteId").value;
  const note_date     = doc("noteDate").value;
  const note_end_date = doc("noteEndDate").value || null;
  const start_time    = doc("noteStartTime").value || null;
  const end_time      = doc("noteEndTime").value   || null;
  const color         = doc("noteColor").value || "#3b82f6";

  if (!note_date) { alert("Vui lòng chọn ngày bắt đầu."); return; }
  if (note_end_date && note_end_date < note_date) {
    alert("Ngày kết thúc phải sau ngày bắt đầu."); return;
  }

  try {
    if (id) {
      // Always send note_end_date so it can be cleared (set to "" means clear)
      const payload = { note_date, content, start_time, end_time, color };
      payload.note_end_date = note_end_date;  // can be null to clear
      await API.updateNote(Number(id), payload);
    } else {
      await API.createNote({ note_date, note_end_date, content, start_time, end_time, color });
    }
    doc("noteModalOverlay").classList.add("hidden");
    refreshView();
  } catch (e) {
    alert("Lỗi khi lưu ghi chú: " + (e.message || e));
  }
}

async function deleteNoteById() {
  if (state.userRole !== "admin") return;
  const id = doc("noteId").value;
  if (!id) return;
  const ok = await showConfirm("Bạn có chắc muốn xoá ghi chú này?");
  if (!ok) return;
  try {
    await API.deleteNote(Number(id));
    doc("noteModalOverlay").classList.add("hidden");
    refreshView();
  } catch (e) {
    alert("Lỗi khi xoá ghi chú: " + (e.message || e));
  }
}

// ─── Route Color Management ───────────────────────────────────────────────────
async function openRouteColorModal() {
  doc("routeColorModalOverlay").classList.remove("hidden");
  await renderRouteColorList();
}

async function renderRouteColorList() {
  const list = doc("routeColorList");
  let colors;
  try {
    colors = await API.getRouteColors();
  } catch {
    list.innerHTML = '<p style="color:var(--text-secondary);">Lỗi tải dữ liệu</p>';
    return;
  }

  if (colors.length === 0) {
    list.innerHTML = '<p style="color:var(--text-secondary); text-align:center; padding:24px 0;">Chưa có màu chặng nào. Thêm mới ở trên.</p>';
    return;
  }

  const isAdmin = state.userRole === "admin";
  list.innerHTML = `
    <table class="data-table" style="width:100%;">
      <thead><tr>
        <th>Chặng</th>
        <th>Màu</th>
        ${isAdmin ? "<th>Thao tác</th>" : ""}
      </tr></thead>
      <tbody>
        ${colors.map(rc => `
          <tr>
            <td><strong>${rc.origin}</strong> → <strong>${rc.destination}</strong></td>
            <td>
              <span style="display:inline-block;width:32px;height:18px;border-radius:3px;background:${rc.color};vertical-align:middle;"></span>
              <code style="margin-left:4px;font-size:12px;">${rc.color}</code>
            </td>
            ${isAdmin ? `
              <td>
                <button class="btn btn-danger btn-sm" onclick="deleteRouteColor(${rc.id})">
                  <i class="fas fa-trash"></i>
                </button>
              </td>
            ` : ""}
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

async function addRouteColor() {
  if (state.userRole !== "admin") return;
  const origin = doc("rcOrigin").value.trim().toUpperCase();
  const dest = doc("rcDest").value.trim().toUpperCase();
  const color = doc("rcColor").value;
  if (!origin || !dest) {
    alert("Vui lòng nhập sân bay đi và đến");
    return;
  }
  try {
    await API.createRouteColor({ origin, destination: dest, color });
    doc("rcOrigin").value = "";
    doc("rcDest").value = "";
    // Reload state
    const rcList = await API.getRouteColors();
    state.routeColors = {};
    for (const rc of rcList) state.routeColors[`${rc.origin}-${rc.destination}`] = rc.color;
    await renderRouteColorList();
    if (state.routeColorEnabled) refreshView();
  } catch (err) {
    alert("Lỗi: " + err.message);
  }
}

async function deleteRouteColor(id) {
  if (state.userRole !== "admin") return;
  if (!confirm("Xoá màu chặng này?")) return;
  try {
    await API.deleteRouteColor(id);
    // Reload state
    const rcList = await API.getRouteColors();
    state.routeColors = {};
    for (const rc of rcList) state.routeColors[`${rc.origin}-${rc.destination}`] = rc.color;
    await renderRouteColorList();
    if (state.routeColorEnabled) refreshView();
  } catch (err) {
    alert("Lỗi: " + err.message);
  }
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
window.openNoteModal        = openNoteModal;
window.deleteRouteColor     = deleteRouteColor;

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", init);
