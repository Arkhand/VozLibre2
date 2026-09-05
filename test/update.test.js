const test = require("node:test");
const assert = require("node:assert/strict");

const update = require("../src/main/update");

test("isNewer: compara mayor.menor.patch y tolera la v", () => {
  assert.equal(update.isNewer("v1.0.1", "1.0.0"), true);
  assert.equal(update.isNewer("1.0.0", "1.0.0"), false);
  assert.equal(update.isNewer("1.0.0", "1.0.1"), false);
  assert.equal(update.isNewer("2.0.0", "1.9.9"), true);
  assert.equal(update.isNewer("1.10.0", "1.9.0"), true);
  assert.equal(update.isNewer("basura", "1.0.0"), false);
});

test("repoFromPackage: lee owner/repo de package.json", () => {
  const r = update.repoFromPackage();
  assert.deepEqual(r, { owner: "Arkhand", repo: "VozLibre2" });
});

test("parseVersion", () => {
  assert.deepEqual(update.parseVersion("v1.2.3-portable"), [1, 2, 3]);
  assert.equal(update.parseVersion("x"), null);
});
