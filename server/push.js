const fs = require("node:fs");
const path = require("node:path");
const webpush = require("web-push");

const DATA_DIR = path.join(__dirname, "..", "data");
const VAPID_PATH = path.join(DATA_DIR, "vapid.json");

function loadOrCreateVapidKeys() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(VAPID_PATH)) {
    return JSON.parse(fs.readFileSync(VAPID_PATH, "utf8"));
  }
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_PATH, JSON.stringify(keys, null, 2));
  return keys;
}

const vapidKeys = loadOrCreateVapidKeys();

webpush.setVapidDetails("mailto:clairemariondesign@gmail.com", vapidKeys.publicKey, vapidKeys.privateKey);

function sendToAll(db, payload) {
  const subs = db.prepare("SELECT id, endpoint, subscription_json FROM push_subscriptions").all();
  const body = JSON.stringify(payload);
  for (const sub of subs) {
    let parsed;
    try {
      parsed = JSON.parse(sub.subscription_json);
    } catch (e) {
      continue;
    }
    webpush.sendNotification(parsed, body).catch((err) => {
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(sub.id);
      } else {
        console.error("Erreur envoi push:", err.message);
      }
    });
  }
}

// Heure/jour "Europe/Paris" quelle que soit la timezone du serveur d'hébergement.
const PARIS_DAY_KEYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

function getParisNow() {
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const map = {};
  for (const p of parts) map[p.type] = p.value;

  const weekdayIndex = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Europe/Paris" })
  ).getDay();

  return {
    hh: map.hour,
    mm: map.minute,
    dateStr: `${map.year}-${map.month}-${map.day}`,
    dayKey: PARIS_DAY_KEYS[weekdayIndex],
  };
}

module.exports = { vapidKeys, sendToAll, getParisNow };
