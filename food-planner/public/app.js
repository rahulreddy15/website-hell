const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SLOTS = ["Breakfast", "Lunch", "Dinner"];
const MEAL_TYPES = ["Breakfast", "Lunch", "Dinner", "Snack"];
const EFFORTS = ["Quick", "Medium", "Project"];
const PREP_OPTIONS = ["None", "Soak overnight", "Marinate", "Defrost morning of", "Other"];
const VERDICTS = {
  love: "👍",
  no: "👎",
  again: "🔁",
};

const state = {
  view: "plan",
  meals: [],
  week: null,
  shoppingItems: [],
  archive: { weeks: [], stats: [] },
  categories: ["Produce", "Dairy", "Grains & Pulses", "Proteins", "Pantry", "Other"],
  filters: { q: "", type: "", effort: "", tag: "" },
  archiveFilter: "all",
  flowStep: 0,
  flowVerdicts: [],
  pendingImport: null,
};

const app = document.querySelector("#app");
const modal = document.querySelector("#modal");
const toast = document.querySelector("#toast");
const apiBase = new URL("api/", window.location.href).pathname;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function attr(value) {
  return escapeHtml(value);
}

function fmtDate(dateString, options = { month: "short", day: "numeric" }) {
  const date = new Date(`${dateString}T00:00:00`);
  return date.toLocaleDateString(undefined, options);
}

function addDays(dateString, count) {
  const date = new Date(`${dateString}T00:00:00`);
  date.setDate(date.getDate() + count);
  return date.toISOString().slice(0, 10);
}

function normalize(text) {
  return String(text || "").trim().toLowerCase();
}

function mealById(id) {
  return state.meals.find((meal) => meal.id === id);
}

function cellKey(dayIndex, slot) {
  return `${dayIndex}|${slot}`;
}

function cellsByKey() {
  const map = new Map();
  for (const cell of state.week?.cells || []) {
    map.set(cellKey(cell.day_index, cell.slot), cell);
  }
  return map;
}

async function api(path, options = {}) {
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const apiPath = normalizedPath.startsWith("api/") ? normalizedPath.slice(4) : normalizedPath;
  const response = await fetch(`${apiBase}${apiPath}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Something went wrong");
  }
  return data;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2400);
}

function setView(view) {
  state.view = view;
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.view === view);
  });
  render();
}

function updateFromBootstrap(data) {
  state.meals = data.meals || [];
  state.week = data.week;
  state.shoppingItems = data.shoppingItems || [];
  state.archive = data.archive || { weeks: [], stats: [] };
  state.categories = data.categories || state.categories;
}

async function load() {
  try {
    const data = await api("/api/bootstrap");
    updateFromBootstrap(data);
    render();
  } catch (error) {
    app.innerHTML = `<section class="empty-state">${escapeHtml(error.message)}</section>`;
  }
}

function render() {
  if (!state.week) return;
  const views = {
    plan: renderPlan,
    shopping: renderShopping,
    library: renderLibrary,
    archive: renderArchive,
    flow: renderFlow,
  };
  app.innerHTML = views[state.view]();
  bindCurrentView();
}

function renderPlan() {
  const filled = state.week.cells.length;
  const prepCount = state.week.cells.filter(cellNeedsPrep).length;
  const projectCount = state.week.cells.filter((cell) => cellEffort(cell) === "Project").length;

  return `
    <section class="view two-column">
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">
            <p class="eyebrow">Current week</p>
            <h2>Plan at a glance</h2>
            <div class="week-range">${fmtDate(state.week.start_date, { weekday: "short", month: "short", day: "numeric" })} - ${fmtDate(state.week.end_date, { weekday: "short", month: "short", day: "numeric" })}</div>
          </div>
          <div class="button-row">
            <button class="button" data-action="generate-shopping">Generate shopping list</button>
            <button class="button primary" data-view-target="flow">Plan this week</button>
          </div>
        </div>
        <div class="plan-toolbar">
          <label class="field">
            <span>Pantry notes / use up this week</span>
            <textarea class="textarea" data-action="pantry" placeholder="Example: spinach, cucumbers, feta, cooked quinoa">${escapeHtml(state.week.pantry_notes)}</textarea>
          </label>
          <div class="summary-stack">
            <div class="summary-card"><span class="hint">Filled cells</span><strong>${filled}/21</strong></div>
            <div class="summary-card"><span class="hint">Needs prep</span><strong>${prepCount}</strong></div>
            <div class="summary-card"><span class="hint">Project meals</span><strong>${projectCount}</strong></div>
          </div>
        </div>
      </div>
      <div class="panel compact">
        <div class="panel-title">
          <p class="eyebrow">Calm defaults</p>
          <h2>Weekly cues</h2>
        </div>
        <div class="summary-stack">
          <div class="summary-card"><span class="hint">Quick meals are green, medium meals are amber, project meals are clay.</span></div>
          <div class="summary-card"><span class="hint">Cells with prep show a small dot. Hover or tap to see ingredients.</span></div>
          <div class="summary-card"><span class="hint">Split meals are for nights when each person wants something different.</span></div>
        </div>
      </div>
    </section>
    <section class="panel planner-panel">
      ${renderPlannerGrid()}
      ${renderMobilePlanner()}
    </section>
  `;
}

function renderPlannerGrid() {
  const map = cellsByKey();
  const dayHeads = DAYS.map((day, index) => `
    <div class="day-head">
      <div class="day-name">${day}</div>
      <div class="day-date">${fmtDate(addDays(state.week.start_date, index))}</div>
    </div>
  `).join("");
  const rows = SLOTS.map((slot) => `
    <div class="slot-head">${slot}</div>
    ${DAYS.map((_, dayIndex) => renderPlannerCell(map.get(cellKey(dayIndex, slot)), dayIndex, slot)).join("")}
  `).join("");
  return `
    <div class="planner-wrap">
      <div class="planner-grid">
        <div></div>
        ${dayHeads}
        ${rows}
      </div>
    </div>
  `;
}

function renderMobilePlanner() {
  const map = cellsByKey();
  return `
    <div class="mobile-planner">
      ${DAYS.map((day, dayIndex) => `
        <div class="mobile-day-card">
          <div class="mobile-day-title"><span>${day}</span><span>${fmtDate(addDays(state.week.start_date, dayIndex))}</span></div>
          ${SLOTS.map((slot) => `
            <div class="mobile-slot-label">${slot}</div>
            ${renderPlannerCell(map.get(cellKey(dayIndex, slot)), dayIndex, slot)}
          `).join("")}
        </div>
      `).join("")}
    </div>
  `;
}

function renderPlannerCell(cell, dayIndex, slot) {
  if (!cell) {
    return `
      <div class="planner-cell empty" role="button" tabindex="0" data-action="edit-cell" data-day="${dayIndex}" data-slot="${slot}">
        <span class="cell-title">+ Add meal</span>
      </div>
    `;
  }
  const title = cellTitle(cell);
  const effort = cellEffort(cell);
  const prep = cellPrep(cell);
  const detail = cellDetails(cell);
  return `
    <div class="planner-cell ${effort.toLowerCase()}" role="button" tabindex="0" data-action="edit-cell" data-day="${dayIndex}" data-slot="${slot}">
      <span class="cell-title">${escapeHtml(title)}</span>
      <span class="cell-subline">
        <span class="badge ${effort.toLowerCase()}">${effort}</span>
        ${prep && prep !== "None" ? `<span class="prep-dot" title="${attr(prep)}">!</span>` : ""}
      </span>
      <div class="cell-popover">
        <h4>${escapeHtml(title)}</h4>
        ${detail.map((item) => `<p><strong>${escapeHtml(item.label)}:</strong> ${escapeHtml(item.value)}</p>`).join("")}
      </div>
    </div>
  `;
}

function cellTitle(cell) {
  if (!cell) return "";
  if (cell.mode === "split") return `${cell.split_a_label || mealById(cell.split_a_meal_id)?.name || "Person A"} / ${cell.split_b_label || mealById(cell.split_b_meal_id)?.name || "Person B"}`;
  return cell.meal_label || mealById(cell.meal_id)?.name || "Meal";
}

function cellMeals(cell) {
  if (!cell) return [];
  if (cell.mode === "meal") return [mealById(cell.meal_id)].filter(Boolean);
  return [mealById(cell.split_a_meal_id), mealById(cell.split_b_meal_id)].filter(Boolean);
}

function cellEffort(cell) {
  const meals = cellMeals(cell);
  if (meals.some((meal) => meal.effort === "Project")) return "Project";
  if (meals.some((meal) => meal.effort === "Medium")) return "Medium";
  return meals[0]?.effort || "Quick";
}

function cellPrep(cell) {
  return cellMeals(cell).map((meal) => meal.prep_needed).find((prep) => prep && prep !== "None") || "None";
}

function cellNeedsPrep(cell) {
  return cellPrep(cell) !== "None";
}

function cellDetails(cell) {
  const meals = cellMeals(cell);
  if (!meals.length) {
    return [{ label: "Details", value: "Custom split label only. Add the meals to the library for ingredient details." }];
  }
  return meals.flatMap((meal) => [
    { label: `${meal.name} prep`, value: meal.prep_needed || "None" },
    { label: "Ingredients", value: meal.ingredients.join(", ") },
  ]);
}

function renderLibrary() {
  const meals = filteredMeals();
  const tags = [...new Set(state.meals.flatMap((meal) => meal.tags || []))].sort((a, b) => a.localeCompare(b));
  return `
    <section class="panel">
      <div class="panel-header">
        <div class="panel-title">
          <p class="eyebrow">Validated meals</p>
          <h2>Meal Library</h2>
          <p>${state.meals.length} meals ready for quick planning.</p>
        </div>
        <div class="button-row">
          <button class="button" data-action="export-json">Export JSON</button>
          <button class="button" data-action="import-json">Import JSON</button>
          <input class="file-input" type="file" accept="application/json" data-role="import-file">
          <button class="button primary" data-action="new-meal">Add meal</button>
        </div>
      </div>
      <div class="filters">
        <input class="input" data-filter="q" placeholder="Search meals, ingredients, notes" value="${attr(state.filters.q)}">
        <select class="select" data-filter="type">
          <option value="">All meal types</option>
          ${MEAL_TYPES.map((type) => `<option ${state.filters.type === type ? "selected" : ""}>${type}</option>`).join("")}
        </select>
        <select class="select" data-filter="effort">
          <option value="">All effort levels</option>
          ${EFFORTS.map((effort) => `<option ${state.filters.effort === effort ? "selected" : ""}>${effort}</option>`).join("")}
        </select>
        <select class="select" data-filter="tag">
          <option value="">All tags</option>
          ${tags.map((tag) => `<option value="${attr(tag)}" ${state.filters.tag === tag ? "selected" : ""}>${escapeHtml(tag)}</option>`).join("")}
        </select>
      </div>
      <div class="meal-list">
        ${meals.length ? meals.map(renderMealCard).join("") : `
          <div class="empty-state">
            <div>
              <h3>No meals found</h3>
              <p>Clear filters or add the first meal you already know you both like.</p>
            </div>
          </div>
        `}
      </div>
    </section>
  `;
}

function filteredMeals() {
  const q = normalize(state.filters.q);
  return state.meals.filter((meal) => {
    const haystack = normalize([meal.name, meal.notes, meal.ingredients.join(" "), meal.tags.join(" ")].join(" "));
    return (!q || haystack.includes(q))
      && (!state.filters.type || meal.meal_types.includes(state.filters.type))
      && (!state.filters.effort || meal.effort === state.filters.effort)
      && (!state.filters.tag || meal.tags.includes(state.filters.tag));
  });
}

function renderMealCard(meal) {
  return `
    <article class="meal-card">
      <div class="meal-card-head">
        <div>
          <h3>${escapeHtml(meal.name)}</h3>
          <div class="meta-row">
            <span class="badge ${meal.effort.toLowerCase()}">${meal.effort}</span>
            <span class="badge">Prep: ${escapeHtml(meal.prep_needed)}</span>
            ${meal.meal_types.map((type) => `<span class="chip">${type}</span>`).join("")}
          </div>
        </div>
        <div class="button-row">
          <button class="button subtle" data-action="edit-meal" data-id="${meal.id}">Edit</button>
          <button class="button danger" data-action="delete-meal" data-id="${meal.id}">Delete</button>
        </div>
      </div>
      <p class="ingredients-preview"><strong>Ingredients:</strong> ${escapeHtml(meal.ingredients.join(", "))}</p>
      ${meal.notes ? `<p class="ingredients-preview"><strong>Notes:</strong> ${escapeHtml(meal.notes)}</p>` : ""}
      ${meal.tags.length ? `<div class="tag-row">${meal.tags.map((tag) => `<span class="badge">#${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
    </article>
  `;
}

function renderShopping() {
  const grouped = groupShoppingItems();
  const checked = state.shoppingItems.filter((item) => item.checked).length;
  return `
    <section class="view shopping-view">
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">
            <p class="eyebrow">Supermarket mode</p>
            <h2>Shopping List</h2>
            <p>${checked}/${state.shoppingItems.length} checked off.</p>
          </div>
          <div class="button-row">
            <button class="button" data-action="generate-shopping">Regenerate</button>
            <button class="button danger" data-action="reset-shopping">Reset list</button>
          </div>
        </div>
        <div class="shopping-list">
          ${state.shoppingItems.length ? state.categories.map((category) => renderShoppingCategory(category, grouped[category] || [])).join("") : `
            <div class="empty-state">
              <div>
                <h3>No shopping items yet</h3>
                <p>Fill the weekly grid, then generate the list.</p>
              </div>
            </div>
          `}
        </div>
      </div>
      <aside class="panel compact">
        <div class="panel-title">
          <p class="eyebrow">Add one-off item</p>
          <h2>Custom item</h2>
        </div>
        <form class="form-grid" data-form="custom-shopping">
          <label class="field">
            <span>Item</span>
            <input class="input" name="name" placeholder="Coffee, dish soap, lemons">
          </label>
          <label class="field">
            <span>Category</span>
            <select class="select" name="category">
              ${state.categories.map((category) => `<option>${category}</option>`).join("")}
            </select>
          </label>
          <button class="button primary" type="submit">Add to list</button>
        </form>
      </aside>
    </section>
  `;
}

function groupShoppingItems() {
  return state.shoppingItems.reduce((groups, item) => {
    groups[item.category] ||= [];
    groups[item.category].push(item);
    return groups;
  }, {});
}

function renderShoppingCategory(category, items) {
  if (!items.length) return "";
  return `
    <section class="category-card">
      <div class="category-head"><span>${escapeHtml(category)}</span><span>${items.length}</span></div>
      ${items.map((item) => `
        <div class="shopping-item ${item.checked ? "checked" : ""}">
          <input type="checkbox" data-action="toggle-shopping" data-id="${item.id}" ${item.checked ? "checked" : ""}>
          <div>
            <div class="item-name">${escapeHtml(item.name)}</div>
            <div class="item-meta">${item.source === "generated" ? "From weekly plan" : "Custom"}</div>
          </div>
          <div class="button-row">
            <button class="icon-button" data-action="edit-shopping" data-id="${item.id}" title="Edit">Edit</button>
            <button class="icon-button" data-action="delete-shopping" data-id="${item.id}" title="Remove">×</button>
          </div>
        </div>
      `).join("")}
    </section>
  `;
}

function renderArchive() {
  const weeks = filteredArchiveWeeks();
  const stats = filteredArchiveStats();
  return `
    <section class="view archive-layout">
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">
            <p class="eyebrow">Past weeks</p>
            <h2>Archive</h2>
            <p>Review what was loved, repeated, or should leave the library.</p>
          </div>
          <select class="select" data-action="archive-filter">
            <option value="all" ${state.archiveFilter === "all" ? "selected" : ""}>All verdicts</option>
            <option value="love" ${state.archiveFilter === "love" ? "selected" : ""}>Loved</option>
            <option value="again" ${state.archiveFilter === "again" ? "selected" : ""}>Want again soon</option>
            <option value="no" ${state.archiveFilter === "no" ? "selected" : ""}>Didn't love</option>
          </select>
        </div>
        <div class="archive-weeks">
          ${weeks.length ? weeks.map(renderWeekArchive).join("") : `<div class="empty-state">Archive a week from Sunday Flow to start seeing history.</div>`}
        </div>
      </div>
      <aside class="panel compact">
        <div class="panel-title">
          <p class="eyebrow">Most eaten</p>
          <h2>Meal stats</h2>
        </div>
        <div class="stats-list">
          ${stats.length ? stats.slice(0, 18).map(renderStatRow).join("") : `<div class="empty-state">No meal stats yet.</div>`}
        </div>
      </aside>
    </section>
  `;
}

function filteredArchiveWeeks() {
  if (state.archiveFilter === "all") return state.archive.weeks || [];
  return (state.archive.weeks || [])
    .map((week) => ({ ...week, entries: week.entries.filter((entry) => entry.verdict === state.archiveFilter) }))
    .filter((week) => week.entries.length);
}

function filteredArchiveStats() {
  if (state.archiveFilter === "all") return state.archive.stats || [];
  return (state.archive.stats || []).filter((stat) => Number(stat[state.archiveFilter] || 0) > 0);
}

function renderWeekArchive(week) {
  return `
    <article class="week-card">
      <h3>${fmtDate(week.start_date)} - ${fmtDate(week.end_date)}</h3>
      ${week.pantry_notes ? `<p class="ingredients-preview"><strong>Pantry:</strong> ${escapeHtml(week.pantry_notes)}</p>` : ""}
      <div class="verdict-list">
        ${week.entries.map((entry) => `
          <div class="verdict-row">
            <span class="verdict-mark">${VERDICTS[entry.verdict]}</span>
            <span>${escapeHtml(entry.label)}</span>
            <span>${DAYS[entry.day_index]} ${entry.slot}</span>
          </div>
        `).join("")}
      </div>
    </article>
  `;
}

function renderStatRow(stat) {
  return `
    <article class="stat-row">
      <h3>${escapeHtml(stat.label)}</h3>
      <div class="meta-row">
        <span class="badge">${stat.total}x eaten</span>
        <span class="badge">👍 ${stat.love || 0}</span>
        <span class="badge">🔁 ${stat.again || 0}</span>
        <span class="badge">👎 ${stat.no || 0}</span>
      </div>
      <p class="ingredients-preview">Last eaten ${fmtDate(stat.last_eaten)}</p>
    </article>
  `;
}

function renderFlow() {
  const steps = ["Pantry", "Archive", "Fill Grid", "Shopping"];
  return `
    <section class="flow-layout">
      <div class="flow-progress">
        ${steps.map((step, index) => `<div class="flow-step ${state.flowStep === index ? "active" : ""}">${index + 1}. ${step}</div>`).join("")}
      </div>
      <div class="step-card">
        ${renderFlowStep()}
        <div class="flow-actions">
          <button class="button" data-action="flow-prev" ${state.flowStep === 0 ? "disabled" : ""}>Back</button>
          <button class="button primary" data-action="flow-next">${state.flowStep === 3 ? "Finish" : "Continue"}</button>
        </div>
      </div>
    </section>
  `;
}

function renderFlowStep() {
  if (state.flowStep === 0) {
    return `
      <p class="eyebrow">Step 1</p>
      <h2>What should we use up?</h2>
      <p class="hint">Start with the fridge, freezer, and pantry. This keeps the plan grounded and reduces impulse buying.</p>
      <label class="field" style="margin-top:14px">
        <span>Pantry notes</span>
        <textarea class="textarea" data-action="pantry" placeholder="Cooked lentils, basil, yogurt, frozen salmon">${escapeHtml(state.week.pantry_notes)}</textarea>
      </label>
    `;
  }
  if (state.flowStep === 1) {
    const occurrences = currentOccurrences();
    if (!state.flowVerdicts.length) {
      state.flowVerdicts = occurrences.map((item) => ({ ...item, verdict: "again" }));
    }
    return `
      <p class="eyebrow">Step 2</p>
      <h2>Archive last week</h2>
      <p class="hint">Default is 🔁 because planned meals are usually validated. Change the outliers before continuing.</p>
      <div class="verdict-editor" style="margin-top:14px">
        ${state.flowVerdicts.length ? state.flowVerdicts.map((item, index) => renderVerdictEditorRow(item, index)).join("") : `<div class="empty-state">No meals in the current grid yet. Continue and fill the week.</div>`}
      </div>
    `;
  }
  if (state.flowStep === 2) {
    return `
      <p class="eyebrow">Step 3</p>
      <h2>Fill this week's grid</h2>
      <p class="hint">Click any cell to choose a library meal or split meal. Keep project meals intentional and add quick fallbacks.</p>
      <div style="margin-top:14px">${renderPlannerGrid()}${renderMobilePlanner()}</div>
    `;
  }
  return `
    <p class="eyebrow">Step 4</p>
    <h2>Generate shopping list</h2>
    <p class="hint">Create a deduplicated list from the plan, then switch to supermarket mode on your phone.</p>
    <div class="summary-stack" style="margin-top:14px">
      <div class="summary-card"><span class="hint">Planned cells</span><strong>${state.week.cells.length}/21</strong></div>
      <div class="summary-card"><span class="hint">Shopping items now</span><strong>${state.shoppingItems.length}</strong></div>
    </div>
    <div class="button-row" style="margin-top:14px">
      <button class="button primary" data-action="generate-shopping">Generate list now</button>
      <button class="button" data-view-target="shopping">Open shopping view</button>
    </div>
  `;
}

function currentOccurrences() {
  return (state.week.cells || []).flatMap((cell) => {
    if (cell.mode === "meal") {
      const label = cell.meal_label || mealById(cell.meal_id)?.name;
      return label ? [{ meal_id: cell.meal_id, label, day_index: cell.day_index, slot: cell.slot, side: "" }] : [];
    }
    if (cell.mode === "split") {
      return [
        { meal_id: cell.split_a_meal_id, label: cell.split_a_label || mealById(cell.split_a_meal_id)?.name, day_index: cell.day_index, slot: cell.slot, side: "A" },
        { meal_id: cell.split_b_meal_id, label: cell.split_b_label || mealById(cell.split_b_meal_id)?.name, day_index: cell.day_index, slot: cell.slot, side: "B" },
      ].filter((item) => item.label);
    }
    return [];
  });
}

function renderVerdictEditorRow(item, index) {
  return `
    <div class="verdict-editor-row">
      <div>
        <strong>${escapeHtml(item.label)}</strong>
        <div class="hint">${DAYS[item.day_index]} ${item.slot}${item.side ? `, split ${item.side}` : ""}</div>
      </div>
      <div class="segmented" data-verdict-index="${index}">
        ${Object.entries(VERDICTS).map(([key, icon]) => `<button class="${item.verdict === key ? "active" : ""}" data-action="set-verdict" data-value="${key}" title="${key}">${icon}</button>`).join("")}
      </div>
    </div>
  `;
}

function bindCurrentView() {
  app.querySelectorAll("[data-view-target]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.viewTarget));
  });
  app.querySelectorAll("[data-action]").forEach((el) => {
    const action = el.dataset.action;
    if (action === "new-meal") el.addEventListener("click", () => openMealModal());
    if (action === "edit-meal") el.addEventListener("click", () => openMealModal(mealById(el.dataset.id)));
    if (action === "delete-meal") el.addEventListener("click", () => deleteMeal(el.dataset.id));
    if (action === "edit-cell") {
      el.addEventListener("click", () => openCellModal(Number(el.dataset.day), el.dataset.slot));
      el.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openCellModal(Number(el.dataset.day), el.dataset.slot);
        }
      });
    }
    if (action === "pantry") el.addEventListener("change", (event) => savePantry(event.target.value));
    if (action === "generate-shopping") el.addEventListener("click", generateShopping);
    if (action === "reset-shopping") el.addEventListener("click", resetShopping);
    if (action === "toggle-shopping") el.addEventListener("change", () => toggleShopping(el.dataset.id, el.checked));
    if (action === "edit-shopping") el.addEventListener("click", () => openShoppingModal(el.dataset.id));
    if (action === "delete-shopping") el.addEventListener("click", () => deleteShopping(el.dataset.id));
    if (action === "archive-filter") el.addEventListener("change", (event) => { state.archiveFilter = event.target.value; render(); });
    if (action === "flow-prev") el.addEventListener("click", () => { state.flowStep = Math.max(0, state.flowStep - 1); render(); });
    if (action === "flow-next") el.addEventListener("click", flowNext);
    if (action === "set-verdict") el.addEventListener("click", (event) => setVerdict(event));
    if (action === "export-json") el.addEventListener("click", exportJson);
    if (action === "import-json") el.addEventListener("click", () => app.querySelector('[data-role="import-file"]').click());
  });
  app.querySelectorAll("[data-filter]").forEach((input) => {
    input.addEventListener("input", (event) => {
      state.filters[input.dataset.filter] = event.target.value;
      render();
    });
  });
  const customForm = app.querySelector('[data-form="custom-shopping"]');
  if (customForm) customForm.addEventListener("submit", addCustomShopping);
  const importFile = app.querySelector('[data-role="import-file"]');
  if (importFile) importFile.addEventListener("change", importJson);
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => setView(tab.dataset.view));
});

async function savePantry(value) {
  try {
    const data = await api(`/api/weeks/${state.week.id}/pantry`, {
      method: "PUT",
      body: JSON.stringify({ pantry_notes: value }),
    });
    state.week = data.week;
    showToast("Pantry notes saved");
  } catch (error) {
    showToast(error.message);
  }
}

function openMealModal(meal = null) {
  const isEdit = Boolean(meal);
  showModal(`
    <div class="modal-card">
      <div class="modal-header">
        <div>
          <p class="eyebrow">${isEdit ? "Edit meal" : "Add meal"}</p>
          <h2 id="modal-title">${isEdit ? "Update library meal" : "Add a validated meal"}</h2>
        </div>
        <button class="icon-button" data-modal-close>×</button>
      </div>
      <form class="form-grid" data-form="meal">
        <label class="field">
          <span>Name</span>
          <input class="input" name="name" required value="${attr(meal?.name || "")}" placeholder="Moong dal + jeera rice + cucumber salad">
        </label>
        <div class="field">
          <span class="field-title">Meal type</span>
          <div class="check-row">
            ${MEAL_TYPES.map((type) => `<label class="pill-check"><input type="checkbox" name="meal_types" value="${type}" ${(meal?.meal_types || []).includes(type) ? "checked" : ""}>${type}</label>`).join("")}
          </div>
        </div>
        <div class="field-grid">
          <label class="field">
            <span>Effort</span>
            <select class="select" name="effort">${EFFORTS.map((effort) => `<option ${meal?.effort === effort ? "selected" : ""}>${effort}</option>`).join("")}</select>
          </label>
          <label class="field">
            <span>Prep needed</span>
            <input class="input" name="prep_needed" list="prep-options" value="${attr(meal?.prep_needed || "None")}">
            <datalist id="prep-options">${PREP_OPTIONS.map((prep) => `<option value="${prep}"></option>`).join("")}</datalist>
          </label>
        </div>
        <label class="field">
          <span>Key ingredients</span>
          <textarea class="textarea" name="ingredients" required placeholder="One per line, or comma-separated">${escapeHtml((meal?.ingredients || []).join("\n"))}</textarea>
        </label>
        <label class="field">
          <span>Notes</span>
          <textarea class="textarea" name="notes" placeholder="Optional planning notes">${escapeHtml(meal?.notes || "")}</textarea>
        </label>
        <label class="field">
          <span>Tags</span>
          <input class="input" name="tags" value="${attr((meal?.tags || []).join(", "))}" placeholder="Indian, veg, high-protein">
        </label>
        <div class="button-row">
          <button class="button primary" type="submit">${isEdit ? "Save meal" : "Add meal"}</button>
          <button class="button" type="button" data-modal-close>Cancel</button>
        </div>
      </form>
    </div>
  `);
  modal.querySelector('[data-form="meal"]').addEventListener("submit", (event) => saveMeal(event, meal?.id));
}

async function saveMeal(event, mealId = null) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = {
    name: form.name.value,
    meal_types: [...form.querySelectorAll('input[name="meal_types"]:checked')].map((input) => input.value),
    effort: form.effort.value,
    ingredients: form.ingredients.value,
    prep_needed: form.prep_needed.value,
    notes: form.notes.value,
    tags: form.tags.value,
  };
  try {
    const data = await api(mealId ? `/api/meals/${mealId}` : "/api/meals", {
      method: mealId ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    if (mealId) {
      state.meals = state.meals.map((meal) => meal.id === mealId ? data.meal : meal);
    } else {
      state.meals = [...state.meals, data.meal].sort((a, b) => a.name.localeCompare(b.name));
    }
    closeModal();
    render();
    showToast(mealId ? "Meal updated" : "Meal added");
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteMeal(id) {
  const meal = mealById(id);
  if (!meal || !confirm(`Delete "${meal.name}" from the library? Existing plans will keep the label but lose ingredients.`)) return;
  try {
    await api(`/api/meals/${id}`, { method: "DELETE" });
    state.meals = state.meals.filter((item) => item.id !== id);
    render();
    showToast("Meal deleted");
  } catch (error) {
    showToast(error.message);
  }
}

function mealOptions(selected = "") {
  return `<option value="">Choose a meal</option>${state.meals.map((meal) => `<option value="${meal.id}" ${selected === meal.id ? "selected" : ""}>${escapeHtml(meal.name)}</option>`).join("")}`;
}

function openCellModal(dayIndex, slot) {
  const cell = (state.week.cells || []).find((item) => item.day_index === dayIndex && item.slot === slot);
  const mode = cell?.mode || "meal";
  showModal(`
    <div class="modal-card narrow">
      <div class="modal-header">
        <div>
          <p class="eyebrow">${DAYS[dayIndex]} ${slot}</p>
          <h2 id="modal-title">Plan meal</h2>
        </div>
        <button class="icon-button" data-modal-close>×</button>
      </div>
      <form class="form-grid" data-form="cell">
        <label class="field">
          <span>Cell type</span>
          <select class="select" name="mode" data-role="cell-mode">
            <option value="meal" ${mode === "meal" ? "selected" : ""}>One shared meal</option>
            <option value="split" ${mode === "split" ? "selected" : ""}>Split meal</option>
            <option value="empty">Empty</option>
          </select>
        </label>
        <div data-role="single-fields">
          <label class="field">
            <span>Meal</span>
            <select class="select" name="meal_id">${mealOptions(cell?.meal_id || "")}</select>
          </label>
        </div>
        <div data-role="split-fields" class="form-grid">
          <label class="field">
            <span>Person A</span>
            <select class="select" name="split_a_meal_id">${mealOptions(cell?.split_a_meal_id || "")}</select>
          </label>
          <label class="field">
            <span>Person B</span>
            <select class="select" name="split_b_meal_id">${mealOptions(cell?.split_b_meal_id || "")}</select>
          </label>
          <p class="hint">Use library meals so shopping can include both ingredient sets.</p>
        </div>
        <div class="button-row">
          <button class="button primary" type="submit">Save cell</button>
          ${cell ? `<button class="button danger" type="button" data-action="clear-cell">Clear</button>` : ""}
          <button class="button" type="button" data-modal-close>Cancel</button>
        </div>
      </form>
    </div>
  `);
  const form = modal.querySelector('[data-form="cell"]');
  const updateMode = () => {
    const selected = form.mode.value;
    modal.querySelector('[data-role="single-fields"]').style.display = selected === "meal" ? "block" : "none";
    modal.querySelector('[data-role="split-fields"]').style.display = selected === "split" ? "grid" : "none";
  };
  form.mode.addEventListener("change", updateMode);
  updateMode();
  form.addEventListener("submit", (event) => saveCell(event, dayIndex, slot));
  modal.querySelector('[data-action="clear-cell"]')?.addEventListener("click", () => clearCell(dayIndex, slot));
}

async function saveCell(event, dayIndex, slot) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = {
    day_index: dayIndex,
    slot,
    mode: form.mode.value,
    meal_id: form.meal_id?.value || "",
    split_a_meal_id: form.split_a_meal_id?.value || "",
    split_b_meal_id: form.split_b_meal_id?.value || "",
  };
  try {
    const data = await api(`/api/weeks/${state.week.id}/cells`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    state.week = data.week;
    closeModal();
    render();
    showToast("Plan updated");
  } catch (error) {
    showToast(error.message);
  }
}

async function clearCell(dayIndex, slot) {
  try {
    const data = await api(`/api/weeks/${state.week.id}/cells`, {
      method: "PUT",
      body: JSON.stringify({ day_index: dayIndex, slot, mode: "empty" }),
    });
    state.week = data.week;
    closeModal();
    render();
    showToast("Cell cleared");
  } catch (error) {
    showToast(error.message);
  }
}

async function generateShopping() {
  try {
    const data = await api("/api/shopping/generate", {
      method: "POST",
      body: JSON.stringify({ week_id: state.week.id }),
    });
    state.shoppingItems = data.items;
    render();
    showToast("Shopping list generated");
  } catch (error) {
    showToast(error.message);
  }
}

async function resetShopping() {
  if (!confirm("Reset this week's shopping list? Checked status and custom items will be removed.")) return;
  try {
    const data = await api("/api/shopping/reset", {
      method: "POST",
      body: JSON.stringify({ week_id: state.week.id }),
    });
    state.shoppingItems = data.items;
    render();
    showToast("Shopping list reset");
  } catch (error) {
    showToast(error.message);
  }
}

async function addCustomShopping(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const data = await api("/api/shopping/custom", {
      method: "POST",
      body: JSON.stringify({ week_id: state.week.id, name: form.name.value, category: form.category.value }),
    });
    state.shoppingItems.push(data.item);
    form.reset();
    render();
    showToast("Item added");
  } catch (error) {
    showToast(error.message);
  }
}

async function toggleShopping(id, checked) {
  const item = state.shoppingItems.find((entry) => entry.id === id);
  if (!item) return;
  try {
    const data = await api(`/api/shopping/${id}`, {
      method: "PUT",
      body: JSON.stringify({ ...item, checked }),
    });
    state.shoppingItems = state.shoppingItems.map((entry) => entry.id === id ? data.item : entry);
    render();
  } catch (error) {
    showToast(error.message);
  }
}

function openShoppingModal(id) {
  const item = state.shoppingItems.find((entry) => entry.id === id);
  if (!item) return;
  showModal(`
    <div class="modal-card narrow">
      <div class="modal-header">
        <div>
          <p class="eyebrow">Shopping item</p>
          <h2 id="modal-title">Edit item</h2>
        </div>
        <button class="icon-button" data-modal-close>×</button>
      </div>
      <form class="form-grid" data-form="shopping-edit">
        <label class="field"><span>Name</span><input class="input" name="name" value="${attr(item.name)}" required></label>
        <label class="field"><span>Category</span><select class="select" name="category">${state.categories.map((category) => `<option ${item.category === category ? "selected" : ""}>${category}</option>`).join("")}</select></label>
        <label class="pill-check"><input type="checkbox" name="checked" ${item.checked ? "checked" : ""}>Checked off</label>
        <div class="button-row"><button class="button primary" type="submit">Save item</button><button class="button" type="button" data-modal-close>Cancel</button></div>
      </form>
    </div>
  `);
  modal.querySelector('[data-form="shopping-edit"]').addEventListener("submit", (event) => saveShoppingItem(event, id));
}

async function saveShoppingItem(event, id) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const data = await api(`/api/shopping/${id}`, {
      method: "PUT",
      body: JSON.stringify({ name: form.name.value, category: form.category.value, checked: form.checked.checked }),
    });
    state.shoppingItems = state.shoppingItems.map((entry) => entry.id === id ? data.item : entry);
    closeModal();
    render();
    showToast("Item updated");
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteShopping(id) {
  if (!confirm("Remove this shopping item?")) return;
  try {
    await api(`/api/shopping/${id}`, { method: "DELETE" });
    state.shoppingItems = state.shoppingItems.filter((item) => item.id !== id);
    render();
    showToast("Item removed");
  } catch (error) {
    showToast(error.message);
  }
}

function setVerdict(event) {
  event.preventDefault();
  const wrapper = event.target.closest("[data-verdict-index]");
  const index = Number(wrapper.dataset.verdictIndex);
  state.flowVerdicts[index].verdict = event.target.dataset.value;
  render();
}

async function flowNext() {
  if (state.flowStep === 1 && state.flowVerdicts.length) {
    if (confirm("Archive this grid and move to a fresh week? Choose Cancel if you are using Sunday Flow to plan the current unarchived grid.")) {
      try {
        const data = await api(`/api/weeks/${state.week.id}/archive`, {
          method: "POST",
          body: JSON.stringify({ verdicts: state.flowVerdicts }),
        });
        state.week = data.week;
        state.shoppingItems = data.shoppingItems;
        state.archive = data.archive;
        state.flowVerdicts = [];
        showToast("Week archived; fresh grid ready");
      } catch (error) {
        showToast(error.message);
        return;
      }
    }
  }
  if (state.flowStep === 3) {
    setView("shopping");
    return;
  }
  state.flowStep += 1;
  render();
}

async function exportJson() {
  try {
    const data = await api("/api/export");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `meal-planner-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast("Backup exported");
  } catch (error) {
    showToast(error.message);
  }
}

async function importJson(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (!confirm("Importing will replace the current database. Continue?")) return;
  try {
    const text = await file.text();
    await api("/api/import", { method: "POST", body: text });
    const data = await api("/api/bootstrap");
    updateFromBootstrap(data);
    render();
    showToast("Backup imported");
  } catch (error) {
    showToast(error.message);
  }
}

function showModal(html) {
  modal.innerHTML = html;
  modal.classList.remove("hidden");
  modal.querySelectorAll("[data-modal-close]").forEach((button) => button.addEventListener("click", closeModal));
  modal.addEventListener("click", modalBackdropClose);
  document.addEventListener("keydown", escapeClose);
  const firstInput = modal.querySelector("input, textarea, select, button");
  firstInput?.focus();
}

function closeModal() {
  modal.classList.add("hidden");
  modal.innerHTML = "";
  modal.removeEventListener("click", modalBackdropClose);
  document.removeEventListener("keydown", escapeClose);
}

function modalBackdropClose(event) {
  if (event.target === modal) closeModal();
}

function escapeClose(event) {
  if (event.key === "Escape") closeModal();
}

load();
