document.addEventListener("DOMContentLoaded", () => {
  const DEFAULT_AUTO_SKIP_KEYWORDS = "sponsored, paid partnership, #ad, ad, gaming";

  const verEl = document.getElementById("version");
  if (verEl) {
    const v = chrome.runtime.getManifest().version;
    verEl.textContent = `v${v}`;
  }

  const enabledEl = document.getElementById("enabled");
  const windowEl = document.getElementById("window");
  const windowValueEl = document.getElementById("windowValue");
  const scrollPctEl = document.getElementById("scrollPct");
  const scrollPctValueEl = document.getElementById("scrollPctValue");
  const autoSkipByTypeEl = document.getElementById("autoSkipByType");
  const autoClickSkipAdsEl = document.getElementById("autoClickSkipAds");
  const showGestureVideoInfoEl = document.getElementById("showGestureVideoInfo");
  const showVideoReleaseDateEl = document.getElementById("showVideoReleaseDate");
  const autoSkipMaxAgeEl = document.getElementById("autoSkipMaxAge");
  const autoSkipKeywordsEl = document.getElementById("autoSkipKeywords");
  const statusEl = document.getElementById("status");

  chrome.storage.sync.get(
    {
      enabled: true,
      gestureWindowMs: 1000,
      feedScrollPercent: 80,
      autoSkipByTypeEnabled: false,
      autoSkipKeywords: DEFAULT_AUTO_SKIP_KEYWORDS,
      autoClickSkipAdsEnabled: false,
      showGestureVideoInfo: false,
      showVideoReleaseDate: true,
      autoSkipMaxAge: "",
    },
    (items) => {
      enabledEl.checked = items.enabled;
      let gwm = items.gestureWindowMs;
      if (gwm < 1000) gwm = 1000;
      if (gwm > 4000) gwm = 4000;
      windowEl.value = gwm;
      windowValueEl.textContent = gwm;
      let pct = items.feedScrollPercent;
      if (pct < 70) pct = 70;
      if (pct > 100) pct = 100;
      scrollPctEl.value = pct;
      scrollPctValueEl.textContent = pct;
      autoSkipByTypeEl.checked = !!items.autoSkipByTypeEnabled;
      autoClickSkipAdsEl.checked = !!items.autoClickSkipAdsEnabled;
      showGestureVideoInfoEl.checked = !!items.showGestureVideoInfo;
      showVideoReleaseDateEl.checked = items.showVideoReleaseDate !== false;
      const age = items.autoSkipMaxAge || "";
      autoSkipMaxAgeEl.value =
        (age === "1d" || age === "1w" || age === "1m" || age === "1y") ? age : "";
      autoSkipKeywordsEl.value = items.autoSkipKeywords || DEFAULT_AUTO_SKIP_KEYWORDS;
    }
  );

  function save() {
    const settings = {
      enabled: enabledEl.checked,
      gestureWindowMs: parseInt(windowEl.value, 10),
      feedScrollPercent: parseInt(scrollPctEl.value, 10),
      autoSkipByTypeEnabled: autoSkipByTypeEl.checked,
      autoSkipKeywords: autoSkipKeywordsEl.value.trim() || DEFAULT_AUTO_SKIP_KEYWORDS,
      autoClickSkipAdsEnabled: autoClickSkipAdsEl.checked,
      showGestureVideoInfo: showGestureVideoInfoEl.checked,
      showVideoReleaseDate: showVideoReleaseDateEl.checked,
      autoSkipMaxAge: autoSkipMaxAgeEl.value || "",
    };
    chrome.storage.sync.set(settings, () => {
      statusEl.textContent = "Settings saved";
      statusEl.style.opacity = "1";
      setTimeout(() => {
        statusEl.style.opacity = "0";
      }, 1500);
    });
  }

  enabledEl.addEventListener("change", save);

  windowEl.addEventListener("input", () => {
    windowValueEl.textContent = windowEl.value;
  });
  windowEl.addEventListener("change", save);

  scrollPctEl.addEventListener("input", () => {
    scrollPctValueEl.textContent = scrollPctEl.value;
  });
  scrollPctEl.addEventListener("change", save);

  autoSkipByTypeEl.addEventListener("change", save);
  autoClickSkipAdsEl.addEventListener("change", save);
  showGestureVideoInfoEl.addEventListener("change", save);
  showVideoReleaseDateEl.addEventListener("change", save);
  autoSkipMaxAgeEl.addEventListener("change", save);
  autoSkipKeywordsEl.addEventListener("change", save);
});
