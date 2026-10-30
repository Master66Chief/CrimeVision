/**
 * ClassMind AI — Master Dashboard Controller.
 * Comprehensive pair-programming implementation for ClassMind AI Education Management Platform.
 * Features:
 *  - Dual Themes (Light & Dark) with localStorage persistence and Chart.js color synchronization
 *  - 8 distinct operational views with smooth navigation
 *  - Real-time WebSocket streaming with HTTP polling fallback
 *  - Interactive Chart.js graphs for Overview & Analytics
 *  - Full live video stream lifecycle with reconnection & synthetic fallback
 *  - Automated Sustained Attendance with search, sorting, filtering, and manual audit overrides
 *  - AI Teaching Assistant pedagogical recommendations with feedback & filtering
 *  - Historical session archives with aggregate KPI calculation
 *  - Full Student Management CRUD (list, add, edit, delete with confirmation)
 *  - Privacy, retention, and multimodal threshold settings synchronization
 */

// ==========================================================================
// 1. GLOBAL STATE & CONFIGURATION
// ==========================================================================

let overviewChart = null;
let analyticsChart = null;
let maxDataPoints = 30;

const chartLabels = [];
const engSeries = [];
const poseSeries = [];
const motionSeries = [];
const audioSeries = [];

let activeSessionId = "SESSION-LIVE-01";
let sessionStartEpoch = Date.now();
let knownSuggestionIds = new Set();
let cachedAttendanceRoster = [];
let cachedStudentsList = [];
let recentClassroomEvents = [];
let unreadNotifications = [];

let telemetrySocket = null;
let pollingInterval = null;
let currentCopilotFilter = "ALL";
let editingStudentId = null;

// Attendance sorting state
let attendanceSortColumn = "roll_no";
let attendanceSortAsc = true;

// Video Stream Lifecycle
let currentActiveViewId = "view-overview";
let currentIsSim = true;
let lastFrameArrivalTs = 0;
let streamFrameArrivals = 0;
let streamWatchdogInterval = null;
let streamConnectTs = 0;

// Current Theme
let currentTheme = localStorage.getItem("classmind_theme") || "dark";

// ==========================================================================
// 2. DOM INITIALIZATION
// ==========================================================================

document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initNavigation();
  initVideoStreamController();
  initCharts();
  initSessionControls();
  initAttendanceControls();
  initStudentControls();
  initSettingsControls();
  initNotifications();
  initGlobalSearch();
  initModals();
  startLiveStreaming();
  loadInitialData();
});

// ==========================================================================
// 3. THEME MANAGEMENT (Light / Dark Modes)
// ==========================================================================

function initTheme() {
  applyTheme(currentTheme);

  // Top header theme toggle button
  const toggleBtn = document.getElementById("btn-theme-toggle");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      const nextTheme = currentTheme === "dark" ? "light" : "dark";
      applyTheme(nextTheme);
      showToast(`Switched to ${nextTheme === 'dark' ? 'Dark' : 'Light'} theme`, "info");
    });
  }

  // Settings view radio choices
  const radioLight = document.getElementById("theme-radio-light");
  const radioDark = document.getElementById("theme-radio-dark");

  if (radioLight) {
    radioLight.checked = currentTheme === "light";
    radioLight.addEventListener("change", () => {
      if (radioLight.checked) applyTheme("light");
    });
  }

  if (radioDark) {
    radioDark.checked = currentTheme === "dark";
    radioDark.addEventListener("change", () => {
      if (radioDark.checked) applyTheme("dark");
    });
  }
}

function applyTheme(theme) {
  currentTheme = theme;
  localStorage.setItem("classmind_theme", theme);

  document.documentElement.setAttribute("data-theme", theme);
  document.body.className = `${theme}-theme`;

  // Update Settings Radios if present
  const radioLight = document.getElementById("theme-radio-light");
  const radioDark = document.getElementById("theme-radio-dark");
  if (radioLight) radioLight.checked = theme === "light";
  if (radioDark) radioDark.checked = theme === "dark";

  // Synchronize Chart.js Theme Colors
  updateChartsTheme();
}

function updateChartsTheme() {
  const isLight = currentTheme === "light";
  const gridColor = isLight ? "rgba(0, 0, 0, 0.06)" : "rgba(255, 255, 255, 0.06)";
  const tickColor = isLight ? "#64748B" : "#94A3B8";

  [overviewChart, analyticsChart].forEach(chart => {
    if (chart && chart.options && chart.options.scales) {
      if (chart.options.scales.y) {
        chart.options.scales.y.grid.color = gridColor;
        chart.options.scales.y.ticks.color = tickColor;
      }
      chart.update("none");
    }
  });
}

// ==========================================================================
// 4. NAVIGATION & VIEW SWITCHING (8 Sections)
// ==========================================================================

function initNavigation() {
  const navButtons = document.querySelectorAll(".nav-item");
  navButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const targetView = btn.getAttribute("data-view");
      switchView(targetView);
    });
  });

  // Mobile drawer toggle
  const mobileBtn = document.getElementById("btn-toggle-sidebar");
  const sidebar = document.getElementById("main-sidebar");
  if (mobileBtn && sidebar) {
    mobileBtn.addEventListener("click", () => {
      sidebar.classList.toggle("open");
    });

    // Close on click outside on mobile
    document.addEventListener("click", (e) => {
      if (!sidebar.contains(e.target) && !mobileBtn.contains(e.target) && sidebar.classList.contains("open")) {
        sidebar.classList.remove("open");
      }
    });
  }
}

function switchView(viewId) {
  // Update sidebar active buttons
  document.querySelectorAll(".nav-item").forEach(b => {
    b.classList.toggle("active", b.getAttribute("data-view") === viewId);
  });

  // Update active panels
  document.querySelectorAll(".view-panel").forEach(p => {
    p.classList.toggle("active", p.id === viewId);
  });

  // Close mobile sidebar if open
  const sidebar = document.getElementById("main-sidebar");
  if (sidebar && sidebar.classList.contains("open")) {
    sidebar.classList.remove("open");
  }

  // Handle Video Stream Attach / Detach
  handleStreamViewChange(viewId);

  // Trigger view-specific dynamic refreshes
  if (viewId === "view-overview") {
    if (overviewChart) overviewChart.update();
  } else if (viewId === "view-attendance") {
    refreshAttendanceTable();
  } else if (viewId === "view-analytics") {
    if (analyticsChart) analyticsChart.update();
  } else if (viewId === "view-copilot") {
    loadAllRecommendations();
  } else if (viewId === "view-history") {
    loadSessionHistory();
  } else if (viewId === "view-students") {
    loadStudentsTable();
  } else if (viewId === "view-settings") {
    loadSettingsData();
  }
}

// ==========================================================================
// 5. VIDEO STREAM LIFECYCLE CONTROLLER
// ==========================================================================

function initVideoStreamController() {
  const mainStream = document.getElementById("live-main-stream");
  const loadingOverlay = document.getElementById("video-stream-loading");
  const errorOverlay = document.getElementById("video-stream-error");
  const reconnectBtn = document.getElementById("btn-reconnect-stream");
  const cameraSelect = document.getElementById("select-camera-source");

  if (reconnectBtn) {
    reconnectBtn.addEventListener("click", reconnectLiveStream);
  }

  if (cameraSelect) {
    cameraSelect.addEventListener("change", async (e) => {
      const val = e.target.value;
      if (val === "sim") {
        await postSettingsUpdate({ use_simulation: true });
        showToast("Switched to Simulation Engine", "info");
      } else {
        const camIdx = parseInt(val, 10);
        await postSettingsUpdate({ use_simulation: false, selected_camera_index: camIdx });
        showToast(`Connecting to Camera Device #${camIdx}...`, "info");
      }
      setTimeout(reconnectLiveStream, 350);
    });
  }

  if (mainStream) {
    mainStream.addEventListener("load", () => {
      if (loadingOverlay) loadingOverlay.classList.add("hidden");
      if (errorOverlay) errorOverlay.classList.add("hidden");
      lastFrameArrivalTs = Date.now();
      streamFrameArrivals++;

      const statusEl = document.getElementById("video-feed-status");
      const dotEl = document.getElementById("video-feed-status-dot");
      if (statusEl) {
        statusEl.innerText = `Stream Active • ${currentIsSim ? 'Simulation' : 'Hardware Camera'}`;
      }
      if (dotEl) {
        dotEl.className = "badge-dot pulse";
      }

      if (mainStream.naturalWidth > 0) {
        const resStr = `${mainStream.naturalWidth}x${mainStream.naturalHeight}`;
        const resTag = document.getElementById("live-tag-res");
        const resBadge = document.getElementById("live-stream-res-badge");
        if (resTag) resTag.innerText = resStr;
        if (resBadge) resBadge.innerText = resStr;
      }
    });

    mainStream.addEventListener("error", () => {
      console.warn("[ClassMind AI] Live main video stream disconnected.");
      if (currentActiveViewId === "view-live") {
        if (loadingOverlay) loadingOverlay.classList.add("hidden");
        if (errorOverlay) errorOverlay.classList.remove("hidden");
        const statusEl = document.getElementById("video-feed-status");
        const dotEl = document.getElementById("video-feed-status-dot");
        if (statusEl) statusEl.innerText = "Stream Disconnected • Waiting to reconnect";
        if (dotEl) dotEl.className = "badge-dot dot-error";
      }
    });
  }

  // Initial stream setup for default view
  handleStreamViewChange(currentActiveViewId);

  // Watchdog timer to detect stalls
  if (streamWatchdogInterval) clearInterval(streamWatchdogInterval);
  streamWatchdogInterval = setInterval(() => {
    if (currentActiveViewId === "view-live" && mainStream) {
      const now = Date.now();
      const timeSinceConnect = now - streamConnectTs;
      const isLoaded = mainStream.complete && mainStream.naturalWidth > 0;

      if (isLoaded) {
        if (loadingOverlay) loadingOverlay.classList.add("hidden");
        if (errorOverlay) errorOverlay.classList.add("hidden");
      } else if (timeSinceConnect > 4500) {
        if (loadingOverlay) loadingOverlay.classList.add("hidden");
        if (errorOverlay) errorOverlay.classList.remove("hidden");
      }
    }
  }, 1000);
}

function handleStreamViewChange(viewId) {
  currentActiveViewId = viewId;
  const mainStream = document.getElementById("live-main-stream");
  const overviewStream = document.getElementById("overview-video-feed");
  const loadingOverlay = document.getElementById("video-stream-loading");
  const errorOverlay = document.getElementById("video-stream-error");

  if (viewId === "view-live") {
    // Detach overview stream to prevent duplicate bandwidth
    if (overviewStream) overviewStream.src = "";

    // Connect main live stream
    if (mainStream) {
      if (loadingOverlay) loadingOverlay.classList.remove("hidden");
      if (errorOverlay) errorOverlay.classList.add("hidden");
      streamConnectTs = Date.now();
      const statusEl = document.getElementById("video-feed-status");
      if (statusEl) statusEl.innerText = "Connecting to real-time stream...";

      mainStream.src = `/video_feed?stream=live&t=${Date.now()}`;
    }
  } else if (viewId === "view-overview") {
    if (mainStream) mainStream.src = "";
    if (overviewStream && (!overviewStream.src || overviewStream.src === "")) {
      overviewStream.src = `/video_feed?stream=overview&t=${Date.now()}`;
    }
  } else {
    // Other background views: detach both streams to conserve machine resources
    if (mainStream) mainStream.src = "";
    if (overviewStream) overviewStream.src = "";
  }
}

function reconnectLiveStream() {
  const mainStream = document.getElementById("live-main-stream");
  const loadingOverlay = document.getElementById("video-stream-loading");
  const errorOverlay = document.getElementById("video-stream-error");

  if (loadingOverlay) loadingOverlay.classList.remove("hidden");
  if (errorOverlay) errorOverlay.classList.add("hidden");
  streamConnectTs = Date.now();

  const statusEl = document.getElementById("video-feed-status");
  if (statusEl) statusEl.innerText = "Reconnecting stream...";

  if (mainStream) {
    mainStream.src = "";
    setTimeout(() => {
      mainStream.src = `/video_feed?stream=live&t=${Date.now()}`;
    }, 150);
  }
}

// ==========================================================================
// 6. REAL-TIME TELEMETRY STREAMING (WebSocket + Polling Fallback)
// ==========================================================================

function startLiveStreaming() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws/telemetry`;

  try {
    telemetrySocket = new WebSocket(wsUrl);

    telemetrySocket.onopen = () => {
      console.log("[ClassMind AI] WebSocket connection established.");
      if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
      }
    };

    telemetrySocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleTelemetryUpdate(data);
      } catch (err) {
        console.error("Error parsing telemetry message:", err);
      }
    };

    telemetrySocket.onerror = () => {
      console.warn("[ClassMind AI] WebSocket encountered error, engaging polling fallback...");
      startPollingFallback();
    };

    telemetrySocket.onclose = () => {
      console.warn("[ClassMind AI] WebSocket closed, engaging polling fallback...");
      startPollingFallback();
    };
  } catch (e) {
    startPollingFallback();
  }
}

function startPollingFallback() {
  if (pollingInterval) return;
  pollingInterval = setInterval(async () => {
    try {
      const res = await fetch("/api/telemetry");
      if (res.ok) {
        const data = await res.json();
        handleTelemetryUpdate(data);
      }
    } catch (e) {
      // transient network wait
    }
  }, 750);
}

// ==========================================================================
// 7. TELEMETRY DISPATCHER & UI STATE SYNCHRONIZATION
// ==========================================================================

function handleTelemetryUpdate(data) {
  if (!data) return;

  const t = data.telemetry || {};
  const a = data.attendance || {};
  const i = data.interaction || {};
  const participants = data.participants || [];
  const s = data.latest_suggestion;
  const isSim = data.use_simulation;
  const isPaused = data.is_paused;

  // Header Status Bar
  updateHeaderStatus(isPaused, isSim);

  // Section 1: Overview KPIs
  updateOverviewView(t, a, i, data.fps, data.latency_ms);

  // Section 2: Live Classroom HUD
  updateLiveClassroomView(participants, isSim, data.fps, data.latency_ms, data.camera_error);

  // Section 3: Attendance State Cache & Table
  if (a.records) {
    cachedAttendanceRoster = a.records;
    renderAttendanceRows();
  }

  // Section 4: Analytics Charts Timeseries
  updateChartsData(t);

  // Section 5: AI Recommendations Copilot
  if (s && s.id && !knownSuggestionIds.has(s.id)) {
    knownSuggestionIds.add(s.id);
    prependRecommendation(s);
    addNotificationAlert(s.title, s.priority, s.suggestion);
    showToast(`AI Alert: ${s.title}`, s.priority === "urgent" ? "error" : "info");
  }

  // Record Recent Events
  logTelemetryEvent(t, participants);
}

function updateHeaderStatus(isPaused, isSim) {
  const statusBadge = document.getElementById("header-session-status");
  const statusText = document.getElementById("session-status-text");
  const pauseBtn = document.getElementById("btn-pause-session");
  const resumeBtn = document.getElementById("btn-resume-session");
  const modeBadge = document.getElementById("header-mode-badge");

  if (isPaused) {
    if (statusBadge) statusBadge.className = "session-status-badge status-paused";
    if (statusText) statusText.innerText = "PAUSED";
    if (pauseBtn) pauseBtn.classList.add("hidden");
    if (resumeBtn) resumeBtn.classList.remove("hidden");
  } else {
    if (statusBadge) statusBadge.className = "session-status-badge status-live";
    if (statusText) statusText.innerText = "LIVE SESSION";
    if (pauseBtn) pauseBtn.classList.remove("hidden");
    if (resumeBtn) resumeBtn.classList.add("hidden");
  }

  if (modeBadge) {
    modeBadge.innerText = isSim ? "Simulation Mode" : "Physical Camera";
    modeBadge.className = isSim ? "chip chip-mode" : "chip";
  }

  // Duration counter calculation
  const elapsedSec = Math.floor((Date.now() - sessionStartEpoch) / 1000);
  const hrs = String(Math.floor(elapsedSec / 3600)).padStart(2, '0');
  const mins = String(Math.floor((elapsedSec % 3600) / 60)).padStart(2, '0');
  const secs = String(elapsedSec % 60).padStart(2, '0');
  const durationEl = document.getElementById("header-session-duration");
  if (durationEl) durationEl.innerText = `${hrs}:${mins}:${secs}`;
}

function updateOverviewView(t, a, i, fps, latency) {
  // 1. Composite Engagement KPI
  const engVal = t.overall_engagement !== undefined ? Math.round(t.overall_engagement) : "--";
  const engValEl = document.getElementById("overview-engagement-val");
  const engBarEl = document.getElementById("overview-engagement-bar");
  if (engValEl) engValEl.innerText = engVal;
  if (engBarEl) engBarEl.style.width = `${typeof engVal === 'number' ? engVal : 0}%`;

  const trendEl = document.getElementById("kpi-trend");
  const trend = t.trend || "Steady";
  if (trendEl) {
    trendEl.innerText = trend;
    trendEl.className = "trend-pill " + trend.toLowerCase().replace(" ", "-");
  }

  // 2. Attendance Stat Counts
  if (a.present_count !== undefined) {
    const rateEl = document.getElementById("overview-attendance-rate");
    const barEl = document.getElementById("overview-attendance-bar");
    const presentEl = document.getElementById("overview-present-cnt");
    const presentStatEl = document.getElementById("overview-present-stat");
    const partialEl = document.getElementById("overview-partial-cnt");
    const absentEl = document.getElementById("overview-absent-cnt");
    const unverifiedEl = document.getElementById("overview-unverified-cnt");
    const enrolledEl = document.getElementById("overview-enrolled-summary");

    if (rateEl) rateEl.innerText = `${a.attendance_rate}%`;
    if (barEl) barEl.style.width = `${a.attendance_rate}%`;
    if (presentEl) presentEl.innerText = a.present_count;
    if (presentStatEl) presentStatEl.innerText = a.present_count;
    if (partialEl) partialEl.innerText = a.partial_count;
    if (absentEl) absentEl.innerText = a.absent_count;
    if (unverifiedEl) unverifiedEl.innerText = a.unverified_count || 0;
    if (enrolledEl) enrolledEl.innerText = `of ${a.total_enrolled} enrolled`;
  }

  // 3. Visual Pose Proxy
  const poseVal = t.head_pose_score !== null && t.head_pose_score !== undefined ? Math.round(t.head_pose_score) : "--";
  const poseValEl = document.getElementById("overview-pose-val");
  const poseBarEl = document.getElementById("overview-pose-bar");
  if (poseValEl) poseValEl.innerText = poseVal;
  if (poseBarEl) poseBarEl.style.width = `${typeof poseVal === 'number' ? poseVal : 0}%`;

  // 4. Audio Activity Proxy
  const audioVal = t.audio_score !== null && t.audio_score !== undefined ? Math.round(t.audio_score) : "--";
  const audioValEl = document.getElementById("overview-audio-val");
  const audioBarEl = document.getElementById("overview-audio-bar");
  const audioStateEl = document.getElementById("overview-audio-state");
  const talkRatioEl = document.getElementById("overview-talk-ratio-label");

  if (audioValEl) audioValEl.innerText = audioVal;
  if (audioBarEl) audioBarEl.style.width = `${typeof audioVal === 'number' ? audioVal : 0}%`;
  if (audioStateEl) audioStateEl.innerText = t.is_speech ? "Active Speech" : "Silent";
  if (talkRatioEl) talkRatioEl.innerText = `Talk Ratio: ${Math.round((i.talk_ratio || 0) * 100)}%`;

  // 5. Mini Stream Badges
  if (fps !== undefined) {
    const miniFps = document.getElementById("mini-stream-fps");
    const miniLat = document.getElementById("mini-stream-latency");
    if (miniFps) miniFps.innerText = `${fps} FPS`;
    if (miniLat) miniLat.innerText = `${latency}ms Latency`;
  }

  // Analytics Comparison Current Value
  const compEl = document.getElementById("comp-this-session");
  if (compEl && engVal !== "--") compEl.innerText = `${engVal}%`;
}

function updateLiveClassroomView(participants, isSim, fps, latency, cameraError) {
  currentIsSim = isSim;
  const sourceLabel = isSim ? "Source: Simulation" : "Source: Physical Camera";

  const tagSource = document.getElementById("live-tag-source");
  const countEl = document.getElementById("live-participant-count");
  if (tagSource) tagSource.innerText = sourceLabel;
  if (countEl) countEl.innerText = `${participants.length} Tracked`;

  // Badges
  const tagFps = document.getElementById("live-tag-fps");
  if (tagFps && fps !== undefined) tagFps.innerText = `FPS: ${fps}`;

  const hudFps = document.getElementById("live-stream-fps-badge");
  if (hudFps && fps !== undefined) hudFps.innerText = `${fps} FPS`;

  const hudLatency = document.getElementById("live-stream-latency-badge");
  if (hudLatency && latency !== undefined) hudLatency.innerText = `${latency}ms`;

  const hudRes = document.getElementById("live-stream-res-badge");
  const mainStream = document.getElementById("live-main-stream");
  if (hudRes && mainStream && mainStream.naturalWidth > 0) {
    const resText = `${mainStream.naturalWidth}x${mainStream.naturalHeight}`;
    hudRes.innerText = resText;
    const tagRes = document.getElementById("live-tag-res");
    if (tagRes) tagRes.innerText = resText;
  }

  // Hardware status in sidebar footer
  const camDot = document.getElementById("cam-status-dot");
  const camText = document.getElementById("cam-status-text");
  if (camText) camText.innerText = isSim ? "Simulation Active" : "Webcam Live";
  if (camDot) camDot.className = "sensor-indicator sensor-live";

  // Participant cards container in Live Classroom
  const container = document.getElementById("live-participants-container");
  if (!container) return;

  if (!participants || participants.length === 0) {
    container.innerHTML = `<div class="empty-state">No face tracks currently detected in camera view.</div>`;
    return;
  }

  container.innerHTML = "";
  participants.forEach(p => {
    const card = document.createElement("div");
    card.className = "participant-card";

    let badgeClass = "badge-attentive";
    if (p.state.includes("Down") || p.state.includes("Notes")) badgeClass = "badge-down";
    else if (p.state.includes("Away") || p.state.includes("Inattentive")) badgeClass = "badge-away";

    card.innerHTML = `
      <div class="participant-card-header">
        <span class="participant-name">#${p.track_id} ${escapeHtml(p.display_name)}</span>
        <span class="participant-badge ${badgeClass}">${escapeHtml(p.state)}</span>
      </div>
      <div class="participant-metrics">
        <span>Attn: ${Math.round(p.attentiveness_score * 100)}%</span>
        <span>Motion: ${Math.round(p.motion_score * 100)}%</span>
        <span>${p.is_inactive ? 'Inactive (' + p.inactivity_seconds + 's)' : 'Active'}</span>
      </div>
    `;
    container.appendChild(card);
  });
}

function logTelemetryEvent(t, participants) {
  const timeline = document.getElementById("overview-events-timeline");
  if (!timeline) return;

  // Add event on significant shifts
  const now = new Date();
  const timeStr = now.toTimeString().split(" ")[0];

  if (recentClassroomEvents.length === 0 || (Date.now() - recentClassroomEvents[0].ts > 15000)) {
    const desc = participants.length > 0 
      ? `Telemetry sample: ${participants.length} students detected in camera frame. Engagement index ${Math.round(t.overall_engagement || 70)}%.`
      : `Classroom observation window refreshed. Acoustic monitoring active.`;

    recentClassroomEvents.unshift({ ts: Date.now(), timeStr, type: "MONITOR", desc });
    if (recentClassroomEvents.length > 8) recentClassroomEvents.pop();

    renderEventsTimeline();
  }
}

function renderEventsTimeline() {
  const timeline = document.getElementById("overview-events-timeline");
  if (!timeline) return;

  timeline.innerHTML = "";
  recentClassroomEvents.forEach(e => {
    const row = document.createElement("div");
    row.className = "event-row";
    row.innerHTML = `
      <span class="event-time">${e.timeStr}</span>
      <span class="event-type-badge">${e.type}</span>
      <span class="event-text">${escapeHtml(e.desc)}</span>
    `;
    timeline.appendChild(row);
  });
}

// ==========================================================================
// 8. INTERACTIVE CHART.JS (Overview & Analytics Views)
// ==========================================================================

function initCharts() {
  for (let i = 0; i < maxDataPoints; i++) {
    chartLabels.push("");
    engSeries.push(null);
    poseSeries.push(null);
    motionSeries.push(null);
    audioSeries.push(null);
  }

  const isLight = currentTheme === "light";
  const gridColor = isLight ? "rgba(0, 0, 0, 0.06)" : "rgba(255, 255, 255, 0.06)";
  const tickColor = isLight ? "#64748B" : "#94A3B8";

  const chartConfig = {
    type: "line",
    data: {
      labels: chartLabels,
      datasets: [
        {
          label: "Overall Engagement",
          data: engSeries,
          borderColor: "#2563EB",
          backgroundColor: "rgba(37, 99, 235, 0.12)",
          fill: true,
          tension: 0.35,
          borderWidth: 2.5,
          pointRadius: 0
        },
        {
          label: "Visual Attention",
          data: poseSeries,
          borderColor: "#06B6D4",
          borderWidth: 1.5,
          borderDash: [4, 4],
          pointRadius: 0,
          fill: false,
          tension: 0.3
        },
        {
          label: "Movement Dynamics",
          data: motionSeries,
          borderColor: "#10B981",
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
          tension: 0.3
        },
        {
          label: "Audio Activity",
          data: audioSeries,
          borderColor: "#F59E0B",
          borderWidth: 1.5,
          borderDash: [2, 2],
          pointRadius: 0,
          fill: false,
          tension: 0.3
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 },
      scales: {
        y: {
          min: 0,
          max: 100,
          grid: { color: gridColor },
          ticks: { color: tickColor, font: { size: 10 } }
        },
        x: { display: false }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: isLight ? "#1E293B" : "#1F2937",
          titleColor: "#FFFFFF",
          bodyColor: "#94A3B8"
        }
      }
    }
  };

  // 1. Overview Chart
  const ctxOverview = document.getElementById("overview-timeseries-chart");
  if (ctxOverview) {
    overviewChart = new Chart(ctxOverview.getContext("2d"), JSON.parse(JSON.stringify(chartConfig)));
  }

  // 2. Analytics Chart
  const ctxAnalytics = document.getElementById("analytics-timeseries-chart");
  if (ctxAnalytics) {
    analyticsChart = new Chart(ctxAnalytics.getContext("2d"), JSON.parse(JSON.stringify(chartConfig)));
  }

  // Range Selector Buttons
  document.querySelectorAll(".btn-chart-range").forEach(b => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".btn-chart-range").forEach(btn => btn.classList.remove("active"));
      b.classList.add("active");
      maxDataPoints = parseInt(b.getAttribute("data-points"), 10);
      trimChartSeries();
    });
  });
}

function updateChartsData(t) {
  if (t.overall_engagement === undefined) return;

  chartLabels.push("");
  engSeries.push(t.overall_engagement);
  poseSeries.push(t.head_pose_score);
  motionSeries.push(t.movement_score);
  audioSeries.push(t.audio_score);

  trimChartSeries();

  if (overviewChart && currentActiveViewId === "view-overview") {
    overviewChart.update();
  }
  if (analyticsChart && currentActiveViewId === "view-analytics") {
    analyticsChart.update();
  }

  // Dynamic weights breakdown in Analytics View
  if (t.formula_contribution) {
    const c = t.formula_contribution;
    const container = document.getElementById("analytics-weights-breakdown");
    if (container) {
      container.innerHTML = `
        <div class="weight-row">
          <div class="weight-row-label"><span>Visual Head Pose</span><span>${c.head_pose}</span></div>
          <div class="progress-track"><div class="progress-bar bar-cyan" style="width: ${c.head_pose}"></div></div>
        </div>
        <div class="weight-row">
          <div class="weight-row-label"><span>Physical Movement</span><span>${c.movement}</span></div>
          <div class="progress-track"><div class="progress-bar" style="width: ${c.movement}"></div></div>
        </div>
        <div class="weight-row">
          <div class="weight-row-label"><span>Acoustic Energy</span><span>${c.audio}</span></div>
          <div class="progress-track"><div class="progress-bar bar-amber" style="width: ${c.audio}"></div></div>
        </div>
      `;
    }
  }

  // Sensor Coverage badge in Analytics View
  if (t.sensor_coverage !== undefined) {
    const cov = Math.round(t.sensor_coverage * 100);
    const badge = document.getElementById("coverage-percentage-badge");
    const details = document.getElementById("sensor-coverage-details");
    if (badge) badge.innerText = `${cov}%`;
    if (details) details.innerText = `${cov}% Sensory Coverage (${t.active_sensors ? t.active_sensors.join(", ") : 'None'})`;
  }
}

function trimChartSeries() {
  while (chartLabels.length > maxDataPoints) {
    chartLabels.shift();
    engSeries.shift();
    poseSeries.shift();
    motionSeries.shift();
    audioSeries.shift();
  }
}

// ==========================================================================
// 9. ATTENDANCE MANAGEMENT & AUDIT LOGS
// ==========================================================================

function initAttendanceControls() {
  const searchInput = document.getElementById("attendance-search");
  const filterSelect = document.getElementById("attendance-filter-status");

  if (searchInput) searchInput.addEventListener("input", renderAttendanceRows);
  if (filterSelect) filterSelect.addEventListener("change", renderAttendanceRows);

  const auditBtn = document.getElementById("btn-view-audit-logs");
  if (auditBtn) auditBtn.addEventListener("click", loadAuditLogs);

  // Column header sorting
  document.querySelectorAll("#table-attendance th.sortable").forEach(th => {
    th.addEventListener("click", () => {
      const col = th.getAttribute("data-sort");
      if (attendanceSortColumn === col) {
        attendanceSortAsc = !attendanceSortAsc;
      } else {
        attendanceSortColumn = col;
        attendanceSortAsc = true;
      }
      renderAttendanceRows();
    });
  });
}

function refreshAttendanceTable() {
  fetch(`/api/attendance/summary?session_id=${activeSessionId}`)
    .then(r => r.json())
    .then(data => {
      if (data.records) {
        cachedAttendanceRoster = data.records;
        renderAttendanceRows();
      }
    })
    .catch(console.error);
}

function renderAttendanceRows() {
  const tbody = document.getElementById("attendance-table-body");
  if (!tbody) return;

  const search = (document.getElementById("attendance-search")?.value || "").toLowerCase();
  const filter = document.getElementById("attendance-filter-status")?.value || "ALL";

  tbody.innerHTML = "";

  // 1. Filter
  let filtered = cachedAttendanceRoster.filter(r => {
    const matchesSearch = (r.name || "").toLowerCase().includes(search) ||
                          (r.roll_no || "").toLowerCase().includes(search) ||
                          (r.student_id || "").toLowerCase().includes(search);
    const matchesFilter = filter === "ALL" || r.status === filter;
    return matchesSearch && matchesFilter;
  });

  // 2. Sort
  filtered.sort((a, b) => {
    let valA = a[attendanceSortColumn] || "";
    let valB = b[attendanceSortColumn] || "";
    if (typeof valA === "number" && typeof valB === "number") {
      return attendanceSortAsc ? valA - valB : valB - valA;
    }
    return attendanceSortAsc 
      ? String(valA).localeCompare(String(valB)) 
      : String(valB).localeCompare(String(valA));
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="12" style="text-align: center; color: var(--text-dim); padding: 2rem;">No matching attendance records found.</td></tr>`;
    return;
  }

  filtered.forEach(r => {
    const tr = document.createElement("tr");

    let statusPillClass = "absent";
    if (r.status === "Present") statusPillClass = "present";
    else if (r.status === "Partial") statusPillClass = "partial";
    else if (r.status === "Unverified") statusPillClass = "unverified";

    // Flags
    let flagsHtml = "";
    if (r.is_late) flagsHtml += `<span class="tag-flag tag-late">Late</span> `;
    if (r.is_early_departure) flagsHtml += `<span class="tag-flag tag-early">Early Dep.</span> `;
    if (r.manual_correction) flagsHtml += `<span class="tag-flag" style="background: rgba(37,99,235,0.15); color: var(--color-primary);">Manual</span>`;
    if (!flagsHtml) flagsHtml = "-";

    const firstTime = r.first_detected ? r.first_detected.split("T").pop().split(".")[0] : "--";
    const lastTime = r.last_detected ? r.last_detected.split("T").pop().split(".")[0] : "--";

    tr.innerHTML = `
      <td style="font-family: var(--font-mono); font-size: 0.78rem;">${escapeHtml(r.roll_no)}</td>
      <td style="font-weight: 700; color: var(--text-main);">${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.section || 'Section A')}</td>
      <td><span class="status-pill ${statusPillClass}">${escapeHtml(r.status)}</span></td>
      <td><strong>${r.sustained_seconds}s</strong></td>
      <td>${Math.round(r.presence_ratio * 100)}%</td>
      <td>${Math.round(r.confidence * 100)}%</td>
      <td style="font-family: var(--font-mono); font-size: 0.72rem; color: var(--text-muted);">${firstTime}</td>
      <td style="font-family: var(--font-mono); font-size: 0.72rem; color: var(--text-muted);">${lastTime}</td>
      <td>${flagsHtml}</td>
      <td style="font-size: 0.74rem; color: var(--text-muted); max-width: 200px;">${escapeHtml(r.verification_reason)}</td>
      <td>
        <button class="btn btn-xs btn-secondary" onclick="openCorrectionModal('${r.student_id}', '${escapeHtml(r.name)}', '${escapeHtml(r.roll_no)}', '${r.status}')">
          Edit
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function openCorrectionModal(studentId, name, rollNo, currentStatus) {
  editingStudentId = studentId;
  document.getElementById("modal-student-name").innerText = name;
  document.getElementById("modal-student-roll").innerText = rollNo;
  document.getElementById("modal-select-status").value = currentStatus;
  document.getElementById("modal-input-reason").value = "";
  openModal("modal-correction");
}

async function submitAttendanceCorrection() {
  if (!editingStudentId) return;

  const newStatus = document.getElementById("modal-select-status").value;
  const reason = document.getElementById("modal-input-reason").value.trim();

  if (!reason) {
    showToast("Please provide an audit explanation for this override.", "error");
    return;
  }

  try {
    const res = await fetch("/api/attendance/correct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        student_id: editingStudentId,
        new_status: newStatus,
        reason: reason,
        instructor_id: "Prof. Johnson"
      })
    });

    if (res.ok) {
      showToast("Attendance updated successfully.", "success");
      closeModal("modal-correction");
      refreshAttendanceTable();
    } else {
      showToast("Failed to update attendance.", "error");
    }
  } catch (err) {
    showToast("Network error submitting correction.", "error");
  }
}

async function loadAuditLogs() {
  try {
    const res = await fetch(`/api/attendance/audit-trail?session_id=${activeSessionId}`);
    if (res.ok) {
      const logs = await res.json();
      const tbody = document.getElementById("audit-trail-tbody");
      tbody.innerHTML = "";
      if (logs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-dim); padding: 1.5rem;">No manual overrides recorded for this session.</td></tr>`;
      } else {
        logs.forEach(l => {
          const tr = document.createElement("tr");
          tr.innerHTML = `
            <td style="font-family: var(--font-mono); font-size: 0.75rem;">${escapeHtml(l.timestamp)}</td>
            <td>${escapeHtml(l.student_id)}</td>
            <td><span class="status-pill">${escapeHtml(l.previous_status)}</span></td>
            <td><span class="status-pill present">${escapeHtml(l.new_status)}</span></td>
            <td>${escapeHtml(l.changed_by)}</td>
            <td style="font-size: 0.78rem;">${escapeHtml(l.reason)}</td>
          `;
          tbody.appendChild(tr);
        });
      }
      openModal("modal-audit-trail");
    }
  } catch (err) {
    showToast("Failed to fetch audit trail.", "error");
  }
}

// ==========================================================================
// 10. AI TEACHING ASSISTANT RECOMMENDATIONS
// ==========================================================================

function prependRecommendation(s) {
  // 1. Overview snippet
  const overviewContainer = document.getElementById("overview-copilot-container");
  if (overviewContainer) {
    const emptyEl = overviewContainer.querySelector(".empty-state");
    if (emptyEl) emptyEl.remove();

    const miniCard = document.createElement("div");
    miniCard.className = `recommendation-card ${s.priority || 'info'}`;
    miniCard.innerHTML = `
      <div class="rec-header">
        <span class="rec-title">${escapeHtml(s.title)}</span>
        <span class="rec-time">${s.timestamp ? s.timestamp.split(" ")[1] || s.timestamp : ''}</span>
      </div>
      <div class="rec-suggestion">${escapeHtml(s.suggestion)}</div>
    `;
    overviewContainer.prepend(miniCard);
  }

  // 2. Full Copilot View Card
  const copilotContainer = document.getElementById("copilot-recommendations-list");
  if (copilotContainer) {
    const emptyEl = copilotContainer.querySelector(".empty-state");
    if (emptyEl) emptyEl.remove();

    const fullCard = document.createElement("div");
    fullCard.className = `recommendation-card ${s.priority || 'info'}`;
    fullCard.id = `rec-card-${s.id}`;
    fullCard.setAttribute("data-priority", s.priority || "info");

    fullCard.innerHTML = `
      <div class="rec-header">
        <div class="rec-title-group">
          <span class="rec-badge ${s.priority || 'info'}">${escapeHtml((s.priority || 'INFO').toUpperCase())}</span>
          <span class="rec-title">${escapeHtml(s.title)}</span>
        </div>
        <span class="rec-time">${s.timestamp || ''}</span>
      </div>
      <div class="rec-suggestion">${escapeHtml(s.suggestion)}</div>
      <div class="rec-details-grid">
        <div class="rec-rationale"><strong>Triggering Signal:</strong> ${escapeHtml(s.triggering_signal || s.rationale)}</div>
        <div class="rec-purpose"><strong>Pedagogical Purpose:</strong> ${escapeHtml(s.instructional_purpose || 'Instructional pacing')}</div>
      </div>
      <div class="rec-actions">
        <button class="btn btn-xs btn-secondary" onclick="handleRecFeedback(${s.id}, false, true)">Helpful</button>
        <button class="btn btn-xs btn-secondary" onclick="handleRecFeedback(${s.id}, true, null)">Dismiss</button>
      </div>
    `;
    copilotContainer.prepend(fullCard);
  }

  // Update badge count in sidebar
  const countBadge = document.getElementById("nav-rec-count");
  if (countBadge) {
    countBadge.innerText = parseInt(countBadge.innerText || "0", 10) + 1;
  }
}

async function loadAllRecommendations() {
  try {
    const res = await fetch(`/api/recommendations?session_id=${activeSessionId}`);
    if (res.ok) {
      const list = await res.json();
      const container = document.getElementById("copilot-recommendations-list");
      if (!container) return;
      container.innerHTML = "";

      if (list.length === 0) {
        container.innerHTML = `<div class="empty-state">No active recommendations. Classroom pacing is within optimal thresholds.</div>`;
      } else {
        list.forEach(s => prependRecommendation(s));
      }
    }
  } catch (err) {
    console.error("Failed to load recommendations:", err);
  }
}

async function handleRecFeedback(recId, isDismissed, isHelpful) {
  try {
    await fetch(`/api/recommendations/${recId}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_dismissed: isDismissed, is_helpful: isHelpful })
    });

    if (isDismissed) {
      const el = document.getElementById(`rec-card-${recId}`);
      if (el) el.remove();
      showToast("Recommendation dismissed.", "info");
    } else if (isHelpful) {
      showToast("Recorded: Marked as helpful.", "success");
    }
  } catch (err) {
    console.error("Failed to post feedback:", err);
  }
}

// ==========================================================================
// 11. SESSION HISTORY & ARCHIVED REPORTS
// ==========================================================================

async function loadSessionHistory() {
  try {
    const res = await fetch("/api/sessions?limit=50");
    if (res.ok) {
      const sessions = await res.json();
      const tbody = document.getElementById("sessions-history-tbody");
      if (!tbody) return;
      tbody.innerHTML = "";

      if (sessions.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; color: var(--text-dim); padding: 2rem;">No previous sessions recorded.</td></tr>`;
        return;
      }

      // Aggregate Stats calculation
      const totalSessions = sessions.length;
      let totalAtt = 0;
      let totalEng = 0;

      sessions.forEach(s => {
        const rate = (s.total_present / Math.max(1, s.total_enrolled)) * 100;
        totalAtt += rate;
        totalEng += (s.avg_engagement || 70);

        const tr = document.createElement("tr");
        const statusBadge = s.is_active 
          ? `<span class="status-pill present">Active</span>` 
          : `<span class="status-pill unverified">Completed</span>`;

        tr.innerHTML = `
          <td style="font-family: var(--font-mono); font-size: 0.78rem;">${escapeHtml(s.session_id)}</td>
          <td style="font-weight: 700; color: var(--text-main);">${escapeHtml(s.title)}</td>
          <td>${escapeHtml(s.section)}</td>
          <td>${escapeHtml(s.instructor_name)}</td>
          <td style="font-size: 0.75rem;">${escapeHtml(s.start_time)}</td>
          <td>${s.total_enrolled}</td>
          <td style="font-weight: 700; color: var(--accent-emerald);">${s.total_present}</td>
          <td>${Math.round(s.avg_engagement || 70)}%</td>
          <td>${statusBadge}</td>
          <td>
            <a href="/api/attendance/export/csv?session_id=${s.session_id}" class="btn btn-xs btn-secondary" download>CSV</a>
            <a href="/api/attendance/export/json?session_id=${s.session_id}" class="btn btn-xs btn-secondary" download>JSON</a>
          </td>
        `;
        tbody.appendChild(tr);
      });

      const avgAttendance = Math.round(totalAtt / totalSessions);
      const avgEngagement = Math.round(totalEng / totalSessions);

      const totEl = document.getElementById("history-total-sessions");
      const attEl = document.getElementById("history-avg-attendance");
      const engEl = document.getElementById("history-avg-engagement");

      if (totEl) totEl.innerText = totalSessions;
      if (attEl) attEl.innerText = `${avgAttendance}%`;
      if (engEl) engEl.innerText = `${avgEngagement}%`;
    }
  } catch (err) {
    console.error("Failed to load session history:", err);
  }
}

// ==========================================================================
// 12. STUDENT MANAGEMENT CRUD (Section 7)
// ==========================================================================

function initStudentControls() {
  const searchInput = document.getElementById("student-search");
  const filterSelect = document.getElementById("student-filter-section");
  const addBtn = document.getElementById("btn-add-student-modal");

  if (searchInput) searchInput.addEventListener("input", renderStudentsRows);
  if (filterSelect) filterSelect.addEventListener("change", renderStudentsRows);

  if (addBtn) {
    addBtn.addEventListener("click", () => {
      document.getElementById("new-student-id").value = `S${Math.floor(100 + Math.random() * 900)}`;
      document.getElementById("new-student-roll").value = `2024-CS-0${Math.floor(7 + Math.random() * 20)}`;
      document.getElementById("new-student-name").value = "";
      openModal("modal-add-student");
    });
  }

  // Submit Add Student
  const submitAdd = document.getElementById("btn-submit-add-student");
  if (submitAdd) {
    submitAdd.addEventListener("click", async () => {
      const studentId = document.getElementById("new-student-id").value.trim();
      const rollNo = document.getElementById("new-student-roll").value.trim();
      const name = document.getElementById("new-student-name").value.trim();
      const section = document.getElementById("new-student-section").value.trim() || "Section A";

      if (!studentId || !rollNo || !name) {
        showToast("Please fill all required student fields.", "error");
        return;
      }

      try {
        const res = await fetch("/api/roster", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            student_id: studentId,
            roll_no: rollNo,
            name: name,
            section: section
          })
        });

        if (res.ok) {
          showToast(`Enrolled student ${name} successfully.`, "success");
          closeModal("modal-add-student");
          loadStudentsTable();
          refreshAttendanceTable();
        } else {
          const err = await res.json();
          showToast(`Error: ${err.detail || "Failed to add student."}`, "error");
        }
      } catch (e) {
        showToast("Network error creating student.", "error");
      }
    });
  }

  // Submit Edit Student
  const submitEdit = document.getElementById("btn-submit-edit-student");
  if (submitEdit) {
    submitEdit.addEventListener("click", async () => {
      const studentId = document.getElementById("edit-student-id").value;
      const rollNo = document.getElementById("edit-student-roll").value.trim();
      const name = document.getElementById("edit-student-name").value.trim();
      const section = document.getElementById("edit-student-section").value.trim();

      if (!rollNo || !name) {
        showToast("Roll number and name are required.", "error");
        return;
      }

      try {
        const res = await fetch(`/api/roster/${studentId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roll_no: rollNo, name: name, section: section })
        });

        if (res.ok) {
          showToast("Student updated successfully.", "success");
          closeModal("modal-edit-student");
          loadStudentsTable();
          refreshAttendanceTable();
        } else {
          showToast("Failed to update student.", "error");
        }
      } catch (e) {
        showToast("Network error updating student.", "error");
      }
    });
  }

  // Confirm Delete Student
  const confirmDelete = document.getElementById("btn-confirm-delete-student");
  if (confirmDelete) {
    confirmDelete.addEventListener("click", async () => {
      const studentId = document.getElementById("delete-student-id").value;
      try {
        const res = await fetch(`/api/roster/${studentId}`, { method: "DELETE" });
        if (res.ok) {
          showToast("Student deleted from roster.", "info");
          closeModal("modal-delete-student");
          loadStudentsTable();
          refreshAttendanceTable();
        } else {
          showToast("Failed to delete student.", "error");
        }
      } catch (e) {
        showToast("Network error deleting student.", "error");
      }
    });
  }
}

async function loadStudentsTable() {
  try {
    const res = await fetch("/api/roster");
    if (res.ok) {
      cachedStudentsList = await res.json();
      renderStudentsRows();
    }
  } catch (err) {
    console.error("Failed to load roster:", err);
  }
}

function renderStudentsRows() {
  const tbody = document.getElementById("students-table-body");
  if (!tbody) return;

  const search = (document.getElementById("student-search")?.value || "").toLowerCase();
  const filter = document.getElementById("student-filter-section")?.value || "ALL";

  tbody.innerHTML = "";

  const filtered = cachedStudentsList.filter(s => {
    const matchesSearch = (s.name || "").toLowerCase().includes(search) ||
                          (s.roll_no || "").toLowerCase().includes(search) ||
                          (s.student_id || "").toLowerCase().includes(search);
    const matchesSection = filter === "ALL" || s.section === filter;
    return matchesSearch && matchesSection;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-dim); padding: 2rem;">No matching students found in roster.</td></tr>`;
    return;
  }

  filtered.forEach(s => {
    const tr = document.createElement("tr");
    const biometricBadge = s.has_biometric_enrolled
      ? `<span class="status-pill present">Enrolled</span>`
      : `<span class="status-pill unverified">Anonymous / Track ID</span>`;

    tr.innerHTML = `
      <td style="font-family: var(--font-mono); font-size: 0.80rem;">${escapeHtml(s.student_id)}</td>
      <td style="font-family: var(--font-mono); font-size: 0.80rem; font-weight: 600;">${escapeHtml(s.roll_no)}</td>
      <td style="font-weight: 700; color: var(--text-main);">${escapeHtml(s.name)}</td>
      <td>${escapeHtml(s.section || 'Section A')}</td>
      <td>${biometricBadge}</td>
      <td>
        <div style="display: flex; gap: 0.45rem;">
          <button class="btn btn-xs btn-secondary" onclick="openEditStudentModal('${s.student_id}', '${escapeHtml(s.roll_no)}', '${escapeHtml(s.name)}', '${escapeHtml(s.section)}')">Edit</button>
          <button class="btn btn-xs btn-danger" onclick="openDeleteStudentModal('${s.student_id}', '${escapeHtml(s.name)}')">Delete</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function openEditStudentModal(id, roll, name, section) {
  document.getElementById("edit-student-id").value = id;
  document.getElementById("edit-student-roll").value = roll;
  document.getElementById("edit-student-name").value = name;
  document.getElementById("edit-student-section").value = section || "Section A";
  openModal("modal-edit-student");
}

function openDeleteStudentModal(id, name) {
  document.getElementById("delete-student-id").value = id;
  document.getElementById("delete-student-name").innerText = name;
  document.getElementById("delete-student-id-display").innerText = id;
  openModal("modal-delete-student");
}

// ==========================================================================
// 13. SETTINGS & PRIVACY CONTROLS (Section 8)
// ==========================================================================

function initSettingsControls() {
  const saveBtn = document.getElementById("btn-save-settings");
  if (saveBtn) saveBtn.addEventListener("click", saveSettingsData);

  const pruneBtn = document.getElementById("btn-prune-retention");
  if (pruneBtn) {
    pruneBtn.addEventListener("click", async () => {
      const days = parseInt(document.getElementById("set-retention-days")?.value, 10) || 30;
      try {
        const res = await fetch(`/api/settings/retention/prune?days=${days}`, { method: "POST" });
        const data = await res.json();
        showToast(`Pruned ${data.sessions_pruned} sessions older than ${days} days.`, "success");
      } catch (e) {
        showToast("Failed to prune retention records.", "error");
      }
    });
  }

  const backupBtn = document.getElementById("btn-backup-db");
  if (backupBtn) {
    backupBtn.addEventListener("click", async () => {
      try {
        const res = await fetch("/api/settings/backup", { method: "POST" });
        const data = await res.json();
        showToast(`Snapshot created: ${data.backup_file.split('\\').pop()}`, "success");
      } catch (e) {
        showToast("Failed to create database snapshot.", "error");
      }
    });
  }

  // Sliders value mirrors
  const sHead = document.getElementById("slider-weight-head");
  const sMotion = document.getElementById("slider-weight-motion");
  const sAudio = document.getElementById("slider-weight-audio");

  if (sHead) sHead.addEventListener("input", () => document.getElementById("val-weight-head").innerText = sHead.value);
  if (sMotion) sMotion.addEventListener("input", () => document.getElementById("val-weight-motion").innerText = sMotion.value);
  if (sAudio) sAudio.addEventListener("input", () => document.getElementById("val-weight-audio").innerText = sAudio.value);

  // Quick blur toggles
  const quickBlur = document.getElementById("btn-quick-privacy");
  const liveBlur = document.getElementById("btn-toggle-blur-live");
  if (quickBlur) quickBlur.addEventListener("click", togglePrivacyBlur);
  if (liveBlur) liveBlur.addEventListener("click", togglePrivacyBlur);

  // Toggle Camera Source in View 2
  const toggleCamBtn = document.getElementById("btn-toggle-camera-src");
  if (toggleCamBtn) {
    toggleCamBtn.addEventListener("click", async () => {
      const isSimNow = document.getElementById("live-tag-source")?.innerText.includes("Simulation");
      const nextSim = !isSimNow;

      const statusEl = document.getElementById("video-feed-status");
      if (statusEl) {
        statusEl.innerText = nextSim ? "Activating Simulation Mode..." : "Initializing Physical Camera...";
      }
      const loadingOverlay = document.getElementById("video-stream-loading");
      if (loadingOverlay) loadingOverlay.classList.remove("hidden");

      try {
        await postSettingsUpdate({ use_simulation: nextSim });
        showToast(nextSim ? "Simulation Mode Activated" : "Connecting to Physical Camera...", "info");
        setTimeout(reconnectLiveStream, 350);
      } catch (err) {
        showToast("Failed to switch source: " + err.message, "error");
        reconnectLiveStream();
      }
    });
  }
}

async function loadSettingsData() {
  try {
    const res = await fetch("/api/settings");
    if (res.ok) {
      const s = await res.json();
      const blurCb = document.getElementById("set-privacy-blur");
      const bioCb = document.getElementById("set-biometric-matching");
      const retInp = document.getElementById("set-retention-days");
      const winInp = document.getElementById("set-window-duration");
      const presInp = document.getElementById("set-presence-ratio");

      if (blurCb) blurCb.checked = s.anonymize_faces;
      if (bioCb) bioCb.checked = s.biometric_matching_enabled;
      if (retInp) retInp.value = s.data_retention_days;
      if (winInp) winInp.value = s.window_duration_seconds;
      if (presInp) presInp.value = s.sustained_presence_ratio;

      const sHead = document.getElementById("slider-weight-head");
      const sMotion = document.getElementById("slider-weight-motion");
      const sAudio = document.getElementById("slider-weight-audio");

      if (sHead) {
        sHead.value = s.weight_head_pose;
        document.getElementById("val-weight-head").innerText = s.weight_head_pose;
      }
      if (sMotion) {
        sMotion.value = s.weight_movement;
        document.getElementById("val-weight-motion").innerText = s.weight_movement;
      }
      if (sAudio) {
        sAudio.value = s.weight_audio_activity;
        document.getElementById("val-weight-audio").innerText = s.weight_audio_activity;
      }

      updatePrivacyBadge(s.anonymize_faces);
    }
  } catch (err) {
    console.error("Failed to load settings:", err);
  }
}

async function saveSettingsData() {
  const payload = {
    anonymize_faces: document.getElementById("set-privacy-blur")?.checked ?? true,
    biometric_matching_enabled: document.getElementById("set-biometric-matching")?.checked ?? false,
    data_retention_days: parseInt(document.getElementById("set-retention-days")?.value, 10) || 30,
    window_duration_seconds: parseFloat(document.getElementById("set-window-duration")?.value) || 15.0,
    sustained_presence_ratio: parseFloat(document.getElementById("set-presence-ratio")?.value) || 0.60,
    weight_head_pose: parseFloat(document.getElementById("slider-weight-head")?.value) || 0.45,
    weight_movement: parseFloat(document.getElementById("slider-weight-motion")?.value) || 0.25,
    weight_audio_activity: parseFloat(document.getElementById("slider-weight-audio")?.value) || 0.30
  };

  await postSettingsUpdate(payload);
  showToast("System configuration saved.", "success");
}

async function postSettingsUpdate(payload) {
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      const data = await res.json();
      if (data.anonymize_faces !== undefined) {
        updatePrivacyBadge(data.anonymize_faces);
      }
    }
  } catch (err) {
    console.error("Settings update error:", err);
  }
}

async function togglePrivacyBlur() {
  const headerLabel = document.getElementById("header-privacy-label");
  const isCurrentlyOn = headerLabel && headerLabel.innerText.includes("On");
  const next = !isCurrentlyOn;
  await postSettingsUpdate({ anonymize_faces: next });
  updatePrivacyBadge(next);
  showToast(`Face Blurring ${next ? 'Enabled' : 'Disabled'}`, "info");
}

function updatePrivacyBadge(isOn) {
  const label = document.getElementById("header-privacy-label");
  const liveTag = document.getElementById("live-tag-anon");
  if (label) label.innerText = isOn ? "Blur: On" : "Blur: Off";
  if (liveTag) liveTag.innerText = isOn ? "Privacy: Active (Blur)" : "Privacy: Normal";
  const checkbox = document.getElementById("set-privacy-blur");
  if (checkbox) checkbox.checked = isOn;
}

// ==========================================================================
// 14. SESSION CONTROLS & NEW SESSION MODAL
// ==========================================================================

function initSessionControls() {
  const pauseBtn = document.getElementById("btn-pause-session");
  const resumeBtn = document.getElementById("btn-resume-session");
  const stopBtn = document.getElementById("btn-stop-session");
  const newSessionModalBtn = document.getElementById("btn-new-session-modal");
  const submitNewSessionBtn = document.getElementById("btn-submit-new-session");

  if (pauseBtn) {
    pauseBtn.addEventListener("click", async () => {
      await fetch("/api/sessions/current/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pause" })
      });
      showToast("Classroom monitoring paused.", "info");
    });
  }

  if (resumeBtn) {
    resumeBtn.addEventListener("click", async () => {
      await fetch("/api/sessions/current/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resume" })
      });
      showToast("Classroom monitoring resumed.", "success");
    });
  }

  if (stopBtn) {
    stopBtn.addEventListener("click", async () => {
      if (confirm("Are you sure you want to stop and finalize this classroom session?")) {
        await fetch("/api/sessions/current/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "stop" })
        });
        showToast("Session stopped and finalized.", "info");
      }
    });
  }

  if (newSessionModalBtn) {
    newSessionModalBtn.addEventListener("click", () => {
      openModal("modal-new-session");
    });
  }

  if (submitNewSessionBtn) {
    submitNewSessionBtn.addEventListener("click", async () => {
      const title = document.getElementById("new-session-title")?.value.trim();
      const section = document.getElementById("new-session-section")?.value.trim() || "Section A";
      const instructor = document.getElementById("new-session-instructor")?.value.trim() || "Prof. Johnson";
      const enrolled = parseInt(document.getElementById("new-session-enrolled")?.value, 10) || 6;

      if (!title) {
        showToast("Please enter a session title.", "error");
        return;
      }

      try {
        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: title,
            section: section,
            instructor_name: instructor,
            total_enrolled: enrolled
          })
        });

        if (res.ok) {
          const newSession = await res.json();
          activeSessionId = newSession.session_id;
          sessionStartEpoch = Date.now();
          const titleEl = document.getElementById("header-session-title");
          const idEl = document.getElementById("header-session-id");
          if (titleEl) titleEl.innerText = newSession.title;
          if (idEl) idEl.innerText = `ID: ${newSession.session_id}`;
          closeModal("modal-new-session");
          showToast(`Started new session: ${newSession.title}`, "success");
          refreshAttendanceTable();
        }
      } catch (e) {
        showToast("Failed to create new session.", "error");
      }
    });
  }
}

// ==========================================================================
// 15. NOTIFICATIONS ALERT DRAWER & GLOBAL SEARCH
// ==========================================================================

function initNotifications() {
  const btnNotif = document.getElementById("btn-notifications");
  const dropdown = document.getElementById("notification-dropdown");
  const btnClear = document.getElementById("btn-clear-notif");

  if (btnNotif && dropdown) {
    btnNotif.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown.classList.toggle("active");
      const dot = document.getElementById("top-notification-dot");
      if (dot) dot.classList.remove("active");
    });

    document.addEventListener("click", (e) => {
      if (!dropdown.contains(e.target) && !btnNotif.contains(e.target)) {
        dropdown.classList.remove("active");
      }
    });
  }

  if (btnClear) {
    btnClear.addEventListener("click", () => {
      unreadNotifications = [];
      renderNotifications();
    });
  }
}

function addNotificationAlert(title, priority, text) {
  unreadNotifications.unshift({ title, priority, text, time: new Date().toLocaleTimeString() });
  if (unreadNotifications.length > 10) unreadNotifications.pop();

  const dot = document.getElementById("top-notification-dot");
  if (dot) dot.classList.add("active");
  renderNotifications();
}

function renderNotifications() {
  const list = document.getElementById("top-notification-list");
  if (!list) return;

  if (unreadNotifications.length === 0) {
    list.innerHTML = `<div class="notif-empty">No unread alerts.</div>`;
    return;
  }

  list.innerHTML = "";
  unreadNotifications.forEach(n => {
    const item = document.createElement("div");
    item.style.padding = "0.5rem 0";
    item.style.borderBottom = "1px solid var(--border-color)";
    item.innerHTML = `
      <div style="display: flex; justify-content: space-between; font-size: 0.76rem; font-weight: 700;">
        <span>${escapeHtml(n.title)}</span>
        <span style="font-size: 0.68rem; color: var(--text-dim);">${n.time}</span>
      </div>
      <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 2px;">${escapeHtml(n.text)}</div>
    `;
    list.appendChild(item);
  });
}

function initGlobalSearch() {
  const globalInput = document.getElementById("top-global-search");
  if (!globalInput) return;

  globalInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const query = globalInput.value.trim().toLowerCase();
      if (!query) return;

      // Switch to Attendance or Student view to filter
      switchView("view-attendance");
      const attSearch = document.getElementById("attendance-search");
      if (attSearch) {
        attSearch.value = query;
        renderAttendanceRows();
      }
    }
  });
}

// ==========================================================================
// 16. MODAL UTILITIES
// ==========================================================================

function initModals() {
  const submitCorr = document.getElementById("btn-submit-correction");
  if (submitCorr) submitCorr.addEventListener("click", submitAttendanceCorrection);

  // Close modals on clicking backdrop
  document.querySelectorAll(".modal-backdrop").forEach(backdrop => {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) {
        backdrop.classList.remove("active");
      }
    });
  });
}

function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add("active");
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove("active");
}

// ==========================================================================
// 17. TOAST NOTIFICATIONS
// ==========================================================================

function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerText = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(24px)";
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// ==========================================================================
// 18. INITIAL DATA BOOTSTRAP
// ==========================================================================

function loadInitialData() {
  refreshAttendanceTable();
  loadAllRecommendations();
  loadStudentsTable();
  loadSettingsData();
}

// HTML XSS Escaping Helper
function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
