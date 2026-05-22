const SETTINGS_KEY = "detect-anything:settings";
const INSTALLED_MODELS_KEY = "detect-anything:installed-models";
const FRAME_INTERVAL_MS = 120;
const THEME_COLORS = {
  studio: "#0f766e",
  midnight: "#5eead4",
  cyberpunk: "#00e5ff",
  paper: "#2563eb",
};

const MODEL_CONFIGS = {
  "coco-lite": {
    family: "object",
    name: "COCO-SSD Lite",
    base: "lite_mobilenet_v2",
    libraries: ["tf", "cocoSsd"],
  },
  "coco-v2": {
    family: "object",
    name: "COCO-SSD MobileNet V2",
    base: "mobilenet_v2",
    libraries: ["tf", "cocoSsd"],
  },
  "coco-v1": {
    family: "object",
    name: "COCO-SSD MobileNet V1",
    base: "mobilenet_v1",
    libraries: ["tf", "cocoSsd"],
  },
  "pose-lightning": {
    family: "pose",
    name: "MoveNet Pose Lightning",
    type: "SINGLEPOSE_LIGHTNING",
    libraries: ["tf", "poseDetection"],
  },
  "pose-thunder": {
    family: "pose",
    name: "MoveNet Pose Thunder",
    type: "SINGLEPOSE_THUNDER",
    libraries: ["tf", "poseDetection"],
  },
};

const POSE_CONNECTIONS = [
  ["nose", "left_eye"],
  ["nose", "right_eye"],
  ["left_eye", "left_ear"],
  ["right_eye", "right_ear"],
  ["left_shoulder", "right_shoulder"],
  ["left_shoulder", "left_elbow"],
  ["left_elbow", "left_wrist"],
  ["right_shoulder", "right_elbow"],
  ["right_elbow", "right_wrist"],
  ["left_shoulder", "left_hip"],
  ["right_shoulder", "right_hip"],
  ["left_hip", "right_hip"],
  ["left_hip", "left_knee"],
  ["left_knee", "left_ankle"],
  ["right_hip", "right_knee"],
  ["right_knee", "right_ankle"],
];

const LABEL_KEYPOINTS = new Set([
  "nose",
  "left_shoulder",
  "right_shoulder",
  "left_wrist",
  "right_wrist",
  "left_ankle",
  "right_ankle",
]);

const camera = document.querySelector("#camera");
const overlay = document.querySelector("#overlay");
const ctx = overlay.getContext("2d");
const emptyState = document.querySelector("#emptyState");
const installButton = document.querySelector("#installButton");
const cameraButton = document.querySelector("#cameraButton");
const statusText = document.querySelector("#statusText");
const objectCount = document.querySelector("#objectCount");
const resultMetricLabel = document.querySelector("#resultMetricLabel");
const fpsValue = document.querySelector("#fpsValue");
const modelSelect = document.querySelector("#modelSelect");
const themeSelect = document.querySelector("#themeSelect");
const cameraSelect = document.querySelector("#cameraSelect");
const scoreSlider = document.querySelector("#scoreSlider");
const scoreOutput = document.querySelector("#scoreOutput");
const maxObjects = document.querySelector("#maxObjects");
const maxObjectsOutput = document.querySelector("#maxObjectsOutput");
const limitLabel = document.querySelector("#limitLabel");
const mirrorToggle = document.querySelector("#mirrorToggle");
const labelsToggle = document.querySelector("#labelsToggle");
const detectionList = document.querySelector("#detectionList");
const themeColor = document.querySelector("#themeColor");

const modelCache = new Map();

let activeModelId = "coco-lite";
let stream;
let running = false;
let detecting = false;
let videoFrameReady = false;
let lastFrameAt = 0;
let lastFpsAt = performance.now();
let frameCount = 0;

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function getInstalledModels() {
  return readJson(INSTALLED_MODELS_KEY, []);
}

function markModelInstalled(modelId) {
  const installed = new Set(getInstalledModels());
  installed.add(modelId);
  writeJson(INSTALLED_MODELS_KEY, [...installed]);
}

function modelIsInstalled(modelId) {
  return getInstalledModels().includes(modelId);
}

function getSettings() {
  return {
    modelId: "coco-lite",
    theme: "studio",
    score: "55",
    maxObjects: "8",
    mirror: true,
    labels: true,
    videoDeviceId: "",
    ...readJson(SETTINGS_KEY, {}),
  };
}

function saveSettings() {
  writeJson(SETTINGS_KEY, {
    modelId: modelSelect.value,
    theme: themeSelect.value,
    score: scoreSlider.value,
    maxObjects: maxObjects.value,
    mirror: mirrorToggle.checked,
    labels: labelsToggle.checked,
    videoDeviceId: cameraSelect.value,
  });
}

function setStatus(message) {
  statusText.textContent = message;
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  if (label) {
    button.querySelector("span:last-child").textContent = label;
  }
}

function selectedConfig() {
  return MODEL_CONFIGS[activeModelId] ?? MODEL_CONFIGS["coco-lite"];
}

function updateModeUi() {
  const config = selectedConfig();
  const poseMode = config.family === "pose";

  resultMetricLabel.textContent = poseMode ? "Keypoints" : "Treffer";
  limitLabel.textContent = poseMode ? "Posen" : "Max. Objekte";
  maxObjects.disabled = poseMode;
  maxObjectsOutput.value = poseMode ? "1" : maxObjects.value;
}

function updateInstallState() {
  const cached = modelCache.has(activeModelId);
  const installed = modelIsInstalled(activeModelId);

  updateModeUi();

  if (cached) {
    installButton.querySelector("span:last-child").textContent = "Modell bereit";
    installButton.disabled = true;
    cameraButton.disabled = false;
    return;
  }

  installButton.disabled = false;
  installButton.querySelector("span:last-child").textContent = installed
    ? "Modell laden"
    : "Modell installieren";
  cameraButton.disabled = true;
}

function clearResults() {
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  objectCount.textContent = "0";
  fpsValue.textContent = "0";
  detectionList.replaceChildren();
}

function labelForDevice(device, index) {
  if (device.label) {
    return device.label;
  }

  return `Kamera ${index + 1}`;
}

async function updateCameraList(preferredDeviceId = cameraSelect.value) {
  if (!navigator.mediaDevices?.enumerateDevices) {
    cameraSelect.disabled = true;
    return;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter((device) => device.kind === "videoinput");
    const currentTrack = stream?.getVideoTracks()[0];
    const activeDeviceId = currentTrack?.getSettings().deviceId;
    const selectedDeviceId = preferredDeviceId || activeDeviceId || "";
    const options = [
      new Option("Automatisch", ""),
      ...videoInputs.map((device, index) => {
        const option = new Option(labelForDevice(device, index), device.deviceId);
        if (device.deviceId === activeDeviceId) {
          option.textContent = `${option.textContent} (aktiv)`;
        }
        return option;
      }),
    ];

    cameraSelect.replaceChildren(...options);
    cameraSelect.value = videoInputs.some((device) => device.deviceId === selectedDeviceId)
      ? selectedDeviceId
      : "";
    cameraSelect.disabled = videoInputs.length === 0;
  } catch (error) {
    console.warn("Camera enumeration failed", error);
    cameraSelect.disabled = true;
  }
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  try {
    const registration = await navigator.serviceWorker.register("service-worker.js");
    await navigator.serviceWorker.ready;

    if (registration.waiting) {
      registration.waiting.postMessage({ type: "SKIP_WAITING" });
    }
  } catch (error) {
    console.warn("Service worker registration failed", error);
  }
}

async function waitForLibraries(libraries) {
  const startedAt = performance.now();

  while (
    libraries.some((library) => !window[library]) &&
    performance.now() - startedAt < 10000
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const missing = libraries.filter((library) => !window[library]);
  if (missing.length) {
    throw new Error("Modellbibliothek konnte nicht geladen werden.");
  }
}

async function prepareBackend() {
  const webglReady = await tf.setBackend("webgl").catch(() => false);
  if (!webglReady) {
    await tf.setBackend("cpu");
  }

  await tf.ready();
}

async function loadObjectModel(config) {
  const instance = await cocoSsd.load({ base: config.base });
  const warmup = document.createElement("canvas");
  warmup.width = 320;
  warmup.height = 240;
  await instance.detect(warmup, 1, 0.5);
  return { family: "object", instance };
}

async function loadPoseModel(config) {
  const model = poseDetection.SupportedModels.MoveNet;
  const modelType = poseDetection.movenet.modelType[config.type];
  const instance = await poseDetection.createDetector(model, {
    modelType,
    enableSmoothing: true,
  });
  const warmup = document.createElement("canvas");
  warmup.width = 320;
  warmup.height = 240;
  await instance.estimatePoses(warmup, { flipHorizontal: false }, performance.now());
  return { family: "pose", instance };
}

async function installModel() {
  if (modelCache.has(activeModelId)) {
    return modelCache.get(activeModelId);
  }

  const config = selectedConfig();
  setBusy(installButton, true, "Installiere...");
  setStatus(`Lade ${config.name} und speichere die Dateien lokal im Browsercache.`);

  await waitForLibraries(config.libraries);
  await prepareBackend();

  const model =
    config.family === "pose" ? await loadPoseModel(config) : await loadObjectModel(config);

  modelCache.set(activeModelId, model);
  markModelInstalled(activeModelId);
  updateInstallState();
  setStatus(`${config.name} ist bereit. Die Erkennung läuft lokal im Browser.`);
  return model;
}

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  themeColor.content = THEME_COLORS[theme] ?? THEME_COLORS.studio;
}

function syncMirrorState() {
  camera.classList.toggle("mirrored", mirrorToggle.checked);
}

function resizeOverlay() {
  const rect = overlay.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));

  if (overlay.width !== width || overlay.height !== height) {
    overlay.width = width;
    overlay.height = height;
  }
}

function videoMap() {
  const scale = Math.max(
    overlay.width / camera.videoWidth,
    overlay.height / camera.videoHeight,
  );
  const renderedWidth = camera.videoWidth * scale;
  const renderedHeight = camera.videoHeight * scale;

  return {
    scale,
    offsetX: (overlay.width - renderedWidth) / 2,
    offsetY: (overlay.height - renderedHeight) / 2,
  };
}

function mapPoint(point, map) {
  const x = point.x * map.scale + map.offsetX;
  const y = point.y * map.scale + map.offsetY;
  return {
    x: mirrorToggle.checked ? overlay.width - x : x,
    y,
  };
}

function mapBox(bbox, map) {
  const [rawX, rawY, rawWidth, rawHeight] = bbox;
  const width = rawWidth * map.scale;
  const height = rawHeight * map.scale;
  const x = rawX * map.scale + map.offsetX;
  const y = rawY * map.scale + map.offsetY;

  return {
    x: mirrorToggle.checked ? overlay.width - x - width : x,
    y,
    width,
    height,
  };
}

function labelFontSize() {
  const dpr = overlay.width / Math.max(overlay.clientWidth, 1);
  const cssSize = window.matchMedia("(max-width: 700px)").matches ? 18 : 15;
  return Math.round(cssSize * dpr);
}

function drawLabel(text, x, y, color) {
  const fontSize = labelFontSize();
  const padX = Math.round(fontSize * 0.55);
  const padY = Math.round(fontSize * 0.34);
  const height = fontSize + padY * 2;

  ctx.font = `800 ${fontSize}px Inter, system-ui, sans-serif`;
  ctx.textBaseline = "top";

  const width = ctx.measureText(text).width + padX * 2;
  const safeX = Math.min(Math.max(0, x), Math.max(0, overlay.width - width));
  const safeY = Math.min(Math.max(0, y), Math.max(0, overlay.height - height));

  ctx.fillStyle = color;
  ctx.shadowColor = "rgb(0 0 0 / 0.24)";
  ctx.shadowBlur = Math.round(fontSize * 0.45);
  ctx.fillRect(safeX, safeY, width, height);
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, safeX + padX, safeY + padY);
}

function setCanvasStyle() {
  const dpr = overlay.width / Math.max(overlay.clientWidth, 1);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(3 * dpr, Math.round(overlay.width / 220));
}

function drawObjectDetections(predictions) {
  resizeOverlay();
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  setCanvasStyle();

  const map = videoMap();
  const showLabels = labelsToggle.checked;

  predictions.forEach((prediction, index) => {
    const box = mapBox(prediction.bbox, map);
    const color = index % 2 === 0 ? "#14b8a6" : "#f59e0b";
    const label = `${prediction.class} ${Math.round(prediction.score * 100)}%`;

    ctx.strokeStyle = color;
    ctx.strokeRect(box.x, box.y, box.width, box.height);

    if (showLabels) {
      drawLabel(label, box.x, box.y - labelFontSize() * 2.1, color);
    }
  });
}

function visibleKeypoints(pose, threshold) {
  return pose.keypoints.filter((keypoint) => (keypoint.score ?? 0) >= threshold);
}

function drawPoseDetections(poses, threshold) {
  resizeOverlay();
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  setCanvasStyle();

  const map = videoMap();
  const showLabels = labelsToggle.checked;
  const pointRadius = Math.max(5, Math.round(labelFontSize() * 0.34));

  poses.forEach((pose, poseIndex) => {
    const byName = new Map(
      pose.keypoints
        .filter((keypoint) => (keypoint.score ?? 0) >= threshold)
        .map((keypoint) => [keypoint.name, mapPoint(keypoint, map)]),
    );
    const color = poseIndex % 2 === 0 ? "#14b8a6" : "#f59e0b";

    ctx.strokeStyle = color;
    POSE_CONNECTIONS.forEach(([from, to]) => {
      const start = byName.get(from);
      const end = byName.get(to);
      if (!start || !end) {
        return;
      }

      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    });

    ctx.fillStyle = color;
    pose.keypoints.forEach((keypoint) => {
      if ((keypoint.score ?? 0) < threshold) {
        return;
      }

      const point = mapPoint(keypoint, map);
      ctx.beginPath();
      ctx.arc(point.x, point.y, pointRadius, 0, Math.PI * 2);
      ctx.fill();

      if (showLabels && LABEL_KEYPOINTS.has(keypoint.name)) {
        drawLabel(
          keypoint.name.replace("_", " "),
          point.x + pointRadius * 1.5,
          point.y - labelFontSize() * 0.9,
          color,
        );
      }
    });
  });
}

function updateObjectList(predictions) {
  detectionList.replaceChildren(
    ...predictions.map((prediction) => {
      const item = document.createElement("li");
      const name = document.createElement("strong");
      const score = document.createElement("span");

      name.textContent = prediction.class;
      score.className = "score";
      score.textContent = `${Math.round(prediction.score * 100)}%`;
      item.append(name, score);
      return item;
    }),
  );
}

function updatePoseList(poses, threshold) {
  detectionList.replaceChildren(
    ...poses.map((pose, index) => {
      const keypoints = visibleKeypoints(pose, threshold);
      const item = document.createElement("li");
      const name = document.createElement("strong");
      const score = document.createElement("span");

      name.textContent = `Pose ${index + 1}`;
      score.className = "score";
      score.textContent = `${keypoints.length}/17`;
      item.append(name, score);
      return item;
    }),
  );
}

function updateFps() {
  frameCount += 1;
  const now = performance.now();

  if (now - lastFpsAt >= 1000) {
    fpsValue.textContent = String(frameCount);
    frameCount = 0;
    lastFpsAt = now;
  }
}

async function startCamera() {
  await installModel();

  setBusy(cameraButton, true, "Starte...");
  setStatus("Fordere Kamerazugriff an.");

  const videoDeviceId = cameraSelect.value;
  const videoConstraints = videoDeviceId
    ? {
        deviceId: { exact: videoDeviceId },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      }
    : {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      };

  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: videoConstraints,
  });
  await updateCameraList(videoDeviceId);

  camera.srcObject = stream;
  await Promise.race([
    new Promise((resolve) => {
      if (camera.readyState >= 2) {
        resolve();
        return;
      }

      camera.addEventListener("loadedmetadata", resolve, { once: true });
    }),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  await Promise.race([camera.play(), new Promise((resolve) => setTimeout(resolve, 2000))]);

  running = true;
  videoFrameReady = false;
  lastFrameAt = 0;
  frameCount = 0;
  lastFpsAt = performance.now();
  resizeOverlay();
  emptyState.classList.add("hidden");
  syncMirrorState();
  setBusy(cameraButton, false, "Kamera stoppen");
  setStatus("Kamera aktiv. Warte auf erstes Videobild.");
  requestAnimationFrame(detectLoop);
}

function stopCamera() {
  running = false;
  videoFrameReady = false;

  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = undefined;
  }

  camera.srcObject = null;
  clearResults();
  emptyState.classList.remove("hidden");
  cameraButton.querySelector("span:last-child").textContent = "Kamera starten";
  setStatus("Kamera gestoppt.");
}

async function detectLoop(now) {
  if (!running) {
    return;
  }

  requestAnimationFrame(detectLoop);

  if (detecting || now - lastFrameAt < FRAME_INTERVAL_MS) {
    return;
  }

  if (!camera.videoWidth || !camera.videoHeight) {
    return;
  }

  if (!videoFrameReady) {
    videoFrameReady = true;
    resizeOverlay();
    setStatus("Kamera aktiv. Erkennung läuft lokal.");
  }

  detecting = true;
  lastFrameAt = now;

  try {
    const active = modelCache.get(activeModelId);
    const score = Number(scoreSlider.value) / 100;

    if (active.family === "pose") {
      const poses = await active.instance.estimatePoses(
        camera,
        { flipHorizontal: false },
        performance.now(),
      );
      const filtered = poses.filter((pose) => visibleKeypoints(pose, score).length > 0);
      const keypointCount = filtered.reduce(
        (total, pose) => total + visibleKeypoints(pose, score).length,
        0,
      );

      drawPoseDetections(filtered, score);
      updatePoseList(filtered, score);
      objectCount.textContent = String(keypointCount);
    } else {
      const limit = Number(maxObjects.value);
      const predictions = await active.instance.detect(camera, limit, score);

      drawObjectDetections(predictions);
      updateObjectList(predictions);
      objectCount.textContent = String(predictions.length);
    }

    updateFps();
  } catch (error) {
    console.error(error);
    setStatus("Erkennung wurde unterbrochen. Kamera neu starten.");
  } finally {
    detecting = false;
  }
}

function applySettings() {
  const settings = getSettings();

  activeModelId = MODEL_CONFIGS[settings.modelId] ? settings.modelId : "coco-lite";
  modelSelect.value = activeModelId;
  themeSelect.value = THEME_COLORS[settings.theme] ? settings.theme : "studio";
  scoreSlider.value = settings.score;
  maxObjects.value = settings.maxObjects;
  mirrorToggle.checked = Boolean(settings.mirror);
  labelsToggle.checked = Boolean(settings.labels);
  cameraSelect.value = settings.videoDeviceId;

  scoreOutput.value = `${scoreSlider.value}%`;
  maxObjectsOutput.value = maxObjects.value;
  applyTheme(themeSelect.value);
  syncMirrorState();
  updateInstallState();
}

installButton.addEventListener("click", async () => {
  try {
    await installModel();
  } catch (error) {
    console.error(error);
    installButton.disabled = false;
    setStatus(error.message || "Modell konnte nicht installiert werden.");
  }
});

cameraButton.addEventListener("click", async () => {
  try {
    if (running) {
      stopCamera();
    } else {
      await startCamera();
    }
  } catch (error) {
    console.error(error);
    cameraButton.disabled = !modelCache.has(activeModelId);
    cameraButton.querySelector("span:last-child").textContent = "Kamera starten";
    setStatus(error.message || "Kamera konnte nicht gestartet werden.");
  }
});

modelSelect.addEventListener("change", () => {
  if (running) {
    stopCamera();
  }

  activeModelId = modelSelect.value;
  clearResults();
  saveSettings();
  updateInstallState();
  setStatus(`${selectedConfig().name} ausgewählt.`);
});

themeSelect.addEventListener("change", () => {
  applyTheme(themeSelect.value);
  saveSettings();
});

cameraSelect.addEventListener("change", async () => {
  saveSettings();

  if (!running) {
    return;
  }

  try {
    stopCamera();
    setStatus("Wechsle Videoquelle.");
    await startCamera();
  } catch (error) {
    console.error(error);
    cameraButton.querySelector("span:last-child").textContent = "Kamera starten";
    setStatus(error.message || "Videoquelle konnte nicht gewechselt werden.");
  }
});

scoreSlider.addEventListener("input", () => {
  scoreOutput.value = `${scoreSlider.value}%`;
  saveSettings();
});

maxObjects.addEventListener("input", () => {
  maxObjectsOutput.value = maxObjects.value;
  saveSettings();
});

mirrorToggle.addEventListener("change", () => {
  syncMirrorState();
  saveSettings();
});

labelsToggle.addEventListener("change", saveSettings);

window.addEventListener("resize", resizeOverlay);

if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    updateCameraList().then(saveSettings);
  });
}

registerServiceWorker();
applySettings();
updateCameraList(getSettings().videoDeviceId);
