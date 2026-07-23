(() => {
  "use strict";

  const MEAL_ICON = { "petit-dej": "☀️", dejeuner: "🥗", diner: "🌙" };
  const DAY_COLORS = ["terracotta", "sun", "sage", "sky"];

  let meta = null;
  let weekData = null; // { week: [...] }
  let picker = { day: null, meal: null, recipeId: null, nbPersonnes: 2, portionBonus: false };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  async function api(path, options) {
    const res = await fetch(path, options);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Erreur ${res.status}`);
    }
    return res.json();
  }

  function showToast(msg) {
    const toast = $("#toast");
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toast.hidden = true; }, 1800);
  }

  // ============ TABS ============
  function initTabs() {
    $$(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        $$(".tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        $$(".view").forEach((v) => (v.hidden = true));
        const target = $("#" + tab.dataset.view);
        target.hidden = false;
        if (tab.dataset.view === "view-shopping") loadShoppingList();
      });
    });
  }

  // ============ WEEK VIEW ============
  async function loadWeek() {
    weekData = await api("/api/week");
    renderWeek();
  }

  function findRecipeInOptions(day, mealType, recipeId) {
    const dayObj = weekData.week.find((d) => d.day === day);
    const mealObj = dayObj.meals.find((m) => m.mealType === mealType);
    return mealObj.options.find((o) => o.id === recipeId) || null;
  }

  function renderWeek() {
    const container = $("#week-list");
    container.innerHTML = "";
    weekData.week.forEach((dayObj, i) => {
      const block = document.createElement("div");
      block.className = "day-block";
      block.dataset.color = DAY_COLORS[i % DAY_COLORS.length];

      const header = document.createElement("div");
      header.className = "day-header";
      header.textContent = dayObj.label;
      block.appendChild(header);

      dayObj.meals.forEach((meal) => {
        block.appendChild(renderMealRow(dayObj, meal));
      });

      container.appendChild(block);
    });
  }

  function renderMealRow(dayObj, meal) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "meal-row";
    row.dataset.day = dayObj.day;
    row.dataset.meal = meal.mealType;

    const icon = document.createElement("span");
    icon.className = `meal-icon ${meal.mealType}`;
    icon.textContent = MEAL_ICON[meal.mealType];
    row.appendChild(icon);

    const info = document.createElement("div");
    info.className = "meal-info";

    const typeLabel = document.createElement("div");
    typeLabel.className = "meal-type-label";
    typeLabel.textContent = meal.label;
    info.appendChild(typeLabel);

    const choice = document.createElement("div");
    const selectedRecipe = meal.selected.recipeId
      ? meal.options.find((o) => o.id === meal.selected.recipeId)
      : null;
    if (selectedRecipe) {
      choice.className = "meal-choice";
      choice.textContent = selectedRecipe.name;
    } else {
      choice.className = "meal-choice empty";
      choice.textContent = "à choisir →";
    }
    info.appendChild(choice);

    if (selectedRecipe) {
      const metaRow = document.createElement("div");
      metaRow.className = "meal-meta";
      metaRow.appendChild(pill(`⏱ ${selectedRecipe.prepMinutes} min`));
      metaRow.appendChild(pill(`👥 ${meal.selected.nbPersonnes}`));
      if (meal.selected.portionBonus) {
        metaRow.appendChild(pill("🍱 +1 demain midi", "bonus"));
      }
      info.appendChild(metaRow);
    }

    row.appendChild(info);

    if (selectedRecipe) {
      const jump = document.createElement("span");
      jump.className = "recipe-jump";
      jump.textContent = "📖";
      jump.addEventListener("click", (e) => {
        e.stopPropagation();
        openRecipeSheet(selectedRecipe.id, meal.selected.nbPersonnes);
      });
      row.appendChild(jump);
    }

    row.addEventListener("click", () => openPicker(dayObj, meal));
    return row;
  }

  function pill(text, extraClass) {
    const span = document.createElement("span");
    span.className = "pill" + (extraClass ? " " + extraClass : "");
    span.textContent = text;
    return span;
  }

  // ============ PICKER SHEET ============
  function openPicker(dayObj, meal) {
    picker = {
      day: dayObj.day,
      meal: meal.mealType,
      recipeId: meal.selected.recipeId,
      nbPersonnes: meal.selected.nbPersonnes || 2,
      portionBonus: !!meal.selected.portionBonus,
    };

    $("#picker-day-meal").textContent = `${dayObj.label} · ${meal.label}`;
    $("#picker-title").textContent = "Choisis ton repas";
    $("#stepper-value").textContent = picker.nbPersonnes;

    const bonusRow = $("#bonus-row");
    bonusRow.hidden = meal.mealType !== "diner";
    $("#bonus-toggle").checked = picker.portionBonus;

    renderPickerOptions(meal.options);
    updateSeeRecipeButton();

    $("#sheet-backdrop").hidden = false;
  }

  function renderPickerOptions(options) {
    const wrap = $("#picker-options");
    wrap.innerHTML = "";
    options.forEach((opt) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "option-card" + (opt.id === picker.recipeId ? " selected" : "");
      card.dataset.id = opt.id;

      const name = document.createElement("div");
      name.className = "opt-name";
      name.textContent = (opt.id === picker.recipeId ? "✓ " : "") + opt.name;
      card.appendChild(name);

      const metaRow = document.createElement("div");
      metaRow.className = "opt-meta";
      metaRow.appendChild(pill(`⏱ ${opt.prepMinutes} min`));
      (opt.tags || []).forEach((tag) => metaRow.appendChild(pill(meta.tagLabels[tag] || tag)));
      card.appendChild(metaRow);

      card.addEventListener("click", () => selectOption(opt.id));
      wrap.appendChild(card);
    });
  }

  async function selectOption(recipeId) {
    picker.recipeId = recipeId;
    renderPickerOptions(findMealOptions());
    updateSeeRecipeButton();
    await savePlan();
  }

  function findMealOptions() {
    const dayObj = weekData.week.find((d) => d.day === picker.day);
    return dayObj.meals.find((m) => m.mealType === picker.meal).options;
  }

  function updateSeeRecipeButton() {
    const btn = $("#btn-see-recipe");
    btn.hidden = !picker.recipeId;
  }

  async function savePlan() {
    await api(`/api/plan/${picker.day}/${picker.meal}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipeId: picker.recipeId,
        nbPersonnes: picker.nbPersonnes,
        portionBonus: picker.portionBonus,
      }),
    });
    await loadWeek();
    showToast("Repas enregistré ✓");
  }

  function initPickerControls() {
    $("#stepper-minus").addEventListener("click", () => changePersonnes(-1));
    $("#stepper-plus").addEventListener("click", () => changePersonnes(1));
    $("#bonus-toggle").addEventListener("change", async (e) => {
      picker.portionBonus = e.target.checked;
      if (picker.recipeId) await savePlan();
    });
    $("#btn-see-recipe").addEventListener("click", () => {
      if (picker.recipeId) openRecipeSheet(picker.recipeId, picker.nbPersonnes);
    });
  }

  let debounceTimer = null;
  function changePersonnes(delta) {
    picker.nbPersonnes = Math.max(1, Math.min(12, picker.nbPersonnes + delta));
    $("#stepper-value").textContent = picker.nbPersonnes;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (picker.recipeId) savePlan();
    }, 350);
  }

  // ============ RECIPE SHEET ============
  async function openRecipeSheet(recipeId, nbPersonnes) {
    const recipe = await api(`/api/recipes/${recipeId}?personnes=${nbPersonnes}`);
    $("#recipe-eyebrow").textContent = `${meta.mealLabels[recipe.mealType]} · ${recipe.prepMinutes} min · ${nbPersonnes} pers.`;
    $("#recipe-title").textContent = recipe.name;

    const content = $("#recipe-content");
    content.innerHTML = "";

    if (recipe.mealType !== "petit-dej") {
      const bar = document.createElement("div");
      bar.className = "ratio-bar";
      bar.innerHTML = `
        <span style="width:50%;background:var(--sage)"></span>
        <span style="width:25%;background:var(--terracotta)"></span>
        <span style="width:25%;background:var(--sun)"></span>`;
      content.appendChild(bar);
      const legend = document.createElement("div");
      legend.className = "ratio-legend";
      legend.textContent = recipe.ratio;
      content.appendChild(legend);
    } else {
      const legend = document.createElement("div");
      legend.className = "ratio-legend";
      legend.textContent = "🍳 " + recipe.ratio;
      content.appendChild(legend);
    }

    if (recipe.spices && recipe.spices.length) {
      const spiceWrap = document.createElement("div");
      spiceWrap.className = "spice-chips";
      recipe.spices.forEach((s) => spiceWrap.appendChild(pill("🌶 " + s)));
      content.appendChild(spiceWrap);
    }

    const ingTitle = document.createElement("div");
    ingTitle.className = "recipe-section-title";
    ingTitle.textContent = `Ingrédients pour ${nbPersonnes} pers.`;
    content.appendChild(ingTitle);

    const ingList = document.createElement("ul");
    ingList.className = "ingredient-list";
    recipe.ingredients.forEach((ing) => {
      const li = document.createElement("li");
      li.innerHTML = `<span>${ing.name}</span><span class="qty">${formatQty(ing.qty)} ${ing.unit}</span>`;
      ingList.appendChild(li);
    });
    content.appendChild(ingList);

    const stepsTitle = document.createElement("div");
    stepsTitle.className = "recipe-section-title";
    stepsTitle.textContent = "Préparation";
    content.appendChild(stepsTitle);

    const stepsList = document.createElement("ol");
    stepsList.className = "steps-list";
    recipe.steps.forEach((s) => {
      const li = document.createElement("li");
      li.textContent = s;
      stepsList.appendChild(li);
    });
    content.appendChild(stepsList);

    $("#sheet-backdrop-recipe").hidden = false;
  }

  function formatQty(n) {
    return Number.isInteger(n) ? n : n.toFixed(2).replace(/\.?0+$/, "");
  }

  // ============ SHOPPING VIEW ============
  function checkKey(name, unit) {
    return `checked__${name}__${unit}`;
  }

  async function loadShoppingList() {
    const data = await api("/api/shopping-list");
    renderShoppingList(data);
  }

  function renderShoppingList(data) {
    const container = $("#shopping-list");
    container.innerHTML = "";

    if (data.isEmpty) {
      container.innerHTML = `
        <div class="empty-state">
          <div style="font-size:2.2rem">🧺</div>
          <p class="hand-note">pas encore de plan cette semaine —<br/>va choisir tes repas dans l'onglet "Ma semaine" !</p>
        </div>`;
      $("#shopping-progress").hidden = true;
      return;
    }

    let total = 0;
    let checked = 0;

    data.rayons.forEach((rayonGroup) => {
      const block = document.createElement("div");
      block.className = "rayon-block";

      const header = document.createElement("div");
      header.className = "rayon-header";
      header.textContent = rayonGroup.rayon;
      block.appendChild(header);

      const itemsWrap = document.createElement("div");
      itemsWrap.className = "rayon-items";

      rayonGroup.items.forEach((item) => {
        total++;
        const key = checkKey(item.name, item.unit);
        const isChecked = localStorage.getItem(key) === "1";
        if (isChecked) checked++;

        const row = document.createElement("div");
        row.className = "item-row" + (isChecked ? " checked" : "");
        row.innerHTML = `
          <span class="item-checkbox">${isChecked ? "✓" : ""}</span>
          <span class="item-label">${item.name}</span>
          <span class="item-qty">${formatQty(item.qty)} ${item.unit}</span>`;
        row.addEventListener("click", () => {
          const nowChecked = !row.classList.contains("checked");
          row.classList.toggle("checked", nowChecked);
          row.querySelector(".item-checkbox").textContent = nowChecked ? "✓" : "";
          localStorage.setItem(key, nowChecked ? "1" : "0");
          updateProgress();
        });
        itemsWrap.appendChild(row);
      });

      block.appendChild(itemsWrap);
      container.appendChild(block);
    });

    updateProgress();
  }

  function updateProgress() {
    const rows = $$(".item-row");
    const total = rows.length;
    const checked = $$(".item-row.checked").length;
    const el = $("#shopping-progress");
    el.hidden = total === 0;
    el.textContent = checked === total && total > 0
      ? `🎉 tout est coché, direction les fourneaux !`
      : `${checked}/${total} cochés`;
  }

  // ============ SHEET CLOSE HANDLERS ============
  function initSheetClosers() {
    $("[data-close-sheet]").addEventListener("click", () => { $("#sheet-backdrop").hidden = true; });
    $("[data-close-recipe]").addEventListener("click", () => { $("#sheet-backdrop-recipe").hidden = true; });
    $("#sheet-backdrop").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });
    $("#sheet-backdrop-recipe").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });
  }

  // ============ INIT ============
  async function init() {
    meta = await api("/api/meta");
    initTabs();
    initPickerControls();
    initSheetClosers();
    await loadWeek();

    $("#btn-refresh-list").addEventListener("click", loadShoppingList);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }

  init().catch((err) => {
    console.error(err);
    showToast("Oups, un souci de connexion au serveur.");
  });
})();
