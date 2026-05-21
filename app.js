const MODEL_KEY = "detect-anything:model-installed-at";
const MODEL_BASE = "lite_mobilenet_v2";
const FRAME_INTERVAL_MS = 120;

const camera = document.querySelector("#camera");
const overlay = document.querySelector("#overlay");
const ctx = overlay.getContext("2d");
const emptyState = document.querySelector("#emptyState");
const installButton = document.querySelector("#installButton");
const cameraButton = document.querySelector("#cameraButton");
const statusText = document.querySelector("#statusText");
const objectCount = document.querySelector("#objectCount");
const fpsValue = document.querySelector("#fpsValue");
const scoreSlider = document.querySelector("#scoreSlider");
const scoreOutput = document.querySelector("#scoreOutput");
const maxObjects = document.querySelector("#maxObjects");
const maxObjectsOutput = document.querySelector("#maxObjectsOutput");
const mirrorToggle = document.querySelector("#mirrorToggle");
const labelsToggle = document.querySelector("#labelsToggle");
const detectionList = document.querySelector("#detectionList");

let model;
let stream;
let running = false;
let detecting = false;
let videoFrameReady = false;
let lastFrameAt = 0;
let lastFpsAt = performance.now();
let frameCount = 0;

function setStatus(message) {
  statusText.textContent = message;
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  if (label) {
    button.querySelector("span:last-child").textContent = label;
  }
}

function modelIsInstalled() {
  return Boolean(localStorage.getItem(MODEL_KEY));
}

function updateInstallState() {
  if (model) {
    installButton.querySelector("span:last-child").textContent = "Modell installiert";
    installButton.disabled = true;
    cameraButton.disabled = false;
    return;
  }

  if (modelIsInstalled()) {
    installButton.querySelector("span:last-child").textContent = "Modell laden";
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

async function waitForLibraries() {
  const startedAt = performance.now();

  while ((!window.tf || !window.cocoSsd) && performance.now() - startedAt < 10000) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  if (!window.tf || !window.cocoSsd) {
    throw new Error("TensorFlow.js konnte nicht geladen werden.");
  }
}

async function installModel() {
  if (model) {
    return model;
  }

  setBusy(installButton, true, "Installiere...");
  setStatus("Lade Modell und speichere Dateien lokal im Browsercache.");

  await waitForLibraries();
  const webglReady = await tf.setBackend("webgl").catch(() => false);
  if (!webglReady) {
    await tf.setBackend("cpu");
  }

  await tf.ready();

  model = await cocoSsd.load({ base: MODEL_BASE });

  const warmup = document.createElement("canvas");
  warmup.width = 320;
  warmup.height = 240;
  await model.detect(warmup, 1, 0.5);

  localStorage.setItem(MODEL_KEY, new Date().toISOString());
  updateInstallState();
  setStatus("Modell installiert. Die Erkennung läuft lokal im Browser.");
  return model;
}

function syncMirrorState() {
  const mirrored = mirrorToggle.checked;
  camera.classList.toggle("mirrored", mirrored);
}

function resizeOverlay() {
  const width = camera.videoWidth || overlay.clientWidth;
  const height = camera.videoHeight || overlay.clientHeight;

  if (overlay.width !== width || overlay.height !== height) {
    overlay.width = width;
    overlay.height = height;
  }
}

async function startCamera() {
  await installModel();

  setBusy(cameraButton, true, "Starte...");
  setStatus("Fordere Kamerazugriff an.");

  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: "environment",
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  });

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
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  emptyState.classList.remove("hidden");
  cameraButton.querySelector("span:last-child").textContent = "Kamera starten";
  objectCount.textContent = "0";
  fpsValue.textContent = "0";
  detectionList.replaceChildren();
  setStatus("Kamera gestoppt.");
}

function drawDetections(predictions) {
  resizeOverlay();
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  ctx.lineWidth = Math.max(3, Math.round(overlay.width / 260));
  ctx.font = `${Math.max(15, Math.round(overlay.width / 52))}px Inter, system-ui, sans-serif`;
  ctx.textBaseline = "top";

  const showLabels = labelsToggle.checked;

  predictions.forEach((prediction, index) => {
    const [rawX, y, width, height] = prediction.bbox;
    const x = mirrorToggle.checked ? overlay.width - rawX - width : rawX;
    const color = index % 2 === 0 ? "#14b8a6" : "#f59e0b";
    const label = `${prediction.class} ${Math.round(prediction.score * 100)}%`;

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.strokeRect(x, y, width, height);

    if (showLabels) {
      const textWidth = ctx.measureText(label).width + 14;
      const labelY = Math.max(0, y - 30);
      ctx.fillRect(x, labelY, textWidth, 28);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, x + 7, labelY + 5);
    }
  });
}

function updateDetectionList(predictions) {
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

function updateFps() {
  frameCount += 1;
  const now = performance.now();

  if (now - lastFpsAt >= 1000) {
    fpsValue.textContent = String(frameCount);
    frameCount = 0;
    lastFpsAt = now;
  }
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
    setStatus("Kamera aktiv. Objekte werden lokal erkannt.");
  }

  detecting = true;
  lastFrameAt = now;

  try {
    const limit = Number(maxObjects.value);
    const score = Number(scoreSlider.value) / 100;
    const predictions = await model.detect(camera, limit, score);

    drawDetections(predictions);
    updateDetectionList(predictions);
    objectCount.textContent = String(predictions.length);
    updateFps();
  } catch (error) {
    console.error(error);
    setStatus("Erkennung wurde unterbrochen. Kamera neu starten.");
  } finally {
    detecting = false;
  }
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
    cameraButton.disabled = !model;
    cameraButton.querySelector("span:last-child").textContent = "Kamera starten";
    setStatus(error.message || "Kamera konnte nicht gestartet werden.");
  }
});

scoreSlider.addEventListener("input", () => {
  scoreOutput.value = `${scoreSlider.value}%`;
});

maxObjects.addEventListener("input", () => {
  maxObjectsOutput.value = maxObjects.value;
});

mirrorToggle.addEventListener("change", syncMirrorState);

window.addEventListener("resize", resizeOverlay);

registerServiceWorker();
updateInstallState();
