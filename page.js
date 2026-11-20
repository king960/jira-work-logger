import { installTeamView } from './team-view.js';
import { normalizeTheme, cacheTheme } from './theme-settings.js';
import { dailyWorkLimit, dailyOvertime } from './time-metrics.js';
import { setLoadingWave } from './loading-wave.js';
import { installWorkspaceUX } from './workspace-ux.js';
import { monthDates, formatDateRange } from './date-range.js';
import { installBitbucketSettings } from './bitbucket-context.js';
import { installWorklogProposals } from "./worklog-proposals.js";
import { installBartekAI, buildBartekAIContext } from "./bartek-ai.js";
import { installLocalAI, aiScope } from "./local-ai.js";
import { installBartekEasterEgg } from "./bartek-easter-egg.js";
import { showNotice, askConfirmation } from "./ui-prompts.js";
import { assistantReport } from "./assistant.js";
import { deleteWorklog, addWorklog, fetchMyIssues, fetchAssignedIssues, fetchIssuePreview, fetchWorklogsRange, fmtHHMM, parseHHMM, projectFilterClause, worklogStartedOnDate, updateWorklog } from "./api.js";
import {
  REMINDER_DEFAULTS,
  analyzeCompletion,
  fromIso,
  groupDaysByWeek,
  loadReminderSettings,
  nextReminderDay,
  normalizeWeeklyHours,
  saveReminderSettings
} from "./reminders.js";

const $ = (id) => document.getElementById(id);

const state = {
  rows: [],
  myIssues: [],
  selected: null,
  pinnedIssues: [],
  hasData: false,
  fetchedRange: null,
  fetchedSource: null,
  reminder: { ...REMINDER_DEFAULTS },
  monthlyTargets: {},
  lastFetchedAt: null,
  releaseDates: [],
  localAISummaries: {},
  dayNotes: {},
  meetingCounts: {}
};

const MEETING_TYPES = [
  { id: "daily", label: "Daily", hours: 0.5 },
  { id: "grooming", label: "Grooming", hours: 1 },
  { id: "planning", label: "Planning", hours: 2 },
  { id: "retro", label: "Retro", hours: 1 }
];
const MEETING_MAX_COUNT = 99;

const DAILY_TYPE = MEETING_TYPES.find((type) => type.id === "daily");
const DAILY_COMMENT = "daily";

// Geometria wykresu tygodniowego (jednostki viewBox = px przy skali 1:1).
const CHART = {
  slot: 30,
  bar: 18,
  weekGap: 22,
  padLeft: 46,
  padRight: 14,
  padTop: 32,
  plotHeight: 168,
  labelHeight: 34
};

function setStatus(s) {
  $("status").textContent = s;
  if (fetchInProgress) $("fetchActivityText").textContent = s;
}

let fetchInProgress = false;
function setFetchBusy(busy) {
  fetchInProgress = busy;
  if (busy) { localAI?.cancel(); bartekAI?.cancel(); worklogProposals?.cancel(); $("bartekAIHeadline").textContent = ""; }
  document.body.classList.toggle("isFetching", busy);
  $("fetchActivity").hidden = !busy;
  document.querySelector(".appShell").setAttribute("aria-busy", String(busy));
  $("fetchBtn").disabled = busy;
  $("refreshBtn").disabled = busy;

  $("refreshBtn").setAttribute("aria-label",busy?"Odświeżanie danych":"Odśwież dane");
  $("newWorklog").disabled=busy;
  syncFetchControls();
  renderBartek();
  setLoadingWave(busy);
}

function syncFetchControls() {
  const selectors = '[data-edit], [data-edit-entry], [data-delete-worklog], [data-delete-entry], [data-add-worklog], [data-add-day-worklog], [data-add-daily], .weekendQuickBtn, #saveBtn, #addWorklogSaveBtn, #meetingsSaveBtn, [data-day-meetings], #editDlg input, #editDlg textarea, #addWorklogDlg input, #addWorklogDlg textarea, #bartekRefresh';
  document.querySelectorAll(selectors).forEach(control => {
    if (fetchInProgress) {
      if (!control.hasAttribute("data-fetch-disabled")) control.dataset.fetchDisabled = String(control.disabled);
      control.disabled = true;
    } else if (control.hasAttribute("data-fetch-disabled")) {
      control.disabled = control.dataset.fetchDisabled === "true";
      control.removeAttribute("data-fetch-disabled");
    }
  });
}

function clampNumber(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return min;
  return Math.min(Math.max(parsed, min), max);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function isDoneStatus(status) {
  return String(status || "").trim().toLowerCase() === "done";
}

function findKnownIssue(issueKey) {
  return buildMyIssues().find((issue) => issue.issueKey === issueKey) ||
    state.pinnedIssues.find((issue) => issue.issueKey === issueKey);
}

function ticketLink(issueKey, withIcon = false) {
  try {
    const base = new URL($("baseUrl").value.trim());
    if (!["https:", "http:"].includes(base.protocol)) return escapeHtml(issueKey);
    const url = new URL(`${base.pathname.replace(/\/$/, "")}/browse/${encodeURIComponent(issueKey)}`, base.origin);
    return `<a class="ticketLink" href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer" title="Otworz ${escapeHtml(issueKey)} w Jira">${escapeHtml(issueKey)}${withIcon ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M14 4h6v6m0-6L10 14M11 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6"/></svg>' : ""}</a>`;
  } catch {
    return escapeHtml(issueKey);
  }
}

function editPencilIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15l-1 6 5-2"/></svg>';
}

function deleteWorklogButton(attribute) {
  return `<button type="button" class="editIconBtn deleteWorklogBtn" ${attribute} title="Usun worklog" aria-label="Usun worklog"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6m4-6v6"/></svg></button>`;
}

const deletingWorklogs = new Set();
async function onDeleteWorklog(row, button) {
  if (fetchInProgress) return;
  const key = `${row.issueKey}:${row.worklogId}`;
  if (deletingWorklogs.has(key)) return;
  if (!row.worklogId) { void showNotice("Ten wpis nie ma identyfikatora. Odswiez dane przed usunieciem."); return; }
  deletingWorklogs.add(key);
  button.disabled = true;
  if (!(await askConfirmation(`Usunac worklog z Jiry?\n\nTicket: ${row.issueKey}\nData: ${row.date}\nCzas: ${row.timeHHMM}\n${row.comment ? `Komentarz: ${row.comment}\n` : ""}\nTej operacji nie mozna cofnac.`))) {
    deletingWorklogs.delete(key);
    button.disabled = false;
    return;
  }
  let deleted = false;
  try {
    if (fetchInProgress) return;
    const params = validate();
    await deleteWorklog({ ...params, issueKey: row.issueKey, worklogId: row.worklogId });
    deleted = true;
    state.rows = state.rows.filter(entry => !(entry.issueKey === row.issueKey && String(entry.worklogId) === String(row.worklogId)));
    renderAll();
    const { lastResult } = await loadLastResult();
    if (lastResult) {
      const rows = (lastResult.rows || []).filter(entry => !(entry.issueKey === row.issueKey && String(entry.worklogId) === String(row.worklogId)));
      const totalSeconds = rows.reduce((sum, entry) => sum + Number(entry.seconds || 0), 0);
      await chrome.storage.local.set({ lastResult: { ...lastResult, rows, totalSeconds, totalHHMM: fmtHHMM(totalSeconds) } });
    }
    $("total").textContent = fmtHHMM(state.rows.reduce((sum, entry) => sum + Number(entry.seconds || 0), 0));
    await onFetch({ force: false });
  } catch (error) {
    void showNotice(deleted ? "Worklog zostal usuniety w Jira, ale odswiezenie lokalnych danych nie powiodlo sie. Pobierz dane ponownie." : String(error?.message || error));
  } finally {
    deletingWorklogs.delete(key);
    button.disabled = false;
  }
}

function renderTable(rows) {
  const tbody = $("tbody");
  tbody.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.date)}</td>
      <td>${ticketLink(r.issueKey)}</td>
      <td style="text-align:center">${escapeHtml(r.timeHHMM)}</td>
      <td>${escapeHtml(r.summary)}</td>
      <td>${escapeHtml(r.comment)}</td>
      <td><button type="button" class="editIconBtn" data-edit="1" title="Edytuj worklog" aria-label="Edytuj worklog">${editPencilIcon()}</button>${deleteWorklogButton('data-delete-worklog="1"')}</td>
    `;
    tr.querySelector("button[data-edit]").addEventListener("click", () => openEdit(r));
    tr.querySelector("[data-delete-worklog]").addEventListener("click", (event) => { void onDeleteWorklog(r, event.currentTarget); });
    tbody.appendChild(tr);
  }
}

function aggregateIssues(rows) {
  const byIssue = new Map();
  for (const row of rows) {
    const current = byIssue.get(row.issueKey) || {
      issueKey: row.issueKey,
      summary: row.summary,
      epic: row.epic,
      issueType: row.issueType,
      seconds: 0,
      entries: 0,
      source: "Worklog"
    };
    current.seconds += Number(row.seconds || 0);
    current.entries += 1;
    byIssue.set(row.issueKey, current);
  }
  return [...byIssue.values()].sort((a, b) => a.issueKey.localeCompare(b.issueKey));
}

function buildMyIssues() {
  const byIssue = new Map();

  for (const issue of state.myIssues) {
    byIssue.set(issue.issueKey, {
      issueKey: issue.issueKey,
      summary: issue.summary,
      epic: issue.epic,
      issueType: issue.issueType,
      status: issue.status || "-",
      seconds: 0,
      entries: 0,
      source: issue.source || "Aktywnosc"
    });
  }

  for (const issue of aggregateIssues(state.rows)) {
    const existing = byIssue.get(issue.issueKey);
    if (existing) {
      existing.summary = existing.summary || issue.summary;
      existing.epic = existing.epic || issue.epic;
      existing.issueType = existing.issueType || issue.issueType;
      existing.seconds = issue.seconds;
      existing.entries = issue.entries;
      if (!existing.source.includes("Worklog")) {
        existing.source = `${existing.source} + Worklog`;
      }
    } else {
      byIssue.set(issue.issueKey, {
        ...issue,
        status: "-"
      });
    }
  }

  return [...byIssue.values()].sort((a, b) => a.issueKey.localeCompare(b.issueKey));
}

function renderWorkedIssues() {
  const tbody = $("workedIssuesBody");
  tbody.innerHTML = "";
  const issues = buildMyIssues();

  if (!issues.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="emptyCell">Pobierz dane, zeby zobaczyc przypisane tickety i tickety z worklogami.</td></tr>`;
    return;
  }

  for (const issue of issues) {
    const action = isDoneStatus(issue.status)
      ? `<span class="mutedAction">Done</span>`
      : `<button data-add-worklog="1">Dodaj worklog</button>`;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${issue.epic ? `${ticketLink(issue.epic.key)} ${escapeHtml(issue.epic.summary)}` : "—"}</td>
      <td>${escapeHtml(issue.issueKey)}</td>
      <td>${escapeHtml(issue.summary)}</td>
      <td>${escapeHtml(issue.status || "-")}</td>
      <td>${escapeHtml(fmtHHMM(issue.seconds))}</td>
      <td>${escapeHtml(issue.source)}</td>
      <td>${action}</td>
    `;
    tr.querySelector("button[data-add-worklog]")?.addEventListener("click", () => {
      openAddWorklog(issue.issueKey, issue.summary, issue.status);
    });
    tbody.appendChild(tr);
  }
}

function renderPinnedIssues() {
  const tbody = $("pinnedIssuesBody");
  tbody.innerHTML = "";

  if (!state.pinnedIssues.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="emptyCell">Dodaj stale tickety, ktore czesto uzupelniasz.</td></tr>`;
    return;
  }

  for (const issue of state.pinnedIssues) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(issue.issueKey)}</td>
      <td>${escapeHtml(issue.summary || "-")}</td>
      <td>
        <button data-add-worklog="1">Dodaj worklog</button>
        <button data-remove-pinned="1">Usun</button>
      </td>
    `;
    tr.querySelector("button[data-add-worklog]").addEventListener("click", () => {
      openAddWorklog(issue.issueKey, issue.summary, issue.status);
    });
    tr.querySelector("button[data-remove-pinned]").addEventListener("click", () => {
      void removePinnedIssue(issue.issueKey);
    });
    tbody.appendChild(tr);
  }
}

function iso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}

async function saveSettings() {
  await chrome.storage.sync.set({
    baseUrl: $("baseUrl").value.trim(),
    email: $("email").value.trim(),
    token: $("token").value,          // uwaga: Basic Auth → wrażliwe
    dateFrom: $("dateFrom").value,
    dateTo: $("dateTo").value,
    project: $("project").value.trim(),
    meetingIssueKey: $("meetingIssueKey").value.trim().toUpperCase(),
    dailyIssueKey: $("dailyIssueKey").value.trim().toUpperCase(),
    planningIssueKey: $("planningIssueKey").value.trim().toUpperCase()
  });
}

function applyTheme(value) {
  const theme = normalizeTheme(value);
  document.body.dataset.theme = theme;
  $("themeSelect").value = theme;
  cacheTheme(theme);
}

$("jiraPanelEnabled").addEventListener("change", async (event) => {
  const input = event.currentTarget;
  const enabled = input.checked;
  input.disabled = true;
  try { await chrome.storage.sync.set({ jiraPanelEnabled: enabled }); }
  catch {
    input.checked = !enabled;
    void showNotice("Nie udalo sie zapisac ustawienia panelu Jiry.");
  } finally { input.disabled = false; }
});

$("themeSelect").addEventListener("change", async (event) => {
  const previous = document.body.dataset.theme || "classic";
  const theme = event.target.value;
  applyTheme(theme);
  try {
    await chrome.storage.sync.set({ theme });
  } catch (error) {
    applyTheme(previous);
    void showNotice(`Nie udalo sie zapisac motywu: ${error?.message || error}`);
  }
});

async function loadSettings() {
  const data = await chrome.storage.sync.get([
    "baseUrl",
    "email",
    "token",
    "dateFrom",
    "dateTo",
    "project",
    "pinnedIssues",
    "meetingIssueKey",
    "dailyIssueKey",
    "planningIssueKey",
    "theme",
    "jiraPanelEnabled",
    "refreshOnReload",
    "showEmptyWeekends"
  ]);
  $("showEmptyWeekends").checked = data.showEmptyWeekends === true;
  applyTheme(data.theme);
  $("jiraPanelEnabled").checked = data.jiraPanelEnabled !== false;
  $("refreshOnReload").checked = data.refreshOnReload === true;
  if (data.baseUrl) $("baseUrl").value = data.baseUrl;
  if (data.email) $("email").value = data.email;
  if (data.token) $("token").value = data.token;
  if (data.project) $("project").value = data.project;
  if (data.meetingIssueKey) $("meetingIssueKey").value = data.meetingIssueKey;
  $("dailyIssueKey").value = data.dailyIssueKey ?? data.meetingIssueKey ?? "";
  $("planningIssueKey").value = data.planningIssueKey ?? data.meetingIssueKey ?? "";

  // domyślne daty jak w Pythonie
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = today.getMonth();
  const day = today.getDate();

  let defFrom, defTo;
  if (day <= 8) {
    const firstThis = new Date(yyyy, mm, 1);
    const lastPrev = new Date(firstThis.getTime() - 86400000);
    const firstPrev = new Date(lastPrev.getFullYear(), lastPrev.getMonth(), 1);
    defFrom = iso(firstPrev);
    defTo = iso(lastPrev);
  } else {
    defFrom = iso(new Date(yyyy, mm, 1));
    defTo = iso(new Date(yyyy, mm+1, 0));
  }

  $("dateFrom").value = data.dateFrom || defFrom;
  $("dateTo").value = data.dateTo || defTo;
  syncPeriodPicker();

  state.pinnedIssues = Array.isArray(data.pinnedIssues) ? data.pinnedIssues : [];

  const { dayNotes, monthlyTargets, releaseDates } = await chrome.storage.local.get(["dayNotes", "monthlyTargets", "releaseDates"]);
  state.releaseDates = Array.isArray(releaseDates) ? releaseDates.filter(date => typeof date === "string") : [];
  state.monthlyTargets = monthlyTargets && typeof monthlyTargets === "object" ? monthlyTargets : {};
  state.dayNotes = dayNotes && typeof dayNotes === "object" && !Array.isArray(dayNotes) ? dayNotes : {};

  state.reminder = await loadReminderSettings();
  applyReminderSettingsToForm();
}

async function savePinnedIssues() {
  await chrome.storage.sync.set({ pinnedIssues: state.pinnedIssues });
}

async function addPinnedIssue() {
  const issueKey = $("pinnedIssueKey").value.trim().toUpperCase();
  const summary = $("pinnedIssueSummary").value.trim();
  if (!issueKey) {
    void showNotice("Podaj issue key.");
    return;
  }

  const existing = state.pinnedIssues.find((issue) => issue.issueKey === issueKey);
  if (existing) {
    existing.summary = summary || existing.summary;
  } else {
    state.pinnedIssues.push({ issueKey, summary });
  }

  state.pinnedIssues.sort((a, b) => a.issueKey.localeCompare(b.issueKey));
  $("pinnedIssueKey").value = "";
  $("pinnedIssueSummary").value = "";
  renderPinnedIssues();
  await savePinnedIssues();
}

async function removePinnedIssue(issueKey) {
  state.pinnedIssues = state.pinnedIssues.filter((issue) => issue.issueKey !== issueKey);
  renderPinnedIssues();
  await savePinnedIssues();
}

function meetingSeconds(type, count) {
  return Math.round(type.hours * 3600) * count;
}

function meetingTotals() {
  const items = MEETING_TYPES.map((type) => {
    const count = state.meetingCounts[type.id] || 0;
    return { ...type, count, seconds: meetingSeconds(type, count) };
  });
  return {
    items,
    count: items.reduce((sum, item) => sum + item.count, 0),
    seconds: items.reduce((sum, item) => sum + item.seconds, 0)
  };
}

// Polskie liczebniki: 1 / 2-4 / 5+, z wyjatkiem nastolatek (12-14).
function plural(count, one, few, many) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (count === 1) return `1 ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} ${few}`;
  return `${count} ${many}`;
}

function pluralWeeks(count) {
  return plural(count, "tydzien", "tygodnie", "tygodni");
}

function pluralDays(count) {
  return plural(count, "dzien", "dni", "dni");
}

function pluralMeetings(count) {
  return plural(count, "spotkanie", "spotkania", "spotkan");
}

function fmtHours(hours) {
  return String(hours).replace(".", ",");
}

function renderMeetingRows() {
  const wrap = $("meetingRows");
  wrap.innerHTML = "";

  for (const type of MEETING_TYPES) {
    const count = state.meetingCounts[type.id] || 0;
    const row = document.createElement("div");
    row.className = "meetingRow";
    row.innerHTML = `
      <div class="meetingName">
        <strong>${escapeHtml(type.label)}</strong>
        <span>${escapeHtml(fmtHours(type.hours))} h za spotkanie</span>
      </div>
      <div class="stepper">
        <button type="button" data-step="-1" aria-label="Mniej: ${escapeHtml(type.label)}">-</button>
        <input class="stepperValue" type="number" min="0" max="${MEETING_MAX_COUNT}" step="1"
               value="${count}" aria-label="Liczba spotkan w tym dniu: ${escapeHtml(type.label)}" />
        <button type="button" data-step="1" aria-label="Wiecej: ${escapeHtml(type.label)}">+</button>
      </div>
      <div class="meetingSubtotal">${escapeHtml(fmtHHMM(meetingSeconds(type, count)))}</div>
    `;
    row.querySelectorAll("button[data-step]").forEach((button) => {
      button.addEventListener("click", () => {
        stepMeetingCount(type.id, Number(button.dataset.step));
      });
    });

    const input = row.querySelector("input.stepperValue");
    input.addEventListener("change", () => setMeetingCount(type.id, input.value));
    input.addEventListener("keydown", (event) => {
      // Enter w formularzu dialogu klika domyslny przycisk, czyli wysylalby worklogi.
      if (event.key !== "Enter") return;
      event.preventDefault();
      setMeetingCount(type.id, input.value);
    });
    wrap.appendChild(row);
  }
}

function renderMeetingsSummary() {
  const { items, count, seconds } = meetingTotals();
  const picked = items.filter((item) => item.count > 0);

  const rows = picked.length
    ? picked.map((item) => `<div class="summaryRow"><span>${escapeHtml(item.label)} x${item.count}</span><strong>${escapeHtml(fmtHHMM(item.seconds))}</strong></div>`)
    : [`<div class="summaryRow"><span>Nic nie wybrano</span><strong>00:00</strong></div>`];

  rows.push(
    `<div class="summaryRow summaryTotal"><span>Razem (${escapeHtml(pluralMeetings(count))})</span><strong>${escapeHtml(fmtHHMM(seconds))}</strong></div>`
  );

  $("meetingsSummary").innerHTML = rows.join("");
  $("meetingsSaveBtn").disabled = seconds === 0;
}

function renderMeetings() {
  renderMeetingRows();
  renderMeetingsSummary();
}

function setMeetingCount(typeId, value) {
  state.meetingCounts[typeId] = clampNumber(value, 0, MEETING_MAX_COUNT);
  renderMeetings();
}

function stepMeetingCount(typeId, step) {
  setMeetingCount(typeId, (state.meetingCounts[typeId] || 0) + step);
}

function openMeetings(date) {
  if(fetchInProgress)return;
  state.meetingCounts = {};
  $("meetingsInfo").textContent = `Daily: ${meetingKeyFor("daily") || "brak"} · Planning: ${meetingKeyFor("planning") || "brak"} · Pozostałe: ${meetingKeyFor("other") || "brak"}`;
  $("meetingsDate").value = date || iso(new Date());
  renderMeetings();
  $("meetingsDlg").showModal();
}

async function onSubmitMeetings(e) {
  e.preventDefault();
  if (fetchInProgress) return;
  const added = [];
  try {
    const params = validate();
    const date = $("meetingsDate").value;
    const { items, count, seconds } = meetingTotals();
    const picked = items.filter((item) => item.count > 0);

    if (!date) throw new Error("Podaj date.");
    if (!picked.length) throw new Error("Wybierz przynajmniej jedno spotkanie.");

    for (const item of picked) {
      const issueKey = meetingKeyFor(item.id);
      if (!issueKey) throw new Error(`Ustaw ticket dla ${item.label} w ustawieniach.`);
      if (isDoneStatus(findKnownIssue(issueKey)?.status)) throw new Error(`Ticket ${issueKey} ma status DONE.`);
    }
    for (const item of picked) {
      const issueKey = meetingKeyFor(item.id);
      setStatus(`Dodaje worklog: ${item.label} (${added.length + 1}/${picked.length})...`);
      await addWorklog({
        baseUrl: params.baseUrl,
        email: params.email,
        token: params.token,
        issueKey,
        date,
        timeHHMM: fmtHHMM(item.seconds),
        comment: `${item.label} x${item.count} (${fmtHours(item.hours)} h)`
      });
      added.push(item);
    }

    $("meetingsDlg").close();
    await onFetch({ force: false });
    void showNotice(`Dodano ${added.length} worklogow: ${fmtHHMM(seconds)} (${pluralMeetings(count)}).`);
  } catch (err) {
    console.error(err);
    setStatus("Blad.");
    // Worklogi lecą po kolei. Przy bledzie w polowie trzeba powiedziec, co juz wpadlo do Jiry,
    // i wyzerowac te pozycje, zeby ponowny submit ich nie zdublowal.
    const done = added.length ? `\n\nDodane przed bledem: ${added.map((item) => `${item.label} x${item.count}`).join(", ")}` : "";
    for (const item of added) state.meetingCounts[item.id] = 0;
    renderMeetings();
    void showNotice(`${String(err?.message || err)}${done}`);
    if (added.length) await onFetch({ force: false });
  }
}

/**
 * Liczymy zawsze dla zakresu, z ktorego pochodza wczytane worklogi.
 * Gdyby brac daty z formularza, zmiana zakresu bez "Pobierz" pokazywalaby
 * dni nowego miesiaca jako puste - bo wisza jeszcze dane poprzedniego.
 */
function currentSummary() {
  const { dateFrom, dateTo } = state.fetchedRange || {};
  if (!state.hasData || !dateFrom || !dateTo || dateFrom > dateTo) return null;
  return analyzeCompletion({
    rows: state.rows,
    dateFrom,
    dateTo,
    dailyTargetHours: state.reminder.dailyTargetHours,
    weeklyHours: state.reminder.weeklyHours,
    respectHolidays: state.reminder.reminderRespectHolidays,
    vacationDates: state.reminder.vacationDates
  });
}

// Puste weekendy sa dostepne jako kompaktowe akcje dodawania wpisu.
function isEmptyWeekend(day) {
  const weekday = fromIso(day.date).getDay();
  return (weekday === 0 || weekday === 6) && !day.isWorkingDay && !day.entries.length && !day.isVacation;
}

function visibleDays(summary) {
  return summary.days.filter((day) => {
    if (state.releaseDates.includes(day.date) || isEmptyWeekend(day) || day.isVacation || day.seconds > 0) return true;
    if (day.isHoliday && ![0, 6].includes(fromIso(day.date).getDay())) return true;
    if (!day.isWorkingDay) return false;
    return true;
  });
}

function dayLongName(dateIso) {
  return fromIso(dateIso).toLocaleDateString("pl-PL", { weekday: "long" });
}

function meetingKeyFor(type) {
  const id = type === "daily" ? "dailyIssueKey" : type === "planning" ? "planningIssueKey" : "meetingIssueKey";
  return $(id).value.trim().toUpperCase();
}
function meetingIssueKeyValue() { return meetingKeyFor("daily"); }

function bindDayDeleteButtons(card, day) {
  card.querySelectorAll("[data-delete-entry]").forEach(button => {
    button.addEventListener("click", (event) => {
      void onDeleteWorklog(day.entries[Number(button.dataset.deleteEntry)], event.currentTarget);
    });
  });
}

const epicIcon = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.3 1.5 3.8 8h3.6l-.7 6.5L12.2 7H8.6l.7-5.5Z" fill="currentColor" stroke="currentColor" stroke-linejoin="round"/></svg>';

function issueTypeIcon(type) {
  if (!type) return "";
  const name = type.toLowerCase();
  const kind = /bug|błąd|blad/.test(name) ? "bug" : /story|requirement|wymaganie/.test(name) ? "story" : /epic/.test(name) ? "epic" : "task";
  const paths = {
    bug: '<path d="M5 6h6v3a3 3 0 0 1-6 0V6Zm1-2a2 2 0 0 1 4 0M3 7h2m6 0h2M3.5 10H5m6 0h1.5"/>',
    story: '<path d="M5 2.5h6v11L8 11.3 5 13.5v-11Z"/>',
    epic: '<path d="m9 2-5 6h3.4L7 14l5-7H8.6L9 2Z"/>',
    task: '<path d="M3 3h10v10H3zM5.5 8l1.6 1.6L10.8 6"/>'
  };
  return `<span class="issueTypeIcon issueTypeIcon--${kind}" title="${escapeHtml(type)}" aria-label="Typ: ${escapeHtml(type)}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[kind]}</svg></span>`;
}

function groupByEpic(items, getIssue = (item) => item) {
  const groups = new Map();
  for (const item of items) {
    const key = getIssue(item).epic?.key || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()];
}

function renderDayWorklogs(day) {
  if (!day.entries.length) {
    return `<p class="dayEmpty">Brak worklogow w tym dniu.</p>`;
  }

  const items = groupByEpic(day.entries.map((row, index) => ({ row, index })), (item) => item.row).map((group) => {
    const epic = group[0].row.epic;
    const heading = `<li class="epicGroupHeading"><span class="dayWorklogEpic" title="${escapeHtml(epic?.summary || "")}">${epicIcon}<span>Epic</span>${epic ? ticketLink(epic.key) : "Brak"}</span>${epic?.summary ? `<span class="epicGroupSummary">${escapeHtml(epic.summary)}</span>` : ""}</li>`;
    return heading + group.map(({ row, index }) => `
    <li class="dayWorklog">
      <span class="dayWorklogKey"><span class="dayWorklogIssue">${issueTypeIcon(row.issueType)}${ticketLink(row.issueKey,true)}</span></span>
      <span class="dayWorklogTime" aria-label="Czas wpisu: ${escapeHtml(row.timeHHMM)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/></svg>${escapeHtml(row.timeHHMM)}</span>
      <span class="dayWorklogText">
        <strong>${escapeHtml(row.summary || "-")}</strong>
        ${row.comment ? `<span>${escapeHtml(row.comment)}</span>` : ""}
      </span>
      <span class="worklogRowActions"><button type="button" class="editIconBtn" data-edit-entry="${index}" title="Edytuj worklog" aria-label="Edytuj worklog">${editPencilIcon()}</button>${deleteWorklogButton(`data-delete-entry="${index}"`)}</span>
    </li>
  `).join("");
  });

  return `<ul class="dayWorklogs">${items.join("")}</ul>`;
}

async function toggleVacation(date, button) {
  button.disabled = true;
  const dates = state.reminder.vacationDates;
  const vacationDates = dates.includes(date)
    ? dates.filter((entry) => entry !== date)
    : [...dates, date].sort();
  try {
    await saveReminderSettings({ vacationDates });
    state.reminder.vacationDates = vacationDates;
    renderAll();
  } catch (error) {
    void showNotice(`Nie udalo sie zapisac urlopu: ${error?.message || error}`);
  } finally {
    button.disabled = false;
  }
}

async function setReleaseDate(date, enabled) {
  const { releaseDates = [] } = await chrome.storage.local.get("releaseDates");
  const next = enabled ? [...new Set([...releaseDates, date])].sort() : releaseDates.filter(entry => entry !== date);
  await chrome.storage.local.set({ releaseDates: next });
  state.releaseDates = next;
  renderAll();
}

function attachReleaseButton(card, date) {
  const selected = state.releaseDates.includes(date);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondaryBtn dayQuickBtn releaseDayBtn";
  button.setAttribute("aria-pressed", String(selected));
  button.title = selected ? "Cofnij oznaczenie dnia releasowego" : "Oznacz jako dzien releasowy";
  button.innerHTML = `${dayActionIcon("release")}<span>Release</span>`;
  card.classList.toggle("isReleaseDay", selected);
  card.querySelector(".dayQuickActions").append(button);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await setReleaseDate(date, !state.releaseDates.includes(date));
    } catch {
      void showNotice("Nie udalo sie zapisac oznaczenia dnia releasowego.");
      button.disabled = false;
    }
  });
}

function attachDayNote(card, date) {
  const meetings=document.createElement('button');meetings.type='button';meetings.className='secondaryBtn dayQuickBtn';meetings.dataset.dayMeetings=date;meetings.innerHTML=`${dayActionIcon('daily')}<span>Spotkania Teams</span>`;meetings.disabled=fetchInProgress;meetings.addEventListener('click',()=>openMeetings(date));card.querySelector('.dayQuickActions').append(meetings);
  attachReleaseButton(card, date);
  localAI.attachDay(card, date);
  const propose = document.createElement("button");
  propose.type="button";propose.className="secondaryBtn dayQuickBtn";propose.textContent="Propozycja";propose.title="Bartek zaproponuje worklog na ten dzien";propose.disabled=fetchInProgress;
  propose.addEventListener("click",()=>{
    openAddWorklog("","","",{date,timeHHMM:"01:00"});
    $("drawerAI").open=true;
    void worklogProposals.propose(date);
  });
  card.querySelector(".dayQuickActions").append(propose);
  const content = document.createElement("div");
  content.className = "dayContent";
  content.append(...card.childNodes);
  const note = document.createElement("aside");
  note.className = "dayNote";
  const saved = typeof state.dayNotes[date] === "string" ? state.dayNotes[date] : "";
  note.hidden = !saved;
  note.id = `day-note-${date}`;
  note.innerHTML = `
    <label for="note-${date}">Prywatna notatka do dnia</label>
    <textarea id="note-${date}" placeholder="Tylko w rozszerzeniu, bez wysylania do Jiry"></textarea>
    <div class="dayNoteActions">
      <button type="button" class="secondaryBtn">Zapisz notatke</button>
      <span role="status"></span>
    </div>
  `;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "secondaryBtn dayQuickBtn";
  toggle.title = "Prywatna notatka do dnia";
  toggle.innerHTML = `${dayActionIcon("note")}<span>Notatka</span>`;
  toggle.setAttribute("aria-controls", note.id);
  const syncToggle = () => {
    toggle.setAttribute("aria-expanded", String(!note.hidden));
  };
  syncToggle();
  toggle.addEventListener("click", () => {
    note.hidden = !note.hidden;
    syncToggle();
    if (!note.hidden) note.querySelector("textarea").focus();
  });
  content.querySelector(".dayQuickActions").append(toggle);
  const textarea = note.querySelector("textarea");
  const button = note.querySelector("button");
  const status = note.querySelector('[role="status"]');
  textarea.value = saved;
  textarea.addEventListener("input", () => { status.textContent = "Niezapisane zmiany"; });
  button.addEventListener("click", async () => {
    button.disabled = true;
    const value = textarea.value;
    try {
      const { dayNotes = {} } = await chrome.storage.local.get("dayNotes");
      const next = { ...dayNotes };
      if (value.trim()) next[date] = value;
      else delete next[date];
      await chrome.storage.local.set({ dayNotes: next });
      state.dayNotes = next;
      status.textContent = value.trim() ? "Zapisano lokalnie" : "Usunieto notatke";
      if (!value.trim()) note.hidden = true;
      syncToggle();
    } catch (error) {
      status.textContent = "Nie udalo sie zapisac. Sprobuj ponownie.";
      console.warn(error);
    } finally {
      button.disabled = false;
    }
  });
  card.classList.add("hasDayNote");
  const actions=content.querySelector('.dayQuickActions');
  const more=document.createElement('button');more.type='button';more.className='secondaryBtn dayQuickBtn dayMoreButton';more.textContent='•••';more.setAttribute('aria-label','Wiecej akcji dnia');
  const menu=document.createElement('div');menu.id=`day-more-${date}`;menu.className='dayMoreMenu';menu.setAttribute('popover','auto');menu.setAttribute('aria-label','Pozostale akcje dnia');
  for(const action of [...actions.children])if(!action.matches('[data-add-day-worklog], [data-inline-day]'))menu.append(action);
  more.setAttribute('popovertarget',menu.id);
  menu.addEventListener('toggle',()=>{if(!menu.matches(':popover-open'))return;const rect=more.getBoundingClientRect();menu.style.left=`${Math.max(8,Math.min(rect.right-menu.offsetWidth,window.innerWidth-menu.offsetWidth-8))}px`;menu.style.top=`${Math.max(8,Math.min(rect.bottom+6,window.innerHeight-menu.offsetHeight-8))}px`;});
  menu.addEventListener('click',event=>{if(event.target.closest('button')&&menu.matches(':popover-open'))menu.hidePopover();});
  actions.append(more,menu);
  card.append(content, note);
}

async function openInlineDayEditor(day, card) {
  const previous = card.querySelector(".inlineDayEditor");
  if (previous) { if (previous.dataset.changed === "true") { previous.remove(); void onFetch({ force: false }); } else previous.remove(); return; }
  let params;
  try { params = validate(); } catch (error) { void showNotice(String(error?.message || error)); return; }
  const panel = document.createElement("section"); panel.className = "inlineDayEditor";
  panel.innerHTML = '<h3>Edycja wpisów</h3><p class="inlineDayStatus" role="status">Pobieram wpisy i przypisane tickety…</p><div class="inlineDayContent"></div>';
  card.append(panel);
  try {
    const [worklogs, issues] = await Promise.all([fetchWorklogsRange({ ...params, dateFrom: day.date, dateTo: day.date, project: null }), fetchAssignedIssues(params)]);
    if (!panel.isConnected) return;
    const content = panel.querySelector(".inlineDayContent"), status = panel.querySelector(".inlineDayStatus");
    status.textContent = "Zmień czas lub komentarz i zapisz wybrany wiersz. Suma uwzględnia wszystkie projekty.";
    const list = document.createElement("div"); list.className = "inlineDayRows"; content.append(list);
    function makeRow(issue, entry = null) {
      const row = document.createElement("div");
      row.className = `inlineDayRow${entry ? "" : " inlineDayNew"}`;
      row.innerHTML = `<div class="inlineDayTicket"><strong>${escapeHtml(issue.issueKey)}</strong><span>${escapeHtml(issue.summary || "Brak opisu")}</span>${entry ? "" : "<small>Nowy wpis</small>"}</div><label>Czas<input data-time value="${escapeHtml(entry?.timeHHMM || "")}" placeholder="00:00" aria-label="Czas ${escapeHtml(issue.issueKey)}" inputmode="numeric"></label><label>Komentarz<input data-comment value="${escapeHtml(entry?.comment || "")}" placeholder="Opcjonalnie" aria-label="Komentarz ${escapeHtml(issue.issueKey)}"></label><button type="button" class="${entry ? "secondaryBtn" : "primaryBtn"}">${entry ? "Zapisz" : "Dodaj"}</button>`;
      list.append(row);
      row.querySelector("button").addEventListener("click", async () => {
        const button = row.querySelector("button");
        try {
          const timeHHMM = row.querySelector("[data-time]").value.trim();
          const seconds = parseHHMM(timeHHMM);
          if (!seconds || !Number.isSafeInteger(seconds)) throw new Error("Czas musi być większy od zera.");
          const comment = row.querySelector("[data-comment]").value.trim();
          button.disabled = true; status.textContent = `Zapisuję ${issue.issueKey}…`;
          if (entry) {
            await updateWorklog({ ...params, issueKey: entry.issueKey, worklogId: entry.worklogId, started: entry.started, newSeconds: seconds, comment });
            entry.seconds = seconds; entry.timeHHMM = fmtHHMM(seconds); entry.comment = comment;
            row.querySelector("[data-time]").value = entry.timeHHMM;
            button.disabled = false;
          } else {
            await addWorklog({ ...params, issueKey: issue.issueKey, date: day.date, timeHHMM, comment });
            row.querySelectorAll("input").forEach(input => input.disabled = true);
            button.textContent = "Dodano";
          }
          panel.dataset.changed = "true";
          status.textContent = "Zapisano wpis. Podsumowanie dnia odświeży się po zamknięciu edycji.";
          updateTotal();
        } catch (error) { status.textContent = `Nie udało się zapisać: ${error?.message || error}`; button.disabled = false; }
      });
    }
    const assignedKeys = new Set(issues.map(issue => issue.issueKey));
    for (const group of groupByEpic(issues)) {
      for (const issue of group) {
        const entries = worklogs.rows.filter(entry => entry.issueKey === issue.issueKey);
        for (const entry of entries) makeRow(issue, entry);
        makeRow(issue);
      }
    }
    for (const entry of worklogs.rows) if (!assignedKeys.has(entry.issueKey)) makeRow(entry, entry);
    if (!issues.length && !worklogs.rows.length) status.textContent = "Brak przypisanych ticketów i zapisanych wpisów w tym dniu.";
    const total = document.createElement("p"); total.className = "inlineDayTotal"; content.append(total);
    function updateTotal() {
      let seconds = 0, valid = true;
      for (const row of list.children) {
        const input = row.querySelector("[data-time]"), value = input.value.trim(); input.removeAttribute("aria-invalid");
        if (!value && row.classList.contains("inlineDayNew")) continue;
        try { const n = parseHHMM(value); if (!n || !Number.isSafeInteger(n)) throw new Error(); seconds += n; }
        catch { valid = false; input.setAttribute("aria-invalid", "true"); }
      }
      total.textContent = valid ? `Razem po zapisaniu: ${fmtHHMM(seconds)}` : "Podaj poprawny czas w formacie HH:MM.";
    }
    list.addEventListener("input", updateTotal); updateTotal();
  } catch (error) { if (panel.isConnected) panel.querySelector(".inlineDayStatus").textContent = `Nie udało się pobrać danych: ${error?.message || error}`; }
}

function dayActionIcon(name) {
  const paths = {
    daily: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
    add: '<path d="M12 5v14M5 12h14"/>',
    vacation: '<path d="M3 12a9 9 0 0 1 18 0H3Zm9-9v17a2 2 0 0 0 4 0M12 3c-4 3-4 6-4 9m4-9c4 3 4 6 4 9"/>',
    release: '<path d="M5 21V4m0 0h13l-3 5 3 5H5"/>',
    note: '<path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h6"/>',
    undo: '<path d="m8 4-5 5 5 5M3 9h11a6 6 0 0 1 0 12"/>'
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

function openWeekendWorklog(date) {
  openAddWorklog("", "", "", { date, timeHHMM: "01:00" });
}

function vacationRun(days, start) {
  const group = [days[start]];
  for (let index = start + 1; index < days.length; index += 1) {
    const previous = fromIso(group[group.length - 1].date);
    previous.setDate(previous.getDate() - 1);
    if (!days[index].isVacation || days[index].date !== iso(previous)) break;
    group.push(days[index]);
  }
  return group;
}

function renderVacationGroup(days) {
  const card = document.createElement("article");
  card.className = "dayCard isFree isVacation vacationGroup";
  const first = days[days.length - 1].date;
  const last = days[0].date;
  card.innerHTML = `
    <header class="dayHead">
      <div class="dayWhen"><strong>Urlop · ${days.length} ${days.length === 1 ? "dzien" : "dni"}</strong><span>${escapeHtml(first === last ? first : `${first} — ${last}`)}</span></div>
      <div class="dayQuickActions"><button type="button" class="secondaryBtn dayQuickBtn" data-edit-vacation aria-expanded="false">${editPencilIcon()}<span>Edytuj</span></button></div>
    </header>
    <div class="vacationEditor" hidden>
      <p class="hint">Odznacz dni, ktore nie sa urlopem, i zapisz. Pozostale oznaczenia urlopu pozostana bez zmian.</p>
      <div class="vacationMembers"></div>
      <div class="vacationEditorActions"><button type="button" class="primaryBtn" data-save-vacation>Zapisz urlop</button><span role="status"></span></div>
    </div>`;
  const editor = card.querySelector(".vacationEditor");
  const toggle = card.querySelector("[data-edit-vacation]");
  for (const day of days) {
    const anchor = document.createElement("span");
    anchor.id = `day-${day.date}`;
    card.prepend(anchor);
    const member = document.createElement("div");
    member.className = "dayCard vacationMember";
    member.innerHTML = `<header class="dayHead"><label class="vacationDayCheck"><input type="checkbox" data-vacation-date="${day.date}" checked />${escapeHtml(dayLongName(day.date))} · ${day.date}</label><div class="dayQuickActions"></div></header>${day.entries.length ? renderDayWorklogs(day) : ""}`;
    member.querySelectorAll("[data-edit-entry]").forEach(button => {
      button.addEventListener("click", () => openEdit(day.entries[Number(button.dataset.editEntry)]));
    });
    attachReleaseButton(member, day.date);
    bindDayDeleteButtons(member, day);
    card.querySelector(".vacationMembers").append(member);
  }
  editor.hidden = !days.some(day => day.entries.length);
  toggle.setAttribute("aria-expanded", String(!editor.hidden));
  toggle.addEventListener("click", () => {
    editor.hidden = !editor.hidden;
    toggle.setAttribute("aria-expanded", String(!editor.hidden));
  });
  card.querySelector("[data-save-vacation]").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    const removed = new Set([...card.querySelectorAll("[data-vacation-date]")].filter(input => !input.checked).map(input => input.dataset.vacationDate));
    const vacationDates = state.reminder.vacationDates.filter(date => !removed.has(date));
    try {
      await saveReminderSettings({ vacationDates });
      state.reminder.vacationDates = vacationDates;
      renderAll();
    } catch (error) {
      card.querySelector('[role="status"]').textContent = "Nie udalo sie zapisac urlopu. Sprobuj ponownie.";
      console.warn(error);
      button.disabled = false;
    }
  });
  return card;
}

const revealedFutureDays = new Set();
function listDaysForDisplay(summary, today = iso(new Date())) {
  return visibleDays(summary).filter(day => day.date <= today || revealedFutureDays.has(day.date));
}

async function navigateChartDay(date, weekendAdd = false) {
  if (fetchInProgress) return;
  if (date > iso(new Date()) && !revealedFutureDays.has(date)) {
    const accepted = await askConfirmation(`Dzien ${date} jeszcze nie nadszedl. Czy chcesz pokazac jego wiersz na liscie?`, {
      title: "Pokazac przyszly dzien?", acceptLabel: "Pokaz dzien", danger: false
    });
    if (!accepted || fetchInProgress || !currentSummary()?.days.some(day => day.date === date)) return;
    revealedFutureDays.add(date);
    renderDays();
    syncFetchControls();
  } else if (weekendAdd) {
    openWeekendWorklog(date);
    return;
  }
  workspaceUX.reveal(date);
  renderDays();
  const target = $(`day-${date}`);
  const card = target?.closest(".dayCard") || target;
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.add("isFocused");
  setTimeout(() => card.classList.remove("isFocused"), 1600);
}

function renderDays() {
  const host = $("daysList");
  const summary = currentSummary();
  workspaceUX.update(summary);

  if (!summary) {
    $("daysRange").textContent = "—";
    $("daysTime").textContent = "—";
    host.innerHTML = `<p class="emptyCell">Pobierz worklogi, zeby zobaczyc rozbicie na dni.</p>`;
    renderWeeklyChart(null);
    return;
  }

  const allDays = listDaysForDisplay(summary).slice().reverse();
  const days = allDays.filter(day=>workspaceUX.matches(day));
  $("visibleDayCount").textContent=`${days.length} dni`;
  const defaultOpenDate=allDays.find(day=>day.date===iso(new Date()))?.date || allDays.find(day=>day.entries.length)?.date || allDays[0]?.date;
  $("daysRange").textContent = fmtRange(state.fetchedRange);
  $("daysTime").textContent = `${fmtHHMM(summary.loggedSeconds)} / ${fmtHHMM(summary.expectedSeconds)}`;
  renderWeeklyChart(summary);

  host.innerHTML = "";
  if (!days.length) {
    const allAhead = summary.days.some((day) => day.isWorkingDay) && !summary.countedDays;
    host.innerHTML = `<p class="emptyCell">${
      workspaceUX.getFilter()!=="all" ? "Brak dni pasujących do wybranego filtra." : allAhead
        ? "Wszystkie dni robocze z tego zakresu sa jeszcze przed nami."
        : "Brak dni roboczych w tym zakresie."
    }</p>`;
    return;
  }

  const issueKey = meetingIssueKeyValue();

  for (let dayIndex = 0; dayIndex < days.length; dayIndex += 1) {
    const day = days[dayIndex];
    if (day.isVacation) {
      const group = vacationRun(days, dayIndex);
      host.append(renderVacationGroup(group));
      dayIndex += group.length - 1;
      continue;
    }
    if (isEmptyWeekend(day)) {
      let row = host.lastElementChild;
      if (!row?.classList.contains("weekendQuickRow")) {
        row = document.createElement("div");
        row.className = "weekendQuickRow";
        host.append(row);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "weekendQuickBtn";
      button.id = `day-${day.date}`;
      button.title = `Dodaj worklog: ${dayLongName(day.date)} ${day.date}`;
      button.innerHTML = `${dayActionIcon("add")}<span>${escapeHtml(dayLongName(day.date))} <time>${escapeHtml(day.date.slice(5).split("-").reverse().join("."))}</time></span>`;
      button.addEventListener("click", () => openWeekendWorklog(day.date));
      row.append(button);
      continue;
    }
    const target = day.targetSeconds;
    const overtime=dailyOvertime(day,state.reminder);
    const displayedLimit=dailyWorkLimit(day,state.reminder);
    const percent = target ? Math.min(100, Math.round((day.seconds / target) * 100)) : 100;
    // Dzien w przyszlosci nie jest "brakiem" - jeszcze sie nie wydarzyl.
    const short = day.counted && day.seconds < target;
    const future = target > 0 && !day.counted;
    const dayState = !target ? "isFree" : future ? "isFuture" : short ? "isShort" : "isDone";
    const card = document.createElement("article");
    card.className = `dayCard ${dayState}`;
    card.id = `day-${day.date}`;
    card.innerHTML = `
      <header class="dayHead dayHeadWithActions">
        <div class="dayWhen">
          <strong>${escapeHtml(dayLongName(day.date))}${day.isHoliday ? ' <small class="holidayBadge">Święto</small>' : ""}</strong>
          <span>${escapeHtml(day.date)}</span>
        </div>
        <div class="dayQuickActions" role="group" aria-label="Akcje dnia ${day.date}">
          <button type="button" class="secondaryBtn dayQuickBtn" data-add-daily title="${escapeHtml(issueKey ? `Dodaj Daily ${fmtHHMM(Math.round(DAILY_TYPE.hours * 3600))} do ${issueKey}` : "Ustaw ticket na spotkania w konfiguracji")}" ${issueKey ? "" : "disabled"}>${dayActionIcon("daily")}<span>Daily</span></button>
          <button type="button" class="secondaryBtn dayQuickBtn" data-inline-day title="Edytuj i dodaj wpisy">✎ <span>Edytuj wpisy</span></button>
          <button type="button" class="secondaryBtn dayQuickBtn" data-add-day-worklog title="Dodaj worklog za ${day.date}">${dayActionIcon("add")}<span>Wpis</span></button>
          <button type="button" class="secondaryBtn dayQuickBtn" data-toggle-vacation title="Oznacz dzien jako urlop">${dayActionIcon("vacation")}<span>Urlop</span></button>
        </div>
        <div class="dayMeter">
          <div class="meterTrack"><span class="meterFill" style="width:${percent}%"></span></div>
          <div class="dayNumbers">
            <div class="dayDeclared"><span>Zadeklarowane</span><strong>${escapeHtml(fmtHHMM(day.seconds))}<small> / ${escapeHtml(fmtHHMM(displayedLimit))}</small></strong></div>
            <span class="dayDelta ${overtime>0?'isOvertime':'isNoOvertime'}">${overtime>0?`+${escapeHtml(fmtHHMM(overtime))}`:'BRAK'}<small>nadgodzin</small></span>
          </div>
        </div>
      </header>
      ${renderDayWorklogs(day)}

    `;

    card.querySelectorAll("button[data-edit-entry]").forEach((button) => {
      button.addEventListener("click", () => openEdit(day.entries[Number(button.dataset.editEntry)]));
    });
    card.querySelector("[data-inline-day]").addEventListener("click", () => { void openInlineDayEditor(day, card); });
    card.querySelector("[data-toggle-vacation]").addEventListener("click", (event) => {
      void toggleVacation(day.date, event.currentTarget);
    });
    card.querySelector("button[data-add-daily]").addEventListener("click", (event) => {
      void addDailyToDay(day.date, event.currentTarget);
    });
    card.querySelector("button[data-add-day-worklog]").addEventListener("click", () => {
      openAddWorklog("", "", "", {
        date: day.date,
        timeHHMM: fmtHHMM(Math.max(0, day.targetSeconds - day.seconds)) || "01:00"
      });
    });
    bindDayDeleteButtons(card, day);
    attachDayNote(card, day.date);
    workspaceUX.decorate(card,day,defaultOpenDate);
    host.appendChild(card);
  }
}

// Slupek: zaokraglony czub (4px), kwadratowa podstawa na linii zerowej.
function barPath(x, yTop, width, baseline) {
  const height = baseline - yTop;
  if (height <= 0) return "";
  const r = Math.min(4, height, width / 2);
  return [
    `M${x},${baseline}`,
    `V${(yTop + r).toFixed(1)}`,
    `Q${x},${yTop} ${(x + r).toFixed(1)},${yTop}`,
    `H${(x + width - r).toFixed(1)}`,
    `Q${(x + width).toFixed(1)},${yTop} ${(x + width).toFixed(1)},${(yTop + r).toFixed(1)}`,
    `V${baseline}`,
    "Z"
  ].join(" ");
}

$("showEmptyWeekends").addEventListener("change", async () => {
  const checked = $("showEmptyWeekends").checked;
  renderWeeklyChart(currentSummary());
  try {
    await chrome.storage.sync.set({ showEmptyWeekends: checked });
  } catch (error) {
    $("showEmptyWeekends").checked = !checked;
    renderWeeklyChart(currentSummary());
    void showNotice("Nie udalo sie zapisac ustawienia wykresu.");
  }
});

function holidayColumn(day, x, width, top, baseline, tip) {
  const clipId = `holiday-${day.date}`;
  const shape = barPath(x, top, width, baseline);
  let seed = Number(day.date.replaceAll("-", ""));
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const symbols = [];
  let index = 0;
  for (let y = top + 13; y < baseline - 8; y += 24 + random() * 9) {
    const center = x + width / 2 + (random() - .5) * Math.max(0, width - 16);
    const angle = Math.round((random() - .5) * 64);
    if (index++ % 3 !== 1) {
      symbols.push(`<text x="${center}" y="${y}" text-anchor="middle" dominant-baseline="central" transform="rotate(${angle} ${center} ${y})" font-family="system-ui, sans-serif" font-size="11" fill="#9da5b0">%</text>`);
    } else {
      symbols.push(`<g transform="translate(${center} ${y}) rotate(${angle})"><path d="M-2-7v4l-2 3v7h8V0L2-3v-4zM-2-5h4M-4 2h8" fill="none" stroke="#9da5b0" stroke-width="1" stroke-linejoin="round"/></g>`);
    }
  }
  return `<g data-date="${day.date}"><title>${escapeHtml(tip)} · Wzor oznacza swieto, nie zalogowane godziny</title><defs><clipPath id="${clipId}"><path d="${shape}"/></clipPath></defs><path class="chartHolidayFill" fill="#eef0f3" d="${shape}"/><g clip-path="url(#${clipId})" pointer-events="none">${symbols.join("")}</g></g>`;
}

function renderWeeklyChart(summary) {
  const host = $("weeklyChart");
  const caption = $("chartCaption");
  $("chartInfo").disabled=!summary;

  if (!summary) {
    caption.textContent = "";
    host.innerHTML = `<p class="hint">Pobierz worklogi, zeby zobaczyc wykres.</p>`;
    return;
  }

  const days = visibleDays(summary).filter(day => $("showEmptyWeekends").checked || state.releaseDates.includes(day.date) || !isEmptyWeekend(day));
  if (!days.length) {
    $("chartInfo").disabled=true;
    caption.textContent = "";
    host.innerHTML = `<p class="hint">Brak dni w tym zakresie.</p>`;
    return;
  }

  const today = iso(new Date());
  const weeks = groupDaysByWeek(days);
  const availableWidth = host.clientWidth;
  const availableSlots = availableWidth - CHART.padLeft - CHART.padRight - (weeks.length - 1) * CHART.weekGap;
  const slot = Math.max(CHART.slot, availableSlots / days.length);
  const chart = { ...CHART, slot, bar: Math.min(32, slot * 0.6) };

  const target = summary.dailyTargetSeconds;
  const holidayBarSeconds = target || 8 * 3600;
  const scaleMax = Math.max(target, ...days.map((day) => day.seconds), days.some(day => day.isHoliday) ? holidayBarSeconds : 0) * 1.12 || 1;
  const baseline = chart.padTop + chart.plotHeight;
  const y = (seconds) => baseline - (seconds / scaleMax) * chart.plotHeight;

  const overtimeThreshold = day => dailyWorkLimit(day,state.reminder);
  const marks = [];
  const dayLabels = [];
  const weekLabels = [];
  const gridlines = [];

  let x = chart.padLeft;
  for (const week of weeks) {
    const groupStart = x;

    for (const day of week.days) {
      const isRelease = state.releaseDates.includes(day.date);
      const releaseFill = isRelease ? ' style="fill:url(#releaseDayStripes)"' : "";
      const barX = x + (chart.slot - chart.bar) / 2;
      const short = day.counted && day.seconds < day.targetSeconds;
      // Bez celu (weekend) albo przed czasem (dzien przyszly) - nie ma czego "spelniac".
      const tone = day.isVacation
        ? "isVacation"
        : day.seconds === 0
        ? "isEmpty"
        : !day.targetSeconds || !day.counted ? "isFree" : short ? "isShort" : "isDone";
      const tip = `${dayLongName(day.date)} ${day.date}: ${fmtHHMM(day.seconds)}` +
        (day.isVacation ? " (Urlop)" : day.targetSeconds ? ` z ${fmtHHMM(day.targetSeconds)}` : " (dzien wolny)") +
        (short ? ` - brakuje ${fmtHHMM(day.targetSeconds - day.seconds)}` : "") + (isRelease ? " · Dzien releasowy" : "") + (day.isHoliday ? " · Święto" : "");

      const overtimeTarget=overtimeThreshold(day);
      const overtime=Math.max(0,day.seconds-overtimeTarget);
      const barBody=day.seconds>0?`<path class="chartBar ${tone}"${releaseFill} d="${barPath(barX,y(day.seconds),chart.bar,baseline)}"/>${overtime>0?`<path class="chartOverTarget" style="fill:url(#overtimeStripes)" data-over-target="${day.date}" data-threshold="${overtimeTarget}" data-excess-seconds="${overtime}" pointer-events="none" d="${barPath(barX,y(day.seconds),chart.bar,y(overtimeTarget))}"/>`:""}`:"";
      const loggedTip=tip+(overtime>0?` · Ponad cel ${fmtHHMM(overtimeTarget)}: +${fmtHHMM(overtime)}`:"");
      const center = barX + chart.bar / 2;
      if (day.isHoliday) {
        marks.push(holidayColumn(day, barX, chart.bar, y(holidayBarSeconds), baseline, tip));
      }

      if (!day.isVacation && day.seconds > 0 && day.seconds < day.targetSeconds) {
        marks.push(`<path class="chartMissingFill" data-date="${day.date}" d="${barPath(barX, y(day.targetSeconds), chart.bar, baseline)}"><title>${escapeHtml(tip)} · Do celu: ${fmtHHMM(day.targetSeconds - day.seconds)}</title></path>`);
      }
      if (isEmptyWeekend(day)) {
        marks.push(`<g class="chartWeekendAdd" data-date="${day.date}" data-weekend-add tabindex="0" role="button" aria-label="Dodaj worklog: ${escapeHtml(dayLongName(day.date))} ${day.date}">
          <title>Dodaj worklog: ${escapeHtml(dayLongName(day.date))} ${day.date}</title>
          <rect${releaseFill} x="${barX - 3}" y="${baseline - 23}" width="${chart.bar + 6}" height="27" rx="4" />
          <path d="M${center - 4} ${baseline - 10}h8M${center} ${baseline - 14}v8" />
        </g>`);
      } else if (day.isVacation) {
        const barTop = day.seconds > 0 ? y(day.seconds) : baseline;
        marks.push(`
          <g class="chartVacationMark" data-date="${day.date}">
            <title>${escapeHtml(loggedTip)}</title>
            ${barBody}
            <rect class="chartVacationBadge" x="${barX}" y="${barTop - 22}" width="${chart.bar}" height="18" rx="4" />
            <text class="chartVacationText" x="${center}" y="${barTop - 9}">U</text>
          </g>
        `);
      } else if (day.isHoliday && day.seconds === 0) {
        // The decorative holiday column already provides the clickable mark.
      } else {
        marks.push(
          day.seconds > 0
            ? `<g class="chartLoggedBar" data-date="${day.date}"><title>${escapeHtml(loggedTip)}</title>${barBody}</g>`
            : day.targetSeconds > 0
              ? `<path class="chartBar chartEmptyOutline"${releaseFill} d="${barPath(barX, y(day.targetSeconds), chart.bar, baseline)}" data-date="${day.date}"><title>${escapeHtml(tip)}${day.date === today ? " · Dzien jeszcze trwa" : ""}</title></path>`
              : `<rect class="chartBar isEmpty"${releaseFill} x="${barX}" y="${baseline - 3}" width="${chart.bar}" height="3" rx="1.5" data-date="${day.date}"><title>${escapeHtml(tip)}</title></rect>`
        );
      }

      dayLabels.push(
        `<text class="chartDayNum" x="${center}" y="${baseline + 15}">${fromIso(day.date).getDate()}</text>` +
        `<text class="chartDayName" x="${center}" y="${baseline + 28}">${day.isHoliday ? "święto" : escapeHtml(fromIso(day.date).toLocaleDateString("pl-PL", { weekday: "short" }))}</text>`
      );
      x += chart.slot;
    }

    const groupWidth = x - groupStart;
    const center = groupStart + groupWidth / 2;
    // Przy waskiej grupie pelna etykieta nachodzilaby na sasiedni tydzien.
    const label = groupWidth >= 120
      ? `Tydz. ${week.week} - ${fmtHHMM(week.loggedSeconds)} / ${fmtHHMM(week.targetSeconds)}`
      : `T${week.week}`;
    weekLabels.push(`<text class="chartWeek" x="${center}" y="${chart.padTop - 14}">${escapeHtml(label)}</text>`);
    x += chart.weekGap;
  }

  const width = x - chart.weekGap + chart.padRight;
  const height = baseline + chart.labelHeight;

  for (const seconds of [0, target / 2]) {
    gridlines.push(
      `<line class="chartGrid" x1="${chart.padLeft - 6}" y1="${y(seconds)}" x2="${width - chart.padRight}" y2="${y(seconds)}" />` +
      `<text class="chartTick" x="${chart.padLeft - 12}" y="${y(seconds) + 4}">${fmtHHMM(seconds)}</text>`
    );
  }

  const targetY = y(target);
  const rule =
    `<line class="chartRule" x1="${chart.padLeft - 6}" y1="${targetY}" x2="${width - chart.padRight}" y2="${targetY}" />` +
    `<text class="chartTick isRule" x="${chart.padLeft - 12}" y="${targetY + 4}">${fmtHHMM(target)}</text>` +
    `<text class="chartRuleLabel" x="${width - chart.padRight}" y="${targetY - 7}">maks. cel dnia ${fmtHHMM(target)}</text>`;

  caption.textContent = [
    `${pluralWeeks(weeks.length)}, ${pluralDays(days.length)}.`,
    days.some(day=>day.seconds>overtimeThreshold(day))?'Fioletowe pasy w prawo: czas ponad dzienny cel.':'',
    days.some(day=>state.releaseDates.includes(day.date))?'Niebiesko-żółte pasy: dzień release’owy.':'',
    days.some(day=>day.isVacation)?'U: urlop.':'',
    'Kliknij słupek, aby przejść do dnia. „+” w weekend pozwala dodać wpis.'
  ].filter(Boolean).join('\n');

  host.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img"
         aria-label="Zalogowany czas dziennie wzgledem minimum ${fmtHHMM(target)}">
      <defs>
        <pattern id="overtimeStripes" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(30)">
          <rect class="chartOverBase" width="8" height="8" />
          <rect class="chartOverStripe" width="3" height="8" />
        </pattern>
        <pattern id="releaseDayStripes" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(30)">
          <rect width="8" height="8" fill="#3b82f6" />
          <rect width="8" height="4" fill="#fbbf24" />
        </pattern>
      </defs>
      ${gridlines.join("")}
      ${marks.join("")}
      ${rule}
      ${dayLabels.join("")}
      ${weekLabels.join("")}
    </svg>
  `;

  host.querySelectorAll("[data-date]").forEach(mark => {
    const activate = () => { void navigateChartDay(mark.dataset.date, mark.hasAttribute("data-weekend-add")); };
    mark.addEventListener("click", activate);
    mark.setAttribute("tabindex", "0");
    mark.setAttribute("role", "button");
    mark.setAttribute("aria-label", `${dayLongName(mark.dataset.date)} ${mark.dataset.date} — pokaz dzien`);
    mark.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });
  });
}

let chartResizeFrame;
let previousChartWidth = -1;
const chartResizeObserver = new ResizeObserver(entries => {
  const width = entries[0]?.contentRect.width || 0;
  if (width <= 0 || Math.abs(width - previousChartWidth) < 1) return;
  previousChartWidth = width;
  cancelAnimationFrame(chartResizeFrame);
  chartResizeFrame = requestAnimationFrame(() => renderWeeklyChart(currentSummary()));
});
chartResizeObserver.observe($("weeklyChart"));

async function addDailyToDay(dateIso, button) {
  if (fetchInProgress) return;
  const issueKey = meetingIssueKeyValue();
  if (!issueKey) {
    void showNotice("Podaj ticket na spotkania w polu \"Ticket na spotkania\".");
    return;
  }

  const knownIssue = findKnownIssue(issueKey);
  if (knownIssue && isDoneStatus(knownIssue.status)) {
    void showNotice(`Nie mozna dodac workloga do ${issueKey}, bo ticket jest DONE.`);
    return;
  }

  const timeHHMM = fmtHHMM(Math.round(DAILY_TYPE.hours * 3600));
  try {
    if (button) button.disabled = true;
    const params = validate();
    setStatus(`Dodaje daily ${timeHHMM} do ${issueKey} (${dateIso})...`);
    await addWorklog({
      baseUrl: params.baseUrl,
      email: params.email,
      token: params.token,
      issueKey,
      date: dateIso,
      timeHHMM,
      comment: DAILY_COMMENT
    });
    await onFetch({ force: false });
    setStatus(`Dodano daily ${timeHHMM} do ${issueKey} (${dateIso}).`);
  } catch (error) {
    console.error(error);
    setStatus("Blad.");
    void showNotice(String(error?.message || error));
  } finally {
    if (button) button.disabled = false;
  }
}

function reminderOptions() {
  return {
    leadDays: state.reminder.reminderLeadDays,
    respectHolidays: state.reminder.reminderRespectHolidays,
    weeklyHours: state.reminder.weeklyHours
  };
}

function currentRange() {
  return { dateFrom: $("dateFrom").value, dateTo: $("dateTo").value };
}

function syncPeriodPicker() {
  const range=currentRange(),month=monthDates(range.dateFrom?.slice(0,7)||'');
  const full=month&&range.dateFrom===month.dateFrom&&range.dateTo===month.dateTo;
  $('periodMonth').value=range.dateFrom?.slice(0,7)||iso(new Date()).slice(0,7);
  $('customDateRange').hidden=!!full;
  $('periodMode').value=full?'month':'custom';
  $('monthPickerControls').hidden=!full;
}
function chooseMonth(value){
  const dates=monthDates(value);if(!dates)return;
  $('dateFrom').value=dates.dateFrom;$('dateTo').value=dates.dateTo;renderRangeNotice();
}
$('periodMonth').addEventListener('change',event=>chooseMonth(event.target.value));
$('periodMode').addEventListener('change',event=>{
  if(event.target.value==='month')chooseMonth($('periodMonth').value);
  else {$('customDateRange').hidden=false;$('monthPickerControls').hidden=true;$('dateFrom').focus();}
});
for(const [id,offset] of [['previousMonth',-1],['nextMonth',1]])$(id).addEventListener('click',()=>{
  const [year,month]=$('periodMonth').value.split('-').map(Number);
  chooseMonth(iso(new Date(year,month-1+offset,1)).slice(0,7));
});
$('currentMonth').addEventListener('click',()=>chooseMonth(iso(new Date()).slice(0,7)));

function fmtRange(range) {
  return formatDateRange(range);
}

function renderRangeNotice() {
  syncPeriodPicker();
  const notice = $("rangeNotice");
  const selected = currentRange();
  const fetched = state.fetchedRange;
  const mismatch = state.hasData && fetched &&
    (selected.dateFrom !== fetched.dateFrom || selected.dateTo !== fetched.dateTo);

  notice.classList.toggle("isVisible", Boolean(mismatch));
  notice.textContent = mismatch
    ? `Pokazane dane sa z zakresu ${fmtRange(fetched)}. Kliknij "Pobierz", zeby wczytac ${fmtRange(selected)}.`
    : "";
}

function fmtSigned(seconds) {
  const sign = seconds < 0 ? "-" : "+";
  return `${sign}${fmtHHMM(Math.abs(seconds))}`;
}

function dayName(dateIso) {
  return fromIso(dateIso).toLocaleDateString("pl-PL", { weekday: "short" });
}

function applyReminderSettingsToForm() {
  $("reminderEnabled").checked = state.reminder.reminderEnabled;
  $("reminderHour").value = state.reminder.reminderHour;
  $("reminderLeadDays").value = state.reminder.reminderLeadDays;
  $("dailyTargetHours").value = state.reminder.dailyTargetHours;
  const schedule = normalizeWeeklyHours(state.reminder.weeklyHours, state.reminder.dailyTargetHours);
  document.querySelectorAll("[data-weekday-hours]").forEach(input => { input.value = schedule[Number(input.dataset.weekdayHours)]; });
  $("reminderRespectHolidays").checked = state.reminder.reminderRespectHolidays;
}

async function updateReminderSettings(patch) {
  state.reminder = { ...state.reminder, ...patch };
  applyReminderSettingsToForm();
  renderDays();
  renderReminders();
  await saveReminderSettings(state.reminder);
}

function renderReminderHint(next) {
  if (!state.reminder.reminderEnabled) {
    $("reminderHint").textContent = "Przypomnienia sa wylaczone.";
    return;
  }
  const hour = String(state.reminder.reminderHour).padStart(2, "0");
  const when = next ? `${next.date} o ${hour}:00` : "-";
  $("reminderHint").textContent =
    `Chrome pokaze powiadomienie ${when}, jesli przegladarka bedzie uruchomiona. ` +
    "Gdy wszystko jest uzupelnione, powiadomienie sie nie pojawia.";
}

function renderReminderSummary(summary) {
  const box = $("reminderSummary");
  if (!summary) {
    box.innerHTML = `<p class="hint">Pobierz worklogi, zeby policzyc braki w wybranym zakresie.</p>`;
    return;
  }

  const rows = [
    ["Okres", fmtRange(summary)],
    ["Dni robocze (rozliczane)", `${summary.countedDays} z ${summary.workingDays}`],
    ["Cel", fmtHHMM(summary.expectedSeconds)],
    ["Zalogowane", fmtHHMM(summary.loggedSeconds)],
    ["Brakuje w dniach", `${fmtHHMM(summary.dailyGapSeconds)} (${summary.missingDays.length})`],
    ["Saldo zakresu", fmtSigned(summary.balanceSeconds)]
  ];

  box.innerHTML = rows
    .map(([label, value]) => `<div class="summaryRow"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`)
    .join("");
}

function renderMissingDays(summary) {
  const tbody = $("missingDaysBody");
  tbody.innerHTML = "";

  if (!summary) {
    tbody.innerHTML = `<tr><td colspan="5" class="emptyCell">Brak danych. Pobierz worklogi dla wybranego zakresu.</td></tr>`;
    return;
  }

  if (!summary.missingDays.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="emptyCell">Wszystkie dni robocze w zakresie sa uzupelnione.</td></tr>`;
    return;
  }

  const defaultIssueKey = state.pinnedIssues[0]?.issueKey || "";

  for (const day of summary.missingDays) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(day.date)}</td>
      <td>${escapeHtml(dayName(day.date))}</td>
      <td>${escapeHtml(fmtHHMM(day.seconds))}</td>
      <td class="missingCell">${escapeHtml(fmtHHMM(day.missingSeconds))}</td>
      <td><button data-add-worklog="1">Dodaj worklog</button></td>
    `;
    tr.querySelector("button[data-add-worklog]").addEventListener("click", () => {
      openAddWorklog(defaultIssueKey, `Uzupelnienie za ${day.date}`, "", {
        date: day.date,
        timeHHMM: fmtHHMM(day.missingSeconds)
      });
    });
    tbody.appendChild(tr);
  }
}

function renderAll() {
  renderRangeNotice();
  renderTable(state.rows);
  renderWorkedIssues();
  renderDays();
  renderReminders();
  syncFetchControls();
}

function renderReminders() {
  const next = nextReminderDay(new Date(), reminderOptions());
  $("reminderNext").textContent = next
    ? `Najblizsze przypomnienie: ${next.date}${next.isLastWorkingDay ? " (ostatni dzien roboczy)" : ` (zostaja ${next.workingDaysLeft} dni robocze)`}`
    : "-";
  renderReminderHint(next);

  const summary = currentSummary();

  $("missing").textContent = summary ? fmtHHMM(summary.dailyGapSeconds) : "-";
  $("missing").closest(".statBlock").classList.toggle("isClear", Boolean(summary) && summary.dailyGapSeconds === 0);
  renderReminderSummary(summary);
  renderMissingDays(summary);
  renderBartek();
}

let bartekTopic = "backlog";

function setBartekOpen(open) {
  $("bartekPanel").hidden = false;
  if(open){setActiveTab("assistant");document.querySelector(".assistantOverview").open=true;}
  $("bartekToggle").setAttribute("aria-expanded", String(open));
  $("bartekSpeech").setAttribute("aria-expanded", String(open));
  if (open) renderBartek();
}

$("bartekToggle").addEventListener("click", () => setBartekOpen($("bartekPanel").hidden));
$("bartekSpeech").addEventListener("click", () => setBartekOpen($("bartekPanel").hidden));
$("bartekSpeechDismiss").addEventListener("click", () => {
  $("bartekSpeechWrap").hidden = true;
  $("bartekToggle").focus();
});
$("bartekOpenChat").addEventListener("click", () => {
  setBartekOpen(false);
  setActiveTab("assistant");
  $("bartekAIQuestion").focus();
});
$("bartekClose").addEventListener("click", () => { setBartekOpen(false); $("bartekToggle").focus(); });
$("bartekPanel").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.stopPropagation();
    setBartekOpen(false);
    $("bartekToggle").focus();
  }
});
document.querySelectorAll("[data-bartek-topic]").forEach(button => {
  button.addEventListener("click", () => { bartekTopic = button.dataset.bartekTopic; renderBartek(); });
});
$("bartekRefresh").addEventListener("click", async () => {
  $("bartekRefresh").disabled = true;
  try { await onFetch({ force: false }); }
  finally { $("bartekRefresh").disabled = false; }
});

$("bartekSaveTarget").addEventListener("click", async () => {
  const summary = currentSummary();
  if (!summary) { void showNotice("Najpierw pobierz worklogi za wybrany miesiac."); return; }
  const daily = Number($("bartekDailyHours").value);
  const rawMonthly = $("bartekMonthlyHours").value.trim();
  const monthly = Number(rawMonthly);
  if (!(daily > 0 && daily <= 24) || (rawMonthly && !(Number.isFinite(monthly) && monthly >= 0 && monthly <= 744))) {
    void showNotice("Podaj cel dzienny od 0 do 24 h (wiekszy od zera) i miesieczny od 0 do 744 h."); return;
  }
  const monthKey = summary.dateFrom.slice(0,7);
  const next = {...state.monthlyTargets};
  if (rawMonthly) next[monthKey] = monthly; else delete next[monthKey];
  try {
    await chrome.storage.local.set({monthlyTargets:next});
    const currentSchedule = normalizeWeeklyHours(state.reminder.weeklyHours, state.reminder.dailyTargetHours);
    const weeklyHours = daily === state.reminder.dailyTargetHours ? currentSchedule : currentSchedule.map(hours => hours > 0 ? daily : 0);
    await saveReminderSettings({dailyTargetHours:daily, weeklyHours});
    state.reminder.weeklyHours = weeklyHours;
    state.monthlyTargets = next;
    state.reminder.dailyTargetHours = daily;
    applyReminderSettingsToForm();
    renderAll();
  } catch { void showNotice("Nie udalo sie zapisac celu godzinowego."); }
});

function renderBartek() {
  bartekAI.refresh();
  document.querySelectorAll("[data-bartek-topic]").forEach(button => { button.disabled = fetchInProgress; });
  if (fetchInProgress) {
    $("bartekBadge").textContent = "Laduje dane z Jiry…";
    $("bartekOverview").innerHTML = '<p class="bartekLoading"><span class="fetchSpinner" aria-hidden="true"></span> Laduje aktualne worklogi i tickety.</p>';
    $("bartekAdvice").textContent = "Gdy pobieranie sie zakonczy, sprawdze zaleglosci i przelicze podsumowanie. Na ten czas edycja wpisow jest zablokowana.";
    return;
  }
  const summary = currentSummary();
  const report = assistantReport(summary, iso(new Date()), {
    dailyTargetHours: state.reminder.dailyTargetHours,
    weeklyHours: state.reminder.weeklyHours,
    vacationDates: state.reminder.vacationDates,
    respectHolidays: state.reminder.reminderRespectHolidays,
    monthlyTargets: state.monthlyTargets
  });
  $("bartekDailyHours").value = state.reminder.dailyTargetHours;
  $("bartekMonthlyHours").value = report?.customMonthlyTarget ? state.monthlyTargets[report.monthKey] : "";
  const overview = $("bartekOverview");
  const advice = $("bartekAdvice");
  document.querySelectorAll("[data-bartek-topic]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.bartekTopic === bartekTopic));
  });
  if (!report) {
    $("bartekBadge").textContent = "Czekam na dane";
    overview.textContent = "Czesc! Pobierz worklogi, a sprawdze, czy masz zaleglosci i od czego zaczac.";
    advice.textContent = "Ustaw polaczenie z Jira i wybierz zakres dat. Przycisk ponizej pobierze aktualne dane.";
    return;
  }
  const { overdue, current } = report;
  $("bartekBadge").textContent = !report.monthComplete ? "Pobierz caly miesiac" : report.monthlyMissingSeconds ? `Do celu miesiaca: ${fmtHHMM(report.monthlyMissingSeconds)}` : "Cel miesiaca osiagniety!";
  const message = !report.monthComplete
    ? `Mam niepelne dane za ${report.monthKey}. Pobierz caly miesiac, zebym mogl rzetelnie ocenic sume.`
    : report.monthlyMissingSeconds
      ? `Do celu za ${report.monthKey} zostalo ${fmtHHMM(report.monthlyMissingSeconds)}. Licze sume godzin — dluzszy dzien moze wyrownac krotszy.`
      : `Cel za ${report.monthKey} osiagniety!${report.monthlyBalanceSeconds > 0 ? ` Nadwyzka: ${fmtHHMM(report.monthlyBalanceSeconds)}.` : ""} Pojedyncze krotsze dni nie oznaczaja zaleglosci.`;
  overview.innerHTML = `<p>${escapeHtml(message)}</p><div class="bartekMetrics"><span>Zalogowano <strong>${fmtHHMM(report.monthlyLoggedSeconds)}</strong></span><span>Cel miesiaca <strong>${fmtHHMM(report.monthlyTargetSeconds)}</strong></span><span>Do celu <strong>${report.monthComplete ? fmtHHMM(report.monthlyMissingSeconds) : "—"}</strong></span></div><small>Miesiac: ${report.monthKey} · ${report.customMonthlyTarget ? "wlasny cel" : "harmonogram tygodnia, bez urlopow"}${state.lastFetchedAt ? ` · Pobrano: ${escapeHtml(new Date(state.lastFetchedAt).toLocaleString("pl-PL"))}` : ""}</small>`;
  advice.replaceChildren();
  const say = text => { const p = document.createElement("p"); p.textContent = text; advice.append(p); };
  const listDays = days => {
    for (const day of days) {
      const row = document.createElement("div"); row.className = "bartekDay";
      const label = document.createElement("span");
      label.textContent = `${day.date} · ${fmtHHMM(day.seconds)} / ${fmtHHMM(day.targetSeconds)}`;
      const button = document.createElement("button"); button.type = "button";
      button.textContent = `Uzupelnij ${fmtHHMM(day.missingSeconds)}`;
      button.addEventListener("click", () => openAddWorklog("", "", "", {date:day.date,timeHHMM:fmtHHMM(day.missingSeconds)}));
      row.append(label,button); advice.append(row);
    }
  };
  if (!report.monthComplete) {
    const button = document.createElement("button");
    button.type = "button"; button.className = "secondaryBtn"; button.textContent = `Pobierz miesiac ${report.monthKey}`;
    button.addEventListener("click", () => {
      $("dateFrom").value = report.monthRange.dateFrom;
      $("dateTo").value = report.monthRange.dateTo;
      void onFetch({force:false});
    });
    advice.append(button);
  }
  if (bartekTopic === "backlog") {
    say(report.monthlyMissingSeconds ? `Zalogowano ${fmtHHMM(report.monthlyLoggedSeconds)} z ${fmtHHMM(report.monthlyTargetSeconds)}. Cel dotyczy calego miesiaca, lacznie z dniami, ktore sa jeszcze przed nami.` : "Miesieczna suma jest wystarczajaca. Nie musisz wyrownywac kazdego dnia do minimum.");
    say("Do sumy wliczam tez wpisy weekendowe. Dane obejmuja projekty wybrane podczas pobierania.");
  } else if (bartekTopic === "today") {
    if (!current) say("Dzisiaj jest poza pobranym zakresem. Wybierz zakres obejmujacy dzisiejsza date i odswiez dane.");
    else if (current.isVacation) say("Dzis masz urlop. Nie musisz uzupelniac godzin.");
    else if (!current.isWorkingDay) say(`Dzis jest dzien wolny. Zalogowano ${fmtHHMM(current.seconds)}, bez wymaganego minimum.`);
    else if (!current.missingSeconds) say(`Dzisiejszy cel osiagniety: ${fmtHHMM(current.seconds)} z ${fmtHHMM(current.targetSeconds)}.`);
    else { say(`Dzien jeszcze trwa. Do celu zostalo ${fmtHHMM(current.missingSeconds)}.`); listDays([current]); }
  } else if (bartekTopic === "plan") {
    if (!report.monthlyMissingSeconds) say("Cel miesiaca jest osiagniety. Krotsze dni nie wymagaja uzupelniania.");
    else if (!overdue.length) say("Nie ma starszych dni z brakami. Pozostala suma dotyczy dalszej czesci miesiaca.");
    else {
      say(`Do miesiecznej sumy zostalo ${fmtHHMM(report.monthlyMissingSeconds)}. Ponizej dni z mniejsza liczba godzin — to wskazowki, a nie osobne zaleglosci. Wpisuj faktyczny czas pracy.`);
      listDays(overdue);
      say("Jesli danego dnia nie pracowales, oznacz go jako Urlop na liscie dni.");
    }
  } else {
    say(`Saldo miesiaca: ${fmtSigned(report.monthlyBalanceSeconds)}. Ocene opieram na sumie godzin, nie na sumie brakow dziennych.`);
    if (report.monthlyBalanceSeconds >= 0 && summary.dailyGapSeconds > 0) say("Niektore dni sa krotsze, ale nadwyzka z innych dni pokrywa miesieczny cel.");
    if (report.longDays.length) say(`Sprawdz dni z ponad 12 godzinami: ${report.longDays.map(day => `${day.date} (${fmtHHMM(day.seconds)})`).join(", ")}. To moze byc poprawne, ale warto zweryfikowac.`);
    else say("Nie widze dni z ponad 12 godzinami.");
    const vacationWork = summary.days.filter(day => day.isVacation && day.seconds > 0);
    if (vacationWork.length) say(`Worklogi w dni oznaczone urlopem: ${vacationWork.map(day=>day.date).join(", ")}. Sprawdz oznaczenie tych dni.`);
    say("Analizuje wybrany zakres i pobrane projekty. Nowe wpisy w Jira beda widoczne po odswiezeniu.");
  }
}

async function runReminderCheckNow() {
  try {
    setStatus("Sprawdzam braki i wysylam powiadomienie...");
    const result = await chrome.runtime.sendMessage({ type: "reminder:check", force: true });
    if (!result?.ok) throw new Error(result?.error || "Service worker nie odpowiedzial.");
    if (result.error) throw new Error(result.error);
    setStatus(result.notified ? "Powiadomienie wyslane." : "Sprawdzono - brak powiadomienia.");
  } catch (error) {
    console.error(error);
    setStatus("Blad.");
    void showNotice(`Nie udalo sie wyslac powiadomienia: ${String(error?.message || error)}`);
  }
}

function validate() {
  const baseUrl = $("baseUrl").value.trim();
  const email = $("email").value.trim();
  const token = $("token").value.trim();
  const dateFrom = $("dateFrom").value;
  const dateTo = $("dateTo").value;
  const project = $("project").value.trim() || null;
  projectFilterClause(project);

  if (!baseUrl || !email || !token) {
    openSettings(!baseUrl ? "baseUrl" : !email ? "email" : "token");
    throw new Error("Uzupełnij adres Jiry, email i API Token w Ustawieniach.");
  }
  if (!dateFrom || !dateTo) throw new Error("Uzupełnij daty.");
  if (dateFrom > dateTo) throw new Error("Date from nie może być później niż Date to.");

  return { baseUrl, email, token, dateFrom, dateTo, project };
}

async function saveLastResult(payload) {
  await chrome.storage.local.set({
    lastResult: payload,
    lastResultSavedAt: Date.now()
  });
}

async function loadLastResult() {
  return chrome.storage.local.get(["lastResult","lastResultSavedAt"]);
}

/**
 * Starsze wyniki w storage moga nie miec params. Bierzemy wtedy daty z formularza
 * (sa z tego samego zapisu), a nie skrajne daty wierszy - te ucinalyby zakres
 * na ostatnim dniu z worklogiem, czyli gubilyby wlasnie te dni, ktorych szukamy.
 */
function rangeOfLastResult(lastResult) {
  const { dateFrom, dateTo } = lastResult.params || {};
  if (dateFrom && dateTo) return { dateFrom, dateTo };

  const selected = currentRange();
  return selected.dateFrom && selected.dateTo ? selected : null;
}

async function restoreLastResultIfAny() {
  const { lastResult, lastResultSavedAt } = await loadLastResult();
  if (lastResult?.rows?.length || lastResult?.myIssues?.length) {
    state.fetchedSource = lastResult.params?.baseUrl && lastResult.params?.email ? {baseUrl:lastResult.params.baseUrl,email:lastResult.params.email} : null;
    state.lastFetchedAt = lastResultSavedAt || null;
    state.rows = lastResult.rows || [];
    state.myIssues = lastResult.myIssues || [];
    state.fetchedRange = rangeOfLastResult(lastResult);
    $("user").textContent = lastResult.displayName || "-";
    $("total").textContent = lastResult.totalHHMM || "00:00";
    state.hasData = true;
    renderAll();
    const when = lastResultSavedAt ? new Date(lastResultSavedAt).toLocaleString("pl-PL") : "";
    setStatus(`Wczytano ostatni wynik. ${when}`);
  }
}

async function onFetch({ force = true } = {}) {
  if (fetchInProgress) return;
  let fetchedSuccessfully = false;
  try {
    const params = validate();
    setFetchBusy(true);
    await saveSettings();

    // Keep the last result visible until a complete replacement arrives.
    // Clear it only when credentials point to a different Jira account.
    if(state.fetchedSource && aiScope(state.fetchedSource.baseUrl,state.fetchedSource.email)!==aiScope(params.baseUrl,params.email)){
      state.rows=[];state.myIssues=[];state.hasData=false;state.fetchedRange=null;
      $("user").textContent="-";$("total").textContent="00:00";renderAll();
    }
    setStatus(force?"Pobieram…":"Odświeżam…");

    setStatus("Pobieram worklogi i tickety...");
    const [{ displayName, rows, totalSeconds }, myIssues] = await Promise.all([
      fetchWorklogsRange(params),
      fetchMyIssues(params)
    ]);
    state.fetchedSource = {baseUrl:params.baseUrl,email:params.email};
    state.lastFetchedAt = Date.now();
    state.rows = rows;
    state.myIssues = myIssues;
    state.fetchedRange = { dateFrom: params.dateFrom, dateTo: params.dateTo };

    $("user").textContent = displayName;
    $("total").textContent = fmtHHMM(totalSeconds);
    state.hasData = true;
    renderAll();
    setStatus(`Gotowe. Rekordów: ${rows.length}`);

    // nie zapisuj tokenu w wyniku
    await saveLastResult({
      displayName,
      totalHHMM: fmtHHMM(totalSeconds),
      totalSeconds,
      rows,
      myIssues,
      params: { baseUrl: params.baseUrl, email: params.email, dateFrom: params.dateFrom, dateTo: params.dateTo, project: params.project }
    });

    fetchedSuccessfully = true;

  } catch (e) {
    console.error(e);
    setStatus("Błąd.");
    void showNotice(String(e?.message || e));
  } finally {
    setFetchBusy(false);
    if (fetchedSuccessfully) { localAI.schedule(); if ($("assistantTab").classList.contains("isActive")) void bartekAI.assess(); }
  }
}

function openEdit(row) {
  if (fetchInProgress) return;
  state.selected = row;
  $("editInfo").textContent =
    `Issue: ${row.issueKey}\nData: ${row.date}\nObecny czas: ${row.timeHHMM}\n`;
  $("newWorklogDate").value = row.date;
  $("newTime").value = row.timeHHMM;
  $("newComment").value = row.comment || "";
  $("editDlg").showModal();
  $("newTime").focus();
  $("newTime").select();
}

let issueSearchTimer;
let issueSearchVersion = 0;
let selectedAddIssue = null;
let assignedAddIssues = [];
let issuePickerMode="assigned";
let addWorklogPending=false;

const loggedTooltip = document.createElement("div");
loggedTooltip.id = "loggedTimeTooltip";
loggedTooltip.className = "loggedTimeTooltip";
loggedTooltip.setAttribute("popover", "manual");
loggedTooltip.setAttribute("role", "tooltip");
$("addWorklogDlg").append(loggedTooltip);

function hideLoggedTooltip() {
  if (loggedTooltip.matches(":popover-open")) loggedTooltip.hidePopover();
}

function attachLoggedTooltip(element, text) {
  element.setAttribute("aria-label", text);
  element.setAttribute("aria-describedby", loggedTooltip.id);
  element.tabIndex = 0;
  const show = () => {
    loggedTooltip.textContent = text;
    loggedTooltip.style.left = "0px";
    loggedTooltip.style.top = "0px";
    loggedTooltip.showPopover();
    const anchor = element.getBoundingClientRect();
    const bubble = loggedTooltip.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.right - bubble.width, window.innerWidth - bubble.width - 8));
    const top = anchor.top - bubble.height - 8;
    loggedTooltip.style.left = `${left}px`;
    loggedTooltip.style.top = `${top >= 8 ? top : Math.min(anchor.bottom + 8, window.innerHeight - bubble.height - 8)}px`;
  };
  element.addEventListener("pointerenter", show);
  element.addEventListener("pointerleave", hideLoggedTooltip);
  element.addEventListener("focus", show);
  element.addEventListener("blur", hideLoggedTooltip);
  element.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideLoggedTooltip();
      event.preventDefault();
      event.stopPropagation();
    }
  });
}

$("addWorklogDlg").addEventListener("close", hideLoggedTooltip);
document.addEventListener("scroll", hideLoggedTooltip, true);

function issueLoggedSummary(issueKey) {
  if (!state.hasData || !state.fetchedRange) return { time: "--:--", tooltip: "Pobierz worklogi, aby zobaczyc sume" };
  const rows = state.rows.filter((row) => row.issueKey.toUpperCase() === issueKey.toUpperCase());
  const seconds = rows.reduce((sum, row) => sum + Number(row.seconds || 0), 0);
  return { time: fmtHHMM(seconds), tooltip: `Zalogowano: ${fmtHHMM(seconds)} · Wpisy: ${rows.length} · ${fmtRange(state.fetchedRange)}` };
}

function showIssuePreview(issue) {
  hideLoggedTooltip();
  selectedAddIssue = issue;
  $("addWorklogInfo").replaceChildren();
  const key = document.createElement("strong");
  key.innerHTML = ticketLink(issue.issueKey);
  const summary = document.createElement("p");
  summary.textContent = issue.summary || "Brak opisu";
  const status = document.createElement("span");
  status.textContent = issue.status || "";
  const logged = document.createElement("p");
  logged.className = "issueLoggedTime";
  const loggedSummary = issueLoggedSummary(issue.issueKey);
  logged.textContent = loggedSummary.time;
  attachLoggedTooltip(logged, loggedSummary.tooltip);
  const epic = document.createElement("p");
  if (issue.epic) { epic.append("Epic: "); const link = document.createElement("span"); link.innerHTML = ticketLink(issue.epic.key); epic.append(link, ` ${issue.epic.summary}`); }
  $("addWorklogInfo").append(epic, key, summary, status, logged);
}

function chooseAddIssue(issue) {
  clearTimeout(issueSearchTimer);
  issueSearchVersion += 1;
  $("addIssueKey").value = issue.issueKey;
  for(const result of $("issueSearchResults").querySelectorAll('button'))result.setAttribute('aria-pressed',String(result.dataset.issueKey===issue.issueKey));
  showIssuePreview(issue);
}

async function searchAddIssue() {
  hideLoggedTooltip();
  const version = ++issueSearchVersion;
  selectedAddIssue = null;
  const query = $("addIssueKey").value.trim();
  const host = $("issueSearchResults");
  host.replaceChildren();
  $("addWorklogInfo").textContent = query ? "Wybierz ticket z listy lub wpisz pelny klucz." : "Wyszukaj ticket, do ktorego dodasz czas.";
  const known = new Map([...state.pinnedIssues, ...buildMyIssues(), ...assignedAddIssues].map((issue) => [issue.issueKey, issue]));
  let matches = [...known.values()].filter((issue) =>
    `${issue.issueKey} ${issue.summary}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  ).slice(0, 8);
  const renderMatches = () => {
    host.replaceChildren();
    const title=document.createElement('h3');title.className='issueResultsHeading';title.textContent=query?'Wyniki wyszukiwania':issuePickerMode==='assigned'?'Przypisane do mnie':issuePickerMode==='recent'?'Ostatnio używane':'Stałe tickety';host.append(title);
    for (const group of groupByEpic(matches)) {
      const epic = group[0].epic;
      const heading = document.createElement("div");
      heading.className = "issueResultEpic";
      heading.innerHTML = `${epicIcon}<span>Epic</span><b>${escapeHtml(epic?.key || "Brak")}</b> <span class="issueEpicSummary">${escapeHtml(epic?.summary || "")}</span>`;
      host.append(heading);
      for (const issue of group) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "issueSearchResult";
      button.dataset.issueKey=issue.issueKey;
      button.setAttribute("aria-pressed","false");
      const key = document.createElement("strong");
      key.innerHTML = `${issueTypeIcon(issue.issueType)}${escapeHtml(issue.issueKey)}`;
      const label = document.createElement("span");
      label.textContent = issue.summary || "Brak opisu";
      const status = document.createElement("small");
      status.textContent = issue.status || "";
      const logged = document.createElement("small");
      logged.className = "issueLoggedTime";
      const loggedSummary = issueLoggedSummary(issue.issueKey);
      logged.textContent = loggedSummary.time;
      attachLoggedTooltip(logged, loggedSummary.tooltip);
      button.append(key, label, status, logged);
      button.addEventListener("click", () => chooseAddIssue(issue));
      host.append(button);
      }
    }
  };
  if(!query&&issuePickerMode!=='assigned'){
    const latest=new Map();for(const row of state.rows)if((row.started||row.date)>(latest.get(row.issueKey)||''))latest.set(row.issueKey,row.started||row.date);
    matches=(issuePickerMode==='pinned'?state.pinnedIssues:aggregateIssues(state.rows).sort((a,b)=>(latest.get(b.issueKey)||'').localeCompare(latest.get(a.issueKey)||''))).filter(issue=>!isDoneStatus(issue.status)).slice(0,30);renderMatches();
    $('addWorklogInfo').textContent=matches.length?'Wybierz ticket, do którego dodasz czas.':'Brak ticketów w tej grupie. Wpisz klucz w wyszukiwarce.';return;
  }
  if (!query) {
    $("addWorklogInfo").textContent = "Pobieram tickety przypisane do Ciebie…";
    try {
      matches = await fetchAssignedIssues({
        baseUrl: $("baseUrl").value.trim(), email: $("email").value.trim(), token: $("token").value
      });
      if (version !== issueSearchVersion || !$("addWorklogDlg").open) return;
      assignedAddIssues = matches;
      renderMatches();
      $("addWorklogInfo").textContent = matches.length
        ? "Przypisane do Ciebie · wybierz ticket lub wyszukaj inny."
        : "Brak aktywnych ticketow przypisanych do Ciebie. Wyszukaj inny ticket.";
    } catch {
      if (version !== issueSearchVersion || !$("addWorklogDlg").open) return;
      $("addWorklogInfo").textContent = "Nie udalo sie pobrac przypisanych ticketow. Mozesz nadal wyszukac ticket.";
    }
    return;
  }
  renderMatches();
  const exact = known.get(query.toUpperCase());
  if (exact) { showIssuePreview(exact); return; }
  if (!/^[A-Z][A-Z0-9_]*-\d+$/i.test(query)) {
    if (!matches.length) host.textContent = "Brak dopasowan w pobranych ticketach. Podaj pelny klucz, np. ABC-123.";
    return;
  }
  $("addWorklogInfo").textContent = "Sprawdzam ticket w Jira…";
  try {
    const issue = await fetchIssuePreview({
      baseUrl: $("baseUrl").value.trim(), email: $("email").value.trim(),
      token: $("token").value, issueKey: query.toUpperCase()
    });
    if (version !== issueSearchVersion || !$("addWorklogDlg").open) return;
    matches.unshift(issue);
    renderMatches();
    showIssuePreview(issue);
  } catch {
    if (version === issueSearchVersion) $("addWorklogInfo").textContent = "Nie udalo sie znalezc ticketu. Sprawdz klucz, polaczenie i uprawnienia.";
  }
}

$('issuePickerTabs').addEventListener('click',event=>{
  const button=event.target.closest('[data-issue-mode]');if(!button)return;
  issuePickerMode=button.dataset.issueMode;for(const tab of $('issuePickerTabs').querySelectorAll('button'))tab.setAttribute('aria-pressed',String(tab===button));
  clearTimeout(issueSearchTimer);$('addIssueKey').value='';void searchAddIssue();
});

$("addIssueKey").addEventListener("input", () => {
  hideLoggedTooltip();
  clearTimeout(issueSearchTimer);
  issueSearchVersion += 1;
  selectedAddIssue = null;
  $("issueSearchResults").replaceChildren();
  $("addWorklogInfo").textContent = "Wyszukiwanie…";
  issueSearchTimer = setTimeout(() => { void searchAddIssue(); }, 300);
});
$("addIssueKey").addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    $("issueSearchResults").querySelector("button")?.focus();
    event.preventDefault();
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const first = $("issueSearchResults").querySelector("button");
    if (first) first.click();
    else { clearTimeout(issueSearchTimer); void searchAddIssue(); }
  }
});
$("addWorklogDlg").addEventListener("cancel",event=>{if(addWorklogPending)event.preventDefault();});
$("addWorklogDlg").addEventListener("close", () => {
  worklogProposals.cancel();
  clearTimeout(issueSearchTimer);
  issueSearchVersion += 1;
});

function openAddWorklog(issueKey, summary = "", status = "", { date, timeHHMM, comment = "" } = {}) {
  if (fetchInProgress) return;
  worklogProposals.cancel();
  if (isDoneStatus(status)) {
    void showNotice(`Nie mozna dodac workloga do ${issueKey}, bo ticket jest DONE.`);
    return;
  }
  $("addWorklogInfo").textContent = `Issue: ${issueKey || "(podaj klucz)"}\n${summary || ""}`;
  $("addIssueKey").value = issueKey;
  $("addWorklogDate").value = date || $("dateTo").value || iso(new Date());
  $("addWorklogTime").value = timeHHMM || "01:00";
  $("addWorklogComment").value = comment;
  assignedAddIssues = [];
  issuePickerMode="assigned";for(const tab of $("issuePickerTabs").querySelectorAll("button"))tab.setAttribute("aria-pressed",String(tab.dataset.issueMode==="assigned"));
  $("addWorklogDlg").showModal();
  clearTimeout(issueSearchTimer);
  void searchAddIssue();
  const focusTarget = issueKey ? $("addWorklogTime") : $("addIssueKey");
  focusTarget.focus();
  focusTarget.select();
}

async function onSaveEdit(e) {
  e.preventDefault();
  if (fetchInProgress) return;
  try {
    const row = state.selected;
    if (!row) return;

    const params = validate();
    const newSeconds = parseHHMM($("newTime").value);
    const newComment = $("newComment").value.trim();
    const newDate = $("newWorklogDate").value;
    const newStarted = worklogStartedOnDate(row.started, newDate);
    if (newDate === row.date && newSeconds === row.seconds && newComment === (row.comment || "")) {
      $("editDlg").close();
      return;
    }

    setStatus("Zapisuję zmianę…");
    await updateWorklog({
      baseUrl: params.baseUrl,
      email: params.email,
      token: params.token,
      issueKey: row.issueKey,
      worklogId: row.worklogId,
      started: newStarted,
      newSeconds,
      comment: newComment
    });

    $("editDlg").close();
    await onFetch({ force: false });
    void showNotice(`Worklog zaktualizowany: ${row.date} → ${newDate}, ${row.timeHHMM} → ${fmtHHMM(newSeconds)}${state.fetchedRange && (newDate < state.fetchedRange.dateFrom || newDate > state.fetchedRange.dateTo) ? "\nWpis jest teraz poza wyswietlanym zakresem dat." : ""}`);
  } catch (err) {
    console.error(err);
    void showNotice(String(err?.message || err));
  }
}

async function onAddWorklog(e) {
  e.preventDefault();
  if (fetchInProgress||addWorklogPending) return;
  try {
    const params = validate();
    const issueKey = $("addIssueKey").value.trim().toUpperCase();
    const date = $("addWorklogDate").value;
    const timeHHMM = $("addWorklogTime").value.trim();
    const comment = $("addWorklogComment").value.trim();

    if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(issueKey)) throw new Error("Wybierz ticket z listy lub podaj pelny klucz, np. ABC-123.");
    const knownIssue = selectedAddIssue?.issueKey === issueKey ? selectedAddIssue : findKnownIssue(issueKey);
    if (knownIssue && isDoneStatus(knownIssue.status)) {
      throw new Error(`Nie mozna dodac workloga do ${issueKey}, bo ticket jest DONE.`);
    }
    if (!date) throw new Error("Podaj date.");
    parseHHMM(timeHHMM);

    setStatus("Zapisuję nowy wpis…");
    addWorklogPending=true;
    $("addWorklogSaveBtn").disabled=true;$("addWorklogSaveBtn").textContent="Zapisuję…";
    $("drawerClose").disabled=true;$("addWorklogDlg").querySelector('button[value="cancel"]').disabled=true;
    await addWorklog({
      baseUrl: params.baseUrl,
      email: params.email,
      token: params.token,
      issueKey,
      date,
      timeHHMM,
      comment
    });

    $("addWorklogDlg").close();
    workspaceUX.reveal(date);
    workspaceUX.rememberDate(date);
    if(date>iso(new Date()))revealedFutureDays.add(date);
    await onFetch({ force: false });
    workspaceUX.notify(`Dodano ${timeHHMM} do ${issueKey}${date<params.dateFrom||date>params.dateTo?' · wpis poza wybranym okresem':''}`);
  } catch (err) {
    console.error(err);
    setStatus("Blad.");
    void showNotice(String(err?.message || err));
  } finally {
    addWorklogPending=false;$("addWorklogSaveBtn").disabled=fetchInProgress;$("addWorklogSaveBtn").textContent="Dodaj wpis";$("drawerClose").disabled=false;$("addWorklogDlg").querySelector('button[value="cancel"]').disabled=false;
  }
}

function setActiveTab(tabName) {
  const legacy=["worklogs","workedIssues","pinnedIssues","reminders"].includes(tabName)?tabName:null;
  if(legacy)tabName="settings";
  document.body.dataset.activeTab=tabName;
  if (tabName === "assistant") {
    setBartekOpen(false);
    void bartekAI.assess();
  }
  document.querySelectorAll(".tabBtn").forEach((button) => {
    button.classList.toggle("isActive", button.dataset.tab === tabName);
  });
  document.querySelectorAll(".tabView").forEach((view) => {
    view.classList.toggle("isActive", view.id === `${tabName}Tab`);
  });
  if(legacy)workspaceUX.openLegacy(legacy);
}

$("fetchBtn").addEventListener("click", () => onFetch({ force: true }));
$("refreshBtn").addEventListener("click", () => onFetch({ force: false }));
$("saveBtn").addEventListener("click", onSaveEdit);
$("addWorklogSaveBtn").addEventListener("click", onAddWorklog);
$("addPinnedIssueBtn").addEventListener("click", () => {
  void addPinnedIssue();
});
$("meetingsSaveBtn").addEventListener("click", onSubmitMeetings);
$("meetingIssueKey").addEventListener("change", () => {
  const issueKey = $("meetingIssueKey").value.trim().toUpperCase();
  $("meetingIssueKey").value = issueKey;
  // Zapis od razu, bez czekania na "Pobierz" - to pole ustawia sie raz i ma zostac.
  void chrome.storage.sync.set({ meetingIssueKey: issueKey });
  renderDays();
});
$("reminderTestBtn").addEventListener("click", () => {
  void runReminderCheckNow();
});
$("reminderEnabled").addEventListener("change", (event) => {
  void updateReminderSettings({ reminderEnabled: event.target.checked });
});
$("reminderRespectHolidays").addEventListener("change", (event) => {
  void updateReminderSettings({ reminderRespectHolidays: event.target.checked });
});
$("reminderHour").addEventListener("change", (event) => {
  void updateReminderSettings({ reminderHour: clampNumber(event.target.value, 0, 23) });
});
$("reminderLeadDays").addEventListener("change", (event) => {
  void updateReminderSettings({ reminderLeadDays: clampNumber(event.target.value, 0, 10) });
});
$("saveWeeklyHours").addEventListener("click", async () => {
  const weeklyHours = Array(7).fill(0);
  for (const input of document.querySelectorAll("[data-weekday-hours]")) {
    const value = Number(input.value);
    if (!input.value.trim() || !Number.isFinite(value) || value < 0 || value > 24) {
      void showNotice("Podaj od 0 do 24 godzin dla kazdego dnia. 0 oznacza dzien wolny."); return;
    }
    weeklyHours[Number(input.dataset.weekdayHours)] = value;
  }
  try {
    await saveReminderSettings({weeklyHours});
    state.reminder.weeklyHours = weeklyHours;
    applyReminderSettingsToForm();
    renderAll();
    void showNotice("Zapisano tygodniowy harmonogram pracy.");
  } catch { void showNotice("Nie udalo sie zapisac harmonogramu."); }
});

$("dailyTargetHours").addEventListener("change", (event) => {
  const parsed = Number(event.target.value);
  const hours = Number.isFinite(parsed) && parsed > 0 ? Math.min(24, parsed) : REMINDER_DEFAULTS.dailyTargetHours;
  void updateReminderSettings({ dailyTargetHours: hours, weeklyHours: normalizeWeeklyHours(state.reminder.weeklyHours).map(value => value > 0 ? hours : 0) });
});
$("dateFrom").addEventListener("change", renderRangeNotice);
$("dateTo").addEventListener("change", renderRangeNotice);
document.querySelectorAll(".tabBtn").forEach((button) => {
  button.addEventListener("click", () => setActiveTab(button.dataset.tab));
});
function openSettings(focusId) {
  setActiveTab("settings");
  if (focusId) $(focusId).focus();
}

for (const id of ["dailyIssueKey", "planningIssueKey"]) $(id).addEventListener("change", () => { $(id).value = $(id).value.trim().toUpperCase(); renderAll(); });

for (const id of ["baseUrl", "email", "token", "project", "meetingIssueKey", "dailyIssueKey", "planningIssueKey"]) {
  $(id).addEventListener("change", async () => {
    try {
      await saveSettings();
    } catch (error) {
      void showNotice(`Nie udalo sie zapisac ustawien: ${error?.message || error}`);
    }
  });
}

$("refreshOnReload").addEventListener("change", async (event) => {
  const enabled = event.target.checked;
  try {
    await chrome.storage.sync.set({ refreshOnReload: enabled });
  } catch (error) {
    $("refreshOnReload").checked = !enabled;
    void showNotice(`Nie udalo sie zapisac ustawienia: ${error?.message || error}`);
  }
});

// Preserve the selected range before keyboard reload, including unsaved changes.
document.addEventListener("keydown", async (event) => {
  const reloadKey = event.key === "F5" ||
    ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r");
  if (!reloadKey || !$("refreshOnReload").checked) return;
  event.preventDefault();
  if (event.repeat) return;
  try {
    await saveSettings();
    location.reload();
  } catch (error) {
    void showNotice(`Nie udalo sie zapisac zakresu przed odswiezeniem: ${error?.message || error}`);
  }
});

// Avoid replacing a day while its private note is being edited.
function renderLocalAIDays() {
  const focused = document.activeElement;
  if ($("daysList").contains(focused) && focused?.matches("input,textarea")) return;
  renderDays();
  syncFetchControls();
}
$("daysList").addEventListener("focusout", () => {
  setTimeout(() => {
    if (!$("daysList").contains(document.activeElement)) renderLocalAIDays();
  }, 0);
});
installBitbucketSettings(showNotice);
const localAI = installLocalAI({getState:() => state,isFetching:() => fetchInProgress,renderDays:renderLocalAIDays,showNotice});
const bartekScope = () => {
  try { return aiScope($("baseUrl").value.trim(), $("email").value.trim()); }
  catch { return ""; }
};
const bartekAI = installBartekAI({
  getSettings: () => localAI.getSettings(), getScope: bartekScope, isFetching: () => fetchInProgress,
  getContext: () => {
    const summary=currentSummary();
    const report=assistantReport(summary,iso(new Date()),{
      dailyTargetHours:state.reminder.dailyTargetHours,weeklyHours:state.reminder.weeklyHours,
      vacationDates:state.reminder.vacationDates,respectHolidays:state.reminder.reminderRespectHolidays,monthlyTargets:state.monthlyTargets
    });
    if(state.fetchedSource && bartekScope()!==aiScope(state.fetchedSource.baseUrl,state.fetchedSource.email)) return null;
    return buildBartekAIContext({state,summary,report,scope:bartekScope()});
  }
});
for (const id of ["baseUrl", "email", "token"]) $(id).addEventListener("change", () => {bartekAI.cancel();bartekAI.refresh();});


const worklogProposals=installWorklogProposals({
  getState:()=>state,getSummary:currentSummary,getSettings:()=>localAI.getSettings(),
  getCredentials:()=>({baseUrl:$("baseUrl").value.trim(),email:$("email").value.trim(),token:$("token").value}),
  isFetching:()=>fetchInProgress,openWorklog:openAddWorklog,showNotice
});
for(const id of ["baseUrl","email","token"])$(id).addEventListener("change",()=>worklogProposals.cancel());

const teamView = installTeamView({ getParams: validate, getSchedule: () => state.reminder });

const workspaceUX=installWorkspaceUX({renderDays,openWorklog:openAddWorklog,openTab:setActiveTab,propose:date=>worklogProposals.propose(date),isBusy:()=>fetchInProgress,getMonthlyTargets:()=>state.monthlyTargets,getWorkSchedule:()=>state.reminder});
document.body.dataset.activeTab='days';
// start
await loadSettings();
await teamView.restore();
await localAI.load();
renderPinnedIssues();
renderAll();
await restoreLastResultIfAny();
localAI.schedule();
if ($("refreshOnReload").checked &&
    performance.getEntriesByType("navigation")[0]?.type === "reload") {
  if ($("baseUrl").value.trim() && $("email").value.trim() && $("token").value) {
    await onFetch({ force: false });
  } else {
    setStatus("Uzupelnij polaczenie z Jira, aby pobierac dane po F5.");
  }
}

installBartekEasterEgg();

