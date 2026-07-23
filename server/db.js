const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { recipes } = require("./seed/recipes");
const { DAYS, MEALS, weekOptions } = require("./seed/weekOptions");

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "menu.sqlite");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS recipes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    meal_type TEXT NOT NULL,
    prep_minutes INTEGER NOT NULL,
    weekend_only INTEGER NOT NULL DEFAULT 0,
    ratio TEXT,
    tags TEXT,
    spices TEXT,
    steps TEXT
  );

  CREATE TABLE IF NOT EXISTS ingredients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipe_id TEXT NOT NULL REFERENCES recipes(id),
    name TEXT NOT NULL,
    rayon TEXT NOT NULL,
    qty_per_person REAL NOT NULL,
    unit TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS day_meal_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day TEXT NOT NULL,
    meal_type TEXT NOT NULL,
    recipe_id TEXT NOT NULL REFERENCES recipes(id),
    position INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS weekly_plan (
    day TEXT NOT NULL,
    meal_type TEXT NOT NULL,
    recipe_id TEXT REFERENCES recipes(id),
    nb_personnes INTEGER NOT NULL DEFAULT 2,
    portion_bonus INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, meal_type)
  );
`);

function seedIfEmpty() {
  const { count } = db.prepare("SELECT COUNT(*) AS count FROM recipes").get();
  if (count > 0) return;

  const insertRecipe = db.prepare(`
    INSERT INTO recipes (id, name, meal_type, prep_minutes, weekend_only, ratio, tags, spices, steps)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertIngredient = db.prepare(`
    INSERT INTO ingredients (recipe_id, name, rayon, qty_per_person, unit)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const r of recipes) {
    insertRecipe.run(
      r.id,
      r.name,
      r.mealType,
      r.prepMinutes,
      r.weekendOnly ? 1 : 0,
      r.ratio || "",
      JSON.stringify(r.tags || []),
      JSON.stringify(r.spices || []),
      JSON.stringify(r.steps || [])
    );
    for (const ing of r.ingredients) {
      insertIngredient.run(r.id, ing.name, ing.rayon, ing.qtyPerPerson, ing.unit);
    }
  }

  const insertOption = db.prepare(`
    INSERT INTO day_meal_options (day, meal_type, recipe_id, position)
    VALUES (?, ?, ?, ?)
  `);
  for (const meal of MEALS) {
    for (const day of DAYS) {
      const ids = weekOptions[meal][day];
      ids.forEach((recipeId, i) => {
        insertOption.run(day, meal, recipeId, i + 1);
      });
    }
  }

  const insertPlan = db.prepare(`
    INSERT OR IGNORE INTO weekly_plan (day, meal_type, recipe_id, nb_personnes, portion_bonus)
    VALUES (?, ?, NULL, 2, 0)
  `);
  for (const meal of MEALS) {
    for (const day of DAYS) {
      insertPlan.run(day, meal);
    }
  }
}

seedIfEmpty();

module.exports = { db, DAYS, MEALS };
