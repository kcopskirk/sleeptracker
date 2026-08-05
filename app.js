(() => {
  "use strict";

  const STORAGE_KEY = "sleepmonitor_v1";
  const PRE_START_MIN = 21 * 60 + 30;
  const MORNING_START_MIN = 3 * 60;
  const WAKE_REASONS = [
    "上厕所",
    "热或冷",
    "口渴",
    "噪音",
    "做梦或噩梦",
    "不知原因",
    "其他",
  ];

  /** @type {{ nights: Record<string, any>, reports: Record<string, any> }} */
  let db = loadDb();

  /** @type {'log' | 'report'} */
  let currentView = "log";
  /** @type {'aset' | 'bset'} */
  let formMode = "aset";
  /** @type {string | null} */
  let formNightId = null;
  /** @type {string | null} selected week monday key for report */
  let reportWeekKey = null;

  const CLOCK_KEY = "sleepmonitor_clock";
  const DEBUG_KEY = "sleepmonitor_debug";
  const urlParams = new URLSearchParams(location.search);
  /** @type {number | null} */
  let clockOverrideMs = readInitialClock();
  let debugEnabled =
    urlParams.has("debug") || sessionStorage.getItem(DEBUG_KEY) === "1";
  if (urlParams.has("debug")) sessionStorage.setItem(DEBUG_KEY, "1");

  const elLog = document.getElementById("view-log");
  const elReport = document.getElementById("view-report");
  const elContext = document.getElementById("context-line");
  const elToast = document.getElementById("toast");

  // ---------- clock / debug ----------

  function readInitialClock() {
    const q = urlParams.get("now");
    if (q) {
      const t = Date.parse(q);
      if (!Number.isNaN(t)) {
        sessionStorage.setItem(CLOCK_KEY, String(t));
        return t;
      }
    }
    const stored = sessionStorage.getItem(CLOCK_KEY);
    if (stored) {
      const t = Number(stored);
      if (!Number.isNaN(t)) return t;
    }
    return null;
  }

  function now() {
    return clockOverrideMs != null ? new Date(clockOverrideMs) : new Date();
  }

  function setClock(date) {
    clockOverrideMs = date.getTime();
    sessionStorage.setItem(CLOCK_KEY, String(clockOverrideMs));
  }

  function clearClock() {
    clockOverrideMs = null;
    sessionStorage.removeItem(CLOCK_KEY);
  }

  function toDatetimeLocalValue(d) {
    return `${dateKey(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function seedDemoWeek() {
    const t = now();
    const mon = weekMondayKey(nightIdForNow(t));
    const seedMon = addDaysKey(mon, -7);
    const patterns = [
      { exercised: true, exerciseMinutes: 40, napped: false, acTemp: 25, sleepEase: 8, nightWaking: false, sleepScore: 8 },
      { exercised: false, exerciseMinutes: 0, napped: true, napMinutes: 40, acTemp: 27, sleepEase: 4, nightWaking: true, wakeReasons: ["上厕所"], reSleepEase: 5, sleepScore: 5 },
      { exercised: true, exerciseMinutes: 25, napped: false, acTemp: 24, sleepEase: 7, nightWaking: false, sleepScore: 7 },
      { exercised: false, exerciseMinutes: 0, napped: false, acTemp: 26, sleepEase: 5, nightWaking: true, wakeReasons: ["热或冷", "口渴"], reSleepEase: 3, sleepScore: 4 },
      { exercised: true, exerciseMinutes: 60, napped: false, acTemp: 25, sleepEase: 9, nightWaking: false, sleepScore: 9 },
      { exercised: false, exerciseMinutes: 0, napped: true, napMinutes: 20, acTemp: 28, sleepEase: 3, nightWaking: true, wakeReasons: ["噪音"], reSleepEase: 4, sleepScore: 5 },
      { exercised: true, exerciseMinutes: 30, napped: false, acTemp: 25, sleepEase: 7, nightWaking: false, sleepScore: 8 },
    ];

    for (let i = 0; i < 7; i++) {
      const nightKey = addDaysKey(seedMon, i);
      const p = patterns[i];
      const mealHour = 19 + (i % 3);
      db.nights[nightKey] = {
        aset: {
          exercised: p.exercised,
          exerciseMinutes: p.exerciseMinutes || 0,
          napped: p.napped,
          napMinutes: p.napMinutes || 0,
          lastMeal: `${pad2(mealHour)}:30`,
          acTemp: p.acTemp,
          bedtime: "23:15",
          updatedAt: now().toISOString(),
        },
        bset: {
          wakeTime: "07:10",
          sleepEase: p.sleepEase,
          nightWaking: !!p.nightWaking,
          wakeReasons: p.wakeReasons || [],
          otherReason: "",
          reSleepEase: p.nightWaking ? p.reSleepEase : null,
          sleepScore: p.sleepScore,
          updatedAt: now().toISOString(),
        },
      };
      delete db.reports[seedMon];
    }
    saveDb();
    const lockView = atLocal(addDaysKey(seedMon, 7), 22, 0);
    setClock(lockView);
    reportWeekKey = seedMon;
    ensureLockedSnapshots(now());
    toast(`已写入演示周 ${formatWeekRange(seedMon)}，时钟跳到周锁后`);
    setView("report");
  }

  function mountDebugPanel() {
    if (!debugEnabled) return;
    let panel = document.getElementById("debug-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "debug-panel";
      panel.className = "debug-panel";
      document.body.appendChild(panel);
    }
    const t = now();
    panel.innerHTML = `
      <div class="debug-title">调试模式</div>
      <p class="debug-line">伪造时间：${clockOverrideMs == null ? "关（真机时间）" : toDatetimeLocalValue(t)}</p>
      <label class="debug-label">跳到
        <input type="datetime-local" id="debug-now" value="${toDatetimeLocalValue(t)}" />
      </label>
      <div class="debug-actions">
        <button type="button" class="btn btn-ghost" id="dbg-apply">应用时间</button>
        <button type="button" class="btn btn-ghost" id="dbg-aset">今晚睡前 22:00</button>
        <button type="button" class="btn btn-ghost" id="dbg-bset">今早起床后 10:00</button>
        <button type="button" class="btn btn-ghost" id="dbg-plus1">+1 天</button>
        <button type="button" class="btn btn-ghost" id="dbg-seed">灌入上周演示数据</button>
        <button type="button" class="btn btn-ghost" id="dbg-clear-clock">恢复真机时间</button>
        <button type="button" class="btn btn-ghost" id="dbg-wipe">清空全部数据</button>
      </div>
      <p class="hint">URL 也可：?debug=1&now=2026-08-05T22:00</p>
    `;
    panel.querySelector("#dbg-apply").onclick = () => {
      const v = panel.querySelector("#debug-now").value;
      if (!v) return;
      setClock(new Date(v));
      remountAfterClockChange();
    };
    panel.querySelector("#dbg-aset").onclick = () => {
      const d = now();
      setClock(atLocal(dateKey(d), 22, 0));
      remountAfterClockChange();
    };
    panel.querySelector("#dbg-bset").onclick = () => {
      const d = now();
      setClock(atLocal(dateKey(d), 10, 0));
      remountAfterClockChange();
    };
    panel.querySelector("#dbg-plus1").onclick = () => {
      const d = now();
      d.setDate(d.getDate() + 1);
      setClock(d);
      remountAfterClockChange();
    };
    panel.querySelector("#dbg-seed").onclick = () => seedDemoWeek();
    panel.querySelector("#dbg-clear-clock").onclick = () => {
      clearClock();
      remountAfterClockChange();
    };
    panel.querySelector("#dbg-wipe").onclick = () => {
      if (!confirm("清空本地全部睡眠数据？")) return;
      db = { nights: {}, reports: {} };
      saveDb();
      toast("已清空");
      remountAfterClockChange();
    };
  }

  function remountAfterClockChange() {
    ensureLockedSnapshots(now());
    const d = resolveDefaultForm(now());
    formMode = d.mode;
    formNightId = d.nightKey;
    applyTheme();
    mountDebugPanel();
    render();
  }

  // ---------- time helpers ----------

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function dateKey(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function parseDateKey(key) {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0);
  }

  function addDaysKey(key, days) {
    const d = parseDateKey(key);
    d.setDate(d.getDate() + days);
    return dateKey(d);
  }

  function atLocal(key, h, min) {
    const d = parseDateKey(key);
    d.setHours(h, min, 0, 0);
    return d;
  }

  function minutesOf(date) {
    return date.getHours() * 60 + date.getMinutes();
  }

  function nightIdForNow(t = now()) {
    const today = dateKey(t);
    return minutesOf(t) >= PRE_START_MIN ? today : addDaysKey(today, -1);
  }

  function inAsetSenseWindow(t = now()) {
    const m = minutesOf(t);
    return m >= PRE_START_MIN || m < MORNING_START_MIN;
  }

  function weekMondayKey(nightKey) {
    const d = parseDateKey(nightKey);
    const day = d.getDay();
    const offset = day === 0 ? 6 : day - 1;
    d.setDate(d.getDate() - offset);
    return dateKey(d);
  }

  function weekLockAt(mondayKey) {
    return atLocal(addDaysKey(mondayKey, 7), 21, 30);
  }

  function isWeekLocked(nightKey, t = now()) {
    return t.getTime() >= weekLockAt(weekMondayKey(nightKey)).getTime();
  }

  function canWriteAset(nightKey, t = now()) {
    if (isWeekLocked(nightKey, t)) return false;
    const start = atLocal(nightKey, 21, 30);
    const end = atLocal(addDaysKey(nightKey, 1), 21, 30);
    const ms = t.getTime();
    return ms >= start.getTime() && ms < end.getTime();
  }

  function canWriteBset(nightKey, t = now()) {
    if (isWeekLocked(nightKey, t)) return false;
    const start = atLocal(addDaysKey(nightKey, 1), 3, 0);
    const end = atLocal(addDaysKey(nightKey, 1), 21, 30);
    const ms = t.getTime();
    return ms >= start.getTime() && ms < end.getTime();
  }

  function formatNightLabel(nightKey) {
    const d = parseDateKey(nightKey);
    return `${d.getMonth() + 1}/${d.getDate()} 夜`;
  }

  function formatWeekRange(mondayKey) {
    const sun = parseDateKey(addDaysKey(mondayKey, 6));
    const mon = parseDateKey(mondayKey);
    return `${mon.getMonth() + 1}/${mon.getDate()} – ${sun.getMonth() + 1}/${sun.getDate()}`;
  }

  function roundTimeTo5(date = now()) {
    const d = new Date(date);
    const m = d.getMinutes();
    const rounded = Math.round(m / 5) * 5;
    d.setMinutes(rounded, 0, 0);
    if (rounded === 60) {
      d.setHours(d.getHours() + 1);
      d.setMinutes(0);
    }
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function parseTimeOnDay(dayKey, hhmm) {
    if (!hhmm) return null;
    const [h, m] = hhmm.split(":").map(Number);
    return atLocal(dayKey, h, m);
  }

  /** Bedtime on night D; wake may be next calendar day */
  function bedWakeDates(nightKey, bedtime, wakeTime) {
    if (!bedtime || !wakeTime) return null;
    const bed = parseTimeOnDay(nightKey, bedtime);
    let wake = parseTimeOnDay(nightKey, wakeTime);
    if (!bed || !wake) return null;
    if (wake.getTime() <= bed.getTime()) {
      wake = parseTimeOnDay(addDaysKey(nightKey, 1), wakeTime);
    }
    return { bed, wake };
  }

  function hoursBetween(a, b) {
    return (b.getTime() - a.getTime()) / 36e5;
  }

  function formatHours(h) {
    if (h == null || Number.isNaN(h)) return "—";
    const totalMin = Math.round(h * 60);
    const hr = Math.floor(totalMin / 60);
    const min = totalMin % 60;
    if (hr === 0) return `${min} 分钟`;
    if (min === 0) return `${hr} 小时`;
    return `${hr} 小时 ${min} 分`;
  }

  // ---------- storage ----------

  function loadDb() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { nights: {}, reports: {} };
      const parsed = JSON.parse(raw);
      return {
        nights: parsed.nights || {},
        reports: parsed.reports || {},
      };
    } catch {
      return { nights: {}, reports: {} };
    }
  }

  function saveDb() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  }

  function getNight(nightKey) {
    return db.nights[nightKey] || null;
  }

  function ensureNight(nightKey) {
    if (!db.nights[nightKey]) db.nights[nightKey] = {};
    return db.nights[nightKey];
  }

  function ensureLockedSnapshots(t = now()) {
    const currentNight = nightIdForNow(t);
    const currentMon = weekMondayKey(currentNight);
    const keys = new Set([
      ...Object.keys(db.nights).map(weekMondayKey),
      ...Object.keys(db.reports),
      currentMon,
      addDaysKey(currentMon, -7),
    ]);
    for (const mon of keys) {
      if (t.getTime() >= weekLockAt(mon).getTime() && !db.reports[mon]) {
        db.reports[mon] = buildReport(mon, true);
        saveDb();
      }
    }
  }

  // ---------- report ----------

  function nightKeysForWeek(mondayKey) {
    return Array.from({ length: 7 }, (_, i) => addDaysKey(mondayKey, i));
  }

  function isComplete(night) {
    return !!(night && night.aset && night.bset);
  }

  function mealToBedHours(nightKey, aset) {
    if (!aset?.lastMeal || !aset?.bedtime) return null;
    const bed = parseTimeOnDay(nightKey, aset.bedtime);
    let meal = parseTimeOnDay(nightKey, aset.lastMeal);
    if (!bed || !meal) return null;
    // meal usually same calendar evening; if meal appears after bed, assume previous day
    if (meal.getTime() > bed.getTime()) {
      meal = parseTimeOnDay(addDaysKey(nightKey, -1), aset.lastMeal);
    }
    return hoursBetween(meal, bed);
  }

  function timeInBedHours(nightKey, night) {
    const pair = bedWakeDates(nightKey, night?.aset?.bedtime, night?.bset?.wakeTime);
    if (!pair) return null;
    return hoursBetween(pair.bed, pair.wake);
  }

  function mean(nums) {
    if (!nums.length) return null;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  }

  function buildReport(mondayKey, locked) {
    const keys = nightKeysForWeek(mondayKey);
    const scores = keys.map((k) => {
      const n = getNight(k);
      return n?.bset?.sleepScore ?? null;
    });
    const scored = scores.filter((s) => s != null);
    const completeKeys = keys.filter((k) => isComplete(getNight(k)));

    const tibs = [];
    let wakingYes = 0;
    let wakingTotal = 0;
    for (const k of keys) {
      const n = getNight(k);
      const tib = timeInBedHours(k, n);
      if (tib != null) tibs.push(tib);
      if (n?.bset) {
        wakingTotal += 1;
        if (n.bset.nightWaking) wakingYes += 1;
      }
    }

    const factors = completeKeys.length >= 4 ? computeFactors(completeKeys) : [];
    const reasonCounts = {};
    for (const k of keys) {
      const reasons = getNight(k)?.bset?.wakeReasons || [];
      for (const r of reasons) {
        if (r === "其他") continue;
        reasonCounts[r] = (reasonCounts[r] || 0) + 1;
      }
    }
    const topReasons = Object.entries(reasonCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([name, count]) => ({ name, count }));

    return {
      mondayKey,
      locked: !!locked,
      lockedAt: locked ? now().toISOString() : null,
      completeCount: completeKeys.length,
      scores,
      scoreAvg: mean(scored),
      scoreMax: scored.length ? Math.max(...scored) : null,
      scoreMin: scored.length ? Math.min(...scored) : null,
      avgTimeInBed: mean(tibs),
      wakingRatio: wakingTotal ? wakingYes / wakingTotal : null,
      wakingYes,
      wakingTotal,
      factors,
      topReasons,
    };
  }

  function computeFactors(completeKeys) {
    const rows = completeKeys.map((k) => {
      const n = getNight(k);
      return {
        key: k,
        score: n.bset.sleepScore,
        exercised: !!n.aset.exercised,
        napped: !!n.aset.napped,
        nightWaking: !!n.bset.nightWaking,
        mealGap: mealToBedHours(k, n.aset),
        ac: n.aset.acTemp,
        sleepEase: n.bset.sleepEase,
        reSleepEase: n.bset.reSleepEase,
      };
    });

    /** @type {{ text: string, absDelta: number }[]} */
    const candidates = [];

    function pushBinary(labelYes, labelNo, pred) {
      const yes = rows.filter(pred);
      const no = rows.filter((r) => !pred(r));
      if (!yes.length || !no.length) return;
      const dy = mean(yes.map((r) => r.score));
      const dn = mean(no.map((r) => r.score));
      const delta = dy - dn;
      if (Math.abs(delta) < 0.5) return;
      const text =
        delta >= 0
          ? `本周${labelYes}，评分平均比${labelNo}高 ${delta.toFixed(1)} 分（${yes.length} 夜 vs ${no.length} 夜）。`
          : `本周${labelYes}，评分平均比${labelNo}低 ${Math.abs(delta).toFixed(1)} 分（${yes.length} 夜 vs ${no.length} 夜）。`;
      candidates.push({ text, absDelta: Math.abs(delta) });
    }

    pushBinary("运动过后的夜晚", "未运动的夜晚", (r) => r.exercised);
    pushBinary("午睡过后的夜晚", "未午睡的夜晚", (r) => r.napped);
    pushBinary("有夜醒的夜晚", "无夜醒的夜晚", (r) => r.nightWaking);

    function pushSplit(labelYes, labelNo, yesRows, noRows) {
      if (!yesRows.length || !noRows.length) return;
      const dy = mean(yesRows.map((r) => r.score));
      const dn = mean(noRows.map((r) => r.score));
      const delta = dy - dn;
      if (Math.abs(delta) < 0.5) return;
      const text =
        delta >= 0
          ? `本周${labelYes}，评分平均比${labelNo}高 ${delta.toFixed(1)} 分（${yesRows.length} 夜 vs ${noRows.length} 夜）。`
          : `本周${labelYes}，评分平均比${labelNo}低 ${Math.abs(delta).toFixed(1)} 分（${yesRows.length} 夜 vs ${noRows.length} 夜）。`;
      candidates.push({ text, absDelta: Math.abs(delta) });
    }

    const mealKnown = rows.filter((r) => r.mealGap != null);
    pushSplit(
      "末餐距上床不足 3 小时的夜晚",
      "末餐距上床至少 3 小时的夜晚",
      mealKnown.filter((r) => r.mealGap < 3),
      mealKnown.filter((r) => r.mealGap >= 3)
    );

    pushBinary("空调 ≤25℃ 的夜晚", "空调 >25℃ 的夜晚", (r) => r.ac != null && r.ac <= 25);
    pushBinary("入睡轻松的夜晚", "其余夜晚", (r) => r.sleepEase != null && r.sleepEase >= 6);

    const reKnown = rows.filter((r) => r.reSleepEase != null);
    pushSplit(
      "再入睡轻松的夜晚",
      "其余夜晚",
      reKnown.filter((r) => r.reSleepEase >= 6),
      reKnown.filter((r) => r.reSleepEase <= 5)
    );

    return candidates
      .sort((a, b) => b.absDelta - a.absDelta)
      .slice(0, 3)
      .map((c) => c.text);
  }

  function getReportForWeek(mondayKey, t = now()) {
    ensureLockedSnapshots(t);
    if (db.reports[mondayKey]) return db.reports[mondayKey];
    return buildReport(mondayKey, false);
  }

  function listWeekOptions(t = now()) {
    const currentNight = nightIdForNow(t);
    const currentMon = weekMondayKey(currentNight);
    const opts = [];
    for (let i = 0; i < 8; i++) {
      const mon = addDaysKey(currentMon, -7 * i);
      const locked = t.getTime() >= weekLockAt(mon).getTime();
      const hasData =
        locked ||
        nightKeysForWeek(mon).some((k) => getNight(k)) ||
        i === 0;
      if (!hasData && i > 0) continue;
      opts.push({ mondayKey: mon, locked, isCurrent: i === 0 });
    }
    // also include locked report keys not in list
    for (const mon of Object.keys(db.reports)) {
      if (!opts.some((o) => o.mondayKey === mon)) {
        opts.push({ mondayKey: mon, locked: true, isCurrent: false });
      }
    }
    opts.sort((a, b) => (a.mondayKey < b.mondayKey ? 1 : -1));
    return opts;
  }

  // ---------- toast ----------

  let toastTimer = null;
  function toast(msg) {
    elToast.textContent = msg;
    elToast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      elToast.hidden = true;
    }, 2200);
  }

  // ---------- views ----------

  function setView(name) {
    currentView = name;
    document.querySelectorAll(".tab").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.view === name);
    });
    elLog.hidden = name !== "log";
    elReport.hidden = name !== "report";
    elLog.classList.toggle("is-active", name === "log");
    elReport.classList.toggle("is-active", name === "report");
    render();
  }

  function updateContext(t = now()) {
    const nid = nightIdForNow(t);
    const mon = weekMondayKey(nid);
    const windowLabel = inAsetSenseWindow(t) ? "睡前时段" : "起床后时段";
    const fake = clockOverrideMs != null ? " · 调试时钟" : "";
    elContext.textContent = `${windowLabel} · 当前夜 ${formatNightLabel(nid)} · 本周 ${formatWeekRange(mon)}${fake}`;
  }

  function resolveDefaultForm(t = now()) {
    const nid = nightIdForNow(t);
    if (inAsetSenseWindow(t)) {
      return { mode: "aset", nightKey: nid };
    }
    return { mode: "bset", nightKey: nid };
  }

  function applyTheme() {
    const theme =
      currentView === "log" && formMode === "bset" ? "day" : "night";
    document.body.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "day" ? "#fff3d1" : "#12151c");
  }

  function render() {
    const t = now();
    ensureLockedSnapshots(t);
    applyTheme();
    updateContext(t);
    mountDebugPanel();
    if (currentView === "log") renderLog(t);
    else renderReport(t);
  }

  function renderLog(now) {
    applyTheme();
    if (!formNightId || !formMode) {
      const d = resolveDefaultForm(now);
      formMode = d.mode;
      formNightId = d.nightKey;
    }

    // If user navigated away in time, keep explicit formMode/night unless invalid
    const nightKey = formNightId;
    const mode = formMode;
    const night = getNight(nightKey);
    const writing =
      mode === "aset" ? canWriteAset(nightKey, now) : canWriteBset(nightKey, now);
    const lockedWeek = isWeekLocked(nightKey, now);

    const defaultTarget = resolveDefaultForm(now);
    const showBackToDefault =
      nightKey !== defaultTarget.nightKey || mode !== defaultTarget.mode;

    let html = `<div class="panel">`;
    html += `<h2 class="panel-title">${mode === "aset" ? "睡前记录" : "起床后记录"}</h2>`;
    html += `<p class="panel-sub">${formatNightLabel(nightKey)}</p>`;

    if (showBackToDefault) {
      html += `<button type="button" class="btn-link" id="btn-back-default">返回当前时段问卷</button>`;
    }

    if (
      mode === "bset" &&
      !night?.aset &&
      canWriteAset(nightKey, now) &&
      !lockedWeek
    ) {
      html += `<button type="button" class="btn-link" id="btn-fill-aset">补填睡前（Aset）</button>`;
    }

    if (lockedWeek) {
      html += `<div class="locked-card"><strong>本周已锁定</strong>该夜所属周报已上锁，不可再改。</div>`;
      if (night) html += readonlySummary(nightKey, night);
      html += `</div>`;
      elLog.innerHTML = html;
      bindLogChrome();
      return;
    }

    if (!writing) {
      html += `<div class="locked-card"><strong>本夜此侧已截止</strong>可写窗口为 ${
        mode === "aset"
          ? `${nightKey} 21:30 – ${addDaysKey(nightKey, 1)} 21:30`
          : `${addDaysKey(nightKey, 1)} 03:00 – ${addDaysKey(nightKey, 1)} 21:30`
      }</div>`;
      if (night?.[mode]) html += readonlySummary(nightKey, night);
      html += `</div>`;
      elLog.innerHTML = html;
      bindLogChrome();
      return;
    }

    if (night?.[mode]) {
      html += `<div class="banner">已保存过，修改将覆盖原记录。</div>`;
    }

    html +=
      mode === "aset"
        ? asetFormHtml(night?.aset)
        : bsetFormHtml(night?.bset, night?.aset);
    html += `</div>`;
    elLog.innerHTML = html;
    bindLogChrome();
    if (mode === "aset") bindAsetForm(night?.aset);
    else bindBsetForm(night?.bset);
  }

  function readonlySummary(nightKey, night) {
    const parts = [];
    if (night.aset) {
      parts.push(
        `<strong>睡前</strong> 运动 ${night.aset.exercised ? `是 (${night.aset.exerciseMinutes} 分)` : "否"} · 午睡 ${
          night.aset.napped ? `是 (${night.aset.napMinutes} 分)` : "否"
        } · 末餐 ${night.aset.lastMeal} · 空调 ${night.aset.acTemp}℃ · 上床 ${night.aset.bedtime}`
      );
    }
    if (night.bset) {
      parts.push(
        `<strong>起床后</strong> 起床 ${night.bset.wakeTime} · 入睡容易度 ${night.bset.sleepEase} · 夜醒 ${
          night.bset.nightWaking ? "是" : "否"
        }${
          night.bset.nightWaking
            ? ` · 再入睡容易度 ${night.bset.reSleepEase ?? "—"}`
            : ""
        } · 评分 ${night.bset.sleepScore}`
      );
    }
    if (!parts.length) return "";
    return `<div class="readonly-block">${parts.join("<br/>")}</div>`;
  }

  function asetFormHtml(aset) {
    return `
      <div id="form-errors" class="error-list"></div>
      <div id="soft-warn" class="soft-box" hidden></div>

      <div class="field">
        <span class="label">白天是否运动</span>
        <div class="seg" data-field="exercised">
          <button type="button" class="seg-btn" data-value="yes">Yes</button>
          <button type="button" class="seg-btn" data-value="no">No</button>
        </div>
      </div>
      <div class="field" id="field-exercise-min" hidden>
        <label class="label" for="exerciseMinutes">运动时长</label>
        <div class="input-row">
          <input id="exerciseMinutes" type="number" inputmode="numeric" min="1" max="300" placeholder="分钟" />
          <span class="unit">分钟</span>
        </div>
      </div>

      <div class="field">
        <span class="label">白天是否睡觉</span>
        <div class="seg" data-field="napped">
          <button type="button" class="seg-btn" data-value="yes">Yes</button>
          <button type="button" class="seg-btn" data-value="no">No</button>
        </div>
      </div>
      <div class="field" id="field-nap-min" hidden>
        <label class="label" for="napMinutes">睡觉时长</label>
        <div class="input-row">
          <input id="napMinutes" type="number" inputmode="numeric" min="1" max="300" placeholder="分钟" />
          <span class="unit">分钟</span>
        </div>
      </div>

      <div class="field">
        <label class="label" for="lastMeal">最后一次进餐时间</label>
        <input id="lastMeal" type="time" />
        <p class="hint">大约即可</p>
      </div>

      <div class="field">
        <span class="label">空调设定温度</span>
        <div class="stepper">
          <button type="button" class="step-btn" id="ac-minus" aria-label="降低">−</button>
          <div class="step-value"><span id="acTemp">25</span>℃</div>
          <button type="button" class="step-btn" id="ac-plus" aria-label="升高">+</button>
        </div>
      </div>

      <div class="field">
        <label class="label" for="bedtime">上床时间</label>
        <input id="bedtime" type="time" />
      </div>

      <button type="button" class="btn btn-primary" id="btn-save-aset">保存睡前记录</button>
    `;
  }

  function bsetFormHtml() {
    const reasonChips = WAKE_REASONS.map(
      (r) => `<button type="button" class="chip" data-reason="${r}">${r}</button>`
    ).join("");

    return `
      <div id="form-errors" class="error-list"></div>
      <div id="soft-warn" class="soft-box" hidden></div>

      <div class="field">
        <label class="label" for="wakeTime">起床时间</label>
        <input id="wakeTime" type="time" />
      </div>

      <div class="field">
        <span class="label">入睡轻松吗？</span>
        <p class="hint">1 很难 · 10 很容易</p>
        <div class="score-grid" data-score="sleepEase"></div>
      </div>

      <div class="field">
        <span class="label">半夜是否醒来</span>
        <div class="seg" data-field="nightWaking">
          <button type="button" class="seg-btn" data-value="yes">Yes</button>
          <button type="button" class="seg-btn" data-value="no">No</button>
        </div>
      </div>

      <div class="field" id="field-wake-reasons" hidden>
        <span class="label">夜醒原因（可多选）</span>
        <div class="chips" id="wake-reasons">${reasonChips}</div>
      </div>

      <div class="field" id="field-other-reason" hidden>
        <label class="label" for="otherReason">其他原因</label>
        <input id="otherReason" type="text" maxlength="40" placeholder="简短说明" />
      </div>

      <div class="field" id="field-re-sleep" hidden>
        <span class="label">再入睡轻松吗？</span>
        <p class="hint">1 很难 · 10 很容易</p>
        <div class="score-grid" data-score="reSleepEase"></div>
      </div>

      <div class="field">
        <span class="label">本次睡眠评分</span>
        <p class="hint">10 为满分</p>
        <div class="score-grid" data-score="sleepScore"></div>
      </div>

      <button type="button" class="btn btn-primary" id="btn-save-bset">保存起床记录</button>
    `;
  }

  function fillScoreGrid(root, name) {
    const grid = root.querySelector(`[data-score="${name}"]`);
    if (!grid) return;
    grid.innerHTML = "";
    for (let i = 1; i <= 10; i++) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "score-btn";
      b.dataset.value = String(i);
      b.textContent = String(i);
      grid.appendChild(b);
    }
  }

  function bindSeg(root, field, onChange) {
    const wrap = root.querySelector(`[data-field="${field}"]`);
    wrap.querySelectorAll(".seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        wrap.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("is-on"));
        btn.classList.add("is-on");
        onChange?.(btn.dataset.value === "yes");
      });
    });
  }

  function getSeg(root, field) {
    const on = root.querySelector(`[data-field="${field}"] .seg-btn.is-on`);
    if (!on) return null;
    return on.dataset.value === "yes";
  }

  function setSeg(root, field, value) {
    if (value == null) return;
    const wrap = root.querySelector(`[data-field="${field}"]`);
    wrap.querySelectorAll(".seg-btn").forEach((b) => {
      b.classList.toggle("is-on", (b.dataset.value === "yes") === !!value);
    });
  }

  function bindScore(root, name, stateObj) {
    fillScoreGrid(root, name);
    const grid = root.querySelector(`[data-score="${name}"]`);
    grid.addEventListener("click", (e) => {
      const btn = e.target.closest(".score-btn");
      if (!btn) return;
      grid.querySelectorAll(".score-btn").forEach((b) => b.classList.remove("is-on"));
      btn.classList.add("is-on");
      stateObj[name] = Number(btn.dataset.value);
    });
  }

  function setScore(root, name, value) {
    if (value == null) return;
    const grid = root.querySelector(`[data-score="${name}"]`);
    grid.querySelectorAll(".score-btn").forEach((b) => {
      b.classList.toggle("is-on", Number(b.dataset.value) === value);
    });
  }

  function bindLogChrome() {
    document.getElementById("btn-back-default")?.addEventListener("click", () => {
      const d = resolveDefaultForm(now());
      formMode = d.mode;
      formNightId = d.nightKey;
      renderLog(now());
    });
    document.getElementById("btn-fill-aset")?.addEventListener("click", () => {
      formMode = "aset";
      renderLog(now());
    });
  }

  function bindAsetForm(existing) {
    const root = elLog;
    let exercised = existing?.exercised ?? null;
    let napped = existing?.napped ?? null;
    let acTemp = existing?.acTemp ?? 25;

    const exField = root.querySelector("#field-exercise-min");
    const napField = root.querySelector("#field-nap-min");
    const acEl = root.querySelector("#acTemp");

    function syncConditional() {
      exField.hidden = exercised !== true;
      napField.hidden = napped !== true;
      if (exercised === false) root.querySelector("#exerciseMinutes").value = "";
      if (napped === false) root.querySelector("#napMinutes").value = "";
    }

    bindSeg(root, "exercised", (v) => {
      exercised = v;
      syncConditional();
    });
    bindSeg(root, "napped", (v) => {
      napped = v;
      syncConditional();
    });

    root.querySelector("#ac-minus").addEventListener("click", () => {
      acTemp = Math.max(16, acTemp - 1);
      acEl.textContent = String(acTemp);
    });
    root.querySelector("#ac-plus").addEventListener("click", () => {
      acTemp = Math.min(30, acTemp + 1);
      acEl.textContent = String(acTemp);
    });
    acEl.textContent = String(acTemp);

    if (existing) {
      setSeg(root, "exercised", existing.exercised);
      setSeg(root, "napped", existing.napped);
      exercised = existing.exercised;
      napped = existing.napped;
      if (existing.exercised) root.querySelector("#exerciseMinutes").value = existing.exerciseMinutes;
      if (existing.napped) root.querySelector("#napMinutes").value = existing.napMinutes;
      root.querySelector("#lastMeal").value = existing.lastMeal || "";
      root.querySelector("#bedtime").value = existing.bedtime || "";
    } else {
      root.querySelector("#bedtime").value = roundTimeTo5(now());
    }
    syncConditional();

    root.querySelector("#btn-save-aset").addEventListener("click", () => {
      const errors = [];
      if (exercised == null) errors.push("请选择白天是否运动");
      if (napped == null) errors.push("请选择白天是否睡觉");
      const exMin = Number(root.querySelector("#exerciseMinutes").value);
      const napMin = Number(root.querySelector("#napMinutes").value);
      if (exercised === true) {
        if (!root.querySelector("#exerciseMinutes").value) errors.push("请填写运动时长");
        else if (!Number.isFinite(exMin) || exMin < 1 || exMin > 300)
          errors.push("运动时长请在 1–300 分钟");
      }
      if (napped === true) {
        if (!root.querySelector("#napMinutes").value) errors.push("请填写睡觉时长");
        else if (!Number.isFinite(napMin) || napMin < 1 || napMin > 300)
          errors.push("睡觉时长请在 1–300 分钟");
      }
      const lastMeal = root.querySelector("#lastMeal").value;
      const bedtime = root.querySelector("#bedtime").value;
      if (!lastMeal) errors.push("请填写最后一次进餐时间");
      if (!bedtime) errors.push("请填写上床时间");
      if (acTemp < 16 || acTemp > 30) errors.push("温度请在 16–30℃");

      const errBox = root.querySelector("#form-errors");
      errBox.innerHTML = errors.map((e) => `<div>${e}</div>`).join("");
      if (errors.length) return;

      const payload = {
        exercised,
        exerciseMinutes: exercised ? exMin : 0,
        napped,
        napMinutes: napped ? napMin : 0,
        lastMeal,
        acTemp,
        bedtime,
        updatedAt: now().toISOString(),
      };

      const night = ensureNight(formNightId);
      night.aset = payload;
      // invalidate unlocked report cache conceptually by not writing snapshot
      saveDb();
      toast(`已保存 ${formatNightLabel(formNightId)} 睡前记录`);
      renderLog(now());
    });
  }

  function bindBsetForm(existing) {
    const root = elLog;
    const state = {
      nightWaking: existing?.nightWaking ?? null,
      sleepEase: existing?.sleepEase ?? null,
      reSleepEase: existing?.reSleepEase ?? null,
      sleepScore: existing?.sleepScore ?? null,
      wakeReasons: new Set(existing?.wakeReasons || []),
    };

    const reasonsField = root.querySelector("#field-wake-reasons");
    const otherField = root.querySelector("#field-other-reason");
    const reField = root.querySelector("#field-re-sleep");

    function syncWaking() {
      const on = state.nightWaking === true;
      reasonsField.hidden = !on;
      reField.hidden = !on;
      otherField.hidden = !on || !state.wakeReasons.has("其他");
      if (!on) {
        state.wakeReasons.clear();
        state.reSleepEase = null;
        root.querySelector("#otherReason").value = "";
        root.querySelectorAll("#wake-reasons .chip").forEach((c) => c.classList.remove("is-on"));
        setScore(root, "reSleepEase", null);
        root.querySelectorAll('[data-score="reSleepEase"] .score-btn').forEach((b) =>
          b.classList.remove("is-on")
        );
      }
    }

    bindSeg(root, "nightWaking", (v) => {
      state.nightWaking = v;
      syncWaking();
    });

    bindScore(root, "sleepEase", state);
    bindScore(root, "reSleepEase", state);
    bindScore(root, "sleepScore", state);

    root.querySelector("#wake-reasons").addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      const r = chip.dataset.reason;
      if (state.wakeReasons.has(r)) state.wakeReasons.delete(r);
      else state.wakeReasons.add(r);
      chip.classList.toggle("is-on");
      otherField.hidden = !state.wakeReasons.has("其他");
    });

    if (existing) {
      root.querySelector("#wakeTime").value = existing.wakeTime || "";
      setSeg(root, "nightWaking", existing.nightWaking);
      state.nightWaking = existing.nightWaking;
      setScore(root, "sleepEase", existing.sleepEase);
      setScore(root, "sleepScore", existing.sleepScore);
      if (existing.nightWaking) {
        setScore(root, "reSleepEase", existing.reSleepEase);
        root.querySelectorAll("#wake-reasons .chip").forEach((c) => {
          if (state.wakeReasons.has(c.dataset.reason)) c.classList.add("is-on");
        });
        root.querySelector("#otherReason").value = existing.otherReason || "";
      }
    }
    syncWaking();

    root.querySelector("#btn-save-bset").addEventListener("click", () => {
      const errors = [];
      const soft = [];
      const wakeTime = root.querySelector("#wakeTime").value;
      if (!wakeTime) errors.push("请填写起床时间");
      if (state.sleepEase == null) errors.push("请选择：入睡轻松吗？");
      if (state.nightWaking == null) errors.push("请选择半夜是否醒来");
      if (state.nightWaking === true) {
        if (!state.wakeReasons.size) errors.push("请选择夜醒原因");
        if (state.wakeReasons.has("其他") && !root.querySelector("#otherReason").value.trim())
          errors.push("请填写其他原因");
        if (state.reSleepEase == null) errors.push("请选择：再入睡轻松吗？");
      }
      if (state.sleepScore == null) errors.push("请选择睡眠评分");

      const aset = getNight(formNightId)?.aset;
      if (aset?.bedtime && wakeTime) {
        const pair = bedWakeDates(formNightId, aset.bedtime, wakeTime);
        if (pair) {
          const h = hoursBetween(pair.bed, pair.wake);
          if (h < 3 || h > 14) soft.push(`在床约 ${formatHours(h)}，确认无误再保存？`);
        }
      }

      const errBox = root.querySelector("#form-errors");
      errBox.innerHTML = errors.map((e) => `<div>${e}</div>`).join("");
      const softBox = root.querySelector("#soft-warn");
      if (soft.length && !errors.length) {
        softBox.hidden = false;
        softBox.innerHTML =
          soft.join("<br/>") +
          `<div style="margin-top:8px"><button type="button" class="btn btn-primary" id="btn-force-save">仍要保存</button></div>`;
        softBox.querySelector("#btn-force-save").onclick = () => saveBset(true);
        return;
      }
      softBox.hidden = true;
      if (errors.length) return;
      saveBset(false);

      function saveBset() {
        const payload = {
          wakeTime,
          sleepEase: state.sleepEase,
          nightWaking: state.nightWaking,
          wakeReasons: state.nightWaking ? [...state.wakeReasons] : [],
          otherReason:
            state.nightWaking && state.wakeReasons.has("其他")
              ? root.querySelector("#otherReason").value.trim()
              : "",
          reSleepEase: state.nightWaking ? state.reSleepEase : null,
          sleepScore: state.sleepScore,
          updatedAt: now().toISOString(),
        };
        const night = ensureNight(formNightId);
        night.bset = payload;
        saveDb();
        toast(`已保存 ${formatNightLabel(formNightId)} 起床记录`);
        renderLog(now());
      }
    });
  }

  // ---------- report UI ----------

  function renderReport(now) {
    applyTheme();
    const weeks = listWeekOptions(now);
    if (!reportWeekKey || !weeks.some((w) => w.mondayKey === reportWeekKey)) {
      reportWeekKey = weeks[0]?.mondayKey || weekMondayKey(nightIdForNow(now));
    }
    const report = getReportForWeek(reportWeekKey, now);
    const meta = weeks.find((w) => w.mondayKey === reportWeekKey);

    let html = `<div class="week-switch">`;
    for (const w of weeks.slice(0, 6)) {
      html += `<button type="button" class="week-chip ${
        w.mondayKey === reportWeekKey ? "is-on" : ""
      }" data-week="${w.mondayKey}">${
        w.isCurrent ? "本周" : formatWeekRange(w.mondayKey)
      }${w.locked ? " · 已锁" : ""}</button>`;
    }
    html += `</div>`;

    html += `<div class="panel">`;
    html += `<h2 class="panel-title">周报</h2>`;
    html += `<p class="panel-sub">${formatWeekRange(reportWeekKey)}${
      meta?.locked || report.locked ? " · 已锁定" : " · 预览"
    }</p>`;

    html += `<div class="banner">本周完整记录 <strong>${report.completeCount} / 7</strong></div>`;
    if (report.completeCount < 4) {
      html += `<div class="banner warn">完整夜不足 4，暂不分析影响因素。</div>`;
    }

    html += `<h3 class="panel-title" style="font-size:1.05rem;margin-top:8px">评分趋势</h3>`;
    html += scoreChartSvg(report.scores);
    html += `<div class="stat-row">
      <div class="stat"><span class="stat-label">均分</span><span class="stat-value">${fmtNum(report.scoreAvg)}</span></div>
      <div class="stat"><span class="stat-label">最高 / 最低</span><span class="stat-value">${
        report.scoreMax == null ? "—" : `${report.scoreMax} / ${report.scoreMin}`
      }</span></div>
    </div>`;

    html += `<h3 class="panel-title" style="font-size:1.05rem;margin-top:8px">睡眠摘要</h3>`;
    html += `<div class="stat-row">
      <div class="stat"><span class="stat-label">平均在床时长</span><span class="stat-value">${formatHours(
        report.avgTimeInBed
      )}</span></div>
      <div class="stat"><span class="stat-label">夜醒比例</span><span class="stat-value">${
        report.wakingRatio == null
          ? "—"
          : `${Math.round(report.wakingRatio * 100)}%`
      }</span></div>
    </div>`;

    html += `<h3 class="panel-title" style="font-size:1.05rem;margin-top:8px">可能相关因素</h3>`;
    if (report.completeCount < 4) {
      html += `<p class="muted">样本不足</p>`;
    } else if (!report.factors.length) {
      html += `<p class="muted">本周未发现 |Δ| ≥ 0.5 的明显分组差异。</p>`;
    } else {
      html += `<ul class="factor-list">${report.factors
        .map((t) => `<li>${t}</li>`)
        .join("")}</ul>`;
    }

    if (report.topReasons?.length) {
      html += `<p class="hint" style="margin-top:12px">夜醒原因：${report.topReasons
        .map((r) => `${r.name} ${r.count} 次`)
        .join(" · ")}</p>`;
    }

    html += `</div>`;
    elReport.innerHTML = html;

    elReport.querySelectorAll("[data-week]").forEach((btn) => {
      btn.addEventListener("click", () => {
        reportWeekKey = btn.dataset.week;
        renderReport(now());
      });
    });
  }

  function fmtNum(n) {
    if (n == null || Number.isNaN(n)) return "—";
    return (Math.round(n * 10) / 10).toFixed(1);
  }

  function scoreChartSvg(scores) {
    const labels = ["一", "二", "三", "四", "五", "六", "日"];
    const styles = getComputedStyle(document.body);
    const chart = styles.getPropertyValue("--chart").trim() || "#6eb8a8";
    const text = styles.getPropertyValue("--text").trim() || "#e8ecf5";
    const muted = styles.getPropertyValue("--muted").trim() || "#9aa3b5";
    const line = styles.getPropertyValue("--line").trim() || "rgba(0,0,0,0.12)";
    const w = 320;
    const h = 140;
    const padL = 28;
    const padR = 8;
    const padT = 12;
    const padB = 28;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;

    const points = scores.map((s, i) => {
      const x = padL + (i * innerW) / 6;
      const y =
        s == null ? null : padT + innerH - ((s - 1) / 9) * innerH;
      return { x, y, s, label: labels[i] };
    });

    let path = "";
    let started = false;
    for (const p of points) {
      if (p.y == null) {
        started = false;
        continue;
      }
      path += `${started ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)} `;
      started = true;
    }

    const circles = points
      .filter((p) => p.y != null)
      .map(
        (p) =>
          `<circle cx="${p.x}" cy="${p.y}" r="4" fill="${chart}" /><text x="${p.x}" y="${
            p.y - 8
          }" text-anchor="middle" fill="${text}" font-size="10">${p.s}</text>`
      )
      .join("");

    const xLabels = points
      .map(
        (p) =>
          `<text x="${p.x}" y="${h - 8}" text-anchor="middle" fill="${muted}" font-size="11">${p.label}</text>`
      )
      .join("");

    return `<div class="chart"><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="评分趋势">
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + innerH}" stroke="${line}" />
      <line x1="${padL}" y1="${padT + innerH}" x2="${padL + innerW}" y2="${
      padT + innerH
    }" stroke="${line}" />
      <path d="${path}" fill="none" stroke="${chart}" stroke-width="2" />
      ${circles}
      ${xLabels}
    </svg></div>`;
  }

  // ---------- init ----------

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  });

  // Reset form target when opening log tab so time window stays truthful
  document.getElementById("tab-log").addEventListener("click", () => {
    const d = resolveDefaultForm(now());
    formMode = d.mode;
    formNightId = d.nightKey;
  });

  ensureLockedSnapshots(now());
  const initial = resolveDefaultForm(now());
  formMode = initial.mode;
  formNightId = initial.nightKey;
  render();

  setInterval(() => {
    updateContext(now());
  }, 60_000);
})();
