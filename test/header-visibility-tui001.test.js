import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { findStatusIconsBar, mountManagerDock } from "../src/ui/manager-dock.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("TUI-001: class-only responsive reveal restores the header launcher", async () => {
  const dom = new JSDOM(`<!doctype html><html><head>
    <style>.hidden{display:none}</style>
    </head><body><header class="hidden"><ul class="status-icons"></ul></header></body></html>`, {
    url: "https://www.torn.com/companies.php", pretendToBeVisual: true
  });
  const { document, window } = dom.window;
  const dock = mountManagerDock({ documentRef: document, windowRef: window, MutationObserverImpl: window.MutationObserver });
  assert.equal(document.querySelector(".r4-tcm-dock-icon"), null);
  document.querySelector("header").classList.remove("hidden");
  await tick();
  assert.ok(document.querySelector("header .r4-tcm-dock-icon"));
  dock.destroy();
  dom.window.close();
});

test("TUI-001: resize selects the newly visible responsive status bar", async () => {
  const dom = new JSDOM(`<!doctype html><html><head>
    <style>.hidden{display:none}</style>
    </head><body>
    <header id="desktop"><ul class="status-icons"></ul></header>
    <header id="mobile" class="hidden"><ul class="status-icons"></ul></header>
    </body></html>`, { url: "https://www.torn.com/", pretendToBeVisual: true });
  const { document, window } = dom.window;
  const dock = mountManagerDock({ documentRef: document, windowRef: window, MutationObserverImpl: window.MutationObserver });
  assert.ok(document.querySelector("#desktop .r4-tcm-dock-icon"));
  document.querySelector("#desktop").classList.add("hidden");
  document.querySelector("#mobile").classList.remove("hidden");
  window.dispatchEvent(new window.Event("resize"));
  await tick();
  assert.equal(document.querySelector("#desktop .r4-tcm-dock-icon"), null);
  assert.ok(document.querySelector("#mobile .r4-tcm-dock-icon"));
  dock.destroy();
  dom.window.close();
});

test("TUI-001: never mount into zero-geometry responsive headers in real layout", () => {
  const dom = new JSDOM(`<!doctype html><body>
    <header><ul id="hidden-copy" class="status-icons"></ul></header>
    <header><ul id="visible-copy" class="status-icons"></ul></header>
  </body>`, { url: "https://www.torn.com/" });
  const { document, window } = dom.window;
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: "Mozilla/5.0" });
  document.getElementById("hidden-copy").getBoundingClientRect = () => ({ width: 0, height: 0 });
  document.getElementById("visible-copy").getBoundingClientRect = () => ({ width: 120, height: 24 });
  assert.equal(findStatusIconsBar(document, window)?.id, "visible-copy");
  document.getElementById("visible-copy").getBoundingClientRect = () => ({ width: 0, height: 0 });
  assert.equal(findStatusIconsBar(document, window), null);
  dom.window.close();
});
