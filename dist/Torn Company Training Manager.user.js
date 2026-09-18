// ==UserScript==
// @name         Torn Company Training Manager
// @namespace    r4g3runn3r.company.training.manager
// @version      1.2.4
// @description  Fair company train rotation with activity/addiction eligibility, guarded payroll controls, diagnostics, and local audit trail.
// @author       R4G3RUNN3R
// @match        https://www.torn.com/*
// @updateURL    https://raw.githubusercontent.com/Voidsmith-Industries/Torn-Company-Training-Manager/main/dist/Torn%20Company%20Training%20Manager.user.js
// @downloadURL  https://raw.githubusercontent.com/Voidsmith-Industries/Torn-Company-Training-Manager/main/dist/Torn%20Company%20Training%20Manager.user.js
// @supportURL   https://github.com/Voidsmith-Industries/Torn-Company-Training-Manager/issues
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_info
// @connect      api.torn.com
// @run-at       document-idle
// ==/UserScript==

(() => {
  // src/core/constants.js
  var SECONDS_PER_DAY = 86400;
  var NEW_HIRE_HOLD_SECONDS = 72 * 3600;
  var SCHEMA_VERSION = 1;
  var DEFAULT_SETTINGS = Object.freeze({
    inactivityDays: 1,
    newHireHoldHours: 72,
    maxAddiction: 3,
    prioritizeNeverTrained: true,
    rotationMode: "fair",
    fairnessWindowDays: 30,
    accrueDebtWhileIneligible: false,
    removalThresholdDays: null,
    notificationMode: "important",
    showNativeTrainingBadges: true,
    compactDensity: false,
    reduceMotion: false,
    refreshMinutes: 5
  });

  // src/core/history.js
  function emptyHistoryState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      eventsByNewsId: {},
      unresolvedByNewsId: {},
      newestTimestamp: 0
    };
  }
  function toText(value) {
    return typeof value === "string" ? value : "";
  }
  function decodeTextEntities(text) {
    return text.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&#x27;/gi, "'").replace(/&nbsp;/gi, " ");
  }
  function stripTags(html) {
    const input = toText(html);
    let plain = "";
    let inTag = false;
    for (const char of input) {
      if (char === "<") {
        inTag = true;
        plain += " ";
        continue;
      }
      if (char === ">") {
        inTag = false;
        plain += " ";
        continue;
      }
      if (!inTag) plain += char;
    }
    return decodeTextEntities(plain).replace(/\s+/g, " ").trim();
  }
  function parseIdAndName(html) {
    if (typeof DOMParser !== "undefined") {
      try {
        const doc = new DOMParser().parseFromString(html, "text/html");
        for (const anchor of doc.querySelectorAll("a[href]")) {
          const match = anchor.getAttribute("href")?.match(/[?&]XID=(\d+)/i);
          if (match) return { id: Number(match[1]), name: anchor.textContent?.trim() || "" };
        }
      } catch {
      }
    }
    const anchorMatch = html.match(/<a\b[^>]*href=["'][^"']*[?&]XID=(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
    if (anchorMatch) {
      return { id: Number(anchorMatch[1]), name: stripTags(anchorMatch[2]) };
    }
    const idMatch = html.match(/[?&]XID=(\d+)/i);
    return idMatch ? { id: Number(idMatch[1]), name: "" } : null;
  }
  function normalizeNewsId(news) {
    const value = news?.id ?? news?.ID ?? news?.newsId;
    if (value === null || value === void 0 || value === "") return null;
    return String(value);
  }
  function normalizeTimestamp(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
  }
  function parseTrainingNewsItem(news = {}) {
    const newsId = normalizeNewsId(news);
    const timestamp = normalizeTimestamp(news.timestamp);
    const text = toText(news.text ?? news.news ?? news.html);
    const unresolvedBase = { newsId, timestamp, text };
    if (!/has\s+been\s+trained\s+by\s+the\s+director/i.test(stripTags(text))) {
      return { resolved: false, unresolved: { ...unresolvedBase, reason: "not_training_event" } };
    }
    const identity = parseIdAndName(text);
    if (!identity || !Number.isInteger(identity.id)) {
      return { resolved: false, unresolved: { ...unresolvedBase, reason: "missing_employee_id" } };
    }
    return {
      resolved: true,
      event: {
        newsId,
        employeeId: identity.id,
        employeeNameAtTime: identity.name,
        timestamp,
        source: "company_news"
      }
    };
  }
  function mergeTrainingNews(historyState, newsItems = []) {
    const base = historyState && typeof historyState === "object" ? historyState : emptyHistoryState();
    const next = {
      schemaVersion: SCHEMA_VERSION,
      eventsByNewsId: { ...base.eventsByNewsId || {} },
      unresolvedByNewsId: { ...base.unresolvedByNewsId || {} },
      newestTimestamp: Number(base.newestTimestamp) || 0
    };
    for (const news of Array.isArray(newsItems) ? newsItems : []) {
      const newsId = normalizeNewsId(news);
      const ts = normalizeTimestamp(news?.timestamp);
      next.newestTimestamp = Math.max(next.newestTimestamp, ts);
      if (!newsId || next.eventsByNewsId[newsId] || next.unresolvedByNewsId[newsId]) continue;
      const parsed = parseTrainingNewsItem(news);
      if (parsed.resolved) next.eventsByNewsId[newsId] = parsed.event;
      else next.unresolvedByNewsId[newsId] = parsed.unresolved;
    }
    return next;
  }
  function summarizeTrainingHistory(historyState, currentEmployees = []) {
    const byEmployee = /* @__PURE__ */ new Map();
    const currentIds = new Set((currentEmployees || []).map((employee) => Number(employee.id)).filter(Number.isFinite));
    for (const id of currentIds) {
      byEmployee.set(id, { employeeId: id, totalTrains: 0, lastTrainTimestamp: null, events: [] });
    }
    const events = Object.values(historyState?.eventsByNewsId || {}).sort((a, b) => a.timestamp - b.timestamp);
    for (const event of events) {
      if (!currentIds.has(Number(event.employeeId))) continue;
      const summary = byEmployee.get(Number(event.employeeId));
      summary.totalTrains += 1;
      summary.lastTrainTimestamp = Math.max(summary.lastTrainTimestamp ?? 0, Number(event.timestamp) || 0) || null;
      summary.events.push(event);
    }
    return byEmployee;
  }

  // src/core/audit.js
  var AUDIT_LIMIT = 500;
  var SENSITIVE_KEY_RE = /(api[_-]?key|authorization|rfcv?|cookie|session|token|secret)/i;
  var SAFE_PRESENCE_KEY_RE = /(api[_-]?key|authorization|rfcv?|cookie|session|token|secret).*present$/i;
  var sequence = 0;
  function isRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value);
  }
  function shouldRedact(key, raw) {
    if (typeof raw === "boolean" && SAFE_PRESENCE_KEY_RE.test(key)) return false;
    return SENSITIVE_KEY_RE.test(key);
  }
  function sanitizeAuditValue(value, seen = /* @__PURE__ */ new WeakSet()) {
    if (value === null || value === void 0) return value;
    if (typeof value !== "object") return value;
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => sanitizeAuditValue(item, seen));
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
      out[key] = shouldRedact(key, raw) ? "[redacted]" : sanitizeAuditValue(raw, seen);
    }
    return out;
  }
  function createAuditEntry(input = {}, nowSeconds = Math.floor(Date.now() / 1e3)) {
    const timestamp = Number.isFinite(Number(nowSeconds)) ? Math.trunc(Number(nowSeconds)) : Math.floor(Date.now() / 1e3);
    sequence = (sequence + 1) % 1e6;
    const employeeId = Number(input.employeeId);
    return {
      id: `${timestamp}-${sequence}`,
      timestamp,
      type: String(input.type || "unknown"),
      phase: String(input.phase || "unknown"),
      employeeId: Number.isInteger(employeeId) ? employeeId : null,
      employeeName: input.employeeName == null ? null : String(input.employeeName),
      details: sanitizeAuditValue(isRecord(input.details) ? input.details : {})
    };
  }
  function appendAuditEntry(state, entry, limit = AUDIT_LIMIT) {
    const entries = Array.isArray(state?.entries) ? state.entries : [];
    const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : AUDIT_LIMIT;
    return {
      schemaVersion: SCHEMA_VERSION,
      entries: [...entries, sanitizeAuditValue(entry)].slice(-safeLimit)
    };
  }
  function filterAuditEntries(entries = [], filters = {}) {
    const type = String(filters.type || "").trim().toLowerCase();
    const phase = String(filters.phase || "").trim().toLowerCase();
    const employee = String(filters.employee || "").trim().toLowerCase();
    return (Array.isArray(entries) ? entries : []).filter((entry) => {
      if (type && type !== "all" && String(entry?.type || "").toLowerCase() !== type) return false;
      if (phase && phase !== "all" && String(entry?.phase || "").toLowerCase() !== phase) return false;
      if (employee) {
        const haystack = `${entry?.employeeName || ""} ${entry?.employeeId ?? ""}`.toLowerCase();
        if (!haystack.includes(employee)) return false;
      }
      return true;
    });
  }

  // src/core/paid-contracts.js
  var TERMINAL = /* @__PURE__ */ new Set(["completed", "cancelled", "forfeited"]);
  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }
  function positiveInt(value, label) {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new TypeError(`${label} must be a positive whole number`);
    return n;
  }
  function numericEmployeeId(value) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw new TypeError("Employee ID must be a positive integer");
    return id;
  }
  function activeContract(state, employeeIdValue) {
    const employeeId = numericEmployeeId(employeeIdValue);
    const id = state.activeByEmployeeId[String(employeeId)];
    if (!id) throw new Error("No active paid agreement for employee");
    const contract = state.contractsById[id];
    if (!contract || TERMINAL.has(contract.status)) throw new Error("No active paid agreement for employee");
    return { employeeId, id, contract };
  }
  function makeContractId(state, employeeId, createdAt) {
    const base = `paid-${Number(createdAt) || 0}-${employeeId}`;
    if (!state.contractsById[base]) return base;
    let suffix = 2;
    while (state.contractsById[`${base}-${suffix}`]) suffix += 1;
    return `${base}-${suffix}`;
  }
  function emptyPaidState() {
    return { schemaVersion: 1, contractsById: {}, activeByEmployeeId: {}, queue: [] };
  }
  function normalizePaidState(value) {
    const state = emptyPaidState();
    if (!value || typeof value !== "object" || Array.isArray(value)) return state;
    const rawContracts = value.contractsById && typeof value.contractsById === "object" ? value.contractsById : {};
    for (const [id, raw] of Object.entries(rawContracts)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const employeeId = Number(raw.employeeId);
      if (!Number.isInteger(employeeId) || employeeId <= 0) continue;
      state.contractsById[id] = {
        ...clone(raw),
        id,
        employeeId,
        trainsPurchased: Math.max(0, Number(raw.trainsPurchased) || 0),
        trainsDelivered: Math.max(0, Number(raw.trainsDelivered) || 0),
        trainsRemaining: Math.max(0, Number(raw.trainsRemaining) || 0)
      };
    }
    const rawActive = value.activeByEmployeeId && typeof value.activeByEmployeeId === "object" ? value.activeByEmployeeId : {};
    for (const [employeeId, contractId] of Object.entries(rawActive)) {
      const contract = state.contractsById[contractId];
      if (!contract || TERMINAL.has(contract.status)) continue;
      state.activeByEmployeeId[String(Number(employeeId))] = contractId;
    }
    const seen = /* @__PURE__ */ new Set();
    for (const id of Array.isArray(value.queue) ? value.queue : []) {
      if (!state.contractsById[id] || TERMINAL.has(state.contractsById[id].status) || seen.has(id)) continue;
      state.queue.push(id);
      seen.add(id);
    }
    for (const id of Object.values(state.activeByEmployeeId)) {
      if (!seen.has(id)) state.queue.push(id);
    }
    return state;
  }
  function createPaidContract(value, input = {}) {
    const state = normalizePaidState(value);
    const employeeId = numericEmployeeId(input.employeeId);
    if (state.activeByEmployeeId[String(employeeId)]) throw new Error("Employee already has an active paid agreement");
    const trainsPurchased = positiveInt(input.trainsPurchased, "Trains purchased");
    const createdAt = Number(input.createdAt) || Math.floor(Date.now() / 1e3);
    const id = makeContractId(state, employeeId, createdAt);
    state.contractsById[id] = {
      id,
      employeeId,
      employeeName: typeof input.employeeName === "string" ? input.employeeName : "",
      trainsPurchased,
      trainsDelivered: 0,
      trainsRemaining: trainsPurchased,
      createdAt,
      startedAt: Number(input.startedAt) || createdAt,
      pricePerTrain: Number.isFinite(Number(input.pricePerTrain)) ? Number(input.pricePerTrain) : null,
      totalPaid: Number.isFinite(Number(input.totalPaid)) ? Number(input.totalPaid) : null,
      note: typeof input.note === "string" ? input.note : "",
      status: "active",
      pauseReason: null,
      pausedAt: null,
      closedAt: null,
      closedReason: null
    };
    state.activeByEmployeeId[String(employeeId)] = id;
    state.queue.push(id);
    return state;
  }
  function amendPaidContract(value, employeeIdValue, patch = {}, timestamp = Math.floor(Date.now() / 1e3)) {
    const state = normalizePaidState(value);
    const { contract } = activeContract(state, employeeIdValue);
    const addTrains = patch.addTrains == null ? 0 : positiveInt(patch.addTrains, "Additional trains");
    contract.trainsPurchased += addTrains;
    contract.trainsRemaining += addTrains;
    if (Object.hasOwn(patch, "pricePerTrain")) contract.pricePerTrain = Number.isFinite(Number(patch.pricePerTrain)) ? Number(patch.pricePerTrain) : null;
    if (Object.hasOwn(patch, "totalPaid")) contract.totalPaid = Number.isFinite(Number(patch.totalPaid)) ? Number(patch.totalPaid) : null;
    if (Object.hasOwn(patch, "note")) contract.note = typeof patch.note === "string" ? patch.note : "";
    contract.updatedAt = Number(timestamp) || contract.updatedAt || contract.createdAt;
    return state;
  }
  function eligibilityFrom(mapLike, employeeId) {
    if (mapLike instanceof Map) return mapLike.get(employeeId);
    return mapLike?.[employeeId] ?? mapLike?.[String(employeeId)];
  }
  function syncPaidEligibility(value, eligibilityById, timestamp = Math.floor(Date.now() / 1e3)) {
    const state = normalizePaidState(value);
    for (const id of state.queue) {
      const contract = state.contractsById[id];
      if (!contract || TERMINAL.has(contract.status) || contract.status === "manually-paused") continue;
      const eligible = eligibilityFrom(eligibilityById, contract.employeeId)?.eligible === true;
      if (!eligible && contract.status === "active") {
        contract.status = "auto-paused";
        contract.pauseReason = "ineligible";
        contract.pausedAt = Number(timestamp) || null;
      } else if (eligible && contract.status === "auto-paused") {
        contract.status = "active";
        contract.pauseReason = null;
        contract.pausedAt = null;
      }
    }
    return state;
  }
  function pausePaidContract(value, employeeIdValue, { timestamp = Math.floor(Date.now() / 1e3), reason = "director" } = {}) {
    const state = normalizePaidState(value);
    const { contract } = activeContract(state, employeeIdValue);
    contract.status = "manually-paused";
    contract.pauseReason = reason == null ? "director" : String(reason);
    contract.pausedAt = Number(timestamp) || null;
    return state;
  }
  function resumePaidContract(value, employeeIdValue, { timestamp = Math.floor(Date.now() / 1e3) } = {}) {
    const state = normalizePaidState(value);
    const { contract } = activeContract(state, employeeIdValue);
    if (contract.status !== "manually-paused") throw new Error("Paid agreement is not manually paused");
    contract.status = "active";
    contract.pauseReason = null;
    contract.pausedAt = null;
    contract.updatedAt = Number(timestamp) || null;
    return state;
  }
  function recordVerifiedPaidTrain(value, employeeIdValue, { timestamp = Math.floor(Date.now() / 1e3), countsTowardPaid = true } = {}) {
    const state = normalizePaidState(value);
    if (!countsTowardPaid) return state;
    const employeeId = numericEmployeeId(employeeIdValue);
    const id = state.activeByEmployeeId[String(employeeId)];
    if (!id) return state;
    const contract = state.contractsById[id];
    if (!contract || TERMINAL.has(contract.status)) return state;
    contract.trainsDelivered = Math.min(contract.trainsPurchased, contract.trainsDelivered + 1);
    contract.trainsRemaining = Math.max(0, contract.trainsRemaining - 1);
    contract.lastDeliveredAt = Number(timestamp) || null;
    if (contract.trainsRemaining === 0) {
      contract.status = "completed";
      contract.closedAt = Number(timestamp) || null;
      contract.closedReason = "fulfilled";
      delete state.activeByEmployeeId[String(employeeId)];
      state.queue = state.queue.filter((contractId) => contractId !== id);
    }
    return state;
  }
  function reorderPaidQueue(value, orderedIds = []) {
    const state = normalizePaidState(value);
    const current = [...state.queue];
    if (!Array.isArray(orderedIds) || orderedIds.length !== current.length) throw new TypeError("Paid queue reorder must include every active agreement exactly once");
    const expected = [...current].sort();
    const actual = [...new Set(orderedIds)].sort();
    if (actual.length !== current.length || expected.some((id, index) => id !== actual[index])) throw new TypeError("Paid queue reorder contains invalid agreement IDs");
    state.queue = [...orderedIds];
    return state;
  }
  function closePaidContract(value, employeeIdValue, { outcome, timestamp = Math.floor(Date.now() / 1e3), reason = null } = {}) {
    if (!["cancelled", "forfeited"].includes(outcome)) throw new TypeError("Paid agreement close outcome must be cancelled or forfeited");
    const state = normalizePaidState(value);
    const { employeeId, id, contract } = activeContract(state, employeeIdValue);
    contract.status = outcome;
    contract.closedAt = Number(timestamp) || null;
    contract.closedReason = reason == null ? null : String(reason);
    delete state.activeByEmployeeId[String(employeeId)];
    state.queue = state.queue.filter((contractId) => contractId !== id);
    return state;
  }

  // src/core/fairness.js
  function uniqueNumericIds(values = []) {
    return [...new Set((Array.isArray(values) ? values : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  }
  function emptyFairnessState(trackingStartedAt = Math.floor(Date.now() / 1e3)) {
    return { schemaVersion: 1, trackingStartedAt: Number(trackingStartedAt) || 0, opportunities: [] };
  }
  function normalizeFairnessState(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return emptyFairnessState();
    const trackingStartedAt = Number.isFinite(Number(value.trackingStartedAt)) ? Number(value.trackingStartedAt) : 0;
    const opportunities = [];
    for (const raw of Array.isArray(value.opportunities) ? value.opportunities : []) {
      const timestamp = Number(raw?.timestamp);
      const trainedEmployeeId = Number(raw?.trainedEmployeeId);
      if (!Number.isFinite(timestamp) || !Number.isInteger(trainedEmployeeId) || trainedEmployeeId <= 0) continue;
      opportunities.push({
        timestamp,
        trainedEmployeeId,
        eligibleEmployeeIds: uniqueNumericIds(raw.eligibleEmployeeIds),
        allEmployeeIds: uniqueNumericIds(raw.allEmployeeIds)
      });
    }
    opportunities.sort((a, b) => a.timestamp - b.timestamp);
    return { schemaVersion: 1, trackingStartedAt, opportunities };
  }
  function recordFairnessTrain(value, event = {}) {
    const state = normalizeFairnessState(value);
    const timestamp = Number(event.timestamp);
    const trainedEmployeeId = Number(event.trainedEmployeeId);
    if (!Number.isFinite(timestamp)) throw new TypeError("Fairness event timestamp is required");
    if (!Number.isInteger(trainedEmployeeId) || trainedEmployeeId <= 0) throw new TypeError("Trained employee ID is required");
    state.opportunities.push({
      timestamp,
      trainedEmployeeId,
      eligibleEmployeeIds: uniqueNumericIds(event.eligibleEmployeeIds),
      allEmployeeIds: uniqueNumericIds(event.allEmployeeIds)
    });
    state.opportunities.sort((a, b) => a.timestamp - b.timestamp);
    if (!state.trackingStartedAt || timestamp < state.trackingStartedAt) state.trackingStartedAt = timestamp;
    return state;
  }
  function fairnessScores(value, {
    nowSeconds = Math.floor(Date.now() / 1e3),
    windowDays = 30,
    accrueDebtWhileIneligible = false
  } = {}) {
    const state = normalizeFairnessState(value);
    const days = Number(windowDays);
    if (!Number.isFinite(days) || days <= 0) throw new TypeError("Fairness window must be greater than zero");
    const cutoff = Number(nowSeconds) - days * SECONDS_PER_DAY;
    const expected = /* @__PURE__ */ new Map();
    const actual = /* @__PURE__ */ new Map();
    for (const event of state.opportunities) {
      if (event.timestamp < cutoff || event.timestamp > Number(nowSeconds)) continue;
      const participants = accrueDebtWhileIneligible && event.allEmployeeIds.length ? event.allEmployeeIds : event.eligibleEmployeeIds;
      const uniqueParticipants = uniqueNumericIds(participants);
      if (uniqueParticipants.length) {
        const share = 1 / uniqueParticipants.length;
        for (const id of uniqueParticipants) expected.set(id, (expected.get(id) || 0) + share);
      }
      actual.set(event.trainedEmployeeId, (actual.get(event.trainedEmployeeId) || 0) + 1);
    }
    const ids = /* @__PURE__ */ new Set([...expected.keys(), ...actual.keys()]);
    const scores = /* @__PURE__ */ new Map();
    for (const id of ids) {
      const score = (expected.get(id) || 0) - (actual.get(id) || 0);
      scores.set(id, Math.abs(score) < 1e-12 ? 0 : score);
    }
    return scores;
  }

  // src/core/overrides.js
  function clone2(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }
  function emptyOverrideState() {
    return { schemaVersion: 1, priorityOnceEmployeeId: null, prioritySetAt: null, skipsByEmployeeId: {} };
  }
  function normalizeOverrideState(value) {
    const state = emptyOverrideState();
    if (!value || typeof value !== "object" || Array.isArray(value)) return state;
    const priorityId = Number(value.priorityOnceEmployeeId);
    if (Number.isInteger(priorityId) && priorityId > 0) {
      state.priorityOnceEmployeeId = priorityId;
      state.prioritySetAt = Number.isFinite(Number(value.prioritySetAt)) ? Number(value.prioritySetAt) : null;
    }
    const rawSkips = value.skipsByEmployeeId && typeof value.skipsByEmployeeId === "object" ? value.skipsByEmployeeId : {};
    for (const [key, raw] of Object.entries(rawSkips)) {
      const id = Number(raw?.employeeId ?? key);
      if (!Number.isInteger(id) || id <= 0 || !raw || typeof raw !== "object") continue;
      state.skipsByEmployeeId[String(id)] = { ...clone2(raw), employeeId: id };
    }
    return state;
  }
  function setPriorityOnce(value, employeeIdValue, timestamp = Math.floor(Date.now() / 1e3)) {
    const state = normalizeOverrideState(value);
    const employeeId = Number(employeeIdValue);
    if (!Number.isInteger(employeeId) || employeeId <= 0) throw new TypeError("Employee ID must be a positive integer");
    state.priorityOnceEmployeeId = employeeId;
    state.prioritySetAt = Number(timestamp) || null;
    return state;
  }
  function clearPriorityOnce(value) {
    const state = normalizeOverrideState(value);
    state.priorityOnceEmployeeId = null;
    state.prioritySetAt = null;
    return state;
  }
  function createSkip(value, employeeIdValue, options = {}) {
    const state = normalizeOverrideState(value);
    const employeeId = Number(employeeIdValue);
    if (!Number.isInteger(employeeId) || employeeId <= 0) throw new TypeError("Employee ID must be a positive integer");
    const mode = options.mode;
    if (!["next_rotation", "until_tomorrow", "timed", "manual"].includes(mode)) throw new TypeError("Unsupported skip mode");
    const until = options.until == null ? null : Number(options.until);
    if (["timed", "until_tomorrow"].includes(mode) && !Number.isFinite(until)) throw new TypeError("Timed skip requires an expiry timestamp");
    const baseline = options.verifiedTrainCountAtCreate == null ? null : Number(options.verifiedTrainCountAtCreate);
    state.skipsByEmployeeId[String(employeeId)] = {
      employeeId,
      mode,
      createdAt: Number(options.createdAt) || Math.floor(Date.now() / 1e3),
      until,
      verifiedTrainCountAtCreate: Number.isFinite(baseline) ? baseline : null
    };
    return state;
  }
  function clearSkip(value, employeeIdValue) {
    const state = normalizeOverrideState(value);
    delete state.skipsByEmployeeId[String(Number(employeeIdValue))];
    return state;
  }
  function skipExpired(skip, { nowSeconds = Math.floor(Date.now() / 1e3), verifiedTrainCount = null } = {}) {
    if (!skip) return true;
    if (skip.mode === "manual") return false;
    if (skip.mode === "timed" || skip.mode === "until_tomorrow") return Number(nowSeconds) >= Number(skip.until);
    if (skip.mode === "next_rotation") {
      if (!Number.isFinite(Number(skip.verifiedTrainCountAtCreate)) || !Number.isFinite(Number(verifiedTrainCount))) return false;
      return Number(verifiedTrainCount) > Number(skip.verifiedTrainCountAtCreate);
    }
    return true;
  }
  function isSkipped(value, employeeIdValue, context = {}) {
    const state = normalizeOverrideState(value);
    const skip = state.skipsByEmployeeId[String(Number(employeeIdValue))];
    return Boolean(skip) && !skipExpired(skip, context);
  }
  function expireOverrides(value, context = {}) {
    const state = normalizeOverrideState(value);
    for (const [key, skip] of Object.entries(state.skipsByEmployeeId)) {
      if (skipExpired(skip, context)) delete state.skipsByEmployeeId[key];
    }
    return state;
  }

  // src/infra/storage.js
  var STORAGE_KEYS = Object.freeze({
    apiKey: "r4_tcm_api_key",
    settings: "r4_tcm_settings",
    history: "r4_tcm_history",
    payroll: "r4_tcm_payroll",
    cache: "r4_tcm_cache",
    ui: "r4_tcm_ui",
    managerUi: "r4_tcm_manager_ui",
    audit: "r4_tcm_audit",
    trainReceipts: "r4_tcm_train_receipts",
    paidContracts: "r4_tcm_paid_contracts",
    fairness: "r4_tcm_fairness",
    overrides: "r4_tcm_overrides",
    backup: "r4_tcm_last_backup"
  });
  var DEFAULT_PAYROLL = Object.freeze({ schemaVersion: SCHEMA_VERSION, recordsByEmployeeId: {} });
  var DEFAULT_CACHE = Object.freeze({ schemaVersion: SCHEMA_VERSION, employees: [], trains: null, profile: null, lastUpdatedAt: null });
  var DEFAULT_UI = Object.freeze({ schemaVersion: SCHEMA_VERSION, x: null, y: null, collapsed: false });
  var DEFAULT_MANAGER_UI = Object.freeze({ schemaVersion: SCHEMA_VERSION, x: null, y: null, width: null, height: null, minimized: false, maximized: false, locked: true });
  var DEFAULT_AUDIT = Object.freeze({ schemaVersion: SCHEMA_VERSION, entries: [] });
  var DEFAULT_TRAIN_RECEIPTS = Object.freeze({ schemaVersion: SCHEMA_VERSION, receiptsByEmployeeId: {} });
  var SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);
  function clone3(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }
  function isRecord2(value) {
    return value && typeof value === "object" && !Array.isArray(value);
  }
  function finiteNumberOrNull(value) {
    if (value === null || value === void 0 || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  function defaultSettings() {
    return { schemaVersion: SCHEMA_VERSION, ...DEFAULT_SETTINGS };
  }
  var StorageRepo = class {
    constructor(gm) {
      if (!gm?.getValue || !gm?.setValue || !gm?.deleteValue) throw new TypeError("GM storage adapter is required");
      this.gm = gm;
    }
    async #get(key, fallback) {
      try {
        return await this.gm.getValue(key, clone3(fallback));
      } catch {
        return clone3(fallback);
      }
    }
    async loadSettings() {
      const raw = await this.#get(STORAGE_KEYS.settings, defaultSettings());
      if (!isRecord2(raw) || raw.schemaVersion !== SCHEMA_VERSION) return defaultSettings();
      const out = defaultSettings();
      for (const key of SETTING_KEYS) {
        if (Object.prototype.hasOwnProperty.call(raw, key)) out[key] = raw[key];
      }
      return out;
    }
    async saveSettings(settings = {}) {
      const current = await this.loadSettings();
      const out = { ...current, schemaVersion: SCHEMA_VERSION };
      for (const key of SETTING_KEYS) {
        if (Object.prototype.hasOwnProperty.call(settings, key)) out[key] = settings[key];
      }
      await this.gm.setValue(STORAGE_KEYS.settings, clone3(out));
      return out;
    }
    async loadHistory() {
      const fallback = emptyHistoryState();
      const raw = await this.#get(STORAGE_KEYS.history, fallback);
      if (!isRecord2(raw) || raw.schemaVersion !== SCHEMA_VERSION || !isRecord2(raw.eventsByNewsId) || !isRecord2(raw.unresolvedByNewsId)) return fallback;
      return {
        schemaVersion: SCHEMA_VERSION,
        eventsByNewsId: clone3(raw.eventsByNewsId),
        unresolvedByNewsId: clone3(raw.unresolvedByNewsId),
        newestTimestamp: Number.isFinite(Number(raw.newestTimestamp)) ? Number(raw.newestTimestamp) : 0
      };
    }
    async saveHistory(state = {}) {
      const out = {
        schemaVersion: SCHEMA_VERSION,
        eventsByNewsId: isRecord2(state.eventsByNewsId) ? clone3(state.eventsByNewsId) : {},
        unresolvedByNewsId: isRecord2(state.unresolvedByNewsId) ? clone3(state.unresolvedByNewsId) : {},
        newestTimestamp: Number.isFinite(Number(state.newestTimestamp)) ? Number(state.newestTimestamp) : 0
      };
      await this.gm.setValue(STORAGE_KEYS.history, out);
      return out;
    }
    async loadPayroll() {
      const raw = await this.#get(STORAGE_KEYS.payroll, DEFAULT_PAYROLL);
      if (!isRecord2(raw) || raw.schemaVersion !== SCHEMA_VERSION || !isRecord2(raw.recordsByEmployeeId)) return clone3(DEFAULT_PAYROLL);
      return { schemaVersion: SCHEMA_VERSION, recordsByEmployeeId: clone3(raw.recordsByEmployeeId) };
    }
    async savePayroll(state = {}) {
      const out = { schemaVersion: SCHEMA_VERSION, recordsByEmployeeId: isRecord2(state.recordsByEmployeeId) ? clone3(state.recordsByEmployeeId) : {} };
      await this.gm.setValue(STORAGE_KEYS.payroll, out);
      return out;
    }
    async loadCache() {
      const raw = await this.#get(STORAGE_KEYS.cache, DEFAULT_CACHE);
      if (!isRecord2(raw) || raw.schemaVersion !== SCHEMA_VERSION || !Array.isArray(raw.employees)) return clone3(DEFAULT_CACHE);
      return {
        schemaVersion: SCHEMA_VERSION,
        employees: clone3(raw.employees),
        trains: raw.trains ?? null,
        profile: isRecord2(raw.profile) ? clone3(raw.profile) : null,
        lastUpdatedAt: Number.isFinite(Number(raw.lastUpdatedAt)) ? Number(raw.lastUpdatedAt) : null
      };
    }
    async saveCache(state = {}) {
      const out = {
        schemaVersion: SCHEMA_VERSION,
        employees: Array.isArray(state.employees) ? clone3(state.employees) : [],
        trains: state.trains ?? null,
        profile: isRecord2(state.profile) ? clone3(state.profile) : null,
        lastUpdatedAt: Number.isFinite(Number(state.lastUpdatedAt)) ? Number(state.lastUpdatedAt) : null
      };
      await this.gm.setValue(STORAGE_KEYS.cache, out);
      return out;
    }
    async loadUi() {
      const raw = await this.#get(STORAGE_KEYS.ui, DEFAULT_UI);
      if (!isRecord2(raw) || raw.schemaVersion !== SCHEMA_VERSION) return clone3(DEFAULT_UI);
      return {
        schemaVersion: SCHEMA_VERSION,
        x: Number.isFinite(Number(raw.x)) ? Number(raw.x) : null,
        y: Number.isFinite(Number(raw.y)) ? Number(raw.y) : null,
        collapsed: Boolean(raw.collapsed)
      };
    }
    async saveUi(state = {}) {
      const out = {
        schemaVersion: SCHEMA_VERSION,
        x: Number.isFinite(Number(state.x)) ? Number(state.x) : null,
        y: Number.isFinite(Number(state.y)) ? Number(state.y) : null,
        collapsed: Boolean(state.collapsed)
      };
      await this.gm.setValue(STORAGE_KEYS.ui, out);
      return out;
    }
    async loadManagerUi() {
      const raw = await this.#get(STORAGE_KEYS.managerUi, DEFAULT_MANAGER_UI);
      if (!isRecord2(raw) || raw.schemaVersion !== SCHEMA_VERSION) return clone3(DEFAULT_MANAGER_UI);
      return {
        schemaVersion: SCHEMA_VERSION,
        x: finiteNumberOrNull(raw.x),
        y: finiteNumberOrNull(raw.y),
        width: finiteNumberOrNull(raw.width),
        height: finiteNumberOrNull(raw.height),
        minimized: Boolean(raw.minimized),
        maximized: Boolean(raw.maximized),
        locked: raw.locked !== false
      };
    }
    async saveManagerUi(state = {}) {
      const out = {
        schemaVersion: SCHEMA_VERSION,
        x: finiteNumberOrNull(state.x),
        y: finiteNumberOrNull(state.y),
        width: finiteNumberOrNull(state.width),
        height: finiteNumberOrNull(state.height),
        minimized: Boolean(state.minimized),
        maximized: Boolean(state.maximized),
        locked: state.locked !== false
      };
      if (out.maximized) out.minimized = false;
      await this.gm.setValue(STORAGE_KEYS.managerUi, out);
      return out;
    }
    async loadAudit() {
      const raw = await this.#get(STORAGE_KEYS.audit, DEFAULT_AUDIT);
      if (!isRecord2(raw) || raw.schemaVersion !== SCHEMA_VERSION || !Array.isArray(raw.entries)) return clone3(DEFAULT_AUDIT);
      return { schemaVersion: SCHEMA_VERSION, entries: clone3(raw.entries) };
    }
    async saveAudit(state = {}) {
      const out = { schemaVersion: SCHEMA_VERSION, entries: Array.isArray(state.entries) ? clone3(state.entries).slice(-500) : [] };
      await this.gm.setValue(STORAGE_KEYS.audit, out);
      return out;
    }
    async appendAudit(entry) {
      const current = await this.loadAudit();
      const next = appendAuditEntry(current, entry, 500);
      await this.gm.setValue(STORAGE_KEYS.audit, clone3(next));
      return next;
    }
    async clearAudit() {
      await this.gm.setValue(STORAGE_KEYS.audit, clone3(DEFAULT_AUDIT));
      return clone3(DEFAULT_AUDIT);
    }
    async loadTrainReceipts() {
      const raw = await this.#get(STORAGE_KEYS.trainReceipts, DEFAULT_TRAIN_RECEIPTS);
      if (!isRecord2(raw) || raw.schemaVersion !== SCHEMA_VERSION || !isRecord2(raw.receiptsByEmployeeId)) return clone3(DEFAULT_TRAIN_RECEIPTS);
      return { schemaVersion: SCHEMA_VERSION, receiptsByEmployeeId: clone3(raw.receiptsByEmployeeId) };
    }
    async saveTrainReceipts(state = {}) {
      const out = { schemaVersion: SCHEMA_VERSION, receiptsByEmployeeId: isRecord2(state.receiptsByEmployeeId) ? clone3(state.receiptsByEmployeeId) : {} };
      await this.gm.setValue(STORAGE_KEYS.trainReceipts, out);
      return out;
    }
    async loadPaidContracts() {
      const raw = await this.#get(STORAGE_KEYS.paidContracts, emptyPaidState());
      if (!isRecord2(raw) || raw.schemaVersion !== SCHEMA_VERSION) return emptyPaidState();
      return normalizePaidState(raw);
    }
    async savePaidContracts(state = {}) {
      const out = normalizePaidState({ schemaVersion: SCHEMA_VERSION, ...state });
      await this.gm.setValue(STORAGE_KEYS.paidContracts, clone3(out));
      return out;
    }
    async loadFairness() {
      const raw = await this.#get(STORAGE_KEYS.fairness, emptyFairnessState(0));
      if (!isRecord2(raw) || raw.schemaVersion !== SCHEMA_VERSION) return emptyFairnessState(0);
      return normalizeFairnessState(raw);
    }
    async saveFairness(state = {}) {
      const out = normalizeFairnessState({ schemaVersion: SCHEMA_VERSION, ...state });
      await this.gm.setValue(STORAGE_KEYS.fairness, clone3(out));
      return out;
    }
    async loadOverrides() {
      const raw = await this.#get(STORAGE_KEYS.overrides, emptyOverrideState());
      if (!isRecord2(raw) || raw.schemaVersion !== SCHEMA_VERSION) return emptyOverrideState();
      return normalizeOverrideState(raw);
    }
    async saveOverrides(state = {}) {
      const out = normalizeOverrideState({ schemaVersion: SCHEMA_VERSION, ...state });
      await this.gm.setValue(STORAGE_KEYS.overrides, clone3(out));
      return out;
    }
    async loadBackup() {
      const raw = await this.#get(STORAGE_KEYS.backup, null);
      return isRecord2(raw) ? clone3(raw) : null;
    }
    async saveBackup(value) {
      const out = isRecord2(value) ? clone3(value) : null;
      await this.gm.setValue(STORAGE_KEYS.backup, out);
      return out;
    }
    async getApiKey() {
      const value = await this.#get(STORAGE_KEYS.apiKey, "");
      return typeof value === "string" ? value : "";
    }
    async setApiKey(key) {
      const value = String(key ?? "").trim();
      await this.gm.setValue(STORAGE_KEYS.apiKey, value);
    }
    async clearApiKey() {
      await this.gm.deleteValue(STORAGE_KEYS.apiKey);
    }
    async resetNonKeyData() {
      await Promise.all([
        this.gm.deleteValue(STORAGE_KEYS.settings),
        this.gm.deleteValue(STORAGE_KEYS.history),
        this.gm.deleteValue(STORAGE_KEYS.payroll),
        this.gm.deleteValue(STORAGE_KEYS.cache),
        this.gm.deleteValue(STORAGE_KEYS.ui),
        this.gm.deleteValue(STORAGE_KEYS.managerUi),
        this.gm.deleteValue(STORAGE_KEYS.audit),
        this.gm.deleteValue(STORAGE_KEYS.trainReceipts),
        this.gm.deleteValue(STORAGE_KEYS.paidContracts),
        this.gm.deleteValue(STORAGE_KEYS.fairness),
        this.gm.deleteValue(STORAGE_KEYS.overrides),
        this.gm.deleteValue(STORAGE_KEYS.backup)
      ]);
    }
  };

  // src/core/normalize.js
  function finiteNumber(value) {
    if (value === null || value === void 0 || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  function parseUnixSeconds(value) {
    const n = finiteNumber(value);
    if (n === null || n < 0) return null;
    return Math.trunc(n);
  }
  function normalizeAddiction(rawValue) {
    const n = finiteNumber(rawValue);
    return n === null ? null : Math.abs(n);
  }
  function normalizeEmployee(raw = {}, nowSeconds = Math.floor(Date.now() / 1e3)) {
    const id = finiteNumber(raw.id ?? raw.ID ?? raw.user_id);
    const wage = finiteNumber(raw.wage);
    const joinedAt = parseUnixSeconds(raw.joined_at);
    const lastActionTimestamp = parseUnixSeconds(raw.last_action?.timestamp);
    const rawAddictionEffectiveness = finiteNumber(raw.effectiveness?.addiction);
    const rawInactivityEffectiveness = finiteNumber(raw.effectiveness?.inactivity);
    const effectivenessTotal = finiteNumber(raw.effectiveness?.total);
    const daysInCompany = finiteNumber(raw.days_in_company);
    const position = raw.position ?? null;
    const positionName = typeof position === "string" ? position : position?.name ?? null;
    const positionId = typeof position === "object" && position ? finiteNumber(position.id) : null;
    const normalizedNow = parseUnixSeconds(nowSeconds);
    const inactivitySeconds = lastActionTimestamp === null || normalizedNow === null ? null : Math.max(0, normalizedNow - lastActionTimestamp);
    return {
      id: id === null ? null : Math.trunc(id),
      name: typeof raw.name === "string" ? raw.name : "",
      positionId: positionId === null ? null : Math.trunc(positionId),
      positionName,
      daysInCompany: daysInCompany === null ? null : daysInCompany,
      joinedAt,
      wage: wage === null ? null : Math.trunc(wage),
      lastActionTimestamp,
      lastActionRelative: typeof raw.last_action?.relative === "string" ? raw.last_action.relative : null,
      lastActionStatus: typeof raw.last_action?.status === "string" ? raw.last_action.status : null,
      rawAddictionEffectiveness,
      addictionMagnitude: normalizeAddiction(rawAddictionEffectiveness),
      rawInactivityEffectiveness,
      effectivenessTotal,
      stats: raw.stats && typeof raw.stats === "object" ? { ...raw.stats } : null,
      inactivitySeconds
    };
  }

  // src/infra/torn-api.js
  var API_ORIGIN = "https://api.torn.com";
  var API_BASE = `${API_ORIGIN}/v2/company`;
  var COMMENT = "R4G3RUNN3R Training Manager";
  var COMMENT_Q = encodeURIComponent(COMMENT);
  function asEmployeeArray(response) {
    const raw = response?.employees ?? response?.company?.employees ?? [];
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === "object") return Object.entries(raw).map(([id, value]) => ({ id: Number(value?.id ?? id), ...value }));
    return [];
  }
  function asProfile(response) {
    return response?.profile ?? response?.company ?? response ?? {};
  }
  function asNewsArray(response) {
    const raw = response?.news ?? response?.companynews ?? response?.company_news ?? [];
    return Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : [];
  }
  function metadataNext(response) {
    return response?._metadata?.links?.next ?? response?.metadata?.links?.next ?? null;
  }
  function safeApiUrl(value) {
    try {
      const url = new URL(value, API_ORIGIN);
      return url.protocol === "https:" && url.hostname === "api.torn.com";
    } catch {
      return false;
    }
  }
  function sanitizeMessage(message, key) {
    let text = typeof message === "string" ? message : "Torn API error";
    if (key) text = text.split(key).join("[redacted]");
    return text;
  }
  function withCacheBust(value, cacheBust) {
    if (cacheBust === null || cacheBust === void 0 || cacheBust === "") return value;
    const numeric = Number(cacheBust);
    if (!Number.isFinite(numeric)) return value;
    const url = new URL(value, API_ORIGIN);
    url.searchParams.set("timestamp", String(Math.trunc(numeric)));
    return url.href;
  }
  var TornApiError = class extends Error {
    constructor(message, { code = null, status = null } = {}) {
      super(message);
      this.name = "TornApiError";
      this.code = code;
      this.status = status;
    }
  };
  function validateDirectorCapabilities({ employeesResponse, profileResponse }) {
    const missing = [];
    const employees = asEmployeeArray(employeesResponse);
    const profile = asProfile(profileResponse);
    if (!("trains" in profile) || !Number.isFinite(Number(profile.trains))) missing.push("profile.trains");
    if (employees.length > 0) {
      const sample = employees[0];
      if (!("wage" in sample) || !Number.isFinite(Number(sample.wage))) missing.push("employees.wage");
      if (!("joined_at" in sample) || !Number.isFinite(Number(sample.joined_at))) missing.push("employees.joined_at");
      if (!sample.effectiveness || !Number.isFinite(Number(sample.effectiveness.addiction))) missing.push("employees.effectiveness.addiction");
      if (!sample.last_action || !Number.isFinite(Number(sample.last_action.timestamp))) missing.push("employees.last_action.timestamp");
    }
    return { ok: missing.length === 0, missing };
  }
  function createGmTransport(gmXmlhttpRequest) {
    if (typeof gmXmlhttpRequest !== "function") throw new TypeError("GM_xmlhttpRequest is required");
    return {
      requestJson({ method = "GET", url, headers = {} }) {
        return new Promise((resolve, reject) => {
          gmXmlhttpRequest({
            method,
            url,
            headers,
            timeout: 3e4,
            onload(response) {
              if (response.status < 200 || response.status >= 300) {
                reject(new TornApiError(`Torn API HTTP ${response.status}`, { status: response.status }));
                return;
              }
              try {
                resolve(JSON.parse(response.responseText));
              } catch {
                reject(new TornApiError("Torn API returned invalid JSON", { status: response.status }));
              }
            },
            onerror() {
              reject(new TornApiError("Torn API network error"));
            },
            ontimeout() {
              reject(new TornApiError("Torn API request timed out"));
            },
            onabort() {
              reject(new TornApiError("Torn API request aborted"));
            }
          });
        });
      }
    };
  }
  var TornApiClient = class {
    constructor({ transport, apiKey, nowSeconds = () => Math.floor(Date.now() / 1e3) }) {
      if (!transport?.requestJson) throw new TypeError("Transport is required");
      this.transport = transport;
      this.apiKey = String(apiKey ?? "").trim();
      this.nowSeconds = nowSeconds;
    }
    #headers() {
      return this.apiKey ? { Authorization: `ApiKey ${this.apiKey}` } : {};
    }
    async #request(url) {
      const payload = await this.transport.requestJson({ method: "GET", url, headers: this.#headers() });
      if (payload?.error) {
        const code = payload.error.code ?? null;
        const message = sanitizeMessage(payload.error.error ?? payload.error.message ?? "Torn API error", this.apiKey);
        throw new TornApiError(message, { code });
      }
      return payload;
    }
    async getEmployees({ raw = false, cacheBust = null } = {}) {
      const requestUrl = withCacheBust(`${API_BASE}/employees?comment=${COMMENT_Q}`, cacheBust);
      const response = await this.#request(requestUrl);
      if (raw) return response;
      return asEmployeeArray(response).map((item) => normalizeEmployee(item, this.nowSeconds()));
    }
    async getProfile({ raw = false } = {}) {
      const response = await this.#request(`${API_BASE}/profile?comment=${COMMENT_Q}`);
      return raw ? response : asProfile(response);
    }
    async validateCapabilities() {
      const [employeesResponse, profileResponse] = await Promise.all([this.getEmployees({ raw: true }), this.getProfile({ raw: true })]);
      return validateDirectorCapabilities({ employeesResponse, profileResponse });
    }
    async getTrainingNewsPage({ from = null, url = null, cacheBust = null } = {}) {
      let requestUrl = url;
      if (!requestUrl) {
        const params = new URLSearchParams({ cat: "training", limit: "100", sort: "DESC", comment: COMMENT });
        if (from !== null && from !== void 0 && Number.isFinite(Number(from))) params.set("from", String(Math.trunc(Number(from))));
        requestUrl = `${API_BASE}/news?${params.toString()}`;
      }
      requestUrl = withCacheBust(requestUrl, cacheBust);
      if (!safeApiUrl(requestUrl)) throw new TornApiError("Unsafe Torn API pagination URL");
      const response = await this.#request(requestUrl);
      return { news: asNewsArray(response), next: metadataNext(response), raw: response };
    }
    async #collectNews({ from = null, onProgress = null, cacheBust = null } = {}) {
      const news = [];
      const seenUrls = /* @__PURE__ */ new Set();
      let page = 0;
      let nextUrl = null;
      while (page < 100) {
        let pageResult;
        if (page === 0) {
          pageResult = await this.getTrainingNewsPage({ from, cacheBust });
        } else {
          if (!safeApiUrl(nextUrl)) return { news, complete: false, reason: "unsafe_next_url" };
          const normalizedNextUrl = withCacheBust(nextUrl, cacheBust);
          if (seenUrls.has(normalizedNextUrl)) return { news, complete: false, reason: "repeated_next_url" };
          seenUrls.add(normalizedNextUrl);
          pageResult = await this.getTrainingNewsPage({ url: nextUrl, cacheBust });
        }
        news.push(...pageResult.news);
        page += 1;
        if (typeof onProgress === "function") onProgress({ page, count: news.length });
        nextUrl = pageResult.next;
        if (!nextUrl) return { news, complete: true, reason: null };
        if (!safeApiUrl(nextUrl)) return { news, complete: false, reason: "unsafe_next_url" };
        if (page === 1) seenUrls.delete(withCacheBust(nextUrl, cacheBust));
      }
      return { news, complete: false, reason: "page_limit" };
    }
    async getTrainingNewsSince(timestamp, { cacheBust = null } = {}) {
      return this.#collectNews({ from: timestamp, cacheBust });
    }
    async rebuildTrainingNews(onProgress, { cacheBust = null } = {}) {
      return this.#collectNews({ onProgress, cacheBust });
    }
  };

  // src/infra/company-page-actions.js
  function parseMoney(value) {
    if (value === null || value === void 0) return null;
    const cleaned = String(value).replace(/[$,\s]/g, "");
    if (!/^-?\d+$/.test(cleaned)) return null;
    const n = Number(cleaned);
    return Number.isSafeInteger(n) ? n : null;
  }
  function mapGet(mapLike, id) {
    if (mapLike instanceof Map) return mapLike.get(Number(id));
    return mapLike?.[id] ?? mapLike?.[String(id)];
  }
  function toArray(value) {
    return Array.from(value || []);
  }
  function exactEmployeeIdFromHref(href, step) {
    try {
      const url = new URL(href, "https://www.torn.com");
      if (url.searchParams.get("step") !== step) return null;
      const id = url.searchParams.get("ID");
      return /^\d+$/.test(id || "") ? Number(id) : null;
    } catch {
      return null;
    }
  }
  function isSameOrigin(url, origin = "https://www.torn.com") {
    try {
      return new URL(url, origin).origin === origin;
    } catch {
      return false;
    }
  }
  function isDisabled(node) {
    if (!node) return true;
    const className = String(node.className || "");
    return Boolean(node.disabled) || node.getAttribute?.("aria-disabled") === "true" || /\bdisabled\b/i.test(className);
  }
  function findForm(document2) {
    const forms = toArray(document2?.querySelectorAll?.("form"));
    const candidates = forms.filter((form) => {
      try {
        const buttons = toArray(form.querySelectorAll?.("button, input[type='submit']"));
        if (buttons.length === 0 && form.controls) return true;
        return buttons.some((button2) => /SUBMIT\s+CHANGES/i.test(button2.textContent || button2.value || ""));
      } catch {
        return false;
      }
    });
    if (candidates.length === 1) return candidates[0];
    if (forms.length === 1) return forms[0];
    return null;
  }
  function closestEmployeeRow(link) {
    if (!link?.closest) return null;
    const selectors = [
      "li[data-user]",
      "tr[data-user]",
      "[data-employee-id]",
      "tr",
      "li",
      "[class*='employee']",
      "[class*='Employee']",
      "[class*='row']",
      "[class*='Row']",
      "div"
    ];
    for (const selector of selectors) {
      try {
        const row = link.closest(selector);
        if (row) return row;
      } catch {
      }
    }
    return null;
  }
  function rowControls(row) {
    if (!row?.querySelectorAll) return [];
    return toArray(row.querySelectorAll("input, select, textarea"));
  }
  function controlValue(control) {
    return parseMoney(control?.value);
  }
  function validRfcToken(value) {
    return typeof value === "string" && /^[A-Za-z0-9._~-]{4,}$/.test(value.trim());
  }
  function tokenFromUrl(value, origin) {
    try {
      const url = new URL(value, origin);
      const token = url.searchParams.get("rfcv") || url.searchParams.get("rfc_v");
      return validRfcToken(token) ? token.trim() : null;
    } catch {
      return null;
    }
  }
  function tokenFromCookie(cookie) {
    const text = String(cookie || "");
    for (const name of ["rfc_v", "rfcv"]) {
      const match = text.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
      if (!match) continue;
      const value = decodeURIComponent(match[1]);
      if (validRfcToken(value)) return value.trim();
    }
    return null;
  }
  function sanitizedReason(value, token = "") {
    let text = String(value || "Torn rejected the training request").trim();
    if (token) text = text.split(token).join("[redacted]");
    return text.slice(0, 300);
  }
  function findSubmitChangesControls(document2) {
    const selectors = [
      "button",
      "input[type='submit']",
      'input[type="submit"]',
      "[role='button']"
    ];
    const seen = /* @__PURE__ */ new Set();
    const candidates = [];
    for (const selector of selectors) {
      for (const node of toArray(document2?.querySelectorAll?.(selector))) {
        if (seen.has(node)) continue;
        seen.add(node);
        if (isDisabled(node)) continue;
        const label = String(node.textContent || node.value || node.getAttribute?.("aria-label") || "").trim();
        if (/SUBMIT\s+CHANGES/i.test(label)) candidates.push(node);
      }
    }
    return candidates;
  }
  function findSubmitChangesControl(document2) {
    const candidates = findSubmitChangesControls(document2);
    return candidates.length === 1 ? candidates[0] : null;
  }
  function dispatchWageEvents(document2, input) {
    const EventCtor = document2?.defaultView?.Event || globalThis.Event;
    for (const type of ["input", "change", "blur"]) {
      const event = typeof EventCtor === "function" ? new EventCtor(type, { bubbles: true }) : { type };
      input.dispatchEvent?.(event);
    }
  }
  function rowEmployeeId(row) {
    const raw = row?.dataset?.user ?? row?.getAttribute?.("data-user") ?? row?.dataset?.employeeId ?? row?.getAttribute?.("data-employee-id");
    const id = Number(raw);
    return Number.isInteger(id) ? id : null;
  }
  function visibleEmployeeRows(document2) {
    const selectors = [
      "ul.employee-list li[data-user]",
      "li[data-user]",
      "tr[data-user]",
      "[data-employee-id]"
    ];
    const seen = /* @__PURE__ */ new Set();
    const rows = [];
    for (const selector of selectors) {
      for (const row of toArray(document2?.querySelectorAll?.(selector))) {
        if (seen.has(row)) continue;
        seen.add(row);
        rows.push(row);
      }
    }
    return rows;
  }
  var CompanyPageActions = class {
    constructor({ document: document2, fetchImpl = globalThis.fetch?.bind(globalThis), formDataFactory = (form) => new FormData(form) } = {}) {
      if (!document2) throw new TypeError("document is required");
      if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
      this.document = document2;
      this.fetchImpl = fetchImpl;
      this.formDataFactory = formDataFactory;
    }
    #origin() {
      return this.document?.location?.origin || globalThis.location?.origin || "https://www.torn.com";
    }
    #isCompanyManagementPage() {
      try {
        const url = new URL(this.document?.location?.href || "", this.#origin());
        const step = url.searchParams.get("step");
        return url.origin === "https://www.torn.com" && /\/companies\.php$/i.test(url.pathname) && (!step || step === "your");
      } catch {
        return false;
      }
    }
    #legacyTrainLinksFor(employeeId) {
      const links = toArray(this.document.querySelectorAll?.('a[href*="step=trainemp2"]'));
      return links.filter((link) => exactEmployeeIdFromHref(link.href || link.getAttribute?.("href"), "trainemp2") === Number(employeeId));
    }
    #rowForEmployee(employeeId) {
      const id = Number(employeeId);
      if (!Number.isInteger(id)) return null;
      const selectors = [
        `ul.employee-list li[data-user="${id}"]`,
        `li[data-user="${id}"]`,
        `tr[data-user="${id}"]`,
        `[data-employee-id="${id}"]`
      ];
      for (const selector of selectors) {
        try {
          const row = this.document.querySelector?.(selector);
          if (row) return row;
        } catch {
        }
      }
      const links = this.#legacyTrainLinksFor(id);
      return links.length === 1 ? closestEmployeeRow(links[0]) : null;
    }
    #trainActionFor(employeeId) {
      const id = Number(employeeId);
      const row = this.#rowForEmployee(id);
      if (row?.querySelectorAll) {
        const selectors = [
          ".train .train-action.btn-wrap button.torn-btn",
          ".train button.torn-btn",
          ".train .train-action.btn-wrap",
          ".train a.train-action[href*='trainemp2']",
          "a.train-action[href*='trainemp2']",
          "a[href*='step=trainemp2']"
        ];
        for (const selector of selectors) {
          const candidates = toArray(row.querySelectorAll(selector));
          const enabled = candidates.filter((node) => {
            if (isDisabled(node)) return false;
            const wrapper = node.closest?.(".train-action");
            return !wrapper || !isDisabled(wrapper);
          });
          if (enabled.length > 1) return null;
          if (enabled.length === 1) return enabled[0];
        }
      }
      const legacy = this.#legacyTrainLinksFor(id).filter((node) => !isDisabled(node));
      return legacy.length === 1 ? legacy[0] : null;
    }
    #rfcToken() {
      const selectors = [
        'input[name="rfcv"]',
        'input[name="rfc_v"]',
        "#rfcv",
        "#rfc_v"
      ];
      for (const selector of selectors) {
        try {
          const value = this.document.querySelector?.(selector)?.value;
          if (validRfcToken(value)) return String(value).trim();
        } catch {
        }
      }
      const origin = this.#origin();
      const locationToken = tokenFromUrl(this.document?.location?.href, origin);
      if (locationToken) return locationToken;
      try {
        const links = toArray(this.document.querySelectorAll?.('a[href*="rfcv="], a[href*="rfc_v="]'));
        for (const link of links) {
          const token = tokenFromUrl(link.href || link.getAttribute?.("href"), origin);
          if (token) return token;
        }
      } catch {
      }
      try {
        const forms = toArray(this.document.querySelectorAll?.("form"));
        for (const form of forms) {
          const token = tokenFromUrl(form.action, origin);
          if (token) return token;
        }
      } catch {
      }
      return tokenFromCookie(this.document?.cookie);
    }
    findTrainHref(employeeId) {
      const action = this.#trainActionFor(employeeId);
      const href = action?.href || action?.getAttribute?.("href");
      if (!href || !isSameOrigin(href, this.#origin())) return null;
      return new URL(href, this.#origin()).href;
    }
    inspectTrainingEnvironment(employeeId = null) {
      const id = Number(employeeId);
      const row = Number.isInteger(id) ? this.#rowForEmployee(id) : null;
      const action = Number.isInteger(id) ? this.#trainActionFor(id) : null;
      const href = action?.href || action?.getAttribute?.("href") || null;
      return {
        employeeId: Number.isInteger(id) ? id : null,
        companyManagementPage: this.#isCompanyManagementPage(),
        employeeRowFound: Boolean(row),
        exactTrainControlFound: Boolean(action),
        legacyTrainHrefPresent: Boolean(href),
        targetOriginSafe: href ? isSameOrigin(href, this.#origin()) : true,
        rfcTokenPresent: Boolean(this.#rfcToken())
      };
    }
    async submitTrain(employeeId) {
      const id = Number(employeeId);
      if (!Number.isInteger(id)) return { status: "unsafe_dom", reason: "invalid_employee_id" };
      if (!this.#isCompanyManagementPage()) return { status: "unsafe_dom", reason: "not_company_management_page" };
      const row = this.#rowForEmployee(id);
      if (!row) return { status: "unsafe_dom", reason: "employee_row_not_found" };
      const token = this.#rfcToken();
      if (!token) return { status: "unsafe_dom", reason: "rfc_token_not_found" };
      const url = new URL("/companies.php", this.#origin());
      url.searchParams.set("rfcv", token);
      if (!isSameOrigin(url.href, "https://www.torn.com")) return { status: "unsafe_dom", reason: "cross_origin_train_endpoint" };
      const body = new URLSearchParams();
      body.set("step", "trainemp2");
      body.set("ID", String(id));
      try {
        const response = await this.fetchImpl(url.href, {
          method: "POST",
          body,
          credentials: "same-origin",
          headers: {
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest"
          }
        });
        if (!response?.ok) return { status: "http_failed", reason: `http_${Number(response?.status) || 0}`, httpStatus: Number(response?.status) || null };
        let payload;
        try {
          const text = typeof response.text === "function" ? await response.text() : "";
          payload = JSON.parse(text);
        } catch {
          return { status: "http_failed", reason: "invalid_response", httpStatus: Number(response?.status) || null };
        }
        if (payload?.success === true) return { status: "accepted", httpStatus: Number(response?.status) || 200 };
        if (payload?.success === false || payload?.error) {
          return {
            status: "rejected",
            reason: sanitizedReason(payload?.error ?? payload?.message ?? payload?.reason, token),
            httpStatus: Number(response?.status) || 200
          };
        }
        return { status: "http_failed", reason: "unrecognized_response", httpStatus: Number(response?.status) || 200 };
      } catch (error) {
        return { status: "http_failed", reason: "network_error", error: String(error?.message || error).slice(0, 300) };
      }
    }
    inspectPayrollForm(apiWagesById) {
      const form = findForm(this.document);
      if (!form) return { safe: false, reason: "payroll_form_not_unique", targets: /* @__PURE__ */ new Map() };
      const targets = /* @__PURE__ */ new Map();
      const entries = apiWagesById instanceof Map ? [...apiWagesById.entries()] : Object.entries(apiWagesById || {}).map(([id, wage]) => [Number(id), wage]);
      for (const [rawId, rawWage] of entries) {
        const employeeId = Number(rawId);
        const apiWage = Number(rawWage);
        if (!Number.isInteger(employeeId) || !Number.isInteger(apiWage)) return { safe: false, reason: "invalid_api_wage", targets };
        const row = this.#rowForEmployee(employeeId);
        if (!row) return { safe: false, reason: "employee_row_not_unique", employeeId, targets };
        const controls = rowControls(row).filter((control) => control?.name && !control.disabled && controlValue(control) !== null);
        const exact = controls.filter((control) => controlValue(control) === apiWage);
        if (exact.length > 1) return { safe: false, reason: "ambiguous_target_wage_input", employeeId, targets };
        if (exact.length === 0) {
          const numeric = controls.filter((control) => /wage|pay|salary/i.test(control.name || ""));
          if (numeric.length > 0) return { safe: false, reason: "unrelated_dirty_wage", employeeId, targets };
          return { safe: false, reason: "wage_input_not_found", employeeId, targets };
        }
        targets.set(employeeId, { row, input: exact[0], apiWage });
      }
      return { safe: true, reason: null, form, targets };
    }
    inspectPayrollEnvironment(apiWagesById, employeeId = null) {
      const id = Number(employeeId);
      const targetId = Number.isInteger(id) ? id : null;
      const row = targetId == null ? null : this.#rowForEmployee(targetId);
      const wageInputs = row ? toArray(row.querySelectorAll?.(".pay input")).filter((input) => !isDisabled(input)) : [];
      const dirtyEmployeeIds = [];
      let apiWageCoverageOk = true;
      let targetDirty = false;
      for (const visibleRow of visibleEmployeeRows(this.document)) {
        const visibleId = rowEmployeeId(visibleRow);
        if (!Number.isInteger(visibleId)) continue;
        const inputs = toArray(visibleRow.querySelectorAll?.(".pay input")).filter((input) => !isDisabled(input));
        if (inputs.length === 0) continue;
        if (inputs.length !== 1) {
          apiWageCoverageOk = false;
          continue;
        }
        const apiWage = Number(mapGet(apiWagesById, visibleId));
        const currentWage = controlValue(inputs[0]);
        if (!Number.isInteger(apiWage) || apiWage < 0 || currentWage === null) {
          apiWageCoverageOk = false;
          continue;
        }
        if (currentWage !== apiWage) {
          dirtyEmployeeIds.push(visibleId);
          if (visibleId === targetId) targetDirty = true;
        }
      }
      return {
        employeeId: targetId,
        employeeRowFound: Boolean(row),
        wageInputCount: wageInputs.length,
        submitControlCount: findSubmitChangesControls(this.document).length,
        targetDirty,
        dirtyEmployeeIds,
        apiWageCoverageOk
      };
    }
    async submitWageChange({ employeeId, targetWage, apiWagesById }) {
      const id = Number(employeeId);
      if (!Number.isInteger(id)) return { status: "unsafe_dom", reason: "invalid_employee_id" };
      if (!Number.isInteger(targetWage) || targetWage < 0) return { status: "unsafe_dom", reason: "invalid_target_wage" };
      if (!this.#isCompanyManagementPage()) return { status: "unsafe_dom", reason: "not_company_management_page" };
      const row = this.#rowForEmployee(id);
      if (!row) return { status: "unsafe_dom", reason: "employee_row_not_found", employeeId: id };
      const wageInputs = toArray(row.querySelectorAll?.(".pay input")).filter((input2) => !isDisabled(input2));
      if (wageInputs.length !== 1) return { status: "unsafe_dom", reason: "wage_input_not_unique", employeeId: id };
      const targetApiWage = Number(mapGet(apiWagesById, id));
      if (!Number.isInteger(targetApiWage) || targetApiWage < 0) return { status: "unsafe_dom", reason: "api_wage_unverified", employeeId: id };
      const targetCurrentWage = controlValue(wageInputs[0]);
      if (targetCurrentWage === null) return { status: "unsafe_dom", reason: "wage_value_unreadable", employeeId: id };
      if (targetCurrentWage !== targetApiWage) return { status: "unsafe_dom", reason: "target_dirty_wage", employeeId: id };
      for (const visibleRow of visibleEmployeeRows(this.document)) {
        const visibleId = rowEmployeeId(visibleRow);
        if (!Number.isInteger(visibleId) || visibleId === id) continue;
        const inputs = toArray(visibleRow.querySelectorAll?.(".pay input")).filter((input2) => !isDisabled(input2));
        if (inputs.length === 0) continue;
        if (inputs.length !== 1) return { status: "unsafe_dom", reason: "wage_input_not_unique", employeeId: visibleId };
        const apiWage = Number(mapGet(apiWagesById, visibleId));
        if (!Number.isInteger(apiWage) || apiWage < 0) return { status: "unsafe_dom", reason: "api_wage_unverified", employeeId: visibleId };
        const currentWage = controlValue(inputs[0]);
        if (currentWage === null) return { status: "unsafe_dom", reason: "wage_value_unreadable", employeeId: visibleId };
        if (currentWage !== apiWage) return { status: "unsafe_dom", reason: "unrelated_dirty_wage", employeeId: visibleId };
      }
      const submitControl = findSubmitChangesControl(this.document);
      if (!submitControl) return { status: "unsafe_dom", reason: "submit_changes_not_unique" };
      const input = wageInputs[0];
      input.value = String(targetWage);
      dispatchWageEvents(this.document, input);
      submitControl.click?.();
      return { status: "submitted" };
    }
  };

  // src/core/eligibility.js
  function validPolicy(settings) {
    return settings && Number.isFinite(Number(settings.maxAddiction)) && Number(settings.maxAddiction) >= 0;
  }
  function finiteOptional(value) {
    if (value === null || value === void 0 || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  function resolveTenureSeconds(employee, nowSeconds) {
    const joinedAt = finiteOptional(employee?.joinedAt);
    if (joinedAt !== null) return Math.max(0, Number(nowSeconds) - joinedAt);
    const daysInCompany = finiteOptional(employee?.daysInCompany);
    if (daysInCompany !== null && daysInCompany >= 0) return daysInCompany * SECONDS_PER_DAY;
    return null;
  }
  function evaluateEligibility(employee, settings, nowSeconds = Math.floor(Date.now() / 1e3)) {
    const reasons = [];
    let unverified = false;
    let inactive = false;
    let addictionViolation = false;
    let newHireHold = false;
    let inactivitySeconds = null;
    let tenureSeconds = null;
    if (!validPolicy(settings)) {
      return {
        eligible: false,
        unverified: true,
        inactive: false,
        addictionViolation: false,
        newHireHold: false,
        reasons: [{ code: "unverified_policy" }],
        inactivitySeconds: null,
        tenureSeconds: null
      };
    }
    tenureSeconds = resolveTenureSeconds(employee, nowSeconds);
    if (!Number.isFinite(tenureSeconds)) {
      unverified = true;
      reasons.push({ code: "unverified_tenure" });
    } else if (tenureSeconds < NEW_HIRE_HOLD_SECONDS) {
      newHireHold = true;
      reasons.push({ code: "new_hire_hold", actual: tenureSeconds, limit: NEW_HIRE_HOLD_SECONDS });
    }
    const lastAction = employee?.lastActionTimestamp;
    if (!Number.isFinite(lastAction)) {
      unverified = true;
      reasons.push({ code: "unverified_activity" });
    } else {
      inactivitySeconds = Math.max(0, Number(nowSeconds) - Number(lastAction));
      if (inactivitySeconds > SECONDS_PER_DAY) {
        inactive = true;
        reasons.push({ code: "inactive", actual: inactivitySeconds, limit: SECONDS_PER_DAY });
      }
    }
    const addiction = employee?.addictionMagnitude;
    if (!Number.isFinite(addiction)) {
      unverified = true;
      reasons.push({ code: "unverified_addiction" });
    } else if (Number(addiction) > Number(settings.maxAddiction)) {
      addictionViolation = true;
      reasons.push({ code: "addiction", actual: Number(addiction), limit: Number(settings.maxAddiction) });
    }
    return {
      eligible: !unverified && !inactive && !addictionViolation && !newHireHold,
      unverified,
      inactive,
      addictionViolation,
      newHireHold,
      reasons,
      inactivitySeconds,
      tenureSeconds
    };
  }

  // src/core/rotation.js
  function getFrom(mapLike, id) {
    if (mapLike instanceof Map) return mapLike.get(id);
    return mapLike?.[id] ?? mapLike?.[String(id)];
  }
  function joinedAtValue(employee) {
    return Number.isFinite(Number(employee?.joinedAt)) ? Number(employee.joinedAt) : Number.MAX_SAFE_INTEGER;
  }
  function idValue(employee) {
    const n = Number(employee?.id);
    return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
  }
  function historyInfo(trainingById, id) {
    const summary = getFrom(trainingById, id) || {};
    const totalTrains = Number.isFinite(Number(summary.totalTrains)) ? Number(summary.totalTrains) : 0;
    const last = Number.isFinite(Number(summary.lastTrainTimestamp)) ? Number(summary.lastTrainTimestamp) : null;
    return { totalTrains, lastTrainTimestamp: last };
  }
  function rankTrainingCandidates({ employees = [], eligibilityById, trainingById, settings = {} } = {}) {
    const prioritizeNeverTrained = settings.prioritizeNeverTrained !== false;
    const eligibleRows = [];
    const skipped = [];
    const reasonById = /* @__PURE__ */ new Map();
    for (const employee of [...employees]) {
      const eligibility = getFrom(eligibilityById, employee.id);
      const history = historyInfo(trainingById, employee.id);
      const row = { ...employee, trainingSummary: { ...history } };
      if (!eligibility?.eligible) {
        skipped.push(row);
        reasonById.set(employee.id, "skipped_ineligible");
        continue;
      }
      eligibleRows.push(row);
    }
    eligibleRows.sort((a, b) => {
      const ah = a.trainingSummary;
      const bh = b.trainingSummary;
      const aNever = ah.totalTrains === 0;
      const bNever = bh.totalTrains === 0;
      if (prioritizeNeverTrained && aNever !== bNever) return aNever ? -1 : 1;
      if (prioritizeNeverTrained && aNever && bNever) {
        return joinedAtValue(a) - joinedAtValue(b) || idValue(a) - idValue(b);
      }
      const aLast = ah.lastTrainTimestamp ?? 0;
      const bLast = bh.lastTrainTimestamp ?? 0;
      return aLast - bLast || joinedAtValue(a) - joinedAtValue(b) || idValue(a) - idValue(b);
    });
    eligibleRows.forEach((employee, index) => {
      const history = employee.trainingSummary;
      if (history.totalTrains === 0) reasonById.set(employee.id, "never_trained");
      else if (index === 0) reasonById.set(employee.id, "oldest_last_train");
      else reasonById.set(employee.id, "queued");
    });
    skipped.sort((a, b) => idValue(a) - idValue(b));
    return {
      orderedEligible: eligibleRows,
      skipped,
      nextEmployeeId: eligibleRows[0]?.id ?? null,
      reasonById
    };
  }

  // src/core/payroll.js
  function assertWage(value, label = "wage") {
    if (!Number.isInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
  }
  function nowInt(nowSeconds) {
    const n = Number(nowSeconds);
    return Number.isFinite(n) ? Math.trunc(n) : Math.floor(Date.now() / 1e3);
  }
  function createDockRecord(employee, targetWage, eligibility, nowSeconds = Math.floor(Date.now() / 1e3)) {
    assertWage(targetWage, "Target wage");
    if (!employee || !Number.isFinite(Number(employee.id))) throw new TypeError("Employee id is required");
    if (!Number.isInteger(employee.wage) || employee.wage < 0) throw new TypeError("Current wage is required");
    return {
      employeeId: Number(employee.id),
      previousPay: employee.wage,
      requestedDockedPay: targetWage,
      dockedPay: null,
      dockedAt: nowInt(nowSeconds),
      dockVerifiedAt: null,
      reasonsAtDock: Array.isArray(eligibility?.reasons) ? eligibility.reasons.map((r) => ({ ...r })) : [],
      restoredAt: null
    };
  }
  function markDockVerified(record, currentWage, nowSeconds = Math.floor(Date.now() / 1e3)) {
    assertWage(currentWage, "Current wage");
    if (!record) throw new TypeError("Dock record is required");
    if (currentWage !== record.requestedDockedPay) throw new Error("Current wage does not match requested docked wage");
    return {
      ...record,
      dockedPay: currentWage,
      dockVerifiedAt: nowInt(nowSeconds)
    };
  }
  function employeeEligible(employee) {
    if (typeof employee?.eligible === "boolean") return employee.eligible;
    if (typeof employee?.eligibility?.eligible === "boolean") return employee.eligibility.eligible;
    return false;
  }
  function getRestoreState(record, employee) {
    const active = Boolean(record?.dockVerifiedAt) && record?.restoredAt == null && Number.isInteger(record?.dockedPay);
    const eligible = employeeEligible(employee);
    const available = active && eligible;
    let warning = null;
    if (available && Number.isInteger(employee?.wage) && employee.wage !== record.dockedPay) warning = "current_wage_changed";
    return {
      available,
      warning,
      restoreWage: available ? record.previousPay : null
    };
  }
  function markRestoreVerified(record, nowSeconds = Math.floor(Date.now() / 1e3)) {
    if (!record?.dockVerifiedAt || record.restoredAt != null) throw new Error("Dock record is not active");
    return { ...record, restoredAt: nowInt(nowSeconds) };
  }

  // src/app/controller-v110.js
  var emptyRotation = () => ({ orderedEligible: [], skipped: [], nextEmployeeId: null, reasonById: /* @__PURE__ */ new Map() });
  var TRAIN_CACHE_WAIT_MS = 31e3;
  var EMPTY_AUDIT = Object.freeze({ schemaVersion: 1, entries: [] });
  function employeeMap(employees) {
    return new Map((employees || []).map((employee) => [Number(employee.id), employee]));
  }
  function wagesMap(employees) {
    return new Map((employees || []).filter((e) => Number.isInteger(e.wage)).map((e) => [Number(e.id), e.wage]));
  }
  function validSettingsPatch(patch) {
    if (Object.prototype.hasOwnProperty.call(patch, "inactivityDays")) {
      if (!Number.isFinite(Number(patch.inactivityDays)) || Number(patch.inactivityDays) < 0) return false;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "maxAddiction")) {
      if (!Number.isInteger(Number(patch.maxAddiction)) || Number(patch.maxAddiction) < 0) return false;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "refreshMinutes")) {
      if (!Number.isFinite(Number(patch.refreshMinutes)) || Number(patch.refreshMinutes) <= 0) return false;
    }
    return true;
  }
  function hasNewTrainingEvent(history, beforeIds, employeeId) {
    return Object.entries(history?.eventsByNewsId || {}).some(([newsId, event]) => !beforeIds.has(newsId) && Number(event?.employeeId) === Number(employeeId));
  }
  function activeDockCount(payroll) {
    return Object.values(payroll?.recordsByEmployeeId || {}).filter((record) => record?.dockVerifiedAt && record?.restoredAt == null).length;
  }
  function changedSettingKeys(before = {}, after = {}) {
    const keys = /* @__PURE__ */ new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    return [...keys].filter((key) => key !== "schemaVersion" && JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]));
  }
  var TrainingManagerController = class {
    constructor({ api, storage, pageActions, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), nowSeconds = () => Math.floor(Date.now() / 1e3) }) {
      if (!api || !storage || !pageActions) throw new TypeError("api, storage and pageActions are required");
      this.api = api;
      this.storage = storage;
      this.pageActions = pageActions;
      this.sleep = sleep;
      this.nowSeconds = nowSeconds;
      this.listeners = /* @__PURE__ */ new Set();
      this.refreshPromise = null;
      this.actionLocks = /* @__PURE__ */ new Set();
      this.unverifiedTrainIds = /* @__PURE__ */ new Set();
      this.state = {
        status: "idle",
        stale: true,
        lastUpdatedAt: null,
        employees: [],
        eligibilityById: /* @__PURE__ */ new Map(),
        trainingById: /* @__PURE__ */ new Map(),
        rotation: emptyRotation(),
        trains: null,
        profile: null,
        history: emptyHistoryState(),
        payroll: { schemaVersion: 1, recordsByEmployeeId: {} },
        audit: { ...EMPTY_AUDIT, entries: [] },
        auditError: null,
        settings: null,
        action: null,
        error: null
      };
    }
    getState() {
      return this.state;
    }
    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    #emit(patch = {}) {
      this.state = { ...this.state, ...patch };
      for (const listener of this.listeners) {
        try {
          listener(this.state);
        } catch {
        }
      }
    }
    #recompute(extra = {}) {
      const employees = extra.employees ?? this.state.employees;
      const history = extra.history ?? this.state.history;
      const settings = extra.settings ?? this.state.settings;
      const eligibilityById = /* @__PURE__ */ new Map();
      if (settings) {
        for (const employee of employees) eligibilityById.set(Number(employee.id), evaluateEligibility(employee, settings, this.nowSeconds()));
      }
      const trainingById = summarizeTrainingHistory(history, employees);
      const rotation = settings ? rankTrainingCandidates({ employees, eligibilityById, trainingById, settings }) : emptyRotation();
      this.#emit({ employees, history, settings, eligibilityById, trainingById, rotation, ...extra });
    }
    async #audit(type, phase, { employee = null, employeeId = null, employeeName: employeeName2 = null, details = {} } = {}) {
      if (typeof this.storage.appendAudit !== "function") return null;
      const resolvedId = Number.isInteger(Number(employee?.id)) ? Number(employee.id) : Number.isInteger(Number(employeeId)) ? Number(employeeId) : null;
      const resolvedName = employee?.name ?? employeeName2 ?? null;
      const entry = createAuditEntry({ type, phase, employeeId: resolvedId, employeeName: resolvedName, details }, this.nowSeconds());
      try {
        const audit = await this.storage.appendAudit(entry);
        this.#emit({ audit, auditError: null });
        return entry;
      } catch (error) {
        this.#emit({ auditError: String(error?.message || "Audit storage failed") });
        return null;
      }
    }
    async initialize() {
      const [settings, history, payroll, cache, audit] = await Promise.all([
        this.storage.loadSettings(),
        this.storage.loadHistory(),
        this.storage.loadPayroll(),
        this.storage.loadCache(),
        typeof this.storage.loadAudit === "function" ? this.storage.loadAudit() : Promise.resolve({ ...EMPTY_AUDIT, entries: [] })
      ]);
      this.state = {
        ...this.state,
        settings,
        history,
        payroll,
        audit,
        employees: Array.isArray(cache.employees) ? cache.employees : [],
        trains: cache.trains ?? null,
        profile: cache.profile ?? null,
        lastUpdatedAt: cache.lastUpdatedAt ?? null,
        stale: true,
        status: "loading"
      };
      this.#recompute();
      await this.refresh();
      return this.state;
    }
    async refresh() {
      if (this.refreshPromise) return this.refreshPromise;
      this.refreshPromise = this.#refreshInternal().finally(() => {
        this.refreshPromise = null;
      });
      return this.refreshPromise;
    }
    async #refreshInternal() {
      this.#emit({ status: "refreshing", error: null });
      try {
        const [employees, profile] = await Promise.all([this.api.getEmployees(), this.api.getProfile()]);
        const capabilityMissing = [];
        if (!Number.isFinite(Number(profile?.trains))) capabilityMissing.push("profile.trains");
        if (employees.length > 0) {
          const sample = employees[0];
          if (!Number.isInteger(sample?.wage) || sample.wage < 0) capabilityMissing.push("employees.wage");
          if (!Number.isFinite(Number(sample?.joinedAt))) capabilityMissing.push("employees.joined_at");
          if (!Number.isFinite(Number(sample?.rawAddictionEffectiveness))) capabilityMissing.push("employees.effectiveness.addiction");
          if (!Number.isFinite(Number(sample?.lastActionTimestamp))) capabilityMissing.push("employees.last_action.timestamp");
        }
        if (capabilityMissing.length) throw new Error(`Director API capability validation failed: ${capabilityMissing.join(", ")}`);
        const newsResult = await this.api.getTrainingNewsSince(this.state.history?.newestTimestamp || 0);
        const history = mergeTrainingNews(this.state.history, newsResult?.news || []);
        await this.storage.saveHistory(history);
        const trains = Number.isFinite(Number(profile?.trains)) ? Number(profile.trains) : null;
        const lastUpdatedAt = this.nowSeconds();
        await this.storage.saveCache({ employees, trains, profile, lastUpdatedAt });
        this.unverifiedTrainIds.clear();
        this.#recompute({
          employees,
          profile,
          trains,
          history,
          stale: false,
          lastUpdatedAt,
          status: newsResult?.complete === false ? "partial" : "ready",
          error: newsResult?.complete === false ? `Training news sync incomplete: ${newsResult.reason || "unknown"}` : null,
          action: null
        });
      } catch (error) {
        const reason = String(error?.message || "Unable to refresh Torn data");
        this.#emit({ status: "error", stale: true, error: reason, action: null });
        await this.#audit("refresh", "failed", { details: { reason } });
      }
      return this.state;
    }
    async rebuildHistory() {
      if (this.state.stale) throw new Error("Cannot rebuild history while current data is stale");
      this.#emit({ status: "rebuilding_history", action: { type: "history", status: "pending" } });
      try {
        const result = await this.api.rebuildTrainingNews();
        const history = mergeTrainingNews(emptyHistoryState(), result.news || []);
        await this.storage.saveHistory(history);
        const phase = result.complete ? "completed" : "incomplete";
        this.#recompute({ history, status: result.complete ? "ready" : "partial", action: { type: "history", status: result.complete ? "verified" : "incomplete" } });
        await this.#audit("history", phase, { details: { complete: Boolean(result.complete), reason: result.reason || null, eventCount: Object.keys(history.eventsByNewsId || {}).length } });
        return { status: result.complete ? "verified" : "incomplete", reason: result.reason || null };
      } catch (error) {
        const reason = String(error?.message || error);
        await this.#audit("history", "failed", { details: { reason } });
        throw error;
      }
    }
    #assertFresh() {
      if (this.state.stale) throw new Error("Current company data is stale; refresh before making changes");
    }
    #employee(id) {
      return employeeMap(this.state.employees).get(Number(id)) || null;
    }
    #eligibility(id) {
      return this.state.eligibilityById.get(Number(id)) || null;
    }
    async #readTrainingNews(history, { cacheBust = null } = {}) {
      const result = await this.api.getTrainingNewsSince(history?.newestTimestamp || 0, cacheBust == null ? {} : { cacheBust });
      return mergeTrainingNews(history, result?.news || []);
    }
    async trainEmployee(id) {
      id = Number(id);
      this.#assertFresh();
      if (this.unverifiedTrainIds.has(id)) throw new Error("Previous train attempt is awaiting verification; refresh before retrying");
      if (this.actionLocks.has(id)) throw new Error("An action is already pending for this employee");
      const employee = this.#employee(id);
      const eligibility = this.#eligibility(id);
      if (!employee) throw new Error("Employee not found");
      if (!eligibility?.eligible) throw new Error("Employee is not eligible for training");
      if (!Number.isFinite(Number(this.state.trains)) || Number(this.state.trains) <= 0) throw new Error("No company trains are available");
      await this.#audit("train", "requested", {
        employee,
        details: { trainsBefore: this.state.trains, eligibilityReasons: (eligibility.reasons || []).map((r) => r.code) }
      });
      this.actionLocks.add(id);
      this.#emit({ action: { type: "train", employeeId: id, status: "pending" } });
      try {
        const beforeIds = new Set(Object.keys(this.state.history.eventsByNewsId || {}));
        const submitted = await this.pageActions.submitTrain(id);
        if (submitted?.status === "rejected") {
          const reason = submitted?.reason || "Torn rejected the training request";
          this.#emit({ action: { type: "train", employeeId: id, status: "rejected", reason } });
          await this.#audit("train", "rejected", { employee, details: { reason, trainsBefore: this.state.trains } });
          return { status: "rejected", reason };
        }
        if (submitted?.status !== "accepted") {
          const reason = submitted?.reason || submitted?.status || "Training request failed";
          this.#emit({ action: { type: "train", employeeId: id, status: "failed", reason } });
          await this.#audit("train", "failed", { employee, details: { reason, trainsBefore: this.state.trains } });
          return { status: "failed", reason };
        }
        this.#emit({ action: { type: "train", employeeId: id, status: "accepted" } });
        await this.#audit("train", "accepted", { employee, details: { trainsBefore: this.state.trains } });
        let workingHistory = await this.#readTrainingNews(this.state.history);
        if (hasNewTrainingEvent(workingHistory, beforeIds, id)) {
          await this.storage.saveHistory(workingHistory);
          this.#recompute({ history: workingHistory });
          await this.refresh();
          this.#emit({ action: { type: "train", employeeId: id, status: "verified" } });
          await this.#audit("train", "verified", { employee, details: { trainsAfter: this.state.trains } });
          return { status: "verified" };
        }
        this.#recompute({
          history: workingHistory,
          action: { type: "train", employeeId: id, status: "awaiting_verification", retryAfterSeconds: 31 }
        });
        await this.#audit("train", "awaiting_verification", { employee, details: { retryAfterSeconds: 31 } });
        await this.sleep(TRAIN_CACHE_WAIT_MS);
        workingHistory = await this.#readTrainingNews(workingHistory, { cacheBust: this.nowSeconds() });
        await this.storage.saveHistory(workingHistory);
        if (!hasNewTrainingEvent(workingHistory, beforeIds, id)) {
          this.unverifiedTrainIds.add(id);
          const reason = "Torn accepted the request, but company news has not confirmed it yet. Refresh and verify before retrying.";
          this.#recompute({
            history: workingHistory,
            action: { type: "train", employeeId: id, status: "accepted_unverified", reason }
          });
          await this.#audit("train", "accepted_unverified", { employee, details: { reason } });
          return { status: "accepted_unverified" };
        }
        this.#recompute({ history: workingHistory });
        await this.refresh();
        this.#emit({ action: { type: "train", employeeId: id, status: "verified" } });
        await this.#audit("train", "verified", { employee, details: { trainsAfter: this.state.trains } });
        return { status: "verified" };
      } catch (error) {
        const reason = String(error?.message || error);
        this.#emit({ action: { type: "train", employeeId: id, status: "failed", reason } });
        await this.#audit("train", "failed", { employee, details: { reason } });
        throw error;
      } finally {
        this.actionLocks.delete(id);
      }
    }
    async #pollWage(employeeId, targetWage) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (attempt > 0) await this.sleep(1500);
        const employees = await this.api.getEmployees({ cacheBust: this.nowSeconds() });
        const target = employeeMap(employees).get(Number(employeeId));
        if (target?.wage === targetWage) return { verified: true, employees, employee: target };
      }
      return { verified: false };
    }
    async dockPay(id, targetWage) {
      id = Number(id);
      this.#assertFresh();
      if (this.actionLocks.has(id)) throw new Error("An action is already pending for this employee");
      const employee = this.#employee(id);
      const eligibility = this.#eligibility(id);
      if (!employee) throw new Error("Employee not found");
      if (eligibility?.eligible) throw new Error("Eligible employees cannot have pay docked by this policy tool");
      if (eligibility?.unverified) throw new Error("Eligibility is unverified; pay docking is disabled");
      const record = createDockRecord(employee, targetWage, eligibility, this.nowSeconds());
      await this.#audit("dock", "requested", { employee, details: { previousWage: employee.wage, requestedWage: targetWage, eligibilityReasons: (eligibility.reasons || []).map((r) => r.code) } });
      this.actionLocks.add(id);
      this.#emit({ action: { type: "dock", employeeId: id, status: "pending" } });
      try {
        const submitted = await this.pageActions.submitWageChange({ employeeId: id, targetWage, apiWagesById: wagesMap(this.state.employees) });
        if (submitted?.status !== "submitted") {
          const reason = submitted?.reason || submitted?.status || "Pay dock submission failed";
          this.#emit({ action: { type: "dock", employeeId: id, status: "failed", reason } });
          await this.#audit("dock", "failed", { employee, details: { reason, requestedWage: targetWage } });
          return { status: "failed", reason };
        }
        const poll = await this.#pollWage(id, targetWage);
        if (!poll.verified) {
          this.#emit({ stale: true, action: { type: "dock", employeeId: id, status: "unverified" } });
          await this.#audit("dock", "unverified", { employee, details: { requestedWage: targetWage } });
          return { status: "unverified" };
        }
        const verifiedRecord = markDockVerified(record, targetWage, this.nowSeconds());
        const payroll = {
          ...this.state.payroll,
          recordsByEmployeeId: { ...this.state.payroll.recordsByEmployeeId || {}, [id]: verifiedRecord }
        };
        await this.storage.savePayroll(payroll);
        this.#emit({ payroll });
        await this.refresh();
        this.#emit({ action: { type: "dock", employeeId: id, status: "verified" } });
        await this.#audit("dock", "verified", { employee, details: { previousWage: employee.wage, dockedWage: targetWage } });
        return { status: "verified", record: verifiedRecord };
      } catch (error) {
        const reason = String(error?.message || error);
        this.#emit({ action: { type: "dock", employeeId: id, status: "failed", reason } });
        await this.#audit("dock", "failed", { employee, details: { reason, requestedWage: targetWage } });
        throw error;
      } finally {
        this.actionLocks.delete(id);
      }
    }
    getRestoreStateFor(id) {
      id = Number(id);
      const record = this.state.payroll?.recordsByEmployeeId?.[id] ?? this.state.payroll?.recordsByEmployeeId?.[String(id)];
      const employee = this.#employee(id);
      const eligibility = this.#eligibility(id);
      if (!record || !employee) return { available: false, warning: null, restoreWage: null };
      return getRestoreState(record, { ...employee, eligibility });
    }
    async restorePay(id, { confirmMismatch = false } = {}) {
      id = Number(id);
      this.#assertFresh();
      if (this.actionLocks.has(id)) throw new Error("An action is already pending for this employee");
      const record = this.state.payroll?.recordsByEmployeeId?.[id] ?? this.state.payroll?.recordsByEmployeeId?.[String(id)];
      const employee = this.#employee(id);
      if (!record || !employee) throw new Error("No active dock record exists for this employee");
      const restoreState = this.getRestoreStateFor(id);
      if (!restoreState.available) throw new Error("Employee is not yet eligible for pay restoration");
      if (restoreState.warning === "current_wage_changed" && !confirmMismatch) throw new Error("Current wage changed; explicit mismatch confirmation is required");
      const targetWage = restoreState.restoreWage;
      await this.#audit("restore", "requested", { employee, details: { currentWage: employee.wage, restoreWage: targetWage, mismatchConfirmed: Boolean(confirmMismatch) } });
      this.actionLocks.add(id);
      this.#emit({ action: { type: "restore", employeeId: id, status: "pending" } });
      try {
        const submitted = await this.pageActions.submitWageChange({ employeeId: id, targetWage, apiWagesById: wagesMap(this.state.employees) });
        if (submitted?.status !== "submitted") {
          const reason = submitted?.reason || submitted?.status || "Pay restoration submission failed";
          this.#emit({ action: { type: "restore", employeeId: id, status: "failed", reason } });
          await this.#audit("restore", "failed", { employee, details: { reason, restoreWage: targetWage } });
          return { status: "failed", reason };
        }
        const poll = await this.#pollWage(id, targetWage);
        if (!poll.verified) {
          this.#emit({ stale: true, action: { type: "restore", employeeId: id, status: "unverified" } });
          await this.#audit("restore", "unverified", { employee, details: { restoreWage: targetWage } });
          return { status: "unverified" };
        }
        const restoredRecord = markRestoreVerified(record, this.nowSeconds());
        const payroll = {
          ...this.state.payroll,
          recordsByEmployeeId: { ...this.state.payroll.recordsByEmployeeId || {}, [id]: restoredRecord }
        };
        await this.storage.savePayroll(payroll);
        this.#emit({ payroll });
        await this.refresh();
        this.#emit({ action: { type: "restore", employeeId: id, status: "verified" } });
        await this.#audit("restore", "verified", { employee, details: { restoredWage: targetWage } });
        return { status: "verified", record: restoredRecord };
      } catch (error) {
        const reason = String(error?.message || error);
        this.#emit({ action: { type: "restore", employeeId: id, status: "failed", reason } });
        await this.#audit("restore", "failed", { employee, details: { reason, restoreWage: targetWage } });
        throw error;
      } finally {
        this.actionLocks.delete(id);
      }
    }
    async getAudit() {
      if (typeof this.storage.loadAudit !== "function") return this.state.audit;
      try {
        const audit = await this.storage.loadAudit();
        this.#emit({ audit, auditError: null });
        return audit;
      } catch (error) {
        this.#emit({ auditError: String(error?.message || "Audit storage failed") });
        return this.state.audit;
      }
    }
    async clearAudit() {
      if (typeof this.storage.clearAudit !== "function") return this.state.audit;
      try {
        const audit = await this.storage.clearAudit();
        this.#emit({ audit, auditError: null });
        return audit;
      } catch (error) {
        this.#emit({ auditError: String(error?.message || "Audit storage failed") });
        return this.state.audit;
      }
    }
    getDiagnostics() {
      const nextId = this.state.rotation?.nextEmployeeId ?? null;
      const nextEmployee = this.#employee(nextId);
      const diagnostics = {
        generatedAt: this.nowSeconds(),
        controller: {
          status: this.state.status,
          stale: this.state.stale,
          error: this.state.error || null,
          lastUpdatedAt: this.state.lastUpdatedAt,
          trains: this.state.trains,
          employeeCount: this.state.employees.length,
          eligibleCount: this.state.rotation?.orderedEligible?.length ?? 0,
          skippedCount: this.state.rotation?.skipped?.length ?? 0,
          nextEmployeeId: nextEmployee?.id ?? null,
          nextEmployeeName: nextEmployee?.name ?? null,
          action: this.state.action || null,
          pendingManualTrainVerificationIds: [...this.unverifiedTrainIds],
          activeDockCount: activeDockCount(this.state.payroll)
        },
        history: {
          eventCount: Object.keys(this.state.history?.eventsByNewsId || {}).length,
          unresolvedCount: Object.keys(this.state.history?.unresolvedByNewsId || {}).length,
          newestTimestamp: Number(this.state.history?.newestTimestamp) || 0
        },
        audit: {
          entryCount: this.state.audit?.entries?.length ?? 0,
          storageError: this.state.auditError || null
        },
        page: this.pageActions.inspectTrainingEnvironment?.(nextId) || null
      };
      return sanitizeAuditValue(diagnostics);
    }
    async updateSettings(patch = {}) {
      if (!validSettingsPatch(patch)) throw new TypeError("Invalid training manager settings");
      const before = this.state.settings || {};
      const settings = await this.storage.saveSettings({ ...before, ...patch });
      this.#recompute({ settings });
      const changedKeys = changedSettingKeys(before, settings);
      if (changedKeys.length) {
        const safeValues = {};
        for (const key of changedKeys) safeValues[key] = settings[key];
        await this.#audit("settings", "changed", { details: { changedKeys, values: safeValues } });
      }
      return settings;
    }
  };

  // src/app/controller-idempotency-base.js
  var EMPTY_TRAIN_RECEIPTS = Object.freeze({ schemaVersion: 1, receiptsByEmployeeId: {} });
  var TRAIN_CACHE_WAIT_MS2 = 31e3;
  function employeeMap2(employees) {
    return new Map((employees || []).map((employee) => [Number(employee.id), employee]));
  }
  function emptyRotation2() {
    return { orderedEligible: [], skipped: [], nextEmployeeId: null, reasonById: /* @__PURE__ */ new Map() };
  }
  function clone4(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }
  function isRecord3(value) {
    return value && typeof value === "object" && !Array.isArray(value);
  }
  function normalizeTrainReceipts(value) {
    const raw = isRecord3(value?.receiptsByEmployeeId) ? value.receiptsByEmployeeId : {};
    const receiptsByEmployeeId = {};
    for (const [key, receipt] of Object.entries(raw)) {
      if (!isRecord3(receipt)) continue;
      const id = Number(receipt.employeeId ?? key);
      if (!Number.isInteger(id)) continue;
      receiptsByEmployeeId[String(id)] = { ...clone4(receipt), employeeId: id };
    }
    return { schemaVersion: 1, receiptsByEmployeeId };
  }
  function receiptConfirmedByHistory(receipt, history) {
    const employeeId = Number(receipt?.employeeId);
    if (!Number.isInteger(employeeId)) return false;
    const historyFloor = Number(receipt?.historyNewestTimestampBefore) || 0;
    const requestedAt = Number(receipt?.requestedAt) || 0;
    return Object.values(history?.eventsByNewsId || {}).some((event) => {
      if (Number(event?.employeeId) !== employeeId) return false;
      const timestamp = Number(event?.timestamp) || 0;
      if (timestamp <= historyFloor) return false;
      if (requestedAt > 0 && timestamp < requestedAt - 5) return false;
      return true;
    });
  }
  function reconcileTrainReceipts(value, history) {
    const current = normalizeTrainReceipts(value);
    const receiptsByEmployeeId = { ...current.receiptsByEmployeeId };
    let changed = false;
    for (const [key, receipt] of Object.entries(receiptsByEmployeeId)) {
      if (!receiptConfirmedByHistory(receipt, history)) continue;
      delete receiptsByEmployeeId[key];
      changed = true;
    }
    return { state: { schemaVersion: 1, receiptsByEmployeeId }, changed };
  }
  function hasNewTrainingEvent2(history, beforeIds, employeeId = null) {
    return Object.entries(history?.eventsByNewsId || {}).some(([newsId, event]) => {
      if (beforeIds.has(newsId)) return false;
      return employeeId == null || Number(event?.employeeId) === Number(employeeId);
    });
  }
  function filterPendingReceiptsFromRotation(rotation, trainReceipts) {
    const receipts = normalizeTrainReceipts(trainReceipts);
    const pendingIds = new Set(Object.keys(receipts.receiptsByEmployeeId).map(Number));
    if (pendingIds.size === 0) return rotation;
    const orderedEligible = [];
    const skipped = [...rotation?.skipped || []];
    const reasonById = new Map(rotation?.reasonById || []);
    for (const employee of rotation?.orderedEligible || []) {
      const id = Number(employee?.id);
      if (!pendingIds.has(id)) {
        orderedEligible.push(employee);
        continue;
      }
      skipped.push(employee);
      reasonById.set(id, "pending_train_verification");
    }
    return {
      ...rotation,
      orderedEligible,
      skipped,
      nextEmployeeId: orderedEligible[0]?.id ?? null,
      reasonById
    };
  }
  var TrainingManagerController2 = class extends TrainingManagerController {
    constructor(options) {
      super(options);
      this._trainAttemptSequence = 0;
      this.state = {
        ...this.state,
        trainReceipts: { ...EMPTY_TRAIN_RECEIPTS, receiptsByEmployeeId: {} }
      };
    }
    _emit(patch = {}) {
      this.state = { ...this.state, ...patch };
      for (const listener of this.listeners || []) {
        try {
          listener(this.state);
        } catch {
        }
      }
    }
    _recompute(extra = {}) {
      const employees = extra.employees ?? this.state.employees;
      const history = extra.history ?? this.state.history;
      const settings = extra.settings ?? this.state.settings;
      const trainReceipts = extra.trainReceipts ?? this.state.trainReceipts ?? EMPTY_TRAIN_RECEIPTS;
      const eligibilityById = /* @__PURE__ */ new Map();
      if (settings) {
        for (const employee of employees) {
          eligibilityById.set(Number(employee.id), evaluateEligibility(employee, settings, this.nowSeconds()));
        }
      }
      const trainingById = summarizeTrainingHistory(history, employees);
      const ranked = settings ? rankTrainingCandidates({ employees, eligibilityById, trainingById, settings }) : emptyRotation2();
      const rotation = filterPendingReceiptsFromRotation(ranked, trainReceipts);
      this._emit({ employees, history, settings, trainReceipts, eligibilityById, trainingById, rotation, ...extra });
    }
    async _audit(type, phase, { employee = null, employeeId = null, employeeName: employeeName2 = null, details = {} } = {}) {
      if (typeof this.storage.appendAudit !== "function") return null;
      const resolvedId = Number.isInteger(Number(employee?.id)) ? Number(employee.id) : Number.isInteger(Number(employeeId)) ? Number(employeeId) : null;
      const resolvedName = employee?.name ?? employeeName2 ?? null;
      const entry = createAuditEntry({
        type,
        phase,
        employeeId: resolvedId,
        employeeName: resolvedName,
        details
      }, this.nowSeconds());
      try {
        const audit = await this.storage.appendAudit(entry);
        this._emit({ audit, auditError: null });
        return entry;
      } catch (error) {
        this._emit({ auditError: String(error?.message || "Audit storage failed") });
        return null;
      }
    }
    async _saveTrainReceipts(value) {
      const normalized = normalizeTrainReceipts(value);
      const saved = typeof this.storage.saveTrainReceipts === "function" ? await this.storage.saveTrainReceipts(normalized) : normalized;
      const finalState = normalizeTrainReceipts(saved);
      this._recompute({ trainReceipts: finalState });
      return finalState;
    }
    async _loadTrainReceipts(history = this.state.history) {
      const loaded = typeof this.storage.loadTrainReceipts === "function" ? await this.storage.loadTrainReceipts() : this.state.trainReceipts || EMPTY_TRAIN_RECEIPTS;
      const reconciled = reconcileTrainReceipts(loaded, history);
      if (reconciled.changed && typeof this.storage.saveTrainReceipts === "function") {
        await this.storage.saveTrainReceipts(reconciled.state);
      }
      this._recompute({ history, trainReceipts: reconciled.state });
      return reconciled.state;
    }
    _pendingReceipt(id, state = this.state.trainReceipts) {
      return state?.receiptsByEmployeeId?.[String(Number(id))] || null;
    }
    async _reserveTrainReceipt(employee, trainsBefore, historyNewestTimestampBefore) {
      const id = Number(employee.id);
      const current = await this._loadTrainReceipts(this.state.history);
      if (this._pendingReceipt(id, current)) {
        throw new Error("Previous train attempt is still pending verification; duplicate train blocked");
      }
      this._trainAttemptSequence += 1;
      const attemptId = `${this.nowSeconds()}-${id}-${this._trainAttemptSequence}`;
      const receipt = {
        employeeId: id,
        employeeName: employee.name,
        attemptId,
        requestedAt: this.nowSeconds(),
        acceptedAt: null,
        trainsBefore: Number(trainsBefore),
        historyNewestTimestampBefore: Number(historyNewestTimestampBefore) || 0,
        status: "submitting"
      };
      const next = normalizeTrainReceipts(current);
      next.receiptsByEmployeeId[String(id)] = receipt;
      await this._saveTrainReceipts(next);
      if (typeof this.storage.loadTrainReceipts === "function") {
        const verify = normalizeTrainReceipts(await this.storage.loadTrainReceipts());
        const winner = this._pendingReceipt(id, verify);
        if (winner?.attemptId !== attemptId) {
          this._recompute({ trainReceipts: verify });
          throw new Error("Another training action acquired this employee first; duplicate train blocked");
        }
      }
      return receipt;
    }
    async _updateTrainReceipt(receipt, patch = {}) {
      const current = await this._loadTrainReceipts(this.state.history);
      const existing = this._pendingReceipt(receipt.employeeId, current);
      if (!existing || existing.attemptId && receipt.attemptId && existing.attemptId !== receipt.attemptId) {
        throw new Error("Train receipt changed in another tab; refusing to overwrite it");
      }
      const next = normalizeTrainReceipts(current);
      const updated = { ...existing, ...clone4(patch), employeeId: Number(receipt.employeeId) };
      next.receiptsByEmployeeId[String(receipt.employeeId)] = updated;
      await this._saveTrainReceipts(next);
      return updated;
    }
    async _clearTrainReceipt(employeeId, attemptId = null) {
      const current = await this._loadTrainReceipts(this.state.history);
      const existing = this._pendingReceipt(employeeId, current);
      if (!existing) return current;
      if (attemptId && existing.attemptId && existing.attemptId !== attemptId) return current;
      const next = normalizeTrainReceipts(current);
      delete next.receiptsByEmployeeId[String(Number(employeeId))];
      return this._saveTrainReceipts(next);
    }
    async initialize() {
      await super.initialize();
      await this._loadTrainReceipts(this.state.history);
      return this.state;
    }
    async refresh() {
      await super.refresh();
      await this._loadTrainReceipts(this.state.history);
      return this.state;
    }
    async _readTrainingNews(history, { cacheBust = null } = {}) {
      const options = cacheBust == null ? {} : { cacheBust };
      const result = await this.api.getTrainingNewsSince(history?.newestTimestamp || 0, options);
      return {
        history: mergeTrainingNews(history, result?.news || []),
        complete: result?.complete !== false,
        reason: result?.reason || null
      };
    }
    async _preflightTrain(id) {
      const historyBefore = this.state.history;
      const beforeIds = new Set(Object.keys(historyBefore?.eventsByNewsId || {}));
      const trainsBefore = Number(this.state.trains);
      const snapshotEmployee = employeeMap2(this.state.employees).get(Number(id)) || null;
      await this._audit("train", "preflight_started", {
        employee: snapshotEmployee,
        employeeId: id,
        details: { trainsBefore, newestHistoryTimestamp: Number(historyBefore?.newestTimestamp) || 0 }
      });
      const [employees, profile, newsResult] = await Promise.all([
        this.api.getEmployees(),
        this.api.getProfile(),
        this.api.getTrainingNewsSince(historyBefore?.newestTimestamp || 0, { cacheBust: this.nowSeconds() })
      ]);
      const freshHistory = mergeTrainingNews(historyBefore, newsResult?.news || []);
      const freshTrains = Number.isFinite(Number(profile?.trains)) ? Number(profile.trains) : null;
      const lastUpdatedAt = this.nowSeconds();
      await this.storage.saveHistory(freshHistory);
      await this.storage.saveCache({ employees, trains: freshTrains, profile, lastUpdatedAt });
      await this._loadTrainReceipts(freshHistory);
      const freshEmployee = employeeMap2(employees).get(Number(id)) || null;
      const freshEligibility = freshEmployee && this.state.settings ? evaluateEligibility(freshEmployee, this.state.settings, this.nowSeconds()) : null;
      const newsChanged = hasNewTrainingEvent2(freshHistory, beforeIds);
      const trainsChanged = Number.isFinite(trainsBefore) && freshTrains !== trainsBefore;
      const missing = !freshEmployee;
      const ineligible = !freshEligibility?.eligible;
      this._recompute({
        employees,
        profile,
        trains: freshTrains,
        history: freshHistory,
        stale: false,
        lastUpdatedAt,
        status: newsResult?.complete === false ? "partial" : "ready",
        error: newsResult?.complete === false ? `Training news sync incomplete: ${newsResult.reason || "unknown"}` : null
      });
      if (newsChanged || trainsChanged || missing || ineligible || !Number.isFinite(freshTrains) || freshTrains <= 0) {
        const reason = "training_state_changed";
        const result = { status: "preflight_changed", reason };
        this._emit({ action: { type: "train", employeeId: id, status: "preflight_changed", reason } });
        await this._audit("train", "preflight_changed", {
          employee: freshEmployee || snapshotEmployee,
          employeeId: id,
          details: {
            reason,
            newsChanged,
            trainsChanged,
            trainsBefore,
            trainsNow: freshTrains,
            employeeMissing: missing,
            employeeEligible: Boolean(freshEligibility?.eligible)
          }
        });
        return { ok: false, result };
      }
      await this._audit("train", "preflight_ok", {
        employee: freshEmployee,
        details: { trainsBefore: freshTrains }
      });
      return {
        ok: true,
        employee: freshEmployee,
        eligibility: freshEligibility,
        beforeIds,
        trainsBefore: freshTrains,
        historyNewestTimestampBefore: Number(freshHistory?.newestTimestamp) || 0
      };
    }
    async trainEmployee(id) {
      id = Number(id);
      if (this.state.stale) throw new Error("Current company data is stale; refresh before making changes");
      if (this.actionLocks.has(id)) throw new Error("An action is already pending for this employee");
      const receipts = await this._loadTrainReceipts(this.state.history);
      if (this._pendingReceipt(id, receipts)) {
        await this._audit("train", "blocked_pending_receipt", { employeeId: id, details: { reason: "pending_train_receipt" } });
        throw new Error("Previous train attempt is still pending verification; duplicate train blocked");
      }
      const employee = employeeMap2(this.state.employees).get(id) || null;
      const eligibility = this.state.eligibilityById.get(id) || null;
      if (!employee) throw new Error("Employee not found");
      if (!eligibility?.eligible) throw new Error("Employee is not eligible for training");
      if (!Number.isFinite(Number(this.state.trains)) || Number(this.state.trains) <= 0) throw new Error("No company trains are available");
      this.actionLocks.add(id);
      let receipt = null;
      try {
        this._emit({ action: { type: "train", employeeId: id, status: "preflight" } });
        const preflight = await this._preflightTrain(id);
        if (!preflight.ok) return preflight.result;
        const latestReceipts = await this._loadTrainReceipts(this.state.history);
        if (this._pendingReceipt(id, latestReceipts)) {
          throw new Error("Another training action is pending for this employee; duplicate train blocked");
        }
        receipt = await this._reserveTrainReceipt(
          preflight.employee,
          preflight.trainsBefore,
          preflight.historyNewestTimestampBefore
        );
        await this._audit("train", "requested", {
          employee: preflight.employee,
          details: {
            trainsBefore: preflight.trainsBefore,
            attemptId: receipt.attemptId,
            eligibilityReasons: (preflight.eligibility?.reasons || []).map((reason) => reason.code)
          }
        });
        this._emit({ action: { type: "train", employeeId: id, status: "pending" } });
        const submitted = await this.pageActions.submitTrain(id);
        if (submitted?.status === "rejected") {
          const reason = submitted?.reason || "Torn rejected the training request";
          await this._clearTrainReceipt(id, receipt.attemptId);
          this._emit({ action: { type: "train", employeeId: id, status: "rejected", reason } });
          await this._audit("train", "rejected", { employee: preflight.employee, details: { reason, trainsBefore: preflight.trainsBefore } });
          return { status: "rejected", reason };
        }
        if (submitted?.status === "unsafe_dom") {
          const reason = submitted?.reason || "Training request was blocked before submission";
          await this._clearTrainReceipt(id, receipt.attemptId);
          this._emit({ action: { type: "train", employeeId: id, status: "failed", reason } });
          await this._audit("train", "failed_pre_submit", { employee: preflight.employee, details: { reason, trainsBefore: preflight.trainsBefore } });
          return { status: "failed", reason };
        }
        if (submitted?.status !== "accepted") {
          const reason = submitted?.reason || submitted?.status || "Training request outcome is unknown";
          receipt = await this._updateTrainReceipt(receipt, {
            status: "submission_unknown",
            lastError: reason
          });
          const warning = "Training request outcome is unknown. Duplicate retry is blocked until Company News or a manual refresh verifies what happened.";
          this._emit({ action: { type: "train", employeeId: id, status: "submission_unknown", reason: warning } });
          await this._audit("train", "submission_unknown", { employee: preflight.employee, details: { reason } });
          return { status: "submission_unknown", reason: warning };
        }
        receipt = await this._updateTrainReceipt(receipt, {
          status: "accepted_unverified",
          acceptedAt: this.nowSeconds(),
          httpStatus: submitted?.httpStatus || null
        });
        this._emit({ action: { type: "train", employeeId: id, status: "accepted" } });
        await this._audit("train", "accepted", { employee: preflight.employee, details: { trainsBefore: preflight.trainsBefore } });
        let check = await this._readTrainingNews(this.state.history);
        let workingHistory = check.history;
        if (hasNewTrainingEvent2(workingHistory, preflight.beforeIds, id)) {
          await this.storage.saveHistory(workingHistory);
          await this._clearTrainReceipt(id, receipt.attemptId);
          this._recompute({ history: workingHistory });
          await this.refresh();
          this._emit({ action: { type: "train", employeeId: id, status: "verified" } });
          await this._audit("train", "verified", { employee: preflight.employee, details: { trainsAfter: this.state.trains } });
          return { status: "verified" };
        }
        this._recompute({
          history: workingHistory,
          action: { type: "train", employeeId: id, status: "awaiting_verification", retryAfterSeconds: 31 }
        });
        await this._audit("train", "awaiting_verification", { employee: preflight.employee, details: { retryAfterSeconds: 31 } });
        await this.sleep(TRAIN_CACHE_WAIT_MS2);
        check = await this._readTrainingNews(workingHistory, { cacheBust: this.nowSeconds() });
        workingHistory = check.history;
        await this.storage.saveHistory(workingHistory);
        if (!hasNewTrainingEvent2(workingHistory, preflight.beforeIds, id)) {
          const reason = "Torn accepted the request, but Company News has not confirmed it yet. This employee stays locked across refreshes, reloads and tabs until verification succeeds.";
          receipt = await this._updateTrainReceipt(receipt, { status: "accepted_unverified" });
          this._recompute({
            history: workingHistory,
            trainReceipts: this.state.trainReceipts,
            action: { type: "train", employeeId: id, status: "accepted_unverified", reason }
          });
          await this._audit("train", "accepted_unverified", { employee: preflight.employee, details: { reason } });
          return { status: "accepted_unverified" };
        }
        await this._clearTrainReceipt(id, receipt.attemptId);
        this._recompute({ history: workingHistory });
        await this.refresh();
        this._emit({ action: { type: "train", employeeId: id, status: "verified" } });
        await this._audit("train", "verified", { employee: preflight.employee, details: { trainsAfter: this.state.trains } });
        return { status: "verified" };
      } catch (error) {
        const reason = String(error?.message || error);
        this._emit({ action: { type: "train", employeeId: id, status: "failed", reason } });
        await this._audit("train", "failed", { employee: employee || null, employeeId: id, details: { reason } });
        throw error;
      } finally {
        this.actionLocks.delete(id);
      }
    }
    getDiagnostics() {
      const diagnostics = super.getDiagnostics();
      const receipts = normalizeTrainReceipts(this.state.trainReceipts);
      diagnostics.controller.pendingManualTrainVerificationIds = Object.keys(receipts.receiptsByEmployeeId).map(Number);
      diagnostics.controller.pendingTrainReceiptCount = Object.keys(receipts.receiptsByEmployeeId).length;
      diagnostics.controller.pendingTrainReceiptStates = Object.values(receipts.receiptsByEmployeeId).map((receipt) => ({
        employeeId: receipt.employeeId,
        employeeName: receipt.employeeName || null,
        status: receipt.status || null,
        requestedAt: receipt.requestedAt || null,
        acceptedAt: receipt.acceptedAt || null
      }));
      return sanitizeAuditValue(diagnostics);
    }
  };

  // src/core/recommendation.js
  function getFrom2(mapLike, id) {
    if (mapLike instanceof Map) return mapLike.get(id) ?? mapLike.get(String(id));
    return mapLike?.[id] ?? mapLike?.[String(id)];
  }
  function numericId(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  function pendingReceipt(trainReceipts, id) {
    return trainReceipts?.receiptsByEmployeeId?.[id] ?? trainReceipts?.receiptsByEmployeeId?.[String(id)] ?? null;
  }
  function employeeById(employees) {
    const map = /* @__PURE__ */ new Map();
    for (const employee of employees || []) {
      const id = numericId(employee?.id);
      if (id) map.set(id, employee);
    }
    return map;
  }
  function fairnessLabel(score) {
    if (!Number.isFinite(score) || Math.abs(score) < 0.05) return "On balance";
    return score > 0 ? `Behind by ${score.toFixed(1)}` : `Ahead by ${Math.abs(score).toFixed(1)}`;
  }
  function buildTrainingRecommendation({
    employees = [],
    eligibilityById,
    trainingById,
    settings = {},
    paidState,
    overrideState,
    fairnessState,
    trainReceipts = { receiptsByEmployeeId: {} },
    nowSeconds = Math.floor(Date.now() / 1e3),
    verifiedTrainCount = null
  } = {}) {
    const byId2 = employeeById(employees);
    const paid = normalizePaidState(paidState);
    const ordered = [];
    const seen = /* @__PURE__ */ new Set();
    const skipped = [];
    const reasonById = /* @__PURE__ */ new Map();
    const sourceById = /* @__PURE__ */ new Map();
    const paidContractByEmployeeId = /* @__PURE__ */ new Map();
    const fairnessById = fairnessScores(fairnessState, {
      nowSeconds,
      windowDays: Number(settings.fairnessWindowDays) || 30,
      accrueDebtWhileIneligible: settings.accrueDebtWhileIneligible === true
    });
    const canRecommend = (id) => {
      const employee = byId2.get(id);
      if (!employee) return false;
      if (getFrom2(eligibilityById, id)?.eligible !== true) {
        reasonById.set(id, "ineligible");
        return false;
      }
      if (pendingReceipt(trainReceipts, id)) {
        reasonById.set(id, "pending_train_verification");
        return false;
      }
      if (isSkipped(overrideState, id, { nowSeconds, verifiedTrainCount })) {
        reasonById.set(id, "skipped");
        return false;
      }
      return true;
    };
    for (const employee of employees || []) {
      const id = numericId(employee?.id);
      if (!id) continue;
      if (!getFrom2(eligibilityById, id)?.eligible) reasonById.set(id, "ineligible");
      else if (pendingReceipt(trainReceipts, id)) reasonById.set(id, "pending_train_verification");
      else if (isSkipped(overrideState, id, { nowSeconds, verifiedTrainCount })) reasonById.set(id, "skipped");
    }
    for (const contractId of paid.queue) {
      const contract = paid.contractsById[contractId];
      if (!contract || contract.status !== "active") continue;
      const id = numericId(contract.employeeId);
      if (!id || !canRecommend(id) || seen.has(id)) continue;
      const employee = byId2.get(id);
      ordered.push(employee);
      seen.add(id);
      reasonById.set(id, "paid_priority");
      sourceById.set(id, "paid");
      paidContractByEmployeeId.set(id, contract);
    }
    const priorityId = numericId(overrideState?.priorityOnceEmployeeId);
    if (priorityId && !seen.has(priorityId) && canRecommend(priorityId)) {
      ordered.push(byId2.get(priorityId));
      seen.add(priorityId);
      reasonById.set(priorityId, "priority_once");
      sourceById.set(priorityId, "priority_once");
    }
    const remaining = (employees || []).filter((employee) => {
      const id = numericId(employee?.id);
      return id && !seen.has(id) && canRecommend(id);
    });
    if (settings.rotationMode === "balanced") {
      const fairFallback = rankTrainingCandidates({ employees: remaining, eligibilityById, trainingById, settings });
      const fallbackIndex = new Map(fairFallback.orderedEligible.map((employee, index) => [Number(employee.id), index]));
      remaining.sort((a, b) => {
        const aid = Number(a.id);
        const bid = Number(b.id);
        const scoreDiff = (fairnessById.get(bid) || 0) - (fairnessById.get(aid) || 0);
        if (Math.abs(scoreDiff) > 1e-12) return scoreDiff;
        return (fallbackIndex.get(aid) ?? Number.MAX_SAFE_INTEGER) - (fallbackIndex.get(bid) ?? Number.MAX_SAFE_INTEGER);
      });
      for (const employee of remaining) {
        const id = Number(employee.id);
        ordered.push(employee);
        seen.add(id);
        reasonById.set(id, "balanced_behind");
        sourceById.set(id, "balanced_fairness");
      }
    } else {
      const normal = rankTrainingCandidates({ employees: remaining, eligibilityById, trainingById, settings });
      for (const employee of normal.orderedEligible) {
        const id = Number(employee.id);
        ordered.push(employee);
        seen.add(id);
        reasonById.set(id, normal.reasonById.get(id) || "queued");
        sourceById.set(id, "fair_rotation");
      }
    }
    for (const employee of employees || []) {
      const id = numericId(employee?.id);
      if (!id || seen.has(id)) continue;
      skipped.push(employee);
    }
    return {
      ordered,
      nextEmployeeId: ordered[0]?.id ?? null,
      reasonById,
      sourceById,
      fairnessById,
      fairnessLabelById: new Map([...fairnessById.entries()].map(([id, score]) => [id, fairnessLabel(score)])),
      paidContractByEmployeeId,
      skipped,
      canManuallyTrain(employeeId) {
        const id = numericId(employeeId);
        return Boolean(id && byId2.has(id) && getFrom2(eligibilityById, id)?.eligible === true && !pendingReceipt(trainReceipts, id));
      }
    };
  }

  // src/app/controller.js
  var DEFAULT_RECEIPT_SETTLE_MS = 200;
  function defaultAttemptId() {
    try {
      if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
    } catch {
    }
    const randomPart = () => Math.random().toString(36).slice(2);
    return `${Date.now()}-${randomPart()}-${randomPart()}`;
  }
  function wagesMap2(employees) {
    return new Map((employees || []).filter((employee) => Number.isInteger(Number(employee?.id)) && Number.isInteger(employee?.wage)).map((employee) => [Number(employee.id), employee.wage]));
  }
  function clone5(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }
  function normalizeReceipts(value) {
    const out = { schemaVersion: 1, receiptsByEmployeeId: {} };
    const raw = value?.receiptsByEmployeeId && typeof value.receiptsByEmployeeId === "object" ? value.receiptsByEmployeeId : {};
    for (const [key, receipt] of Object.entries(raw)) {
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) continue;
      const id = Number(receipt.employeeId ?? key);
      if (!Number.isInteger(id) || id <= 0) continue;
      out.receiptsByEmployeeId[String(id)] = { ...clone5(receipt), employeeId: id };
    }
    return out;
  }
  function receiptConfirmedByHistory2(receipt, history) {
    const employeeId = Number(receipt?.employeeId);
    if (!Number.isInteger(employeeId)) return false;
    const historyFloor = Number(receipt?.historyNewestTimestampBefore) || 0;
    const requestedAt = Number(receipt?.requestedAt) || 0;
    return Object.values(history?.eventsByNewsId || {}).some((event) => {
      if (Number(event?.employeeId) !== employeeId) return false;
      const timestamp = Number(event?.timestamp) || 0;
      if (timestamp <= historyFloor) return false;
      if (requestedAt > 0 && timestamp < requestedAt - 5) return false;
      return true;
    });
  }
  function isLegacyPreSubmitRouteLock(receipt) {
    return receipt?.status === "submission_unknown" && receipt?.lastError === "not_company_management_page" && receipt?.acceptedAt == null;
  }
  function paidChanged(a, b) {
    return JSON.stringify(a) !== JSON.stringify(b);
  }
  function paidContractForEmployee(paid, employeeId) {
    const state = normalizePaidState(paid);
    const contractId = state.activeByEmployeeId[String(Number(employeeId))];
    return contractId ? state.contractsById[contractId] || null : null;
  }
  var TrainingManagerController3 = class extends TrainingManagerController2 {
    constructor(options = {}) {
      super(options);
      this._attemptIdFactory = typeof options.attemptIdFactory === "function" ? options.attemptIdFactory : defaultAttemptId;
      const settleMs = Number(options.receiptSettleMs);
      this._receiptSettleMs = Number.isFinite(settleMs) && settleMs >= 0 ? settleMs : DEFAULT_RECEIPT_SETTLE_MS;
      this._premiumLoaded = false;
      this._trainContextByEmployeeId = /* @__PURE__ */ new Map();
      this.state = {
        ...this.state,
        paid: emptyPaidState(),
        fairness: emptyFairnessState(this.nowSeconds()),
        overrides: emptyOverrideState(),
        recommendation: null
      };
    }
    _recompute(extra = {}) {
      super._recompute(extra);
      const paidInput = extra.paid ?? this.state.paid ?? emptyPaidState();
      const fairness = normalizeFairnessState(extra.fairness ?? this.state.fairness ?? emptyFairnessState(this.nowSeconds()));
      const overrides = expireOverrides(
        normalizeOverrideState(extra.overrides ?? this.state.overrides ?? emptyOverrideState()),
        {
          nowSeconds: this.nowSeconds(),
          verifiedTrainCount: Object.keys(this.state.history?.eventsByNewsId || {}).length
        }
      );
      const paid = syncPaidEligibility(paidInput, this.state.eligibilityById, this.nowSeconds());
      const recommendation = this.state.settings ? buildTrainingRecommendation({
        employees: this.state.employees,
        eligibilityById: this.state.eligibilityById,
        trainingById: this.state.trainingById,
        settings: this.state.settings,
        paidState: paid,
        overrideState: overrides,
        fairnessState: fairness,
        trainReceipts: this.state.trainReceipts,
        nowSeconds: this.nowSeconds(),
        verifiedTrainCount: Object.keys(this.state.history?.eventsByNewsId || {}).length
      }) : null;
      this._emit({ paid, fairness, overrides, recommendation });
    }
    async _loadPremiumDomains() {
      const [paid, fairness, overrides] = await Promise.all([
        typeof this.storage.loadPaidContracts === "function" ? this.storage.loadPaidContracts() : Promise.resolve(emptyPaidState()),
        typeof this.storage.loadFairness === "function" ? this.storage.loadFairness() : Promise.resolve(emptyFairnessState(this.nowSeconds())),
        typeof this.storage.loadOverrides === "function" ? this.storage.loadOverrides() : Promise.resolve(emptyOverrideState())
      ]);
      this._premiumLoaded = true;
      this._recompute({ paid, fairness, overrides });
      await this._persistDerivedPremiumState({ paidBefore: paid, overridesBefore: overrides });
    }
    async _persistDerivedPremiumState({ paidBefore = null, overridesBefore = null } = {}) {
      if (!this._premiumLoaded) return;
      if (typeof this.storage.savePaidContracts === "function" && (paidBefore == null || paidChanged(paidBefore, this.state.paid))) {
        const saved = await this.storage.savePaidContracts(this.state.paid);
        this.state.paid = normalizePaidState(saved);
      }
      if (typeof this.storage.saveOverrides === "function" && overridesBefore != null && JSON.stringify(overridesBefore) !== JSON.stringify(this.state.overrides)) {
        const saved = await this.storage.saveOverrides(this.state.overrides);
        this.state.overrides = normalizeOverrideState(saved);
      }
    }
    async initialize() {
      await super.initialize();
      await this._loadPremiumDomains();
      await this._loadTrainReceipts(this.state.history);
      return this.state;
    }
    async refresh() {
      const beforePaid = clone5(this.state.paid || emptyPaidState());
      const result = await super.refresh();
      if (this._premiumLoaded) await this._persistDerivedPremiumState({ paidBefore: beforePaid });
      return result;
    }
    async _accountVerifiedReceipt(receipt) {
      if (!this._premiumLoaded || !receipt) return;
      const employeeId = Number(receipt.employeeId);
      if (!Number.isInteger(employeeId)) return;
      let fairness = this.state.fairness;
      if (Array.isArray(receipt.fairnessEligibleEmployeeIds)) {
        fairness = recordFairnessTrain(fairness, {
          timestamp: this.nowSeconds(),
          eligibleEmployeeIds: receipt.fairnessEligibleEmployeeIds,
          allEmployeeIds: Array.isArray(receipt.fairnessAllEmployeeIds) ? receipt.fairnessAllEmployeeIds : receipt.fairnessEligibleEmployeeIds,
          trainedEmployeeId: employeeId
        });
        if (typeof this.storage.saveFairness === "function") fairness = await this.storage.saveFairness(fairness);
      }
      let paid = this.state.paid;
      const hadPaidContract = Boolean(paidContractForEmployee(paid, employeeId));
      const countsTowardPaid = receipt.countsTowardPaid === true;
      if (countsTowardPaid) {
        paid = recordVerifiedPaidTrain(paid, employeeId, { timestamp: this.nowSeconds(), countsTowardPaid: true });
        if (typeof this.storage.savePaidContracts === "function") paid = await this.storage.savePaidContracts(paid);
      }
      let overrides = this.state.overrides;
      if (Number(overrides?.priorityOnceEmployeeId) === employeeId) {
        overrides = clearPriorityOnce(overrides);
        if (typeof this.storage.saveOverrides === "function") overrides = await this.storage.saveOverrides(overrides);
        await this._audit("priority", "consumed", { employeeId, details: { reason: "verified_train" } });
      }
      this._recompute({ paid, fairness, overrides });
      if (countsTowardPaid && hadPaidContract) await this._audit("train", "verified_paid", { employeeId, details: { recommendationSource: receipt.recommendationSource || null } });
      else if (hadPaidContract) await this._audit("train", "verified_bonus", { employeeId, details: { recommendationSource: receipt.recommendationSource || null } });
    }
    async _loadTrainReceipts(history = this.state.history) {
      const loaded = typeof this.storage.loadTrainReceipts === "function" ? normalizeReceipts(await this.storage.loadTrainReceipts()) : normalizeReceipts(this.state.trainReceipts);
      const next = normalizeReceipts(loaded);
      let changed = false;
      for (const [key, receipt] of Object.entries(loaded.receiptsByEmployeeId)) {
        if (isLegacyPreSubmitRouteLock(receipt)) {
          delete next.receiptsByEmployeeId[key];
          changed = true;
          continue;
        }
        if (!this._premiumLoaded || !receiptConfirmedByHistory2(receipt, history)) continue;
        await this._accountVerifiedReceipt(receipt);
        delete next.receiptsByEmployeeId[key];
        changed = true;
      }
      if (changed && typeof this.storage.saveTrainReceipts === "function") await this.storage.saveTrainReceipts(next);
      this._recompute({ history, trainReceipts: next });
      return next;
    }
    async _clearTrainReceipt(employeeId, attemptId = null) {
      const id = Number(employeeId);
      const history = typeof this.storage.loadHistory === "function" ? await this.storage.loadHistory() : this.state.history;
      const current = typeof this.storage.loadTrainReceipts === "function" ? normalizeReceipts(await this.storage.loadTrainReceipts()) : normalizeReceipts(this.state.trainReceipts);
      const existing = current.receiptsByEmployeeId[String(id)] || null;
      if (!existing) {
        this._recompute({ history, trainReceipts: current });
        return current;
      }
      if (attemptId && existing.attemptId && existing.attemptId !== attemptId) return current;
      if (this._premiumLoaded && receiptConfirmedByHistory2(existing, history)) {
        await this._accountVerifiedReceipt(existing);
      }
      const next = normalizeReceipts(current);
      delete next.receiptsByEmployeeId[String(id)];
      if (typeof this.storage.saveTrainReceipts === "function") await this.storage.saveTrainReceipts(next);
      this._recompute({ history, trainReceipts: next });
      return next;
    }
    async trainEmployee(id, options = {}) {
      id = Number(id);
      const activePaid = paidContractForEmployee(this.state.paid, id);
      const countsTowardPaid = Object.prototype.hasOwnProperty.call(options, "countsTowardPaid") ? options.countsTowardPaid === true : Boolean(activePaid);
      const source = this.state.recommendation?.sourceById?.get?.(id) || (activePaid ? "paid" : "manual");
      const eligibleIds = [...(this.state.eligibilityById || /* @__PURE__ */ new Map()).entries()].filter(([, eligibility]) => eligibility?.eligible === true).map(([employeeId]) => Number(employeeId));
      const allEmployeeIds = (this.state.employees || []).map((employee) => Number(employee.id)).filter(Number.isInteger);
      this._trainContextByEmployeeId.set(id, {
        countsTowardPaid,
        recommendationSource: source,
        fairnessEligibleEmployeeIds: eligibleIds,
        fairnessAllEmployeeIds: allEmployeeIds
      });
      try {
        return await super.trainEmployee(id);
      } finally {
        this._trainContextByEmployeeId.delete(id);
      }
    }
    async _reserveTrainReceipt(employee, trainsBefore, historyNewestTimestampBefore) {
      const id = Number(employee?.id);
      if (!Number.isInteger(id)) throw new Error("Employee not found");
      const current = await this._loadTrainReceipts(this.state.history);
      if (this._pendingReceipt(id, current)) throw new Error("Previous train attempt is still pending verification; duplicate train blocked");
      const uniquePart = String(this._attemptIdFactory() || "").trim();
      if (!uniquePart) throw new Error("Could not create a unique training attempt identifier");
      const attemptId = `${this.nowSeconds()}-${id}-${uniquePart}`;
      const context = this._trainContextByEmployeeId.get(id) || {};
      const receipt = {
        employeeId: id,
        employeeName: employee.name,
        attemptId,
        requestedAt: this.nowSeconds(),
        acceptedAt: null,
        trainsBefore: Number(trainsBefore),
        historyNewestTimestampBefore: Number(historyNewestTimestampBefore) || 0,
        status: "submitting",
        recommendationSource: context.recommendationSource || "manual",
        countsTowardPaid: context.countsTowardPaid === true,
        fairnessEligibleEmployeeIds: Array.isArray(context.fairnessEligibleEmployeeIds) ? [...context.fairnessEligibleEmployeeIds] : [],
        fairnessAllEmployeeIds: Array.isArray(context.fairnessAllEmployeeIds) ? [...context.fairnessAllEmployeeIds] : []
      };
      const next = { schemaVersion: 1, receiptsByEmployeeId: { ...current?.receiptsByEmployeeId || {}, [String(id)]: receipt } };
      await this._saveTrainReceipts(next);
      if (this._receiptSettleMs > 0) await this.sleep(this._receiptSettleMs);
      const verify = await this._loadTrainReceipts(this.state.history);
      const winner = this._pendingReceipt(id, verify);
      if (winner?.attemptId !== attemptId) throw new Error("Another training action acquired this employee first; duplicate train blocked");
      return receipt;
    }
    async createPaidAgreement(input) {
      let paid = createPaidContract(this.state.paid, { ...input, createdAt: input?.createdAt ?? this.nowSeconds() });
      if (typeof this.storage.savePaidContracts === "function") paid = await this.storage.savePaidContracts(paid);
      this._recompute({ paid });
      await this._audit("paid_contract", "created", { employeeId: input?.employeeId, employeeName: input?.employeeName, details: { trainsPurchased: Number(input?.trainsPurchased) } });
      return paid;
    }
    async amendPaidAgreement(employeeId, patch) {
      let paid = amendPaidContract(this.state.paid, employeeId, patch, this.nowSeconds());
      if (typeof this.storage.savePaidContracts === "function") paid = await this.storage.savePaidContracts(paid);
      this._recompute({ paid });
      await this._audit("paid_contract", "amended", { employeeId, details: { addTrains: Number(patch?.addTrains) || 0 } });
      return paid;
    }
    async pausePaidAgreement(employeeId, options = {}) {
      let paid = pausePaidContract(this.state.paid, employeeId, { timestamp: this.nowSeconds(), reason: options.reason || "director" });
      if (typeof this.storage.savePaidContracts === "function") paid = await this.storage.savePaidContracts(paid);
      this._recompute({ paid });
      await this._audit("paid_contract", "paused", { employeeId, details: { reason: options.reason || "director" } });
      return paid;
    }
    async resumePaidAgreement(employeeId) {
      const eligibility = this.state.eligibilityById?.get?.(Number(employeeId));
      if (!eligibility?.eligible) throw new Error("Paid agreement cannot resume while the employee is ineligible");
      let paid = resumePaidContract(this.state.paid, employeeId, { timestamp: this.nowSeconds() });
      if (typeof this.storage.savePaidContracts === "function") paid = await this.storage.savePaidContracts(paid);
      this._recompute({ paid });
      await this._audit("paid_contract", "resumed", { employeeId });
      return paid;
    }
    async reorderPaidAgreements(contractIds) {
      let paid = reorderPaidQueue(this.state.paid, contractIds);
      if (typeof this.storage.savePaidContracts === "function") paid = await this.storage.savePaidContracts(paid);
      this._recompute({ paid });
      return paid;
    }
    async closePaidAgreement(employeeId, options) {
      let paid = closePaidContract(this.state.paid, employeeId, { ...options, timestamp: options?.timestamp ?? this.nowSeconds() });
      if (typeof this.storage.savePaidContracts === "function") paid = await this.storage.savePaidContracts(paid);
      this._recompute({ paid });
      await this._audit("paid_contract", options?.outcome || "closed", { employeeId, details: { reason: options?.reason || null } });
      return paid;
    }
    async setPriorityOnce(employeeId) {
      const eligibility = this.state.eligibilityById?.get?.(Number(employeeId));
      if (!eligibility?.eligible) throw new Error("Employee is not eligible for priority training");
      let overrides = setPriorityOnce(this.state.overrides, employeeId, this.nowSeconds());
      if (typeof this.storage.saveOverrides === "function") overrides = await this.storage.saveOverrides(overrides);
      this._recompute({ overrides });
      await this._audit("priority", "added", { employeeId });
      return overrides;
    }
    async clearPriorityOnce() {
      const employeeId = this.state.overrides?.priorityOnceEmployeeId ?? null;
      let overrides = clearPriorityOnce(this.state.overrides);
      if (typeof this.storage.saveOverrides === "function") overrides = await this.storage.saveOverrides(overrides);
      this._recompute({ overrides });
      await this._audit("priority", "cleared", { employeeId });
      return overrides;
    }
    async skipEmployee(employeeId, options) {
      const verifiedTrainCount = Object.keys(this.state.history?.eventsByNewsId || {}).length;
      let overrides = createSkip(this.state.overrides, employeeId, { ...options, createdAt: options?.createdAt ?? this.nowSeconds(), verifiedTrainCountAtCreate: options?.verifiedTrainCountAtCreate ?? verifiedTrainCount });
      if (typeof this.storage.saveOverrides === "function") overrides = await this.storage.saveOverrides(overrides);
      this._recompute({ overrides });
      await this._audit("skip", "created", { employeeId, details: { mode: options?.mode || null, until: options?.until || null } });
      return overrides;
    }
    async clearSkip(employeeId) {
      let overrides = clearSkip(this.state.overrides, employeeId);
      if (typeof this.storage.saveOverrides === "function") overrides = await this.storage.saveOverrides(overrides);
      this._recompute({ overrides });
      await this._audit("skip", "cleared", { employeeId });
      return overrides;
    }
    getDiagnostics() {
      const diagnostics = super.getDiagnostics();
      const actionId = Number(this.state.action?.employeeId);
      const targetId = Number.isInteger(actionId) && actionId > 0 ? actionId : this.state.recommendation?.nextEmployeeId ?? this.state.rotation?.nextEmployeeId ?? null;
      const payroll = this.pageActions.inspectPayrollEnvironment?.(wagesMap2(this.state.employees), targetId) || null;
      const page = diagnostics?.page && typeof diagnostics.page === "object" ? diagnostics.page : {};
      return {
        ...diagnostics,
        controller: {
          ...diagnostics.controller,
          recommendationNextEmployeeId: this.state.recommendation?.nextEmployeeId ?? null,
          paidAgreementCount: Object.keys(this.state.paid?.activeByEmployeeId || {}).length,
          fairnessTrackingStartedAt: this.state.fairness?.trackingStartedAt ?? null
        },
        page: { ...page, payroll }
      };
    }
  };

  // src/core/backup.js
  var BACKUP_SCHEMA = 1;
  var DOMAIN_METHODS = Object.freeze({
    settings: ["loadSettings", "saveSettings"],
    history: ["loadHistory", "saveHistory"],
    payroll: ["loadPayroll", "savePayroll"],
    managerUi: ["loadManagerUi", "saveManagerUi"],
    paidContracts: ["loadPaidContracts", "savePaidContracts"],
    fairness: ["loadFairness", "saveFairness"],
    overrides: ["loadOverrides", "saveOverrides"],
    audit: ["loadAudit", "saveAudit"]
  });
  var SECRET_KEY = /(api.?key|authorization|rfc|cookie|session|token|password|secret)/i;
  function clone6(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }
  function sanitize(value) {
    if (Array.isArray(value)) return value.map(sanitize);
    if (!value || typeof value !== "object") return value;
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) continue;
      out[key] = sanitize(child);
    }
    return out;
  }
  function validatePayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("Backup payload must be an object");
    if (Number(payload.schemaVersion) !== BACKUP_SCHEMA) throw new TypeError("Unsupported backup schema version");
    if (!payload.domains || typeof payload.domains !== "object" || Array.isArray(payload.domains)) throw new TypeError("Backup domains are missing");
    const domains = Object.keys(payload.domains);
    for (const domain of domains) {
      if (!DOMAIN_METHODS[domain]) throw new TypeError(`Unsupported backup domain: ${domain}`);
      const value = payload.domains[domain];
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`Invalid backup domain: ${domain}`);
      if (Number(value.schemaVersion) !== 1) throw new TypeError(`Unsupported ${domain} schema version`);
    }
    return domains;
  }
  async function exportNonSecretState(storage, { includeAudit = false, nowSeconds = Math.floor(Date.now() / 1e3) } = {}) {
    if (!storage) throw new TypeError("Storage is required");
    const domains = {};
    for (const [domain, [loadMethod]] of Object.entries(DOMAIN_METHODS)) {
      if (domain === "audit" && !includeAudit) continue;
      if (typeof storage[loadMethod] !== "function") continue;
      domains[domain] = sanitize(await storage[loadMethod]());
    }
    return { schemaVersion: BACKUP_SCHEMA, exportedAt: Number(nowSeconds) || 0, domains };
  }
  function previewImport(payload) {
    const domains = validatePayload(payload);
    return {
      schemaVersion: BACKUP_SCHEMA,
      exportedAt: Number(payload.exportedAt) || null,
      domains,
      counts: Object.fromEntries(domains.map((domain) => {
        const value = payload.domains[domain];
        if (Array.isArray(value?.entries)) return [domain, value.entries.length];
        if (value?.contractsById && typeof value.contractsById === "object") return [domain, Object.keys(value.contractsById).length];
        if (Array.isArray(value?.opportunities)) return [domain, value.opportunities.length];
        return [domain, 1];
      }))
    };
  }
  async function applyImport(storage, payload) {
    const preview = previewImport(payload);
    const backup = await exportNonSecretState(storage, { includeAudit: true });
    if (typeof storage.saveBackup === "function") await storage.saveBackup(backup);
    for (const domain of preview.domains) {
      const [, saveMethod] = DOMAIN_METHODS[domain];
      if (typeof storage[saveMethod] !== "function") throw new Error(`Storage cannot import ${domain}`);
      await storage[saveMethod](clone6(payload.domains[domain]));
    }
    return preview;
  }

  // src/core/notifications.js
  function employeeName(state, id) {
    return (state?.employees || []).find((employee) => Number(employee?.id) === Number(id))?.name || `Employee ${id}`;
  }
  function deriveAttentionItems(state = {}) {
    const items = [];
    if (state.stale) items.push({ id: "state-stale", severity: "critical", category: "safety", message: "Company data is stale. Training writes are blocked until refresh succeeds." });
    if (state.status === "error" || state.error) items.push({ id: "state-error", severity: "critical", category: "safety", message: "Training Manager has an API or refresh error." });
    for (const [key, receipt] of Object.entries(state?.trainReceipts?.receiptsByEmployeeId || {})) {
      const id = Number(receipt?.employeeId ?? key);
      items.push({
        id: `receipt-${id}`,
        severity: "critical",
        category: "verification",
        employeeId: id,
        message: `${employeeName(state, id)} has a training result still awaiting verification. Do not retry.`
      });
    }
    for (const contractId of state?.paid?.queue || []) {
      const contract = state?.paid?.contractsById?.[contractId];
      if (!contract) continue;
      if (contract.status === "auto-paused") {
        items.push({
          id: `paid-paused-${contract.employeeId}`,
          severity: "action",
          category: "paid",
          employeeId: Number(contract.employeeId),
          message: `${contract.employeeName || employeeName(state, contract.employeeId)} paid agreement is paused while the employee is ineligible.`
        });
      }
      if (contract.status === "active" && Number(contract.trainsRemaining) === 1) {
        items.push({
          id: `paid-near-complete-${contract.employeeId}`,
          severity: "info",
          category: "paid",
          employeeId: Number(contract.employeeId),
          message: `${contract.employeeName || employeeName(state, contract.employeeId)} has 1 paid train remaining.`
        });
      }
    }
    return items;
  }
  function filterAttentionItems(items = [], settings = {}) {
    const safe = Array.isArray(items) ? items.filter(Boolean) : [];
    const mode = settings.notificationMode || "important";
    if (mode === "everything") return safe;
    if (mode === "silent") return [];
    if (mode === "custom") {
      return safe.filter((item) => {
        if (item.severity === "critical") return settings.notifyCritical !== false;
        if (item.severity === "action") return settings.notifyAction === true;
        if (item.severity === "info") return settings.notifyInfo === true;
        return false;
      });
    }
    return safe.filter((item) => item.severity === "critical" || item.severity === "action");
  }

  // src/ui/dom.js
  function escapeHtml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }
  function formatMoney(value) {
    return Number.isFinite(Number(value)) ? `$${Math.trunc(Number(value)).toLocaleString("en-US")}` : "\u2014";
  }
  function formatDateTime(seconds) {
    if (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0) return "Never";
    try {
      return new Date(Number(seconds) * 1e3).toLocaleString();
    } catch {
      return "\u2014";
    }
  }
  function formatDuration(seconds) {
    if (!Number.isFinite(Number(seconds)) || Number(seconds) < 0) return "Unknown";
    const total = Math.floor(Number(seconds));
    const d = Math.floor(total / 86400);
    const h = Math.floor(total % 86400 / 3600);
    const m = Math.floor(total % 3600 / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }
  function byId(mapLike, id) {
    if (mapLike instanceof Map) return mapLike.get(Number(id));
    return mapLike?.[id] ?? mapLike?.[String(id)];
  }

  // src/ui/modals.js
  function makeBackdrop(documentRef, title, message) {
    const backdrop = documentRef.createElement("div");
    backdrop.className = "r4-tcm-modal-backdrop";
    backdrop.innerHTML = `<div class="r4-tcm-modal"><h3>${escapeHtml(title)}</h3><div>${message}</div><div class="r4-tcm-modal-actions"></div></div>`;
    documentRef.body.appendChild(backdrop);
    return backdrop;
  }
  function button(documentRef, text, className = "") {
    const btn = documentRef.createElement("button");
    btn.type = "button";
    btn.className = `r4-tcm-btn ${className}`.trim();
    btn.textContent = text;
    return btn;
  }
  function showConfirmModal({ title = "Confirm", message = "Are you sure?", confirmText = "Confirm", cancelText = "Cancel", danger = false, documentRef = globalThis.document } = {}) {
    if (!documentRef?.body) return Promise.resolve(false);
    return new Promise((resolve) => {
      const backdrop = makeBackdrop(documentRef, title, typeof message === "string" ? message : "");
      const actions = backdrop.querySelector(".r4-tcm-modal-actions");
      const cancel = button(documentRef, cancelText);
      const confirm = button(documentRef, confirmText, danger ? "r4-tcm-btn-danger" : "r4-tcm-btn-primary");
      const finish = (value) => {
        backdrop.remove();
        resolve(value);
      };
      cancel.addEventListener("click", () => finish(false));
      confirm.addEventListener("click", () => finish(true));
      backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop) finish(false);
      });
      actions.append(cancel, confirm);
    });
  }
  function showNumberPrompt({ title = "Enter amount", message = "", initialValue = "", min = 0, documentRef = globalThis.document } = {}) {
    if (!documentRef?.body) return Promise.resolve(null);
    return new Promise((resolve) => {
      const backdrop = makeBackdrop(documentRef, title, message);
      const modal = backdrop.querySelector(".r4-tcm-modal");
      const actions = backdrop.querySelector(".r4-tcm-modal-actions");
      const input = documentRef.createElement("input");
      input.type = "number";
      input.min = String(min);
      input.step = "1";
      input.value = String(initialValue ?? "");
      modal.insertBefore(input, actions);
      const cancel = button(documentRef, "Cancel");
      const confirm = button(documentRef, "Apply", "r4-tcm-btn-primary");
      const finish = (value) => {
        backdrop.remove();
        resolve(value);
      };
      cancel.addEventListener("click", () => finish(null));
      confirm.addEventListener("click", () => {
        const value = Number(input.value);
        if (!Number.isInteger(value) || value < min) {
          input.setCustomValidity(`Enter a whole number of at least ${min}.`);
          input.reportValidity();
          return;
        }
        finish(value);
      });
      actions.append(cancel, confirm);
      input.focus();
      input.select();
    });
  }

  // src/ui/company-manager.js
  function pendingTrainReceipt(state, id) {
    return state?.trainReceipts?.receiptsByEmployeeId?.[id] ?? state?.trainReceipts?.receiptsByEmployeeId?.[String(id)] ?? null;
  }
  function activeDock(payroll, id) {
    const record = payroll?.recordsByEmployeeId?.[id] ?? payroll?.recordsByEmployeeId?.[String(id)];
    return record && record.dockVerifiedAt && record.restoredAt == null ? record : null;
  }
  function actionBusy(state) {
    return ["preflight", "pending", "accepted", "awaiting_verification"].includes(state.action?.status);
  }
  function employeeById2(state, id) {
    return (state.employees || []).find((employee) => Number(employee.id) === Number(id)) || null;
  }
  function paidContract(state, id) {
    const contractId = state?.paid?.activeByEmployeeId?.[String(Number(id))];
    return contractId ? state?.paid?.contractsById?.[contractId] || null : null;
  }
  function recommendationSource(state, id) {
    return state?.recommendation?.sourceById?.get?.(Number(id)) || null;
  }
  function recommendationReason(state, id) {
    const source = recommendationSource(state, id);
    const paid = paidContract(state, id);
    if (source === "paid" && paid) return `Paid priority \xB7 ${paid.trainsRemaining} remaining`;
    if (source === "priority_once") return "Director priority \xB7 once";
    if (source === "balanced_fairness") return state?.recommendation?.fairnessLabelById?.get?.(Number(id)) || "Balanced fairness";
    const code = state?.recommendation?.reasonById?.get?.(Number(id));
    if (code === "never_trained") return "Never trained";
    if (code === "oldest_last_train") return "Oldest eligible train";
    return source === "fair_rotation" ? "Fair rotation" : "Eligible";
  }
  function statusLabel(state, employee, eligibility) {
    const id = Number(employee.id);
    const isNext = Number(state?.recommendation?.nextEmployeeId ?? state?.rotation?.nextEmployeeId) === id;
    const paid = paidContract(state, id);
    const pending = pendingTrainReceipt(state, id);
    if (pending) return `<span class="r4-tcm-chip r4-tcm-chip-warn">VERIFYING</span>`;
    if (isNext && paid) return `<span class="r4-tcm-chip r4-tcm-chip-paid">PAID \xB7 NEXT</span>`;
    if (isNext) return `<span class="r4-tcm-chip r4-tcm-chip-next">NEXT</span>`;
    if (paid?.status === "auto-paused" || paid?.status === "manually-paused") return `<span class="r4-tcm-chip r4-tcm-chip-warn">PAID \xB7 PAUSED</span>`;
    if (paid) return `<span class="r4-tcm-chip r4-tcm-chip-paid">PAID</span>`;
    if (Number(state?.overrides?.priorityOnceEmployeeId) === id) return `<span class="r4-tcm-chip r4-tcm-chip-priority">PRIORITY</span>`;
    if (eligibility?.eligible) return `<span class="r4-tcm-chip r4-tcm-chip-ok">ELIGIBLE</span>`;
    if (eligibility?.newHireHold) return `<span class="r4-tcm-chip r4-tcm-chip-neutral">NEW HIRE</span>`;
    if (eligibility?.unverified) return `<span class="r4-tcm-chip r4-tcm-chip-warn">UNVERIFIED</span>`;
    return `<span class="r4-tcm-chip r4-tcm-chip-bad">INELIGIBLE</span>`;
  }
  function ineligibleReason(eligibility, settings) {
    if (!eligibility) return "Eligibility unavailable";
    if (eligibility.newHireHold) {
      const remaining = Math.max(0, 72 * 3600 - Number(eligibility.tenureSeconds || 0));
      return `New hire \xB7 eligible in ${formatDuration(remaining)}`;
    }
    if (eligibility.unverified) return "Eligibility could not be verified";
    const reasons = [];
    if (eligibility.inactive) reasons.push(`Inactive ${formatDuration(eligibility.inactivitySeconds)}`);
    if (eligibility.addictionViolation) reasons.push(`Addiction ${eligibility.reasons?.find?.((r) => r.code === "addiction")?.actual ?? "?"} > ${settings?.maxAddiction ?? "?"}`);
    return reasons.join(" \xB7 ") || "Not eligible";
  }
  function actionFeedback(state) {
    const action = state?.action;
    if (action?.type !== "train") return "";
    const employee = employeeById2(state, action.employeeId);
    const name = employee?.name || `Employee ${action.employeeId ?? "?"}`;
    if (action.status === "preflight") return `<div class="r4-tcm-feedback r4-tcm-info">Checking fresh company state for <strong>${escapeHtml(name)}</strong>\u2026</div>`;
    if (action.status === "preflight_changed") return `<div class="r4-tcm-feedback r4-tcm-stale">Training state changed. Recommendation refreshed before a train was spent.</div>`;
    if (action.status === "pending") return `<div class="r4-tcm-feedback r4-tcm-info">Submitting train for <strong>${escapeHtml(name)}</strong>\u2026</div>`;
    if (action.status === "accepted" || action.status === "awaiting_verification") return `<div class="r4-tcm-feedback r4-tcm-info">Accepted \xB7 verifying <strong>${escapeHtml(name)}</strong>\u2026</div>`;
    if (action.status === "verified") return `<div class="r4-tcm-feedback r4-tcm-success">\u2713 Training verified for <strong>${escapeHtml(name)}</strong>.</div>`;
    if (action.status === "submission_unknown") return `<div class="r4-tcm-feedback r4-tcm-stale">Training outcome unknown. Do not retry; verification lock is active.</div>`;
    if (action.status === "accepted_unverified" || action.status === "unverified") return `<div class="r4-tcm-feedback r4-tcm-stale">Verification pending. Do not retry this employee until Company News confirms the train.</div>`;
    if (action.status === "rejected" || action.status === "failed") return `<div class="r4-tcm-feedback r4-tcm-error">${escapeHtml(action.reason || "Training action failed")}</div>`;
    return "";
  }
  function queuePreview(state) {
    const ordered = state?.recommendation?.ordered || state?.rotation?.orderedEligible || [];
    const items = ordered.slice(0, 4).map((employee, index) => `<li>
    <span class="r4-tcm-queue-rank">${index + 1}</span>
    <span class="r4-tcm-queue-name">${escapeHtml(employee.name)}</span>
    <span class="r4-tcm-queue-reason">${escapeHtml(recommendationReason(state, employee.id))}</span>
  </li>`).join("");
    return `<section class="r4-tcm-queue" data-premium-queue>
    <div class="r4-tcm-section-head"><span>NEXT IN QUEUE</span><button type="button" class="r4-tcm-link-btn" data-action="show-all">View all \u203A</button></div>
    <ol>${items || `<li class="r4-tcm-muted">No eligible employees</li>`}</ol>
  </section>`;
  }
  function rosterRows(state) {
    return (state.employees || []).map((employee) => {
      const id = Number(employee.id);
      const eligibility = byId(state.eligibilityById, id);
      const history = byId(state.trainingById, id) || { totalTrains: 0, lastTrainTimestamp: null };
      const dock = activeDock(state.payroll, id);
      const paid = paidContract(state, id);
      const pending = pendingTrainReceipt(state, id);
      const status = statusLabel(state, employee, eligibility);
      const detailReason = eligibility?.eligible ? recommendationReason(state, id) : ineligibleReason(eligibility, state.settings);
      const classes = [eligibility?.eligible ? "" : "r4-tcm-row-ineligible", pending ? "r4-tcm-row-pending" : "", Number(state?.recommendation?.nextEmployeeId) === id ? "r4-tcm-row-next" : ""].filter(Boolean).join(" ");
      let action = `<button type="button" class="r4-tcm-icon-btn" data-action="employee-menu" data-id="${id}" aria-label="Employee actions" title="Employee actions">\u22EE</button>`;
      if (!eligibility?.eligible && !eligibility?.unverified) action += `<button type="button" class="r4-tcm-hidden-action" data-action="dock" data-id="${id}">Dock Pay</button>`;
      return `<tr class="${classes}" data-eligible="${eligibility?.eligible ? "true" : "false"}" data-id="${id}">
      <td><button type="button" class="r4-tcm-row-toggle" data-action="toggle-details" data-id="${id}"><strong>${escapeHtml(employee.name)}</strong><span class="r4-tcm-muted">[${escapeHtml(id)}]</span></button></td>
      <td>${status}<span class="r4-tcm-row-reason">${escapeHtml(detailReason)}</span></td>
      <td>${history.totalTrains === 0 ? "Never" : escapeHtml(formatDateTime(history.lastTrainTimestamp))}</td>
      <td class="r4-tcm-row-actions">${action}</td>
    </tr>
    <tr class="r4-tcm-detail-row" data-employee-details="${id}" hidden><td colspan="4"><div class="r4-tcm-detail-grid">
      <span><b>Activity</b>${escapeHtml(employee.lastActionRelative || formatDuration(eligibility?.inactivitySeconds))}</span>
      <span><b>Addiction</b>${escapeHtml(employee.addictionMagnitude ?? "?")}</span>
      <span><b>Company time</b>${escapeHtml(formatDuration(eligibility?.tenureSeconds))}</span>
      <span><b>Total trains</b>${escapeHtml(history.totalTrains ?? 0)}</span>
      <span><b>Fairness</b>${escapeHtml(state?.recommendation?.fairnessLabelById?.get?.(id) || "\u2014")}</span>
      <span><b>Paid</b>${paid ? `${escapeHtml(paid.trainsRemaining)} remaining` : "None"}</span>
      <span><b>Pay</b>${escapeHtml(formatMoney(employee.wage))}${dock ? " \xB7 docked" : ""}</span>
    </div></td></tr>`;
    }).join("");
  }
  function primaryCard(state) {
    const nextId = state?.recommendation?.nextEmployeeId ?? state?.rotation?.nextEmployeeId ?? null;
    const employee = employeeById2(state, nextId);
    const paid = employee ? paidContract(state, employee.id) : null;
    const source = employee ? recommendationSource(state, employee.id) : null;
    const pending = employee ? pendingTrainReceipt(state, employee.id) : null;
    const disabled = state.stale || Number(state.trains) <= 0 || !employee || pending || actionBusy(state);
    const eyebrow = source === "paid" ? "PAID PRIORITY" : source === "priority_once" ? "DIRECTOR PRIORITY" : "NEXT TRAIN";
    const reason = employee ? recommendationReason(state, employee.id) : "No eligible employee";
    return `<section class="r4-tcm-primary-card">
    <span class="r4-tcm-eyebrow">${eyebrow}</span>
    <div class="r4-tcm-primary-name">${escapeHtml(employee?.name || "None")}</div>
    <div class="r4-tcm-primary-reason">${escapeHtml(reason)}</div>
    <button type="button" class="r4-tcm-train-primary" data-action="train-next" ${disabled ? "disabled" : ""}>${employee ? `TRAIN ${escapeHtml(employee.name).toUpperCase()}` : "NO TRAIN AVAILABLE"}</button>
    ${paid ? `<div class="r4-tcm-paid-progress">${escapeHtml(paid.trainsDelivered)} / ${escapeHtml(paid.trainsPurchased)} delivered \xB7 ${escapeHtml(paid.trainsRemaining)} remaining</div>` : ""}
    ${employee ? `<button type="button" class="r4-tcm-link-btn" data-action="why-next" data-id="${employee.id}">Why?</button>` : ""}
  </section>`;
  }
  function lockIconHtml(locked) {
    const shackle = locked ? `<path d="M10.5 14v-3.2a5.5 5.5 0 0 1 11 0V14"/>` : `<path d="M12.5 14v-3.2a5.5 5.5 0 0 1 10.7-1.8"/>`;
    return `<svg class="r4-tcm-lock-svg" data-lock-state="${locked ? "locked" : "unlocked"}" width="16" height="16" viewBox="0 0 32 32" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${shackle}<rect x="8" y="14" width="16" height="13" rx="2.6"/><path d="M16 19v3.5"/></svg>`;
  }
  function companyManagerHtml(state, _options = {}) {
    const eligibleCount = [...state.eligibilityById?.values?.() || []].filter((value) => value?.eligible).length;
    const attentionCount = Array.isArray(state.attention) ? state.attention.length : 0;
    const health = state.stale || state.status === "error" ? "bad" : Object.keys(state?.trainReceipts?.receiptsByEmployeeId || {}).length ? "warn" : Number(state.trains) > 0 ? "ok" : "idle";
    return `<section class="r4-tcm-manager r4-tcm-premium" data-tcm-state="${escapeHtml(state.status)}">
    <header class="r4-tcm-header" data-manager-drag-handle>
      <div class="r4-tcm-brand"><span class="r4-tcm-brand-mark">\u25C6</span><div><span>VOIDSMITH INDUSTRIES</span><strong>TRAINING MANAGER</strong></div></div>
      <div class="r4-tcm-header-right"><span class="r4-tcm-health r4-tcm-health-${health}" title="Training Manager health"></span>
        <button type="button" class="r4-tcm-window-btn r4-tcm-attention-btn" data-action="attention" aria-label="Attention" title="Attention">\u26A0${attentionCount ? `<span>${attentionCount}</span>` : ""}</button>
        <button type="button" class="r4-tcm-window-btn r4-tcm-lock-btn" data-window-action="lock" aria-label="Unlock position" title="Unlock position">${lockIconHtml(true)}</button>
        <button type="button" class="r4-tcm-window-btn" data-window-action="minimize" aria-label="Minimize" title="Minimize">\u2212</button>
        <button type="button" class="r4-tcm-window-btn" data-window-action="maximize" aria-label="Maximize" title="Maximize">\u25A1</button>
        <button type="button" class="r4-tcm-window-btn" data-action="settings" aria-label="Settings" title="Settings">\u2699</button>
      </div>
    </header>
    <div class="r4-tcm-manager-body">
      ${state.stale ? `<div class="r4-tcm-stale">Refresh required. Writes are disabled until company state is verified.</div>` : ""}
      ${state.error ? `<div class="r4-tcm-error">${escapeHtml(state.error)}</div>` : ""}
      ${actionFeedback(state)}
      <div class="r4-tcm-metrics">
        <div><strong>${escapeHtml(state.trains ?? "?")}</strong><span>TRAINS</span></div>
        <div><strong>${escapeHtml(employeeById2(state, state?.recommendation?.nextEmployeeId ?? state?.rotation?.nextEmployeeId)?.name || "None")}</strong><span>NEXT</span></div>
        <div><strong>${eligibleCount} / ${(state.employees || []).length}</strong><span>ELIGIBLE</span></div>
      </div>
      ${primaryCard(state)}
      ${queuePreview(state)}
      <section class="r4-tcm-roster"><div class="r4-tcm-section-head"><span>EMPLOYEES</span><div><button type="button" class="r4-tcm-link-btn" data-action="search">\u2315 Search</button><button type="button" class="r4-tcm-link-btn" data-action="filter">Filter</button></div></div>
        <div class="r4-tcm-table-wrap"><table class="r4-tcm-table"><thead><tr><th>Employee</th><th>Training status</th><th>Last train</th><th></th></tr></thead><tbody>${rosterRows(state) || `<tr><td colspan="4">No employees loaded.</td></tr>`}</tbody></table></div>
      </section>
    </div>
  </section>`;
  }
  async function runSafely(fn, actions) {
    try {
      await fn();
    } catch (error) {
      actions?.onError?.(error);
    }
  }
  async function confirmTrain(employee, state, actions, { forceBonus = false } = {}) {
    const contract = paidContract(state, employee.id);
    const paidText = contract ? `<br><strong>${escapeHtml(contract.trainsRemaining)}</strong> paid trains remaining.` : "";
    const ok = await showConfirmModal({ title: `Train ${employee.name}?`, message: `A fresh safety preflight will run before submission.${paidText}`, confirmText: "Confirm Train" });
    if (!ok) return;
    return runSafely(() => actions.trainEmployee?.(employee.id, { countsTowardPaid: contract ? !forceBonus : false }), actions);
  }
  function toggleEmployeeDetails(root, id) {
    const row = root.querySelector?.(`[data-employee-details="${id}"]`);
    if (row) row.hidden = !row.hidden;
  }
  function renderCompanyManager(root, state, actions = {}) {
    if (!root) return;
    root.innerHTML = companyManagerHtml(state);
    if (!root.querySelectorAll) return;
    for (const button2 of root.querySelectorAll("[data-action]")) {
      button2.addEventListener?.("click", async () => {
        const action = button2.dataset.action;
        const id = Number(button2.dataset.id);
        if (action === "refresh") return runSafely(() => actions.refresh?.(), actions);
        if (action === "settings") return actions.openSettings?.();
        if (action === "attention") return actions.openAttention?.();
        if (action === "toggle-details") return toggleEmployeeDetails(root, id);
        if (action === "why-next") return actions.showWhy?.(id, recommendationReason(state, id));
        if (action === "search") return actions.openSearch?.();
        if (action === "filter") return actions.openFilter?.();
        if (action === "show-all") return actions.showAll?.();
        if (action === "train-next") {
          const employee2 = employeeById2(state, state?.recommendation?.nextEmployeeId ?? state?.rotation?.nextEmployeeId);
          if (employee2) return confirmTrain(employee2, state, actions);
          return;
        }
        const employee = employeeById2(state, id);
        if (!employee) return;
        if (action === "employee-menu") return actions.openEmployeeMenu?.(employee, state);
        if (action === "train") return confirmTrain(employee, state, actions);
        if (action === "train-bonus") return confirmTrain(employee, state, actions, { forceBonus: true });
        if (action === "dock") {
          const amount = await showNumberPrompt({ title: `Dock pay for ${employee.name}`, message: `Current pay: <strong>${escapeHtml(formatMoney(employee.wage))}</strong><br>Enter the temporary daily pay.`, initialValue: employee.wage, min: 0 });
          if (amount === null) return;
          const ok = await showConfirmModal({ title: "Confirm pay dock", message: `Change ${escapeHtml(employee.name)} to <strong>${escapeHtml(formatMoney(amount))}</strong>?`, confirmText: "Apply Dock", danger: true });
          if (ok) return runSafely(() => actions.dockPay?.(id, amount), actions);
        }
        if (action === "restore") {
          const restoreState = actions.getRestoreStateFor?.(id) || { available: true, warning: null };
          if (!restoreState.available) return;
          const ok = await showConfirmModal({ title: `Restore ${employee.name}'s pay?`, message: `Restore to <strong>${escapeHtml(formatMoney(restoreState.restoreWage))}</strong>?`, confirmText: "Restore Pay" });
          if (ok) return runSafely(() => actions.restorePay?.(id, { confirmMismatch: restoreState.warning === "current_wage_changed" }), actions);
        }
      });
    }
  }
  var MANAGER_DEFAULTS = Object.freeze({ x: 16, y: 80, width: 760, height: 560 });
  var MANAGER_MIN_WIDTH = 420;
  var MANAGER_MIN_HEIGHT = 280;
  var MANAGER_VIEWPORT_MARGIN = 8;
  var MANAGER_DOCK_TOP = 16;
  function finiteOr(value, fallback) {
    if (value === null || value === void 0 || value === "") return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }
  function normalizedGeometry(value = {}, windowRef = globalThis.window, { topRightDefault = false } = {}) {
    const viewportWidth = Math.max(320, finiteOr(windowRef?.innerWidth, 1280));
    const viewportHeight = Math.max(220, finiteOr(windowRef?.innerHeight, 800));
    const maxWidth = Math.max(320, viewportWidth - MANAGER_VIEWPORT_MARGIN * 2);
    const maxHeight = Math.max(220, viewportHeight - MANAGER_VIEWPORT_MARGIN * 2);
    const minWidth = Math.min(MANAGER_MIN_WIDTH, maxWidth);
    const minHeight = Math.min(MANAGER_MIN_HEIGHT, maxHeight);
    const width = clamp(finiteOr(value.width, MANAGER_DEFAULTS.width), minWidth, maxWidth);
    const height = clamp(finiteOr(value.height, MANAGER_DEFAULTS.height), minHeight, maxHeight);
    const defaultX = topRightDefault ? viewportWidth - width - MANAGER_VIEWPORT_MARGIN : MANAGER_DEFAULTS.x;
    const defaultY = topRightDefault ? MANAGER_DOCK_TOP : MANAGER_DEFAULTS.y;
    const x = clamp(finiteOr(value.x, defaultX), MANAGER_VIEWPORT_MARGIN, Math.max(MANAGER_VIEWPORT_MARGIN, viewportWidth - width - MANAGER_VIEWPORT_MARGIN));
    const y = clamp(finiteOr(value.y, defaultY), MANAGER_VIEWPORT_MARGIN, Math.max(MANAGER_VIEWPORT_MARGIN, viewportHeight - height - MANAGER_VIEWPORT_MARGIN));
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  }
  async function attachManagerWindow({ root, uiStorage, windowRef = globalThis.window, ResizeObserverImpl = globalThis.ResizeObserver, onMinimizedChange = null } = {}) {
    if (!root) return { destroy() {
    }, toggleMinimize: async () => {
    }, toggleMaximize: async () => {
    }, toggleLock: async () => {
    }, sync() {
    }, isMinimized: () => false, isLocked: () => true };
    const loaded = await uiStorage?.loadManagerUi?.() || {};
    const hasExplicitLockState = Object.prototype.hasOwnProperty.call(loaded, "locked");
    let locked = hasExplicitLockState ? loaded.locked !== false : false;
    let geometry = normalizedGeometry(loaded, windowRef, { topRightDefault: locked });
    let minimized = Boolean(loaded.minimized);
    let maximized = Boolean(loaded.maximized);
    if (maximized) minimized = false;
    let dragging = null;
    let destroyed = false;
    const stateForStorage = () => ({ ...geometry, minimized, maximized, locked });
    const updateLockControl = () => {
      const button2 = root.querySelector?.('[data-window-action="lock"]');
      if (!button2) return;
      button2.innerHTML = lockIconHtml(locked);
      button2.title = locked ? "Unlock position" : "Lock position";
      button2.setAttribute?.("aria-label", locked ? "Unlock position" : "Lock position");
      button2.dataset.locked = locked ? "true" : "false";
    };
    const apply = () => {
      const viewportWidth = Math.max(320, finiteOr(windowRef?.innerWidth, 1280));
      const viewportHeight = Math.max(220, finiteOr(windowRef?.innerHeight, 800));
      root.classList?.add?.("r4-tcm-floating-shell");
      root.classList?.toggle?.("r4-tcm-minimized", minimized);
      root.classList?.toggle?.("r4-tcm-maximized", maximized);
      root.classList?.toggle?.("r4-tcm-locked", locked);
      root.dataset && (root.dataset.windowLocked = locked ? "true" : "false");
      root.style.position = "fixed";
      root.style.right = "auto";
      root.style.bottom = "auto";
      root.style.display = minimized ? "none" : "block";
      updateLockControl();
      if (minimized) {
        onMinimizedChange?.(true);
        return;
      }
      if (maximized) {
        root.style.left = `${MANAGER_VIEWPORT_MARGIN}px`;
        root.style.top = `${MANAGER_VIEWPORT_MARGIN}px`;
        root.style.width = `${Math.max(320, viewportWidth - MANAGER_VIEWPORT_MARGIN * 2)}px`;
        root.style.height = `${Math.max(220, viewportHeight - MANAGER_VIEWPORT_MARGIN * 2)}px`;
        root.style.resize = "none";
      } else {
        root.style.left = `${geometry.x}px`;
        root.style.top = `${geometry.y}px`;
        root.style.width = `${geometry.width}px`;
        root.style.height = `${geometry.height}px`;
        root.style.resize = "both";
      }
      onMinimizedChange?.(false);
    };
    const persist = async () => {
      if (!destroyed) await uiStorage?.saveManagerUi?.(stateForStorage());
    };
    const toggleMinimize = async () => {
      minimized = !minimized;
      if (minimized) maximized = false;
      apply();
      await persist();
    };
    const toggleMaximize = async () => {
      maximized = !maximized;
      if (maximized) minimized = false;
      apply();
      await persist();
    };
    const toggleLock = async () => {
      locked = !locked;
      dragging = null;
      apply();
      await persist();
    };
    const restore = async () => {
      if (!minimized) return;
      minimized = false;
      apply();
      await persist();
    };
    const onClick = (event) => {
      const control = event?.target?.closest?.("[data-window-action]");
      if (!control) return;
      event.preventDefault?.();
      event.stopPropagation?.();
      if (control.dataset?.windowAction === "lock") void toggleLock();
      if (control.dataset?.windowAction === "minimize") void toggleMinimize();
      if (control.dataset?.windowAction === "maximize") void toggleMaximize();
    };
    const onPointerDown = (event) => {
      if (locked || maximized || minimized || !event?.target?.closest?.(".r4-tcm-header") || event.target.closest?.("button,a,input,select,textarea")) return;
      const rect = root.getBoundingClientRect?.();
      if (!rect) return;
      dragging = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      root.setPointerCapture?.(event.pointerId);
      event.preventDefault?.();
    };
    const onPointerMove = (event) => {
      if (!dragging) return;
      geometry = normalizedGeometry({ x: event.clientX - dragging.dx, y: event.clientY - dragging.dy, width: geometry.width, height: geometry.height }, windowRef);
      apply();
    };
    const onPointerUp = (event) => {
      if (!dragging) return;
      dragging = null;
      root.releasePointerCapture?.(event?.pointerId);
      void persist();
    };
    const onViewportResize = () => {
      geometry = normalizedGeometry(geometry, windowRef);
      apply();
      void persist();
    };
    apply();
    root.addEventListener?.("click", onClick);
    root.addEventListener?.("pointerdown", onPointerDown);
    root.addEventListener?.("pointermove", onPointerMove);
    root.addEventListener?.("pointerup", onPointerUp);
    root.addEventListener?.("pointercancel", onPointerUp);
    windowRef?.addEventListener?.("resize", onViewportResize);
    const resizeObserver = ResizeObserverImpl ? new ResizeObserverImpl(() => {
      if (dragging || destroyed || minimized || maximized) return;
      const rect = root.getBoundingClientRect?.();
      if (!rect) return;
      geometry = normalizedGeometry({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }, windowRef);
      void persist();
    }) : null;
    resizeObserver?.observe?.(root);
    return {
      toggleMinimize,
      toggleMaximize,
      toggleLock,
      restore,
      isMinimized: () => minimized,
      isLocked: () => locked,
      sync: apply,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        resizeObserver?.disconnect?.();
        root.removeEventListener?.("click", onClick);
        root.removeEventListener?.("pointerdown", onPointerDown);
        root.removeEventListener?.("pointermove", onPointerMove);
        root.removeEventListener?.("pointerup", onPointerUp);
        root.removeEventListener?.("pointercancel", onPointerUp);
        windowRef?.removeEventListener?.("resize", onViewportResize);
      }
    };
  }

  // src/ui/manager-dock.js
  function isActuallyVisible(el, windowRef) {
    if (!el) return false;
    try {
      const rect = el.getBoundingClientRect?.();
      const style = windowRef?.getComputedStyle?.(el);
      const hasSize = !rect || Number(rect.width) > 0 && Number(rect.height) > 0;
      return hasSize && (!style || style.display !== "none") && (!style || style.visibility !== "hidden") && (!style || style.opacity !== "0");
    } catch {
      return false;
    }
  }
  function findStatusIconsBar(documentRef, windowRef = globalThis.window) {
    const selectors = [
      'ul[class*="status-icons"]',
      'ul[class*="statusIcons"]',
      'div[class*="status-icons"] ul',
      'div[class*="statusIcons"] ul',
      "header ul",
      '[class*="header"] ul',
      '[class*="top"] ul'
    ];
    for (const selector of selectors) {
      const candidate = documentRef?.querySelector?.(selector);
      if (isActuallyVisible(candidate, windowRef)) return candidate;
    }
    return null;
  }
  function nextEmployeeName(state) {
    const id = Number(state?.recommendation?.nextEmployeeId ?? state?.rotation?.nextEmployeeId);
    if (!Number.isFinite(id)) return null;
    return (state?.employees || []).find((employee) => Number(employee?.id) === id)?.name || null;
  }
  function dockTone(state) {
    if (state?.stale || state?.status === "error" || state?.error) return "error";
    if (["awaiting_verification", "accepted_unverified", "submission_unknown"].includes(state?.action?.status)) return "warning";
    if ((state?.attention || []).some?.((item) => item?.severity === "critical")) return "error";
    if ((state?.attention || []).some?.((item) => item?.severity === "action")) return "warning";
    if (Number(state?.trains) > 0) return "ready";
    return "idle";
  }
  function dockTitle(state, isManagerOpen) {
    const trains = Number.isFinite(Number(state?.trains)) ? Number(state.trains) : "?";
    const next = nextEmployeeName(state);
    const action = isManagerOpen ? "Minimize" : "Open";
    return `${action} Company Training Manager \xB7 ${trains} train${trains === 1 ? "" : "s"}${next ? ` \xB7 Next: ${next}` : ""}`;
  }
  var VOIDSMITH_TRAINING_GLYPH = `<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path class="r4-tcm-dock-frame" d="M16 2.8 27.7 9.5v13L16 29.2 4.3 22.5v-13Z"/><path class="r4-tcm-dock-v" d="m9.1 10.2 6.9 12.1 6.9-12.1-3.5 1.9-3.4 5.9-3.4-5.9Z"/><path class="r4-tcm-dock-bar" d="M10.3 8.2h11.4v2.4H10.3z"/></svg>`;
  var MANAGER_DOCK_STYLES = `
.r4-tcm-dock-icon{position:relative!important;width:32px!important;height:32px!important;min-width:32px!important;display:flex!important;align-items:center!important;justify-content:center!important;cursor:pointer!important;user-select:none!important;list-style:none!important;border:1px solid #4a4a53!important;border-radius:9px!important;margin:0 3px!important;background:linear-gradient(145deg,#1b1b20,#0b0b0e)!important;box-shadow:inset 0 1px 0 #ffffff0d,0 4px 12px #0008!important;transition:transform .15s ease,background .15s ease,border-color .15s ease,box-shadow .15s ease!important}
.r4-tcm-dock-icon:hover{transform:translateY(-1px)!important;background:linear-gradient(145deg,#24242a,#111116)!important;border-color:#7a3331!important;box-shadow:inset 0 1px 0 #ffffff12,0 5px 16px #000a,0 0 12px #c3474326!important}
.r4-tcm-dock-glyph{width:22px!important;height:22px!important;display:flex!important;align-items:center!important;justify-content:center!important;pointer-events:none!important}.r4-tcm-dock-glyph svg{width:22px!important;height:22px!important;display:block!important}.r4-tcm-dock-frame{fill:#111116;stroke:#777782;stroke-width:1.2}.r4-tcm-dock-v{fill:#d6d6dc}.r4-tcm-dock-bar{fill:#c34743;filter:drop-shadow(0 0 2px #c3474388)}
.r4-tcm-dock-dot{position:absolute!important;right:0!important;bottom:0!important;width:8px!important;height:8px!important;border-radius:50%!important;background:#888!important;border:2px solid #101014!important}
.r4-tcm-dock-icon[data-tone="ready"] .r4-tcm-dock-dot,.r4-tcm-dock-fallback[data-tone="ready"] .r4-tcm-dock-dot{background:#63d467!important;box-shadow:0 0 6px #63d46799!important}
.r4-tcm-dock-icon[data-tone="warning"] .r4-tcm-dock-dot,.r4-tcm-dock-fallback[data-tone="warning"] .r4-tcm-dock-dot{background:#e2b84d!important;box-shadow:0 0 6px #e2b84d77!important}
.r4-tcm-dock-icon[data-tone="error"] .r4-tcm-dock-dot,.r4-tcm-dock-fallback[data-tone="error"] .r4-tcm-dock-dot{background:#ef6262!important;box-shadow:0 0 6px #ef626288!important}
.r4-tcm-dock-fallback{position:fixed!important;right:10px!important;top:120px!important;z-index:1000000!important}.r4-tcm-dock-fallback button{position:relative!important;width:40px!important;height:40px!important;padding:0!important;display:flex!important;align-items:center!important;justify-content:center!important;border:1px solid #51515b!important;border-radius:10px!important;background:linear-gradient(145deg,#1b1b20,#0b0b0e)!important;color:#fff!important;cursor:pointer!important;box-shadow:inset 0 1px 0 #ffffff0d,0 8px 24px #000b!important}.r4-tcm-dock-fallback button:hover{border-color:#7a3331!important;box-shadow:inset 0 1px 0 #ffffff12,0 8px 24px #000c,0 0 16px #c3474329!important}.r4-tcm-dock-fallback .r4-tcm-dock-glyph,.r4-tcm-dock-fallback .r4-tcm-dock-glyph svg{width:26px!important;height:26px!important}
.r4-tcm-floating-shell.r4-tcm-minimized{display:none!important}
`;
  function ensureDockStyles(documentRef) {
    if (!documentRef?.head || documentRef.getElementById?.("r4-tcm-dock-styles")) return;
    const style = documentRef.createElement("style");
    style.setAttribute?.("id", "r4-tcm-dock-styles");
    style.textContent = MANAGER_DOCK_STYLES;
    documentRef.head.appendChild(style);
  }
  function buildGlyph(documentRef) {
    const glyph = documentRef.createElement("span");
    glyph.classList.add("r4-tcm-dock-glyph");
    glyph.innerHTML = VOIDSMITH_TRAINING_GLYPH;
    return glyph;
  }
  function buildStatusDot(documentRef) {
    const dot = documentRef.createElement("span");
    dot.classList.add("r4-tcm-dock-dot");
    return dot;
  }
  function buildDockIcon(documentRef, onToggle) {
    const li = documentRef.createElement("li");
    li.classList.add("r4-tcm-dock-icon");
    li.setAttribute?.("role", "button");
    li.setAttribute?.("tabindex", "0");
    li.setAttribute?.("aria-label", "Company Training Manager");
    li.appendChild(buildGlyph(documentRef));
    li.appendChild(buildStatusDot(documentRef));
    const activate = (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      onToggle?.();
    };
    li.addEventListener?.("click", activate);
    li.addEventListener?.("keydown", (event) => {
      if (event?.key === "Enter" || event?.key === " ") activate(event);
    });
    return li;
  }
  function buildFallback(documentRef, onToggle) {
    const wrap = documentRef.createElement("div");
    wrap.setAttribute?.("id", "r4-tcm-dock-fallback");
    wrap.classList.add("r4-tcm-dock-fallback");
    const button2 = documentRef.createElement("button");
    button2.setAttribute?.("type", "button");
    button2.setAttribute?.("aria-label", "Company Training Manager");
    button2.appendChild(buildGlyph(documentRef));
    button2.appendChild(buildStatusDot(documentRef));
    button2.addEventListener?.("click", (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      onToggle?.();
    });
    wrap.appendChild(button2);
    documentRef.body?.appendChild?.(wrap);
    return wrap;
  }
  function managerRoot(documentRef) {
    return documentRef?.getElementById?.("r4-tcm-company-root") || null;
  }
  function managerIsOpen(documentRef) {
    const root = managerRoot(documentRef);
    if (!root) return false;
    return !root.classList?.contains?.("r4-tcm-minimized") && root.style?.display !== "none";
  }
  function defaultToggleManager({ documentRef, windowRef, managerUrl }) {
    const root = managerRoot(documentRef);
    const minimizeButton = root?.querySelector?.('[data-window-action="minimize"]');
    if (minimizeButton?.click) {
      minimizeButton.click();
      return true;
    }
    try {
      if (managerUrl) windowRef.location.href = managerUrl;
    } catch {
    }
    return false;
  }
  function mountManagerDock({
    documentRef = globalThis.document,
    windowRef = globalThis.window,
    state = {},
    isManagerOpen = null,
    managerUrl = "https://www.torn.com/companies.php?step=your#employees",
    onToggle = null,
    MutationObserverImpl = globalThis.MutationObserver
  } = {}) {
    if (!documentRef?.createElement || !documentRef?.body) return { update() {
    }, ensure() {
    }, destroy() {
    } };
    ensureDockStyles(documentRef);
    let currentState = state || {};
    let currentOpen = typeof isManagerOpen === "boolean" ? isManagerOpen : managerIsOpen(documentRef);
    let destroyed = false;
    let icon = null;
    const updatePresentation = () => {
      const tone = dockTone(currentState);
      const title = dockTitle(currentState, currentOpen);
      for (const element of [icon, fallback]) {
        if (!element) continue;
        element.title = title;
        element.dataset.tone = tone;
        element.dataset.managerOpen = currentOpen ? "true" : "false";
      }
      const button2 = fallback?.querySelector?.("button");
      if (button2) {
        button2.title = title;
        button2.dataset.tone = tone;
      }
    };
    const toggle = async () => {
      if (typeof onToggle === "function") await onToggle();
      else defaultToggleManager({ documentRef, windowRef, managerUrl });
      currentOpen = managerIsOpen(documentRef);
      updatePresentation();
    };
    let fallback = documentRef.getElementById?.("r4-tcm-dock-fallback") || buildFallback(documentRef, toggle);
    const ensure = () => {
      if (destroyed) return;
      if (typeof isManagerOpen !== "boolean") currentOpen = managerIsOpen(documentRef);
      const bar = findStatusIconsBar(documentRef, windowRef);
      const existing = documentRef.querySelector?.(".r4-tcm-dock-icon");
      if (bar) {
        fallback.style.display = "none";
        if (existing && existing.parentElement === bar) {
          icon = existing;
        } else {
          existing?.remove?.();
          icon = buildDockIcon(documentRef, toggle);
          try {
            bar.prepend(icon);
          } catch {
            bar.appendChild?.(icon);
          }
        }
      } else {
        existing?.remove?.();
        icon = null;
        fallback.style.display = "block";
      }
      updatePresentation();
    };
    const onDocumentClick = (event) => {
      if (!event?.target?.closest?.('[data-window-action="minimize"]')) return;
      Promise.resolve().then(() => {
        currentOpen = managerIsOpen(documentRef);
        updatePresentation();
      });
    };
    ensure();
    documentRef.addEventListener?.("click", onDocumentClick, true);
    const observer = MutationObserverImpl ? new MutationObserverImpl(() => ensure()) : null;
    observer?.observe?.(documentRef.documentElement || documentRef.body, { childList: true, subtree: true });
    return {
      update(nextState, { managerOpen } = {}) {
        currentState = nextState || {};
        currentOpen = typeof managerOpen === "boolean" ? managerOpen : managerIsOpen(documentRef);
        ensure();
      },
      ensure,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        observer?.disconnect?.();
        documentRef.removeEventListener?.("click", onDocumentClick, true);
        icon?.remove?.();
        fallback?.remove?.();
        documentRef.getElementById?.("r4-tcm-dock-styles")?.remove?.();
        icon = null;
        fallback = null;
      }
    };
  }

  // src/ui/paid-settings.js
  function activeContracts(state = {}) {
    const paid = state.paid || {};
    const contracts = paid.contractsById || {};
    return (paid.queue || []).map((id) => contracts[id]).filter(Boolean);
  }
  function paidSettingsHtml(state = {}) {
    const contracts = activeContracts(state);
    const rows = contracts.map((contract, index) => `<div class="r4-tcm-paid-setting-row" data-paid-contract="${escapeHtml(contract.id)}">
    <div class="r4-tcm-paid-setting-main">
      <strong>${escapeHtml(contract.employeeName || `Employee ${contract.employeeId}`)}</strong>
      <span>${escapeHtml(contract.trainsDelivered)} / ${escapeHtml(contract.trainsPurchased)} delivered \xB7 ${escapeHtml(contract.trainsRemaining)} remaining</span>
      <small>${escapeHtml(contract.status)} \xB7 started ${escapeHtml(formatDateTime(contract.startedAt || contract.createdAt))}</small>
    </div>
    <div class="r4-tcm-paid-setting-actions">
      <button type="button" class="r4-tcm-btn" data-paid-action="up" data-id="${escapeHtml(contract.employeeId)}" ${index === 0 ? "disabled" : ""}>\u2191</button>
      <button type="button" class="r4-tcm-btn" data-paid-action="down" data-id="${escapeHtml(contract.employeeId)}" ${index === contracts.length - 1 ? "disabled" : ""}>\u2193</button>
      <button type="button" class="r4-tcm-btn" data-paid-action="amend" data-id="${escapeHtml(contract.employeeId)}">Add Trains</button>
      ${contract.status === "manually-paused" ? `<button type="button" class="r4-tcm-btn" data-paid-action="resume" data-id="${escapeHtml(contract.employeeId)}">Resume</button>` : `<button type="button" class="r4-tcm-btn" data-paid-action="pause" data-id="${escapeHtml(contract.employeeId)}">Pause</button>`}
      <button type="button" class="r4-tcm-btn r4-tcm-btn-warn" data-paid-action="close" data-id="${escapeHtml(contract.employeeId)}">Close</button>
    </div>
  </div>`).join("");
    return `<div class="r4-tcm-settings-stack">
    <div class="r4-tcm-settings-help">Paid agreements stay above the normal training queue while eligible. Balances move only after verified trains.</div>
    <button type="button" class="r4-tcm-btn r4-tcm-btn-primary" data-paid-action="create">Create Paid Agreement</button>
    <div class="r4-tcm-paid-settings-list">${rows || `<div class="r4-tcm-muted">No active paid agreements.</div>`}</div>
  </div>`;
  }

  // src/ui/data-recovery.js
  function dataRecoveryHtml() {
    return `<div class="r4-tcm-settings-stack">
    <p class="r4-tcm-settings-help">Back up or move Training Manager state without exporting your Torn API key.</p>
    <button type="button" class="r4-tcm-btn" data-settings-action="export-data">Export Training Manager Data</button>
    <button type="button" class="r4-tcm-btn" data-settings-action="import-data">Import Training Manager Data</button>
    <button type="button" class="r4-tcm-btn" data-settings-action="rebuild">Rebuild Training History</button>
    <button type="button" class="r4-tcm-btn r4-tcm-btn-danger" data-settings-action="reset">Reset Local Data</button>
  </div>`;
  }
  function backupDownloadName(timestamp = Date.now()) {
    const date = new Date(Number(timestamp));
    if (Number.isNaN(date.getTime())) throw new TypeError("Backup timestamp is invalid");
    return `voidsmith-training-manager-backup-${date.toISOString().slice(0, 10)}.json`;
  }
  function parseImportText(text) {
    let value;
    try {
      value = JSON.parse(String(text ?? ""));
    } catch {
      throw new TypeError("Import must be valid JSON");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Import must be a JSON object");
    if (Number(value.schemaVersion) !== 1) throw new TypeError("Unsupported backup schema version");
    if (!value.domains || typeof value.domains !== "object" || Array.isArray(value.domains)) throw new TypeError("Backup domains are missing");
    return value;
  }
  function importPreviewHtml(preview = {}) {
    const domains = Array.isArray(preview.domains) ? preview.domains : [];
    const rows = domains.map((domain) => `<li><strong>${escapeHtml(domain)}</strong>${preview.counts?.[domain] != null ? ` \xB7 ${escapeHtml(preview.counts[domain])}` : ""}</li>`).join("");
    return `<div class="r4-tcm-import-preview"><p>This import will replace the validated local domains below. A backup of current non-secret state is created first.</p><ul>${rows}</ul></div>`;
  }

  // src/ui/settings.js
  var ROTATION_MODES = /* @__PURE__ */ new Set(["fair", "balanced"]);
  var NOTIFICATION_MODES = /* @__PURE__ */ new Set(["important", "everything", "silent", "custom"]);
  var SECTION_IDS = ["general", "training", "paid", "fairness", "notifications", "appearance", "recovery", "advanced"];
  var SECTION_LABELS = Object.freeze({
    general: "General",
    training: "Training Rules",
    paid: "Paid Trains",
    fairness: "Fairness",
    notifications: "Notifications",
    appearance: "Appearance",
    recovery: "Data & Recovery",
    advanced: "Advanced"
  });
  function checked(value) {
    return value ? "checked" : "";
  }
  function selected(value, expected) {
    return value === expected ? "selected" : "";
  }
  function sectionNav(activeSection) {
    return `<nav class="r4-tcm-settings-nav" aria-label="Training Manager settings">${SECTION_IDS.map((id) => `<button type="button" class="r4-tcm-settings-tab ${activeSection === id ? "is-active" : ""}" data-settings-section="${id}" aria-expanded="${activeSection === id ? "true" : "false"}">${SECTION_LABELS[id]}</button>`).join("")}</nav>`;
  }
  function generalHtml(settings, hasApiKey) {
    return `<div class="r4-tcm-settings-stack">
    <label>Torn API key<input name="apiKey" type="password" autocomplete="off" value="" placeholder="${hasApiKey ? "Key saved \xB7 leave blank to keep it" : "Enter director-capable API key"}"></label>
    <span class="r4-tcm-muted">Stored only in userscript-manager storage and sent only to api.torn.com.</span>
    <label>Refresh interval (minutes)<input name="refreshMinutes" type="number" min="1" step="1" value="${escapeHtml(settings.refreshMinutes ?? 5)}"></label>
    <button type="button" class="r4-tcm-btn r4-tcm-btn-primary" data-settings-action="save">Save General</button>
    <button type="button" class="r4-tcm-btn r4-tcm-btn-warn" data-settings-action="clear-key">Clear API Key</button>
  </div>`;
  }
  function trainingHtml(settings) {
    return `<div class="r4-tcm-settings-stack">
    <div class="r4-tcm-policy-card"><strong>Inactivity rule</strong><span>More than 24 hours since last action = ineligible.</span></div>
    <div class="r4-tcm-policy-card"><strong>New-hire hold</strong><span>72 hours / 3 days in the company before training eligibility.</span></div>
    <label>Maximum addiction<input name="maxAddiction" type="number" min="0" step="1" value="${escapeHtml(settings.maxAddiction ?? 3)}"></label>
    <label>Removal eligible after <span class="r4-tcm-muted">days, optional</span><input name="removalThresholdDays" type="number" min="0.01" step="0.01" list="r4-tcm-removal-presets" value="${escapeHtml(settings.removalThresholdDays ?? "")}" placeholder="Off"></label>
    <datalist id="r4-tcm-removal-presets"><option value="2">2 days</option><option value="3">3 days</option><option value="7">7 days</option></datalist>
    <label class="r4-tcm-settings-check"><input name="prioritizeNeverTrained" type="checkbox" ${checked(settings.prioritizeNeverTrained !== false)}>Prioritize employees who have never been trained in Fair Rotation</label>
    <button type="button" class="r4-tcm-btn r4-tcm-btn-primary" data-settings-action="save">Save Training Rules</button>
  </div>`;
  }
  function fairnessHtml(settings) {
    const balanced = settings.rotationMode === "balanced";
    return `<div class="r4-tcm-settings-stack">
    <label>Training mode<select name="rotationMode"><option value="fair" ${selected(settings.rotationMode ?? "fair", "fair")}>Fair Rotation</option><option value="balanced" ${selected(settings.rotationMode, "balanced")}>Balanced Fairness</option></select></label>
    <div class="r4-tcm-settings-help">Fair Rotation stays simple. Balanced Fairness uses verified eligibility-adjusted history without inventing old eligibility.</div>
    <div class="r4-tcm-balanced-options" data-balanced-options data-visible="${balanced ? "true" : "false"}" ${balanced ? "" : "hidden"}>
      <label>Fairness window (days)<input name="fairnessWindowDays" type="number" min="1" step="1" list="r4-tcm-fairness-presets" value="${escapeHtml(settings.fairnessWindowDays ?? 30)}"></label>
      <datalist id="r4-tcm-fairness-presets"><option value="7"><option value="14"><option value="30"><option value="60"><option value="90"></datalist>
      <label class="r4-tcm-settings-check"><input name="accrueDebtWhileIneligible" type="checkbox" ${checked(settings.accrueDebtWhileIneligible === true)}>Accrue fairness debt while ineligible</label>
    </div>
    <button type="button" class="r4-tcm-btn r4-tcm-btn-primary" data-settings-action="save">Save Fairness</button>
  </div>`;
  }
  function notificationsHtml(settings) {
    const custom = settings.notificationMode === "custom";
    return `<div class="r4-tcm-settings-stack">
    <label>Notification level<select name="notificationMode"><option value="important" ${selected(settings.notificationMode ?? "important", "important")}>Important only</option><option value="everything" ${selected(settings.notificationMode, "everything")}>Everything</option><option value="silent" ${selected(settings.notificationMode, "silent")}>Silent</option><option value="custom" ${selected(settings.notificationMode, "custom")}>Custom</option></select></label>
    <div class="r4-tcm-settings-help">Write-blocking safety reasons are always shown inline, even in Silent mode.</div>
    <div data-custom-notifications data-visible="${custom ? "true" : "false"}" ${custom ? "" : "hidden"} class="r4-tcm-custom-notifications">
      <label class="r4-tcm-settings-check"><input name="notifyCritical" type="checkbox" checked>Critical safety and verification</label>
      <label class="r4-tcm-settings-check"><input name="notifyAction" type="checkbox" checked>Director action required</label>
      <label class="r4-tcm-settings-check"><input name="notifyInfo" type="checkbox">Informational training changes</label>
    </div>
    <button type="button" class="r4-tcm-btn r4-tcm-btn-primary" data-settings-action="save">Save Notifications</button>
  </div>`;
  }
  function appearanceHtml(settings) {
    return `<div class="r4-tcm-settings-stack">
    <label class="r4-tcm-settings-check"><input name="showNativeTrainingBadges" type="checkbox" ${checked(settings.showNativeTrainingBadges !== false)}>Show compact training badges on Torn employee rows</label>
    <label class="r4-tcm-settings-check"><input name="compactDensity" type="checkbox" ${checked(settings.compactDensity === true)}>Compact density</label>
    <label class="r4-tcm-settings-check"><input name="reduceMotion" type="checkbox" ${checked(settings.reduceMotion === true)}>Reduce Training Manager motion</label>
    <button type="button" class="r4-tcm-btn r4-tcm-btn-primary" data-settings-action="save">Save Appearance</button>
  </div>`;
  }
  function advancedHtml() {
    return `<div class="r4-tcm-settings-stack">
    <div class="r4-tcm-settings-help">Troubleshooting lives here so normal directors are not greeted by JSON before breakfast.</div>
    <button type="button" class="r4-tcm-btn" data-settings-action="audit-log">Audit Log</button>
    <button type="button" class="r4-tcm-btn" data-settings-action="diagnostics">Diagnostics / Self-Test</button>
  </div>`;
  }
  function sectionPanel(state, activeSection, hasApiKey) {
    const settings = state.settings || {};
    let body = "";
    if (activeSection === "general") body = generalHtml(settings, hasApiKey);
    if (activeSection === "training") body = trainingHtml(settings);
    if (activeSection === "paid") body = paidSettingsHtml(state);
    if (activeSection === "fairness") body = fairnessHtml(settings);
    if (activeSection === "notifications") body = notificationsHtml(settings);
    if (activeSection === "appearance") body = appearanceHtml(settings);
    if (activeSection === "recovery") body = dataRecoveryHtml();
    if (activeSection === "advanced") body = advancedHtml();
    return `<section class="r4-tcm-settings-panel" data-section-panel="${activeSection}"><h4>${SECTION_LABELS[activeSection]}</h4>${body}</section>`;
  }
  function settingsFormHtml(state = {}, { hasApiKey = false, activeSection = "general" } = {}) {
    if (!SECTION_IDS.includes(activeSection)) activeSection = "general";
    return `<div class="r4-tcm-modal r4-tcm-settings">
    <div class="r4-tcm-settings-heading"><div><span class="r4-tcm-eyebrow">VOIDSMITH</span><h3>Training Manager Settings</h3></div><button type="button" class="r4-tcm-window-btn" data-settings-action="close" aria-label="Close settings">\xD7</button></div>
    <div class="r4-tcm-settings-layout">${sectionNav(activeSection)}${sectionPanel(state, activeSection, hasApiKey)}</div>
    <div class="r4-tcm-error" data-settings-error hidden></div>
  </div>`;
  }
  function validateSettingsValues(values = {}) {
    const maxAddiction = Number(values.maxAddiction ?? 3);
    const refreshMinutes = Number(values.refreshMinutes ?? 5);
    const rotationMode = values.rotationMode ?? "fair";
    const fairnessWindowDays = Number(values.fairnessWindowDays ?? 30);
    const notificationMode = values.notificationMode ?? "important";
    const rawRemovalThreshold = values.removalThresholdDays;
    const removalThresholdDays = rawRemovalThreshold === null || rawRemovalThreshold === void 0 || rawRemovalThreshold === "" ? null : Number(rawRemovalThreshold);
    if (!Number.isInteger(maxAddiction) || maxAddiction < 0) throw new TypeError("Addiction threshold must be a whole number of zero or greater");
    if (!Number.isFinite(refreshMinutes) || refreshMinutes <= 0) throw new TypeError("Refresh minutes must be greater than zero");
    if (!ROTATION_MODES.has(rotationMode)) throw new TypeError("Rotation mode must be fair or balanced");
    if (!Number.isFinite(fairnessWindowDays) || fairnessWindowDays <= 0) throw new TypeError("Fairness window must be greater than zero");
    if (removalThresholdDays !== null && (!Number.isFinite(removalThresholdDays) || removalThresholdDays <= 0)) throw new TypeError("Removal threshold must be a positive number of days or blank");
    if (!NOTIFICATION_MODES.has(notificationMode)) throw new TypeError("Notification mode is invalid");
    return {
      maxAddiction,
      newHireHoldHours: 72,
      prioritizeNeverTrained: values.prioritizeNeverTrained !== false,
      rotationMode,
      fairnessWindowDays,
      accrueDebtWhileIneligible: Boolean(values.accrueDebtWhileIneligible),
      removalThresholdDays,
      notificationMode,
      showNativeTrainingBadges: values.showNativeTrainingBadges !== false,
      compactDensity: Boolean(values.compactDensity),
      reduceMotion: Boolean(values.reduceMotion),
      refreshMinutes
    };
  }
  async function savePolicySettings(values, controller) {
    const normalized = validateSettingsValues(values);
    await controller.updateSettings(normalized);
    return normalized;
  }
  function readValues(modal, current = {}) {
    const read = (name, fallback = void 0) => modal.querySelector?.(`[name="${name}"]`)?.value ?? fallback;
    const bool = (name, fallback = false) => modal.querySelector?.(`[name="${name}"]`)?.checked ?? fallback;
    return {
      ...current,
      maxAddiction: read("maxAddiction", current.maxAddiction ?? 3),
      refreshMinutes: read("refreshMinutes", current.refreshMinutes ?? 5),
      prioritizeNeverTrained: bool("prioritizeNeverTrained", current.prioritizeNeverTrained !== false),
      rotationMode: read("rotationMode", current.rotationMode ?? "fair"),
      fairnessWindowDays: read("fairnessWindowDays", current.fairnessWindowDays ?? 30),
      accrueDebtWhileIneligible: bool("accrueDebtWhileIneligible", current.accrueDebtWhileIneligible === true),
      removalThresholdDays: read("removalThresholdDays", current.removalThresholdDays ?? ""),
      notificationMode: read("notificationMode", current.notificationMode ?? "important"),
      showNativeTrainingBadges: bool("showNativeTrainingBadges", current.showNativeTrainingBadges !== false),
      compactDensity: bool("compactDensity", current.compactDensity === true),
      reduceMotion: bool("reduceMotion", current.reduceMotion === true)
    };
  }
  function reorderIds(state, employeeId, direction) {
    const queue = [...state.paid?.queue || []];
    const contractId = state.paid?.activeByEmployeeId?.[String(Number(employeeId))];
    const index = queue.indexOf(contractId);
    if (index < 0) return queue;
    const nextIndex = direction === "up" ? index - 1 : index + 1;
    if (nextIndex < 0 || nextIndex >= queue.length) return queue;
    [queue[index], queue[nextIndex]] = [queue[nextIndex], queue[index]];
    return queue;
  }
  async function renderSettingsModal(state, controller, options = {}) {
    const documentRef = options.documentRef ?? globalThis.document;
    if (!documentRef?.body) return null;
    const hasApiKey = Boolean(await controller.getApiKey?.());
    const backdrop = documentRef.createElement("div");
    backdrop.className = "r4-tcm-modal-backdrop";
    let activeSection = "general";
    let localState = { ...state, settings: { ...state.settings || {} } };
    const render = () => {
      backdrop.innerHTML = settingsFormHtml(localState, { hasApiKey, activeSection });
    };
    render();
    documentRef.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    const showError = (error) => {
      const errorBox = backdrop.querySelector("[data-settings-error]");
      if (!errorBox) return;
      errorBox.hidden = false;
      errorBox.textContent = String(error?.message || error);
    };
    backdrop.addEventListener("click", async (event) => {
      if (event.target === backdrop) return close();
      const sectionButton = event.target.closest?.("[data-settings-section]");
      if (sectionButton) {
        activeSection = sectionButton.dataset.settingsSection;
        render();
        return;
      }
      const paidButton = event.target.closest?.("[data-paid-action]");
      if (paidButton) {
        const action2 = paidButton.dataset.paidAction;
        const employeeId = Number(paidButton.dataset.id);
        try {
          if (action2 === "create") {
            const id = await showNumberPrompt({ title: "Create paid agreement", message: "Employee Torn ID", min: 1, documentRef });
            if (id === null) return;
            const trains = await showNumberPrompt({ title: "Paid trains", message: "How many trains were purchased?", min: 1, documentRef });
            if (trains === null) return;
            const employee = (localState.employees || []).find((row) => Number(row.id) === Number(id));
            await controller.createPaidAgreement?.({ employeeId: Number(id), employeeName: employee?.name || `Employee ${id}`, trainsPurchased: Number(trains) });
          } else if (action2 === "amend") {
            const trains = await showNumberPrompt({ title: "Add paid trains", message: "Additional trains", min: 1, documentRef });
            if (trains !== null) await controller.amendPaidAgreement?.(employeeId, { addTrains: Number(trains) });
          } else if (action2 === "pause") await controller.pausePaidAgreement?.(employeeId);
          else if (action2 === "resume") await controller.resumePaidAgreement?.(employeeId);
          else if (action2 === "up" || action2 === "down") await controller.reorderPaidAgreements?.(reorderIds(localState, employeeId, action2));
          else if (action2 === "close") {
            const ok = await showConfirmModal({ title: "Close paid agreement?", message: "This does not move money. Choose the closing outcome in the next step.", confirmText: "Continue", danger: true, documentRef });
            if (ok) await controller.closePaidAgreement?.(employeeId, { outcome: "cancelled", reason: "director_closed" });
          }
          localState = controller.getState?.() ?? localState;
          render();
        } catch (error) {
          showError(error);
        }
        return;
      }
      const button2 = event.target.closest?.("[data-settings-action]");
      if (!button2) return;
      const action = button2.dataset.settingsAction;
      try {
        if (action === "close") return close();
        if (action === "save") {
          const modal = backdrop.querySelector(".r4-tcm-settings");
          const normalized = await savePolicySettings(readValues(modal, localState.settings), controller);
          localState = { ...controller.getState?.() ?? localState, settings: normalized };
          const key = modal.querySelector?.('[name="apiKey"]')?.value?.trim?.() || "";
          if (key) await controller.setApiKey?.(key);
          await controller.refresh?.();
          localState = controller.getState?.() ?? localState;
          render();
          return;
        }
        if (action === "rebuild") {
          const ok = await showConfirmModal({ title: "Rebuild training history?", message: "This rescans Company News. Paid agreements and settings are preserved.", confirmText: "Rebuild", documentRef });
          if (ok) await controller.rebuildHistory?.();
          return;
        }
        if (action === "clear-key") {
          const ok = await showConfirmModal({ title: "Clear API key?", message: "The manager will stop refreshing until a new key is provided.", confirmText: "Clear Key", danger: true, documentRef });
          if (ok) await controller.clearApiKey?.();
          return;
        }
        if (action === "reset") {
          const ok = await showConfirmModal({ title: "Reset local Training Manager data?", message: "Training Manager state will be cleared. Your API key is preserved.", confirmText: "Reset Local Data", danger: true, documentRef });
          if (ok) await controller.resetNonKeyData?.();
          return;
        }
        if (action === "audit-log") return options.openAuditLog?.();
        if (action === "diagnostics") return options.openDiagnostics?.();
        if (action === "export-data") return options.exportData?.();
        if (action === "import-data") return options.importData?.();
      } catch (error) {
        showError(error);
      }
    });
    backdrop.addEventListener("change", (event) => {
      if (event.target?.name === "rotationMode") {
        localState.settings.rotationMode = event.target.value;
        render();
      }
      if (event.target?.name === "notificationMode") {
        localState.settings.notificationMode = event.target.value;
        render();
      }
    });
    return backdrop;
  }

  // src/ui/audit-log.js
  function option(value, label, selected2) {
    return `<option value="${escapeHtml(value)}" ${selected2 === value ? "selected" : ""}>${escapeHtml(label)}</option>`;
  }
  function detailsSummary(details) {
    if (!details || typeof details !== "object" || Object.keys(details).length === 0) return "";
    return JSON.stringify(sanitizeAuditValue(details));
  }
  function visibleAuditEntries(entries = [], filters = {}) {
    return filterAuditEntries(entries, filters).slice().sort((a, b) => {
      const timeDiff = Number(b?.timestamp || 0) - Number(a?.timestamp || 0);
      if (timeDiff !== 0) return timeDiff;
      return String(b?.id || "").localeCompare(String(a?.id || ""));
    });
  }
  function auditLogHtml(entries = [], filters = {}) {
    const type = String(filters.type || "all");
    const phase = String(filters.phase || "all");
    const employee = String(filters.employee || "");
    const visible = visibleAuditEntries(entries, { type, phase, employee });
    const types = [...new Set((entries || []).map((entry) => String(entry?.type || "unknown")))].sort();
    const phases = [...new Set((entries || []).map((entry) => String(entry?.phase || "unknown")))].sort();
    const rows = visible.map((entry) => `<tr>
      <td>${escapeHtml(formatDateTime(entry.timestamp))}</td>
      <td><strong>${escapeHtml(entry.type)}</strong><br><span class="r4-tcm-muted">${escapeHtml(entry.phase)}</span></td>
      <td>${entry.employeeName ? escapeHtml(entry.employeeName) : "\u2014"}${entry.employeeId != null ? `<br><span class="r4-tcm-muted">[${escapeHtml(entry.employeeId)}]</span>` : ""}</td>
      <td class="r4-tcm-audit-details">${escapeHtml(detailsSummary(entry.details)) || "\u2014"}</td>
    </tr>`).join("");
    return `<div class="r4-tcm-audit-panel">
    <div class="r4-tcm-header">
      <h3 class="r4-tcm-title">Audit Log</h3>
      <button type="button" class="r4-tcm-window-btn" data-audit-action="close" aria-label="Close" title="Close">\xD7</button>
    </div>
    <div class="r4-tcm-audit-filters">
      <label>Action<select data-audit-filter="type">${option("all", "All actions", type)}${types.map((value) => option(value, value, type)).join("")}</select></label>
      <label>Result<select data-audit-filter="phase">${option("all", "All results", phase)}${phases.map((value) => option(value, value, phase)).join("")}</select></label>
      <label>Employee<input type="search" data-audit-filter="employee" value="${escapeHtml(employee)}" placeholder="Name or ID"></label>
    </div>
    <div class="r4-tcm-actions">
      <button type="button" class="r4-tcm-btn" data-audit-action="copy">Copy Visible Log</button>
      <button type="button" class="r4-tcm-btn" data-audit-action="export">Export JSON</button>
      <button type="button" class="r4-tcm-btn r4-tcm-btn-danger" data-audit-action="clear">Clear Log</button>
      <span class="r4-tcm-muted">${visible.length} of ${(entries || []).length} entries \xB7 latest 500 retained</span>
    </div>
    <div class="r4-tcm-table-wrap r4-tcm-audit-table-wrap">
      <table class="r4-tcm-table r4-tcm-audit-table"><thead><tr><th>Time</th><th>Action</th><th>Employee</th><th>Details</th></tr></thead><tbody>${rows || `<tr><td colspan="4">No audit entries match these filters.</td></tr>`}</tbody></table>
    </div>
  </div>`;
  }
  async function defaultCopy(text, documentRef) {
    const navigatorRef = documentRef?.defaultView?.navigator ?? globalThis.navigator;
    if (navigatorRef?.clipboard?.writeText) {
      await navigatorRef.clipboard.writeText(text);
      return;
    }
    documentRef?.defaultView?.prompt?.("Copy audit log", text);
  }
  function defaultExport(entries, documentRef) {
    const win = documentRef?.defaultView ?? globalThis.window;
    const BlobImpl = win?.Blob ?? globalThis.Blob;
    const URLImpl = win?.URL ?? globalThis.URL;
    if (!BlobImpl || !URLImpl?.createObjectURL || !documentRef?.createElement) return false;
    const blob = new BlobImpl([JSON.stringify(sanitizeAuditValue(entries), null, 2)], { type: "application/json" });
    const href = URLImpl.createObjectURL(blob);
    const anchor = documentRef.createElement("a");
    anchor.href = href;
    anchor.download = `torn-training-manager-audit-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.json`;
    documentRef.body?.appendChild?.(anchor);
    anchor.click?.();
    anchor.remove?.();
    URLImpl.revokeObjectURL?.(href);
    return true;
  }
  function renderAuditLogModal({
    entries = [],
    documentRef = globalThis.document,
    onClear = async () => [],
    copyText: copyText2 = defaultCopy,
    exportJson = defaultExport,
    confirmClear = null
  } = {}) {
    if (!documentRef?.body || !documentRef?.createElement) return null;
    const backdrop = documentRef.createElement("div");
    backdrop.className = "r4-tcm-modal-backdrop r4-tcm-audit-backdrop";
    let sourceEntries = Array.isArray(entries) ? entries.slice() : [];
    let filters = { type: "all", phase: "all", employee: "" };
    const close = () => backdrop.remove?.();
    const confirmClearImpl = confirmClear || (() => showConfirmModal({
      title: "Clear Training Manager audit log?",
      message: "This permanently clears the local action log on this browser. Training history and payroll restore records are not affected.",
      confirmText: "Clear Log",
      danger: true,
      documentRef
    }));
    const render = () => {
      backdrop.innerHTML = auditLogHtml(sourceEntries, filters);
      const panel = backdrop.querySelector?.(".r4-tcm-audit-panel");
      panel?.addEventListener?.("click", (event) => event.stopPropagation?.());
      const type = backdrop.querySelector?.('[data-audit-filter="type"]');
      const phase = backdrop.querySelector?.('[data-audit-filter="phase"]');
      const employee = backdrop.querySelector?.('[data-audit-filter="employee"]');
      type?.addEventListener?.("change", () => {
        filters.type = type.value;
        render();
      });
      phase?.addEventListener?.("change", () => {
        filters.phase = phase.value;
        render();
      });
      employee?.addEventListener?.("input", () => {
        filters.employee = employee.value;
        render();
      });
      backdrop.querySelector?.('[data-audit-action="close"]')?.addEventListener?.("click", close);
      backdrop.querySelector?.('[data-audit-action="copy"]')?.addEventListener?.("click", async () => {
        const visible = visibleAuditEntries(sourceEntries, filters);
        await copyText2(JSON.stringify(sanitizeAuditValue(visible), null, 2), documentRef);
      });
      backdrop.querySelector?.('[data-audit-action="export"]')?.addEventListener?.("click", () => {
        exportJson(visibleAuditEntries(sourceEntries, filters), documentRef);
      });
      backdrop.querySelector?.('[data-audit-action="clear"]')?.addEventListener?.("click", async () => {
        if (!await confirmClearImpl()) return;
        const result = await onClear();
        sourceEntries = Array.isArray(result) ? result : Array.isArray(result?.entries) ? result.entries : [];
        render();
      });
    };
    backdrop.addEventListener?.("click", (event) => {
      if (event.target === backdrop) close();
    });
    render();
    documentRef.body.appendChild(backdrop);
    return backdrop;
  }

  // src/ui/attention.js
  var ORDER = { critical: 0, action: 1, info: 2 };
  var LABEL = { critical: "Critical", action: "Action", info: "Information" };
  function attentionHtml(items = []) {
    const sorted = [...Array.isArray(items) ? items : []].sort((a, b) => (ORDER[a.severity] ?? 9) - (ORDER[b.severity] ?? 9));
    const groups = ["critical", "action", "info"].map((severity) => {
      const rows = sorted.filter((item) => item?.severity === severity);
      if (!rows.length) return "";
      return `<section class="r4-tcm-attention-group r4-tcm-attention-${severity}"><h4>${LABEL[severity]}</h4>${rows.map((item) => `<div class="r4-tcm-attention-item">${escapeHtml(item.message || "Training attention item")}</div>`).join("")}</section>`;
    }).join("");
    return `<div class="r4-tcm-modal r4-tcm-attention-panel"><div class="r4-tcm-settings-heading"><div><span class="r4-tcm-eyebrow">TRAINING MANAGER</span><h3>Attention</h3></div><button type="button" class="r4-tcm-window-btn" data-attention-close>\xD7</button></div>${groups || `<div class="r4-tcm-muted">Nothing needs your attention.</div>`}</div>`;
  }
  function renderAttentionModal(items, { documentRef = globalThis.document } = {}) {
    if (!documentRef?.createElement || !documentRef?.body) return null;
    const backdrop = documentRef.createElement("div");
    backdrop.className = "r4-tcm-modal-backdrop";
    backdrop.innerHTML = attentionHtml(items);
    documentRef.body.appendChild(backdrop);
    const close = () => backdrop.remove?.();
    backdrop.addEventListener?.("click", (event) => {
      if (event.target === backdrop || event.target.closest?.("[data-attention-close]")) close();
    });
    return backdrop;
  }

  // src/ui/native-indicators.js
  function getEligibility(state, id) {
    if (state?.eligibilityById instanceof Map) return state.eligibilityById.get(Number(id));
    return state?.eligibilityById?.[id] ?? state?.eligibilityById?.[String(id)] ?? null;
  }
  function paidContract2(state, id) {
    const contractId = state?.paid?.activeByEmployeeId?.[String(Number(id))];
    return contractId ? state?.paid?.contractsById?.[contractId] || null : null;
  }
  function badgeFor(state, id) {
    if (Number(state?.recommendation?.nextEmployeeId) === Number(id)) return { label: "NEXT", tone: "next" };
    const paid = paidContract2(state, id);
    if (Number(state?.overrides?.priorityOnceEmployeeId) === Number(id)) return { label: "PRIORITY", tone: "priority" };
    if (paid?.status === "auto-paused" || paid?.status === "manually-paused") return { label: "PAUSED", tone: "warn" };
    if (paid) return { label: "PAID", tone: "paid" };
    const eligibility = getEligibility(state, id);
    if (eligibility && eligibility.eligible === false) return { label: eligibility.newHireHold ? "NEW HIRE" : "INELIGIBLE", tone: "bad" };
    return null;
  }
  function rowEmployeeId2(row) {
    const candidates = [row?.dataset?.user, row?.dataset?.userid, row?.dataset?.userId, row?.getAttribute?.("data-user"), row?.getAttribute?.("data-userid")];
    for (const candidate of candidates) {
      const id = Number(candidate);
      if (Number.isInteger(id) && id > 0) return id;
    }
    const link = row?.querySelector?.('a[href*="XID="]');
    if (link?.href) {
      try {
        const id = Number(new URL(link.href, "https://www.torn.com").searchParams.get("XID"));
        if (Number.isInteger(id) && id > 0) return id;
      } catch {
      }
    }
    return null;
  }
  function mountNativeTrainingIndicators({ documentRef = globalThis.document, state = {} } = {}) {
    const existing = documentRef?.querySelectorAll?.(".r4-tcm-native-badge") || [];
    for (const node of existing) node.remove?.();
    if (state?.settings?.showNativeTrainingBadges === false) return;
    const rows = documentRef?.querySelectorAll?.('ul.employee-list li[data-user], li[data-userid], [data-user][class*="employee"], [data-userid][class*="employee"]') || [];
    for (const row of rows) {
      const id = rowEmployeeId2(row);
      if (!id) continue;
      const badge = badgeFor(state, id);
      if (!badge) continue;
      if (typeof documentRef?.createElement !== "function") continue;
      const el = documentRef.createElement("span");
      el.className = `r4-tcm-native-badge r4-tcm-native-badge-${badge.tone}`;
      el.textContent = badge.label;
      el.dataset.employeeId = String(id);
      el.title = `Training Manager: ${badge.label}`;
      const name = row.querySelector?.('[class*="name"], .name, a[href*="XID="]');
      if (name?.parentNode?.insertBefore) name.parentNode.insertBefore(el, name.nextSibling);
      else row.appendChild?.(el);
    }
  }
  function reminderTextFor(employee = {}, eligibility = {}) {
    const name = employee.name || `Employee ${employee.id ?? ""}`.trim();
    if (eligibility.addictionViolation) {
      const reason = eligibility.reasons?.find?.((item) => item.code === "addiction") || {};
      return `${name}, your addiction is currently ${reason.actual ?? "above the company limit"}${reason.limit != null ? ` (limit ${reason.limit})` : ""}. Please rehab so you can re-enter the company training rotation.`;
    }
    if (eligibility.inactive) return `${name}, you are currently inactive beyond the company limit and are excluded from training. Please become active again to re-enter the training rotation.`;
    if (eligibility.newHireHold) return `${name}, you are still inside the 3-day new-hire training hold and will enter the normal training rotation after the hold completes, provided all other requirements are met.`;
    return `${name}, you are currently not eligible for company training. Please check the company training requirements.`;
  }
  var NATIVE_INDICATOR_STYLES = `
.r4-tcm-native-badge{display:inline-flex!important;align-items:center!important;margin-left:6px!important;padding:2px 6px!important;border-radius:999px!important;border:1px solid #555!important;background:#252529!important;color:#ddd!important;font:800 9px/1.2 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif!important;letter-spacing:.04em!important;vertical-align:middle!important}
.r4-tcm-native-badge-next{background:#214d22!important;border-color:#438b4a!important;color:#b7f5b9!important}
.r4-tcm-native-badge-paid{background:#3f3315!important;border-color:#695824!important;color:#efd591!important}
.r4-tcm-native-badge-priority{background:#30284e!important;border-color:#51447b!important;color:#d9d3ff!important}
.r4-tcm-native-badge-warn{background:#493a13!important;border-color:#77601d!important;color:#ffe397!important}
.r4-tcm-native-badge-bad{background:#4b1e22!important;border-color:#79353a!important;color:#ffabab!important}
`;
  function injectNativeIndicatorStyles(documentRef = globalThis.document) {
    if (!documentRef?.head || typeof documentRef?.createElement !== "function" || documentRef.getElementById?.("r4-tcm-native-indicator-styles")) return;
    const style = documentRef.createElement("style");
    style.id = "r4-tcm-native-indicator-styles";
    style.textContent = NATIVE_INDICATOR_STYLES;
    documentRef.head.appendChild?.(style);
  }

  // src/ui/employee-menu.js
  function getEligibility2(state, id) {
    if (state?.eligibilityById instanceof Map) return state.eligibilityById.get(Number(id));
    return state?.eligibilityById?.[id] ?? state?.eligibilityById?.[String(id)] ?? null;
  }
  function paidContract3(state, id) {
    const contractId = state?.paid?.activeByEmployeeId?.[String(Number(id))];
    return contractId ? state?.paid?.contractsById?.[contractId] || null : null;
  }
  function employeeContext(eligibility, paid) {
    if (paid?.status === "auto-paused" || paid?.status === "manually-paused") return `Paid agreement paused \xB7 ${paid.trainsRemaining} remaining`;
    if (paid) return `Paid agreement \xB7 ${paid.trainsRemaining} remaining`;
    if (eligibility?.eligible) return "Eligible for company training";
    if (eligibility?.newHireHold) return "New-hire training hold";
    if (eligibility?.unverified) return "Eligibility unverified";
    if (eligibility?.inactive && eligibility?.addictionViolation) return "Inactive \xB7 addiction policy exceeded";
    if (eligibility?.inactive) return "Inactive \xB7 training unavailable";
    if (eligibility?.addictionViolation) return "Addiction policy exceeded";
    return "Training currently unavailable";
  }
  function employeeMenuHtml(employee, state = {}) {
    const eligibility = getEligibility2(state, employee?.id);
    const paid = paidContract3(state, employee?.id);
    let actions = "";
    if (eligibility?.eligible) {
      actions += `<button type="button" class="r4-tcm-btn r4-tcm-btn-primary" data-employee-action="train"><span>Train Employee</span><small>Run fresh safety preflight</small></button>`;
      if (paid) actions += `<button type="button" class="r4-tcm-btn" data-employee-action="bonus"><span>Train as Bonus</span><small>Do not reduce paid balance</small></button><button type="button" class="r4-tcm-btn" data-employee-action="paid-details"><span>Paid Agreement</span><small>${escapeHtml(paid.trainsRemaining)} trains remaining</small></button>`;
      else actions += `<button type="button" class="r4-tcm-btn" data-employee-action="priority"><span>Priority Once</span><small>Move to the front of normal rotation once</small></button><button type="button" class="r4-tcm-btn" data-employee-action="create-paid"><span>Create Paid Agreement</span><small>Add a training commitment</small></button>`;
      actions += `<button type="button" class="r4-tcm-btn" data-employee-action="skip"><span>Skip / Snooze</span><small>Temporarily suppress recommendation</small></button>`;
    } else {
      actions += `<button type="button" class="r4-tcm-btn" data-employee-action="copy-reminder"><span>Copy Reminder</span><small>Prepare a training-policy message</small></button><button type="button" class="r4-tcm-btn" data-employee-action="profile"><span>Open Profile</span><small>Open this player in Torn</small></button>`;
      if (!eligibility?.unverified) actions += `<button type="button" class="r4-tcm-btn r4-tcm-btn-warn" data-employee-action="dock"><span>Dock Pay</span><small>Temporary payroll action \xB7 confirmation required</small></button>`;
    }
    return `<div class="r4-tcm-modal r4-tcm-employee-menu r4-tcm-employee-action-sheet">
    <div class="r4-tcm-action-sheet-head">
      <div><span class="r4-tcm-eyebrow">TRAINING ACTIONS</span><h3>${escapeHtml(employee?.name || `Employee ${employee?.id ?? "?"}`)}</h3><p>${escapeHtml(employeeContext(eligibility, paid))}</p></div>
      <button type="button" class="r4-tcm-window-btn" data-employee-action="close" aria-label="Close actions" title="Close">\xD7</button>
    </div>
    <div class="r4-tcm-action-sheet-actions">${actions}</div>
    <div class="r4-tcm-action-sheet-footer"><button type="button" class="r4-tcm-link-btn" data-employee-action="details">View Training Details</button></div>
  </div>`;
  }
  function renderEmployeeMenu(employee, state, actions = {}, { documentRef = globalThis.document, windowRef = globalThis.window } = {}) {
    if (!documentRef?.createElement || !documentRef?.body) return null;
    const backdrop = documentRef.createElement("div");
    backdrop.className = "r4-tcm-modal-backdrop";
    backdrop.innerHTML = employeeMenuHtml(employee, state);
    documentRef.body.appendChild(backdrop);
    const close = () => backdrop.remove?.();
    backdrop.addEventListener?.("click", async (event) => {
      if (event.target === backdrop) return close();
      const button2 = event.target.closest?.("[data-employee-action]");
      if (!button2) return;
      const action = button2.dataset.employeeAction;
      if (action === "close") return close();
      try {
        if (action === "train") {
          close();
          return actions.train?.(employee.id, { countsTowardPaid: Boolean(paidContract3(state, employee.id)) });
        }
        if (action === "bonus") {
          close();
          return actions.train?.(employee.id, { countsTowardPaid: false });
        }
        if (action === "priority") {
          await actions.priorityOnce?.(employee.id);
          return close();
        }
        if (action === "create-paid") {
          await actions.createPaid?.(employee);
          return close();
        }
        if (action === "paid-details") {
          close();
          return actions.openPaidSettings?.();
        }
        if (action === "skip") {
          await actions.skip?.(employee.id);
          return close();
        }
        if (action === "copy-reminder") {
          await actions.copy?.(reminderTextFor(employee, getEligibility2(state, employee.id)));
          return;
        }
        if (action === "profile") {
          try {
            windowRef?.open?.(`https://www.torn.com/profiles.php?XID=${encodeURIComponent(employee.id)}`, "_blank", "noopener");
          } catch {
          }
          return;
        }
        if (action === "dock") {
          close();
          return actions.dock?.(employee);
        }
        if (action === "details") {
          close();
          return actions.details?.(employee.id);
        }
      } catch (error) {
        actions.onError?.(error);
      }
    });
    return backdrop;
  }

  // src/ui/styles.js
  var TCM_STYLES = `
.r4-tcm-manager,.r4-tcm-badge,.r4-tcm-modal,.r4-tcm-audit-panel{--vs-red:#c34743;--vs-red-deep:#722724;--vs-red-glow:rgba(195,71,67,.22);--vs-black:#09090b;--vs-bg-1:#101014;--vs-bg-2:#17171c;--vs-bg-3:#202027;--vs-bg-4:#292931;--vs-line:#34343d;--vs-line-strong:#555560;--vs-text:#f4f4f4;--vs-muted:#a7a7b0;--vs-green:#63d467;--vs-amber:#e2b84d;--vs-danger:#ef6262;box-sizing:border-box;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:#f4f4f4!important}
.r4-tcm-manager *,.r4-tcm-badge *,.r4-tcm-modal *,.r4-tcm-audit-panel *{box-sizing:border-box}
.r4-tcm-manager{margin:0;padding:0;border:1px solid var(--vs-line-strong);border-radius:11px 11px 15px 15px;background:radial-gradient(circle at 88% -8%,rgba(195,71,67,.13),transparent 28%),linear-gradient(180deg,#17171c 0%,#0b0b0e 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.055),inset 0 0 0 1px rgba(0,0,0,.45),0 24px 70px rgba(0,0,0,.72),0 0 28px rgba(195,71,67,.07);color:#f4f4f4!important;height:100%;display:flex;flex-direction:column;overflow:hidden;transition:box-shadow .16s ease,transform .16s ease}
.r4-tcm-header{position:relative;display:flex;gap:12px;align-items:center;justify-content:space-between;color:#f4f4f4!important;min-height:58px;padding:10px 14px;border-bottom:1px solid var(--vs-line);background:linear-gradient(180deg,#202027,#141419);box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}.r4-tcm-header:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:1px;background:linear-gradient(90deg,transparent 0,var(--vs-red) 15%,rgba(195,71,67,.12) 48%,transparent 82%);pointer-events:none}
.r4-tcm-brand{display:flex;align-items:center;gap:10px;min-width:0}.r4-tcm-brand-mark{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:1px solid #5a3636;border-radius:8px;background:linear-gradient(145deg,#25252b,#111115);color:var(--vs-red)!important;font-size:15px;filter:drop-shadow(0 0 6px rgba(195,71,67,.32));box-shadow:inset 0 1px 0 rgba(255,255,255,.05)}.r4-tcm-brand div{display:flex;flex-direction:column;line-height:1.08}.r4-tcm-brand span{font-size:8px;letter-spacing:.18em;color:#a3a3ac!important}.r4-tcm-brand strong{font-size:13px;letter-spacing:.07em;color:#fff!important}
.r4-tcm-header-right{display:flex;align-items:center;gap:5px}.r4-tcm-window-controls{display:flex;align-items:center;gap:4px}.r4-tcm-window-btn,.r4-tcm-icon-btn{min-width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;border:1px solid #46464f;border-radius:7px;background:linear-gradient(180deg,#292930,#1c1c22);color:#f1f1f3!important;cursor:pointer;font-size:14px;line-height:1;padding:0;box-shadow:inset 0 1px 0 rgba(255,255,255,.035);transition:background .14s ease,border-color .14s ease,transform .14s ease,box-shadow .14s ease}.r4-tcm-window-btn:hover,.r4-tcm-icon-btn:hover{background:linear-gradient(180deg,#34343d,#24242b);border-color:#676772;box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 0 10px rgba(195,71,67,.08)}.r4-tcm-window-btn:active,.r4-tcm-icon-btn:active{transform:scale(.96)}.r4-tcm-lock-btn[data-locked="true"]{border-color:#70413f;background:linear-gradient(180deg,#382524,#241919);color:#ffd7d4!important}.r4-tcm-lock-btn[data-locked="false"]{color:#d8d8de!important}
.r4-tcm-health{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:4px}.r4-tcm-health-ok{background:#63d467;box-shadow:0 0 7px #63d46788}.r4-tcm-health-warn{background:#e2b84d}.r4-tcm-health-bad{background:#ef6262}.r4-tcm-health-idle{background:#777}.r4-tcm-attention-btn{position:relative}.r4-tcm-attention-btn span{position:absolute;right:-5px;top:-5px;min-width:15px;height:15px;border-radius:10px;background:var(--vs-red);color:white!important;font-size:9px;display:flex;align-items:center;justify-content:center;border:1px solid #1a1a1e}
.r4-tcm-manager-body{display:flex;flex:1;min-height:0;flex-direction:column;overflow:auto;padding:14px;gap:12px;background:linear-gradient(180deg,rgba(255,255,255,.01),transparent 28%)}.r4-tcm-feedback{margin:0}.r4-tcm-stale{background:#5a3d13;color:#ffe9bd!important;padding:9px 10px;border:1px solid #8d6423;border-radius:8px}.r4-tcm-error{background:#531f22;color:#ffd7d7!important;padding:9px 10px;border:1px solid #79353a;border-radius:8px}.r4-tcm-info{background:#173247;color:#d9efff!important;padding:9px 10px;border:1px solid #29516e;border-radius:8px}.r4-tcm-success{background:#173c22;color:#dcffdd!important;padding:9px 10px;border:1px solid #2e673c;border-radius:8px}
.r4-tcm-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.r4-tcm-metrics>div{background:linear-gradient(180deg,#16161b,#101014);border:1px solid var(--vs-line);border-radius:9px;padding:10px 12px;min-width:0;box-shadow:inset 0 1px 0 rgba(255,255,255,.025)}.r4-tcm-metrics strong{display:block;font-size:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#fff!important}.r4-tcm-metrics span{display:block;margin-top:2px;font-size:9px;letter-spacing:.12em;color:#96969d!important}
.r4-tcm-primary-card{padding:16px;border-radius:11px;border:1px solid #42424c;background:radial-gradient(circle at 90% 0,rgba(195,71,67,.12),transparent 36%),linear-gradient(180deg,#18181d,#101014);text-align:center;box-shadow:inset 0 1px 0 rgba(255,255,255,.035),0 8px 24px rgba(0,0,0,.23)}.r4-tcm-eyebrow{font-size:9px;letter-spacing:.17em;color:#b8b8bd!important}.r4-tcm-primary-name{font-size:24px;font-weight:750;margin:4px 0 1px;color:#fff!important}.r4-tcm-primary-reason{font-size:12px;color:#bcbcc1!important;margin-bottom:12px}.r4-tcm-train-primary{width:min(440px,100%);min-height:44px;border:1px solid #438b4a;border-radius:8px;background:linear-gradient(180deg,#397c40,#2d6333);color:#fff!important;font-weight:800;letter-spacing:.04em;cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 7px 18px #0005;transition:filter .15s ease,transform .15s ease}.r4-tcm-train-primary:hover:not(:disabled){filter:brightness(1.14);transform:translateY(-1px)}.r4-tcm-train-primary:disabled{opacity:.42;cursor:not-allowed}.r4-tcm-paid-progress{font-size:11px;color:#d1b671!important;margin-top:8px}
.r4-tcm-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10px;font-weight:750;letter-spacing:.11em;color:#aaa!important}.r4-tcm-link-btn{border:0;background:transparent;color:#b9b9c0!important;font:inherit;cursor:pointer;padding:3px 5px}.r4-tcm-link-btn:hover{color:#fff!important}.r4-tcm-queue,.r4-tcm-roster{background:linear-gradient(180deg,#131318,#0e0e12);border:1px solid var(--vs-line);border-radius:10px;padding:11px;box-shadow:inset 0 1px 0 rgba(255,255,255,.02)}.r4-tcm-queue ol{list-style:none;margin:8px 0 0;padding:0}.r4-tcm-queue li{display:grid;grid-template-columns:24px minmax(90px,1fr) auto;gap:8px;align-items:center;min-height:30px;border-top:1px solid #29292d;font-size:12px}.r4-tcm-queue li:first-child{border-top:0}.r4-tcm-queue-rank{color:#73737a!important}.r4-tcm-queue-name{font-weight:700;color:#eee!important}.r4-tcm-queue-reason{color:#a9a9b0!important;text-align:right}
.r4-tcm-table-wrap{overflow:auto;flex:1;min-height:0;margin-top:8px}.r4-tcm-table{width:100%;border-collapse:collapse;font-size:12px;color:#f4f4f4!important}.r4-tcm-table th,.r4-tcm-table td{padding:8px 6px;border-bottom:1px solid #333338;text-align:left;vertical-align:middle;color:#f4f4f4!important}.r4-tcm-table th{font-weight:700;background:#19191c;position:sticky;top:0;z-index:1;color:#bdbdc3!important}.r4-tcm-row-next{background:#27402155}.r4-tcm-row-ineligible{background:rgba(100,20,20,.13)}.r4-tcm-row-pending{background:rgba(120,93,20,.13)}.r4-tcm-row-toggle{border:0;background:transparent;color:#fff!important;text-align:left;cursor:pointer;padding:0}.r4-tcm-row-toggle strong{display:block}.r4-tcm-row-toggle .r4-tcm-muted{font-size:10px}.r4-tcm-row-reason{display:block;margin-top:3px;font-size:10px;color:#a7a7ad!important}.r4-tcm-row-actions{text-align:right!important;white-space:nowrap}.r4-tcm-hidden-action{position:absolute!important;width:1px!important;height:1px!important;overflow:hidden!important;clip:rect(0 0 0 0)!important;white-space:nowrap!important}.r4-tcm-detail-row[hidden]{display:none}.r4-tcm-detail-row td{background:#0e0e10!important}.r4-tcm-detail-grid{display:grid;grid-template-columns:repeat(3,minmax(100px,1fr));gap:8px 14px;padding:6px}.r4-tcm-detail-grid span{display:flex;flex-direction:column;color:#c8c8ce!important}.r4-tcm-detail-grid b{font-size:9px;letter-spacing:.06em;color:#7f7f86!important;text-transform:uppercase;margin-bottom:2px}
.r4-tcm-chip{display:inline-flex;align-items:center;border-radius:999px;padding:3px 7px;font-size:9px;font-weight:800;letter-spacing:.04em;border:1px solid transparent}.r4-tcm-chip-ok{color:#89e18c!important;background:#173c22;border-color:#2e673c}.r4-tcm-chip-next{color:#b7f5b9!important;background:#214d22;border-color:#438b4a}.r4-tcm-chip-paid{color:#efd591!important;background:#3f3315;border-color:#695824}.r4-tcm-chip-priority{color:#d9d3ff!important;background:#30284e;border-color:#51447b}.r4-tcm-chip-warn{color:#ffe397!important;background:#493a13;border-color:#77601d}.r4-tcm-chip-bad{color:#ffabab!important;background:#4b1e22;border-color:#79353a}.r4-tcm-chip-neutral{color:#d6d6dc!important;background:#2b2b30;border-color:#494950}
.r4-tcm-status-ok{color:#7cff4f!important;font-weight:700}.r4-tcm-status-bad{color:#ff6b6b!important;font-weight:700}.r4-tcm-status-warn{color:#ffe45c!important;font-weight:700}.r4-tcm-muted{color:#c7c7c7!important;opacity:1}.r4-tcm-reason{display:block;font-size:11px;margin-top:2px;color:#e8e8e8!important}.r4-tcm-manager strong{color:#fff!important}
.r4-tcm-btn{border:1px solid #50505a;border-radius:7px;padding:8px 11px;background:linear-gradient(180deg,#292930,#202027);color:#f4f4f4!important;cursor:pointer;font-weight:650;box-shadow:inset 0 1px 0 rgba(255,255,255,.035);transition:filter .14s ease,border-color .14s ease,transform .14s ease}.r4-tcm-btn:hover:not(:disabled){filter:brightness(1.12);border-color:#6b6b76}.r4-tcm-btn:disabled{opacity:.45;cursor:not-allowed}.r4-tcm-btn-primary{background:linear-gradient(180deg,#397c40,#2c6232);border-color:#438b4a}.r4-tcm-btn-danger{background:linear-gradient(180deg,#743134,#58262a);border-color:#8e4448}.r4-tcm-btn-warn{background:linear-gradient(180deg,#6b551b,#514013);border-color:#8a7027}.r4-tcm-actions{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
.r4-tcm-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.82);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;z-index:10000000;padding:16px}.r4-tcm-modal{width:min(560px,100%);max-height:92vh;overflow:auto;background:radial-gradient(circle at 90% 0,rgba(195,71,67,.1),transparent 32%),linear-gradient(180deg,#1b1b21,#101014);border:1px solid var(--vs-line-strong);border-radius:11px 11px 14px 14px;padding:16px;box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 24px 70px rgba(0,0,0,.78),0 0 26px rgba(195,71,67,.08);color:#f4f4f4!important}.r4-tcm-modal h3{margin:0 0 10px;color:#fff!important}.r4-tcm-modal input,.r4-tcm-modal select,.r4-tcm-modal textarea{width:100%;padding:9px 10px;background:#0c0c10;color:#eee!important;border:1px solid #4c4c57;border-radius:6px;margin:6px 0;outline:none}.r4-tcm-modal input:focus,.r4-tcm-modal select:focus,.r4-tcm-modal textarea:focus{border-color:#8a4744;box-shadow:0 0 0 2px rgba(195,71,67,.12)}.r4-tcm-modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}.r4-tcm-settings-row{margin:10px 0}.r4-tcm-settings-row label{display:block;font-weight:650;margin-bottom:3px}.r4-tcm-settings-check{display:flex;gap:8px;align-items:center}.r4-tcm-settings-check input{width:auto;margin:0}
.r4-tcm-settings{width:min(790px,calc(100vw - 32px));padding:0;overflow:hidden}.r4-tcm-settings-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:18px 20px 16px;border-bottom:1px solid var(--vs-line);background:linear-gradient(180deg,#222229,#17171c);box-shadow:inset 0 1px 0 rgba(255,255,255,.045)}.r4-tcm-settings-heading h3{font-size:21px;line-height:1.15;margin:3px 0 0!important;color:#fff!important}.r4-tcm-settings-heading .r4-tcm-eyebrow{color:#c4a09e!important}.r4-tcm-settings-layout{display:grid;grid-template-columns:190px minmax(0,1fr);min-height:450px;max-height:70vh}.r4-tcm-settings-nav{display:flex;flex-direction:column;gap:4px;padding:14px 10px;background:linear-gradient(180deg,#101014,#0b0b0e);border-right:1px solid var(--vs-line);overflow:auto}.r4-tcm-settings-tab{appearance:none;width:100%;min-height:38px;padding:9px 11px;border:1px solid transparent;border-radius:6px;background:transparent;color:#aaaab4!important;text-align:left;font:650 12px/1.2 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif!important;cursor:pointer;transition:background .14s ease,border-color .14s ease,color .14s ease}.r4-tcm-settings-tab:hover{background:#1b1b21;color:#fff!important;border-color:#2e2e36}.r4-tcm-settings-tab.is-active{background:linear-gradient(90deg,rgba(195,71,67,.23),rgba(195,71,67,.055));border-color:#5f3433;color:#fff!important;box-shadow:inset 3px 0 0 var(--vs-red),0 0 14px rgba(195,71,67,.06)}.r4-tcm-settings-panel{min-width:0;padding:22px 24px 26px;overflow:auto;background:linear-gradient(180deg,#17171c,#121216);color:#f4f4f4!important}.r4-tcm-settings-panel h4{font-size:18px;line-height:1.2;margin:0 0 18px;color:#fff!important;letter-spacing:.01em}.r4-tcm-settings-stack{display:flex;flex-direction:column;gap:13px;color:#ededf1!important}.r4-tcm-settings-stack>label{display:flex;flex-direction:column;gap:5px;color:#ededf1!important;font-size:12px;font-weight:650;line-height:1.3}.r4-tcm-settings-stack .r4-tcm-muted{font-size:11px;line-height:1.4;color:#aaaab3!important}.r4-tcm-settings-help{padding:10px 12px;border:1px solid #33333c;border-radius:7px;background:#101014;color:#b9b9c1!important;font-size:11px;line-height:1.45}.r4-tcm-policy-card{display:flex;flex-direction:column;gap:3px;padding:11px 12px;border:1px solid #35353f;border-radius:7px;background:linear-gradient(180deg,#1a1a20,#121217)}.r4-tcm-policy-card strong{color:#fff!important;font-size:12px}.r4-tcm-policy-card span{color:#b7b7bf!important;font-size:11px;line-height:1.4}.r4-tcm-settings-check{display:flex!important;flex-direction:row!important;align-items:flex-start!important;gap:9px!important;color:#ededf1!important}.r4-tcm-settings-check input{width:16px!important;height:16px!important;min-width:16px!important;margin:1px 0 0!important;accent-color:var(--vs-red)}.r4-tcm-settings-panel .r4-tcm-btn{align-self:flex-start;min-width:130px}.r4-tcm-settings-panel .r4-tcm-btn+.r4-tcm-btn{margin-top:-5px}.r4-tcm-balanced-options,.r4-tcm-custom-notifications{display:flex;flex-direction:column;gap:11px;padding:12px;border:1px solid #34343d;border-radius:7px;background:#101014}.r4-tcm-balanced-options[hidden],.r4-tcm-custom-notifications[hidden]{display:none!important}
.r4-tcm-employee-action-sheet{width:min(430px,calc(100vw - 24px));padding:0;overflow:hidden}.r4-tcm-action-sheet-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:17px 18px 14px;border-bottom:1px solid var(--vs-line);background:linear-gradient(180deg,#222229,#17171c);box-shadow:inset 0 1px 0 rgba(255,255,255,.045)}.r4-tcm-action-sheet-head h3{margin:3px 0 0!important;font-size:21px;color:#fff!important}.r4-tcm-action-sheet-head p{margin:5px 0 0;color:#aaaab3!important;font-size:11px;line-height:1.35}.r4-tcm-action-sheet-actions{display:grid;grid-template-columns:1fr;gap:8px;padding:15px 16px;background:linear-gradient(180deg,#16161b,#111115)}.r4-tcm-action-sheet-actions .r4-tcm-btn{width:100%;min-height:48px;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:2px;text-align:left;padding:8px 12px}.r4-tcm-action-sheet-actions .r4-tcm-btn span{color:#fff!important;font-size:12px;font-weight:750}.r4-tcm-action-sheet-actions .r4-tcm-btn small{color:#a9a9b2!important;font-size:10px;font-weight:500;line-height:1.25}.r4-tcm-action-sheet-actions .r4-tcm-btn-warn small{color:#f1dca3!important}.r4-tcm-action-sheet-footer{padding:10px 16px;border-top:1px solid #303038;background:#0f0f13;text-align:right}.r4-tcm-action-sheet-footer .r4-tcm-link-btn{font-size:11px}
.r4-tcm-audit-panel{width:min(920px,96vw);max-height:90vh;display:flex;flex-direction:column;overflow:hidden;background:#18181b;border:1px solid #555;border-radius:10px;padding:14px;box-shadow:0 12px 40px #000;color:#f4f4f4!important}.r4-tcm-audit-filters{display:grid;grid-template-columns:minmax(130px,1fr) minmax(160px,1fr) minmax(180px,2fr);gap:10px;margin:12px 0}.r4-tcm-audit-filters label{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:700;color:#e8e8e8!important}.r4-tcm-audit-filters select,.r4-tcm-audit-filters input{width:100%;padding:7px 8px;border:1px solid #555;border-radius:5px;background:#111;color:#f4f4f4!important}.r4-tcm-audit-table-wrap{max-height:58vh;overflow:auto;flex:1 1 auto}.r4-tcm-audit-details{max-width:410px;font:11px/1.45 Consolas,Monaco,monospace;overflow-wrap:anywhere;white-space:normal}
.r4-tcm-badge{position:fixed;right:18px;bottom:18px;width:250px;background:linear-gradient(180deg,#1b1b20f5,#101014f5);border:1px solid var(--vs-line-strong);border-radius:10px;z-index:999999;padding:10px;box-shadow:inset 0 1px 0 rgba(255,255,255,.04),0 8px 25px #000b}.r4-tcm-badge-head{display:flex;justify-content:space-between;align-items:center;cursor:move;font-weight:700}.r4-tcm-badge-body{margin-top:8px;font-size:12px;line-height:1.5}.r4-tcm-badge.r4-tcm-collapsed .r4-tcm-badge-body{display:none}
.r4-tcm-floating-shell{z-index:999999!important;resize:both;overflow:hidden;min-width:420px;min-height:280px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px)}.r4-tcm-floating-shell .r4-tcm-header{cursor:grab;user-select:none}.r4-tcm-floating-shell.r4-tcm-locked .r4-tcm-header{cursor:default}.r4-tcm-floating-shell .r4-tcm-window-btn{cursor:pointer;user-select:none}.r4-tcm-floating-shell.r4-tcm-maximized{max-width:none;max-height:none}.r4-tcm-floating-shell.r4-tcm-minimized{display:none!important}
@media(max-width:720px){.r4-tcm-floating-shell{min-width:0;width:calc(100vw - 12px)!important;left:6px!important}.r4-tcm-metrics{grid-template-columns:repeat(3,1fr)}.r4-tcm-primary-name{font-size:21px}.r4-tcm-queue li{grid-template-columns:22px minmax(80px,1fr)}.r4-tcm-queue-reason{grid-column:2;text-align:left;font-size:10px}.r4-tcm-table thead{display:none}.r4-tcm-table,.r4-tcm-table tbody{display:block}.r4-tcm-table tr:not(.r4-tcm-detail-row){display:grid;grid-template-columns:1fr auto;gap:5px;border:1px solid #343438;border-radius:9px;margin:7px 0;padding:9px}.r4-tcm-table tr:not(.r4-tcm-detail-row) td{display:block;border:0;padding:2px}.r4-tcm-table tr:not(.r4-tcm-detail-row) td:nth-child(2){grid-column:1}.r4-tcm-table tr:not(.r4-tcm-detail-row) td:nth-child(3){grid-column:1}.r4-tcm-table tr:not(.r4-tcm-detail-row) td:nth-child(4){grid-column:2;grid-row:1/4}.r4-tcm-icon-btn,.r4-tcm-window-btn{min-width:40px;height:40px}.r4-tcm-detail-grid{grid-template-columns:repeat(2,minmax(100px,1fr))}.r4-tcm-audit-filters{grid-template-columns:1fr}.r4-tcm-audit-panel{width:98vw;max-height:94vh}.r4-tcm-audit-details{max-width:240px}.r4-tcm-settings{width:calc(100vw - 12px);max-height:95vh}.r4-tcm-settings-heading{padding:15px}.r4-tcm-settings-layout{display:block;max-height:none}.r4-tcm-settings-nav{flex-direction:row;gap:5px;overflow-x:auto;padding:8px;border-right:0;border-bottom:1px solid var(--vs-line);white-space:nowrap}.r4-tcm-settings-tab{width:auto;min-width:max-content;padding:8px 10px}.r4-tcm-settings-tab.is-active{box-shadow:inset 0 -3px 0 var(--vs-red)}.r4-tcm-settings-panel{padding:16px;max-height:66vh}.r4-tcm-employee-action-sheet{width:calc(100vw - 16px)}}
@media(prefers-reduced-motion:reduce){.r4-tcm-manager,.r4-tcm-window-btn,.r4-tcm-icon-btn,.r4-tcm-train-primary,.r4-tcm-settings-tab{transition:none!important}}
`;
  function injectStyles(documentRef = globalThis.document) {
    if (!documentRef?.head || documentRef.getElementById?.("r4-tcm-styles")) return;
    const style = documentRef.createElement("style");
    style.id = "r4-tcm-styles";
    style.textContent = TCM_STYLES;
    documentRef.head.appendChild(style);
  }

  // src/main.js
  var MutableApiClient = class {
    constructor({ transport, apiKey = "", nowSeconds }) {
      this.transport = transport;
      this.nowSeconds = nowSeconds;
      this.setApiKey(apiKey);
    }
    setApiKey(key) {
      this.apiKey = String(key || "").trim();
      this.client = this.apiKey ? new TornApiClient({ transport: this.transport, apiKey: this.apiKey, nowSeconds: this.nowSeconds }) : null;
    }
    #needClient() {
      if (!this.client) throw new Error("API key required");
      return this.client;
    }
    getEmployees(...args) {
      return this.#needClient().getEmployees(...args);
    }
    getProfile(...args) {
      return this.#needClient().getProfile(...args);
    }
    getTrainingNewsSince(...args) {
      return this.#needClient().getTrainingNewsSince(...args);
    }
    rebuildTrainingNews(...args) {
      return this.#needClient().rebuildTrainingNews(...args);
    }
    validateCapabilities(...args) {
      return this.#needClient().validateCapabilities(...args);
    }
  };
  function directUserscriptGrants() {
    return {
      GM_getValue: typeof GM_getValue === "function" ? GM_getValue : null,
      GM_setValue: typeof GM_setValue === "function" ? GM_setValue : null,
      GM_deleteValue: typeof GM_deleteValue === "function" ? GM_deleteValue : null,
      GM_xmlhttpRequest: typeof GM_xmlhttpRequest === "function" ? GM_xmlhttpRequest : null,
      GM_registerMenuCommand: typeof GM_registerMenuCommand === "function" ? GM_registerMenuCommand : null
    };
  }
  function directUserscriptInfo() {
    try {
      return typeof GM_info === "object" && GM_info ? GM_info : null;
    } catch {
      return null;
    }
  }
  function resolveUserscriptGrant(name, { globalRef = globalThis, directGrants = directUserscriptGrants() } = {}) {
    const direct = directGrants?.[name];
    if (typeof direct === "function") return direct;
    try {
      const value = globalRef?.[name];
      return typeof value === "function" ? value : null;
    } catch {
      return null;
    }
  }
  function resolveScriptVersion({ globalRef = globalThis, directInfo = directUserscriptInfo() } = {}) {
    let info = directInfo;
    if (!info) {
      try {
        info = globalRef?.GM_info ?? null;
      } catch {
        info = null;
      }
    }
    const version = info?.script?.version;
    return typeof version === "string" && version.trim() ? version.trim() : "unknown";
  }
  function makeDefaultGmAdapter() {
    const getValue = resolveUserscriptGrant("GM_getValue");
    const setValue = resolveUserscriptGrant("GM_setValue");
    const deleteValue = resolveUserscriptGrant("GM_deleteValue");
    if (!getValue || !setValue || !deleteValue) throw new Error("Userscript storage APIs are unavailable");
    return {
      getValue: (key, fallback) => getValue(key, fallback),
      setValue: (key, value) => setValue(key, value),
      deleteValue: (key) => deleteValue(key)
    };
  }
  function hrefOf(windowRef) {
    const loc = windowRef?.location;
    if (!loc) return "https://www.torn.com/";
    return loc.href || String(loc);
  }
  function isEmployeesTabActive(windowRef, documentRef) {
    try {
      const panel = documentRef?.getElementById?.("employees");
      if (panel) {
        const rects = panel.getClientRects?.();
        const hasVisibleRects = !rects || typeof rects.length !== "number" || rects.length > 0;
        const style = windowRef?.getComputedStyle?.(panel);
        if (hasVisibleRects && (!style || style.display !== "none")) return true;
      }
      const anchor = documentRef?.querySelector?.('a[href="#employees"], a.ui-tabs-anchor[href="#employees"], li[aria-controls="employees"] a');
      const item = anchor?.closest?.('li,[role="tab"]') || documentRef?.querySelector?.('li[aria-controls="employees"], [role="tab"][aria-controls="employees"]');
      if (!item) return false;
      return item.getAttribute?.("aria-selected") === "true" || /\b(ui-tabs-active|ui-state-active)\b/.test(String(item.className || ""));
    } catch {
      return false;
    }
  }
  function isJobCompanyArea(windowRef, _documentRef) {
    let url;
    try {
      url = new URL(hrefOf(windowRef));
    } catch {
      return false;
    }
    if (!/\/companies\.php$/i.test(url.pathname)) return false;
    const step = url.searchParams.get("step");
    return !step || step === "your";
  }
  function isCompanyEmployeesPage(windowRef, documentRef) {
    let url;
    try {
      url = new URL(hrefOf(windowRef));
    } catch {
      return false;
    }
    if (!/\/companies\.php$/i.test(url.pathname)) return false;
    const step = url.searchParams.get("step");
    if (step && step !== "your") return false;
    const hash = String(url.hash || "").toLowerCase();
    const explicitEmployeeRoute = hash.includes("employee") || url.searchParams.get("tab") === "employees";
    if (explicitEmployeeRoute) return true;
    if (isEmployeesTabActive(windowRef, documentRef)) return true;
    return Boolean(documentRef?.querySelector?.('ul.employee-list li[data-user] .train button.torn-btn, ul.employee-list li[data-user] .train .train-action, a[href*="step=trainemp2"], a[href*="step=kickemp"]'));
  }
  function exactEmployeeRow(documentRef, employeeId) {
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0) return null;
    for (const selector of [
      `ul.employee-list li[data-user="${id}"]`,
      `li[data-user="${id}"]`,
      `tr[data-user="${id}"]`,
      `[data-employee-id="${id}"]`
    ]) {
      try {
        const row = documentRef?.querySelector?.(selector);
        if (row) return row;
      } catch {
      }
    }
    return null;
  }
  function employeeTabControl(documentRef) {
    const selectors = [
      'a[href="#employees"]',
      'a.ui-tabs-anchor[href="#employees"]',
      'li[aria-controls="employees"] a',
      'a[href*="#/option=employees"]',
      'a[href*="option=employees"]',
      '[role="tab"][aria-controls="employees"]'
    ];
    for (const selector of selectors) {
      try {
        const node = documentRef?.querySelector?.(selector);
        if (node?.click) return node;
      } catch {
      }
    }
    return null;
  }
  async function prepareEmployeeTabForTraining({ employeeId, documentRef, windowRef, sleep, maxAttempts = 50 }) {
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0) throw new Error("Invalid employee ID");
    if (!isJobCompanyArea(windowRef, documentRef)) throw new Error("Open Job / Company before training an employee");
    if (exactEmployeeRow(documentRef, id)) return;
    const tab = employeeTabControl(documentRef);
    if (!tab) throw new Error("Could not open Torn's Employees tab automatically");
    tab.click();
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (exactEmployeeRow(documentRef, id)) return;
      await sleep(100);
    }
    throw new Error("Torn's Employees tab did not render the selected employee in time");
  }
  async function defaultMountCompanyUi({ documentRef, windowRef, state, actions, uiStorage, ResizeObserverImpl }) {
    if (!documentRef?.createElement || !documentRef?.body) return { update() {
    }, destroy() {
    }, toggleMinimize: async () => {
    }, restore: async () => {
    }, isMinimized: () => false };
    let root = documentRef.getElementById?.("r4-tcm-company-root");
    if (!root) {
      root = documentRef.createElement("div");
      root.id = "r4-tcm-company-root";
      documentRef.body.appendChild(root);
    }
    renderCompanyManager(root, state, actions);
    const windowHandle = await attachManagerWindow({ root, uiStorage, windowRef, ResizeObserverImpl });
    return {
      update(nextState) {
        renderCompanyManager(root, nextState, actions);
        windowHandle?.sync?.();
      },
      toggleMinimize: () => windowHandle?.toggleMinimize?.(),
      restore: () => windowHandle?.restore?.(),
      isMinimized: () => windowHandle?.isMinimized?.() === true,
      destroy() {
        windowHandle?.destroy?.();
        root.remove?.();
      }
    };
  }
  function managerUrlFor(windowRef) {
    try {
      const current = new URL(hrefOf(windowRef));
      const type = current.searchParams.get("type");
      return type ? `https://www.torn.com/companies.php?step=your&type=${encodeURIComponent(type)}#employees` : "https://www.torn.com/companies.php?step=your#employees";
    } catch {
      return "https://www.torn.com/companies.php?step=your#employees";
    }
  }
  async function copyText(text, { windowRef }) {
    const navigatorRef = windowRef?.navigator ?? globalThis.navigator;
    if (navigatorRef?.clipboard?.writeText) {
      await navigatorRef.clipboard.writeText(text);
      return;
    }
    windowRef?.prompt?.("Copy Training Manager data", text);
  }
  function downloadJson(payload, { documentRef, windowRef }) {
    try {
      const BlobImpl = windowRef?.Blob ?? globalThis.Blob;
      const URLImpl = windowRef?.URL ?? globalThis.URL;
      if (!BlobImpl || !URLImpl?.createObjectURL || !documentRef?.createElement) return false;
      const blob = new BlobImpl([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URLImpl.createObjectURL(blob);
      const link = documentRef.createElement("a");
      link.href = url;
      link.download = backupDownloadName(Date.now());
      link.style.display = "none";
      documentRef.body?.appendChild?.(link);
      link.click?.();
      link.remove?.();
      URLImpl.revokeObjectURL?.(url);
      return true;
    } catch {
      return false;
    }
  }
  function showDiagnosticsModal(diagnostics, { documentRef, windowRef }) {
    if (!documentRef?.createElement || !documentRef?.body) return null;
    const backdrop = documentRef.createElement("div");
    backdrop.className = "r4-tcm-modal-backdrop";
    const modal = documentRef.createElement("div");
    modal.className = "r4-tcm-modal";
    const heading = documentRef.createElement("h3");
    heading.textContent = "Diagnostics / Self-Test";
    const pre = documentRef.createElement("pre");
    pre.className = "r4-tcm-diagnostics-pre";
    pre.textContent = JSON.stringify(diagnostics, null, 2);
    const actions = documentRef.createElement("div");
    actions.className = "r4-tcm-actions";
    const copy = documentRef.createElement("button");
    copy.className = "r4-tcm-btn";
    copy.textContent = "Copy Diagnostics";
    const close = documentRef.createElement("button");
    close.className = "r4-tcm-btn";
    close.textContent = "Close";
    copy.addEventListener?.("click", () => void copyText(pre.textContent, { windowRef }));
    close.addEventListener?.("click", () => backdrop.remove?.());
    actions.appendChild(copy);
    actions.appendChild(close);
    modal.appendChild(heading);
    modal.appendChild(pre);
    modal.appendChild(actions);
    backdrop.appendChild(modal);
    documentRef.body.appendChild(backdrop);
    return backdrop;
  }
  async function chooseImportFile({ documentRef, windowRef }) {
    if (!documentRef?.createElement) return null;
    return new Promise((resolve) => {
      const input = documentRef.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.style.display = "none";
      input.addEventListener?.("change", async () => {
        try {
          resolve(input.files?.[0] ? await input.files[0].text() : null);
        } catch {
          resolve(null);
        }
        input.remove?.();
      });
      documentRef.body?.appendChild?.(input);
      input.click?.();
      if (!input.addEventListener) resolve(windowRef?.prompt?.("Paste Training Manager backup JSON") ?? null);
    });
  }
  function tomorrowStartSeconds(nowSeconds) {
    const date = new Date(Number(nowSeconds) * 1e3);
    date.setHours(24, 0, 0, 0);
    return Math.floor(date.getTime() / 1e3);
  }
  async function bootstrap(deps = {}) {
    const windowRef = deps.windowRef ?? globalThis.window;
    const documentRef = deps.documentRef ?? globalThis.document;
    const setIntervalImpl = deps.setIntervalImpl ?? globalThis.setInterval?.bind(globalThis);
    const clearIntervalImpl = deps.clearIntervalImpl ?? globalThis.clearInterval?.bind(globalThis);
    const setTimeoutImpl = deps.setTimeoutImpl ?? globalThis.setTimeout?.bind(globalThis);
    const clearTimeoutImpl = deps.clearTimeoutImpl ?? globalThis.clearTimeout?.bind(globalThis);
    const MutationObserverImpl = deps.MutationObserverImpl ?? globalThis.MutationObserver;
    const ResizeObserverImpl = deps.ResizeObserverImpl ?? globalThis.ResizeObserver;
    const injectStylesImpl = deps.injectStylesImpl ?? injectStyles;
    const mountCompanyUi = deps.mountCompanyUi ?? defaultMountCompanyUi;
    const mountManagerDockImpl = deps.mountManagerDockImpl ?? mountManagerDock;
    const registerMenuCommandImpl = deps.registerMenuCommandImpl ?? resolveUserscriptGrant("GM_registerMenuCommand");
    const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1e3));
    const trainPreparationSleep = deps.trainPreparationSleep ?? ((ms) => new Promise((resolve) => {
      const handle = setTimeoutImpl?.(resolve, ms);
      if (handle == null) resolve();
    }));
    injectStylesImpl(documentRef);
    injectNativeIndicatorStyles(documentRef);
    let storage = deps.storage;
    let mutableApi = deps.mutableApi;
    let controller = deps.controller;
    let pageActions = deps.pageActions;
    if (!controller) {
      storage = storage ?? new StorageRepo(deps.gmAdapter ?? makeDefaultGmAdapter());
      const apiKey = await storage.getApiKey();
      const transport = deps.transport ?? createGmTransport(deps.gmXmlhttpRequest ?? resolveUserscriptGrant("GM_xmlhttpRequest"));
      mutableApi = mutableApi ?? new MutableApiClient({ transport, apiKey, nowSeconds });
      pageActions = pageActions ?? new CompanyPageActions({ document: documentRef, fetchImpl: deps.fetchImpl ?? globalThis.fetch?.bind(globalThis) });
      controller = new TrainingManagerController3({ api: mutableApi, storage, pageActions, nowSeconds });
    }
    await controller.initialize();
    const present = (raw = controller.getState()) => ({
      ...raw,
      attention: filterAttentionItems(deriveAttentionItems(raw), raw?.settings || {})
    });
    const diagnosticsSnapshot = () => ({ scriptVersion: resolveScriptVersion(), ...controller.getDiagnostics?.() ?? {} });
    const openAuditLog = async () => {
      const audit = await controller.getAudit?.() ?? { entries: [] };
      return renderAuditLogModal({ entries: audit?.entries || [], documentRef, onClear: () => controller.clearAudit?.() ?? { entries: [] } });
    };
    const settingsFacade = {
      updateSettings: (patch) => controller.updateSettings?.(patch),
      rebuildHistory: () => controller.rebuildHistory?.(),
      refresh: () => controller.refresh?.(),
      getState: () => present(controller.getState?.()),
      getApiKey: () => storage?.getApiKey?.() ?? "",
      setApiKey: async (key) => {
        await storage?.setApiKey?.(key);
        mutableApi?.setApiKey?.(key);
      },
      clearApiKey: async () => {
        await storage?.clearApiKey?.();
        mutableApi?.setApiKey?.("");
        await controller.refresh?.();
      },
      resetNonKeyData: async () => {
        await storage?.resetNonKeyData?.();
        try {
          windowRef?.location?.reload?.();
        } catch {
        }
      },
      createPaidAgreement: (...args) => controller.createPaidAgreement?.(...args),
      amendPaidAgreement: (...args) => controller.amendPaidAgreement?.(...args),
      pausePaidAgreement: (...args) => controller.pausePaidAgreement?.(...args),
      resumePaidAgreement: (...args) => controller.resumePaidAgreement?.(...args),
      reorderPaidAgreements: (...args) => controller.reorderPaidAgreements?.(...args),
      closePaidAgreement: (...args) => controller.closePaidAgreement?.(...args)
    };
    const exportData = async () => {
      const payload = await exportNonSecretState(storage, { includeAudit: true, nowSeconds: nowSeconds() });
      if (!downloadJson(payload, { documentRef, windowRef })) await copyText(JSON.stringify(payload, null, 2), { windowRef });
    };
    const importData = async () => {
      const text = await chooseImportFile({ documentRef, windowRef });
      if (!text) return;
      const payload = parseImportText(text);
      const preview = previewImport(payload);
      const summary = importPreviewHtml(preview).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const ok = windowRef?.confirm ? windowRef.confirm(`${summary}

Import this backup?`) : false;
      if (!ok) return;
      await applyImport(storage, payload);
      try {
        windowRef?.location?.reload?.();
      } catch {
      }
    };
    let actions;
    const openSettings = (activeSection = "general") => renderSettingsModal(present(controller.getState()), settingsFacade, {
      documentRef,
      activeSection,
      openAuditLog,
      openDiagnostics: () => showDiagnosticsModal(diagnosticsSnapshot(), { documentRef, windowRef }),
      exportData,
      importData
    });
    const createPaidForEmployee = async (employee) => {
      const raw = windowRef?.prompt?.(`How many paid trains did ${employee.name} purchase?`, "10");
      if (raw == null) return;
      const trainsPurchased = Number(raw);
      if (!Number.isInteger(trainsPurchased) || trainsPurchased <= 0) throw new TypeError("Paid trains must be a positive whole number");
      await controller.createPaidAgreement?.({ employeeId: Number(employee.id), employeeName: employee.name, trainsPurchased });
    };
    const skipEmployee = async (employeeId) => {
      const choice = String(windowRef?.prompt?.("Skip employee: next, tomorrow, hours, or manual", "next") ?? "").trim().toLowerCase();
      if (!choice) return;
      if (choice === "next") return controller.skipEmployee?.(employeeId, { mode: "next_rotation" });
      if (choice === "tomorrow") return controller.skipEmployee?.(employeeId, { mode: "until_tomorrow", until: tomorrowStartSeconds(nowSeconds()) });
      if (choice === "manual") return controller.skipEmployee?.(employeeId, { mode: "manual" });
      const hours = Number(choice.replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(hours) || hours <= 0) throw new TypeError("Custom skip must be a positive number of hours");
      return controller.skipEmployee?.(employeeId, { mode: "timed", until: nowSeconds() + Math.round(hours * 3600) });
    };
    const trainingPreparationLocks = /* @__PURE__ */ new Set();
    const prepareAndTrain = async (id, options) => {
      const employeeId = Number(id);
      if (!Number.isInteger(employeeId) || employeeId <= 0) throw new Error("Invalid employee ID");
      if (trainingPreparationLocks.has(employeeId)) throw new Error("Training preparation is already in progress for this employee");
      trainingPreparationLocks.add(employeeId);
      try {
        await prepareEmployeeTabForTraining({
          employeeId,
          documentRef,
          windowRef,
          sleep: trainPreparationSleep
        });
        return await controller.trainEmployee?.(employeeId, options);
      } finally {
        trainingPreparationLocks.delete(employeeId);
      }
    };
    actions = {
      refresh: () => controller.refresh?.(),
      trainEmployee: (id, options) => prepareAndTrain(id, options),
      dockPay: (id, wage) => controller.dockPay?.(id, wage),
      restorePay: (id, options) => controller.restorePay?.(id, options),
      getRestoreStateFor: (id) => controller.getRestoreStateFor?.(id),
      getDiagnostics: diagnosticsSnapshot,
      copyDiagnostics: async () => copyText(JSON.stringify(diagnosticsSnapshot(), null, 2), { windowRef }),
      openAuditLog,
      openSettings: () => openSettings("general"),
      openAttention: () => renderAttentionModal(present(controller.getState()).attention, { documentRef }),
      showWhy: (_id, reason) => windowRef?.alert?.(`Training Manager: ${reason}`),
      openEmployeeMenu: (employee, state) => renderEmployeeMenu(employee, state, {
        train: (id, options) => prepareAndTrain(id, options),
        priorityOnce: (id) => controller.setPriorityOnce?.(id),
        createPaid: createPaidForEmployee,
        openPaidSettings: () => openSettings("paid"),
        skip: skipEmployee,
        copy: (text) => copyText(text, { windowRef }),
        dock: async (target) => {
          const raw = windowRef?.prompt?.(`Temporary daily pay for ${target.name}`, String(target.wage ?? 0));
          if (raw == null) return;
          const amount = Number(raw);
          if (!Number.isInteger(amount) || amount < 0) throw new TypeError("Daily pay must be zero or a positive whole number");
          return controller.dockPay?.(target.id, amount);
        },
        details: () => {
        },
        onError: (error) => actions.onError(error)
      }, { documentRef, windowRef }),
      onError: (error) => {
        const message = String(error?.message || error || "Training Manager action failed");
        try {
          windowRef?.alert?.(`Training Manager: ${message}`);
        } catch {
        }
      }
    };
    try {
      registerMenuCommandImpl?.("Company Training Manager: Settings", actions.openSettings);
    } catch {
    }
    let mounted = null;
    let mode = "none";
    let destroyed = false;
    let routeTimer = null;
    let intervalId = null;
    let intervalMinutes = null;
    let managerDock = null;
    const destroyMounted = () => {
      mounted?.destroy?.();
      mounted = null;
      mode = "none";
    };
    const desiredMode = () => isJobCompanyArea(windowRef, documentRef) ? "company" : "none";
    const updateNativeIndicators = (state) => {
      if (isCompanyEmployeesPage(windowRef, documentRef)) mountNativeTrainingIndicators({ documentRef, state });
      else mountNativeTrainingIndicators({ documentRef, state: { ...state, settings: { ...state.settings || {}, showNativeTrainingBadges: false } } });
    };
    const evaluateRoute = async (rawState = controller.getState()) => {
      if (destroyed) return;
      const state = present(rawState);
      updateNativeIndicators(state);
      const desired = desiredMode();
      if (desired === mode) {
        mounted?.update?.(state);
        managerDock?.update?.(state, { managerOpen: desired === "company" ? !mounted?.isMinimized?.() : false });
        return;
      }
      destroyMounted();
      mode = desired;
      if (desired === "company") mounted = await mountCompanyUi({ documentRef, windowRef, state, controller, actions, uiStorage: storage, ResizeObserverImpl });
      managerDock?.update?.(state, { managerOpen: desired === "company" ? !mounted?.isMinimized?.() : false });
    };
    managerDock = mountManagerDockImpl({
      documentRef,
      windowRef,
      state: present(controller.getState()),
      managerUrl: managerUrlFor(windowRef),
      MutationObserverImpl,
      onToggle: async () => {
        if (mode === "company" && mounted?.toggleMinimize) {
          await mounted.toggleMinimize();
          managerDock?.update?.(present(controller.getState()), { managerOpen: !mounted?.isMinimized?.() });
          return;
        }
        try {
          windowRef.location.href = managerUrlFor(windowRef);
        } catch {
        }
      }
    });
    const ensureInterval = (rawState = controller.getState()) => {
      const minutes = Number(rawState?.settings?.refreshMinutes) || 5;
      if (intervalId && intervalMinutes === minutes) return;
      if (intervalId) clearIntervalImpl?.(intervalId);
      intervalMinutes = minutes;
      intervalId = setIntervalImpl?.(() => controller.refresh?.(), minutes * 6e4) ?? null;
    };
    const unsubscribe = controller.subscribe?.((rawState) => {
      const state = present(rawState);
      updateNativeIndicators(state);
      managerDock?.update?.(state, { managerOpen: mode === "company" ? !mounted?.isMinimized?.() : false });
      ensureInterval(rawState);
      void evaluateRoute(rawState);
    }) ?? (() => {
    });
    ensureInterval(controller.getState());
    await evaluateRoute(controller.getState());
    managerDock?.update?.(present(controller.getState()), { managerOpen: mode === "company" ? !mounted?.isMinimized?.() : false });
    const observer = MutationObserverImpl ? new MutationObserverImpl(() => {
      if (routeTimer) clearTimeoutImpl?.(routeTimer);
      routeTimer = setTimeoutImpl?.(() => {
        routeTimer = null;
        void evaluateRoute(controller.getState());
      }, 250) ?? null;
    }) : null;
    observer?.observe?.(documentRef?.body ?? documentRef?.documentElement, { childList: true, subtree: true });
    const onUnload = () => {
      if (intervalId) clearIntervalImpl?.(intervalId);
      if (routeTimer) clearTimeoutImpl?.(routeTimer);
      observer?.disconnect?.();
    };
    windowRef?.addEventListener?.("beforeunload", onUnload);
    return {
      controller,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        onUnload();
        unsubscribe();
        managerDock?.destroy?.();
        mountNativeTrainingIndicators({ documentRef, state: { settings: { showNativeTrainingBadges: false } } });
        destroyMounted();
        windowRef?.removeEventListener?.("beforeunload", onUnload);
      }
    };
  }
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    bootstrap().catch((error) => {
      console.error("[TCM] Failed to start:", error?.message || "Unknown error");
    });
  }
})();
