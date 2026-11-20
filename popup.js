import { formatDateRange } from './date-range.js';
import { fmtHHMM } from './api.js';
import { totalOvertime } from './time-metrics.js';
import { normalizeTheme, cacheTheme } from './theme-settings.js';
import { loadReminderSettings, isReminderSettingKey, analyzeCompletion } from "./reminders.js";

async function renderLastSummary() {
  const host = document.getElementById("lastSummary");
  try {
    const [{ lastResult, lastResultSavedAt }, settings] = await Promise.all([
      chrome.storage.local.get(["lastResult", "lastResultSavedAt"]),
      loadReminderSettings()
    ]);
    const element=(tag,text,className)=>{const node=document.createElement(tag);node.textContent=text;if(className)node.className=className;return node;};
    if(!lastResult||!Array.isArray(lastResult.rows)){
      host.replaceChildren(element('p','Brak pobranych danych.','popupEmpty'),element('p','Otwórz worklogi, aby połączyć Jirę i pobrać czas.','hint'));return;
    }
    const {dateFrom,dateTo,project}=lastResult.params||{};
    const summary=dateFrom&&dateTo&&dateFrom<=dateTo?analyzeCompletion({rows:lastResult.rows,dateFrom,dateTo,dailyTargetHours:settings.dailyTargetHours,weeklyHours:settings.weeklyHours,respectHolidays:settings.reminderRespectHolidays,vacationDates:settings.vacationDates}):null;
    const period=element('p',summary?formatDateRange({dateFrom,dateTo}):'Ostatnie dane','popupPeriod');
    const hours=element('div','','popupHours');
    const logged=lastResult.rows.reduce((sum,row)=>sum+Number(row.seconds||0),0);
    for(const [label,value,style] of [['Zadeklarowane',fmtHHMM(logged),'popupDeclared'],['Nadgodziny',summary?`${totalOvertime(summary.days,settings)?'+':''}${fmtHHMM(totalOvertime(summary.days,settings))}`:'—','popupOvertime']]){
      const metric=element('div','',style);metric.append(element('span',label),element('strong',value));hours.append(metric);
    }
    const status=element('p',summary?(summary.missingDays.length?`Dni do uzupełnienia: ${summary.missingDays.length}`:'Dotychczasowe dni uzupełnione'):'','popupCompletion');
    status.classList.toggle('hasMissing',!!summary?.missingDays.length);
    const details=element('details','','popupDetails');details.append(element('summary','Szczegóły'));
    if(project)details.append(element('p',`Projekty: ${project.split(',').map(key=>key.trim()).join(', ')}`));
    details.append(element('p',`Wpisy: ${lastResult.rows.length}`));
    details.append(element('p','Nadgodziny: suma czasu ponad dzienne limity.'));
    if(lastResultSavedAt)details.append(element('p',`Pobrano: ${new Date(lastResultSavedAt).toLocaleString('pl-PL',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}`));
    host.replaceChildren(period,hours,status,details);
  } catch (error) {
    host.textContent = "Nie udalo sie wczytac ostatniego wyniku. Otworz karte rozszerzenia.";
    console.warn(error);
  }
}

function applyTheme(value) {
  const theme = normalizeTheme(value);
  document.body.dataset.theme = theme;
  cacheTheme(theme);
}

async function loadTheme() {
  try {
    const { theme } = await chrome.storage.sync.get("theme");
    applyTheme(theme);
  } catch (error) {
    console.warn(error);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.theme) applyTheme(changes.theme.newValue);
  if ((area === "local" && (changes.lastResult || changes.lastResultSavedAt)) ||
      (area === "sync" && Object.keys(changes).some(isReminderSettingKey))) {
    void renderLastSummary();
  }
});
void loadTheme();
void renderLastSummary();

document.getElementById("openBtn").addEventListener("click", async () => {
  const url = chrome.runtime.getURL("page.html");
  await chrome.tabs.create({ url });
});
