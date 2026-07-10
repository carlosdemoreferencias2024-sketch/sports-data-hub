import assert from "node:assert/strict";

function normalizeAlias(value) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function slugify(value) {
  return normalizeAlias(value).replace(/\s+/g, "-");
}

assert.equal(normalizeAlias("NY Yankees"), "ny yankees");
assert.equal(normalizeAlias("Atlético  Nacional!!"), "atletico nacional");
assert.equal(slugify("Los Angeles Lakers"), "los-angeles-lakers");

console.log("normalization tests passed");
