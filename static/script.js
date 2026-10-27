/* ==========================================================================
   Freshcheck – frontend for the FastAPI fruit classifier
   Talks to:
     POST /predict      multipart/form-data, field "file"  ->  { label, confidence }
     GET  /openapi.json (FastAPI default) used as a health check
   ========================================================================== */

(() => {
  "use strict";

  /* ---------- Config ----------
     Leave API_BASE empty when FastAPI serves this page (same origin).
     If you host the frontend somewhere else (GitHub Pages, Netlify...), set
     window.FRESHCHECK_API_BASE = "https://your-api.example.com" in a <script>
     before this file loads, and enable CORS on the backend. */
  const API_BASE = String(window.FRESHCHECK_API_BASE || "").replace(/\/+$/, "");

  const MAX_BYTES = 10 * 1024 * 1024;
  const REQUEST_TIMEOUT_MS = 60000;
  const STATUS_TIMEOUT_MS = 8000;
  const MODEL_INPUT = 224;
  const CUTOFF = 0.5;
  const CLOSE_CALL_MARGIN = 0.1;
  const HISTORY_LIMIT = 8;
  const HISTORY_KEY = "freshcheck:history";
  const THEME_KEY = "freshcheck:theme";

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");

  const $ = (id) => document.getElementById(id);

  const el = {
    header: document.querySelector(".site-header"),
    apiStatus: $("api-status"),
    apiStatusText: $("api-status-text"),
    themeToggle: $("theme-toggle"),
    dropzone: $("dropzone"),
    fileInput: $("file-input"),
    preview: $("preview"),
    previewImg: $("preview-img"),
    previewCaption: $("preview-caption"),
    sticker: $("sticker"),
    stickerWord: $("sticker-word"),
    stickerSub: $("sticker-sub"),
    clearBtn: $("clear-btn"),
    stageActions: $("stage-actions"),
    modelViewBtn: $("model-view-btn"),
    replaceBtn: $("replace-btn"),
    recheckBtn: $("recheck-btn"),
    result: $("result"),
    cancelBtn: $("cancel-btn"),
    verdictTitle: $("verdict-title"),
    confValue: $("conf-value"),
    spectrum: $("spectrum"),
    spectrumMarker: $("spectrum-marker"),
    verdictNote: $("verdict-note"),
    factScore: $("fact-score"),
    factTime: $("fact-time"),
    factFile: $("fact-file"),
    copyResponseBtn: $("copy-response-btn"),
    errorTitle: $("error-title"),
    errorMessage: $("error-message"),
    retryBtn: $("retry-btn"),
    errorReplaceBtn: $("error-replace-btn"),
    history: $("history"),
    historyList: $("history-list"),
    clearHistoryBtn: $("clear-history-btn"),
    curlExample: $("curl-example"),
    copyCurlBtn: $("copy-curl-btn"),
    docsLink: $("docs-link"),
    toastRegion: $("toast-region"),
  };

  const state = {
    file: null,
    objectUrl: null,
    modelViewUrl: null,
    modelView: false,
    dims: null,
    controller: null,
    requestId: 0,
    lastResponse: null,
    countFrame: 0,
  };

  /* ---------- Small helpers ---------- */
  const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatMs(ms) {
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
  }

  function apiUrl(path) {
    return `${API_BASE}${path}`;
  }

  function apiOrigin() {
    if (API_BASE) return API_BASE;
    return /^https?:$/.test(window.location.protocol) ? window.location.origin : "http://localhost:8000";
  }

  const storage = {
    get(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) {
        return false;
      }
    },
    remove(key) {
      try {
        window.localStorage.removeItem(key);
      } catch (e) {
        /* storage unavailable: nothing to remove */
      }
    },
  };

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (err) {
        ok = false;
      }
      area.remove();
      return ok;
    }
  }

  function toast(message, type = "info", duration = 4200) {
    const node = document.createElement("div");
    node.className = "toast";
    node.dataset.type = type;
    node.textContent = message;
    el.toastRegion.appendChild(node);

    while (el.toastRegion.children.length > 3) {
      el.toastRegion.firstElementChild.remove();
    }

    window.setTimeout(() => {
      node.classList.add("is-leaving");
      node.addEventListener("animationend", () => node.remove(), { once: true });
      window.setTimeout(() => node.remove(), 400);
    }, duration);
  }

  /* ---------- Theme ---------- */
  function currentTheme() {
    const forced = document.documentElement.dataset.theme;
    if (forced === "light" || forced === "dark") return forced;
    return darkScheme.matches ? "dark" : "light";
  }

  function syncThemeButton() {
    const dark = currentTheme() === "dark";
    el.themeToggle.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
    el.themeToggle.title = dark ? "Light theme" : "Dark theme";
  }

  function toggleTheme() {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    // Stored as a plain string because the inline script in <head> reads it before paint
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch (e) {
      /* storage blocked: theme lasts for this visit only */
    }
    syncThemeButton();
  }

  /* ---------- API status ---------- */
  function setStatus(stateName, text) {
    el.apiStatus.dataset.state = stateName;
    el.apiStatusText.textContent = text;
    el.apiStatus.setAttribute("aria-label", `${text}. Check the connection again`);
  }

  async function checkApi() {
    setStatus("checking", "Checking API");
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
    try {
      const res = await fetch(apiUrl("/openapi.json"), { cache: "no-store", signal: controller.signal });
      if (res.status === 404) {
        // Docs can be disabled in production; the server still answered.
        setStatus("online", "API reachable");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const spec = await res.json();
      if (spec && spec.paths && spec.paths["/predict"]) {
        setStatus("online", "API online");
      } else {
        setStatus("warn", "No /predict route");
      }
    } catch (e) {
      setStatus("offline", "API offline");
    } finally {
      window.clearTimeout(timer);
    }
  }

  /* ---------- Result panel states ---------- */
  function setResultState(name) {
    el.result.dataset.state = name;
    el.result.setAttribute("aria-busy", name === "loading" ? "true" : "false");
    const busy = name === "loading";
    el.recheckBtn.disabled = busy;
  }

  function showError(title, message) {
    el.errorTitle.textContent = title;
    el.errorMessage.textContent = message;
    delete el.result.dataset.verdict;
    setResultState("error");
  }

  /* ---------- File intake ---------- */
  function openPicker() {
    el.fileInput.value = "";
    el.fileInput.click();
  }

  function releaseUrls() {
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = null;
    state.modelViewUrl = null;
  }

  function validate(file) {
    if (!file) return "No file was received. Choose a photo and try again.";
    const looksLikeImage = (file.type && file.type.startsWith("image/")) || /\.(jpe?g|png|webp|bmp|gif)$/i.test(file.name || "");
    if (!looksLikeImage) return `“${file.name || "That file"}” isn't an image. Choose a JPG, PNG or WebP photo.`;
    if (file.size === 0) return "That file is empty. Choose another photo.";
    if (file.size > MAX_BYTES) return `That image is ${formatBytes(file.size)}. Choose one under 10 MB.`;
    return null;
  }

  function handleFile(file) {
    const problem = validate(file);
    if (problem) {
      toast(problem, "error");
      return;
    }

    cancelRequest();
    releaseUrls();
    resetSticker();

    state.file = file;
    state.dims = null;
    state.objectUrl = URL.createObjectURL(file);
    setModelView(false, { silent: true });

    el.previewImg.alt = `Your photo: ${file.name || "pasted image"}`;
    el.previewImg.src = state.objectUrl;
    updateCaption();

    el.dropzone.hidden = true;
    el.preview.hidden = false;
    el.stageActions.hidden = false;

    predict();
  }

  el.previewImg.addEventListener("load", () => {
    if (!state.modelView && el.previewImg.naturalWidth) {
      state.dims = { w: el.previewImg.naturalWidth, h: el.previewImg.naturalHeight };
      updateCaption();
    }
  });

  el.previewImg.addEventListener("error", () => {
    if (state.file && !state.modelView) {
      el.previewCaption.textContent = `${state.file.name || "Image"}: your browser can't preview this format, but the server may still read it.`;
    }
  });

  function updateCaption() {
    if (!state.file) return;
    if (state.modelView) {
      el.previewCaption.textContent = `Model's view: ${MODEL_INPUT} × ${MODEL_INPUT} pixels, stretched to a square just like the server does before scoring.`;
      return;
    }
    const parts = [state.file.name || "Pasted image", formatBytes(state.file.size)];
    if (state.dims) parts.push(`${state.dims.w} × ${state.dims.h} px`);
    el.previewCaption.textContent = parts.join(", ");
  }

  function clearPhoto() {
    cancelRequest();
    releaseUrls();
    resetSticker();
    state.file = null;
    state.dims = null;
    state.lastResponse = null;
    setModelView(false, { silent: true });
    el.previewImg.removeAttribute("src");
    el.preview.hidden = true;
    el.stageActions.hidden = true;
    el.dropzone.hidden = false;
    delete el.result.dataset.verdict;
    delete el.preview.dataset.verdict;
    setResultState("idle");
    el.dropzone.focus({ preventScroll: true });
  }

  /* ---------- Model's view (224 x 224, stretched, like PIL resize) ---------- */
  function buildModelView() {
    const img = el.previewImg;
    if (!img.naturalWidth) return null;
    const canvas = document.createElement("canvas");
    canvas.width = MODEL_INPUT;
    canvas.height = MODEL_INPUT;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "medium";
    ctx.drawImage(img, 0, 0, MODEL_INPUT, MODEL_INPUT);
    try {
      return canvas.toDataURL("image/png");
    } catch (e) {
      return null;
    }
  }

  function setModelView(on, { silent = false } = {}) {
    if (on && !state.file) return;

    if (on) {
      if (!state.modelViewUrl) state.modelViewUrl = buildModelView();
      if (!state.modelViewUrl) {
        if (!silent) toast("The preview hasn't finished loading yet. Try again in a moment.", "error");
        return;
      }
      state.modelView = true;
      el.previewImg.src = state.modelViewUrl;
    } else {
      const wasOn = state.modelView;
      state.modelView = false;
      if (wasOn && state.objectUrl) el.previewImg.src = state.objectUrl;
    }

    el.preview.classList.toggle("is-model-view", state.modelView);
    el.modelViewBtn.setAttribute("aria-pressed", String(state.modelView));
    updateCaption();
  }

  /* ---------- Prediction ---------- */
  function cancelRequest() {
    state.requestId += 1;
    if (state.controller) {
      state.controller.abort();
      state.controller = null;
    }
    el.preview.dataset.state = "";
  }

  function readDetail(body) {
    if (!body || body.detail === undefined) return "";
    if (typeof body.detail === "string") return body.detail;
    if (Array.isArray(body.detail)) {
      return body.detail.map((d) => (d && d.msg) || "").filter(Boolean).join("; ");
    }
    return "";
  }

  function describeHttpError(status, detail) {
    if (status === 400) {
      return [
        "The server couldn't read that image",
        `It replied “${detail || "Bad request"}”. The file may be corrupted or in a format Pillow can't open. Try saving it as a JPG or PNG.`,
      ];
    }
    if (status === 404 || status === 405) {
      return [
        "The /predict endpoint wasn't found",
        `The server at ${apiOrigin()} answered, but not with the classifier route. Check that this page is served by your FastAPI app or that API_BASE points to it.`,
      ];
    }
    if (status === 413) {
      return ["That image is too large for the server", "Choose a smaller photo or raise the upload limit on your host."];
    }
    if (status === 422) {
      return [
        "The request was rejected",
        `FastAPI expected the image in a form field named “file”.${detail ? ` Details: ${detail}.` : ""}`,
      ];
    }
    if (status >= 500) {
      return [
        "The server hit an error while scoring",
        `It answered with status ${status}. Check the server logs; a common cause is the model file failing to load at startup.`,
      ];
    }
    return ["That check didn't finish", `The server answered with status ${status}${detail ? `: ${detail}` : ""}.`];
  }

  /**
   * The backend returns the rotten probability as "confidence" for both labels
   * in the original code. If you fix it to return 1 - p for "Fresh", this still
   * works: a Fresh confidence above 0.5 is read as the fresh probability.
   */
  function interpret(body) {
    const label = String(body.label).trim().toLowerCase() === "rotten" ? "rotten" : "fresh";
    const raw = clamp01(body.confidence);
    let rotten;
    if (label === "rotten") {
      rotten = raw;
    } else {
      rotten = raw <= CUTOFF ? raw : 1 - raw;
    }
    const confidence = label === "rotten" ? rotten : 1 - rotten;
    return { label, rotten, confidence };
  }

  async function predict() {
    if (!state.file) return;

    cancelRequest();
    const id = state.requestId;
    const controller = new AbortController();
    state.controller = controller;

    let timedOut = false;
    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    resetSticker();
    el.preview.dataset.state = "scanning";
    setResultState("loading");

    const form = new FormData();
    form.append("file", state.file, state.file.name || "upload.png");

    const started = performance.now();

    try {
      const res = await fetch(apiUrl("/predict"), {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      const text = await res.text();
      const elapsed = performance.now() - started;
      if (id !== state.requestId) return;

      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch (e) {
        body = null;
      }

      if (!res.ok) {
        const [title, message] = describeHttpError(res.status, readDetail(body));
        showError(title, message);
        return;
      }

      if (!body || typeof body.label !== "string" || typeof body.confidence !== "number") {
        showError("The server sent an unexpected answer", "Expected JSON with “label” and “confidence”. Check that /predict returns the PredictionResult model.");
        return;
      }

      setStatus("online", "API online");
      showResult(body, elapsed);
    } catch (err) {
      if (id !== state.requestId) return;
      if (err && err.name === "AbortError") {
        if (timedOut) {
          showError(
            "The server took too long",
            `No answer after ${REQUEST_TIMEOUT_MS / 1000} seconds. The model may still be loading, or the host may be asleep. Try again in a moment.`,
          );
        }
        return;
      }
      setStatus("offline", "API offline");
      showError(
        "Couldn't reach the API",
        `Nothing answered at ${apiOrigin()}. Make sure the FastAPI server is running (uvicorn main:app), then try again.`,
      );
    } finally {
      window.clearTimeout(timer);
      if (id === state.requestId) {
        state.controller = null;
        el.preview.dataset.state = "";
      }
    }
  }

  function showResult(body, elapsed) {
    const { label, rotten, confidence } = interpret(body);
    state.lastResponse = body;

    el.result.dataset.verdict = label;
    el.preview.dataset.verdict = label;

    el.verdictTitle.textContent = label === "rotten" ? "Looks rotten" : "Looks fresh";
    setResultState("done");

    animateNumber(el.confValue, confidence * 100);

    // Spectrum: start at the cutoff and glide to the score
    el.spectrumMarker.style.transition = "none";
    el.spectrumMarker.style.setProperty("--pos", "50%");
    void el.spectrumMarker.offsetWidth;
    el.spectrumMarker.style.transition = "";
    window.requestAnimationFrame(() => {
      el.spectrumMarker.style.setProperty("--pos", `${(rotten * 100).toFixed(2)}%`);
    });
    el.spectrum.setAttribute(
      "aria-label",
      `Rotten score ${rotten.toFixed(3)} on a scale from 0, fresh, to 1, rotten. The cutoff is ${CUTOFF}.`,
    );

    const closeCall = Math.abs(rotten - CUTOFF) < CLOSE_CALL_MARGIN;
    el.verdictNote.hidden = !closeCall;
    if (closeCall) {
      el.verdictNote.textContent = "Close call. The score sits near the cutoff, so a sharper, well-lit photo of a single fruit may give a firmer answer.";
    }

    el.factScore.textContent = rotten.toFixed(4);
    el.factTime.textContent = formatMs(elapsed);
    el.factFile.textContent = state.dims ? `${state.dims.w} × ${state.dims.h} px` : formatBytes(state.file.size);
    el.factFile.title = state.file.name || "";

    // Stamp the sticker onto the photo
    el.stickerWord.textContent = label === "rotten" ? "Rotten" : "Fresh";
    el.stickerSub.textContent = `${Math.round(confidence * 100)}% sure`;
    void el.sticker.offsetWidth;
    el.sticker.classList.add("is-stamped");

    addToHistory({ label, confidence, rotten });
  }

  function resetSticker() {
    el.sticker.classList.remove("is-stamped");
    delete el.preview.dataset.verdict;
  }

  function animateNumber(node, target) {
    window.cancelAnimationFrame(state.countFrame);
    if (reducedMotion.matches) {
      node.textContent = target.toFixed(1);
      return;
    }
    const duration = 900;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      node.textContent = (target * eased).toFixed(1);
      if (t < 1) state.countFrame = window.requestAnimationFrame(step);
    };
    state.countFrame = window.requestAnimationFrame(step);
  }

  /* ---------- History (kept in this browser only) ---------- */
  function makeThumb() {
    const img = el.previewImg;
    if (!img.naturalWidth) return "";
    const size = 112;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const scale = Math.max(size / img.naturalWidth, size / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    try {
      return canvas.toDataURL("image/jpeg", 0.72);
    } catch (e) {
      return "";
    }
  }

  function loadHistory() {
    const items = storage.get(HISTORY_KEY, []);
    return Array.isArray(items) ? items : [];
  }

  function addToHistory({ label, confidence, rotten }) {
    const entry = {
      label,
      confidence,
      rotten,
      name: (state.file && state.file.name) || "Pasted image",
      at: Date.now(),
      thumb: makeThumb(),
    };
    const items = [entry, ...loadHistory()].slice(0, HISTORY_LIMIT);
    if (!storage.set(HISTORY_KEY, items)) {
      // Storage full or blocked: keep the list for this visit without thumbnails
      storage.set(HISTORY_KEY, items.map((i) => ({ ...i, thumb: "" })));
    }
    renderHistory(items);
  }

  const relativeTime = (() => {
    const rtf = typeof Intl !== "undefined" && Intl.RelativeTimeFormat ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }) : null;
    return (ts) => {
      const diff = (ts - Date.now()) / 1000;
      const abs = Math.abs(diff);
      if (!rtf) return new Date(ts).toLocaleString();
      if (abs < 45) return "just now";
      if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
      if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
      return rtf.format(Math.round(diff / 86400), "day");
    };
  })();

  function renderHistory(items = loadHistory()) {
    el.historyList.textContent = "";
    el.history.hidden = items.length === 0;

    for (const item of items) {
      const li = document.createElement("li");
      li.className = "history-item";
      li.dataset.verdict = item.label === "rotten" ? "rotten" : "fresh";

      const img = document.createElement("img");
      img.className = "history-thumb";
      img.alt = "";
      img.loading = "lazy";
      if (item.thumb) img.src = item.thumb;

      const meta = document.createElement("div");
      meta.className = "history-meta";

      const label = document.createElement("span");
      label.className = "history-label";
      label.textContent = `${item.label === "rotten" ? "Rotten" : "Fresh"}, ${(clamp01(item.confidence) * 100).toFixed(1)}%`;

      const sub = document.createElement("span");
      sub.className = "history-sub";
      sub.textContent = `${item.name}, ${relativeTime(item.at)}`;
      sub.title = item.name;

      meta.append(label, sub);
      li.append(img, meta);
      el.historyList.appendChild(li);
    }
  }

  /* ---------- Drag, drop and paste ---------- */
  let dragDepth = 0;

  function hasFiles(event) {
    const types = event.dataTransfer && event.dataTransfer.types;
    return !!types && Array.from(types).includes("Files");
  }

  window.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    document.body.classList.add("is-dragging");
  });

  window.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });

  window.addEventListener("dragleave", (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove("is-dragging");
  });

  window.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    document.body.classList.remove("is-dragging");
    el.dropzone.classList.remove("is-over");
    const files = event.dataTransfer.files;
    if (files.length > 1) toast("Only the first photo was used. Check one fruit at a time.");
    handleFile(files[0]);
  });

  el.dropzone.addEventListener("dragenter", () => el.dropzone.classList.add("is-over"));
  el.dropzone.addEventListener("dragleave", (event) => {
    if (!el.dropzone.contains(event.relatedTarget)) el.dropzone.classList.remove("is-over");
  });

  document.addEventListener("paste", (event) => {
    const target = event.target;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    const data = event.clipboardData;
    if (!data) return;
    let file = data.files && data.files[0];
    if (!file && data.items) {
      for (const item of data.items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          file = item.getAsFile();
          break;
        }
      }
    }
    if (file) {
      event.preventDefault();
      handleFile(file);
      toast("Pasted image added.");
    }
  });

  /* ---------- Wiring ---------- */
  el.fileInput.addEventListener("change", () => {
    const file = el.fileInput.files && el.fileInput.files[0];
    if (file) handleFile(file);
  });

  el.dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openPicker();
    }
  });

  el.clearBtn.addEventListener("click", clearPhoto);
  el.replaceBtn.addEventListener("click", openPicker);
  el.errorReplaceBtn.addEventListener("click", openPicker);
  el.recheckBtn.addEventListener("click", predict);
  el.retryBtn.addEventListener("click", () => {
    if (state.file) predict();
    else openPicker();
  });

  el.cancelBtn.addEventListener("click", () => {
    cancelRequest();
    showError("Check cancelled", "Nothing was scored. Run it again whenever you're ready.");
  });

  el.modelViewBtn.addEventListener("click", () => setModelView(!state.modelView));

  el.copyResponseBtn.addEventListener("click", async () => {
    if (!state.lastResponse) return;
    const ok = await copyText(JSON.stringify(state.lastResponse, null, 2));
    toast(ok ? "Response copied." : "Couldn't copy. Your browser blocked clipboard access.", ok ? "info" : "error");
  });

  el.copyCurlBtn.addEventListener("click", async () => {
    const ok = await copyText(el.curlExample.textContent);
    el.copyCurlBtn.textContent = ok ? "Copied" : "Failed";
    window.setTimeout(() => {
      el.copyCurlBtn.textContent = "Copy";
    }, 1600);
  });

  el.clearHistoryBtn.addEventListener("click", () => {
    storage.remove(HISTORY_KEY);
    renderHistory([]);
    toast("History cleared.");
  });

  el.apiStatus.addEventListener("click", checkApi);
  el.themeToggle.addEventListener("click", toggleTheme);
  darkScheme.addEventListener("change", syncThemeButton);

  window.addEventListener("online", checkApi);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && el.apiStatus.dataset.state !== "online") checkApi();
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && el.result.dataset.state === "loading") {
      el.cancelBtn.click();
    }
  });

  const onScroll = () => el.header.classList.toggle("is-scrolled", window.scrollY > 8);
  window.addEventListener("scroll", onScroll, { passive: true });

  /* ---------- Init ---------- */
  el.curlExample.textContent = `curl -X POST ${apiOrigin()}/predict \\\n  -F "file=@apple.jpg"`;
  el.docsLink.href = apiUrl("/docs");
  syncThemeButton();
  renderHistory();
  onScroll();
  checkApi();
})();
