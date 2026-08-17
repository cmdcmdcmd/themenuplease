const crypto = require("node:crypto");

const PIN_REGEX = /^\d{6}$/;

function makeSalt() {
  return crypto.randomBytes(16).toString("hex");
}

function hashPin(pin, salt) {
  return crypto.scryptSync(pin, salt, 64).toString("hex");
}

function verifyPin(pin, salt, hash) {
  const candidate = Buffer.from(hashPin(pin, salt), "hex");
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function makeToken() {
  return crypto.randomBytes(32).toString("hex");
}

module.exports = { PIN_REGEX, makeSalt, hashPin, verifyPin, makeToken };
