"use strict";

// Die Gruppe wird nirgends gespeichert. Der gesamte Zustand steckt in der URL:
//   ?name=<Gruppenname>&ids=<Team-IDs aufsteigend>&tab=<gruppe|gesamt>&q=<Suche>

const DATA_URL = "data/standings.json";
const DEFAULT_NAME = "Meine Gruppe";
const MAX_NAME = 40;
const MAX_IDS = 200;
const TABS = ["gruppe", "gesamt"];

const points = new Intl.NumberFormat("de-AT", { maximumFractionDigits: 1 });

const COLUMNS = {
  gruppe: [
    { label: "#", title: "Platz in der Gruppe", num: true, primary: true },
    { label: "Team" },
    { label: "Punkte", num: true },
    {
      label: "Gesamt",
      title: "Platz in der Gesamtrangliste",
      num: true,
      secondary: true,
    },
    { label: "In Gruppe", hidden: true },
  ],
  gesamt: [
    {
      label: "#",
      title: "Platz in der Gesamtrangliste",
      num: true,
      primary: true,
    },
    { label: "Team" },
    { label: "Punkte", num: true },
    { label: "In Gruppe", hidden: true },
  ],
};

const state = {
  teams: [],
  byId: new Map(),
  group: { name: DEFAULT_NAME, ids: [] },
  tab: "gesamt",
  query: "",
  loadFailed: false,
};

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Gruppe

function normalizeGroup(raw) {
  const ids = Array.isArray(raw?.ids) ? raw.ids.map(Number) : [];
  const unique = new Set(ids.filter((id) => Number.isInteger(id) && id > 0));
  const name =
    typeof raw?.name === "string" ? raw.name.trim().slice(0, MAX_NAME) : "";
  return {
    name: name || DEFAULT_NAME,
    ids: [...unique].slice(0, MAX_IDS).sort((a, b) => a - b),
  };
}

function displayName() {
  return state.group.name.trim() || DEFAULT_NAME;
}

const defaultTab = () => (state.group.ids.length ? "gruppe" : "gesamt");

// URL als einziger Speicher

function readUrl() {
  const params = new URLSearchParams(location.search);
  const ids = (params.get("ids") ?? "")
    .split(",")
    .map((part) => Number(part.trim()));
  return {
    group: normalizeGroup({ name: params.get("name"), ids }),
    tab: params.get("tab"),
    query: params.get("q") ?? "",
  };
}

// Standardwerte werden weggelassen, damit die Links kurz bleiben.
function urlFor({ view }) {
  const { ids } = state.group;
  const parts = [];
  if (displayName() !== DEFAULT_NAME) {
    parts.push(`name=${encodeURIComponent(displayName())}`);
  }
  if (ids.length) parts.push(`ids=${ids.join(",")}`);
  if (view) {
    if (state.tab !== defaultTab()) parts.push(`tab=${state.tab}`);
    const query = state.query.trim();
    if (query) parts.push(`q=${encodeURIComponent(query)}`);
  }
  return location.pathname + (parts.length ? `?${parts.join("&")}` : "");
}

function syncUrl() {
  try {
    history.replaceState(null, "", urlFor({ view: true }));
  } catch {
    // z. B. in eingebetteten Frames nicht erlaubt: Seite funktioniert weiter
  }
}

function shareUrl() {
  if (!state.group.ids.length) return "";
  return new URL(urlFor({ view: false }), location.href).href;
}

// Daten

const rankOf = (team) => (team.missing ? Infinity : team.ranking);
const byRanking = (a, b) =>
  rankOf(a) === rankOf(b) ? 0 : rankOf(a) < rankOf(b) ? -1 : 1;

async function loadData() {
  const response = await fetch(DATA_URL, { cache: "no-cache" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data.teams)) throw new Error("Ungültige Daten");
  state.teams = data.teams.slice().sort(byRanking);
  state.byId = new Map(state.teams.map((team) => [team.id, team]));
  return data;
}

function renderMeta(data) {
  const parts = [];
  if (Number.isInteger(data.season)) {
    const end = String((data.season + 1) % 100).padStart(2, "0");
    parts.push(`Saison ${data.season}/${end}`);
  }
  const updated = new Date(data.updatedAt);
  if (!Number.isNaN(updated.getTime())) {
    const when = updated.toLocaleString("de-AT", {
      dateStyle: "medium",
      timeStyle: "short",
    });
    parts.push(`Stand ${when}`);
  }
  $("meta").textContent = parts.join(" · ");
}

// Darstellung

function matches(team, query) {
  if (String(team.id) === query.replace(/^#/, "")) return true;
  return !team.missing && team.name.toLowerCase().includes(query);
}

function buildRows() {
  const query = state.query.trim().toLowerCase();
  let rows = state.teams;
  if (state.tab === "gruppe") {
    rows = state.group.ids
      .map((id) => state.byId.get(id) ?? { id, missing: true })
      .sort(byRanking)
      .map((team, index) => ({ ...team, groupRank: index + 1 }));
  }
  return query ? rows.filter((team) => matches(team, query)) : rows;
}

function setStar(button, inGroup) {
  button.textContent = inGroup ? "★" : "☆";
  button.setAttribute("aria-pressed", String(inGroup));
  button.title = inGroup ? "Aus Gruppe entfernen" : "Zur Gruppe hinzufügen";
}

function buildRow(team, groupIds) {
  const inGroup = groupIds.has(team.id);
  const row = el("tr", inGroup && state.tab === "gesamt" ? "in-group" : "");
  row.dataset.id = team.id;

  const rank = state.tab === "gruppe" ? team.groupRank : team.ranking;
  row.append(el("td", "num rank", rank ?? "–"));

  const name = el("td", "name");
  if (team.missing) {
    name.append(`Team #${team.id}`, el("small", "", "nicht in der Rangliste"));
  } else {
    name.textContent = team.name;
  }
  row.append(name);

  row.append(el("td", "num", team.missing ? "–" : points.format(team.points)));
  if (state.tab === "gruppe") {
    row.append(el("td", "num secondary", team.missing ? "–" : team.ranking));
  }

  const star = el("button", "star");
  star.setAttribute(
    "aria-label",
    `In Gruppe: ${team.missing ? `Team #${team.id}` : team.name}`,
  );
  setStar(star, inGroup);
  const cell = el("td", "num");
  cell.append(star);
  row.append(cell);
  return row;
}

function buildHead() {
  const row = el("tr");
  for (const column of COLUMNS[state.tab]) {
    const classes = [column.num && "num", column.secondary && "secondary"];
    const th = el("th", classes.filter(Boolean).join(" "));
    if (column.title) th.title = column.title;
    th.append(
      column.hidden ? el("span", "sr-only", column.label) : column.label,
    );
    row.append(th);
  }
  return row;
}

function messageFor(rows) {
  if (state.loadFailed) {
    return { text: "Die Rangliste konnte nicht geladen werden." };
  }
  if (state.tab === "gruppe" && state.group.ids.length === 0) {
    return {
      text: "Die Gruppe ist noch leer. Markiere Teams in der Gesamttabelle mit ☆.",
      action: { label: "Teams auswählen", tab: "gesamt" },
    };
  }
  return rows.length === 0 ? { text: "Keine Treffer." } : null;
}

function renderList() {
  const rows = state.loadFailed ? [] : buildRows();
  const message = messageFor(rows);

  const box = $("message");
  box.hidden = !message;
  box.replaceChildren();
  if (message) {
    box.append(el("p", "", message.text));
    if (message.action) {
      const button = el("button", "", message.action.label);
      button.addEventListener("click", () => setTab(message.action.tab));
      box.append(button);
    }
  }

  const table = $("table");
  table.hidden = rows.length === 0;
  if (rows.length === 0) return;
  const groupIds = new Set(state.group.ids);
  table.tHead.replaceChildren(buildHead());
  table.tBodies[0].replaceChildren(
    ...rows.map((team) => buildRow(team, groupIds)),
  );
}

// Rahmen (Tabs, Editor) und URL nach jeder Zustandsänderung aktualisieren
function renderChrome() {
  const { ids } = state.group;
  $("tab-gruppe-label").textContent = displayName();
  $("tab-gruppe-count").textContent = ids.length ? `(${ids.length})` : "";
  $("tab-gesamt-count").textContent = state.teams.length
    ? `(${state.teams.length})`
    : "";
  for (const tab of TABS) {
    const button = $(`tab-${tab}`);
    const selected = state.tab === tab;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  $("editor").hidden = state.tab !== "gruppe";
  $("share-url").value = shareUrl();
  $("copy").disabled = ids.length === 0;
  $("clear").disabled = ids.length === 0;
  $("search").placeholder =
    state.tab === "gruppe" ? "In der Gruppe suchen …" : "Team suchen …";
  syncUrl();
}

function render() {
  renderChrome();
  renderList();
}

// Interaktion

function setTab(tab) {
  state.tab = tab;
  state.query = "";
  $("search").value = "";
  render();
}

function toggleTeam(id, button) {
  const { ids } = state.group;
  const index = ids.indexOf(id);
  if (index >= 0) {
    ids.splice(index, 1);
  } else if (ids.length >= MAX_IDS) {
    alert(`Eine Gruppe kann höchstens ${MAX_IDS} Teams enthalten.`);
    return;
  } else {
    ids.push(id);
    ids.sort((a, b) => a - b);
  }
  renderChrome();

  if (state.tab === "gruppe") {
    renderList();
    return;
  }
  // Gesamttabelle: Zeile direkt aktualisieren, damit der Fokus erhalten bleibt.
  const inGroup = index < 0;
  setStar(button, inGroup);
  button.closest("tr").classList.toggle("in-group", inGroup);
}

async function copyShareUrl() {
  const input = $("share-url");
  const button = $("copy");
  input.select();
  let label;
  try {
    await navigator.clipboard.writeText(input.value);
    label = "Kopiert";
  } catch {
    label = "Markiert, Strg+C";
  }
  button.textContent = label;
  setTimeout(() => (button.textContent = "Kopieren"), 2000);
}

function wire() {
  $("tab-gruppe").addEventListener("click", () => setTab("gruppe"));
  $("tab-gesamt").addEventListener("click", () => setTab("gesamt"));
  document.querySelector(".tabs").addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const next =
      event.key === "ArrowLeft" || event.key === "Home" ? "gruppe" : "gesamt";
    setTab(next);
    $(`tab-${next}`).focus();
  });

  $("search").addEventListener("input", (event) => {
    state.query = event.target.value;
    syncUrl();
    renderList();
  });

  $("table").tBodies[0].addEventListener("click", (event) => {
    const button = event.target.closest(".star");
    if (button) toggleTeam(Number(button.closest("tr").dataset.id), button);
  });

  $("group-name").addEventListener("input", (event) => {
    state.group.name = event.target.value.slice(0, MAX_NAME);
    renderChrome();
  });
  $("copy").addEventListener("click", copyShareUrl);
  $("clear").addEventListener("click", () => {
    const { ids } = state.group;
    if (confirm(`Alle ${ids.length} Teams aus „${displayName()}“ entfernen?`)) {
      ids.length = 0;
      renderChrome();
      renderList();
    }
  });
}

async function init() {
  const fromUrl = readUrl();
  state.group = fromUrl.group;
  state.tab = TABS.includes(fromUrl.tab) ? fromUrl.tab : defaultTab();
  state.query = fromUrl.query;
  $("group-name").value = state.group.name;
  $("search").value = state.query;
  // Erklärung beim ersten Besuch (ohne Gruppe) aufgeklappt zeigen
  $("help").open = state.group.ids.length === 0;
  wire();

  try {
    renderMeta(await loadData());
  } catch {
    state.loadFailed = true;
    $("meta").textContent = "";
  }
  render();
}

init();
