import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { mountManagerDock } from "../src/ui/manager-dock.js";

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
