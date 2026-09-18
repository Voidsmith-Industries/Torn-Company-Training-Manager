import test from "node:test";
import assert from "node:assert/strict";
import { parseTrainingNewsItem } from "../src/core/history.js";

test("fallback news parsing keeps encoded angle brackets inert", () => {
  const parsed = parseTrainingNewsItem({
    id: 42,
    timestamp: 1234567890,
    text: '<a href="https://www.torn.com/profiles.php?XID=123456">&lt;script&gt;Alice&lt;/script&gt;</a> has been trained by the director'
  });

  assert.equal(parsed.resolved, true);
  assert.equal(parsed.event.employeeId, 123456);
  assert.equal(parsed.event.employeeNameAtTime, "&lt;script&gt;Alice&lt;/script&gt;");
});

test("fallback news parsing strips actual markup without evaluating it", () => {
  const parsed = parseTrainingNewsItem({
    id: 43,
    timestamp: 1234567891,
    text: '<div><a href="?XID=654321"><strong>Bob</strong></a> has been trained by the director</div>'
  });

  assert.equal(parsed.resolved, true);
  assert.equal(parsed.event.employeeId, 654321);
  assert.equal(parsed.event.employeeNameAtTime, "Bob");
});

test("fallback news parsing decodes text entities only once", () => {
  const parsed = parseTrainingNewsItem({
    id: 44,
    timestamp: 1234567892,
    text: '<a href="?XID=777777">A &amp;quot;B&amp;quot;</a> has been trained by the director'
  });

  assert.equal(parsed.resolved, true);
  assert.equal(parsed.event.employeeId, 777777);
  assert.equal(parsed.event.employeeNameAtTime, "A &quot;B&quot;");
});
