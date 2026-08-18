const express = require("express");
const path = require("node:path");
const { db, DAYS, MEALS } = require("./db");
const { vapidKeys, sendToAll, getParisNow, getCurrentSeason } = require("./push");
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

// ---------- Catégorisation nutritionnelle des ingrédients (pour les pastilles colorées) ----------
// Le rayon (aisle de courses) ne suffit pas : la crèmerie mélange laitages protéinés
// et beurre/crème (matière grasse), l'épicerie mélange féculents et condiments, etc.
// On croise mots-clés sur le nom + repli sur le rayon.
const GLUCIDE_KEYWORDS = [
  "riz", "pâtes", "quinoa", "farine", "pain", "pita", "tortilla", "galette", "crêpe",
  "semoule", "boulgour", "avoine", "flocons", "nouilles", "maïzena", "chapelure",
  "croûtons", "lasagne", "épeautre", "granola", "biscotte",
];
const PROTEINE_KEYWORDS = [
  "œuf", "oeuf", "poulet", "dinde", "bœuf", "boeuf", "porc", "veau", "agneau", "jambon",
  "lardons", "bacon", "saumon", "cabillaud", "thon", "poisson", "crevette", "moule",
  "saint-jacques", "hareng", "anchois", "maquereau", "sardine", "truite", "lieu", "colin",
  "merlu", "dorade", "tofu", "tempeh", "seitan", "falafel", "edamame", "pois chiche",
  "haricots blancs", "haricots rouges", "haricots noirs", "haricot blanc", "haricot rouge",
  "lentille", "houmous", "fromage", "chèvre", "comté", "emmental", "feta",
  "mozzarella", "parmesan", "ricotta", "yaourt", "yogourt", "skyr", "faisselle",
  "cottage", "kéfir", "amande", "noisette", "noix", "graine", "sésame", "tahini",
  "cacahuète", "soja",
];
const LEGUME_EXTRA_KEYWORDS = [
  "petits pois", "fruits rouges", "tomates concassées", "maïs", "algue", "pruneaux",
  "raisins secs", "cranberries", "restes de légumes", "olives",
];
const AUTRE_KEYWORDS = [
  "beurre", "crème", "lait", "sucre", "miel", "vinaigre", "vin", "levure",
  "cacao", "pépites", "bouillon", "fumet",
];
// Exceptions vérifiées en tout premier, avant les listes glucide/protéine/légume
// génériques, pour les cas où un mot-clé plus large matcherait à tort une phrase
// composée : "sauce soja" n'est pas une vraie source de protéines (contrairement au
// soja seul) ; "huile d'olive" n'est pas un légume (contrairement à l'olive seule) ;
// "pâte miso"/"pâte de curry" sont des condiments, pas des féculents (contrairement
// à "pâte feuilletée"/"pâte à pizza", elles, bien glucides).
const AUTRE_OVERRIDE_PHRASES = ["sauce soja", "huile", "pâte miso", "pâte de curry"];
const RAYON_MACRO_FALLBACK = {
  "Fruits & légumes": "legume",
  "Viandes, poissons & œufs": "proteine",
  "Crèmerie": "proteine",
  "Boulangerie": "glucide",
  "Surgelés": "legume",
  "Épicerie": "autre",
  "Épices & condiments": "autre",
};
// Mots entiers uniquement (pas de correspondance en sous-chaîne) pour éviter les faux
// positifs du type "veau" trouvé à l'intérieur de "nouveau". Les entrées à plusieurs
// mots (ex. "pois chiche", "saint-jacques") restent en recherche de sous-chaîne : elles
// sont assez spécifiques pour ne pas produire de faux positifs.
function nameWords(n) {
  return n.split(/[^a-zàâäéèêëïîôöùûüçœ]+/i).filter(Boolean);
}
// Les mots-clés sont au singulier ; les noms d'ingrédients sont le plus souvent au
// pluriel ("amandes", "graines"). On retire un "s" final avant de comparer.
function singularize(w) {
  return w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w;
}
function matchesKeyword(words, n, keyword) {
  if (keyword.includes(" ") || keyword.includes("-")) return n.includes(keyword);
  const k = singularize(keyword);
  return words.some((w) => singularize(w) === k);
}
function classifyIngredientMacro(name, rayon) {
  // Rayon "Viandes, poissons & œufs" : toujours une protéine, même si le nom contient
  // un mot-clé "autre" (ex. "Harengs fumés à l'huile" ne doit pas basculer sur l'huile).
  if (rayon === "Viandes, poissons & œufs") return "proteine";
  const n = name.toLowerCase();
  const words = nameWords(n);
  const has = (list) => list.some((k) => matchesKeyword(words, n, k));
  if (has(AUTRE_OVERRIDE_PHRASES)) return "autre";
  if (has(GLUCIDE_KEYWORDS)) return "glucide";
  if (has(PROTEINE_KEYWORDS)) return "proteine";
  if (has(LEGUME_EXTRA_KEYWORDS)) return "legume";
  if (has(AUTRE_KEYWORDS)) return "autre";
  return RAYON_MACRO_FALLBACK[rayon] || "autre";
}

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
    macro: classifyIngredientMacro(i.name, i.rayon),
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

  const overrideRow = db
    .prepare("SELECT recipe_ids FROM current_options WHERE day = ? AND meal_type = ?")
    .get(day, meal);
  const currentIds = overrideRow ? JSON.parse(overrideRow.recipe_ids) : [];

  let ids;
  if (forceReroll) {
    // Une vraie roulette : on exclut les options actuellement affichées.
    const pool = pickEligiblePool(meal, day, currentIds, favorites);
    ids = pool.slice(0, 3);
    if (ids.length < 3) {
      // Pool trop petit une fois l'exclusion appliquée : on complète sans exclure.
      const fallback = pickEligiblePool(meal, day, [], favorites).filter((id) => !ids.includes(id));
      ids = ids.concat(fallback).slice(0, 3);
    }
  } else if (overrideRow) {
    ids = currentIds.filter((id) => favorites[id] !== "banned" && isInSeason(seasonMap[id], season));
    if (ids.length < 3) {
      const pool = pickEligiblePool(meal, day, ids, favorites);
      ids = ids.concat(pool.slice(0, 3 - ids.length));
    }
  } else {
    // Premier affichage de ce créneau : tirage aléatoire dans le pool éligible
    // (saison + week-end déjà filtrés), pas une liste fixe toujours identique.
    ids = pickEligiblePool(meal, day, [], favorites).slice(0, 3);
  }

  const changed = forceReroll || !overrideRow || JSON.stringify(ids) !== JSON.stringify(currentIds);
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

// ---------- "Ce qu'il reste dans le frigo ?" — suggestions via l'API Claude ----------

const FRIDGE_MODEL = process.env.ANTHROPIC_FRIDGE_MODEL || "claude-sonnet-5";

function buildFridgeSystemPrompt() {
  const rayons = RAYON_ORDER.map((r) => `"${r}"`).join(" | ");
  return `Tu es l'assistant culinaire de "The menu, please", une application de planification de repas pensée pour des familles avec profil TDAH (adultes et enfants).

L'utilisateur va te donner en vrac, en langage libre, ce qu'il lui reste dans le frigo et ses placards. Ta tâche : proposer EXACTEMENT 3 recettes réalisables avec ces ingrédients + les basiques de placard suivants, toujours considérés disponibles sans qu'il soit besoin de les citer :
- féculents : riz, pâtes, quinoa, semoule, pommes de terre, farine
- condiments/assaisonnement : sel, poivre, huile, vinaigre, ail, oignon, épices courantes, sucre, beurre, bouillon

Utilise ces féculents de base librement dans tes 3 recettes (pas besoin qu'ils soient mentionnés par l'utilisateur) — la plupart des foyers en ont toujours sous la main.

Contraintes strictes :
- N'utilise QUE les ingrédients donnés par l'utilisateur + les basiques de placard ci-dessus (féculents + condiments/assaisonnement). N'invente et n'ajoute JAMAIS un ingrédient qui ne soit ni cité par l'utilisateur ni dans cette liste — en particulier aucune viande, poisson, charcuterie, œuf, fromage ou produit laitier qui ne serait pas explicitement donné par l'utilisateur : ce ne sont pas des basiques de placard, même s'ils semblent courants.
- "Farine" dans les basiques veut dire de la farine crue à cuisiner (pour épaissir, paner, faire des crêpes/galettes simples) — ça ne veut PAS dire une pâte à tarte/pâte brisée/pâte feuilletée toute prête. Ne propose une tarte, quiche ou pâtisserie que si l'utilisateur a explicitement une pâte dans sa liste.
- Chaque recette doit être un plat cohérent et réellement appétissant avec les ingrédients disponibles — n'assemble pas des ingrédients juste pour "tout utiliser" si la combinaison ne fait pas un plat sensé. Si tu ne peux pas faire un plat cohérent avec certains ingrédients de la liste de l'utilisateur, laisse-les simplement de côté dans cette recette plutôt que de forcer une association bizarre.
- Difficulté 1 ou 2 uniquement (1 = très simple, ~10-15 min, très peu d'étapes ; 2 = simple, ~20-30 min, quelques étapes) — jamais plus complexe, jamais de technique avancée.
- Logique nutritionnelle TDAH : privilégie les protéines (précurseurs de dopamine), les fibres, et évite les sucres rapides isolés qui provoquent des pics puis chutes de glycémie (aggravant les difficultés de concentration) ; assiette copieuse mais pas lourde.
- Intitulés courts et clairs, sans jargon.
- Étapes très courtes, une action par étape, formulées à l'impératif — pensées pour quelqu'un qui décroche vite face à une recette longue.
- Les quantités d'ingrédients sont données PAR PERSONNE (qty_per_person, pour une base de 2 personnes divisible) — reste cohérent et réaliste.

Réponds UNIQUEMENT avec un JSON strict, sans aucun texte avant ou après, sans balises markdown (pas de \`\`\`), exactement sous cette forme (un tableau de 3 objets) :

[
  {
    "nom": "string",
    "temps_min": number,
    "difficulte": 1,
    "ingredients": [
      { "name": "string", "rayon": ${rayons}, "qty_per_person": number, "unit": "string" }
    ],
    "etapes": ["string"],
    "atouts_tdah": "string — 1 à 2 phrases concrètes (pas génériques) sur ce que cette recette apporte pour un cerveau TDAH"
  }
]`;
}

async function callAnthropic(systemPrompt, userMessage) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error("La clé ANTHROPIC_API_KEY n'est pas configurée côté serveur.");
    err.status = 500;
    throw err;
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: FRIDGE_MODEL,
      max_tokens: 4096,
      temperature: 0.7,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Erreur de l'API Claude (${res.status}).`);
    err.status = 502;
    err.detail = body.slice(0, 300);
    throw err;
  }
  const data = await res.json();
  return (data.content || []).map((b) => b.text || "").join("");
}

function validateFridgeRecipe(r) {
  return (
    !!r &&
    typeof r.nom === "string" && r.nom.trim().length > 0 &&
    Number.isFinite(r.temps_min) && r.temps_min > 0 &&
    (r.difficulte === 1 || r.difficulte === 2) &&
    Array.isArray(r.ingredients) && r.ingredients.length > 0 &&
    r.ingredients.every((i) =>
      i && typeof i.name === "string" && i.name.trim().length > 0 &&
      RAYON_ORDER.includes(i.rayon) &&
      Number.isFinite(i.qty_per_person) && i.qty_per_person > 0 &&
      typeof i.unit === "string" && i.unit.trim().length > 0
    ) &&
    Array.isArray(r.etapes) && r.etapes.length > 0 &&
    r.etapes.every((s) => typeof s === "string" && s.trim().length > 0) &&
    typeof r.atouts_tdah === "string" && r.atouts_tdah.trim().length > 0
  );
}

// Extrait un premier bloc JSON même si le modèle a malgré tout entouré sa
// réponse de texte ou de balises markdown, plutôt que d'échouer directement.
function extractJson(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    const start = trimmed.indexOf("[");
    const end = trimmed.lastIndexOf("]");
    if (start === -1 || end === -1) throw e;
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

app.post("/api/fridge/suggest", async (req, res) => {
  const ingredientsText = String((req.body || {}).ingredients || "").trim();
  if (!ingredientsText) return res.status(400).json({ error: "Décris d'abord ce qu'il te reste." });
  if (ingredientsText.length > 500) return res.status(400).json({ error: "Décris plus court (500 caractères max)." });

  try {
    const text = await callAnthropic(buildFridgeSystemPrompt(), ingredientsText);
    let parsed;
    try {
      parsed = extractJson(text);
    } catch (e) {
      return res.status(502).json({ error: "Réponse illisible de l'assistant, réessaie." });
    }
    if (!Array.isArray(parsed) || parsed.length !== 3 || !parsed.every(validateFridgeRecipe)) {
      return res.status(502).json({ error: "Réponse incomplète de l'assistant, réessaie." });
    }
    const recipes = parsed.map((r) => ({
      ...r,
      ingredients: r.ingredients.map((i) => ({ ...i, macro: classifyIngredientMacro(i.name, i.rayon) })),
    }));
    res.json({ recipes });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "Erreur inattendue." });
  }
});

function slugify(s) {
  return s
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "recette";
}

// Repas cible selon l'heure : avant 9h le petit-déj n'est pas encore passé, avant
// 14h on vise le déjeuner, sinon le dîner du soir.
function fridgeTargetMealType() {
  const hour = Number(getParisNow().hh);
  if (hour < 9) return "petit-dej";
  if (hour < 14) return "dejeuner";
  return "diner";
}

// Premier créneau libre (sans recette, ou annulé) pour ce type de repas, à partir
// d'aujourd'hui puis en avançant jour par jour sur le reste de la semaine.
function findNextAvailableSlot(mealType) {
  const startIdx = DAYS.indexOf(getParisNow().dayKey);
  for (let i = 0; i < DAYS.length; i++) {
    const day = DAYS[(startIdx + i) % DAYS.length];
    const row = db.prepare("SELECT recipe_id, cancelled FROM weekly_plan WHERE day = ? AND meal_type = ?").get(day, mealType);
    if (!row || !row.recipe_id || row.cancelled) return day;
  }
  return null;
}

app.post("/api/fridge/keep", (req, res) => {
  const r = req.body;
  if (!validateFridgeRecipe(r)) return res.status(400).json({ error: "Recette invalide." });

  const mealType = fridgeTargetMealType();

  const exists = (rid) => !!db.prepare("SELECT 1 FROM recipes WHERE id = ?").get(rid);
  let id = `frigo-${slugify(r.nom)}`;
  if (exists(id)) {
    let i = 2;
    while (exists(`${id}-${i}`)) i++;
    id = `${id}-${i}`;
  }

  db.prepare(`
    INSERT INTO recipes (id, name, meal_type, prep_minutes, weekend_only, ratio, tags, spices, steps, inspiration, season)
    VALUES (?, ?, ?, ?, 0, ?, ?, '[]', ?, ?, '[]')
  `).run(
    id,
    r.nom.trim(),
    mealType,
    Math.round(r.temps_min),
    r.atouts_tdah.trim(),
    JSON.stringify(["frigo-ia", `difficulte-${r.difficulte}`]),
    JSON.stringify(r.etapes.map((s) => s.trim())),
    "Suggestion IA — frigo"
  );

  const insertIngredient = db.prepare(`
    INSERT INTO ingredients (recipe_id, name, rayon, qty_per_person, unit)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const ing of r.ingredients) {
    insertIngredient.run(id, ing.name.trim(), ing.rayon, ing.qty_per_person, ing.unit.trim());
  }

  const slotDay = findNextAvailableSlot(mealType);
  if (slotDay) {
    db.prepare(`
      INSERT INTO weekly_plan (day, meal_type, recipe_id, nb_personnes, portion_bonus, cancelled)
      VALUES (?, ?, ?, 2, 0, 0)
      ON CONFLICT(day, meal_type) DO UPDATE SET recipe_id = excluded.recipe_id, cancelled = 0
    `).run(slotDay, mealType, id);
  }

  res.json({ ok: true, id, planned: slotDay ? { day: slotDay, meal: mealType } : null });
});

app.get("/api/shopping-list", (req, res) => {
  const planRows = db.prepare("SELECT * FROM weekly_plan WHERE recipe_id IS NOT NULL AND cancelled = 0").all();

  // Clé sans le rayon : un même ingrédient peut être classé dans des rayons différents
  // selon la recette d'où il vient (incohérence de données) ; le fusionner uniquement
  // sur nom+unité évite d'afficher deux lignes pour le même ingrédient. Le rayon
  // d'affichage retenu est celui de la première occurrence rencontrée.
  const aggregate = new Map();
  const rayonByKey = new Map();
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
      const key = `${ing.name}|${ing.unit}`;
      aggregate.set(key, (aggregate.get(key) || 0) + ing.qty_per_person * portions);
      if (!rayonByKey.has(key)) rayonByKey.set(key, ing.rayon);
    }
  }

  const byRayon = {};
  for (const [key, qty] of aggregate.entries()) {
    const [name, unit] = key.split("|");
    const rayon = rayonByKey.get(key);
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
