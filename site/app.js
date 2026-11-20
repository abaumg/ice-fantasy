"use strict";

// Der gesamte Zustand steckt in der URL und wird nirgends gespeichert:
//   ?name=<Gruppenname>&ids=<Team-IDs aufsteigend>&tab=<Tab>&q=<Suche>
//   &ansicht=<zuwachs|stand|platz> (Verlauf) &pos=<S|FW|DE|GK> (Spieler)
// Einzige Ausnahme ist das Häkchen "Gruppe merken": Dann hält der Browser die
// Gruppe zusätzlich im localStorage und lädt sie, wenn die Seite ohne Gruppe
// in der URL geöffnet wird. Ein Link hat immer Vorrang.

const DATA_URL = "data/standings.json";
const HISTORY_URL = "data/history.json";
const PLAYERS_URL = "data/players.json";
const STORAGE_KEY = "icehl-fantasy-group";
const DEFAULT_NAME = "Meine Gruppe";
const MAX_NAME = 40;
const MAX_IDS = 200;
const TABS = ["gruppe", "gesamt", "verlauf", "spieler"];
const VIEWS = ["zuwachs", "stand", "platz"];
const POSITIONS = ["S", "FW", "DE", "GK"];
const MAX_HISTORY_ROWS = 100;

const points = new Intl.NumberFormat("de-AT", { maximumFractionDigits: 1 });
const delta = new Intl.NumberFormat("de-AT", {
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
});
const percent = new Intl.NumberFormat("de-AT", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const COLUMNS = {
  gruppe: [
    { label: "#", title: "Platz in der Gruppe", num: true, primary: true },
    {
      label: "Gesamt",
      title: "Platz in der Gesamtrangliste",
      num: true,
      secondary: true,
    },
    { label: "Team" },
    { label: "Punkte", num: true },
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
  view: "zuwachs",
  pos: "S",
  playerSort: "total",
  expanded: new Set(),
  history: null, // { status: "loading" | "ok" | "failed", ... }
  players: null,
  loadFailed: false,
  remember: false,
  rememberFailed: false,
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

const nameOf = (group) => group.name.trim() || DEFAULT_NAME;
const displayName = () => nameOf(state.group);
const sameGroup = (a, b) =>
  nameOf(a) === nameOf(b) && a.ids.join() === b.ids.join();

const defaultTab = () => (state.group.ids.length ? "gruppe" : "gesamt");

// Optionaler Speicher im Browser (nur mit Häkchen)

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeGroup(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeStored() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.group));
    return true;
  } catch {
    return false;
  }
}

function clearStored() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // nichts zu tun
  }
}

// URL als maßgeblicher Speicher

function readUrl() {
  const params = new URLSearchParams(location.search);
  const ids = (params.get("ids") ?? "")
    .split(",")
    .map((part) => Number(part.trim()));
  return {
    hasGroup: params.has("ids") || params.has("name"),
    group: normalizeGroup({ name: params.get("name"), ids }),
    tab: params.get("tab"),
    query: params.get("q") ?? "",
    view: params.get("ansicht"),
    pos: params.get("pos"),
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
    if (state.tab === "verlauf" && state.view !== VIEWS[0]) {
      parts.push(`ansicht=${state.view}`);
    }
    if (state.tab === "spieler" && state.pos !== POSITIONS[0]) {
      parts.push(`pos=${state.pos}`);
    }
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
  if (state.tab === "gruppe") {
    row.append(el("td", "num secondary", team.missing ? "–" : team.ranking));
  }

  const name = el("td", "name");
  if (team.missing) {
    name.append(`Team #${team.id}`, el("small", "", "nicht in der Rangliste"));
  } else {
    name.textContent = team.name;
  }
  row.append(name);

  row.append(el("td", "num", team.missing ? "–" : points.format(team.points)));

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

function showMessage(message) {
  const box = $("message");
  box.hidden = !message;
  box.replaceChildren();
  if (!message) return;
  box.append(el("p", "", message.text));
  if (message.action) {
    const button = el("button", "", message.action.label);
    button.addEventListener("click", () => setTab(message.action.tab));
    box.append(button);
  }
}

function showNote(text) {
  $("note").hidden = !text;
  $("note").textContent = text ?? "";
}

function renderList() {
  $("table").classList.toggle(
    "matrix",
    state.tab === "verlauf" || state.tab === "spieler",
  );
  if (state.tab === "verlauf") return renderHistory();
  if (state.tab === "spieler") return renderPlayers();
  showNote("");
  const rows = state.loadFailed ? [] : buildRows();
  showMessage(messageFor(rows));

  const table = $("table");
  table.hidden = rows.length === 0;
  if (rows.length === 0) return;
  const groupIds = new Set(state.group.ids);
  table.tHead.replaceChildren(buildHead());
  table.tBodies[0].replaceChildren(
    ...rows.map((team) => buildRow(team, groupIds)),
  );
}

// Nachgeladene Daten (Verlauf, Spieler) erst beim Öffnen des Tabs holen

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function ensureLoaded(key, url, prepare) {
  if (state[key]) return;
  state[key] = { status: "loading" };
  try {
    state[key] = { status: "ok", ...prepare(await fetchJson(url)) };
  } catch {
    state[key] = { status: "failed" };
  }
  renderList();
}

const ensureHistory = () =>
  ensureLoaded("history", HISTORY_URL, prepareHistory);
const ensurePlayers = () =>
  ensureLoaded("players", PLAYERS_URL, preparePlayers);

function loadingMessage(data, what) {
  if (!data || data.status === "loading") return { text: `Lade ${what} …` };
  if (data.status === "failed") {
    return { text: `${what} konnte nicht geladen werden.` };
  }
  return null;
}

function showMatrix(head, rows) {
  const table = $("table");
  table.hidden = rows.length === 0;
  table.tHead.replaceChildren(head);
  table.tBodies[0].replaceChildren(...rows);
}

const fmtDate = (iso) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString("de-AT", {
    day: "numeric",
    month: "numeric",
  });

const round1 = (value) => Math.round(value * 10) / 10;

// Spaltenköpfe der Runden. Runden ohne eigenen Stand sind mit der folgenden
// zusammengefasst ("R5–6"), weil nur ihre Summe bekannt ist.
function roundHead(round, previous, extra = "") {
  const first = previous + 1;
  const label =
    first === round.round ? `R${round.round}` : `R${first}–${round.round}`;
  const th = el("th", `num round${round.live ? " live" : ""}`);
  th.title =
    `Runde ${first === round.round ? round.round : `${first} bis ${round.round}`}` +
    ` (${fmtDate(round.startDate)}–${fmtDate(round.endDate)})` +
    (round.live ? ", läuft noch" : "") +
    extra;
  th.append(label);
  if (round.live) th.append(el("span", "live-dot", " ●"));
  return th;
}

// Verlauf der Teams

function prepareHistory(data) {
  const rounds = Array.isArray(data.rounds) ? data.rounds : [];
  const totals = new Map(
    Object.entries(data.points ?? {}).map(([id, list]) => [Number(id), list]),
  );
  // Platz nach jeder Runde: Anzahl Teams mit mehr Punkten + 1
  const ranks = rounds.map((_, column) => {
    const sorted = [...totals.values()]
      .map((list) => list[column] ?? 0)
      .sort((a, b) => b - a);
    const firstIndex = new Map();
    sorted.forEach((value, index) => {
      if (!firstIndex.has(value)) firstIndex.set(value, index + 1);
    });
    return firstIndex;
  });
  return { rounds, totals, ranks };
}

function historyValue(list, column, history) {
  const total = list[column] ?? 0;
  if (state.view === "stand") return total;
  if (state.view === "platz") return history.ranks[column].get(total);
  return round1(total - (column > 0 ? (list[column - 1] ?? 0) : 0));
}

function renderHistory() {
  const history = state.history;
  const waiting = loadingMessage(history, "Der Verlauf");
  if (waiting || !history.rounds.length) {
    showMessage(
      waiting ?? {
        text: "Noch kein Verlauf vorhanden. Er entsteht ab dem ersten gespeicherten Stand nach einer Runde.",
      },
    );
    showNote("");
    return showMatrix(el("tr"), []);
  }

  const inGroup = state.tab === "verlauf" && state.group.ids.length > 0;
  let teams = inGroup
    ? state.group.ids.map((id) => state.byId.get(id) ?? { id, missing: true })
    : state.teams;
  teams = teams.slice().sort(byRanking);
  const query = state.query.trim().toLowerCase();
  if (query) teams = teams.filter((team) => matches(team, query));

  showMessage(teams.length ? null : { text: "Keine Treffer." });
  const shown = teams.slice(0, MAX_HISTORY_ROWS);
  const notes = [];
  if (shown.length < teams.length) {
    notes.push(
      `Zeige ${shown.length} von ${teams.length} Teams. Suche oder Gruppe verwenden, um andere zu sehen.`,
    );
  }
  if (!inGroup && state.group.ids.length === 0) {
    notes.push("Mit einer Gruppe siehst du hier nur deine Teams.");
  }
  if (history.rounds.some((round) => round.live)) {
    notes.push("● Runde läuft noch, Stand der letzten Aktualisierung.");
  }
  showNote(notes.join(" "));

  // Neueste Runde zuerst, damit sie ohne Scrollen sichtbar ist
  const columns = history.rounds
    .map((round, index) => ({ round, index }))
    .reverse();
  const head = el("tr");
  head.append(el("th", "num", "#"), el("th", "sticky", "Team"));
  for (const { round, index } of columns) {
    head.append(
      roundHead(round, index > 0 ? history.rounds[index - 1].round : 0),
    );
  }

  const lists = shown.map((team) => history.totals.get(team.id));
  // In "Punkte je Runde" die beste Runde unter den angezeigten Teams hervorheben
  const best = columns.map(({ index }) =>
    state.view === "zuwachs"
      ? Math.max(
          ...lists
            .filter(Boolean)
            .map((list) => historyValue(list, index, history)),
        )
      : null,
  );

  const rows = shown.map((team, rowIndex) => {
    const list = lists[rowIndex];
    const row = el("tr");
    row.append(el("td", "num rank", team.missing ? "–" : team.ranking));
    const name = el(
      "td",
      "name sticky",
      team.missing ? `Team #${team.id}` : team.name,
    );
    row.append(name);
    columns.forEach(({ index }, columnIndex) => {
      if (!list) return row.append(el("td", "num muted", "–"));
      const value = historyValue(list, index, history);
      const live = history.rounds[index].live ? " live" : "";
      let text;
      let title = "";
      let arrow = null;
      if (state.view === "platz") {
        text = value;
        const before =
          index > 0 ? historyValue(list, index - 1, history) : null;
        if (before) {
          const change = before - value;
          title = change
            ? `${change > 0 ? "+" : ""}${change} Plätze`
            : "unverändert";
          if (change)
            arrow = el(
              "span",
              change > 0 ? "up" : "down",
              change > 0 ? " ▲" : " ▼",
            );
        }
      } else if (state.view === "stand") {
        text = points.format(value);
      } else {
        text = value ? delta.format(value) : "0";
        title = `Stand ${points.format(list[index] ?? 0)}`;
      }
      const top =
        best[columnIndex] !== null && value === best[columnIndex] && value > 0;
      const cell = el("td", `num${live}${top ? " best" : ""}`, text);
      if (title) cell.title = title;
      if (arrow) cell.append(arrow);
      row.append(cell);
    });
    return row;
  });
  showMatrix(head, rows);
}

// Spieler

function roundIndexFor(rounds, day) {
  // Letzte Runde, die an oder vor dem Spieltag beginnt
  let found = -1;
  rounds.forEach((round, index) => {
    if (round.startDate <= day) found = index;
  });
  return found;
}

function preparePlayers(data) {
  const allRounds = (data.rounds ?? [])
    .slice()
    .sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
  const used = new Set();
  const players = (data.players ?? []).map((player) => {
    const perRound = new Map();
    for (const game of player.games ?? []) {
      const index = roundIndexFor(allRounds, game.d);
      if (index < 0) continue;
      used.add(index);
      const sum = perRound.get(index) ?? {
        games: [],
        g: 0,
        a: 0,
        pm: 0,
        ga: 0,
        sv: 0,
      };
      sum.games.push(game);
      for (const key of ["g", "a", "pm", "ga", "sv"])
        sum[key] += game[key] ?? 0;
      perRound.set(index, sum);
    }
    const total = {
      games: player.games ?? [],
      g: 0,
      a: 0,
      pm: 0,
      ga: 0,
      sv: 0,
    };
    for (const sum of perRound.values()) {
      for (const key of ["g", "a", "pm", "ga", "sv"]) total[key] += sum[key];
    }
    return { ...player, perRound, total };
  });
  // Nur Runden mit mindestens einem Spiel als Spalten
  const rounds = allRounds
    .map((round, index) => ({ ...round, index }))
    .filter((round) => used.has(round.index));
  return { rounds, players };
}

const isGoalie = () => state.pos === "GK";

function savePct(sum) {
  const shots = sum.sv + sum.ga;
  return shots ? (100 * sum.sv) / shots : null;
}

// Zahl zum Sortieren und Anzeigen; null = kein Spiel
function playerScore(sum) {
  if (!sum || !sum.games.length) return null;
  return isGoalie() ? savePct(sum) : sum.g + sum.a;
}

function sumTitle(sum) {
  const games = `${sum.games.length} ${sum.games.length === 1 ? "Spiel" : "Spiele"}`;
  if (isGoalie()) return `${games}: ${sum.sv} Paraden, ${sum.ga} Gegentore`;
  const pm = sum.pm > 0 ? `+${sum.pm}` : String(sum.pm);
  return `${games}: ${sum.g} Tore, ${sum.a} Assists, ${pm}`;
}

function scoreText(value) {
  if (value === null) return "–";
  return isGoalie() ? percent.format(value) : String(value);
}

function sortHead(label, key, className, title) {
  const th = el("th", className);
  const button = el("button", "sort", label);
  button.type = "button";
  button.dataset.sort = key;
  if (title) button.title = title;
  const active = state.playerSort === key;
  th.setAttribute("aria-sort", active ? "descending" : "none");
  if (active) button.append(el("span", "", " ▾"));
  th.append(button);
  return th;
}

function gameTable(player) {
  const goalie = player.pos === "GK";
  const table = el("table", "games");
  const head = el("tr");
  const labels = goalie
    ? ["Datum", "Gegner", "Ergebnis", "Paraden", "GT", "Fq. %", "Eiszeit"]
    : [
        "Datum",
        "Gegner",
        "Ergebnis",
        "T",
        "A",
        "P",
        "+/–",
        "Schüsse",
        "Eiszeit",
      ];
  labels.forEach((label, index) =>
    head.append(el("th", index > 2 ? "num" : "", label)),
  );
  table.append(el("thead"), el("tbody"));
  table.tHead.append(head);
  const minutes = (seconds) =>
    `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  for (const game of player.games.slice().reverse()) {
    const row = el("tr");
    const cells = [
      fmtDate(game.d),
      `${game.h ? "vs" : "@"} ${game.o}`,
      game.r,
      ...(goalie
        ? [
            game.sv,
            game.ga,
            game.sv + game.ga
              ? percent.format((100 * game.sv) / (game.sv + game.ga))
              : "–",
          ]
        : [
            game.g,
            game.a,
            game.g + game.a,
            game.pm > 0 ? `+${game.pm}` : game.pm,
            game.s,
          ]),
      minutes(game.toi ?? 0),
    ];
    cells.forEach((text, index) =>
      row.append(el("td", index > 2 ? "num" : "", text)),
    );
    table.tBodies[0].append(row);
  }
  return table;
}

function togglePlayer(id) {
  if (!state.expanded.delete(id)) state.expanded.add(id);
  renderList();
}

function renderPlayers() {
  const data = state.players;
  const waiting = loadingMessage(data, "Die Spielerliste");
  if (waiting) {
    showMessage(waiting);
    showNote("");
    return showMatrix(el("tr"), []);
  }

  const query = state.query.trim().toLowerCase();
  const wanted = state.pos === "S" ? ["FW", "DE"] : [state.pos];
  let players = data.players.filter((player) => wanted.includes(player.pos));
  if (query) {
    players = players.filter(
      (player) =>
        player.name.toLowerCase().includes(query) ||
        player.team.toLowerCase() === query,
    );
  }

  const columns = data.rounds.slice().reverse();
  const keyOf = (player) => {
    const sum =
      state.playerSort === "total"
        ? player.total
        : player.perRound.get(Number(state.playerSort));
    return playerScore(sum) ?? -Infinity;
  };
  players.sort(
    (a, b) =>
      keyOf(b) - keyOf(a) ||
      (isGoalie()
        ? b.total.games.length - a.total.games.length
        : b.total.g - a.total.g) ||
      a.name.localeCompare(b.name, "de"),
  );

  showMessage(players.length ? null : { text: "Keine Treffer." });
  showNote(
    isGoalie()
      ? "Fangquote in Prozent je Runde. Auf einen Spieler tippen für alle Spiele."
      : "Scorerpunkte (Tore + Assists) je Runde, Details beim Darüberfahren. Auf einen Spieler tippen für alle Spiele. Fantasy-Punkte pro Spieler liefert die API nicht.",
  );

  const head = el("tr");
  head.append(el("th", "sticky", "Spieler"));
  head.append(el("th", "num", "Sp"));
  head.append(
    sortHead(
      isGoalie() ? "Fq." : "P",
      "total",
      "num",
      isGoalie() ? "Fangquote der Saison" : "Scorerpunkte der Saison",
    ),
  );
  for (const round of columns) {
    const th = roundHead(round, round.round - 1);
    const label = th.firstChild.textContent;
    th.replaceChildren(
      Object.assign(el("button", "sort", label), {
        type: "button",
        title: th.title + " – danach sortieren",
      }),
    );
    th.firstChild.dataset.sort = String(round.index);
    if (state.playerSort === String(round.index)) th.firstChild.append(" ▾");
    head.append(th);
  }

  const width = 3 + columns.length;
  const rows = [];
  for (const player of players) {
    const row = el("tr");
    row.dataset.id = player.id;
    const name = el("td", "name sticky");
    const button = el("button", "expand", player.name);
    button.type = "button";
    button.setAttribute("aria-expanded", String(state.expanded.has(player.id)));
    name.append(button, el("small", "", `${player.team} · ${player.pos}`));
    row.append(name);
    row.append(el("td", "num muted", player.total.games.length));
    const total = el("td", "num strong", scoreText(playerScore(player.total)));
    total.title = sumTitle(player.total);
    row.append(total);
    for (const round of columns) {
      const sum = player.perRound.get(round.index);
      const value = playerScore(sum);
      const cell = el(
        "td",
        `num${value === null ? " muted" : ""}${!isGoalie() && value >= 2 ? " best" : ""}`,
        scoreText(value),
      );
      if (sum) cell.title = sumTitle(sum);
      row.append(cell);
    }
    rows.push(row);
    if (state.expanded.has(player.id)) {
      const detail = el("tr", "detail");
      const cell = el("td");
      cell.colSpan = width;
      cell.append(
        player.games.length ? gameTable(player) : "Noch keine Spiele.",
      );
      detail.append(cell);
      rows.push(detail);
    }
  }
  showMatrix(head, rows);
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
  $("controls").hidden = state.tab !== "verlauf" && state.tab !== "spieler";
  $("view-wrap").hidden = state.tab !== "verlauf";
  $("pos-wrap").hidden = state.tab !== "spieler";
  $("view").value = state.view;
  $("pos").value = state.pos;
  $("share-url").value = shareUrl();
  $("copy").disabled = ids.length === 0;
  $("clear").disabled = ids.length === 0;
  $("remember").checked = state.remember;
  $("remember-note").hidden = !state.rememberFailed;
  $("search").placeholder =
    {
      gruppe: "In der Gruppe suchen …",
      spieler: "Spieler oder Verein suchen …",
    }[state.tab] ?? "Team suchen …";
  syncUrl();
}

function render() {
  renderChrome();
  renderList();
}

// Interaktion

// Nach jeder Änderung an der Gruppe (Name oder Teams)
function groupChanged() {
  if (state.remember && !writeStored()) {
    state.remember = false;
    state.rememberFailed = true;
  }
  renderChrome();
}

function toggleRemember(wanted) {
  if (wanted) {
    const stored = readStored();
    const replaces = stored && !sameGroup(stored, state.group);
    const question =
      `Auf diesem Gerät ist die Gruppe „${stored && nameOf(stored)}“ ` +
      `(${stored?.ids.length} Teams) gemerkt. Durch „${displayName()}“ ersetzen?`;
    if (replaces && !confirm(question)) return renderChrome();
    state.remember = writeStored();
    state.rememberFailed = !state.remember;
  } else {
    clearStored();
    state.remember = false;
    state.rememberFailed = false;
  }
  renderChrome();
}

function setTab(tab) {
  state.tab = tab;
  state.query = "";
  $("search").value = "";
  render();
  $(`tab-${tab}`).scrollIntoView({ block: "nearest", inline: "nearest" });
  if (tab === "verlauf") ensureHistory();
  if (tab === "spieler") ensurePlayers();
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
  groupChanged();

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
  for (const tab of TABS) {
    $(`tab-${tab}`).addEventListener("click", () => setTab(tab));
  }
  document.querySelector(".tabs").addEventListener("keydown", (event) => {
    const index = TABS.indexOf(state.tab);
    const next = {
      ArrowLeft: TABS[(index + TABS.length - 1) % TABS.length],
      ArrowRight: TABS[(index + 1) % TABS.length],
      Home: TABS[0],
      End: TABS[TABS.length - 1],
    }[event.key];
    if (!next) return;
    setTab(next);
    $(`tab-${next}`).focus();
  });

  $("view").addEventListener("change", (event) => {
    state.view = event.target.value;
    syncUrl();
    renderList();
  });
  $("pos").addEventListener("change", (event) => {
    state.pos = event.target.value;
    state.playerSort = "total";
    syncUrl();
    renderList();
  });

  $("search").addEventListener("input", (event) => {
    state.query = event.target.value;
    syncUrl();
    renderList();
  });

  $("table").tBodies[0].addEventListener("click", (event) => {
    const button = event.target.closest(".star");
    if (button) toggleTeam(Number(button.closest("tr").dataset.id), button);
    const toggle = event.target.closest(".expand");
    if (toggle) togglePlayer(Number(toggle.closest("tr").dataset.id));
  });
  $("table").tHead.addEventListener("click", (event) => {
    const button = event.target.closest(".sort");
    if (!button) return;
    state.playerSort = button.dataset.sort;
    renderList();
  });

  $("group-name").addEventListener("input", (event) => {
    state.group.name = event.target.value.slice(0, MAX_NAME);
    groupChanged();
  });
  $("remember").addEventListener("change", (event) =>
    toggleRemember(event.target.checked),
  );
  $("copy").addEventListener("click", copyShareUrl);
  $("clear").addEventListener("click", () => {
    const { ids } = state.group;
    if (confirm(`Alle ${ids.length} Teams aus „${displayName()}“ entfernen?`)) {
      ids.length = 0;
      groupChanged();
      renderList();
    }
  });
}

async function init() {
  const fromUrl = readUrl();
  const stored = readStored();
  // Ein Link hat Vorrang. Ohne Gruppe in der URL greift die gemerkte Gruppe.
  state.group = fromUrl.hasGroup ? fromUrl.group : (stored ?? fromUrl.group);
  // "Merken" gilt nur, wenn die angezeigte Gruppe die gemerkte ist. Bei einem
  // fremden Link bleibt die gemerkte Gruppe unangetastet.
  state.remember = stored !== null && sameGroup(stored, state.group);
  state.tab = TABS.includes(fromUrl.tab) ? fromUrl.tab : defaultTab();
  state.query = fromUrl.query;
  if (VIEWS.includes(fromUrl.view)) state.view = fromUrl.view;
  if (POSITIONS.includes(fromUrl.pos)) state.pos = fromUrl.pos;
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
  if (state.tab === "verlauf") ensureHistory();
  if (state.tab === "spieler") ensurePlayers();
}

init();
