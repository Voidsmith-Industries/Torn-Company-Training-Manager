import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { companyManagerHtml, attachManagerWindow } from "../src/ui/company-manager.js";
import { employeeMenuHtml } from "../src/ui/employee-menu.js";
import { settingsFormHtml } from "../src/ui/settings.js";
import { TCM_STYLES } from "../src/ui/styles.js";
import { StorageRepo } from "../src/infra/storage.js";
import { mountManagerDock, findStatusIconsBar } from "../src/ui/manager-dock.js";

function emptyState() {
  return {
    status: "ready", stale: false, trains: 2, lastUpdatedAt: 1, error: null, action: null,
    settings: { maxAddiction: 3, refreshMinutes: 5 }, employees: [], eligibilityById: new Map(), trainingById: new Map(),
    rotation: { nextEmployeeId: null, orderedEligible: [], skipped: [] }, payroll: { recordsByEmployeeId: {} },
    paid: { contractsById: {}, activeByEmployeeId: {}, queue: [] }, overrides: {}, recommendation: { ordered: [] }, attention: []
  };
}

test("manager header exposes a persistent vector lock control before minimize/maximize", () => {
  const html = companyManagerHtml(emptyState());
  assert.match(html, /data-window-action="lock"/);
  assert.match(html, /r4-tcm-lock-svg/);
  const lockIndex = html.indexOf('data-window-action="lock"');
  const minimizeIndex = html.indexOf('data-window-action="minimize"');
  assert.ok(lockIndex >= 0 && lockIndex < minimizeIndex);
});

test("manager UI state persists locked mode and defaults to locked", async () => {
  const values = new Map();
  const repo = new StorageRepo({
    async getValue(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
    async setValue(key, value) { values.set(key, value); },
    async deleteValue(key) { values.delete(key); }
  });
  assert.equal((await repo.loadManagerUi()).locked, true);
  await repo.saveManagerUi({ x: 100, y: 80, width: 700, height: 500, minimized: false, maximized: false, locked: false });
  assert.equal((await repo.loadManagerUi()).locked, false);
});

test("locked manager defaults to top-right, blocks drag, and remembers unlock", async () => {
  const listeners = new Map();
  const saved = [];
  const rect = { left: 432, top: 16, width: 760, height: 560 };
  const lockButton = { dataset: { windowAction: "lock" }, innerHTML: "", title: "", setAttribute() {} };
  const root = {
    style: {},
    classList: { add() {}, toggle() {} },
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name) { listeners.delete(name); },
    querySelector(selector) { return selector === '[data-window-action="lock"]' ? lockButton : null; },
    getBoundingClientRect() { return rect; },
    setPointerCapture() {}, releasePointerCapture() {}
  };
  const handle = await attachManagerWindow({
    root,
    windowRef: { innerWidth: 1200, innerHeight: 900, addEventListener() {}, removeEventListener() {} },
    ResizeObserverImpl: null,
    uiStorage: {
      async loadManagerUi() { return { x: null, y: null, width: null, height: null, minimized: false, maximized: false, locked: true }; },
      async saveManagerUi(value) { saved.push({ ...value }); }
    }
  });
  assert.equal(root.style.left, "432px");
  assert.equal(root.style.top, "16px");
  assert.equal(root.style.resize, "both");
  assert.match(lockButton.innerHTML, /r4-tcm-lock-svg/);

  const dragTarget = { closest(selector) { if (selector === ".r4-tcm-header") return {}; if (selector.includes("button")) return null; return null; } };
  listeners.get("pointerdown")({ target: dragTarget, clientX: 500, clientY: 40, pointerId: 1, preventDefault() {} });
  listeners.get("pointermove")({ target: dragTarget, clientX: 300, clientY: 200, pointerId: 1 });
  assert.equal(root.style.left, "432px");
  assert.equal(root.style.top, "16px");

  await handle.toggleLock();
  assert.equal(saved.at(-1).locked, false);
  assert.match(lockButton.innerHTML, /data-lock-state="unlocked"/);
  listeners.get("pointerdown")({ target: dragTarget, clientX: 500, clientY: 40, pointerId: 1, preventDefault() {} });
  listeners.get("pointermove")({ target: dragTarget, clientX: 350, clientY: 140, pointerId: 1 });
  listeners.get("pointerup")({ target: dragTarget, pointerId: 1 });
  assert.equal(root.style.left, "282px");
  assert.equal(saved.at(-1).locked, false);
});

test("settings use a structured two-column Voidsmith layout", () => {
  const html = settingsFormHtml(emptyState(), { hasApiKey: true, activeSection: "general" });
  assert.match(html, /r4-tcm-settings-layout/);
  assert.match(html, /r4-tcm-settings-nav/);
  assert.match(TCM_STYLES, /--vs-red\s*:/);
  assert.match(TCM_STYLES, /\.r4-tcm-settings-layout\{[^}]*display:grid[^}]*grid-template-columns:/s);
  assert.match(TCM_STYLES, /\.r4-tcm-settings-tab\.is-active\{/);
});

test("employee actions render as a dedicated premium action sheet", () => {
  const state = emptyState();
  state.employees = [{ id: 42, name: "kembe2304" }];
  state.eligibilityById = new Map([[42, { eligible: false, unverified: false, inactive: true, addictionViolation: false }]]);
  const html = employeeMenuHtml(state.employees[0], state);
  assert.match(html, /r4-tcm-employee-action-sheet/);
  assert.match(html, /r4-tcm-action-sheet-actions/);
  assert.match(html, /r4-tcm-action-sheet-footer/);
  assert.match(TCM_STYLES, /\.r4-tcm-employee-action-sheet\{/);
});

test("status-bar selection ignores hidden responsive header copies", () => {
  const dom = new JSDOM('<!doctype html><html><body><div style="display:none"><ul class="status-icons"></ul></div><header><ul class="status-icons"></ul></header></body></html>', { url: "https://www.torn.com/" });
  const visible = dom.window.document.querySelector("header ul");
  assert.equal(findStatusIconsBar(dom.window.document, dom.window), visible);
});

test("training launcher shows distinct graduation-cap icon in the Torn status bar", () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><ul class="status-icons"></ul></body></html>', { url: "https://www.torn.com/companies.php" });
  const dock = mountManagerDock({
    documentRef: dom.window.document,
    windowRef: dom.window,
    state: { trains: 2, employees: [], recommendation: {} },
    isManagerOpen: true,
    onToggle() {},
    MutationObserverImpl: null
  });
  const launcher = dom.window.document.querySelector(".r4-tcm-dock-icon, #r4-tcm-dock-fallback button");
  assert.ok(launcher);
  assert.equal(launcher.textContent, "🎓");
  assert.doesNotMatch(launcher.textContent, /T\s*◆/);
  dock.destroy();
});
