const fileInput = document.querySelector("#fileInput");
const dropZone = document.querySelector("#dropZone");
const fileList = document.querySelector("#fileList");
const previewStrip = document.querySelector("#previewStrip");
const renderButton = document.querySelector("#renderButton");
const clearButton = document.querySelector("#clearButton");
const videoCount = document.querySelector("#videoCount");
const message = document.querySelector("#message");
const progressWrap = document.querySelector("#progressWrap");
const progressText = document.querySelector("#progressText");
const progressPercent = document.querySelector("#progressPercent");
const progressBar = document.querySelector("#progressBar");
const resultStage = document.querySelector("#resultStage");
const downloadLink = document.querySelector("#downloadLink");
const heightSelect = document.querySelector("#heightSelect");
const rowsSelect = document.querySelector("#rowsSelect");
const columnsSelect = document.querySelector("#columnsSelect");
const qualitySelect = document.querySelector("#qualitySelect");
const presetSelect = document.querySelector("#presetSelect");
const audioSelect = document.querySelector("#audioSelect");
const rowLayoutButton = document.querySelector("#rowLayoutButton");
const autoLayoutButton = document.querySelector("#autoLayoutButton");
const layoutHint = document.querySelector("#layoutHint");

let videos = [];
let isRendering = false;
let layoutTouched = false;

fileInput.addEventListener("change", (event) => {
  addFiles([...event.target.files]);
  fileInput.value = "";
});

clearButton.addEventListener("click", () => {
  for (const video of videos) URL.revokeObjectURL(video.url);
  videos = [];
  layoutTouched = false;
  rowsSelect.value = "1";
  columnsSelect.value = "2";
  setMessage("");
  render();
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("is-dragging");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("is-dragging");
});

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("is-dragging");
  addFiles([...event.dataTransfer.files]);
});

renderButton.addEventListener("click", () => {
  renderVideos();
});

for (const select of [rowsSelect, columnsSelect]) {
  select.addEventListener("change", () => {
    layoutTouched = true;
    setMessage("");
    render();
  });
}

rowLayoutButton.addEventListener("click", () => {
  layoutTouched = true;
  rowsSelect.value = "1";
  columnsSelect.value = String(clamp(videos.length || 2, 1, 8));
  setMessage("");
  render();
});

autoLayoutButton.addEventListener("click", () => {
  layoutTouched = true;
  setLayout(autoGrid(videos.length || 2));
  setMessage("");
  render();
});

function addFiles(files) {
  const videoFiles = files.filter((file) => file.type.startsWith("video/") || /\.(mkv|m4v)$/i.test(file.name));

  if (!videoFiles.length) {
    setMessage("Choose video files.", "error");
    return;
  }

  videos = [
    ...videos,
    ...videoFiles.map((file) => ({
      id: crypto.randomUUID(),
      file,
      url: URL.createObjectURL(file)
    }))
  ];

  syncDefaultLayout();
  setMessage("");
  render();
}

function render() {
  syncDefaultLayout();
  const layout = getLayout();
  const hasEnoughCells = layout.capacity >= videos.length;

  videoCount.textContent = `${videos.length} ${videos.length === 1 ? "file" : "files"}`;
  renderButton.disabled = videos.length < 2 || isRendering || !hasEnoughCells;
  clearButton.disabled = videos.length === 0 || isRendering;
  updateLayoutHint(layout, hasEnoughCells);
  renderFileList();
  renderPreview(layout);
}

function renderFileList() {
  fileList.replaceChildren();

  for (const [index, video] of videos.entries()) {
    const card = document.createElement("article");
    card.className = "file-card";

    const thumb = document.createElement("video");
    thumb.src = video.url;
    thumb.muted = true;
    thumb.playsInline = true;
    thumb.preload = "metadata";

    const info = document.createElement("div");
    const name = document.createElement("div");
    name.className = "file-name";
    name.textContent = video.file.name;

    const meta = document.createElement("div");
    meta.className = "file-meta";
    meta.textContent = formatBytes(video.file.size);

    info.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "file-actions";
    actions.append(
      iconButton("↑", "Move earlier", () => moveVideo(index, -1), index === 0),
      iconButton("↓", "Move later", () => moveVideo(index, 1), index === videos.length - 1),
      iconButton("×", "Remove", () => removeVideo(video.id), false, "danger")
    );

    card.append(thumb, info, actions);
    fileList.append(card);
  }
}

function renderPreview(layout) {
  previewStrip.replaceChildren();
  previewStrip.style.setProperty("--preview-columns", String(layout.columns));

  if (!videos.length) {
    const empty = document.createElement("div");
    empty.className = "preview-empty";
    empty.textContent = "No videos loaded";
    previewStrip.append(empty);
    return;
  }

  for (let index = 0; index < layout.capacity; index += 1) {
    const tile = document.createElement("div");
    tile.className = "preview-tile";

    const video = videos[index];
    if (!video) {
      tile.classList.add("is-empty");
      tile.textContent = "Empty";
      previewStrip.append(tile);
      continue;
    }

    const preview = document.createElement("video");
    preview.src = video.url;
    preview.muted = true;
    preview.loop = true;
    preview.playsInline = true;
    preview.autoplay = true;
    preview.preload = "metadata";

    tile.append(preview);
    previewStrip.append(tile);
  }
}

function iconButton(text, title, onClick, disabled = false, extraClass = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon-button ${extraClass}`.trim();
  button.textContent = text;
  button.title = title;
  button.ariaLabel = title;
  button.disabled = disabled || isRendering;
  button.addEventListener("click", onClick);
  return button;
}

function moveVideo(index, delta) {
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= videos.length) return;
  const next = [...videos];
  [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
  videos = next;
  render();
}

function removeVideo(id) {
  const removed = videos.find((video) => video.id === id);
  if (removed) URL.revokeObjectURL(removed.url);
  videos = videos.filter((video) => video.id !== id);
  render();
}

function renderVideos() {
  if (videos.length < 2 || isRendering) return;
  const layout = getLayout();

  if (layout.capacity < videos.length) {
    setMessage(`The ${layout.rows} x ${layout.columns} grid needs more cells.`, "error");
    return;
  }

  isRendering = true;
  render();
  setMessage("Uploading videos.");
  setProgress(0, "Uploading");
  progressWrap.hidden = false;
  downloadLink.hidden = true;

  const formData = new FormData();
  for (const video of videos) {
    formData.append("videos", video.file, video.file.name);
  }
  formData.append("height", heightSelect.value);
  formData.append("rows", String(layout.rows));
  formData.append("columns", String(layout.columns));
  formData.append("quality", qualitySelect.value);
  formData.append("preset", presetSelect.value);
  formData.append("audio", audioSelect.value);

  const request = new XMLHttpRequest();
  request.open("POST", "/api/render");

  request.upload.addEventListener("progress", (event) => {
    if (!event.lengthComputable) return;
    const percent = Math.round((event.loaded / event.total) * 92);
    setProgress(percent, percent >= 92 ? "Rendering" : "Uploading");
  });

  request.addEventListener("load", () => {
    isRendering = false;
    render();

    let payload = {};
    try {
      payload = JSON.parse(request.responseText || "{}");
    } catch {
      payload = {};
    }

    if (request.status >= 200 && request.status < 300 && payload.url) {
      setProgress(100, "Complete");
      showOutput(payload.url, payload.downloadUrl, payload.filename);
      setMessage("Render complete.", "success");
      return;
    }

    progressWrap.hidden = true;
    setMessage(payload.error || "Render failed.", "error");
  });

  request.addEventListener("error", () => {
    isRendering = false;
    render();
    progressWrap.hidden = true;
    setMessage("Upload failed.", "error");
  });

  request.send(formData);
}

function showOutput(url, downloadUrl, filename) {
  const video = document.createElement("video");
  video.src = `${url}?t=${Date.now()}`;
  video.controls = true;
  video.playsInline = true;

  resultStage.replaceChildren(video);
  downloadLink.href = downloadUrl || url;
  downloadLink.download = filename || "side-by-side.mp4";
  downloadLink.hidden = false;
}

function setProgress(percent, text) {
  progressBar.style.width = `${percent}%`;
  progressPercent.textContent = `${percent}%`;
  progressText.textContent = text;
}

function setMessage(text, type = "") {
  message.textContent = text;
  message.className = `message ${type ? `is-${type}` : ""}`.trim();
}

function syncDefaultLayout() {
  if (layoutTouched) return;
  const count = Math.max(2, videos.length);
  rowsSelect.value = "1";
  columnsSelect.value = String(clamp(count, 1, 8));
}

function getLayout() {
  const rows = clamp(Number(rowsSelect.value), 1, 8);
  const columns = clamp(Number(columnsSelect.value), 1, 8);
  return {
    rows,
    columns,
    capacity: rows * columns
  };
}

function setLayout(layout) {
  rowsSelect.value = String(layout.rows);
  columnsSelect.value = String(layout.columns);
}

function autoGrid(count) {
  const columns = clamp(Math.ceil(Math.sqrt(count)), 1, 8);
  const rows = clamp(Math.ceil(count / columns), 1, 8);
  return { rows, columns };
}

function updateLayoutHint(layout, hasEnoughCells) {
  const label = `${layout.rows} x ${layout.columns} grid`;
  const cells = `${layout.capacity} ${layout.capacity === 1 ? "cell" : "cells"}`;
  layoutHint.textContent = videos.length ? `${label}, ${cells}` : "Choose a layout";
  layoutHint.classList.toggle("is-error", Boolean(videos.length && !hasEnoughCells));
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

render();
