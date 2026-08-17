(() => {
  "use strict";

  const JS_DAY_TO_KEY = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
  const CORE_MEALS = ["petit-dej", "dejeuner", "diner"];

  const MEAL_ICON = {
    "petit-dej": { id: "s-tasse", vb: "0 0 120 90", color: "var(--creme)" },
    dejeuner: { id: "s-bol", vb: "0 0 120 80", color: "var(--bleu)" },
    diner: { id: "s-theiere", vb: "0 0 130 90", color: "var(--rouge)" },
    dessert: { id: "s-croissant", vb: "0 0 130 110", color: "var(--rouge)" },
  };

  const THEME_KEY = "menuStpTheme";
  const STREAK_KEY = "menuStpStreak";
  const TOKEN_KEY = "menuStpToken";
  const STREAK_THRESHOLD = 10; // sur 21 créneaux (3 repas x 7 jours), hors dessert bonus

  let meta = null;
  let weekData = null;
  let picker = { day: null, meal: null, recipeId: null, nbPersonnes: 2, portionBonus: false, cancelled: false };
  let currentRecipeSheetId = null;
  let lastShoppingData = null;
  let authToken = localStorage.getItem(TOKEN_KEY) || null;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function setToken(token) {
    authToken = token;
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  }

  async function api(path, options = {}) {
    const headers = Object.assign({}, options.headers, authToken ? { Authorization: "Bearer " + authToken } : {});
    const res = await fetch(path, Object.assign({}, options, { headers }));
    if (res.status === 401 && !path.startsWith("/api/auth/")) {
      setToken(null);
      showLock("login");
      throw new Error("Authentification requise.");
    }
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
    showToast._t = setTimeout(() => { toast.hidden = true; }, 2000);
  }

  function todayKey() {
    return JS_DAY_TO_KEY[new Date().getDay()];
  }

  function iconSvg(mealType) {
    const m = MEAL_ICON[mealType];
    return `<svg viewBox="${m.vb}" style="color:${m.color}"><use href="#${m.id}" fill="currentColor"/></svg>`;
  }

  function pill(text, extraClass) {
    const span = document.createElement("span");
    span.className = "pill mono" + (extraClass ? " " + extraClass : "");
    span.textContent = text;
    return span;
  }

  function formatQty(n) {
    return Number.isInteger(n) ? n : n.toFixed(2).replace(/\.?0+$/, "");
  }

  // ============ TABS ============
  function initTabs() {
    $$(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        $$(".tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        $$(".view").forEach((v) => (v.hidden = true));
        $("#" + tab.dataset.view).hidden = false;
        if (tab.dataset.view === "view-shopping") loadShoppingList();
      });
    });
  }

  // ============ WEEK + TODAY VIEWS ============
  const FR_DATE = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "2-digit", month: "long" });

  async function loadWeek() {
    weekData = await api("/api/week");
    renderToday();
    renderWeek();
    renderStreak();
  }

  function renderToday() {
    $("#today-date").textContent = FR_DATE.format(new Date()).replace(".", "");
    const key = todayKey();
    const dayObj = weekData.week.find((d) => d.day === key);
    const container = $("#today-list");
    container.innerHTML = "";
    if (!dayObj) return;

    dayObj.meals.forEach((meal) => {
      const selectedRecipe = meal.selected.recipeId ? meal.options.find((o) => o.id === meal.selected.recipeId) : null;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "meal-card-btn" + (meal.selected.cancelled ? " is-cancelled" : "");

      const top = document.createElement("div");
      top.className = "mc-top";
      const tag = document.createElement("span");
      tag.className = "mc-tag mono";
      tag.textContent = meal.label;
      top.appendChild(tag);
      const icon = document.createElement("span");
      icon.className = "mc-icon";
      icon.innerHTML = iconSvg(meal.mealType).replace(/color:var\(--\w+\)/, "color:var(--bg)");
      top.appendChild(icon);
      btn.appendChild(top);

      const name = document.createElement("div");
      if (meal.selected.cancelled) {
        name.className = "mc-name";
        name.textContent = selectedRecipe ? selectedRecipe.name : "Annulé";
      } else if (selectedRecipe) {
        name.className = "mc-name";
        name.textContent = selectedRecipe.name;
      } else {
        name.className = "mc-name empty";
        name.textContent = "à choisir →";
      }
      btn.appendChild(name);

      if (selectedRecipe && !meal.selected.cancelled) {
        const metaRow = document.createElement("div");
        metaRow.className = "mc-meta mono";
        metaRow.innerHTML = `<span>${selectedRecipe.prepMinutes} min</span><span>${meal.selected.nbPersonnes} pers.</span>` +
          (meal.selected.portionBonus ? "<span>+1 lendemain</span>" : "");
        btn.appendChild(metaRow);
      }

      btn.addEventListener("click", () => {
        if (selectedRecipe && !meal.selected.cancelled) {
          openRecipeSheet(selectedRecipe.id, meal.selected.nbPersonnes);
        } else {
          openPicker(dayObj, meal);
        }
      });
      container.appendChild(btn);
    });
  }

  function renderWeek() {
    const container = $("#week-list");
    container.innerHTML = "";
    const key = todayKey();

    weekData.week.forEach((dayObj) => {
      const group = document.createElement("div");
      group.className = "day-group" + (dayObj.day === key ? " is-today" : "");

      const heading = document.createElement("div");
      heading.className = "day-heading mono";
      heading.textContent = dayObj.label;
      group.appendChild(heading);

      dayObj.meals.forEach((meal) => group.appendChild(renderDayRow(dayObj, meal)));
      container.appendChild(group);
    });
  }

  function renderDayRow(dayObj, meal) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "day" + (meal.selected.cancelled ? " is-cancelled" : "");

    const d = document.createElement("span");
    d.className = "d";
    d.textContent = meal.label;
    row.appendChild(d);

    const selectedRecipe = meal.selected.recipeId ? meal.options.find((o) => o.id === meal.selected.recipeId) : null;
    const m = document.createElement("span");
    if (selectedRecipe) {
      m.className = "m";
      m.textContent = selectedRecipe.name;
    } else {
      m.className = "m empty";
      m.textContent = "à choisir";
    }
    row.appendChild(m);

    if (selectedRecipe && !meal.selected.cancelled) {
      const jump = document.createElement("span");
      jump.className = "recipe-jump";
      jump.textContent = "›";
      jump.setAttribute("role", "button");
      jump.setAttribute("aria-label", "Voir la recette");
      jump.addEventListener("click", (e) => {
        e.stopPropagation();
        openRecipeSheet(selectedRecipe.id, meal.selected.nbPersonnes);
      });
      row.appendChild(jump);
    }

    const icon = document.createElement("span");
    icon.className = "day-icon";
    icon.innerHTML = iconSvg(meal.mealType);
    row.appendChild(icon);

    row.addEventListener("click", () => openPicker(dayObj, meal));
    return row;
  }

  // ============ RÉGULARITÉ (streak, jamais négatif) ============
  function getISOWeekId(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dayNum + 3);
    const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
    const weekNum = 1 + Math.round((d - firstThursday) / (7 * 24 * 3600 * 1000));
    return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
  }

  function countPlannedCoreMeals() {
    let count = 0;
    weekData.week.forEach((dayObj) => {
      dayObj.meals.forEach((meal) => {
        if (CORE_MEALS.includes(meal.mealType) && meal.selected.recipeId && !meal.selected.cancelled) count++;
      });
    });
    return count;
  }

  function loadJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || "null") || fallback; } catch (e) { return fallback; }
  }

  function updateStreak() {
    const currentWeek = getISOWeekId(new Date());
    const state = loadJSON(STREAK_KEY, { lastSeenWeek: null, streak: 0 });

    if (!state.lastSeenWeek) {
      localStorage.setItem(STREAK_KEY, JSON.stringify({ lastSeenWeek: currentWeek, streak: 0 }));
      return 0;
    }
    if (state.lastSeenWeek === currentWeek) return state.streak;

    const metThreshold = countPlannedCoreMeals() >= STREAK_THRESHOLD;
    const newStreak = metThreshold ? state.streak + 1 : 0;
    localStorage.setItem(STREAK_KEY, JSON.stringify({ lastSeenWeek: currentWeek, streak: newStreak }));
    return newStreak;
  }

  function renderStreak() {
    const streak = updateStreak();
    const badge = $("#streak-badge");
    if (streak < 1) { badge.hidden = true; return; }
    badge.hidden = false;
    badge.textContent = streak === 1 ? "1 semaine de suite planifiée" : `${streak} semaines de suite planifiées`;
  }

  // ============ PICKER SHEET ============
  function openPicker(dayObj, meal) {
    picker = {
      day: dayObj.day,
      meal: meal.mealType,
      recipeId: meal.selected.recipeId,
      nbPersonnes: meal.selected.nbPersonnes || (meal.mealType === "dessert" ? 4 : 2),
      portionBonus: !!meal.selected.portionBonus,
      cancelled: !!meal.selected.cancelled,
    };

    $("#picker-day-meal").textContent = `${dayObj.label} · ${meal.label}`;
    $("#picker-title").textContent = meal.mealType === "dessert" ? "Choisis ton dessert" : "Choisis ton repas";
    $("#stepper-value").textContent = picker.nbPersonnes;

    $("#bonus-row").hidden = meal.mealType === "petit-dej" || meal.mealType === "dessert";
    $("#bonus-toggle").checked = picker.portionBonus;
    $("#cancel-toggle").checked = picker.cancelled;

    renderPickerOptions(meal.options);
    $("#picker-favorites").hidden = true;
    $("#picker-favorites").innerHTML = "";
    loadPickerFavorites();
    updateSeeRecipeButton();
    $("#btn-zero-effort").hidden = meal.mealType === "dessert";

    $("#sheet-backdrop").hidden = false;
  }

  async function loadPickerFavorites() {
    // On dérive les favoris depuis les options déjà chargées pour ce type de repas ;
    // si aucune n'est aimée on n'affiche rien (pas d'appel supplémentaire nécessaire).
    const dayObj = weekData.week.find((d) => d.day === picker.day);
    const meal = dayObj.meals.find((m) => m.mealType === picker.meal);
    const loved = (meal.options || []).filter((o) => o.favorite === "loved");
    renderPickerFavorites(loved);
  }

  function renderPickerFavorites(loved) {
    const wrap = $("#picker-favorites");
    if (!loved.length) { wrap.hidden = true; wrap.innerHTML = ""; return; }
    wrap.hidden = false;
    wrap.innerHTML = "";

    const label = document.createElement("p");
    label.className = "picker-fav-label";
    label.textContent = "Tes favoris";
    wrap.appendChild(label);

    const list = document.createElement("div");
    list.className = "picker-fav-list";
    loved.forEach((r) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "fav-chip" + (r.id === picker.recipeId ? " selected" : "");
      chip.textContent = r.name;
      chip.addEventListener("click", () => selectOption(r.id));
      list.appendChild(chip);
    });
    wrap.appendChild(list);
  }

  function renderPickerOptions(options) {
    const wrap = $("#picker-options");
    wrap.innerHTML = "";
    options.forEach((opt) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "option-card cut-a" + (opt.id === picker.recipeId ? " selected" : "");
      card.dataset.id = opt.id;

      if (opt.favorite === "loved") {
        const badge = document.createElement("span");
        badge.className = "fav-badge";
        badge.innerHTML = '<svg viewBox="0 0 90 120" style="color:var(--rouge)"><use href="#s-fleur" fill="currentColor"/></svg>';
        card.appendChild(badge);
      }

      const name = document.createElement("div");
      name.className = "opt-name";
      name.textContent = opt.name;
      card.appendChild(name);

      const metaRow = document.createElement("div");
      metaRow.className = "opt-meta";
      metaRow.appendChild(pill(`${opt.prepMinutes} min`));
      (opt.tags || []).forEach((tag) => metaRow.appendChild(pill(meta.tagLabels[tag] || tag)));
      card.appendChild(metaRow);

      if (opt.id === picker.recipeId) {
        const clearBtn = document.createElement("span");
        clearBtn.className = "opt-clear";
        clearBtn.textContent = "×";
        clearBtn.setAttribute("role", "button");
        clearBtn.setAttribute("aria-label", "Retirer ce choix");
        clearBtn.addEventListener("click", (e) => { e.stopPropagation(); clearChoice(); });
        card.appendChild(clearBtn);
      }

      card.addEventListener("click", () => selectOption(opt.id));
      wrap.appendChild(card);
    });
  }

  async function selectOption(recipeId) {
    picker.recipeId = recipeId;
    picker.cancelled = false;
    $("#cancel-toggle").checked = false;
    renderPickerOptions(findMealOptions());
    updateSeeRecipeButton();
    await savePlan();
  }

  function findMealOptions() {
    const dayObj = weekData.week.find((d) => d.day === picker.day);
    return dayObj.meals.find((m) => m.mealType === picker.meal).options;
  }

  function updateSeeRecipeButton() {
    $("#btn-see-recipe").hidden = !picker.recipeId;
  }

  async function clearChoice() {
    picker.recipeId = null;
    picker.portionBonus = false;
    $("#bonus-toggle").checked = false;
    renderPickerOptions(findMealOptions());
    updateSeeRecipeButton();
    await savePlan();
  }

  async function savePlan() {
    await api(`/api/plan/${picker.day}/${picker.meal}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipeId: picker.recipeId,
        nbPersonnes: picker.nbPersonnes,
        portionBonus: picker.portionBonus,
        cancelled: picker.cancelled,
      }),
    });
    await loadWeek();
    if (picker.cancelled) showToast("Repas annulé");
    else if (!picker.recipeId) showToast("Choix retiré");
    else showToast("Repas enregistré");
  }

  async function handleReroll() {
    const res = await api(`/api/options/${picker.day}/${picker.meal}/reroll`, { method: "POST" });
    const dayObj = weekData.week.find((d) => d.day === picker.day);
    dayObj.meals.find((m) => m.mealType === picker.meal).options = res.options;
    renderPickerOptions(res.options);
    showToast("Nouvelles options");
  }

  async function handleZeroEffort() {
    const res = await api(`/api/options/${picker.day}/${picker.meal}/zero-effort`, { method: "POST" });
    if (!res.options.length) {
      showToast("Pas d'option zéro effort pour ce repas");
      return;
    }
    const dayObj = weekData.week.find((d) => d.day === picker.day);
    dayObj.meals.find((m) => m.mealType === picker.meal).options = res.options;
    renderPickerOptions(res.options);
    showToast("Repas zéro effort");
  }

  function initPickerControls() {
    $("#stepper-minus").addEventListener("click", () => changePersonnes(-1));
    $("#stepper-plus").addEventListener("click", () => changePersonnes(1));
    $("#bonus-toggle").addEventListener("change", async (e) => {
      picker.portionBonus = e.target.checked;
      if (picker.recipeId) await savePlan();
    });
    $("#cancel-toggle").addEventListener("change", async (e) => {
      picker.cancelled = e.target.checked;
      await savePlan();
    });
    $("#btn-see-recipe").addEventListener("click", () => {
      if (picker.recipeId) openRecipeSheet(picker.recipeId, picker.nbPersonnes);
    });
    $("#btn-reroll").addEventListener("click", handleReroll);
    $("#btn-zero-effort").addEventListener("click", handleZeroEffort);
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
    currentRecipeSheetId = recipeId;

    $("#recipe-hero-icon").innerHTML = iconSvg(recipe.mealType).replace(/color:var\(--\w+\)/, "color:var(--bg)");
    $("#recipe-title").textContent = recipe.name;
    $("#recipe-meta").innerHTML = `<span>${recipe.prepMinutes} min</span><span>${nbPersonnes} pers.</span><span>${meta.mealLabels[recipe.mealType]}</span>`;
    updateFavButtons(recipe.favorite);

    const content = $("#recipe-content");
    content.innerHTML = "";

    if (recipe.mealType !== "petit-dej" && recipe.mealType !== "dessert") {
      const proteinPct = recipe.mealType === "diner" ? 35 : 25;
      const carbPct = recipe.mealType === "diner" ? 15 : 25;
      const bar = document.createElement("div");
      bar.className = "ratio-bar";
      bar.innerHTML = `<span style="width:50%;background:var(--legume)"></span><span style="width:${proteinPct}%;background:var(--rouge)"></span><span style="width:${carbPct}%;background:var(--glucide)"></span>`;
      content.appendChild(bar);
    }
    const legend = document.createElement("div");
    legend.className = "ratio-legend mono";
    legend.textContent = recipe.ratio;
    content.appendChild(legend);

    if (recipe.spices && recipe.spices.length) {
      const spiceWrap = document.createElement("div");
      spiceWrap.className = "spice-chips";
      recipe.spices.forEach((s) => spiceWrap.appendChild(pill(s)));
      content.appendChild(spiceWrap);
    }

    const ingTitle = document.createElement("div");
    ingTitle.className = "recipe-section-title";
    ingTitle.textContent = `Ingrédients — ${nbPersonnes} pers.`;
    content.appendChild(ingTitle);

    const macroLegend = document.createElement("div");
    macroLegend.className = "macro-legend mono";
    macroLegend.innerHTML = `<span><i class="lg-legume"></i>Légumes</span><span><i class="lg-proteine"></i>Protéines</span><span><i class="lg-glucide"></i>Glucides</span>`;
    content.appendChild(macroLegend);

    const ingList = document.createElement("ul");
    ingList.className = "ingredient-list";
    recipe.ingredients.forEach((ing) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="ing-dot" data-macro="${ing.macro}"></span><span class="ing-name">${ing.name}</span><span class="qty">${formatQty(ing.qty)} ${ing.unit}</span>`;
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

    if (recipe.mealType === "diner") {
      const tip = document.createElement("div");
      tip.className = "evening-tip";
      tip.innerHTML = "<strong>Encore faim ?</strong>Un bol de fromage blanc 0% (ou skyr) avec une poignée de baies — rassasiant, sans culpabiliser. Et une tisane sans sucre 1h après le dîner aide à calmer le grignotage du soir.";
      content.appendChild(tip);
    }

    $("#sheet-backdrop-recipe").hidden = false;
  }

  function updateFavButtons(status) {
    $("#btn-love").classList.toggle("active", status === "loved");
    $("#btn-ban").classList.toggle("active", status === "banned");
  }

  async function setFavorite(status) {
    if (!currentRecipeSheetId) return;
    const res = await api(`/api/recipes/${currentRecipeSheetId}/favorite`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    updateFavButtons(res.status);
    await loadWeek();
    showToast(res.status === "loved" ? "Ajouté aux favoris" : res.status === "banned" ? "Ne sera plus proposé" : "Retiré des favoris");
  }

  function initFavoriteControls() {
    $("#btn-love").addEventListener("click", () => setFavorite($("#btn-love").classList.contains("active") ? null : "loved"));
    $("#btn-ban").addEventListener("click", () => setFavorite($("#btn-ban").classList.contains("active") ? null : "banned"));
  }

  // ============ SHOPPING VIEW ============
  function checkKey(name, unit) {
    return `checked__${name}__${unit}`;
  }

  async function loadShoppingList() {
    const data = await api("/api/shopping-list");
    lastShoppingData = data;
    renderShoppingList(data);
  }

  function renderShoppingList(data) {
    const container = $("#shopping-list");
    container.innerHTML = "";

    if (data.isEmpty) {
      container.innerHTML = `<div class="empty-state"><p class="hand-note mono">pas encore de plan cette semaine — va choisir tes repas dans l'onglet "Jour" !</p></div>`;
      $("#shopping-progress").hidden = true;
      $("#btn-share-list").hidden = true;
      return;
    }
    $("#btn-share-list").hidden = false;

    data.rayons.forEach((rayonGroup) => {
      const block = document.createElement("div");
      block.className = "rayon-block";

      const header = document.createElement("div");
      header.className = "rayon-header";
      header.textContent = rayonGroup.rayon;
      block.appendChild(header);

      rayonGroup.items.forEach((item) => {
        const key = checkKey(item.name, item.unit);
        const isChecked = localStorage.getItem(key) === "1";
        const row = document.createElement("div");
        row.className = "item-row" + (isChecked ? " checked" : "");
        row.dataset.key = key;
        row.innerHTML = `<span class="item-checkbox"></span><span class="item-label">${item.name}</span><span class="item-qty">${formatQty(item.qty)} ${item.unit}</span>`;
        row.addEventListener("click", () => {
          const nowChecked = !row.classList.contains("checked");
          row.classList.toggle("checked", nowChecked);
          localStorage.setItem(key, nowChecked ? "1" : "0");
          updateProgress();
        });
        block.appendChild(row);
      });
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
    el.textContent = checked === total && total > 0 ? `tout est coché, direction les fourneaux !` : `${checked}/${total} cochés`;
  }

  function clearBoughtItems() {
    const checkedRows = $$(".item-row.checked");
    if (!checkedRows.length) { showToast("Rien à vider — coche d'abord ce que tu as acheté"); return; }
    checkedRows.forEach((row) => {
      localStorage.removeItem(row.dataset.key);
      row.remove();
    });
    $$(".rayon-block").forEach((block) => {
      if (!block.querySelector(".item-row")) block.remove();
    });
    updateProgress();
    showToast("Courses faites, liste nettoyée");
  }

  function buildShareText() {
    if (!lastShoppingData || lastShoppingData.isEmpty) return "";
    const lines = ["Liste de courses — The menu, please", ""];
    lastShoppingData.rayons.forEach((group) => {
      lines.push(`— ${group.rayon} —`);
      group.items.forEach((item) => {
        const checked = localStorage.getItem(checkKey(item.name, item.unit)) === "1";
        lines.push(`${checked ? "[x]" : "[ ]"} ${item.name} — ${formatQty(item.qty)} ${item.unit}`);
      });
      lines.push("");
    });
    return lines.join("\n").trim();
  }

  async function shareShoppingList() {
    const text = buildShareText();
    if (!text) return;

    if (navigator.share) {
      try { await navigator.share({ title: "Liste de courses", text }); return; }
      catch (e) { if (e.name === "AbortError") return; }
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        showToast("Liste copiée dans le presse-papier");
        return;
      } catch (e) { /* repli ci-dessous */ }
    }

    showShareFallback(text);
  }

  function showShareFallback(text) {
    const ta = $("#share-textarea");
    ta.value = text;
    $("#sheet-backdrop-share").hidden = false;
    requestAnimationFrame(() => {
      ta.focus();
      ta.select();
      try {
        if (document.execCommand("copy")) showToast("Copié dans le presse-papier");
      } catch (e) { /* l'utilisateur copiera à la main, le texte est sélectionné */ }
    });
  }

  // ============ RÉGLAGES ============
  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
  }

  async function openSettings() {
    const [reminder, tisane, planning] = await Promise.all([
      api("/api/settings/reminder"),
      api("/api/settings/tisane"),
      api("/api/settings/planning"),
    ]);
    $("#reminder-enabled").checked = reminder.enabled;
    $("#reminder-time").value = reminder.time;
    $("#reminder-meal").value = reminder.mealType;
    $("#tisane-enabled").checked = tisane.enabled;
    $("#tisane-time").value = tisane.time;
    $("#planning-enabled").checked = planning.enabled;
    $("#planning-time").value = planning.time;
    $("#sheet-backdrop-settings").hidden = false;
  }

  async function ensurePushSubscription() {
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      throw new Error("Les notifications ne sont pas supportées sur ce navigateur.");
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      throw new Error("Autorisation refusée — impossible d'activer les rappels.");
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { publicKey } = await api("/api/push/vapid-public-key");
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    await api("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub),
    });
  }

  async function saveReminder() {
    const enabled = $("#reminder-enabled").checked;
    const time = $("#reminder-time").value || "17:00";
    const mealType = $("#reminder-meal").value;

    if (enabled) {
      try { await ensurePushSubscription(); }
      catch (e) { showToast(e.message); return; }
    }

    await api("/api/settings/reminder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, time, mealType }),
    });
    showToast(enabled ? "Rappel activé" : "Rappel désactivé");
  }

  async function saveTisane() {
    const enabled = $("#tisane-enabled").checked;
    const time = $("#tisane-time").value || "20:30";

    if (enabled) {
      try { await ensurePushSubscription(); }
      catch (e) { showToast(e.message); return; }
    }

    await api("/api/settings/tisane", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, time }),
    });
    showToast(enabled ? "Rituel tisane activé" : "Rituel tisane désactivé");
  }

  async function savePlanning() {
    const enabled = $("#planning-enabled").checked;
    const time = $("#planning-time").value || "19:00";

    if (enabled) {
      try { await ensurePushSubscription(); }
      catch (e) { showToast(e.message); return; }
    }

    await api("/api/settings/planning", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, time }),
    });
    showToast(enabled ? "Rappel dimanche activé" : "Rappel dimanche désactivé");
  }

  async function savePin() {
    const currentPin = $("#pin-current").value.trim();
    const newPin = $("#pin-new").value.trim();
    const confirmPin = $("#pin-new-confirm").value.trim();
    const errEl = $("#pin-change-error");
    errEl.hidden = true;

    if (!/^\d{6}$/.test(newPin)) { errEl.textContent = "Le nouveau code doit contenir 6 chiffres."; errEl.hidden = false; return; }
    if (newPin !== confirmPin) { errEl.textContent = "Les deux nouveaux codes ne correspondent pas."; errEl.hidden = false; return; }

    try {
      const { token } = await api("/api/auth/change-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPin, newPin }),
      });
      setToken(token);
      $("#pin-current").value = "";
      $("#pin-new").value = "";
      $("#pin-new-confirm").value = "";
      showToast("Code changé — les autres appareils devront le ressaisir");
    } catch (e) {
      errEl.textContent = e.message;
      errEl.hidden = false;
    }
  }

  async function logoutDevice() {
    try { await api("/api/auth/logout", { method: "POST" }); } catch (e) { /* on verrouille quand même */ }
    setToken(null);
    $("#sheet-backdrop-settings").hidden = true;
    showLock("login");
  }

  function initSettings() {
    $("#btn-settings").addEventListener("click", openSettings);
    $("#btn-save-reminder").addEventListener("click", saveReminder);
    $("#btn-save-tisane").addEventListener("click", saveTisane);
    $("#btn-save-planning").addEventListener("click", savePlanning);
    $("#btn-save-pin").addEventListener("click", savePin);
    $("#btn-logout").addEventListener("click", logoutDevice);
  }

  // ============ THÈME ============
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
    $("#btn-theme-dark").classList.toggle("active", theme === "dark");
    $("#btn-theme-light").classList.toggle("active", theme === "light");
  }

  function initTheme() {
    applyTheme(localStorage.getItem(THEME_KEY) || "dark");
    $("#btn-theme-dark").addEventListener("click", () => applyTheme("dark"));
    $("#btn-theme-light").addEventListener("click", () => applyTheme("light"));
  }

  // ============ SHEET CLOSE HANDLERS ============
  function initSheetClosers() {
    $("[data-close-sheet]").addEventListener("click", () => { $("#sheet-backdrop").hidden = true; });
    $("[data-close-recipe]").addEventListener("click", () => { $("#sheet-backdrop-recipe").hidden = true; });
    $("[data-close-settings]").addEventListener("click", () => { $("#sheet-backdrop-settings").hidden = true; });
    $("[data-close-share]").addEventListener("click", () => { $("#sheet-backdrop-share").hidden = true; });
    [$("#sheet-backdrop"), $("#sheet-backdrop-recipe"), $("#sheet-backdrop-settings"), $("#sheet-backdrop-share")].forEach((backdrop) => {
      backdrop.addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });
    });
  }

  // ============ VERROU PIN (code famille) ============
  let lockMode = "login";

  function showLock(mode) {
    lockMode = mode;
    $("#lock-screen").hidden = false;
    $("#lock-pin").value = "";
    $("#lock-pin-confirm").value = "";
    $("#lock-error").hidden = true;
    if (mode === "setup") {
      $("#lock-eyebrow").textContent = "Bienvenue";
      $("#lock-title").textContent = "Crée le code de la famille";
      $("#lock-sub").textContent = "6 chiffres, à partager avec les autres appareils du foyer";
      $("#lock-confirm-label").hidden = false;
      $("#lock-pin-confirm").hidden = false;
      $("#lock-submit").textContent = "Créer le code";
    } else {
      $("#lock-eyebrow").textContent = "Verrouillé";
      $("#lock-title").textContent = "Entre le code";
      $("#lock-sub").textContent = "code à 6 chiffres partagé en famille";
      $("#lock-confirm-label").hidden = true;
      $("#lock-pin-confirm").hidden = true;
      $("#lock-submit").textContent = "Déverrouiller";
    }
    requestAnimationFrame(() => $("#lock-pin").focus());
  }

  function hideLock() {
    // Le focus programmatique du champ PIN ouvre le clavier virtuel ; sur iOS, ça
    // fait défiler le document sous-jacent même à travers un overlay position:fixed,
    // et ce décalage persiste après la fermeture du clavier. On force le blur (pour
    // lancer la fermeture du clavier tout de suite) puis on recale le scroll, une
    // fois immédiatement et une fois après l'animation de fermeture du clavier.
    $("#lock-pin").blur();
    $("#lock-pin-confirm").blur();
    $("#lock-screen").hidden = true;
    window.scrollTo(0, 0);
    setTimeout(() => window.scrollTo(0, 0), 350);
  }

  function showLockError(msg) {
    const el = $("#lock-error");
    el.textContent = msg;
    el.hidden = false;
  }

  async function submitLock() {
    const pin = $("#lock-pin").value.trim();
    if (!/^\d{6}$/.test(pin)) { showLockError("Le code doit contenir 6 chiffres."); return; }

    if (lockMode === "setup") {
      const confirmPin = $("#lock-pin-confirm").value.trim();
      if (pin !== confirmPin) { showLockError("Les deux codes ne correspondent pas."); return; }
      try {
        const { token } = await api("/api/auth/setup", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }),
        });
        setToken(token);
        hideLock();
        await bootApp();
      } catch (e) { showLockError(e.message); }
    } else {
      try {
        const { token } = await api("/api/auth/login", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }),
        });
        setToken(token);
        hideLock();
        await bootApp();
      } catch (e) { showLockError(e.message); }
    }
  }

  function initLockScreen() {
    $("#lock-submit").addEventListener("click", submitLock);
    [$("#lock-pin"), $("#lock-pin-confirm")].forEach((input) => {
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") submitLock(); });
    });
  }

  // ============ INIT ============
  async function bootApp() {
    initTabs();
    initPickerControls();
    initFavoriteControls();
    initSettings();
    initSheetClosers();
    meta = await api("/api/meta");
    await loadWeek();

    $("#btn-refresh-list").addEventListener("click", loadShoppingList);
    $("#btn-share-list").addEventListener("click", shareShoppingList);
    $("#btn-bought").addEventListener("click", clearBoughtItems);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }

  function initStickyHeader() {
    const topbar = $(".topbar");
    const onScroll = () => topbar.classList.toggle("is-scrolled", window.scrollY > 4);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  async function init() {
    // iOS/Safari restaure parfois la position de scroll d'une session précédente
    // au (re)lancement de la PWA, ce qui coupe le haut de l'écran "Aujourd'hui".
    window.scrollTo(0, 0);
    window.addEventListener("pageshow", (e) => { if (e.persisted) window.scrollTo(0, 0); });

    initTheme();
    initLockScreen();
    initStickyHeader();

    if (authToken) {
      try { await bootApp(); } catch (e) { /* api() a déjà affiché le verrou en cas de 401 */ }
    } else {
      const status = await api("/api/auth/status").catch(() => ({ hasPin: true }));
      showLock(status.hasPin ? "login" : "setup");
    }
  }

  init().catch((err) => {
    console.error(err);
    showToast("Oups, un souci de connexion au serveur.");
  });
})();
