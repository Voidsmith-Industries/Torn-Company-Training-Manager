import { SCHEMA_VERSION } from "./constants.js";

export function emptyHistoryState() {
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

function decodeBasicEntities(text) {
  return text
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

function stripTags(html) {
  let value = toText(html);
  for (let pass = 0; pass < 4; pass += 1) {
    const decoded = decodeBasicEntities(value);
    const stripped = decoded.replace(/<[^>]*>/g, "");
    if (stripped === value) {
      value = stripped;
      break;
    }
    value = stripped;
  }
  return value.replace(/\s+/g, " ").trim();
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
      // Regex fallback below.
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
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

function normalizeTimestamp(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

export function parseTrainingNewsItem(news = {}) {
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

export function mergeTrainingNews(historyState, newsItems = []) {
  const base = historyState && typeof historyState === "object" ? historyState : emptyHistoryState();
  const next = {
    schemaVersion: SCHEMA_VERSION,
    eventsByNewsId: { ...(base.eventsByNewsId || {}) },
    unresolvedByNewsId: { ...(base.unresolvedByNewsId || {}) },
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

export function summarizeTrainingHistory(historyState, currentEmployees = []) {
  const byEmployee = new Map();
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
