import { escapeHtml, formatMoney, formatDateTime, formatDuration, byId } from "./dom.js";
import { showConfirmModal, showNumberPrompt } from "./modals.js";


// Read-only release discovery. Never send company or player data to the website.
const release = { checked: false, label: "Checking…", href: null, updated: false, activeRoot: null };
function releaseVersion(value) {
  const bits = String(value ?? "").replace(/^v/i, "").split(".");
  if (bits.length !== 3 || bits.some(bit => !/^\d+$/.test(bit))) return null;
  return bits.map(Number);
}
function showReleaseStatus(root) {
  const link = root?.querySelector?.("[data-tcm-release-status]");
  if (!link) return;
  link.textContent = release.label;
  link.title = release.label;
  const url = release.href;
  if (url) { link.href = url; link.setAttribute("target", "_blank"); link.setAttribute("rel", "noopener noreferrer"); }
  else { link.href = "https://voidsmithindustries.com/torn/scripts.html"; }
  link.style.borderColor = release.updated ? "#e7b04c" : release.checked && release.label === "Up to date" ? "#69be85" : "";
}
function checkReleaseStatus(root) {
  release.activeRoot = root;
  showReleaseStatus(root);
  if (release.checked) return;
  release.checked = true;
  const request = typeof GM_xmlhttpRequest === "function" ? GM_xmlhttpRequest : globalThis.GM_xmlhttpRequest;
  if (typeof request !== "function") { release.label = "Check updates"; showReleaseStatus(root); return; }
  request({
    method: "GET", url: "https://voidsmithindustries.com/torn/data/scripts.json", timeout: 12000, anonymous: true, withCredentials: false,
    onload: ({ status, responseText }) => {
      try {
        if (status !== 200) throw Error("No release data");
        const items = JSON.parse(responseText);
        const item = Array.isArray(items) && items.find(x => x?.id === "company-training-manager");
        if (!item || !["Live","Beta"].includes(item.status) || item.publication?.status !== "approved" || item.publication?.installApproved !== true) throw Error("No approved release");
        const current = releaseVersion(globalThis.GM_info?.script?.version);
        const newest = releaseVersion(item.version);
        if (!current || !newest) throw Error("Invalid version");
        const outdated = current.findIndex((part,i) => part !== newest[i]);
        const needsUpdate = outdated >= 0 && current[outdated] < newest[outdated];
        if (needsUpdate) {
          const target = new URL(item.installUrl);
          if (target.origin !== "https://voidsmithindustries.com" || target.pathname !== "/torn/install/company-training-manager.user.js" || target.search || target.hash || target.username || target.password) throw Error("Untrusted installer");
          release.href = target.href;
          release.label = "Update available · v" + item.version;
          release.updated = true;
        } else { release.label = "Up to date"; }
      } catch { release.label = "Check updates"; }
      showReleaseStatus(release.activeRoot);
    },
    onerror: () => { release.label = "Check updates"; showReleaseStatus(release.activeRoot); },
    ontimeout: () => { release.label = "Check updates"; showReleaseStatus(release.activeRoot); }
  });
}

function pendingTrainReceipt(state, id) {
  return state?.trainReceipts?.receiptsByEmployeeId?.[id]
    ?? state?.trainReceipts?.receiptsByEmployeeId?.[String(id)]
    ?? null;
}

function activeDock(payroll, id) {
  const record = payroll?.recordsByEmployeeId?.[id] ?? payroll?.recordsByEmployeeId?.[String(id)];
  return record && record.dockVerifiedAt && record.restoredAt == null ? record : null;
}

function actionBusy(state) {
  return ["preflight", "pending", "accepted", "awaiting_verification"].includes(state.action?.status);
}

function employeeById(state, id) {
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
  if (source === "paid" && paid) return `Paid priority · ${paid.trainsRemaining} remaining`;
  if (source === "priority_once") return "Director priority · once";
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
  if (isNext && paid) return `<span class="r4-tcm-chip r4-tcm-chip-paid">PAID · NEXT</span>`;
  if (isNext) return `<span class="r4-tcm-chip r4-tcm-chip-next">NEXT</span>`;
  if (paid?.status === "auto-paused" || paid?.status === "manually-paused") return `<span class="r4-tcm-chip r4-tcm-chip-warn">PAID · PAUSED</span>`;
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
    const remaining = Math.max(0, (72 * 3600) - Number(eligibility.tenureSeconds || 0));
    return `New hire · eligible in ${formatDuration(remaining)}`;
  }
  if (eligibility.unverified) return "Eligibility could not be verified";
  const reasons = [];
  if (eligibility.inactive) reasons.push(`Inactive ${formatDuration(eligibility.inactivitySeconds)}`);
  if (eligibility.addictionViolation) reasons.push(`Addiction ${eligibility.reasons?.find?.((r) => r.code === "addiction")?.actual ?? "?"} > ${settings?.maxAddiction ?? "?"}`);
  return reasons.join(" · ") || "Not eligible";
}

function actionFeedback(state) {
  const action = state?.action;
  if (action?.type !== "train") return "";
  const employee = employeeById(state, action.employeeId);
  const name = employee?.name || `Employee ${action.employeeId ?? "?"}`;
  if (action.status === "preflight") return `<div class="r4-tcm-feedback r4-tcm-info">Checking fresh company state for <strong>${escapeHtml(name)}</strong>…</div>`;
  if (action.status === "preflight_changed") return `<div class="r4-tcm-feedback r4-tcm-stale">Training state changed. Recommendation refreshed before a train was spent.</div>`;
  if (action.status === "pending") return `<div class="r4-tcm-feedback r4-tcm-info">Submitting train for <strong>${escapeHtml(name)}</strong>…</div>`;
  if (action.status === "accepted" || action.status === "awaiting_verification") return `<div class="r4-tcm-feedback r4-tcm-info">Accepted · verifying <strong>${escapeHtml(name)}</strong>…</div>`;
  if (action.status === "verified") return `<div class="r4-tcm-feedback r4-tcm-success">✓ Training verified for <strong>${escapeHtml(name)}</strong>.</div>`;
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
    <div class="r4-tcm-section-head"><span>NEXT IN QUEUE</span><button type="button" class="r4-tcm-link-btn" data-action="show-all">View all ›</button></div>
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
    let action = `<button type="button" class="r4-tcm-icon-btn" data-action="employee-menu" data-id="${id}" aria-label="Employee actions" title="Employee actions">⋮</button>`;
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
      <span><b>Fairness</b>${escapeHtml(state?.recommendation?.fairnessLabelById?.get?.(id) || "—")}</span>
      <span><b>Paid</b>${paid ? `${escapeHtml(paid.trainsRemaining)} remaining` : "None"}</span>
      <span><b>Pay</b>${escapeHtml(formatMoney(employee.wage))}${dock ? " · docked" : ""}</span>
    </div></td></tr>`;
  }).join("");
}

function primaryCard(state) {
  const nextId = state?.recommendation?.nextEmployeeId ?? state?.rotation?.nextEmployeeId ?? null;
  const employee = employeeById(state, nextId);
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
    ${paid ? `<div class="r4-tcm-paid-progress">${escapeHtml(paid.trainsDelivered)} / ${escapeHtml(paid.trainsPurchased)} delivered · ${escapeHtml(paid.trainsRemaining)} remaining</div>` : ""}
    ${employee ? `<button type="button" class="r4-tcm-link-btn" data-action="why-next" data-id="${employee.id}">Why?</button>` : ""}
  </section>`;
}

function lockIconHtml(locked) {
  const shackle = locked
    ? `<path d="M10.5 14v-3.2a5.5 5.5 0 0 1 11 0V14"/>`
    : `<path d="M12.5 14v-3.2a5.5 5.5 0 0 1 10.7-1.8"/>`;
  return `<svg class="r4-tcm-lock-svg" data-lock-state="${locked ? "locked" : "unlocked"}" width="16" height="16" viewBox="0 0 32 32" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${shackle}<rect x="8" y="14" width="16" height="13" rx="2.6"/><path d="M16 19v3.5"/></svg>`;
}

export function companyManagerHtml(state, _options = {}) {
  const eligibleCount = [...(state.eligibilityById?.values?.() || [])].filter((value) => value?.eligible).length;
  const attentionCount = Array.isArray(state.attention) ? state.attention.length : 0;
  const health = state.stale || state.status === "error" ? "bad" : Object.keys(state?.trainReceipts?.receiptsByEmployeeId || {}).length ? "warn" : Number(state.trains) > 0 ? "ok" : "idle";
  return `<section class="r4-tcm-manager r4-tcm-premium" data-tcm-state="${escapeHtml(state.status)}">
    <header class="r4-tcm-header" data-manager-drag-handle>
      <div class="r4-tcm-brand"><span class="r4-tcm-brand-mark">◆</span><div><span>VOIDSMITH INDUSTRIES</span><strong>TRAINING MANAGER</strong></div></div>
      <div class="r4-tcm-header-right"><a data-tcm-release-status class="r4-tcm-window-btn r4-tcm-release-status" href="https://voidsmithindustries.com/torn/scripts.html" target="_blank" rel="noopener noreferrer" title="Voidsmith release status">Checking…</a><span class="r4-tcm-health r4-tcm-health-${health}" title="Training Manager health"></span>
        <button type="button" class="r4-tcm-window-btn r4-tcm-attention-btn" data-action="attention" aria-label="Attention" title="Attention">⚠${attentionCount ? `<span>${attentionCount}</span>` : ""}</button>
        <button type="button" class="r4-tcm-window-btn r4-tcm-lock-btn" data-window-action="lock" aria-label="Unlock position" title="Unlock position">${lockIconHtml(true)}</button>
        <button type="button" class="r4-tcm-window-btn" data-window-action="minimize" aria-label="Minimize" title="Minimize">−</button>
        <button type="button" class="r4-tcm-window-btn" data-window-action="maximize" aria-label="Maximize" title="Maximize">□</button>
        <button type="button" class="r4-tcm-window-btn" data-action="settings" aria-label="Settings" title="Settings">⚙</button>
      </div>
    </header>
    <div class="r4-tcm-manager-body">
      ${state.stale ? `<div class="r4-tcm-stale">Refresh required. Writes are disabled until company state is verified.</div>` : ""}
      ${state.error ? `<div class="r4-tcm-error">${escapeHtml(state.error)}</div>` : ""}
      ${actionFeedback(state)}
      <div class="r4-tcm-metrics">
        <div><strong>${escapeHtml(state.trains ?? "?")}</strong><span>TRAINS</span></div>
        <div><strong>${escapeHtml(employeeById(state, state?.recommendation?.nextEmployeeId ?? state?.rotation?.nextEmployeeId)?.name || "None")}</strong><span>NEXT</span></div>
        <div><strong>${eligibleCount} / ${(state.employees || []).length}</strong><span>ELIGIBLE</span></div>
      </div>
      ${primaryCard(state)}
      ${queuePreview(state)}
      <section class="r4-tcm-roster"><div class="r4-tcm-section-head"><span>EMPLOYEES</span><div><button type="button" class="r4-tcm-link-btn" data-action="search">⌕ Search</button><button type="button" class="r4-tcm-link-btn" data-action="filter">Filter</button></div></div>
        <div class="r4-tcm-table-wrap"><table class="r4-tcm-table"><thead><tr><th>Employee</th><th>Training status</th><th>Last train</th><th></th></tr></thead><tbody>${rosterRows(state) || `<tr><td colspan="4">No employees loaded.</td></tr>`}</tbody></table></div>
      </section>
    </div>
  </section>`;
}

async function runSafely(fn, actions) { try { await fn(); } catch (error) { actions?.onError?.(error); } }

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

export function renderCompanyManager(root, state, actions = {}) {
  if (!root) return;
  root.innerHTML = companyManagerHtml(state);
  checkReleaseStatus(root);
  if (!root.querySelectorAll) return;
  for (const button of root.querySelectorAll("[data-action]")) {
    button.addEventListener?.("click", async () => {
      const action = button.dataset.action;
      const id = Number(button.dataset.id);
      if (action === "refresh") return runSafely(() => actions.refresh?.(), actions);
      if (action === "settings") return actions.openSettings?.();
      if (action === "attention") return actions.openAttention?.();
      if (action === "toggle-details") return toggleEmployeeDetails(root, id);
      if (action === "why-next") return actions.showWhy?.(id, recommendationReason(state, id));
      if (action === "search") return actions.openSearch?.();
      if (action === "filter") return actions.openFilter?.();
      if (action === "show-all") return actions.showAll?.();
      if (action === "train-next") {
        const employee = employeeById(state, state?.recommendation?.nextEmployeeId ?? state?.rotation?.nextEmployeeId);
        if (employee) return confirmTrain(employee, state, actions);
        return;
      }
      const employee = employeeById(state, id);
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

const MANAGER_DEFAULTS = Object.freeze({ x: 16, y: 80, width: 760, height: 560 });
const MANAGER_MIN_WIDTH = 420;
const MANAGER_MIN_HEIGHT = 280;
const MANAGER_VIEWPORT_MARGIN = 8;
const MANAGER_DOCK_TOP = 16;

function finiteOr(value, fallback) { if (value === null || value === undefined || value === "") return fallback; const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
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

export async function attachManagerWindow({ root, uiStorage, windowRef = globalThis.window, ResizeObserverImpl = globalThis.ResizeObserver, onMinimizedChange = null } = {}) {
  if (!root) return { destroy() {}, toggleMinimize: async () => {}, toggleMaximize: async () => {}, toggleLock: async () => {}, sync() {}, isMinimized: () => false, isLocked: () => true };
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
    const button = root.querySelector?.('[data-window-action="lock"]');
    if (!button) return;
    button.innerHTML = lockIconHtml(locked);
    button.title = locked ? "Unlock position" : "Lock position";
    button.setAttribute?.("aria-label", locked ? "Unlock position" : "Lock position");
    button.dataset.locked = locked ? "true" : "false";
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
    if (minimized) { onMinimizedChange?.(true); return; }
    if (maximized) {
      root.style.left = `${MANAGER_VIEWPORT_MARGIN}px`; root.style.top = `${MANAGER_VIEWPORT_MARGIN}px`;
      root.style.width = `${Math.max(320, viewportWidth - MANAGER_VIEWPORT_MARGIN * 2)}px`;
      root.style.height = `${Math.max(220, viewportHeight - MANAGER_VIEWPORT_MARGIN * 2)}px`; root.style.resize = "none";
    } else {
      root.style.left = `${geometry.x}px`; root.style.top = `${geometry.y}px`;
      root.style.width = `${geometry.width}px`; root.style.height = `${geometry.height}px`; root.style.resize = "both";
    }
    onMinimizedChange?.(false);
  };
  const persist = async () => { if (!destroyed) await uiStorage?.saveManagerUi?.(stateForStorage()); };
  const toggleMinimize = async () => { minimized = !minimized; if (minimized) maximized = false; apply(); await persist(); };
  const toggleMaximize = async () => { maximized = !maximized; if (maximized) minimized = false; apply(); await persist(); };
  const toggleLock = async () => { locked = !locked; dragging = null; apply(); await persist(); };
  const restore = async () => { if (!minimized) return; minimized = false; apply(); await persist(); };
  const onClick = (event) => {
    const control = event?.target?.closest?.("[data-window-action]");
    if (!control) return;
    event.preventDefault?.(); event.stopPropagation?.();
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
  const onPointerUp = (event) => { if (!dragging) return; dragging = null; root.releasePointerCapture?.(event?.pointerId); void persist(); };
  const onViewportResize = () => { geometry = normalizedGeometry(geometry, windowRef); apply(); void persist(); };
  apply();
  root.addEventListener?.("click", onClick); root.addEventListener?.("pointerdown", onPointerDown); root.addEventListener?.("pointermove", onPointerMove); root.addEventListener?.("pointerup", onPointerUp); root.addEventListener?.("pointercancel", onPointerUp); windowRef?.addEventListener?.("resize", onViewportResize);
  const resizeObserver = ResizeObserverImpl ? new ResizeObserverImpl(() => { if (dragging || destroyed || minimized || maximized) return; const rect = root.getBoundingClientRect?.(); if (!rect) return; geometry = normalizedGeometry({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }, windowRef); void persist(); }) : null;
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
      root.removeEventListener?.("click", onClick); root.removeEventListener?.("pointerdown", onPointerDown); root.removeEventListener?.("pointermove", onPointerMove); root.removeEventListener?.("pointerup", onPointerUp); root.removeEventListener?.("pointercancel", onPointerUp); windowRef?.removeEventListener?.("resize", onViewportResize);
    }
  };
}
