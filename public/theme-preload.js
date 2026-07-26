/*
 * Applies the synchronous Interface cache before React and the stylesheet
 * bundle load. SQLite remains the durable mirror; ThemeBootstrap hydrates it
 * after mount when the local cache is missing.
 */
(function preloadShuguTheme() {
  var root = document.documentElement;
  var source = document.currentScript;
  var windowKind = source && source.dataset ? source.dataset.window : "main";
  var defaults = {
    fontScale: 100,
    uiDensity: "comfortable",
    animations: true,
    reducedMotion: false,
    glassEnabled: true,
    monoFont: "JetBrains Mono",
  };
  var monoStacks = {
    "JetBrains Mono": "'JetBrains Mono', ui-monospace, monospace",
    "Fira Code": "'Fira Code', ui-monospace, monospace",
    "IBM Plex Mono": "'IBM Plex Mono', ui-monospace, monospace",
    "Cascadia Code": "'Cascadia Code', ui-monospace, monospace",
    "SF Mono": "'SF Mono', ui-monospace, monospace",
    "ui-monospace": "ui-monospace, monospace",
  };
  var saved = {};

  try {
    var raw = localStorage.getItem("shugu.interface.v1");
    if (raw) saved = JSON.parse(raw);
  } catch (_) {
    saved = {};
  }

  var settings = Object.assign({}, defaults, saved);
  var scale = Number(settings.fontScale);
  root.style.setProperty(
    "--ui-font-scale",
    Number.isFinite(scale) ? String(scale / 100) : "1",
  );
  root.style.setProperty(
    "--ui-density",
    settings.uiDensity || defaults.uiDensity,
  );
  root.style.setProperty(
    "--ui-glass",
    settings.glassEnabled === false ? "0" : "1",
  );
  root.style.setProperty(
    "--font-mono",
    monoStacks[settings.monoFont] || monoStacks["ui-monospace"],
  );
  if (settings.glassEnabled === false)
    root.style.setProperty("--lg-blur", "0px");

  root.dataset.density = settings.uiDensity || defaults.uiDensity;
  root.dataset.animations = settings.animations === false ? "off" : "on";
  root.dataset.reducedmotion = settings.reducedMotion === true ? "on" : "off";
  root.dataset.glass = settings.glassEnabled === false ? "off" : "on";
  root.style.colorScheme = "dark";

  // The mascot webview must remain OS-transparent.
  if (windowKind === "main") root.style.backgroundColor = "#050510";
})();
