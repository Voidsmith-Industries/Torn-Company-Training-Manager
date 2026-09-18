import test from "node:test";
import assert from "node:assert/strict";
import { settingsFormHtml } from "../src/ui/settings.js";

function state(overrides = {}) {
  return {
    settings: {
      maxAddiction: 3,
      refreshMinutes: 5,
      prioritizeNeverTrained: true,
      rotationMode: "fair",
      fairnessWindowDays: 30,
      accrueDebtWhileIneligible: false,
      removalThresholdDays: null,
      notificationMode: "important",
      showGlobalBadge: true,
      showTrainCount: true,
      showNativeTrainingBadges: true,
      compactDensity: false,
      reduceMotion: false,
      ...overrides
    },
    paid: { schemaVersion: 1, contractsById: {}, activeByEmployeeId: {}, queue: [] }
  };
}

test("Gear settings expose simple section navigation instead of one wall of controls", () => {
  const html = settingsFormHtml(state(), { hasApiKey: true, activeSection: "general" });
  for (const label of ["General", "Training Rules", "Paid Trains", "Fairness", "Notifications", "Appearance", "Data & Recovery", "Advanced"]) {
    const encoded = label.replaceAll("&", "&amp;");
    assert.ok(html.includes(label) || html.includes(encoded), "Expected settings label: " + label);
  }
  assert.match(html, /data-settings-section="general"[^>]*aria-expanded="true"/i);
  assert.match(html, /data-section-panel="general"/i);
  assert.doesNotMatch(html, /data-section-panel="advanced"[^>]*>[^<]*Diagnostics/i);
});

test("General settings no longer expose retired global badge controls", () => {
  const html = settingsFormHtml(state(), { hasApiKey: true, activeSection: "general" });
  assert.doesNotMatch(html, /showGlobalBadge/i);
  assert.doesNotMatch(html, /Show global launcher outside Company/i);
  assert.doesNotMatch(html, /showTrainCount/i);
});

test("Training Rules shows fixed 24h inactivity and 72h new-hire policy plus director removal threshold", () => {
  const html = settingsFormHtml(state(), { activeSection: "training" });
  assert.match(html, /24 hours/i);
  assert.match(html, /72 hours|3 days/i);
  assert.match(html, /name="maxAddiction"/i);
  assert.match(html, /name="removalThresholdDays"/i);
  assert.match(html, />2 days<|value="2"/i);
  assert.match(html, />3 days<|value="3"/i);
  assert.match(html, />7 days<|value="7"/i);
});

test("Fairness settings keep advanced balanced controls conditional", () => {
  const fair = settingsFormHtml(state({ rotationMode: "fair" }), { activeSection: "fairness" });
  assert.match(fair, /name="rotationMode"/i);
  assert.match(fair, /Fair Rotation/i);
  assert.match(fair, /Balanced Fairness/i);
  assert.doesNotMatch(fair, /data-balanced-options[^>]*data-visible="true"/i);

  const balanced = settingsFormHtml(state({ rotationMode: "balanced" }), { activeSection: "fairness" });
  assert.match(balanced, /data-balanced-options[^>]*data-visible="true"/i);
  assert.match(balanced, /name="fairnessWindowDays"/i);
  assert.match(balanced, /name="accrueDebtWhileIneligible"/i);
});

test("Notifications default to Important only and custom details reveal only for Custom", () => {
  const important = settingsFormHtml(state({ notificationMode: "important" }), { activeSection: "notifications" });
  assert.match(important, /Important only/i);
  assert.doesNotMatch(important, /data-custom-notifications[^>]*data-visible="true"/i);

  const custom = settingsFormHtml(state({ notificationMode: "custom" }), { activeSection: "notifications" });
  assert.match(custom, /data-custom-notifications[^>]*data-visible="true"/i);
});

test("Advanced owns Audit Log and Diagnostics rather than the ordinary manager surface", () => {
  const html = settingsFormHtml(state(), { activeSection: "advanced" });
  assert.match(html, /data-settings-action="audit-log"/i);
  assert.match(html, /data-settings-action="diagnostics"/i);
  assert.match(html, /Audit Log/i);
  assert.match(html, /Diagnostics/i);
});
