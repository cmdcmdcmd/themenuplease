const express = require("express");
const path = require("node:path");
const { db, DAYS, MEALS } = require("./db");
const { vapidKeys, sendToAll, getParisNow, getCurrentSeason } = require("./push");
const { weekOptions } = require("./seed/weekOptions");
const { PIN_REGEX, makeSalt, hashPin, verifyPin, makeToken } = require("./auth");

const app = express();
app.use(express.json());

const RAYON_ORDER = [
  "Fruits & légumes",
  "Viandes, poissons & œufs",
  "Crèmerie",
  "Épicerie",
  "Surgelés",
  "Épices & condiments",
  "Boulangerie",
];

const DAY_LABELS = {
  lundi: "Lundi",
  mardi: "Mardi",
  mercredi: "Mercredi",
  jeudi: "Jeudi",
  vendredi: "Vendredi",
  samedi: "Samedi",
  dimanche: "Dimanche",
};

const MEAL_LABELS = {
  "petit-dej": "Petit-déj",
  dejeuner: "Déjeuner",
  diner: "Dîner",
  dessert: "Dessert",
};

const TAG_LABELS = {
  "proteines-matin": "Protéines dès le matin",
  "omega-3": "Oméga-3",
  "fer-magnesium": "Fer & magnésium",
  "zero-effort": "Zéro effort",
};

const WEEKEND_DAYS = ["samedi", "dimanche"];

// Le bonus dessert n'est proposé que le samedi — pas un repas comme les autres,
// donc pas dans MEALS (qui pilote la boucle jour x repas partout ailleurs).
function isValidSlot(day, meal) {
  if (day === "samedi" && meal === "dessert") return true;
  return DAYS.includes(day) && MEALS.includes(meal);
}

function roundQty(n) {
  return Math.round(n * 100) / 100;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Favoris ----------

function getFavoritesMap() {
  const rows = db.prepare("SELECT recipe_id, status FROM favorites").all();
  const map = {};
  for (const r of rows) map[r.recipe_id] = r.status;
  return map;
}

// ---------- Saison ----------
// Un tableau season vide = recette disponible toute l'année (la majorité des
// recettes). Une recette avec des saisons précises n'est proposée que pendant
// celles-ci — le pool se met donc à jour tout seul au fil des mois.

function isInSeason(seasonJson, currentSeason) {
  let arr;
  try { arr = JSON.parse(seasonJson || "[]"); } catch (e) { arr = []; }
  return !arr.length || arr.includes(currentSeason);
}

function getSeasonMap() {
  const rows = db.prepare("SELECT id, season FROM recipes").all();
  const map = {};
  for (const r of rows) map[r.id] = r.season;
  return map;
}

// ---------- Recettes ----------

function parseRecipeRow(row, favorites) {
  return {
    id: row.id,
    name: row.name,
    mealType: row.meal_type,
    prepMinutes: row.prep_minutes,
    weekendOnly: !!row.weekend_only,
    ratio: row.ratio,
    tags: JSON.parse(row.tags || "[]"),
    spices: JSON.parse(row.spices || "[]"),
    steps: JSON.parse(row.steps || "[]"),
    season: JSON.parse(row.season || "[]"),
    favorite: favorites ? favorites[row.id] || null : null,
  };
}

function getRecipeSummary(id, favorites) {
  const row = db.prepare("SELECT * FROM recipes WHERE id = ?").get(id);
  return row ? parseRecipeRow(row, favorites || getFavoritesMap()) : null;
}

function getRecipeDetail(id, nbPersonnes) {
  const recipe = getRecipeSummary(id);
  if (!recipe) return null;
  const ingredientRows = db
    .prepare("SELECT name, rayon, qty_per_person, unit FROM ingredients WHERE recipe_id = ?")
    .all(id);
  recipe.ingredients = ingredientRows.map((i) => ({
    name: i.name,
    rayon: i.rayon,
    unit: i.unit,
    qtyPerPerson: i.qty_per_person,
    qty: roundQty(i.qty_per_person * nbPersonnes),
  }));
  return recipe;
}

// ---------- Résolution des options (défaut + reroll + exclusion des bannies) ----------

function pickEligiblePool(mealType, day, excludeIds, favorites) {
  const isWeekend = WEEKEND_DAYS.includes(day);
  const season = getCurrentSeason();
  const rows = db.prepare("SELECT id, weekend_only, season FROM recipes WHERE meal_type = ?").all(mealType);
  const excludeSet = new Set(excludeIds);
  const eligible = rows
    .filter((r) => (isWeekend ? true : !r.weekend_only))
    .filter((r) => isInSeason(r.season, season))
    .filter((r) => favorites[r.id] !== "banned")
    .filter((r) => !excludeSet.has(r.id))
    .map((r) => r.id);

  // Petit biais en faveur des recettes "j'adore" : elles apparaissent deux fois dans le tirage.
  const weighted = eligible.flatMap((id) => (favorites[id] === "loved" ? [id, id] : [id]));
  const seen = new Set();
  return shuffle(weighted).filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
}

function resolveOptions(day, meal, { forceReroll = false } = {}) {
  const favorites = getFavoritesMap();
  const season = getCurrentSeason();
  const seasonMap = getSeasonMap();
  const defaultIds = weekOptions[meal][day];

  const overrideRow = forceReroll
    ? null
    : db.prepare("SELECT recipe_ids FROM current_options WHERE day = ? AND meal_type = ?").get(day, meal);

  let baseIds = overrideRow ? JSON.parse(overrideRow.recipe_ids) : defaultIds;
  let ids = baseIds.filter((id) => favorites[id] !== "banned" && isInSeason(seasonMap[id], season));

  if (forceReroll) {
    // Une vraie roulette : on exclut aussi les options actuellement affichées.
    const excludeIds = baseIds;
    const pool = pickEligiblePool(meal, day, excludeIds, favorites);
    ids = pool.slice(0, 3);
    if (ids.length < 3) {
      // Pool trop petit (ex. week-end) : on ré-autorise les anciennes options non bannies.
      const fallback = baseIds.filter((id) => favorites[id] !== "banned" && !ids.includes(id));
      ids = ids.concat(fallback).slice(0, 3);
    }
  } else if (ids.length < 3) {
    const pool = pickEligiblePool(meal, day, ids, favorites);
    ids = ids.concat(pool.slice(0, 3 - ids.length));
  }

  const changed = forceReroll || JSON.stringify(ids) !== JSON.stringify(baseIds);
  if (changed) {
    db.prepare(`
      INSERT INTO current_options (day, meal_type, recipe_ids) VALUES (?, ?, ?)
      ON CONFLICT(day, meal_type) DO UPDATE SET recipe_ids = excluded.recipe_ids
    `).run(day, meal, JSON.stringify(ids));
  }

  return ids.map((id) => getRecipeSummary(id, favorites)).filter(Boolean);
}

// ---------- Réglages (rappels) ----------

function getSetting(key, fallback) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch (e) { return fallback; }
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, JSON.stringify(value));
}

const DEFAULT_REMINDER = { enabled: false, time: "17:00", mealType: "diner" };
const DEFAULT_TISANE = { enabled: false, time: "20:30" };
const DEFAULT_PLANNING = { enabled: false, time: "19:00" };

// ---------- Authentification (code PIN partagé en famille) ----------
// Un seul code pour tout le foyer : chaque appareil garde son propre jeton de
// session après déverrouillage, pour ne pas retaper le code à chaque visite.

const PUBLIC_AUTH_PATHS = new Set(["/api/auth/status", "/api/auth/setup", "/api/auth/login"]);
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000;
const loginState = { fails: 0, lockedUntil: 0 };

function getAuthConfig() {
  return getSetting("auth_pin", null);
}

function createSession() {
  const token = makeToken();
  db.prepare("INSERT INTO sessions (token, created_at) VALUES (?, ?)").run(token, new Date().toISOString());
  return token;
}

function isValidSession(token) {
  return !!token && !!db.prepare("SELECT 1 FROM sessions WHERE token = ?").get(token);
}

function requireAuth(req, res, next) {
  const token = (req.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!isValidSession(token)) return res.status(401).json({ error: "Authentification requise." });
  next();
}

app.use((req, res, next) => {
  if (!req.path.startsWith("/api/") || PUBLIC_AUTH_PATHS.has(req.path)) return next();
  return requireAuth(req, res, next);
});

app.get("/api/auth/status", (req, res) => {
  res.json({ hasPin: !!getAuthConfig() });
});

app.post("/api/auth/setup", (req, res) => {
  if (getAuthConfig()) return res.status(409).json({ error: "Un code existe déjà — demande-le à la famille." });
  const { pin } = req.body || {};
  if (!PIN_REGEX.test(pin || "")) return res.status(400).json({ error: "Le code doit contenir 6 chiffres." });
  const salt = makeSalt();
  setSetting("auth_pin", { salt, hash: hashPin(pin, salt) });
  res.json({ token: createSession() });
});

app.post("/api/auth/login", (req, res) => {
  const auth = getAuthConfig();
  if (!auth) return res.status(409).json({ error: "Aucun code n'est configuré." });

  if (Date.now() < loginState.lockedUntil) {
    const waitMin = Math.ceil((loginState.lockedUntil - Date.now()) / 60000);
    return res.status(429).json({ error: `Trop d'essais. Réessaie dans ${waitMin} min.` });
  }

  const { pin } = req.body || {};
  if (!PIN_REGEX.test(pin || "") || !verifyPin(pin, auth.salt, auth.hash)) {
    loginState.fails += 1;
    if (loginState.fails >= LOGIN_MAX_FAILS) {
      loginState.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
      loginState.fails = 0;
    }
    return res.status(401).json({ error: "Code incorrect." });
  }

  loginState.fails = 0;
  loginState.lockedUntil = 0;
  res.json({ token: createSession() });
});

app.post("/api/auth/change-pin", requireAuth, (req, res) => {
  const auth = getAuthConfig();
  const { currentPin, newPin } = req.body || {};
  if (!auth || !PIN_REGEX.test(currentPin || "") || !verifyPin(currentPin, auth.salt, auth.hash)) {
    return res.status(401).json({ error: "Code actuel incorrect." });
  }
  if (!PIN_REGEX.test(newPin || "")) return res.status(400).json({ error: "Le nouveau code doit contenir 6 chiffres." });

  const salt = makeSalt();
  setSetting("auth_pin", { salt, hash: hashPin(newPin, salt) });

  // Un changement de code déconnecte tous les appareils (y compris celui-ci), par sécurité.
  db.prepare("DELETE FROM sessions").run();
  res.json({ token: createSession() });
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  const token = (req.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  res.json({ ok: true });
});

// ---------- API ----------

app.get("/api/meta", (req, res) => {
  res.json({ days: DAYS, dayLabels: DAY_LABELS, meals: MEALS, mealLabels: MEAL_LABELS, tagLabels: TAG_LABELS, rayonOrder: RAYON_ORDER });
});

app.get("/api/week", (req, res) => {
  const planRows = db.prepare("SELECT * FROM weekly_plan").all();
  const planByKey = {};
  for (const row of planRows) planByKey[`${row.day}__${row.meal_type}`] = row;

  function buildMeal(day, meal) {
    const key = `${day}__${meal}`;
    const plan = planByKey[key] || { recipe_id: null, nb_personnes: meal === "dessert" ? 4 : 2, portion_bonus: 0, cancelled: 0 };
    return {
      mealType: meal,
      label: MEAL_LABELS[meal],
      options: resolveOptions(day, meal),
      selected: {
        recipeId: plan.recipe_id,
        nbPersonnes: plan.nb_personnes,
        portionBonus: !!plan.portion_bonus,
        cancelled: !!plan.cancelled,
      },
    };
  }

  const week = DAYS.map((day) => {
    const meals = MEALS.map((meal) => buildMeal(day, meal));
    if (day === "samedi") meals.push(buildMeal(day, "dessert"));
    return { day, label: DAY_LABELS[day], meals };
  });

  res.json({ week });
});

app.post("/api/options/:day/:meal/reroll", (req, res) => {
  const { day, meal } = req.params;
  if (!isValidSlot(day, meal)) {
    return res.status(400).json({ error: "Jour ou repas invalide." });
  }
  const options = resolveOptions(day, meal, { forceReroll: true });
  res.json({ options });
});

app.post("/api/options/:day/:meal/zero-effort", (req, res) => {
  const { day, meal } = req.params;
  if (!isValidSlot(day, meal)) {
    return res.status(400).json({ error: "Jour ou repas invalide." });
  }
  const favorites = getFavoritesMap();
  const isWeekend = WEEKEND_DAYS.includes(day);
  const season = getCurrentSeason();
  const rows = db.prepare("SELECT id, weekend_only, tags, season FROM recipes WHERE meal_type = ?").all(meal);
  const ids = rows
    .filter((r) => (isWeekend ? true : !r.weekend_only))
    .filter((r) => isInSeason(r.season, season))
    .filter((r) => favorites[r.id] !== "banned")
    .filter((r) => JSON.parse(r.tags || "[]").includes("zero-effort"))
    .map((r) => r.id)
    .slice(0, 3);

  if (!ids.length) return res.json({ options: [] });

  db.prepare(`
    INSERT INTO current_options (day, meal_type, recipe_ids) VALUES (?, ?, ?)
    ON CONFLICT(day, meal_type) DO UPDATE SET recipe_ids = excluded.recipe_ids
  `).run(day, meal, JSON.stringify(ids));

  res.json({ options: ids.map((id) => getRecipeSummary(id, favorites)).filter(Boolean) });
});

app.put("/api/plan/:day/:meal", (req, res) => {
  const { day, meal } = req.params;
  if (!isValidSlot(day, meal)) {
    return res.status(400).json({ error: "Jour ou repas invalide." });
  }
  const { recipeId = null, nbPersonnes = 2, portionBonus = false, cancelled = false } = req.body || {};

  if (recipeId) {
    const validIds = resolveOptions(day, meal).map((r) => r.id);
    if (!validIds.includes(recipeId)) {
      return res.status(400).json({ error: "Cette recette n'est pas une option proposée pour ce repas." });
    }
  }

  const nb = Math.max(1, Math.min(12, Number(nbPersonnes) || 1));

  db.prepare(`
    INSERT INTO weekly_plan (day, meal_type, recipe_id, nb_personnes, portion_bonus, cancelled)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, meal_type) DO UPDATE SET
      recipe_id = excluded.recipe_id,
      nb_personnes = excluded.nb_personnes,
      portion_bonus = excluded.portion_bonus,
      cancelled = excluded.cancelled
  `).run(day, meal, recipeId, nb, portionBonus ? 1 : 0, cancelled ? 1 : 0);

  res.json({ ok: true });
});

app.get("/api/recipes/:id", (req, res) => {
  const nb = Math.max(1, Math.min(12, Number(req.query.personnes) || 2));
  const recipe = getRecipeDetail(req.params.id, nb);
  if (!recipe) return res.status(404).json({ error: "Recette introuvable." });
  res.json(recipe);
});

app.patch("/api/recipes/:id/favorite", (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};
  const recipe = db.prepare("SELECT 1 FROM recipes WHERE id = ?").get(id);
  if (!recipe) return res.status(404).json({ error: "Recette introuvable." });

  if (status === "loved" || status === "banned") {
    db.prepare(`
      INSERT INTO favorites (recipe_id, status) VALUES (?, ?)
      ON CONFLICT(recipe_id) DO UPDATE SET status = excluded.status
    `).run(id, status);
  } else {
    db.prepare("DELETE FROM favorites WHERE recipe_id = ?").run(id);
  }
  res.json({ ok: true, status: status === "loved" || status === "banned" ? status : null });
});

app.get("/api/shopping-list", (req, res) => {
  const planRows = db.prepare("SELECT * FROM weekly_plan WHERE recipe_id IS NOT NULL AND cancelled = 0").all();

  const aggregate = new Map();
  const usedRecipes = [];

  for (const plan of planRows) {
    const ingredientRows = db
      .prepare("SELECT name, rayon, qty_per_person, unit FROM ingredients WHERE recipe_id = ?")
      .all(plan.recipe_id);
    const extra = (plan.meal_type === "diner" || plan.meal_type === "dejeuner") && plan.portion_bonus ? 1 : 0;
    const portions = plan.nb_personnes + extra;

    const recipe = getRecipeSummary(plan.recipe_id);
    usedRecipes.push({ day: plan.day, mealType: plan.meal_type, recipe, nbPersonnes: plan.nb_personnes, portionBonus: !!plan.portion_bonus });

    for (const ing of ingredientRows) {
      const key = `${ing.name}|${ing.unit}|${ing.rayon}`;
      aggregate.set(key, (aggregate.get(key) || 0) + ing.qty_per_person * portions);
    }
  }

  const byRayon = {};
  for (const [key, qty] of aggregate.entries()) {
    const [name, unit, rayon] = key.split("|");
    if (!byRayon[rayon]) byRayon[rayon] = [];
    byRayon[rayon].push({ name, unit, qty: roundQty(qty) });
  }

  const rayons = RAYON_ORDER.filter((r) => byRayon[r]).map((rayon) => ({
    rayon,
    items: byRayon[rayon].sort((a, b) => a.name.localeCompare(b.name, "fr")),
  }));

  res.json({ rayons, usedRecipes, isEmpty: planRows.length === 0 });
});

// ---------- Rappels Web Push ----------

app.get("/api/push/vapid-public-key", (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post("/api/push/subscribe", (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: "Abonnement invalide." });
  db.prepare(`
    INSERT INTO push_subscriptions (endpoint, subscription_json, created_at) VALUES (?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET subscription_json = excluded.subscription_json
  `).run(sub.endpoint, JSON.stringify(sub), new Date().toISOString());
  res.json({ ok: true });
});

app.post("/api/push/unsubscribe", (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  res.json({ ok: true });
});

app.get("/api/settings/reminder", (req, res) => {
  res.json(getSetting("reminder", DEFAULT_REMINDER));
});

app.put("/api/settings/reminder", (req, res) => {
  const { enabled = false, time = "17:00", mealType = "diner" } = req.body || {};
  if (!MEALS.includes(mealType)) return res.status(400).json({ error: "Repas invalide." });
  if (!/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ error: "Heure invalide (HH:MM)." });
  const value = { enabled: !!enabled, time, mealType };
  setSetting("reminder", value);
  res.json(value);
});

app.get("/api/settings/tisane", (req, res) => {
  res.json(getSetting("tisane", DEFAULT_TISANE));
});

app.put("/api/settings/tisane", (req, res) => {
  const { enabled = false, time = "20:30" } = req.body || {};
  if (!/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ error: "Heure invalide (HH:MM)." });
  const value = { enabled: !!enabled, time };
  setSetting("tisane", value);
  res.json(value);
});

app.get("/api/settings/planning", (req, res) => {
  res.json(getSetting("planning", DEFAULT_PLANNING));
});

app.put("/api/settings/planning", (req, res) => {
  const { enabled = false, time = "19:00" } = req.body || {};
  if (!/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ error: "Heure invalide (HH:MM)." });
  const value = { enabled: !!enabled, time };
  setSetting("planning", value);
  res.json(value);
});

// ---------- Boucle de rappels (vérifie chaque minute) ----------

function checkReminder() {
  const reminder = getSetting("reminder", DEFAULT_REMINDER);
  if (!reminder.enabled) return;

  const now = getParisNow();
  const currentHHMM = `${now.hh}:${now.mm}`;
  if (currentHHMM !== reminder.time) return;

  const lastSent = getSetting("reminder_last_sent", null);
  if (lastSent === now.dateStr) return;

  const plan = db.prepare("SELECT * FROM weekly_plan WHERE day = ? AND meal_type = ?").get(now.dayKey, reminder.mealType);
  const mealLabel = MEAL_LABELS[reminder.mealType];

  let body;
  if (plan && plan.recipe_id && !plan.cancelled) {
    const recipe = db.prepare("SELECT name, prep_minutes FROM recipes WHERE id = ?").get(plan.recipe_id);
    body = recipe ? `${mealLabel} de ce soir : ${recipe.name} (${recipe.prep_minutes} min)` : `Pense à ton ${mealLabel.toLowerCase()} !`;
  } else if (plan && plan.cancelled) {
    return; // repas annulé, pas de rappel
  } else {
    body = `Tu n'as pas encore choisi ton ${mealLabel.toLowerCase()} d'aujourd'hui !`;
  }

  sendToAll(db, { title: "The menu, please 🍽️", body, icon: "/icons/icon-192.png" });
  setSetting("reminder_last_sent", now.dateStr);
}

function checkTisane() {
  const tisane = getSetting("tisane", DEFAULT_TISANE);
  if (!tisane.enabled) return;

  const now = getParisNow();
  const currentHHMM = `${now.hh}:${now.mm}`;
  if (currentHHMM !== tisane.time) return;

  const lastSent = getSetting("tisane_last_sent", null);
  if (lastSent === now.dateStr) return;

  sendToAll(db, {
    title: "Rituel tisane 🍵",
    body: "Une tisane sans sucre (camomille, verveine), un moment calme avant le coucher — pour calmer le grignotage de fin de soirée.",
    icon: "/icons/icon-192.png",
  });
  setSetting("tisane_last_sent", now.dateStr);
}

function checkPlanning() {
  const planning = getSetting("planning", DEFAULT_PLANNING);
  if (!planning.enabled) return;

  const now = getParisNow();
  if (now.dayKey !== "dimanche") return;
  const currentHHMM = `${now.hh}:${now.mm}`;
  if (currentHHMM !== planning.time) return;

  const lastSent = getSetting("planning_last_sent", null);
  if (lastSent === now.dateStr) return;

  sendToAll(db, {
    title: "The menu, please 🍽️",
    body: "As-tu prévu ta semaine ? 5 min suffisent pour attaquer lundi tranquille.",
    icon: "/icons/icon-192.png",
  });
  setSetting("planning_last_sent", now.dateStr);
}

setInterval(() => {
  checkReminder();
  checkTisane();
  checkPlanning();
}, 60 * 1000);

app.use(express.static(path.join(__dirname, "..", "public")));

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Ta popote TDAH tourne sur http://localhost:${PORT}`);
});
