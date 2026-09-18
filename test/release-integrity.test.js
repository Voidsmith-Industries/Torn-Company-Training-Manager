import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const RAW = "https://voidsmithindustries.com/torn/install/company-training-manager.user.js";
const SUPPORT = "https://voidsmithindustries.com/torn/support.html";

async function text(path) {
  return readFile(resolve(root, path), "utf8");
}

test("package version is the v1.2.5 release source", async () => {
  const pkg = JSON.parse(await text("package.json"));
  assert.equal(pkg.version, "1.2.5");
});

test("source header uses build-time version placeholder and explicit update metadata", async () => {
  const header = await text("src/userscript-header.txt");
  assert.match(header, /@version\s+__VERSION__/);
  assert.ok(header.includes("@updateURL    " + RAW));
  assert.ok(header.includes("@downloadURL  " + RAW));
  assert.ok(header.includes("@supportURL   " + SUPPORT));
});

test("built userscript version and metadata match package version", async () => {
  const pkg = JSON.parse(await text("package.json"));
  const dist = await text("dist/Torn Company Training Manager.user.js");
  assert.match(dist, new RegExp("@version\\s+" + pkg.version.replaceAll(".", "\\.")));
  assert.equal(dist.includes("__VERSION__"), false);
  assert.ok(dist.includes("@updateURL    " + RAW));
  assert.ok(dist.includes("@downloadURL  " + RAW));
  assert.ok(dist.includes("@supportURL   " + SUPPORT));
});

test("README and changelog identify the same current v1.2.5 release", async () => {
  const readme = await text("README.md");
  const changelog = await text("CHANGELOG.md");
  assert.match(readme, /Current release:\s*v1\.2\.5/i);
  assert.match(changelog, /\[1\.2\.5\]/);
  assert.match(changelog, /distribution|install|update/i);
});
