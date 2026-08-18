const NATIVE_HOST = "com.volgesture.volumemonitor";
const RECONNECT_DELAY_MS = 3000;
const KEEPALIVE_ALARM = "volgesture_keepalive";
const DEFAULT_SETTINGS = {
  enabled: true,
  gestureWindowMs: 1000,
  feedScrollPercent: 80,
  autoSkipByTypeEnabled: false,
  autoSkipKeywords: "sponsored, paid partnership, #ad, ad, gaming",
  autoClickSkipAdsEnabled: false,
  showGestureVideoInfo: false,
  showVideoReleaseDate: true,
  autoSkipMaxAge: "",
};

let port = null;

// --- Native host connection ---
function connectNativeHost() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    console.error("[VolumeGesture] Failed to connect native host:", e);
    scheduleReconnect();
    return;
  }

  port.onMessage.addListener((msg) => {
    if (msg.type === "gesture") {
      console.log("[VolumeGesture] Gesture detected:", msg.gesture);
      handleGesture(msg.gesture);
    } else if (msg.type === "status") {
      const hostVer = msg.version ? ` (native host ${msg.version})` : "";
      console.log("[VolumeGesture] Native host status:", msg.status + hostVer);
    } else if (msg.type === "error") {
      console.error("[VolumeGesture] Native host error:", msg.error);
    }
  });

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    console.warn("[VolumeGesture] Native host disconnected:",
      err ? err.message : "unknown reason");
    port = null;
    scheduleReconnect();
  });

  // Send current settings + whether to fire OS media keys (off on YouTube Shorts)
  chrome.storage.sync.get(
    DEFAULT_SETTINGS,
    (items) => {
      if (!port) return;
      shouldSimulateMediaKeysForGestureContext().then((simulateMediaKeys) => {
        if (port) {
          port.postMessage({
            type: "config",
            gestureWindowMs: items.gestureWindowMs,
            simulateMediaKeys,
          });
        }
      });
    }
  );
}

function scheduleReconnect() {
  setTimeout(connectNativeHost, RECONNECT_DELAY_MS);
}

/** Same tab priority as handleGesture: audible tab, else active in last-focused window. */
async function shouldSimulateMediaKeysForGestureContext() {
  let tabs = await chrome.tabs.query({ audible: true });
  if (!tabs || tabs.length === 0) {
    tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  }
  if (!tabs || tabs.length === 0) return true;
  const url = tabs[0].url || "";
  const isShorts =
    url.indexOf("youtube.com") !== -1 && url.indexOf("/shorts") !== -1;
  // Shorts: extension navigates in-page; skip OS media keys to avoid double advance.
  return !isShorts;
}

async function updateNativeSimulateMediaKeys() {
  if (!port) return;
  try {
    const simulateMediaKeys = await shouldSimulateMediaKeysForGestureContext();
    port.postMessage({ type: "config", simulateMediaKeys });
  } catch (e) {
    console.warn("[VolumeGesture] updateNativeSimulateMediaKeys:", e);
  }
}

async function handleGesture(gesture) {
  try {
    const items = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    if (!items.enabled) return;
    const scrollPct = Math.min(100, Math.max(70, items.feedScrollPercent || 80));
    const showVideoInfo = !!items.showGestureVideoInfo;

    let tabs = await chrome.tabs.query({ audible: true });
    if (!tabs || tabs.length === 0) {
      tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    }
    if (!tabs || tabs.length === 0) return;

    for (const tab of tabs) {
      if (!tab.url) continue;
      if (tab.url.startsWith("chrome://") || tab.url.startsWith("edge://")) continue;

      const isShorts =
        tab.url.indexOf("youtube.com") !== -1 &&
        tab.url.indexOf("/shorts") !== -1;

      // YouTube Shorts is a vertical reel: OS media keys often don't map to next/prev
      // the way they do on watch pages. Run in MAIN world so key events reach YouTube.
      if (isShorts) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: rememberGestureNavigation,
          args: [gesture],
        });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          func: navigateYouTubeShorts,
          args: [gesture],
        });
        if (showVideoInfo) {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "MAIN",
            func: showGestureVideoInfoOverlay,
            args: [1000, 1500],
          });
        }
        continue;
      }

      var isYouTube = tab.url.indexOf("youtube.com") !== -1;

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: rememberGestureNavigation,
        args: [gesture],
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: navigateVideo,
        args: [gesture, isYouTube, scrollPct],
      });
      if (showVideoInfo) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          func: showGestureVideoInfoOverlay,
          args: [1000, 1500],
        });
      }
    }
  } catch (e) {
    console.error("[VolumeGesture] executeScript failed:", e);
  }
}

// Injected after manual navigation so auto-skip can continue in the same direction.
function rememberGestureNavigation(gesture) {
  window.__volGestureLastManualNavigation = {
    gesture: gesture === "previous" ? "previous" : "next",
    at: Date.now(),
  };
}

async function updateAutoSkipMonitorForTab(tabId) {
  if (!tabId) return;
  try {
    const items = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: installAutoSkipMonitor,
      args: [{
        enabled: !!(items.enabled && (items.autoSkipByTypeEnabled || items.autoClickSkipAdsEnabled)),
        autoSkipByTypeEnabled: !!items.autoSkipByTypeEnabled,
        autoClickSkipAdsEnabled: !!items.autoClickSkipAdsEnabled,
        keywords: items.autoSkipKeywords || DEFAULT_SETTINGS.autoSkipKeywords,
        feedScrollPercent: Math.min(100, Math.max(70, items.feedScrollPercent || 80)),
      }],
    });
  } catch (e) {
    // Expected on browser-internal pages and some restricted sites.
    if (String(e && e.message || e).indexOf("Cannot access") === -1) {
      console.warn("[VolumeGesture] updateAutoSkipMonitorForTab:", e);
    }
  }
}

async function updateReleaseDateMonitorForTab(tabId) {
  if (!tabId) return;
  try {
    const items = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    const showDate = !!items.showVideoReleaseDate;
    const maxAge = items.autoSkipMaxAge || "";
    // Harvest publish_time from Facebook XHR/fetch JSON in the page MAIN world.
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "MAIN",
        func: installReleaseDateNetworkTap,
      });
    } catch (_) {}
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: installReleaseDateMonitor,
      args: [{
        enabled: !!(items.enabled && (showDate || maxAge)),
        showDateOverlay: showDate,
        autoSkipMaxAge: maxAge,
      }],
    });
  } catch (e) {
    if (String(e && e.message || e).indexOf("Cannot access") === -1) {
      console.warn("[VolumeGesture] updateReleaseDateMonitorForTab:", e);
    }
  }
}

async function updateAutoSkipMonitorsForGestureContext() {
  try {
    let tabs = await chrome.tabs.query({ audible: true });
    const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tabs = (tabs || []).concat(activeTabs || []);
    const seen = {};
    for (const tab of tabs) {
      if (!tab || !tab.id || seen[tab.id]) continue;
      seen[tab.id] = true;
      await updateAutoSkipMonitorForTab(tab.id);
      await updateReleaseDateMonitorForTab(tab.id);
    }
  } catch (e) {
    console.warn("[VolumeGesture] updateAutoSkipMonitorsForGestureContext:", e);
  }
}

// Injected into the page MAIN world — YouTube Shorts only
function navigateYouTubeShorts(gesture, suppressOverlay) {
  function showOverlay(g) {
    var overlay = document.getElementById("__vol_gesture_overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "__vol_gesture_overlay";
      overlay.style.cssText =
        "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) scale(0.8);" +
        "background:rgba(0,0,0,0.78);color:#fff;font-family:'Segoe UI',system-ui,sans-serif;" +
        "font-size:22px;font-weight:600;padding:16px 32px;border-radius:12px;" +
        "z-index:2147483647;pointer-events:none;opacity:0;" +
        "transition:opacity 0.2s ease,transform 0.2s ease;text-align:center;" +
        "backdrop-filter:blur(6px);box-shadow:0 4px 24px rgba(0,0,0,0.3);";
      document.body.appendChild(overlay);
    }
    overlay.textContent = g === "next" ? "\u23ED Next Video" : "\u23EE Previous Video";
    overlay.style.opacity = "1";
    overlay.style.transform = "translate(-50%,-50%) scale(1)";
    clearTimeout(overlay._ht);
    overlay._ht = setTimeout(function () {
      overlay.style.opacity = "0";
      overlay.style.transform = "translate(-50%,-50%) scale(0.8)";
    }, 1500);
  }

  if (!suppressOverlay) {
    showOverlay(gesture);
  }

  function clickNavButton(containerId) {
    var el = document.getElementById(containerId);
    if (!el) return false;
    var btn = el.querySelector("button");
    if (btn) {
      btn.click();
      return true;
    }
    if (typeof el.click === "function") {
      el.click();
      return true;
    }
    return false;
  }

  if (gesture === "next") {
    if (clickNavButton("navigation-button-down")) return;
  } else {
    if (clickNavButton("navigation-button-up")) return;
  }

  var key = gesture === "next" ? "ArrowDown" : "ArrowUp";
  var keyCode = gesture === "next" ? 40 : 38;
  var init = {
    key: key,
    code: key,
    keyCode: keyCode,
    which: keyCode,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
  // Shorts listens for ArrowUp/ArrowDown (see in-page MediaSession hacks); avoid also
  // scrolling the viewport or we may advance twice.
  var sp = document.getElementById("shorts-player");
  if (sp) {
    sp.dispatchEvent(new KeyboardEvent("keydown", init));
    sp.dispatchEvent(new KeyboardEvent("keyup", init));
  }
  document.dispatchEvent(new KeyboardEvent("keydown", init));
  document.dispatchEvent(new KeyboardEvent("keyup", init));
}

// This function is injected into the tab
function navigateVideo(gesture, isYouTube, feedScrollPercent, suppressOverlay) {
  var scrollFrac = (typeof feedScrollPercent === "number" ? feedScrollPercent : 100) / 100;
  if (scrollFrac < 0.8) scrollFrac = 0.8;
  if (scrollFrac > 1) scrollFrac = 1;
  function showOverlay(g) {
    var overlay = document.getElementById("__vol_gesture_overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "__vol_gesture_overlay";
      overlay.style.cssText =
        "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) scale(0.8);" +
        "background:rgba(0,0,0,0.78);color:#fff;font-family:'Segoe UI',system-ui,sans-serif;" +
        "font-size:22px;font-weight:600;padding:16px 32px;border-radius:12px;" +
        "z-index:2147483647;pointer-events:none;opacity:0;" +
        "transition:opacity 0.2s ease,transform 0.2s ease;text-align:center;" +
        "backdrop-filter:blur(6px);box-shadow:0 4px 24px rgba(0,0,0,0.3);";
      document.body.appendChild(overlay);
    }
    overlay.textContent = g === "next" ? "\u23ED Next Video" : "\u23EE Previous Video";
    overlay.style.opacity = "1";
    overlay.style.transform = "translate(-50%,-50%) scale(1)";
    clearTimeout(overlay._ht);
    overlay._ht = setTimeout(function () {
      overlay.style.opacity = "0";
      overlay.style.transform = "translate(-50%,-50%) scale(0.8)";
    }, 1500);
  }

  if (isYouTube) {
    if (!suppressOverlay) {
      showOverlay(gesture);
    }
    return;
  }

  var host = window.location.hostname;

  if (host.indexOf("facebook.com") !== -1) {
    var nextLabels = ["Next", "Next video", "Next card", "Next reel"];
    var prevLabels = ["Previous", "Previous video", "Previous card", "Previous reel"];
    var labels = gesture === "next" ? nextLabels : prevLabels;

    for (var i = 0; i < labels.length; i++) {
      var btn = document.querySelector('[aria-label="' + labels[i] + '"]');
      if (btn) {
        btn.click();
        if (!suppressOverlay) showOverlay(gesture);
        return;
      }
    }

    var videos = Array.prototype.slice.call(document.querySelectorAll("video"));
    if (videos.length > 0) {
      var bestIdx = 0, bestVis = -1;
      for (var v = 0; v < videos.length; v++) {
        var rect = videos[v].getBoundingClientRect();
        var visTop = Math.max(0, rect.top);
        var visBot = Math.min(window.innerHeight, rect.bottom);
        var vis = rect.height > 0 ? Math.max(0, visBot - visTop) / rect.height : 0;
        if (vis > bestVis) { bestVis = vis; bestIdx = v; }
      }
      var targetIdx = gesture === "next" ? bestIdx + 1 : bestIdx - 1;
      if (targetIdx >= 0 && targetIdx < videos.length) {
        var container = videos[targetIdx].parentElement;
        while (container && container !== document.body) {
          if (container.getBoundingClientRect().height >= window.innerHeight * 0.4) break;
          container = container.parentElement;
        }
        (container || videos[targetIdx]).scrollIntoView({ behavior: "smooth", block: "center" });
        if (!suppressOverlay) showOverlay(gesture);
        return;
      }
    }
    if (!suppressOverlay) showOverlay(gesture);
    return;
  }

  // MSN.com: scroll-to-play feed — scroll by one viewport to bring next/prev video into focus
  if (host.indexOf("msn.com") !== -1) {
    var scrollAmount = gesture === "next"
      ? window.innerHeight * scrollFrac
      : -window.innerHeight * scrollFrac;
    window.scrollBy({ top: scrollAmount, behavior: "smooth" });
    if (!suppressOverlay) showOverlay(gesture);
    return;
  }

  var genericLabels = gesture === "next"
    ? ["next", "skip", "forward", "Next video"]
    : ["previous", "prev", "back", "Previous video"];
  for (var g = 0; g < genericLabels.length; g++) {
    var gBtn =
      document.querySelector('[aria-label*="' + genericLabels[g] + '" i]') ||
      document.querySelector('button[title*="' + genericLabels[g] + '" i]');
    if (gBtn) {
      gBtn.click();
      if (!suppressOverlay) showOverlay(gesture);
      return;
    }
  }

  var allVids = Array.prototype.slice.call(document.querySelectorAll("video"));
  if (allVids.length > 1) {
    var bIdx = 0, bVis = -1;
    for (var j = 0; j < allVids.length; j++) {
      var r = allVids[j].getBoundingClientRect();
      var vt = Math.max(0, r.top), vb = Math.min(window.innerHeight, r.bottom);
      var vv = r.height > 0 ? Math.max(0, vb - vt) / r.height : 0;
      if (vv > bVis) { bVis = vv; bIdx = j; }
    }
    var tIdx = gesture === "next" ? bIdx + 1 : bIdx - 1;
    if (tIdx >= 0 && tIdx < allVids.length) {
      allVids[tIdx].scrollIntoView({ behavior: "smooth", block: "center" });
      if (!suppressOverlay) showOverlay(gesture);
      return;
    }
  }

  // Fallback for any feed-style site: scroll by configured fraction of viewport
  var fallbackScroll = gesture === "next"
    ? window.innerHeight * scrollFrac
    : -window.innerHeight * scrollFrac;
  window.scrollBy({ top: fallbackScroll, behavior: "smooth" });
  if (!suppressOverlay) showOverlay(gesture);
}

// Injected after a manual gesture when the user enables video-info display.
function showGestureVideoInfoOverlay(displayMs, delayMs) {
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
    });
  }

  function visibleRatio(el) {
    var rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return 0;
    var left = Math.max(0, rect.left);
    var right = Math.min(window.innerWidth, rect.right);
    var top = Math.max(0, rect.top);
    var bottom = Math.min(window.innerHeight, rect.bottom);
    var visible = Math.max(0, right - left) * Math.max(0, bottom - top);
    return visible / (rect.width * rect.height);
  }

  function activeVideo() {
    var videos = Array.prototype.slice.call(document.querySelectorAll("video"));
    var best = null;
    var bestScore = 0;
    for (var i = 0; i < videos.length; i++) {
      var video = videos[i];
      var ratio = visibleRatio(video);
      if (ratio < 0.2) continue;
      var score = ratio + (video.paused ? 0 : 1);
      if (score > bestScore) {
        best = video;
        bestScore = score;
      }
    }
    return best;
  }

  function collectText(video) {
    var parts = [document.title || "", window.location.href || ""];
    var metas = document.querySelectorAll(
      'meta[name="description"], meta[property="og:title"], meta[property="og:description"]'
    );
    for (var m = 0; m < metas.length; m++) {
      parts.push(metas[m].getAttribute("content") || "");
    }

    var node = video;
    var depth = 0;
    while (node && node !== document.body && depth < 7) {
      if (node.getAttribute) {
        parts.push(node.getAttribute("aria-label") || "");
        parts.push(node.getAttribute("title") || "");
      }
      if (node.innerText && node.innerText.length < 4000) {
        parts.push(node.innerText);
      }
      node = node.parentElement;
      depth++;
    }
    return parts.join("\n");
  }

  function normalizeInfoText(text) {
    var cleaned = String(text || "")
      .split(/\n+/)
      .map(function (line) { return line.replace(/\s+/g, " ").trim(); })
      .filter(Boolean)
      .filter(function (line, idx, arr) { return arr.indexOf(line) === idx; })
      .join("\n");
    if (cleaned.length > 800) {
      cleaned = cleaned.slice(0, 797) + "...";
    }
    return cleaned;
  }

  function showInfo(text) {
    var overlay = document.getElementById("__vol_gesture_overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "__vol_gesture_overlay";
      document.body.appendChild(overlay);
    }
    overlay.style.cssText =
      "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) scale(0.98);" +
      "background:rgba(0,0,0,0.82);color:#fff;font-family:'Segoe UI',system-ui,sans-serif;" +
      "font-size:13px;font-weight:500;padding:14px 18px;border-radius:12px;" +
      "z-index:2147483647;pointer-events:none;opacity:0;max-width:min(720px,88vw);" +
      "max-height:35vh;overflow:hidden;white-space:pre-wrap;text-align:left;" +
      "transition:opacity 0.15s ease,transform 0.15s ease;" +
      "backdrop-filter:blur(6px);box-shadow:0 4px 24px rgba(0,0,0,0.3);";
    overlay.innerHTML =
      '<div style="font-size:12px;color:#bbb;margin-bottom:6px;">Video info used for matching</div>' +
      escapeHtml(text);
    overlay.style.opacity = "1";
    overlay.style.transform = "translate(-50%,-50%) scale(1)";
    clearTimeout(overlay._ht);
    overlay._ht = setTimeout(function () {
      overlay.style.opacity = "0";
      overlay.style.transform = "translate(-50%,-50%) scale(0.98)";
    }, displayMs || 1000);
  }

  setTimeout(function () {
    var video = activeVideo();
    if (!video) return;
    var text = normalizeInfoText(collectText(video));
    if (text) showInfo(text);
  }, delayMs || 800);
}

function clickSkipAdsButtonInMainWorld() {
  function isElementVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    return rect.bottom > 0 && rect.right > 0 &&
      rect.top < window.innerHeight && rect.left < window.innerWidth;
  }

  function textAroundElement(el) {
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node !== document && depth < 4) {
      if (node.getAttribute) {
        parts.push(node.getAttribute("aria-label") || "");
        parts.push(node.getAttribute("title") || "");
        parts.push(node.getAttribute("id") || "");
        parts.push(node.getAttribute("class") || "");
        parts.push(node.getAttribute("role") || "");
      }
      if (node.innerText && node.innerText.length < 300) {
        parts.push(node.innerText);
      }
      node = node.parentElement;
      depth++;
    }
    return parts.join(" ");
  }

  function closestClickable(el) {
    var node = el;
    var depth = 0;
    while (node && node !== document && depth < 5) {
      if (node.matches &&
          node.matches('button, [role="button"], a, [onclick], [tabindex]')) {
        return node;
      }
      node = node.parentElement;
      depth++;
    }
    return el;
  }

  function clickElement(el) {
    var target = closestClickable(el);
    var events = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
    for (var i = 0; i < events.length; i++) {
      var eventInit = {
        bubbles: true,
        cancelable: true,
        view: window,
      };
      if (events[i].indexOf("pointer") === 0 && typeof PointerEvent !== "undefined") {
        target.dispatchEvent(new PointerEvent(events[i], eventInit));
      } else {
        target.dispatchEvent(new MouseEvent(events[i], eventInit));
      }
    }
    if (typeof target.click === "function") {
      target.click();
    }
  }

  var candidates = Array.prototype.slice.call(document.querySelectorAll(
    'button, [role="button"], a, [aria-label], [title], [id*="skip"], [class*="skip"], ' +
    '#skip_button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, ' +
    '.ytp-ad-skip-button-container'
  ));
  for (var i = 0; i < candidates.length; i++) {
    var el = candidates[i];
    if (!isElementVisible(el)) continue;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;

    var text = textAroundElement(el).replace(/\s+/g, " ").trim();
    var lower = text.toLowerCase();
    // Require word boundaries so "header"/"load"/"read" do not count as ad context.
    var hasAdContext = /\b(ads?|advert|advertisement|sponsor|commercial)\b/.test(lower);
    var knownSkipAdControl =
      /(^|[\s_-])skip([\s_-]|$)/.test(String(el.id || "").toLowerCase()) ||
      /(^|[\s_-])skip([\s_-]|$)/.test(String(el.className || "").toLowerCase()) ||
      /ytp-ad-skip/.test(String(el.className || "").toLowerCase());
    var explicitAdSkip =
      /\bskip\s+(ads?|advert|advertisement|commercial)\b/.test(lower) ||
      /\b(skip|skip now)\b.*\b(ads?|advert|advertisement|commercial)\b/.test(lower);
    var plainSkipWithAdContext = /^skip$/i.test((el.innerText || "").trim()) && hasAdContext;

    if (!explicitAdSkip && !plainSkipWithAdContext && !(knownSkipAdControl && hasAdContext)) {
      continue;
    }

    clickElement(el);
    return true;
  }
  return false;
}

function parseDateCandidate(raw) {
  if (raw === 0 || raw === "0") return null;
  if (raw === null || raw === undefined || raw === "") return null;
  const text = String(raw).trim();
  if (!text) return null;

  // Unix seconds / milliseconds (Facebook publish_time / creation_time, TikTok createTime)
  if (/^\d{10}$/.test(text)) {
    const sec = Number(text);
    if (sec >= 946684800 && sec <= 4102444800) {
      const d = new Date(sec * 1000);
      return { ms: d.getTime(), label: d.toISOString().slice(0, 10), raw: text };
    }
  }
  if (/^\d{13}$/.test(text)) {
    const ms = Number(text);
    if (ms >= 946684800000 && ms <= 4102444800000) {
      const d = new Date(ms);
      return { ms: d.getTime(), label: d.toISOString().slice(0, 10), raw: text };
    }
  }

  const iso = text.match(
    /\b(20\d{2}|19\d{2})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (iso) {
    const d = new Date(iso[0]);
    if (!isNaN(d.getTime())) return { ms: d.getTime(), label: iso[0].slice(0, 10), raw: text };
  }
  const d = new Date(text);
  if (!isNaN(d.getTime()) && d.getFullYear() >= 1990 && d.getFullYear() <= 2100) {
    return {
      ms: d.getTime(),
      label: d.toISOString().slice(0, 10),
      raw: text,
    };
  }
  return null;
}

function contentIdFromUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    const host = u.hostname || "";
    const path = u.pathname || "";
    let m;
    if (/facebook\.com$/i.test(host.replace(/^www\.|^m\.|^mbasic\./, "")) ||
        /facebook\.com$/i.test(host)) {
      m = path.match(/\/(?:reel|reels|videos)\/(\d+)/i);
      if (m) return m[1];
      m = u.searchParams.get("v");
      if (m && /^\d+$/.test(m)) return m;
    }
    if (/youtube\.com|youtu\.be/i.test(host)) {
      m = path.match(/\/shorts\/([\w-]{6,})/i) || path.match(/\/embed\/([\w-]{6,})/i);
      if (m) return m[1];
      if (/youtu\.be/i.test(host)) {
        m = path.match(/^\/([\w-]{6,})/);
        if (m) return m[1];
      }
      m = u.searchParams.get("v");
      if (m) return m;
    }
    if (/tiktok\.com/i.test(host)) {
      m = path.match(/\/video\/(\d+)/);
      if (m) return m[1];
    }
  } catch (_) {}
  return "";
}

function expandReleaseDateFetchUrls(urls) {
  const out = [];
  const seen = {};
  const add = (u) => {
    if (!u || typeof u !== "string" || !/^https?:\/\//i.test(u)) return;
    if (seen[u]) return;
    seen[u] = true;
    out.push(u);
  };
  for (const url of urls || []) {
    add(url);
    let m = String(url).match(/facebook\.com\/(?:reel|reels|videos)\/(\d+)/i);
    if (!m) {
      m = String(url).match(/[?&]v=(\d{8,})/);
      if (m && /facebook\.com/i.test(url)) {
        /* keep */
      } else {
        m = null;
      }
    }
    if (m) {
      const id = m[1];
      // Prefer www reel HTML (tested: has publish_time). Skip plugins (no publish_time).
      add("https://www.facebook.com/reel/" + id);
      add("https://m.facebook.com/reel/" + id);
    }
    const ys = String(url).match(/youtube\.com\/shorts\/([\w-]{6,})/i);
    if (ys) add("https://www.youtube.com/watch?v=" + ys[1]);
    const yv = String(url).match(/[?&]v=([\w-]{6,})/);
    if (yv && /youtube\.com/i.test(url)) add("https://www.youtube.com/shorts/" + yv[1]);
  }
  return out.slice(0, 8);
}

function extractUnixTimesFromText(text, contentId) {
  if (!text) return [];
  const found = [];
  const pushUnix = (sec, nearId) => {
    const parsed = parseDateCandidate(String(sec));
    if (!parsed) return;
    found.push({
      ms: parsed.ms,
      label: parsed.label,
      hint: !!nearId,
      raw: String(sec),
    });
  };

  if (contentId) {
    const idRe = new RegExp(
        contentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
        "[\\s\\S]{0,800}?\\\\?\"(?:publish_time|creation_time|created_time|upload_time|createTime)\\\\?\"\\s*:\\s*\\\\?\"?(\\d{10,13})",
      "gi"
    );
    let m;
    while ((m = idRe.exec(text))) pushUnix(m[1], true);
    const idRe2 = new RegExp(
      "\\\\?\"(?:publish_time|creation_time|created_time|upload_time|createTime)\\\\?\"\\s*:\\s*\\\\?\"?(\\d{10,13})[\\s\\S]{0,800}?" +
        contentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "gi"
    );
    while ((m = idRe2.exec(text))) pushUnix(m[1], true);
  }

  const labeled = text.matchAll(
    /\\?"(?:publish_time|creation_time|created_time|upload_time|createTime|publishDate|uploadDate)\\?"\s*:\s*\\?"?(\d{10,13}|20\d{2}-\d{2}-\d{2}[^"\\]*)/gi
  );
  for (const m of labeled) {
    const parsed = parseDateCandidate(m[1]);
    if (!parsed) continue;
    found.push({
      ms: parsed.ms,
      label: parsed.label,
      hint: false,
      raw: m[1],
    });
  }
  return found;
}

function extractReleaseDateFromHtml(html, opts) {
  if (!html) return null;
  const contentId = (opts && opts.contentId) || "";
  const candidates = [];
  const push = (raw, hint) => {
    const parsed = parseDateCandidate(raw);
    if (!parsed) return;
    candidates.push({
      ms: parsed.ms,
      label: parsed.label,
      hint: !!hint,
      raw: parsed.raw,
    });
  };

  const jsonBlocks = html.match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  ) || [];
  for (const block of jsonBlocks) {
    const body = block.replace(/^[\s\S]*?>/, "").replace(/<\/script>\s*$/i, "");
    try {
      const data = JSON.parse(body);
      const stack = Array.isArray(data) ? data.slice() : [data];
      while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== "object") continue;
        const type = String(node["@type"] || "").toLowerCase();
        const isVideo =
          type.indexOf("video") !== -1 ||
          type.indexOf("movie") !== -1 ||
          type.indexOf("clip") !== -1;
        if (node.uploadDate) push(node.uploadDate, isVideo);
        if (node.datePublished) push(node.datePublished, isVideo);
        if (node.releaseDate) push(node.releaseDate, true);
        if (node.dateCreated) push(node.dateCreated, isVideo);
        for (const key of Object.keys(node)) {
          const val = node[key];
          if (val && typeof val === "object") stack.push(val);
        }
      }
    } catch (_) {
      // ignore malformed JSON-LD
    }
  }

  const metaPatterns = [
    /property=["']og:video:release_date["'][^>]*content=["']([^"']+)["']/i,
    /content=["']([^"']+)["'][^>]*property=["']og:video:release_date["']/i,
    /property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i,
    /content=["']([^"']+)["'][^>]*property=["']article:published_time["']/i,
    /itemprop=["'](?:uploadDate|datePublished|dateCreated|releaseDate)["'][^>]*content=["']([^"']+)["']/i,
    /content=["']([^"']+)["'][^>]*itemprop=["'](?:uploadDate|datePublished|dateCreated|releaseDate)["']/i,
    /name=["']uploadDate["'][^>]*content=["']([^"']+)["']/i,
    /"uploadDate"\s*:\s*"([^"]+)"/i,
    /"publishDate"\s*:\s*"([^"]+)"/i,
    /"datePublished"\s*:\s*"([^"]+)"/i,
    /"releaseDate"\s*:\s*"([^"]+)"/i,
  ];
  for (const re of metaPatterns) {
    const m = html.match(re);
    if (m && m[1]) push(m[1], true);
  }

  const unixCandidates = extractUnixTimesFromText(html, contentId);
  for (const c of unixCandidates) {
    candidates.push(c);
  }

  if (!candidates.length) return null;
  // Prefer timestamps linked to the current reel/video id when available.
  // CRITICAL: with a contentId, never fall back to page-wide earliest dates —
  // that wrongly marks fresh reels as ancient (SPA leftovers / site metadata).
  const idLinked = unixCandidates.filter((c) => c.hint);
  if (contentId) {
    if (!idLinked.length) return null;
    idLinked.sort((a, b) => a.ms - b.ms);
    // Among id-linked stamps, prefer the latest publish_time near this id
    // (creation vs publish can both appear; earliest is often an unrelated neighbor).
    return idLinked[idLinked.length - 1];
  }
  const hinted = candidates.filter((c) => c.hint);
  const pool = hinted.length ? hinted : candidates;
  pool.sort((a, b) => a.ms - b.ms);
  return pool[0];
}

async function fetchReleaseDateFromUrl(url, opts) {
  try {
    const resp = await fetch(url, {
      method: "GET",
      // Include cookies so Facebook returns the logged-in HTML that has publish_time.
      credentials: "include",
      redirect: "follow",
      headers: {
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    const contentId = (opts && opts.contentId) || contentIdFromUrl(url);
    return extractReleaseDateFromHtml(html.slice(0, 800000), { contentId });
  } catch (e) {
    console.warn("[VolumeGesture] fetchReleaseDateFromUrl:", e);
    return null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === "fetchReleaseDate") {
    (async () => {
      try {
        const urls = expandReleaseDateFetchUrls(
          Array.isArray(msg.urls) ? msg.urls : []
        );
        const contentId = msg.contentId || contentIdFromUrl(urls[0] || "");
        let best = null;
        for (const url of urls) {
          const found = await fetchReleaseDateFromUrl(url, { contentId });
          if (!found) continue;
          // Prefer id-linked hits; never replace an id-linked date with an older
          // non-linked page-wide guess.
          if (!best) {
            best = Object.assign({ sourceUrl: url }, found);
            continue;
          }
          if (found.hint && !best.hint) {
            best = Object.assign({ sourceUrl: url }, found);
            continue;
          }
          if (found.hint === best.hint && found.ms > best.ms) {
            // Prefer newer among equally trusted id-linked stamps.
            best = Object.assign({ sourceUrl: url }, found);
          }
        }
        sendResponse({ ok: !!best, result: best });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }

  // Page-context Facebook reel fetch (uses the tab's cookies / logged-in HTML).
  if (msg.type === "fetchFacebookReelDate") {
    (async () => {
      try {
        const tab = sender && sender.tab;
        const contentId = msg.contentId ? String(msg.contentId) : "";
        if (!tab || !tab.id || !contentId) {
          sendResponse({ ok: false, error: "missing tab or contentId" });
          return;
        }
        const target = { tabId: tab.id };
        if (typeof sender.frameId === "number") {
          target.frameIds = [sender.frameId];
        }
        const results = await chrome.scripting.executeScript({
          target,
          world: "MAIN",
          func: fetchFacebookReelDateInMainWorld,
          args: [contentId],
        });
        const found = results && results[0] && results[0].result;
        sendResponse({ ok: !!found, result: found || null });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }

  if (msg.type === "autoClickSkipAds") {
    (async () => {
      try {
        const tab = sender && sender.tab;
        if (!tab || !tab.id) {
          sendResponse({ ok: false, error: "missing sender tab" });
          return;
        }
        const target = { tabId: tab.id };
        if (typeof sender.frameId === "number") {
          target.frameIds = [sender.frameId];
        }
        const results = await chrome.scripting.executeScript({
          target,
          world: "MAIN",
          func: clickSkipAdsButtonInMainWorld,
        });
        const clicked = !!(results && results.some((r) => r && r.result));
        if (clicked) {
          // Reset release-date gates in every frame — ad UI often lives in an
          // iframe while the date monitor runs on the top frame.
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id, allFrames: true },
              func: function () {
                try {
                  window.__volGestureAdSkipAt = Date.now();
                  if (typeof window.__volGestureResetReleaseDateGates === "function") {
                    window.__volGestureResetReleaseDateGates();
                  }
                } catch (_) {}
              },
            });
          } catch (_) {}
        }
        sendResponse({ ok: clicked });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();

    return true;
  }

  if (msg.type !== "autoSkipNavigate") return false;

  (async () => {
    try {
      const tab = sender && sender.tab;
      if (!tab || !tab.id || !tab.url) {
        sendResponse({ ok: false, error: "missing sender tab" });
        return;
      }

      const direction = msg.direction === "previous" ? "previous" : "next";
      const items = await chrome.storage.sync.get(DEFAULT_SETTINGS);
      const scrollPct = Math.min(100, Math.max(70, items.feedScrollPercent || 80));
      const isShorts =
        tab.url.indexOf("youtube.com") !== -1 &&
        tab.url.indexOf("/shorts") !== -1;

      if (isShorts) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          func: navigateYouTubeShorts,
          args: [direction, true],
        });
      } else {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: navigateVideo,
          args: [direction, tab.url.indexOf("youtube.com") !== -1, scrollPct, true],
        });
      }

      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();

  return true;
});

// Injected into pages. Keeps all classification local to the current tab.
function installAutoSkipMonitor(config) {
  // Always refresh toast helper so slot behavior updates after extension reload.

  // Fixed-slot toasts: each message keeps its Y until it expires (no reflow/jump).
  window.__volGestureShowToast = function (text) {
    if (!text) return;
    if (!window.__volGestureToastSlots) window.__volGestureToastSlots = [];
    var slots = window.__volGestureToastSlots;
    var slot = 0;
    while (slot < slots.length && slots[slot]) slot++;
    if (slot === slots.length) slots.push(true);
    else slots[slot] = true;

    var toast = document.createElement("div");
    toast.setAttribute("data-vol-gesture-toast-slot", String(slot));
    toast.style.cssText =
      "position:fixed;left:50%;transform:translateX(-50%);" +
      "top:" + (16 + slot * 44) + "px;" +
      "z-index:2147483647;pointer-events:none;" +
      "background:rgba(0,0,0,0.78);color:#fff;font-family:'Segoe UI',system-ui,sans-serif;" +
      "font-size:13px;font-weight:600;padding:8px 12px;border-radius:10px;opacity:0;" +
      "transition:opacity 0.15s ease;backdrop-filter:blur(6px);" +
      "box-shadow:0 2px 12px rgba(0,0,0,0.28);white-space:nowrap;" +
      "max-width:90vw;overflow:hidden;text-overflow:ellipsis;";
    toast.textContent = String(text);
    document.body.appendChild(toast);
    requestAnimationFrame(function () {
      toast.style.opacity = "1";
    });
    setTimeout(function () {
      toast.style.opacity = "0";
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
        slots[slot] = false;
        while (slots.length && !slots[slots.length - 1]) slots.pop();
      }, 200);
    }, 2000);
  };


  if (window.__volGestureAutoSkip && window.__volGestureAutoSkip.updateConfig) {
    window.__volGestureAutoSkip.updateConfig(config);
    return;
  }

  var state = {
    config: config || {},
    timer: null,
    lastSkipAt: 0,
    lastAdSkipAt: 0,
    fastUntil: Date.now() + 2500,
  };
  var NORMAL_CHECK_INTERVAL_MS = 1500;
  var FAST_CHECK_INTERVAL_MS = 250;
  var FAST_CHECK_WINDOW_MS = 2500;
  var ATTEMPT_COOLDOWN_MS = 1000;

  // Session-wide: once we auto-skipped a clip (ads/keywords), don't skip it again
  // if the user navigates back to watch it.
  function skipExemptMap() {
    try {
      var root = window.top || window;
      if (!root.__volGestureSkipExemptIds) root.__volGestureSkipExemptIds = {};
      return root.__volGestureSkipExemptIds;
    } catch (_) {
      if (!window.__volGestureSkipExemptIds) window.__volGestureSkipExemptIds = {};
      return window.__volGestureSkipExemptIds;
    }
  }

  function currentClipKey() {
    var path = location.pathname || "";
    var m = path.match(/\/(?:reel|reels|videos|shorts)\/([\w-]+)/i);
    if (m) return m[1];
    try {
      var v = new URL(location.href).searchParams.get("v");
      if (v) return String(v);
    } catch (_) {}
    return String(location.href || "").split("#")[0];
  }

  function isSkipExempt(key) {
    return !!(key && skipExemptMap()[key]);
  }

  function markSkipExempt(key) {
    if (!key) return;
    skipExemptMap()[key] = true;
  }

  function parseKeywords(raw) {
    return String(raw || "")
      .split(",")
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function matchKeyword(text, keyword) {
    var lowerText = String(text || "").toLowerCase();
    var lowerKeyword = String(keyword || "").trim().toLowerCase();
    if (!lowerKeyword) return false;

    if (lowerKeyword === "ad") {
      return /(^|[^\w])#?ad([^\w]|$)/i.test(lowerText);
    }
    if (lowerKeyword.charAt(0) === "#") {
      return new RegExp("(^|[^\\w])" + escapeRegExp(lowerKeyword) + "([^\\w]|$)", "i")
        .test(lowerText);
    }
    if (/^[\w-]+$/.test(lowerKeyword) && lowerKeyword.length <= 3) {
      return new RegExp("(^|[^\\w])" + escapeRegExp(lowerKeyword) + "([^\\w]|$)", "i")
        .test(lowerText);
    }
    return lowerText.indexOf(lowerKeyword) !== -1;
  }

  function findKeywordMatch(text, keywords) {
    for (var i = 0; i < keywords.length; i++) {
      if (matchKeyword(text, keywords[i])) return keywords[i];
    }
    return "";
  }

  function visibleRatio(el) {
    var rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return 0;
    var left = Math.max(0, rect.left);
    var right = Math.min(window.innerWidth, rect.right);
    var top = Math.max(0, rect.top);
    var bottom = Math.min(window.innerHeight, rect.bottom);
    var visible = Math.max(0, right - left) * Math.max(0, bottom - top);
    return visible / (rect.width * rect.height);
  }

  function isElementVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    return rect.bottom > 0 && rect.right > 0 &&
      rect.top < window.innerHeight && rect.left < window.innerWidth;
  }

  function activeVideo() {
    var videos = Array.prototype.slice.call(document.querySelectorAll("video"));
    var best = null;
    var bestScore = 0;
    for (var i = 0; i < videos.length; i++) {
      var video = videos[i];
      var ratio = visibleRatio(video);
      if (ratio < 0.2) continue;
      var score = ratio + (video.paused ? 0 : 1);
      if (score > bestScore) {
        best = video;
        bestScore = score;
      }
    }
    return best;
  }

  function isShortFormContext(video) {
    var host = window.location.hostname;
    var path = window.location.pathname;
    if (host.indexOf("youtube.com") !== -1 && path.indexOf("/shorts") !== -1) return true;
    if (host.indexOf("facebook.com") !== -1 && /\/(reel|reels|watch)\b/i.test(path)) return true;
    if (host.indexOf("instagram.com") !== -1 && /\/reels?\b/i.test(path)) return true;
    if (host.indexOf("tiktok.com") !== -1) return true;

    var rect = video.getBoundingClientRect();
    return rect.height >= window.innerHeight * 0.35 && rect.height > rect.width * 1.15;
  }

  function collectText(video) {
    var parts = [document.title || "", window.location.href || ""];
    var metas = document.querySelectorAll(
      'meta[name="description"], meta[property="og:title"], meta[property="og:description"]'
    );
    for (var m = 0; m < metas.length; m++) {
      parts.push(metas[m].getAttribute("content") || "");
    }

    var node = video;
    var depth = 0;
    while (node && node !== document.body && depth < 7) {
      if (node.getAttribute) {
        parts.push(node.getAttribute("aria-label") || "");
        parts.push(node.getAttribute("title") || "");
      }
      if (node.innerText && node.innerText.length < 4000) {
        parts.push(node.innerText);
      }
      node = node.parentElement;
      depth++;
    }
    return parts.join("\n");
  }

  function showOverlay(match, title) {
    var msg = title || "Skipped previous video";
    if (match) msg += ", keyword " + match;
    if (window.__volGestureShowToast) {
      window.__volGestureShowToast(msg);
      return;
    }
  }

  function noMoveTitleForDirection(direction) {
    return direction === "previous"
      ? "Could not skip to previous video"
      : "Could not skip to next video";
  }

  function matchTitleForDirection(direction) {
    return "Skipped previous video";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
    });
  }

  function rememberNavigationDirection(direction) {
    window.__volGestureLastManualNavigation = {
      gesture: direction === "previous" ? "previous" : "next",
      at: Date.now(),
    };
  }

  function directionFromText(text) {
    var lower = String(text || "").toLowerCase();
    if (/(^|[^a-z])(previous|prev|back|backward|rewind)([^a-z]|$)/.test(lower)) {
      return "previous";
    }
    if (/(^|[^a-z])(next|forward|skip)([^a-z]|$)/.test(lower)) {
      return "next";
    }
    return "";
  }

  function directionFromElement(el) {
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node !== document && depth < 6) {
      if (node.getAttribute) {
        parts.push(node.getAttribute("aria-label") || "");
        parts.push(node.getAttribute("title") || "");
        parts.push(node.getAttribute("id") || "");
        parts.push(node.getAttribute("class") || "");
        parts.push(node.getAttribute("role") || "");
      }
      if (node.innerText && node.innerText.length < 200) {
        parts.push(node.innerText);
      }
      var dir = directionFromText(parts.join(" "));
      if (dir) return dir;
      node = node.parentElement;
      depth++;
    }
    return "";
  }

  function textAroundElement(el) {
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node !== document && depth < 4) {
      if (node.getAttribute) {
        parts.push(node.getAttribute("aria-label") || "");
        parts.push(node.getAttribute("title") || "");
        parts.push(node.getAttribute("id") || "");
        parts.push(node.getAttribute("class") || "");
        parts.push(node.getAttribute("role") || "");
      }
      if (node.innerText && node.innerText.length < 300) {
        parts.push(node.innerText);
      }
      node = node.parentElement;
      depth++;
    }
    return parts.join(" ");
  }

  function requestSkipAdsClick(callback) {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
      callback(false);
      return;
    }
    chrome.runtime.sendMessage(
      { type: "autoClickSkipAds" },
      function (response) {
        if (chrome.runtime.lastError || !response || !response.ok) {
          callback(false);
          return;
        }
        callback(true);
      }
    );
  }

  function findSkipAdsButton() {
    var candidates = Array.prototype.slice.call(document.querySelectorAll(
      'button, [role="button"], a, [aria-label], [title], [id*="skip"], [class*="skip"], ' +
      '#skip_button, .ytp-ad-skip-button, ' +
      '.ytp-ad-skip-button-modern, .ytp-ad-skip-button-container'
    ));
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (!isElementVisible(el)) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;

      var text = textAroundElement(el).replace(/\s+/g, " ").trim();
      var lower = text.toLowerCase();
      // Require word boundaries so "header"/"load"/"read" do not count as ad context.
      var hasAdContext = /\b(ads?|advert|advertisement|sponsor|commercial)\b/.test(lower);
      var knownSkipAdControl =
        /(^|[\s_-])skip([\s_-]|$)/.test(String(el.id || "").toLowerCase()) ||
        /(^|[\s_-])skip([\s_-]|$)/.test(String(el.className || "").toLowerCase()) ||
        /ytp-ad-skip/.test(String(el.className || "").toLowerCase());
      var explicitAdSkip =
        /\bskip\s+(ads?|advert|advertisement|commercial)\b/.test(lower) ||
        /\b(skip|skip now)\b.*\b(ads?|advert|advertisement|commercial)\b/.test(lower);
      var plainSkipWithAdContext = /^skip$/i.test((el.innerText || "").trim()) && hasAdContext;

      if (!explicitAdSkip && !plainSkipWithAdContext && !(knownSkipAdControl && hasAdContext)) {
        continue;
      }
      return el;
    }
    return null;
  }

  function clickSkipAdsButton() {
    return !!findSkipAdsButton();
  }

  function installPageDirectionTracking() {
    if (state.directionTrackingInstalled) return;
    state.directionTrackingInstalled = true;

    document.addEventListener("click", function (event) {
      var dir = directionFromElement(event.target);
      if (dir) {
        rememberNavigationDirection(dir);
        triggerFastChecks();
      }
    }, true);

    document.addEventListener("keydown", function (event) {
      if (event.key === "ArrowUp" || event.key === "ArrowLeft" || event.key === "PageUp") {
        rememberNavigationDirection("previous");
        triggerFastChecks();
      } else if (event.key === "ArrowDown" || event.key === "ArrowRight" ||
                 event.key === "PageDown") {
        rememberNavigationDirection("next");
        triggerFastChecks();
      }
    }, true);
  }

  function recentGestureDirection() {
    var nav = window.__volGestureLastManualNavigation;
    if (nav && (nav.gesture === "next" || nav.gesture === "previous") &&
        Date.now() - nav.at < 10000) {
      return nav.gesture;
    }
    return "next";
  }

  function requestNavigation(direction, callback) {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
      callback(false);
      return;
    }
    chrome.runtime.sendMessage(
      { type: "autoSkipNavigate", direction: direction },
      function (response) {
        if (chrome.runtime.lastError || !response || !response.ok) {
          callback(false);
          return;
        }
        callback(true);
      }
    );
  }

  function makeSignature(match, text) {
    return [
      window.location.href,
      match.toLowerCase(),
      text.toLowerCase().replace(/\s+/g, " ").slice(0, 300),
    ].join("|");
  }

  function check() {
    if (!state.config.enabled) return;
    var now = Date.now();
    var clipKey = currentClipKey();

    // Skip-ads must run even when keyword list is empty, and must not
    // permanently consume the check loop on a failed/sticky match.
    if (state.config.autoClickSkipAdsEnabled && now - state.lastAdSkipAt >= 1500) {
      if (!isSkipExempt(clipKey)) {
        var adButton = findSkipAdsButton();
        if (adButton) {
          state.lastAdSkipAt = now;
          requestSkipAdsClick(function (ok) {
            if (ok) {
              markSkipExempt(clipKey);
              showOverlay("", "Skipped previous Ads");
              // Background also broadcasts reset to all frames; call locally too
              // so same-frame monitors refresh immediately.
              try {
                window.__volGestureAdSkipAt = Date.now();
                if (typeof window.__volGestureResetReleaseDateGates === "function") {
                  window.__volGestureResetReleaseDateGates();
                }
              } catch (_) {}
              triggerFastChecks();
            }
          });
        }
      }
    }

    if (!state.config.autoSkipByTypeEnabled) return;
    var keywords = parseKeywords(state.config.keywords);
    if (!keywords.length) return;
    if (now - state.lastSkipAt < ATTEMPT_COOLDOWN_MS) return;
    if (isSkipExempt(clipKey)) return;

    var video = activeVideo();
    if (!video || !isShortFormContext(video)) return;

    var text = collectText(video);
    var match = findKeywordMatch(text, keywords);
    if (!match) return;

    var signature = makeSignature(match, text);
    var direction = recentGestureDirection();
    var beforeUrl = window.location.href;
    var beforeScrollY = window.scrollY;
    state.lastSkipAt = now;

    requestNavigation(direction, function (ok) {
      if (!ok) {
        showOverlay(match, noMoveTitleForDirection(direction));
        return;
      }
      markSkipExempt(clipKey);
      // Popup appears after navigation, same timing as skip-ads.
      showOverlay(match, matchTitleForDirection(direction));

      setTimeout(function () {
        var nextVideo = activeVideo();
        var nextText = nextVideo ? collectText(nextVideo) : "";
        var nextSignature = nextVideo ? makeSignature(match, nextText) : "";
        var navigated =
          window.location.href !== beforeUrl ||
          Math.abs(window.scrollY - beforeScrollY) > 20 ||
          nextVideo !== video ||
          (nextSignature && nextSignature !== signature);
        if (navigated) {
          triggerFastChecks();
          return;
        } else {
          showOverlay(match, noMoveTitleForDirection(direction));
        }
      }, 1200);
    });
  }

  function scheduleCheck(delay) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(runCheckLoop, delay);
  }

  function runCheckLoop() {
    if (!state.config.enabled) {
      state.timer = null;
      return;
    }
    check();
    var interval = Date.now() < state.fastUntil
      ? FAST_CHECK_INTERVAL_MS
      : NORMAL_CHECK_INTERVAL_MS;
    scheduleCheck(interval);
  }

  function triggerFastChecks() {
    state.fastUntil = Date.now() + FAST_CHECK_WINDOW_MS;
    if (state.config.enabled) {
      scheduleCheck(0);
    }
  }

  function start() {
    triggerFastChecks();
  }

  window.__volGestureAutoSkip = {
    updateConfig: function (nextConfig) {
      state.config = nextConfig || {};
      if (!state.config.enabled && state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
        return;
      }
      if (state.config.enabled && !state.timer) {
        start();
      }
    },
  };

  installPageDirectionTracking();
  if (state.config.enabled) start();
}

// Injected into page MAIN world. Fetches reel HTML with the page's cookies so
// later SPA clips (not in the initial document) still yield publish_time.
// Streams the body and cancels as soon as an id-linked publish_time is found.
function fetchFacebookReelDateInMainWorld(contentId) {
  if (!contentId) return Promise.resolve(null);

  function extract(html, id) {
    if (!html || !id) return null;
    var esc = String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    var re1 = new RegExp(
      esc +
        "[\\s\\S]{0,2500}?\\\\?\"(?:publish_time|creation_time|created_time|upload_time|createTime)\\\\?\"\\s*:\\s*\\\\?\"?(\\d{10,13})",
      "i"
    );
    var re2 = new RegExp(
      "\\\\?\"(?:publish_time|creation_time|created_time|upload_time|createTime)\\\\?\"\\s*:\\s*\\\\?\"?(\\d{10,13})[\\s\\S]{0,2500}?" +
        esc,
      "i"
    );
    var m = html.match(re1) || html.match(re2);
    if (!m) return null;
    var raw = m[1];
    if (/^\d{10}$/.test(raw)) {
      var sec = Number(raw);
      if (sec >= 946684800 && sec <= 4102444800) {
        var dSec = new Date(sec * 1000);
        return {
          ms: dSec.getTime(),
          label: dSec.toISOString().slice(0, 10),
          raw: raw,
          hint: true,
        };
      }
    }
    if (/^\d{13}$/.test(raw)) {
      var msVal = Number(raw);
      if (msVal >= 946684800000 && msVal <= 4102444800000) {
        var dMs = new Date(msVal);
        return {
          ms: dMs.getTime(),
          label: dMs.toISOString().slice(0, 10),
          raw: raw,
          hint: true,
        };
      }
    }
    return null;
  }

  return (async function () {
    var url = "https://www.facebook.com/reel/" + contentId;
    try {
      var resp = await fetch(url, {
        credentials: "include",
        redirect: "follow",
        headers: {
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      if (!resp.ok) return null;

      // Stream and stop once publish_time near this id appears (often mid-body).
      if (resp.body && typeof resp.body.getReader === "function") {
        var reader = resp.body.getReader();
        var decoder = new TextDecoder("utf-8");
        var buf = "";
        var maxBytes = 1200000;
        while (buf.length < maxBytes) {
          var chunk = await reader.read();
          if (chunk.done) break;
          buf += decoder.decode(chunk.value || new Uint8Array(), { stream: true });
          var found = extract(buf, contentId);
          if (found) {
            try { reader.cancel(); } catch (_) {}
            return found;
          }
        }
        try { reader.cancel(); } catch (_) {}
        return extract(buf, contentId);
      }

      var html = await resp.text();
      return extract(html.slice(0, 1200000), contentId);
    } catch (_) {
      return null;
    }
  })();
}

// Injected into page MAIN world. Taps fetch/XHR so SPA GraphQL payloads that
// never land in <script> tags still yield id→publish_time pairs + reel id lists.
function installReleaseDateNetworkTap() {
  function postToHost(payload) {
    try {
      var w = window.top || window;
      w.postMessage(payload, "*");
    } catch (_) {
      try {
        window.postMessage(payload, "*");
      } catch (__) {}
    }
  }

  function postIds(ids) {
    if (!ids || !ids.length) return;
    postToHost({ source: "__volGestureReleaseDate", type: "reelIds", ids: ids });
  }

  function emitReelIds(text) {
    if (!text || typeof text !== "string") return;
    if (text.indexOf("reel") === -1 && text.indexOf("Reel") === -1) return;
    var ids = [];
    var seen = {};
    var re = /\\?\/reel\\?\/(\d{10,20})/gi;
    var m;
    while ((m = re.exec(text))) {
      var id = m[1];
      if (seen[id]) continue;
      seen[id] = true;
      ids.push(id);
      if (ids.length >= 40) break;
    }
    postIds(ids);
  }

  // Prefer /reel/<id> near publish_time so map keys match URL content ids.
  function bestIdNearTime(region, from, tIdx, unix) {
    var bestId = "";
    var bestDist = 1e15;
    var reelRe = /\\?\/reel\\?\/(\d{10,20})/gi;
    var rm;
    while ((rm = reelRe.exec(region))) {
      var rid = rm[1];
      if (rid === unix) continue;
      var rDist = Math.abs(from + rm.index - tIdx);
      if (rDist < bestDist) {
        bestDist = rDist;
        bestId = rid;
      }
    }
    if (bestId && bestDist <= 2500) return { id: bestId, dist: bestDist };

    bestId = "";
    bestDist = 1e15;
    var labeled =
      /\\?"(?:video_id|story_fbid|media_id|legacy_attachment_id|post_id|reel_id|id)\\?"\s*:\s*\\?"?(\d{14,20})/gi;
    var lm;
    while ((lm = labeled.exec(region))) {
      var lid = lm[1];
      if (lid === unix) continue;
      var lDist = Math.abs(from + lm.index - tIdx);
      if (lDist < bestDist) {
        bestDist = lDist;
        bestId = lid;
      }
    }
    if (bestId && bestDist <= 2500) return { id: bestId, dist: bestDist };

    bestId = "";
    bestDist = 1e15;
    var idRe = /\d{14,20}/g;
    var im;
    while ((im = idRe.exec(region))) {
      var id = im[0];
      if (id === unix) continue;
      var dist = Math.abs(from + im.index - tIdx);
      if (dist < bestDist) {
        bestDist = dist;
        bestId = id;
      }
    }
    if (bestId && bestDist <= 2500) return { id: bestId, dist: bestDist };
    return null;
  }

  function harvest(text) {
    if (!text || typeof text !== "string" || text.length < 40) return;
    // Always surface /reel/<id> paths for prefetch, even without dates.
    emitReelIds(text);
    if (
      text.indexOf("publish_time") === -1 &&
      text.indexOf("creation_time") === -1 &&
      text.indexOf("created_time") === -1 &&
      text.indexOf("createTime") === -1
    ) {
      return;
    }
    var entries = [];
    var seen = {};
    var re =
      /\\?"(?:publish_time|creation_time|created_time|upload_time|createTime)\\?"\s*:\s*\\?"?(\d{10,13})/gi;
    var m;
    while ((m = re.exec(text))) {
      var unix = m[1];
      var tIdx = m.index;
      var from = Math.max(0, tIdx - 2500);
      var to = Math.min(text.length, tIdx + m[0].length + 2500);
      var region = text.slice(from, to);
      var hit = bestIdNearTime(region, from, tIdx, unix);
      if (!hit) continue;
      var key = hit.id + ":" + unix;
      if (seen[key]) continue;
      seen[key] = true;
      entries.push([hit.id, unix]);
      if (entries.length >= 40) break;
    }
    if (!entries.length) return;
    postToHost({
      source: "__volGestureReleaseDate",
      type: "dates",
      entries: entries,
    });
  }

  // Hot-update harvest body on re-inject (wrappers call this global).
  window.__volGestureNetTapHarvest = harvest;

  function runHarvest(text) {
    try {
      var h = window.__volGestureNetTapHarvest;
      if (typeof h === "function") h(text);
    } catch (_) {}
  }

  function tapResponse(resp) {
    try {
      if (!resp || !resp.clone) return;
      var ct = "";
      try {
        ct = (resp.headers && resp.headers.get && resp.headers.get("content-type")) || "";
      } catch (_) {}
      if (
        ct &&
        ct.indexOf("json") === -1 &&
        ct.indexOf("javascript") === -1 &&
        ct.indexOf("text") === -1 &&
        ct.indexOf("octet") === -1
      ) {
        return;
      }
      resp
        .clone()
        .text()
        .then(runHarvest)
        .catch(function () {});
    } catch (_) {}
  }

  // Avoid double-wrapping. Pre-v3 taps ignore NetTapHarvest — refresh FB once.
  if (window.__volGestureNetTap) {
    window.__volGestureNetTap.version = 3;
    window.__volGestureNetTap.wrapped = true;
    return;
  }

  if (typeof window.fetch === "function") {
    var origFetch = window.fetch;
    window.fetch = function () {
      return origFetch.apply(this, arguments).then(function (resp) {
        tapResponse(resp);
        return resp;
      });
    };
  }

  if (typeof XMLHttpRequest !== "undefined") {
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      try {
        this.addEventListener("load", function () {
          try {
            if (typeof this.responseText === "string") runHarvest(this.responseText);
          } catch (_) {}
        });
      } catch (_) {}
      return origSend.apply(this, arguments);
    };
  }

  window.__volGestureNetTap = { version: 3, wrapped: true };
}

// Injected into pages. Shows original video release/made date (upper-left, 1s)
// when a clip starts playing. Prefers earliest original date; may ask background
// to fetch external/source links when the current page looks like a forward/repost.
function installReleaseDateMonitor(config) {
  // Only the top frame shows release dates / listens for harvest messages.
  // Iframes still run the MAIN-world network tap, which posts to window.top.
  try {
    if (window.top && window !== window.top) return;
  } catch (_) {
    return;
  }

  // Fixed-slot toasts: each message keeps its Y until it expires (no reflow/jump).
  function dismissReleaseToasts() {
    try {
      var nodes = document.querySelectorAll('[data-vol-gesture-kind="release"]');
      var slots = window.__volGestureToastSlots;
      for (var i = 0; i < nodes.length; i++) {
        var toast = nodes[i];
        var slotAttr = toast.getAttribute("data-vol-gesture-toast-slot");
        if (toast.parentNode) toast.parentNode.removeChild(toast);
        if (slots && slotAttr != null && slotAttr !== "") {
          var slot = Number(slotAttr);
          if (!isNaN(slot)) slots[slot] = false;
        }
      }
      if (slots) {
        while (slots.length && !slots[slots.length - 1]) slots.pop();
      }
    } catch (_) {}
  }
  window.__volGestureDismissReleaseToasts = dismissReleaseToasts;

  function showToast(text, kind) {
    if (!text) return;
    var label = String(text);
    if (kind === "release") {
      try {
        var root = window.top || window;
        var now = Date.now();
        if (
          root.__volGestureLastReleaseToast === label &&
          now - (root.__volGestureLastReleaseToastAt || 0) < 3000
        ) {
          return;
        }
        root.__volGestureLastReleaseToast = label;
        root.__volGestureLastReleaseToastAt = now;
      } catch (_) {}
    }
    if (!window.__volGestureToastSlots) window.__volGestureToastSlots = [];
    var slots = window.__volGestureToastSlots;
    var slot = 0;
    while (slot < slots.length && slots[slot]) slot++;
    if (slot === slots.length) slots.push(true);
    else slots[slot] = true;

    var toast = document.createElement("div");
    toast.setAttribute("data-vol-gesture-toast-slot", String(slot));
    if (kind) toast.setAttribute("data-vol-gesture-kind", kind);
    toast.style.cssText =
      "position:fixed;left:50%;transform:translateX(-50%);" +
      "top:" + (16 + slot * 44) + "px;" +
      "z-index:2147483647;pointer-events:none;" +
      "background:rgba(0,0,0,0.78);color:#fff;font-family:'Segoe UI',system-ui,sans-serif;" +
      "font-size:13px;font-weight:600;padding:8px 12px;border-radius:10px;opacity:0;" +
      "transition:opacity 0.15s ease;backdrop-filter:blur(6px);" +
      "box-shadow:0 2px 12px rgba(0,0,0,0.28);white-space:nowrap;" +
      "max-width:90vw;overflow:hidden;text-overflow:ellipsis;";
    toast.textContent = label;
    document.body.appendChild(toast);
    requestAnimationFrame(function () {
      toast.style.opacity = "1";
    });
    setTimeout(function () {
      if (!toast.parentNode) return;
      toast.style.opacity = "0";
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
        slots[slot] = false;
        while (slots.length && !slots[slots.length - 1]) slots.pop();
      }, 200);
    }, 2000);
  }

  window.__volGestureShowToast = function (text) {
    showToast(text);
  };

  if (window.__volGestureReleaseDate &&
      window.__volGestureReleaseDate.version === 23 &&
      window.__volGestureReleaseDate.updateConfig) {
    window.__volGestureReleaseDate.updateConfig(config);
    return;
  }
  if (window.__volGestureReleaseDate && window.__volGestureReleaseDate.kill) {
    window.__volGestureReleaseDate.kill();
  }

  var state = {
    config: config || {},
    dead: false,
    pendingKey: null,
    pendingContentIds: {},
    handledIds: {},
    dateByContentId: {},
    lastSeenContentId: "",
    lastShownContentId: "",
    lastShownAt: 0,
    lastSeenSrc: "",
    lastSeenDur: -1,
    coolId: "",
    coolUntil: 0,
    lastUrl: location.href,
    lastAgeSkipAt: 0,
    retryById: {},
    adSkipUntil: 0,
    playGen: 0,
    hadProgress: false,
    lastHarvestAt: 0,
    prefetchInFlight: {},
    lastPrefetchAt: 0,
    debug: {
      candidates: [],
      nearIds: [],
      needIds: [],
      lastEvent: "init",
      lastFetchId: "",
      lastFetchOk: null,
      lastFetchMs: 0,
      lastFetchAt: 0,
      mapSize: 0,
      currentId: "",
      inFlight: [],
    },
  };

  function updateConfig(next) {
    if (state.dead) return;
    state.config = next || {};
    removePrefetchDebugOverlay();
    if (state.config.enabled) scheduleScan(150);
  }

  function removePrefetchDebugOverlay() {
    var el = document.getElementById("__vol_gesture_prefetch_debug");
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  // Prefetch debug HUD disabled (v22). Keep no-op so call sites stay cheap.
  function refreshPrefetchDebug(extra) {
    if (!extra || typeof extra !== "object") return;
    Object.keys(extra).forEach(function (k) {
      state.debug[k] = extra[k];
    });
  }

  function resetGates() {
    if (state.dead) return;
    state.handledIds = {};
    state.pendingKey = null;
    state.pendingContentIds = {};
    state.coolId = "";
    state.coolUntil = 0;
    state.lastSeenSrc = "";
    state.lastSeenContentId = "";
    state.lastShownContentId = "";
    state.lastShownAt = 0;
    state.lastSeenDur = -1;
    state.retryById = {};
    state.adSkipUntil = Date.now() + 8000;
    state.playGen = (state.playGen || 0) + 1;
    state.hadProgress = false;
    scheduleScanSeries([100, 400, 1000, 2000]);
  }

  // Drop handled/soft marks for a content id so returning to that reel can toast again.
  function clearHandledForContentId(contentId) {
    if (!contentId) return;
    var prefixSoft = "soft:" + contentId;
    var prefixId = "id:" + contentId;
    Object.keys(state.handledIds).forEach(function (k) {
      if (k === prefixSoft || k.indexOf(prefixSoft + "|") === 0 ||
          k === prefixId || k.indexOf(prefixId + "|") === 0) {
        delete state.handledIds[k];
      }
    });
    delete state.pendingContentIds[contentId];
  }

  function noteActiveContentId(id) {
    if (!id) return;
    if (state.lastSeenContentId && state.lastSeenContentId !== id) {
      dismissReleaseToasts();
      clearHandledForContentId(state.lastSeenContentId);
      if (state.lastShownContentId === state.lastSeenContentId) {
        state.lastShownContentId = "";
        state.lastShownAt = 0;
      }
    }
    state.lastSeenContentId = id;
    refreshPrefetchDebug({ currentId: id, lastEvent: "active " + id });
  }

  function alive() {
    return !state.dead && state.config && state.config.enabled;
  }

  // Shared with auto-skip monitor via window.top so returning to a clip we already
  // age-/ad-skipped does not auto-skip again this session.
  function skipExemptMap() {
    try {
      var root = window.top || window;
      if (!root.__volGestureSkipExemptIds) root.__volGestureSkipExemptIds = {};
      return root.__volGestureSkipExemptIds;
    } catch (_) {
      if (!window.__volGestureSkipExemptIds) window.__volGestureSkipExemptIds = {};
      return window.__volGestureSkipExemptIds;
    }
  }

  function isSkipExempt(id) {
    return !!(id && skipExemptMap()[id]);
  }

  function markSkipExempt(id) {
    if (!id) return;
    skipExemptMap()[id] = true;
  }

  function rememberDateForId(id, unixOrRaw) {
    if (!id) return;
    var parsed = parseDateCandidate(unixOrRaw);
    if (!parsed || !parsed.absolute) return;
    var prev = state.dateByContentId[id];
    // Prefer the latest absolute stamp for a given content id.
    if (!prev || parsed.ms >= prev.ms) {
      state.dateByContentId[id] = {
        ms: parsed.ms,
        label: parsed.label,
        raw: parsed.raw,
        absolute: true,
        originalHint: true,
        idLinked: true,
      };
      refreshPrefetchDebug({ lastEvent: "map+" + id });
    }
  }

  function harvestPublishTimesFromText(text) {
    if (!text || text.length < 40) return;
    if (
      text.indexOf("publish_time") === -1 &&
      text.indexOf("creation_time") === -1 &&
      text.indexOf("created_time") === -1 &&
      text.indexOf("createTime") === -1
    ) {
      return;
    }
    var re =
      /\\?"(?:publish_time|creation_time|created_time|upload_time|createTime)\\?"\s*:\s*\\?"?(\d{10,13})/gi;
    var m;
    while ((m = re.exec(text))) {
      var unix = m[1];
      var tIdx = m.index;
      var from = Math.max(0, tIdx - 2500);
      var to = Math.min(text.length, tIdx + m[0].length + 2500);
      var region = text.slice(from, to);
      var bestId = "";
      var bestDist = 1e15;

      // Prefer /reel/<id> so keys match resolveContentId / URL ids.
      var reelRe = /\\?\/reel\\?\/(\d{10,20})/gi;
      var rm;
      while ((rm = reelRe.exec(region))) {
        var rid = rm[1];
        if (rid === unix) continue;
        var rDist = Math.abs(from + rm.index - tIdx);
        if (rDist < bestDist) {
          bestDist = rDist;
          bestId = rid;
        }
      }

      if (!bestId || bestDist > 2500) {
        bestId = "";
        bestDist = 1e15;
        var labeled =
          /\\?"(?:video_id|story_fbid|media_id|legacy_attachment_id|post_id|reel_id|id)\\?"\s*:\s*\\?"?(\d{14,20})/gi;
        var lm;
        while ((lm = labeled.exec(region))) {
          var lid = lm[1];
          if (lid === unix) continue;
          var lDist = Math.abs(from + lm.index - tIdx);
          if (lDist < bestDist) {
            bestDist = lDist;
            bestId = lid;
          }
        }
      }

      if (!bestId || bestDist > 2500) {
        bestId = "";
        bestDist = 1e15;
        var idRe = /\d{14,20}/g;
        var im;
        while ((im = idRe.exec(region))) {
          var id = im[0];
          if (id === unix) continue;
          var dist = Math.abs(from + im.index - tIdx);
          if (dist < bestDist) {
            bestDist = dist;
            bestId = id;
          }
        }
      }

      if (bestId && bestDist <= 2500) rememberDateForId(bestId, unix);
    }
  }

  function harvestFromDomScripts() {
    var scripts = document.querySelectorAll("script");
    for (var i = 0; i < scripts.length; i++) {
      var body = scripts[i].textContent || "";
      if (body.length >= 40 && body.length < 2000000) harvestPublishTimesFromText(body);
    }
    state.lastHarvestAt = Date.now();
    // New ids in scripts → warm their dates before the user swipes.
    prefetchNearbyReelDates(true);
  }

  function dateFromMap(contentId) {
    if (!contentId) return null;
    return state.dateByContentId[contentId] || null;
  }

  function contentIdFromLocation() {
    var href = location.href || "";
    var path = location.pathname || "";
    var host = location.hostname || "";
    var m;
    if (/facebook\.com/i.test(host)) {
      m = path.match(/\/(?:reel|reels|videos)\/(\d+)/i);
      if (m) return m[1];
      try {
        m = new URL(href).searchParams.get("v");
        if (m && /^\d+$/.test(m)) return m;
      } catch (_) {}
    }
    if (/youtube\.com|youtu\.be/i.test(host)) {
      m = path.match(/\/shorts\/([\w-]{6,})/i);
      if (m) return m[1];
      if (/youtu\.be/i.test(host)) {
        m = path.match(/^\/([\w-]{6,})/);
        if (m) return m[1];
      }
      try {
        m = new URL(href).searchParams.get("v");
        if (m) return m;
      } catch (_) {}
    }
    if (/tiktok\.com/i.test(host)) {
      m = path.match(/\/video\/(\d+)/);
      if (m) return m[1];
    }
    return "";
  }

  // When URL is /reels/ (no numeric id), recover id from nearby reel links.
  function contentIdFromDom(video) {
    if (!/facebook\.com/i.test(location.hostname || "")) return "";
    var roots = [];
    var node = video;
    var depth = 0;
    while (node && node !== document.body && depth < 8) {
      roots.push(node);
      node = node.parentElement;
      depth++;
    }
    roots.push(document.querySelector('[role="main"]') || document.body);
    var seen = {};
    for (var r = 0; r < roots.length; r++) {
      var root = roots[r];
      if (!root || !root.querySelectorAll) continue;
      var anchors = root.querySelectorAll('a[href*="/reel/"], a[href*="/reels/"]');
      for (var i = 0; i < anchors.length; i++) {
        var href = anchors[i].href || anchors[i].getAttribute("href") || "";
        var m = String(href).match(/\/(?:reel|reels)\/(\d{10,})/i);
        if (!m) continue;
        var id = m[1];
        if (seen[id]) continue;
        seen[id] = true;
        // Prefer a link close to the viewport center (active reel).
        try {
          var rect = anchors[i].getBoundingClientRect();
          var cy = (rect.top + rect.bottom) / 2;
          if (cy > window.innerHeight * 0.15 && cy < window.innerHeight * 0.85) {
            return id;
          }
        } catch (_) {
          return id;
        }
      }
    }
    var ids = Object.keys(seen);
    return ids.length === 1 ? ids[0] : "";
  }

  function resolveContentId(video) {
    return contentIdFromLocation() || contentIdFromDom(video) || "";
  }

  function softFingerprint(contentId, video) {
    if (!contentId) return "";
    var src = "";
    var dur = 0;
    try { src = (video && (video.currentSrc || video.src)) || ""; } catch (_) {}
    try {
      if (video && isFinite(video.duration) && video.duration > 0) {
        dur = Math.round(video.duration);
      }
    } catch (_) {}
    return "soft:" + contentId + "|d:" + dur + "|s:" + String(src).slice(-80);
  }

  function clipIdentity(video) {
    var id = resolveContentId(video);
    var src = "";
    var dur = 0;
    try { src = (video && (video.currentSrc || video.src)) || ""; } catch (_) {}
    try {
      if (video && isFinite(video.duration) && video.duration > 0) {
        dur = Math.round(video.duration);
      }
    } catch (_) {}
    try {
      var ct = video && video.currentTime;
      if (typeof ct === "number" && ct > 2) state.hadProgress = true;
    } catch (_) {}
    // Stable key: do NOT include playGen — bumps during async fetch were aborting
    // valid local dates after age-skip navigation churn.
    var key =
      "id:" + id +
      "|d:" + dur +
      "|s:" + String(src).slice(-100);
    return { key: key, contentId: id, src: src, duration: dur };
  }

  function parseDateCandidate(raw) {
    if (raw === null || raw === undefined || raw === "") return null;
    var text = String(raw).trim();
    if (!text) return null;
    if (/^\d{10}$/.test(text)) {
      var sec = Number(text);
      if (sec >= 946684800 && sec <= 4102444800) {
        var dSec = new Date(sec * 1000);
        return { ms: dSec.getTime(), label: dSec.toISOString().slice(0, 10), raw: text, absolute: true };
      }
    }
    if (/^\d{13}$/.test(text)) {
      var msVal = Number(text);
      if (msVal >= 946684800000 && msVal <= 4102444800000) {
        var dMs = new Date(msVal);
        return { ms: dMs.getTime(), label: dMs.toISOString().slice(0, 10), raw: text, absolute: true };
      }
    }
    var iso = text.match(/\b(20\d{2}|19\d{2})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (iso) {
      var dIso = new Date(iso[0]);
      if (!isNaN(dIso.getTime())) {
        return { ms: dIso.getTime(), label: iso[0].slice(0, 10), raw: text, absolute: true };
      }
    }
    var abs = text.match(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}\b/i);
    if (abs) {
      var dAbs = new Date(abs[0]);
      if (!isNaN(dAbs.getTime())) {
        return { ms: dAbs.getTime(), label: dAbs.toISOString().slice(0, 10), raw: abs[0], absolute: true };
      }
    }
    var rel = text.match(/\b(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago\b/i);
    if (rel) {
      var n = Number(rel[1]);
      var unit = rel[2].toLowerCase();
      var mult = { second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000, year: 31536000000 };
      if (mult[unit]) {
        var dRel = new Date(Date.now() - n * mult[unit]);
        return { ms: dRel.getTime(), label: dRel.toISOString().slice(0, 10), raw: rel[0], absolute: false };
      }
    }
    var shortRel = text.match(/\b(\d+)\s*([smhdwy])\b/i);
    if (shortRel) {
      var sn = Number(shortRel[1]);
      var su = shortRel[2].toLowerCase();
      var smult = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000, y: 31536000000 };
      if (smult[su] && sn > 0 && sn < 4000) {
        var dShort = new Date(Date.now() - sn * smult[su]);
        return { ms: dShort.getTime(), label: dShort.toISOString().slice(0, 10), raw: shortRel[0], absolute: false };
      }
    }
    var d = new Date(text);
    if (!isNaN(d.getTime()) && d.getFullYear() >= 1990 && d.getFullYear() <= 2100) {
      return { ms: d.getTime(), label: d.toISOString().slice(0, 10), raw: text, absolute: true };
    }
    return null;
  }

  function pushCandidate(list, raw, opts) {
    var parsed = parseDateCandidate(raw);
    if (!parsed) return;
    list.push({
      ms: parsed.ms,
      label: parsed.label,
      raw: parsed.raw,
      absolute: parsed.absolute,
      originalHint: !!(opts && opts.originalHint),
      external: !!(opts && opts.external),
      idLinked: !!(opts && opts.idLinked),
    });
  }

  function collectJsonLdDates(list) {
    var scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < scripts.length; i++) {
      var body = scripts[i].textContent || "";
      if (!body) continue;
      try {
        var data = JSON.parse(body);
        var stack = Array.isArray(data) ? data.slice() : [data];
        while (stack.length) {
          var node = stack.pop();
          if (!node || typeof node !== "object") continue;
          var type = String(node["@type"] || "").toLowerCase();
          var isVideo = type.indexOf("video") !== -1 || type.indexOf("movie") !== -1 || type.indexOf("clip") !== -1;
          if (node.uploadDate) pushCandidate(list, node.uploadDate, { originalHint: isVideo });
          if (node.datePublished) pushCandidate(list, node.datePublished, { originalHint: isVideo });
          if (node.releaseDate) pushCandidate(list, node.releaseDate, { originalHint: true });
          if (node.dateCreated) pushCandidate(list, node.dateCreated, { originalHint: isVideo });
          for (var key in node) {
            if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
            var val = node[key];
            if (val && typeof val === "object") stack.push(val);
          }
        }
      } catch (_) {}
    }
  }

  function collectMetaDates(list) {
    var metas = document.querySelectorAll("meta");
    for (var i = 0; i < metas.length; i++) {
      var m = metas[i];
      var prop = ((m.getAttribute("property") || "") + " " + (m.getAttribute("name") || "") + " " + (m.getAttribute("itemprop") || "")).toLowerCase();
      if (
        prop.indexOf("uploaddate") !== -1 ||
        prop.indexOf("datepublished") !== -1 ||
        prop.indexOf("release_date") !== -1 ||
        prop.indexOf("releasedate") !== -1 ||
        prop.indexOf("published_time") !== -1 ||
        prop.indexOf("datecreated") !== -1
      ) {
        pushCandidate(list, m.getAttribute("content") || "", { originalHint: true });
      }
    }
    var times = document.querySelectorAll("time[datetime]");
    for (var t = 0; t < times.length; t++) {
      pushCandidate(list, times[t].getAttribute("datetime") || "", { originalHint: false });
    }
  }

  function collectEmbeddedScriptDates(list, contentId) {
    var scripts = document.querySelectorAll("script");
    var chunks = [];
    for (var i = 0; i < scripts.length; i++) {
      var body = scripts[i].textContent || "";
      if (!body || body.length < 40) continue;
      if (contentId && body.indexOf(contentId) !== -1) {
        chunks.push(body);
      } else if (!contentId &&
          /"publish(?:_time|Date)"|"uploadDate"|"creation_time"|"created_time"|"createTime"|ytInitialPlayerResponse/.test(body)) {
        if (body.length < 1500000) chunks.push(body.slice(0, 400000));
      }
    }
    // Only scan full HTML when we have a content id (and then only id-linked matches),
    // so prior Facebook SPA clips cannot poison later dates.
    if (contentId) {
      try {
        var html = document.documentElement && document.documentElement.innerHTML;
        if (html) chunks.push(html.slice(0, 900000));
      } catch (_) {}
    }

    for (var c = 0; c < chunks.length; c++) {
      var text = chunks[c];
      if (contentId) {
        var escId = contentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        var nearRe = new RegExp(
          escId + "[\\s\\S]{0,2500}?\\\\?\"(?:publish_time|creation_time|created_time|upload_time|createTime)\\\\?\"\\s*:\\s*\\\\?\"?(\\d{10,13})",
          "gi"
        );
        var nm;
        while ((nm = nearRe.exec(text))) {
          pushCandidate(list, nm[1], { originalHint: true, idLinked: true });
          rememberDateForId(contentId, nm[1]);
        }
        var nearRe2 = new RegExp(
          "\\\\?\"(?:publish_time|creation_time|created_time|upload_time|createTime)\\\\?\"\\s*:\\s*\\\\?\"?(\\d{10,13})[\\s\\S]{0,2500}?" + escId,
          "gi"
        );
        while ((nm = nearRe2.exec(text))) {
          pushCandidate(list, nm[1], { originalHint: true, idLinked: true });
          rememberDateForId(contentId, nm[1]);
        }
        // Do not collect unlabeled page-wide publish_time when contentId is known.
        continue;
      }
      var labeledRe = /\\?"(?:publish_time|creation_time|created_time|upload_time|createTime|publishDate|uploadDate|datePublished)\\?"\s*:\s*\\?"?(\d{10,13}|20\d{2}-\d{2}-\d{2}[^"\\]*)/gi;
      var lm;
      while ((lm = labeledRe.exec(text))) {
        pushCandidate(list, lm[1], { originalHint: true });
      }
    }
  }

  function nearbyText(video) {
    var parts = [document.title || ""];
    var node = video;
    var depth = 0;
    while (node && node !== document.body && depth < 8) {
      if (node.getAttribute) {
        parts.push(node.getAttribute("aria-label") || "");
        parts.push(node.getAttribute("title") || "");
      }
      if (node.innerText && node.innerText.length < 4000) parts.push(node.innerText);
      node = node.parentElement;
      depth++;
    }
    try {
      var main = document.querySelector('[role="main"]') || document.body;
      if (main && main.innerText && main.innerText.length < 20000) {
        parts.push(main.innerText.slice(0, 8000));
      }
    } catch (_) {}
    return parts.join("\n");
  }

  function collectTextDates(list, video) {
    var text = nearbyText(video);
    if (!text) return;
    var patterns = [
      /\b(?:Premiered|Uploaded|Published|Released|Posted|Shared)\s*(?:on\s*)?:?\s*([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})\b/gi,
      /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}\b/g,
      /\b\d+\s*(?:second|minute|hour|day|week|month|year)s?\s+ago\b/gi,
      /\b\d+\s*[dhwy]\b/gi,
    ];
    for (var p = 0; p < patterns.length; p++) {
      var re = patterns[p];
      var m;
      while ((m = re.exec(text))) {
        pushCandidate(list, m[1] || m[0], { originalHint: false });
        if (list.length > 20) return;
      }
    }
  }

  function isExternalMediaUrl(href) {
    if (!href || href.indexOf("http") !== 0) return false;
    try {
      var u = new URL(href, location.href);
      if (u.hostname === location.hostname) return false;
      return /youtube\.com|youtu\.be|tiktok\.com|instagram\.com|vimeo\.com|facebook\.com|fb\.watch|twitter\.com|x\.com|reddit\.com|dailymotion\.com|bilibili\.com/i.test(u.hostname);
    } catch (_) {
      return false;
    }
  }

  function collectExternalCandidates(video) {
    var urls = [];
    var seen = {};
    function add(href, boost) {
      if (!href) return;
      try { href = new URL(href, location.href).href; } catch (_) { return; }
      if (!isExternalMediaUrl(href) && !boost) return;
      if (seen[href]) return;
      seen[href] = true;
      urls.push({ href: href, boost: !!boost });
    }

    add(location.href, true);

    var scope = video;
    var depth = 0;
    while (scope && scope !== document.body && depth < 6) {
      scope = scope.parentElement;
      depth++;
    }
    if (!scope) scope = document;

    var anchors = scope.querySelectorAll("a[href]");
    for (var i = 0; i < anchors.length && urls.length < 12; i++) {
      var a = anchors[i];
      var label = ((a.textContent || "") + " " + (a.getAttribute("aria-label") || "") + " " + (a.getAttribute("title") || "")).toLowerCase();
      var boost = /\b(original|source|via|credit|from|watch on|full video|originally)\b/.test(label);
      add(a.href, boost);
    }

    var pageAnchors = document.querySelectorAll("a[href]");
    for (var j = 0; j < pageAnchors.length && urls.length < 16; j++) {
      var pa = pageAnchors[j];
      var plabel = ((pa.textContent || "") + " " + (pa.getAttribute("aria-label") || "") + " " + (pa.getAttribute("title") || "")).toLowerCase();
      if (/\b(original|source|via|credit|full video|originally posted)\b/.test(plabel)) add(pa.href, true);
      else if (isExternalMediaUrl(pa.href)) add(pa.href, false);
    }

    try {
      var blob = (document.body && document.body.innerText) || "";
      var bare = blob.match(/https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=[\w-]+|youtu\.be\/[\w-]+|tiktok\.com\/@[\w.]+\/video\/\d+)/gi) || [];
      for (var b = 0; b < bare.length && urls.length < 18; b++) add(bare[b], true);
    } catch (_) {}

    urls.sort(function (a, b) { return (b.boost ? 1 : 0) - (a.boost ? 1 : 0); });
    return urls.slice(0, 6).map(function (u) { return u.href; });
  }

  function pickBest(list, contentId) {
    if (!list || !list.length) return null;
    var idLinked = list.filter(function (c) { return c.idLinked; });
    // With a known clip id, only trust id-linked dates. Falling back to JSON-LD /
    // meta / earliest SPA leftovers is what wrongly age-skipped fresh reels.
    if (contentId) {
      if (!idLinked.length) return null;
      var absId = idLinked.filter(function (c) { return c.absolute; });
      var poolId = absId.length ? absId : idLinked;
      poolId.sort(function (a, b) { return a.ms - b.ms; });
      return poolId[poolId.length - 1];
    }
    var external = list.filter(function (c) { return c.external; });
    var pool = external.length
      ? external
      : list.filter(function (c) { return c.originalHint || c.external; });
    if (!pool.length) pool = list;
    var absolute = pool.filter(function (c) { return c.absolute; });
    if (absolute.length) pool = absolute;
    pool.sort(function (a, b) { return a.ms - b.ms; });
    return pool[pool.length - 1];
  }

  function showOverlay(label) {
    if (!label) return;
    if (/^Released /i.test(String(label))) {
      showToast(label, "release");
      return;
    }
    showToast(label);
  }

  function maxAgeMs(code) {
    if (code === "1d") return 1 * 86400000;
    if (code === "1w") return 7 * 86400000;
    if (code === "1m") return 30 * 86400000;
    if (code === "1y") return 365 * 86400000;
    return 0;
  }

  function maxAgeLabel(code) {
    if (code === "1d") return "1 day";
    if (code === "1w") return "1 week";
    if (code === "1m") return "1 month";
    if (code === "1y") return "1 year";
    return "";
  }

  function requestAgeSkip(callback) {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
      if (callback) callback(false);
      return;
    }
    chrome.runtime.sendMessage(
      { type: "autoSkipNavigate", direction: "next" },
      function (response) {
        if (chrome.runtime.lastError || !response || !response.ok) {
          if (callback) callback(false);
          return;
        }
        if (callback) callback(true);
      }
    );
  }

  function fetchExternalDates(urls, contentId) {
    return new Promise(function (resolve) {
      if (!urls || !urls.length) {
        resolve([]);
        return;
      }
      var done = false;
      function finish(value) {
        if (done) return;
        done = true;
        resolve(value);
      }
      // Prevent pendingKey from sticking forever if the SW never answers.
      setTimeout(function () { finish([]); }, 5000);
      try {
        chrome.runtime.sendMessage(
          { type: "fetchReleaseDate", urls: urls, contentId: contentId || "" },
          function (resp) {
            if (chrome.runtime.lastError) {
              finish([]);
              return;
            }
            if (resp && resp.ok && resp.result) {
              finish([{
                ms: resp.result.ms,
                label: resp.result.label,
                raw: resp.result.raw || resp.result.label,
                absolute: true,
                originalHint: true,
                external: true,
                // Only treat as id-linked when the background parser matched near the id.
                idLinked: !!(contentId && resp.result.hint),
              }]);
            } else {
              finish([]);
            }
          }
        );
      } catch (_) {
        finish([]);
      }
    });
  }

  // Stream-fetch www reel HTML in this content script (no SW/MAIN hop).
  // Extension host_permissions + credentials include the user's Facebook cookies.
  function extractReelPublishTime(html, id) {
    if (!html || !id) return null;
    var esc = String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    var re1 = new RegExp(
      esc +
        "[\\s\\S]{0,2500}?\\\\?\"(?:publish_time|creation_time|created_time|upload_time|createTime)\\\\?\"\\s*:\\s*\\\\?\"?(\\d{10,13})",
      "i"
    );
    var re2 = new RegExp(
      "\\\\?\"(?:publish_time|creation_time|created_time|upload_time|createTime)\\\\?\"\\s*:\\s*\\\\?\"?(\\d{10,13})[\\s\\S]{0,2500}?" +
        esc,
      "i"
    );
    var m = html.match(re1) || html.match(re2);
    if (!m) return null;
    var raw = m[1];
    if (/^\d{10}$/.test(raw)) {
      var sec = Number(raw);
      if (sec >= 946684800 && sec <= 4102444800) {
        var dSec = new Date(sec * 1000);
        return {
          ms: dSec.getTime(),
          label: dSec.toISOString().slice(0, 10),
          raw: raw,
          hint: true,
        };
      }
    }
    if (/^\d{13}$/.test(raw)) {
      var msVal = Number(raw);
      if (msVal >= 946684800000 && msVal <= 4102444800000) {
        var dMs = new Date(msVal);
        return {
          ms: dMs.getTime(),
          label: dMs.toISOString().slice(0, 10),
          raw: raw,
          hint: true,
        };
      }
    }
    return null;
  }

  function fetchReelHtmlDate(contentId) {
    return (async function () {
      var url = "https://www.facebook.com/reel/" + contentId;
      var resp = await fetch(url, {
        credentials: "include",
        redirect: "follow",
        headers: {
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      if (!resp.ok) return null;
      if (resp.body && typeof resp.body.getReader === "function") {
        var reader = resp.body.getReader();
        var decoder = new TextDecoder("utf-8");
        var buf = "";
        var maxBytes = 900000;
        while (buf.length < maxBytes) {
          var chunk = await reader.read();
          if (chunk.done) break;
          buf += decoder.decode(chunk.value || new Uint8Array(), { stream: true });
          // Cheap gate before expensive regex.
          if (buf.indexOf(contentId) === -1 || buf.indexOf("publish_time") === -1) {
            continue;
          }
          var found = extractReelPublishTime(buf, contentId);
          if (found) {
            try { reader.cancel(); } catch (_) {}
            return found;
          }
        }
        try { reader.cancel(); } catch (_) {}
        return extractReelPublishTime(buf, contentId);
      }
      var html = await resp.text();
      return extractReelPublishTime(html.slice(0, 900000), contentId);
    })().catch(function () { return null; });
  }

  // Dedupes in-flight requests so prefetch + handlePlay share one fetch.
  function fetchPageReelDate(contentId) {
    if (!contentId || !/facebook\.com/i.test(location.hostname || "")) {
      return Promise.resolve(null);
    }
    if (state.dateByContentId[contentId]) {
      refreshPrefetchDebug({
        lastEvent: "map-hit " + contentId,
        lastFetchId: contentId,
        lastFetchOk: true,
        lastFetchMs: 0,
      });
      return Promise.resolve({
        ms: state.dateByContentId[contentId].ms,
        label: state.dateByContentId[contentId].label,
        raw: state.dateByContentId[contentId].raw,
        hint: true,
      });
    }
    if (state.prefetchInFlight[contentId]) {
      refreshPrefetchDebug({ lastEvent: "await-inflight " + contentId });
      return state.prefetchInFlight[contentId];
    }
    var t0 = Date.now();
    refreshPrefetchDebug({
      lastEvent: "fetch-start " + contentId,
      lastFetchId: contentId,
      lastFetchOk: null,
    });
    var promise = fetchReelHtmlDate(contentId).then(function (hit) {
      delete state.prefetchInFlight[contentId];
      var ms = Date.now() - t0;
      if (hit && hit.label) {
        rememberDateForId(contentId, hit.raw || hit.label);
        refreshPrefetchDebug({
          lastEvent: "fetch-ok " + contentId,
          lastFetchId: contentId,
          lastFetchOk: true,
          lastFetchMs: ms,
          lastFetchAt: Date.now(),
        });
      } else {
        refreshPrefetchDebug({
          lastEvent: "fetch-fail " + contentId,
          lastFetchId: contentId,
          lastFetchOk: false,
          lastFetchMs: ms,
          lastFetchAt: Date.now(),
        });
      }
      return hit;
    }, function () {
      delete state.prefetchInFlight[contentId];
      refreshPrefetchDebug({
        lastEvent: "fetch-error " + contentId,
        lastFetchId: contentId,
        lastFetchOk: false,
        lastFetchMs: Date.now() - t0,
      });
      return null;
    });
    state.prefetchInFlight[contentId] = promise;
    refreshPrefetchDebug({});
    return promise;
  }

  // Warm dateByContentId for upcoming reels. Facebook rarely puts next ids in
  // <a href>; they live in script/JSON as /reel/<id> or \/reel\/<id>.
  // Returns unmapped ids to fetch; also records near (all discovered) for HUD.
  function collectNearbyReelIds(limit) {
    var near = [];
    var need = [];
    var seen = {};
    var cur = resolveContentId(activeVideo());
    if (cur) seen[cur] = true;
    var max = limit || 5;

    function consider(id) {
      if (!id || seen[id]) return;
      if (!/^\d{10,20}$/.test(id)) return;
      seen[id] = true;
      near.push(id);
      if (!state.dateByContentId[id] && need.length < max) need.push(id);
    }

    var anchors = document.querySelectorAll('a[href*="/reel/"], a[href*="/reels/"]');
    for (var i = 0; i < anchors.length; i++) {
      var href = anchors[i].href || anchors[i].getAttribute("href") || "";
      var m = String(href).match(/\/(?:reel|reels)\/(\d{10,})/i);
      if (m) consider(m[1]);
    }

    // Script / embedded JSON paths (most common on Reels SPA).
    var scripts = document.querySelectorAll("script");
    var rePath = /\\?\/reel\\?\/(\d{10,20})/gi;
    var reVid = /\\?"(?:video_id|legacy_attachment_id|story_fbid|reel_id)\\?"\s*:\s*\\?"?(\d{10,20})/gi;
    for (var s = 0; s < scripts.length; s++) {
      var body = scripts[s].textContent || "";
      if (body.length < 40 || body.length > 2000000) continue;
      if (body.indexOf("reel") === -1 && body.indexOf("video_id") === -1 &&
          body.indexOf("publish_time") === -1) {
        continue;
      }
      var pm;
      rePath.lastIndex = 0;
      while ((pm = rePath.exec(body))) consider(pm[1]);
      reVid.lastIndex = 0;
      while ((pm = reVid.exec(body))) consider(pm[1]);
    }

    state.debug.nearIds = near.slice(0, 12);
    state.debug.needIds = need.slice(0, max);
    state.debug.candidates = need.slice(0, max);
    return need;
  }

  function queuePrefetchIds(ids, eventLabel) {
    if (!ids || !ids.length) return;
    var queued = [];
    var cur = resolveContentId(activeVideo());
    for (var i = 0; i < ids.length; i++) {
      var id = String(ids[i] || "");
      if (!id || !/^\d{10,20}$/.test(id)) continue;
      if (cur && id === cur) continue;
      if (state.dateByContentId[id]) continue;
      if (state.prefetchInFlight[id]) continue;
      queued.push(id);
      if (queued.length >= 5) break;
    }
    if (!queued.length) {
      refreshPrefetchDebug({
        lastEvent: (eventLabel || "queue") + "-none",
        nearIds: (state.debug.nearIds || []).concat(ids).slice(0, 12),
      });
      return;
    }
    var nearMerged = (state.debug.nearIds || []).slice();
    queued.forEach(function (id) {
      if (nearMerged.indexOf(id) === -1) nearMerged.push(id);
    });
    refreshPrefetchDebug({
      lastEvent: (eventLabel || "queue") + "-" + queued.length,
      nearIds: nearMerged.slice(0, 12),
      needIds: queued.slice(),
      candidates: queued.slice(),
    });
    queued.forEach(function (id) {
      fetchPageReelDate(id);
    });
  }

  function prefetchNearbyReelDates(force) {
    if (!alive()) return;
    if (!/facebook\.com/i.test(location.hostname || "")) return;
    if (!force && Date.now() - (state.lastPrefetchAt || 0) < 400) return;
    state.lastPrefetchAt = Date.now();
    var ids = collectNearbyReelIds(5);
    refreshPrefetchDebug({
      lastEvent: force ? "prefetch-force" : "prefetch-scan",
      candidates: ids.slice(),
      needIds: ids.slice(),
      nearIds: (state.debug.nearIds || []).slice(),
    });
    try {
      console.log("[VolumeGesture][releaseDate] prefetch near/need", state.debug.nearIds, ids);
    } catch (_) {}
    ids.forEach(function (id) {
      if (state.dateByContentId[id]) return;
      if (state.prefetchInFlight[id]) return;
      fetchPageReelDate(id);
    });
  }

  function activeVideo() {
    var videos = Array.prototype.slice.call(document.querySelectorAll("video"));
    var best = null;
    var bestScore = 0;
    for (var i = 0; i < videos.length; i++) {
      var video = videos[i];
      var rect = video.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      var visible = Math.max(0, Math.min(window.innerWidth, rect.right) - Math.max(0, rect.left)) *
        Math.max(0, Math.min(window.innerHeight, rect.bottom) - Math.max(0, rect.top));
      var ratio = visible / (rect.width * rect.height);
      if (ratio < 0.15) continue;
      var score = ratio + (video.paused ? 0 : 1.5);
      if (score > bestScore) {
        best = video;
        bestScore = score;
      }
    }
    return best;
  }

  async function handlePlay(video) {
    if (!alive()) return;
    if (!video) video = activeVideo();
    if (!video) return;

    var ident = clipIdentity(video);
    var key = ident.key;
    var contentId = ident.contentId;
    var startSrc = ident.src || "";
    if (!key) return;

    if (contentId) noteActiveContentId(contentId);

    // Brief cooldown only for the clip we just age-skipped.
    if (contentId && contentId === state.coolId && Date.now() < state.coolUntil) return;

    // Burst suppress: same reel id shown moments ago (reload/play/playing/metadata races).
    if (contentId &&
        contentId === state.lastShownContentId &&
        Date.now() - (state.lastShownAt || 0) < 2500) {
      return;
    }

    if (state.handledIds[key]) return;
    var softKeyEarly = softFingerprint(contentId, video);
    if (softKeyEarly && state.handledIds[softKeyEarly]) return;
    if (state.pendingKey === key) return;
    if (contentId && state.pendingContentIds[contentId]) return;
    state.pendingKey = key;
    if (contentId) state.pendingContentIds[contentId] = true;

    function stillSameClip() {
      var nowId = resolveContentId(video);
      if (contentId) return (nowId || "") === contentId;
      var now = clipIdentity(video);
      var nowSrc = now.src || "";
      if (startSrc && nowSrc && startSrc !== nowSrc) return false;
      return true;
    }

    function debugMiss(reason) {
      try {
        console.log("[VolumeGesture][releaseDate]", reason, {
          contentId: contentId || "",
          key: key,
        });
      } catch (_) {}
    }

    function applyBest(best, contentIdNow) {
      if (!best || !best.label) return false;
      if (!stillSameClip()) {
        debugMiss("stale_abort_before_apply");
        return false;
      }
      var idNow = contentIdNow || contentId || "";
      if (idNow &&
          idNow === state.lastShownContentId &&
          Date.now() - (state.lastShownAt || 0) < 2500) {
        return true;
      }
      var identNow = clipIdentity(video);
      var finalKey = identNow.key || key;
      var softKey = softFingerprint(idNow, video);
      if (state.handledIds[finalKey] || (softKey && state.handledIds[softKey])) return true;
      state.handledIds[finalKey] = true;
      state.handledIds[key] = true;
      if (softKey) state.handledIds[softKey] = true;
      state.retryById[finalKey] = 0;
      if (idNow) {
        rememberDateForId(idNow, best.raw || best.label);
        state.lastShownContentId = idNow;
        state.lastShownAt = Date.now();
      }

      var showDate = typeof state.config.showDateOverlay === "undefined"
        ? true
        : !!state.config.showDateOverlay;

      var ageCode = state.config.autoSkipMaxAge || "";
      var limitMs = maxAgeMs(ageCode);
      var tooOld = limitMs > 0 && best.idLinked && typeof best.ms === "number" &&
        best.ms < (Date.now() - limitMs);

      if (showDate) {
        showOverlay("Released " + best.label);
      }
      setTimeout(prefetchNearbyReelDates, 300);

      // User already bounced off this clip once (age/ads); let them watch on return.
      if (idNow && isSkipExempt(idNow)) {
        return true;
      }

      if (tooOld && Date.now() - state.lastAgeSkipAt >= 1500) {
        state.lastAgeSkipAt = Date.now();
        var skippedId = contentIdNow || contentId || "";
        setTimeout(function () {
          // Drop the old release toast before/while navigating away.
          dismissReleaseToasts();
          requestAgeSkip(function (ok) {
            dismissReleaseToasts();
            if (ok) {
              markSkipExempt(skippedId);
              showOverlay(
                "Skipped previous video due to " +
                  best.label +
                  " > " +
                  maxAgeLabel(ageCode)
              );
            }
            state.coolId = skippedId;
            state.coolUntil = Date.now() + 1500;
            state.pendingKey = null;
            setTimeout(function () {
              if (state.coolId === skippedId) {
                state.coolId = "";
                state.coolUntil = 0;
              }
              scheduleScan(300);
            }, 1600);
          });
        }, showDate ? 700 : 200);
      }
      return true;
    }

    try {
      if (Date.now() - (state.lastHarvestAt || 0) > 2000) {
        harvestFromDomScripts();
      }

      var local = [];
      // Map first: network tap / prior scans often already know this reel's date.
      var mapped = dateFromMap(contentId);
      if (mapped) {
        local.push({
          ms: mapped.ms,
          label: mapped.label,
          raw: mapped.raw,
          absolute: true,
          originalHint: true,
          idLinked: true,
        });
      }

      // Only id-scoped embedded dates when we know the clip id. JSON-LD/meta are
      // often site-wide and caused false "too old" skips on the first reel.
      if (contentId) {
        collectEmbeddedScriptDates(local, contentId);
      } else {
        collectJsonLdDates(local);
        collectMetaDates(local);
        collectEmbeddedScriptDates(local, contentId);
        collectTextDates(local, video);
      }

      // Local-first: do not wait on external fetch when the page already has the date.
      var bestLocal = pickBest(local, contentId);
      if (bestLocal && applyBest(bestLocal, contentId)) {
        return;
      }

      // Facebook: page-context reel fetch (logged-in HTML) for SPA clips past preload.
      var pageHit = await fetchPageReelDate(contentId);
      if (state.pendingKey !== key) return;
      if (!stillSameClip()) {
        debugMiss("stale_abort_after_page_fetch");
        return;
      }
      if (pageHit && pageHit.label) {
        rememberDateForId(contentId, pageHit.raw || pageHit.label);
        var pageBest = {
          ms: pageHit.ms,
          label: pageHit.label,
          raw: pageHit.raw || pageHit.label,
          absolute: true,
          originalHint: true,
          external: true,
          idLinked: true,
        };
        if (applyBest(pageBest, contentId)) {
          return;
        }
      } else if (contentId) {
        debugMiss("page_fetch_null");
      } else {
        debugMiss("no_content_id");
      }

      var externalUrls = collectExternalCandidates(video);
      var external = await fetchExternalDates(externalUrls, contentId);
      if (state.pendingKey !== key) return;
      if (!stillSameClip()) {
        debugMiss("stale_abort_after_external_fetch");
        return;
      }

      var identNow = clipIdentity(video);
      var contentIdNow = identNow.contentId || contentId;
      // Re-check map in case network tap filled it during the fetch.
      var mappedNow = dateFromMap(contentIdNow);
      if (mappedNow) {
        local.push({
          ms: mappedNow.ms,
          label: mappedNow.label,
          raw: mappedNow.raw,
          absolute: true,
          originalHint: true,
          idLinked: true,
        });
      }
      var best = pickBest(local.concat(external), contentIdNow);

      if (!best || !best.label) {
        debugMiss("no_date_after_all_sources");
        var retryKey = identNow.key || key;
        var retries = state.retryById[retryKey] || 0;
        if (retries < 10) {
          state.retryById[retryKey] = retries + 1;
          scheduleRetry(600 + retries * 250);
        }
        return;
      }

      applyBest(best, contentIdNow);
    } finally {
      if (state.pendingKey === key) state.pendingKey = null;
      if (contentId) delete state.pendingContentIds[contentId];
    }
  }

  function waitForContentIdChange(prevId, cb) {
    // Kept for compatibility; age-skip no longer depends on this path.
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      var id = contentIdFromLocation();
      var video = activeVideo();
      var srcChanged = false;
      if (video) {
        try {
          var src = video.currentSrc || video.src || "";
          if (src && state._waitPrevSrc && src !== state._waitPrevSrc) srcChanged = true;
        } catch (_) {}
      }
      if ((prevId && id && id !== prevId) || srcChanged || tries >= 40) {
        clearInterval(timer);
        if (typeof cb === "function") cb();
      }
    }, 250);
    try {
      var v0 = activeVideo();
      state._waitPrevSrc = v0 ? (v0.currentSrc || v0.src || "") : "";
    } catch (_) {
      state._waitPrevSrc = "";
    }
  }

  function noteDuration(video) {
    var dur = 0;
    try {
      if (video && isFinite(video.duration) && video.duration > 0) {
        dur = Math.round(video.duration);
      }
    } catch (_) {}
    if (dur > 0 && dur !== state.lastSeenDur) {
      state.lastSeenDur = dur;
      var ident = clipIdentity(video);
      var soft = softFingerprint(ident.contentId, video);
      // Duration became known for a clip we already announced — mark new key, no retost.
      if (soft && state.handledIds[soft]) {
        state.handledIds[ident.key] = true;
        return false;
      }
      state.playGen = (state.playGen || 0) + 1;
      state.pendingKey = null;
      return true;
    }
    return false;
  }

  function onPlay(ev) {
    var video = ev && ev.target;
    if (!video || video.tagName !== "VIDEO") return;
    var recentAdSkip =
      (state.adSkipUntil && Date.now() < state.adSkipUntil) ||
      (window.__volGestureAdSkipAt && Date.now() - window.__volGestureAdSkipAt < 8000);
    if (noteDuration(video)) {
      state.hadProgress = false;
    }
    // Restart after real progress (new reel / post-ad content) → new playGen.
    if (video.currentTime < 1 && state.hadProgress) {
      state.playGen = (state.playGen || 0) + 1;
      state.hadProgress = false;
      state.pendingKey = null;
    } else if (recentAdSkip && video.currentTime < 1) {
      state.playGen = (state.playGen || 0) + 1;
      state.pendingKey = null;
    }
    // Fresh play of a clip: if reel id changed, force a new evaluation.
    if (video.currentTime < 2) {
      var id = resolveContentId(video);
      if (id && id !== state.lastSeenContentId) {
        noteActiveContentId(id);
        state.playGen = (state.playGen || 0) + 1;
      }
    }
    void handlePlay(video);
  }

  var scanTimer = null;
  var retryTimer = null;
  function scheduleScan(delay) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(function () {
      if (!alive()) return;
      var video = activeVideo();
      if (video && !video.paused) void handlePlay(video);
    }, delay || 300);
  }

  // Independent of scheduleScan so MutationObserver/poll cannot cancel retries.
  function scheduleRetry(delay) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(function () {
      if (!alive()) return;
      var video = activeVideo();
      if (video && !video.paused) void handlePlay(video);
    }, delay || 600);
  }

  function scheduleScanSeries(delays) {
    (delays || []).forEach(function (delay) {
      setTimeout(function () {
        if (!alive()) return;
        var video = activeVideo();
        if (video && !video.paused) void handlePlay(video);
      }, delay);
    });
  }

  function onLocationMaybeChanged() {
    if (location.href === state.lastUrl) return;
    state.lastUrl = location.href;
    var id = contentIdFromLocation();
    if (id) {
      noteActiveContentId(id);
      if (id !== state.coolId) {
        state.coolId = "";
        state.coolUntil = 0;
      }
    }
    state.playGen = (state.playGen || 0) + 1;
    state.hadProgress = false;
    state.pendingKey = null;
    prefetchNearbyReelDates(true);
    scheduleScanSeries([200, 800, 1600]);
  }

  function pollActiveClip() {
    if (!alive()) return;
    onLocationMaybeChanged();
    if (Date.now() - (state.lastHarvestAt || 0) > 3000) {
      harvestFromDomScripts();
    }
    prefetchNearbyReelDates();
    var id = resolveContentId(activeVideo());
    if (id && id !== state.lastSeenContentId) {
      noteActiveContentId(id);
      if (id !== state.coolId) {
        state.coolId = "";
        state.coolUntil = 0;
      }
      state.playGen = (state.playGen || 0) + 1;
      state.hadProgress = false;
      state.lastSeenDur = -1;
      prefetchNearbyReelDates(true);
      scheduleScan(100);
      return;
    }
    var video = activeVideo();
    if (!video || video.paused) return;
    try {
      if (video.currentTime > 2) state.hadProgress = true;
    } catch (_) {}
    if (noteDuration(video)) {
      state.hadProgress = false;
      scheduleScan(150);
      return;
    }
    var src = "";
    try { src = video.currentSrc || video.src || ""; } catch (_) {}
    if (src && src !== state.lastSeenSrc) {
      state.lastSeenSrc = src;
      state.playGen = (state.playGen || 0) + 1;
      state.hadProgress = false;
      state.lastSeenDur = -1;
      scheduleScan(150);
      return;
    }
    var ident = clipIdentity(video);
    if (!state.handledIds[ident.key] && Date.now() >= state.coolUntil) {
      scheduleScan(300);
    }
  }

  document.addEventListener("play", onPlay, true);
  document.addEventListener("playing", onPlay, true);
  document.addEventListener("loadedmetadata", onPlay, true);

  window.addEventListener("message", function (ev) {
    if (state.dead) return;
    var data = ev && ev.data;
    if (!data || data.source !== "__volGestureReleaseDate") return;
    if (data.type === "reelIds") {
      queuePrefetchIds(data.ids || [], "net-ids");
      return;
    }
    if (data.type !== "dates") return;
    var entries = data.entries;
    if (!entries || !entries.length) return;
    for (var i = 0; i < entries.length; i++) {
      var pair = entries[i];
      if (!pair || pair.length < 2) continue;
      rememberDateForId(String(pair[0]), String(pair[1]));
    }
    var video = activeVideo();
    var cur = resolveContentId(video);
    if (cur && state.dateByContentId[cur]) {
      var soft = softFingerprint(cur, video);
      if (!soft || !state.handledIds[soft]) scheduleScan(100);
    }
  });

  setInterval(function () {
    if (state.dead) return;
    pollActiveClip();
  }, 600);

  try {
    var mo = new MutationObserver(function () {
      if (state.dead) return;
      onLocationMaybeChanged();
      if (Date.now() - (state.lastHarvestAt || 0) > 1500) {
        harvestFromDomScripts();
      }
      scheduleScan(400);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}

  harvestFromDomScripts();
  removePrefetchDebugOverlay();
  prefetchNearbyReelDates();
  scheduleScan(400);
  scheduleScan(1200);

  window.__volGestureResetReleaseDateGates = resetGates;
  window.__volGestureReleaseDate = {
    version: 23,
    updateConfig: updateConfig,
    resetGates: resetGates,
    kill: function () {
      state.dead = true;
      removePrefetchDebugOverlay();
      dismissReleaseToasts();
      try {
        if (window.__volGestureResetReleaseDateGates === resetGates) {
          window.__volGestureResetReleaseDateGates = null;
        }
      } catch (_) {}
    },
  };
}

// Forward settings changes to native host
chrome.storage.onChanged.addListener((changes) => {
  if (changes.gestureWindowMs && port) {
    port.postMessage({
      type: "config",
      gestureWindowMs: changes.gestureWindowMs.newValue,
    });
  }
  if (changes.autoSkipByTypeEnabled || changes.autoClickSkipAdsEnabled || changes.autoSkipKeywords ||
      changes.feedScrollPercent || changes.enabled || changes.showVideoReleaseDate ||
      changes.autoSkipMaxAge) {
    void updateAutoSkipMonitorsForGestureContext();
  }
});

chrome.tabs.onActivated.addListener(() => {
  void updateNativeSimulateMediaKeys();
  void updateAutoSkipMonitorsForGestureContext();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) void updateNativeSimulateMediaKeys();
  if (changeInfo.url || changeInfo.status === "complete") {
    void updateAutoSkipMonitorForTab(tabId);
    void updateReleaseDateMonitorForTab(tabId);
  }
});
chrome.windows.onFocusChanged.addListener((winId) => {
  if (winId !== chrome.windows.WINDOW_ID_NONE) {
    void updateNativeSimulateMediaKeys();
    void updateAutoSkipMonitorsForGestureContext();
  }
});

// Keep-alive: reconnect native host if needed
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    if (!port) {
      connectNativeHost();
    }
  }
});

// Start connection on extension load
connectNativeHost();
void updateAutoSkipMonitorsForGestureContext();
