const fileInput = document.querySelector("#fileInput");
const dropZone = document.querySelector("#dropZone");
const fileList = document.querySelector("#fileList");
const previewStrip = document.querySelector("#previewStrip");
const renderButton = document.querySelector("#renderButton");
const thumbnailButton = document.querySelector("#thumbnailButton");
const clearButton = document.querySelector("#clearButton");
const videoCount = document.querySelector("#videoCount");
const message = document.querySelector("#message");
const progressWrap = document.querySelector("#progressWrap");
const progressText = document.querySelector("#progressText");
const progressPercent = document.querySelector("#progressPercent");
const progressBar = document.querySelector("#progressBar");
const resultStage = document.querySelector("#resultStage");
const downloadLink = document.querySelector("#downloadLink");
const healthPill = document.querySelector("#healthPill");
const heightSelect = document.querySelector("#heightSelect");
const rowsSelect = document.querySelector("#rowsSelect");
const columnsSelect = document.querySelector("#columnsSelect");
const qualitySelect = document.querySelector("#qualitySelect");
const presetSelect = document.querySelector("#presetSelect");
const audioSelect = document.querySelector("#audioSelect");
const fitSelect = document.querySelector("#fitSelect");
const gapRange = document.querySelector("#gapRange");
const gapValue = document.querySelector("#gapValue");
const rowLayoutButton = document.querySelector("#rowLayoutButton");
const autoLayoutButton = document.querySelector("#autoLayoutButton");
const layoutHint = document.querySelector("#layoutHint");

const MAX_VIDEOS = 120;
const MAX_GRID_SIDE = 120;
const MAX_GRID_CELLS = 120;
const MAX_GAP = 64;
const TARGET_GRID_RATIO = 2 / (9 / 16);

let videos = [];
let isRendering = false;
let layoutTouched = false;

populateNumberSelect(rowsSelect, 1, MAX_GRID_SIDE, 1);
populateNumberSelect(columnsSelect, 1, MAX_GRID_SIDE, 2);

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

thumbnailButton.addEventListener("click", () => {
  renderTwitterThumbnail();
});

for (const select of [rowsSelect, columnsSelect]) {
  select.addEventListener("change", () => {
    layoutTouched = true;
    setMessage("");
    render();
  });
}

gapRange.addEventListener("input", () => {
  updateGapValue();
  render();
});

fitSelect.addEventListener("change", () => {
  render();
});

rowLayoutButton.addEventListener("click", () => {
  layoutTouched = true;
  rowsSelect.value = "1";
  columnsSelect.value = String(clamp(videos.length || 2, 1, MAX_GRID_SIDE));
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

  const availableSlots = Math.max(0, MAX_VIDEOS - videos.length);
  const acceptedFiles = videoFiles.slice(0, availableSlots);

  if (!acceptedFiles.length) {
    setMessage(`This batch is capped at ${MAX_VIDEOS} videos.`, "error");
    return;
  }

  videos = [
    ...videos,
    ...acceptedFiles.map((file) => ({
      id: crypto.randomUUID(),
      file,
      url: URL.createObjectURL(file)
    }))
  ];

  syncDefaultLayout();
  setMessage(
    acceptedFiles.length < videoFiles.length
      ? `Loaded ${acceptedFiles.length} of ${videoFiles.length} videos. Max ${MAX_VIDEOS}.`
      : ""
  );
  render();
}

function render() {
  syncDefaultLayout();
  const layout = getLayout();
  const hasEnoughCells = layout.capacity >= videos.length;
  const hasSupportedCells = layout.capacity <= MAX_GRID_CELLS;
  const canExport = hasEnoughCells && hasSupportedCells;

  videoCount.textContent = `${videos.length} ${videos.length === 1 ? "file" : "files"}`;
  renderButton.disabled = videos.length < 2 || isRendering || !canExport;
  thumbnailButton.disabled = videos.length < 1 || isRendering || !canExport;
  clearButton.disabled = videos.length === 0 || isRendering;
  updateLayoutHint(layout, hasEnoughCells, hasSupportedCells);
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
  previewStrip.style.setProperty("--preview-rows", String(layout.rows));
  previewStrip.style.setProperty("--preview-gap", `${previewGap(getGap())}px`);
  previewStrip.classList.toggle("is-cover-fit", getFit() === "cover");
  previewStrip.classList.toggle("is-dense", layout.capacity > 36);
  previewStrip.classList.toggle("is-very-dense", layout.capacity > 80);

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
      tile.textContent = layout.capacity <= 36 ? "Empty" : "";
      previewStrip.append(tile);
      continue;
    }

    const preview = document.createElement("video");
    preview.src = video.url;
    preview.muted = true;
    preview.playsInline = true;
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

  if (layout.capacity > MAX_GRID_CELLS) {
    setMessage(`Use ${MAX_GRID_CELLS} grid cells or fewer.`, "error");
    return;
  }

  submitJob({
    endpoint: "/api/render",
    formData: buildJobFormData(layout),
    workingLabel: "Rendering",
    completeMessage: "Render complete.",
    failureMessage: "Render failed.",
    showResult: showVideoOutput
  });
}

function renderTwitterThumbnail() {
  if (!videos.length || isRendering) return;
  const layout = getLayout();

  if (layout.capacity < videos.length) {
    setMessage(`The ${layout.rows} x ${layout.columns} grid needs more cells.`, "error");
    return;
  }

  if (layout.capacity > MAX_GRID_CELLS) {
    setMessage(`Use ${MAX_GRID_CELLS} grid cells or fewer.`, "error");
    return;
  }

  submitJob({
    endpoint: "/api/twitter-thumbnail",
    formData: buildJobFormData(layout),
    workingLabel: "Composing",
    completeMessage: "Thumbnail ready.",
    failureMessage: "Thumbnail failed.",
    showResult: showImageOutput
  });
}

function submitJob({ endpoint, formData, workingLabel, completeMessage, failureMessage, showResult }) {
  isRendering = true;
  render();
  setMessage("Uploading videos.");
  setProgress(0, "Uploading");
  progressWrap.hidden = false;
  downloadLink.hidden = true;

  const request = new XMLHttpRequest();
  request.open("POST", endpoint);

  request.upload.addEventListener("progress", (event) => {
    if (!event.lengthComputable) return;
    const percent = Math.round((event.loaded / event.total) * 92);
    setProgress(percent, percent >= 92 ? workingLabel : "Uploading");
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
      showResult(payload.url, payload.downloadUrl, payload.filename);
      setMessage(completeMessage, "success");
      return;
    }

    progressWrap.hidden = true;
    setMessage(payload.error || failureMessage, "error");
  });

  request.addEventListener("error", () => {
    isRendering = false;
    render();
    progressWrap.hidden = true;
    setMessage("Upload failed.", "error");
  });

  request.send(formData);
}

function buildJobFormData(layout) {
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
  formData.append("fit", getFit());
  formData.append("gap", String(getGap()));
  return formData;
}

function showVideoOutput(url, downloadUrl, filename) {
  const video = document.createElement("video");
  video.src = `${url}?t=${Date.now()}`;
  video.controls = true;
  video.playsInline = true;

  resultStage.replaceChildren(video);
  downloadLink.href = downloadUrl || url;
  downloadLink.download = filename || "side-by-side.mp4";
  downloadLink.textContent = "Download MP4";
  downloadLink.hidden = false;
}

function showImageOutput(url, downloadUrl, filename) {
  const image = document.createElement("img");
  image.src = `${url}?t=${Date.now()}`;
  image.alt = "Twitter article thumbnail preview";

  resultStage.replaceChildren(image);
  downloadLink.href = downloadUrl || url;
  downloadLink.download = filename || "twitter-article-thumbnail.png";
  downloadLink.textContent = "Download PNG";
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
  const count = videos.length || 2;
  const layout = getLayout();
  const needsAutoLayout =
    !layoutTouched || (videos.length > 0 && (layout.capacity < videos.length || layout.capacity > MAX_GRID_CELLS));

  if (needsAutoLayout) {
    setLayout(autoGrid(count));
  }
}

function getLayout() {
  const rows = clamp(Number(rowsSelect.value), 1, MAX_GRID_SIDE);
  const columns = clamp(Number(columnsSelect.value), 1, MAX_GRID_SIDE);
  return {
    rows,
    columns,
    capacity: rows * columns
  };
}

function getGap() {
  return clamp(Number(gapRange.value), 0, MAX_GAP);
}

function getFit() {
  return fitSelect.value === "contain" ? "contain" : "cover";
}

function setLayout(layout) {
  rowsSelect.value = String(layout.rows);
  columnsSelect.value = String(layout.columns);
}

function autoGrid(count) {
  const targetCount = clamp(count, 1, MAX_VIDEOS);
  let best = { rows: 1, columns: targetCount, score: Number.POSITIVE_INFINITY };

  for (let rows = 1; rows <= MAX_GRID_SIDE; rows += 1) {
    const minColumns = Math.ceil(targetCount / rows);
    const maxColumns = Math.min(MAX_GRID_SIDE, Math.floor(MAX_GRID_CELLS / rows));

    for (let columns = minColumns; columns <= maxColumns; columns += 1) {
      const capacity = rows * columns;
      if (capacity < targetCount || capacity > MAX_GRID_CELLS) continue;

      const ratioPenalty = Math.abs(Math.log((columns / rows) / TARGET_GRID_RATIO));
      const emptyPenalty = ((capacity - targetCount) / targetCount) * 1.4;
      const score = ratioPenalty + emptyPenalty;

      if (score < best.score) {
        best = { rows, columns, score };
      }
    }
  }

  return { rows: best.rows, columns: best.columns };
}

function updateLayoutHint(layout, hasEnoughCells, hasSupportedCells) {
  const label = `${layout.rows} x ${layout.columns} grid`;
  const cells = `${layout.capacity} ${layout.capacity === 1 ? "cell" : "cells"}`;
  const gap = getGap();
  const fit = getFit() === "cover" ? "fill" : "full";
  const overflow = videos.length > MAX_VIDEOS;
  let suffix = "";
  if (!hasSupportedCells) suffix = `, max ${MAX_GRID_CELLS}`;
  if (hasSupportedCells && !hasEnoughCells) suffix = `, ${videos.length - layout.capacity} over`;
  if (!suffix && gap > 0) suffix = `, ${gap}px gap`;
  if (!suffix && videos.length) suffix = `, ${fit}`;

  layoutHint.textContent = videos.length ? `${label}, ${cells}${suffix}` : "Choose a layout";
  layoutHint.classList.toggle("is-error", Boolean(videos.length && (!hasEnoughCells || !hasSupportedCells || overflow)));
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

function populateNumberSelect(select, min, max, selectedValue) {
  const fragment = document.createDocumentFragment();
  for (let value = min; value <= max; value += 1) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = String(value);
    option.selected = value === selectedValue;
    fragment.append(option);
  }
  select.replaceChildren(fragment);
}

function previewGap(gap) {
  return Math.min(24, Math.round(gap / 3));
}

function updateGapValue() {
  gapValue.textContent = `${getGap()} px`;
}

async function syncHealth() {
  try {
    const response = await fetch("/api/health");
    const payload = await response.json();
    healthPill.textContent = `Port ${payload.port}`;
  } catch {
    healthPill.textContent = "Local";
  }
}

updateGapValue();
syncHealth();
render();
