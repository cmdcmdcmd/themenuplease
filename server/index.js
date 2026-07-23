const express = require("express");
const path = require("node:path");
const { db, DAYS, MEALS } = require("./db");

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
};

const TAG_LABELS = {
  "proteines-matin": "Protéines dès le matin",
  "omega-3": "Oméga-3",
  "fer-magnesium": "Fer & magnésium",
};

function parseRecipeRow(row) {
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
  };
}

function getRecipeSummary(id) {
  const row = db.prepare("SELECT * FROM recipes WHERE id = ?").get(id);
  return row ? parseRecipeRow(row) : null;
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

function roundQty(n) {
  return Math.round(n * 100) / 100;
}

// ---------- API ----------

app.get("/api/meta", (req, res) => {
  res.json({ days: DAYS, dayLabels: DAY_LABELS, meals: MEALS, mealLabels: MEAL_LABELS, tagLabels: TAG_LABELS, rayonOrder: RAYON_ORDER });
});

app.get("/api/week", (req, res) => {
  const planRows = db.prepare("SELECT * FROM weekly_plan").all();
  const planByKey = {};
  for (const row of planRows) {
    planByKey[`${row.day}__${row.meal_type}`] = row;
  }

  const optionRows = db
    .prepare("SELECT day, meal_type, recipe_id, position FROM day_meal_options ORDER BY position ASC")
    .all();
  const optionsByKey = {};
  for (const row of optionRows) {
    const key = `${row.day}__${row.meal_type}`;
    if (!optionsByKey[key]) optionsByKey[key] = [];
    optionsByKey[key].push(getRecipeSummary(row.recipe_id));
  }

  const week = DAYS.map((day) => ({
    day,
    label: DAY_LABELS[day],
    meals: MEALS.map((meal) => {
      const key = `${day}__${meal}`;
      const plan = planByKey[key] || { recipe_id: null, nb_personnes: 2, portion_bonus: 0 };
      return {
        mealType: meal,
        label: MEAL_LABELS[meal],
        options: optionsByKey[key] || [],
        selected: {
          recipeId: plan.recipe_id,
          nbPersonnes: plan.nb_personnes,
          portionBonus: !!plan.portion_bonus,
        },
      };
    }),
  }));

  res.json({ week });
});

app.put("/api/plan/:day/:meal", (req, res) => {
  const { day, meal } = req.params;
  if (!DAYS.includes(day) || !MEALS.includes(meal)) {
    return res.status(400).json({ error: "Jour ou repas invalide." });
  }
  const { recipeId = null, nbPersonnes = 2, portionBonus = false } = req.body || {};

  if (recipeId) {
    const validOption = db
      .prepare("SELECT 1 FROM day_meal_options WHERE day = ? AND meal_type = ? AND recipe_id = ?")
      .get(day, meal, recipeId);
    if (!validOption) {
      return res.status(400).json({ error: "Cette recette n'est pas une option proposée pour ce repas." });
    }
  }

  const nb = Math.max(1, Math.min(12, Number(nbPersonnes) || 1));

  db.prepare(`
    INSERT INTO weekly_plan (day, meal_type, recipe_id, nb_personnes, portion_bonus)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(day, meal_type) DO UPDATE SET
      recipe_id = excluded.recipe_id,
      nb_personnes = excluded.nb_personnes,
      portion_bonus = excluded.portion_bonus
  `).run(day, meal, recipeId, nb, portionBonus ? 1 : 0);

  res.json({ ok: true });
});

app.get("/api/recipes/:id", (req, res) => {
  const nb = Math.max(1, Math.min(12, Number(req.query.personnes) || 2));
  const recipe = getRecipeDetail(req.params.id, nb);
  if (!recipe) return res.status(404).json({ error: "Recette introuvable." });
  res.json(recipe);
});

app.get("/api/shopping-list", (req, res) => {
  const planRows = db.prepare("SELECT * FROM weekly_plan WHERE recipe_id IS NOT NULL").all();

  const aggregate = new Map(); // key: name|unit|rayon -> qty
  const usedRecipes = [];

  for (const plan of planRows) {
    const ingredientRows = db
      .prepare("SELECT name, rayon, qty_per_person, unit FROM ingredients WHERE recipe_id = ?")
      .all(plan.recipe_id);
    const extra = plan.meal_type === "diner" && plan.portion_bonus ? 1 : 0;
    const portions = plan.nb_personnes + extra;

    const recipe = getRecipeSummary(plan.recipe_id);
    usedRecipes.push({ day: plan.day, mealType: plan.meal_type, recipe, nbPersonnes: plan.nb_personnes, portionBonus: !!plan.portion_bonus });

    for (const ing of ingredientRows) {
      const key = `${ing.name}|${ing.unit}|${ing.rayon}`;
      const qty = ing.qty_per_person * portions;
      aggregate.set(key, (aggregate.get(key) || 0) + qty);
    }
  }

  const byRayon = {};
  for (const [key, qty] of aggregate.entries()) {
    const [name, unit, rayon] = key.split("|");
    if (!byRayon[rayon]) byRayon[rayon] = [];
    byRayon[rayon].push({ name, unit, qty: roundQty(qty) });
  }

  const rayons = RAYON_ORDER.filter((r) => byRayon[r])
    .map((rayon) => ({
      rayon,
      items: byRayon[rayon].sort((a, b) => a.name.localeCompare(b.name, "fr")),
    }));

  res.json({ rayons, usedRecipes, isEmpty: planRows.length === 0 });
});

app.use(express.static(path.join(__dirname, "..", "public")));

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Ta popote TDAH tourne sur http://localhost:${PORT}`);
});
