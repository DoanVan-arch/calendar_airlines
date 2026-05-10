/* api.js – Thin HTTP client for the FastAPI backend */
const API = (() => {
  async function req(method, url, body) {
    const opts = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const d = await res.json(); msg = d.detail || JSON.stringify(d); } catch {}
      throw new Error(msg);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  return {
    // ── Aircraft ─────────────────────────────────────────────
    getAircraft: ()             => req("GET",    "/api/aircraft/"),
    createAircraft: (d)        => req("POST",   "/api/aircraft/", d),
    updateAircraft: (id, d)    => req("PUT",    `/api/aircraft/${id}`, d),
    deleteAircraft: (id)       => req("DELETE", `/api/aircraft/${id}`),
    reorderAircraft: (order)   => req("PUT",    "/api/aircraft/reorder/batch", order),

    // ── Sectors ──────────────────────────────────────────────
    getSectors: (date, acId)   => req("GET",  `/api/sectors/?date=${date}${acId ? "&aircraft_id=" + acId : ""}`),
    getSectorsPeriod: (s, e)   => req("GET",  `/api/sectors/period?start=${s}&end=${e}`),
    createSector: (d)          => req("POST",  "/api/sectors/", d),
    updateSector: (id, d)      => req("PUT",   `/api/sectors/${id}`, d),
    deleteSector: (id)         => req("DELETE",`/api/sectors/${id}`),
    cancelSector: (id)         => req("POST",  `/api/sectors/${id}/cancel`, {}),
    restoreSector: (id)        => req("POST",  `/api/sectors/${id}/restore`, {}),
    bulkCancelSectors: (ids)   => req("POST",  "/api/sectors/bulk-cancel", { sector_ids: ids }),
    bulkRestoreSectors: (ids)  => req("POST",  "/api/sectors/bulk-restore", { sector_ids: ids }),
    getWarnings: (date)        => req("GET",   `/api/sectors/warnings?date=${date}`),
    swapAircraft: (d)          => req("POST",  "/api/sectors/swap-aircraft", d),
    clearSectorColors: (acId)  => req("POST",  `/api/sectors/clear-colors/aircraft/${acId}`, {}),

    // ── Rules ────────────────────────────────────────────────
    getAirports: ()              => req("GET",    "/api/rules/airports"),
    createAirport: (d)           => req("POST",   "/api/rules/airports", d),
    updateAirport: (code, d)     => req("PUT",    `/api/rules/airports/${code}`, d),
    deleteAirport: (code)        => req("DELETE", `/api/rules/airports/${code}`),

    getTATRules: ()              => req("GET",    "/api/rules/tat"),
    createTATRule: (d)           => req("POST",   "/api/rules/tat", d),
    updateTATRule: (id, d)       => req("PUT",    `/api/rules/tat/${id}`, d),
    deleteTATRule: (id)          => req("DELETE", `/api/rules/tat/${id}`),
    getMassTAT: ()               => req("GET",    "/api/rules/tat/mass"),
    setMassTAT: (d)              => req("PUT",    "/api/rules/tat/mass", d),

    getBlockTimeRules: ()        => req("GET",    "/api/rules/blocktime"),
    createBlockTimeRule: (d)     => req("POST",   "/api/rules/blocktime", d),
    updateBlockTimeRule: (id, d) => req("PUT",    `/api/rules/blocktime/${id}`, d),
    deleteBlockTimeRule: (id)    => req("DELETE", `/api/rules/blocktime/${id}`),

    getRegistrations: ()         => req("GET",    "/api/rules/registration"),
    createRegistration: (d)      => req("POST",   "/api/rules/registration", d),
    updateRegistration: (id, d)  => req("PUT",    `/api/rules/registration/${id}`, d),
    deleteRegistration: (id)     => req("DELETE", `/api/rules/registration/${id}`),

    // ── Seasons ──────────────────────────────────────────────
    getSeasons: ()               => req("GET",    "/api/seasons/"),
    getSeasonDefaults: ()        => req("GET",    "/api/seasons/defaults"),
    createSeason: (d)            => req("POST",   "/api/seasons/", d),
    updateSeason: (id, d)        => req("PUT",    `/api/seasons/${id}`, d),
    deleteSeason: (id)           => req("DELETE", `/api/seasons/${id}`),

    // ── Maintenance ──────────────────────────────────────────
    getMaintenance: (p)          => req("GET",    `/api/maintenance/?${new URLSearchParams(p || {})}`),
    createMaintenance: (d)       => req("POST",   "/api/maintenance/", d),
    updateMaintenance: (id, d)   => req("PUT",    `/api/maintenance/${id}`, d),
    deleteMaintenance: (id)      => req("DELETE", `/api/maintenance/${id}`),

    // ── Audit log ────────────────────────────────────────────
    getAuditLog: (p)             => req("GET",    `/api/audit/?${new URLSearchParams(p || {})}`),

    // ── Calendar notes ───────────────────────────────────────
    getNotes: (p)                => req("GET",    `/api/notes/?${new URLSearchParams(p || {})}`),
    createNote: (d)              => req("POST",   "/api/notes/", d),
    updateNote: (id, d)          => req("PUT",    `/api/notes/${id}`, d),
    deleteNote: (id)             => req("DELETE", `/api/notes/${id}`),

    // ── Route colors ────────────────────────────────────────
    getRouteColors: ()           => req("GET",    "/api/rules/route-colors"),
    createRouteColor: (d)        => req("POST",   "/api/rules/route-colors", d),
    updateRouteColor: (id, d)    => req("PUT",    `/api/rules/route-colors/${id}`, d),
    patchRouteColor: (id, d)     => req("PATCH",  `/api/rules/route-colors/${id}`, d),
    deleteRouteColor: (id)       => req("DELETE", `/api/rules/route-colors/${id}`),

    // ── App settings ────────────────────────────────────────
    getSetting: (key)            => req("GET",    `/api/rules/settings/${key}`),
    setSetting: (key, value)     => req("PUT",    `/api/rules/settings/${key}`, { value }),

    // ── Export / Import ──────────────────────────────────────
    exportTimetable: (p)  => req("POST", "/api/export/timetable", p),
    exportReport: (p)     => req("POST", "/api/export/report", p),
    exportSchedule: ()    => req("GET",  "/api/export/schedule"),
    importSchedule: (d)   => req("POST", "/api/export/import", d),
    exportxlsxSchedule: ()    => req("GET",  "/api/export/schedulexlsx"),
    importxlsxSchedule: (d)   => req("POST", "/api/export/importxlsx", d),
    
  };
})();
