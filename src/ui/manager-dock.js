function isActuallyVisible(el, windowRef) {
  if (!el) return false;
  try {
    const style = windowRef?.getComputedStyle?.(el);
    return (!style || style.display !== "none")
      && (!style || style.visibility !== "hidden")
      && (!style || style.opacity !== "0");
  } catch {
    return false;
  }
}

export function findStatusIconsBar(documentRef, windowRef = globalThis.window) {
  const selectors = [
    'ul[class*="status-icons"]',
    'ul[class*="statusIcons"]'
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
  return `${action} Company Training Manager · ${trains} train${trains === 1 ? "" : "s"}${next ? ` · Next: ${next}` : ""}`;
}

const VOIDSMITH_TRAINING_GLYPH = `<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path class="r4-tcm-dock-frame" d="M16 2.8 27.7 9.5v13L16 29.2 4.3 22.5v-13Z"/><path class="r4-tcm-dock-v" d="m9.1 10.2 6.9 12.1 6.9-12.1-3.5 1.9-3.4 5.9-3.4-5.9Z"/><path class="r4-tcm-dock-bar" d="M10.3 8.2h11.4v2.4H10.3z"/></svg>`;

export const MANAGER_DOCK_STYLES = `
.r4-tcm-dock-icon{position:relative!important;width:32px!important;height:32px!important;min-width:32px!important;display:flex!important;align-items:center!important;justify-content:center!important;cursor:pointer!important;user-select:none!important;list-style:none!important;border:1px solid #4a4a53!important;border-radius:9px!important;margin:0 3px!important;background:linear-gradient(145deg,#1b1b20,#0b0b0e)!important;box-shadow:inset 0 1px 0 #ffffff0d,0 4px 12px #0008!important;transition:transform .15s ease,background .15s ease,border-color .15s ease,box-shadow .15s ease!important}
.r4-tcm-dock-icon:hover{transform:translateY(-1px)!important;background:linear-gradient(145deg,#24242a,#111116)!important;border-color:#7a3331!important;box-shadow:inset 0 1px 0 #ffffff12,0 5px 16px #000a,0 0 12px #c3474326!important}
.r4-tcm-dock-glyph{width:22px!important;height:22px!important;display:flex!important;align-items:center!important;justify-content:center!important;pointer-events:none!important;font-size:21px!important;line-height:1!important}.r4-tcm-dock-glyph svg{width:22px!important;height:22px!important;display:block!important}.r4-tcm-dock-frame{fill:#111116;stroke:#777782;stroke-width:1.2}.r4-tcm-dock-v{fill:#d6d6dc}.r4-tcm-dock-bar{fill:#c34743;filter:drop-shadow(0 0 2px #c3474388)}
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
  glyph.textContent = "🎓";
  glyph.setAttribute?.("aria-hidden", "true");
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
  const button = documentRef.createElement("button");
  button.setAttribute?.("type", "button");
  button.setAttribute?.("aria-label", "Company Training Manager");
  button.appendChild(buildGlyph(documentRef));
  button.appendChild(buildStatusDot(documentRef));
  button.addEventListener?.("click", (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    onToggle?.();
  });
  wrap.appendChild(button);
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
  } catch {}
  return false;
}

export function mountManagerDock({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  state = {},
  isManagerOpen = null,
  managerUrl = "https://www.torn.com/companies.php?step=your#employees",
  onToggle = null,
  MutationObserverImpl = globalThis.MutationObserver
} = {}) {
  if (!documentRef?.createElement || !documentRef?.body) return { update() {}, ensure() {}, destroy() {} };
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
    const button = fallback?.querySelector?.("button");
    if (button) { button.title = title; button.dataset.tone = tone; }
  };

  const toggle = async () => {
    if (typeof onToggle === "function") await onToggle();
    else defaultToggleManager({ documentRef, windowRef, managerUrl });
    currentOpen = managerIsOpen(documentRef);
    updatePresentation();
  };

  // Header-only launcher: no screen overlay or alternative floating button.
  let fallback = null;

  const ensure = () => {
    if (destroyed) return;
    if (typeof isManagerOpen !== "boolean") currentOpen = managerIsOpen(documentRef);
    const bar = findStatusIconsBar(documentRef, windowRef);
    const existing = documentRef.querySelector?.(".r4-tcm-dock-icon");
    if (bar) {

      if (existing && existing.parentElement === bar) {
        icon = existing;
      } else {
        existing?.remove?.();
        icon = buildDockIcon(documentRef, toggle);
        try { bar.prepend(icon); } catch { bar.appendChild?.(icon); }
      }
    } else {
      existing?.remove?.();
      icon = null;

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
