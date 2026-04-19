const canvas = document.getElementById("scene");
const context = canvas.getContext("2d");

const statusEl = document.getElementById("status");
const sourceLabelEl = document.getElementById("source-label");
const bassMeterEl = document.getElementById("bass-meter");
const midMeterEl = document.getElementById("mid-meter");
const highMeterEl = document.getElementById("high-meter");

const shareAudioButton = document.getElementById("share-audio");
const micAudioButton = document.getElementById("mic-audio");
const demoModeButton = document.getElementById("demo-mode");
const fileInput = document.getElementById("audio-file");
const audioPlayer = document.getElementById("audio-player");

let width = window.innerWidth;
let height = window.innerHeight;
let dpr = Math.min(window.devicePixelRatio || 1, 2);

const droplets = [];
const ripples = [];

const BLOOM_SEGMENTS = 128;
const bloomRadiiScratch = new Float32Array(BLOOM_SEGMENTS);
const bloomRadiiSmoothed = new Float32Array(BLOOM_SEGMENTS);
const bloomContourPoints = Array.from({ length: BLOOM_SEGMENTS }, () => ({ x: 0, y: 0 }));

let animationId = 0;
let audioContext;
let analyser;
let frequencyData;
let waveformData;
let audioSource;
let sourceStream;
let silentOutput;
let mediaElementSource;
let demoMode = true;
let currentTrackUrl = "";

const state = {
  bass: 0.16,
  mid: 0.18,
  high: 0.22,
  intensity: 0.14,
  transient: 0,
  hueShift: 0,
  lastRippleAt: 0,
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function lerp(start, end, factor) {
  return start + (end - start) * factor;
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function setStatus(message) {
  statusEl.textContent = message;
}

function setSourceLabel(message) {
  sourceLabelEl.textContent = message;
}

function resizeCanvas() {
  width = window.innerWidth;
  height = window.innerHeight;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function seedDroplets() {
  droplets.length = 0;
  const count = width < 700 ? 34 : 58;

  for (let index = 0; index < count; index += 1) {
    droplets.push({
      x: Math.random() * width,
      y: Math.random() * height,
      radius: randomBetween(8, 42),
      drift: randomBetween(0.08, 0.28),
      sway: randomBetween(0.4, 1.25),
      phase: Math.random() * Math.PI * 2,
      depth: randomBetween(0.4, 1.25),
      shimmer: randomBetween(0.35, 1),
    });
  }
}

function ensureAudioGraph() {
  if (!audioContext) {
    audioContext = new window.AudioContext();
  }

  if (audioContext.state === "suspended") {
    audioContext.resume();
  }

  if (!analyser) {
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.86;
    frequencyData = new Uint8Array(analyser.frequencyBinCount);
    waveformData = new Uint8Array(analyser.fftSize);
    silentOutput = audioContext.createGain();
    silentOutput.gain.value = 0;
    analyser.connect(silentOutput);
    silentOutput.connect(audioContext.destination);
  }

  return analyser;
}

function disconnectCurrentSource() {
  if (audioSource) {
    audioSource.disconnect();
    audioSource = null;
  }

  if (sourceStream) {
    for (const track of sourceStream.getTracks()) {
      track.stop();
    }

    sourceStream = null;
  }

  if (currentTrackUrl) {
    URL.revokeObjectURL(currentTrackUrl);
    currentTrackUrl = "";
  }

  audioPlayer.pause();
  audioPlayer.removeAttribute("src");
  audioPlayer.load();
}

async function startDisplayCapture() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    setStatus("Tab audio capture is not available in this browser.");
    return;
  }

  const graph = ensureAudioGraph();

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
      },
    });

    const [audioTrack] = stream.getAudioTracks();

    if (!audioTrack) {
      for (const track of stream.getTracks()) {
        track.stop();
      }

      setStatus("No audio was shared. Pick a browser tab and enable its audio.");
      return;
    }

    disconnectCurrentSource();
    sourceStream = stream;
    audioSource = audioContext.createMediaStreamSource(stream);
    audioSource.connect(graph);
    demoMode = false;
    setSourceLabel("Tab or system audio");
    setStatus("Listening to shared audio. Keep the tab or app unmuted.");

    audioTrack.addEventListener("ended", () => {
      demoMode = true;
      setSourceLabel("Demo pulse");
      setStatus("Shared audio ended. Falling back to demo mode.");
    });
  } catch (error) {
    setStatus("Audio sharing was cancelled or unavailable in this browser.");
  }
}

async function startMicrophoneCapture() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Microphone capture is not available in this browser.");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    disconnectCurrentSource();
    sourceStream = stream;
    audioSource = ensureAudioGraph().context.createMediaStreamSource(stream);
    audioSource.connect(analyser);
    demoMode = false;
    setSourceLabel("Microphone input");
    setStatus("Microphone connected. Nearby music will drive the scene.");
  } catch (error) {
    setStatus("Microphone access was blocked. Use tab audio or demo mode instead.");
  }
}

async function startFilePlayback(file) {
  if (!file) {
    return;
  }

  try {
    ensureAudioGraph();
    disconnectCurrentSource();
    currentTrackUrl = URL.createObjectURL(file);
    audioPlayer.src = currentTrackUrl;
    audioPlayer.loop = true;
    audioPlayer.volume = 1;
    if (!mediaElementSource) {
      mediaElementSource = audioContext.createMediaElementSource(audioPlayer);
    }

    audioSource = mediaElementSource;
    audioSource.connect(analyser);
    audioSource.connect(audioContext.destination);
    demoMode = false;
    await audioPlayer.play();
    setSourceLabel(`Track: ${file.name}`);
    setStatus("Loaded local track. The visuals are following the file playback.");
  } catch (error) {
    setStatus("The selected audio file could not be played.");
  }
}

function startDemoMode() {
  disconnectCurrentSource();
  demoMode = true;
  setSourceLabel("Demo pulse");
  setStatus("Demo mode active. The scene is running on a synthetic pulse.");
}

function readLiveAudio(now) {
  analyser.getByteFrequencyData(frequencyData);
  analyser.getByteTimeDomainData(waveformData);

  const bassEnd = Math.floor(frequencyData.length * 0.08);
  const midEnd = Math.floor(frequencyData.length * 0.32);
  const highEnd = Math.floor(frequencyData.length * 0.68);

  let bassSum = 0;
  let midSum = 0;
  let highSum = 0;
  let amplitude = 0;

  for (let index = 0; index < frequencyData.length; index += 1) {
    const value = frequencyData[index] / 255;

    if (index < bassEnd) {
      bassSum += value;
    } else if (index < midEnd) {
      midSum += value;
    } else if (index < highEnd) {
      highSum += value;
    }
  }

  for (let index = 0; index < waveformData.length; index += 1) {
    const sample = waveformData[index] / 128 - 1;
    amplitude += sample * sample;
  }

  const bass = bassSum / Math.max(bassEnd, 1);
  const mid = midSum / Math.max(midEnd - bassEnd, 1);
  const high = highSum / Math.max(highEnd - midEnd, 1);
  const intensity = clamp(Math.sqrt(amplitude / waveformData.length) * 2.2, 0, 1);
  const transient = Math.max(0, bass - state.bass * 0.9) + intensity * 0.25;

  state.bass = lerp(state.bass, bass, 0.14);
  state.mid = lerp(state.mid, mid, 0.12);
  state.high = lerp(state.high, high, 0.12);
  state.intensity = lerp(state.intensity, intensity, 0.12);
  state.transient = lerp(state.transient, transient, 0.22);
  state.hueShift = lerp(state.hueShift, mid * 60 + high * 90, 0.05);

  if (transient > 0.18 && now - state.lastRippleAt > 180) {
    spawnRipple(width * 0.5, height * 0.54, 60 + bass * 80, 0.85);
    state.lastRippleAt = now;
  }
}

function readDemoAudio(now) {
  const seconds = now * 0.001;
  const bass = 0.32 + Math.sin(seconds * 1.35) * 0.16 + Math.sin(seconds * 3.8) * 0.07;
  const mid = 0.26 + Math.sin(seconds * 0.92 + 1.4) * 0.11;
  const high = 0.24 + Math.sin(seconds * 1.67 + 2.1) * 0.1;
  const intensity = 0.28 + Math.sin(seconds * 1.05) * 0.09 + Math.sin(seconds * 5.4) * 0.04;
  const transient = Math.max(0, Math.sin(seconds * 2.7)) * 0.24;

  state.bass = lerp(state.bass, clamp(bass, 0, 1), 0.08);
  state.mid = lerp(state.mid, clamp(mid, 0, 1), 0.08);
  state.high = lerp(state.high, clamp(high, 0, 1), 0.08);
  state.intensity = lerp(state.intensity, clamp(intensity, 0, 1), 0.08);
  state.transient = lerp(state.transient, transient, 0.16);
  state.hueShift = lerp(state.hueShift, 28 + state.mid * 44 + state.high * 54, 0.05);

  if (transient > 0.16 && now - state.lastRippleAt > 340) {
    spawnRipple(width * 0.5, height * 0.56, 55 + state.bass * 55, 0.72);
    state.lastRippleAt = now;
  }
}

function updateMeters() {
  bassMeterEl.style.width = `${Math.round(clamp(state.bass, 0, 1) * 100)}%`;
  midMeterEl.style.width = `${Math.round(clamp(state.mid, 0, 1) * 100)}%`;
  highMeterEl.style.width = `${Math.round(clamp(state.high, 0, 1) * 100)}%`;
}

function spawnRipple(x, y, radius, strength) {
  ripples.push({
    x,
    y,
    radius,
    strength,
    age: 0,
    life: 1600 + strength * 600,
  });
}

function sampleBloomSpectrum(progress) {
  if (!frequencyData || frequencyData.length === 0) {
    return state.mid;
  }

  const length = frequencyData.length;
  const span = length * 0.45;
  const position = progress * span;
  const index = Math.floor(position);
  const fraction = position - index;
  const safeIndex = clamp(index, 0, length - 1);
  const nextIndex = clamp(index + 1, 0, length - 1);
  const valueA = frequencyData[safeIndex] / 255;
  const valueB = frequencyData[nextIndex] / 255;

  return valueA * (1 - fraction) + valueB * fraction;
}

function smoothRing3Tap(radii, work, count, passes) {
  for (let pass = 0; pass < passes; pass += 1) {
    for (let index = 0; index < count; index += 1) {
      const previous = radii[(index - 1 + count) % count];
      const current = radii[index];
      const next = radii[(index + 1) % count];
      work[index] = previous * 0.22 + current * 0.56 + next * 0.22;
    }

    for (let index = 0; index < count; index += 1) {
      radii[index] = work[index];
    }
  }
}

function traceSmoothClosedCardinal(points, count, curvatureDivisor) {
  if (count < 3) {
    return;
  }

  const first = points[0];
  context.moveTo(first.x, first.y);

  for (let index = 0; index < count; index += 1) {
    const previous = points[(index - 1 + count) % count];
    const current = points[index];
    const next = points[(index + 1) % count];
    const afterNext = points[(index + 2) % count];
    const control1x = current.x + (next.x - previous.x) / curvatureDivisor;
    const control1y = current.y + (next.y - previous.y) / curvatureDivisor;
    const control2x = next.x - (afterNext.x - current.x) / curvatureDivisor;
    const control2y = next.y - (afterNext.y - current.y) / curvatureDivisor;

    context.bezierCurveTo(control1x, control1y, control2x, control2y, next.x, next.y);
  }

  context.closePath();
}

function drawBackground(now) {
  const seconds = now * 0.001;
  const hueA = 198 + state.hueShift * 0.12;
  const hueB = 210 + state.bass * 22;
  const hueC = 184 + state.high * 28;

  const wash = context.createLinearGradient(0, 0, width, height);
  wash.addColorStop(0, `hsla(${hueA}, 58%, 10%, 0.96)`);
  wash.addColorStop(0.45, `hsla(${hueB}, 55%, 15%, 0.88)`);
  wash.addColorStop(1, `hsla(${hueC}, 48%, 25%, 0.94)`);
  context.fillStyle = wash;
  context.fillRect(0, 0, width, height);

  const glow = context.createRadialGradient(
    width * 0.5,
    height * 0.48,
    0,
    width * 0.5,
    height * 0.48,
    Math.max(width, height) * 0.62
  );
  glow.addColorStop(0, `rgba(198, 246, 255, ${0.07 + state.intensity * 0.14})`);
  glow.addColorStop(0.45, `rgba(98, 196, 228, ${0.06 + state.mid * 0.08})`);
  glow.addColorStop(1, "rgba(3, 10, 14, 0)");
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);

  context.save();
  context.globalCompositeOperation = "screen";
  for (let index = 0; index < 3; index += 1) {
    const offset = index * Math.PI * 0.65;
    const x = width * (0.28 + 0.3 * Math.sin(seconds * 0.11 + offset));
    const y = height * (0.32 + 0.18 * Math.cos(seconds * 0.17 + offset * 1.2));
    const radius = Math.min(width, height) * (0.2 + index * 0.06 + state.intensity * 0.12);
    const aura = context.createRadialGradient(x, y, 0, x, y, radius);
    aura.addColorStop(0, `rgba(224, 251, 255, ${0.045 + state.high * 0.04})`);
    aura.addColorStop(0.55, `rgba(124, 205, 236, ${0.04 + state.mid * 0.05})`);
    aura.addColorStop(1, "rgba(0, 0, 0, 0)");
    context.fillStyle = aura;
    context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
  context.restore();
}

function drawBloom(now) {
  const seconds = now * 0.001;
  const centerX = width * 0.5;
  const centerY = height * 0.54;
  const baseRadius = Math.min(width, height) * (0.12 + state.intensity * 0.05);
  const segments = BLOOM_SEGMENTS;
  const squash = 0.76 + state.mid * 0.15;

  for (let index = 0; index < segments; index += 1) {
    const progress = index / segments;
    const angle = progress * Math.PI * 2;
    const spectrum = sampleBloomSpectrum(progress);
    const pulse =
      Math.sin(angle * 2 + seconds * 1.8) * 5 +
      Math.cos(angle * 1.5 - seconds * 1.15) * 6;
    const radius =
      baseRadius +
      spectrum * 78 +
      state.bass * 36 +
      pulse +
      Math.sin(seconds * 0.9 + angle * 1.1) * 10;
    bloomRadiiScratch[index] = Math.max(baseRadius * 0.35, radius);
  }

  smoothRing3Tap(bloomRadiiScratch, bloomRadiiSmoothed, segments, 4);

  for (let index = 0; index < segments; index += 1) {
    const progress = index / segments;
    const angle = progress * Math.PI * 2;
    const radius = bloomRadiiScratch[index];
    const point = bloomContourPoints[index];
    point.x = Math.cos(angle) * radius;
    point.y = Math.sin(angle) * radius * squash;
  }

  context.save();
  context.translate(centerX, centerY);
  context.rotate(seconds * 0.03 + state.high * 0.18);
  context.beginPath();
  traceSmoothClosedCardinal(bloomContourPoints, segments, 9);

  const bloom = context.createRadialGradient(0, 0, 0, 0, 0, baseRadius * 2.4);
  bloom.addColorStop(0, `rgba(246, 253, 255, ${0.34 + state.intensity * 0.26})`);
  bloom.addColorStop(0.3, `rgba(157, 222, 241, ${0.2 + state.high * 0.15})`);
  bloom.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = bloom;
  context.fill();

  context.lineWidth = 1.2 + state.high * 2;
  context.strokeStyle = `rgba(224, 250, 255, ${0.18 + state.high * 0.2})`;
  context.stroke();
  context.restore();
}

function drawWaveRibbon(now) {
  const seconds = now * 0.001;
  const centerY = height * 0.72;
  const amplitude = 20 + state.intensity * 44 + state.high * 24;

  context.save();
  context.beginPath();

  for (let index = 0; index <= 96; index += 1) {
    const progress = index / 96;
    const x = progress * width;
    const waveIndex = Math.floor(progress * (waveformData?.length || 128));
    const sample = waveformData ? waveformData[waveIndex] / 128 - 1 : Math.sin(seconds * 3 + progress * 14) * 0.4;
    const y =
      centerY +
      Math.sin(progress * 8 + seconds * 0.7) * 14 +
      sample * amplitude;

    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }

  context.strokeStyle = `rgba(230, 252, 255, ${0.1 + state.mid * 0.1})`;
  context.lineWidth = 1 + state.mid * 1.2;
  context.stroke();
  context.restore();
}

function drawDroplets(now) {
  const seconds = now * 0.001;

  for (const droplet of droplets) {
    const x = droplet.x + Math.sin(seconds * droplet.drift + droplet.phase) * 18 * droplet.sway;
    const y = droplet.y + Math.cos(seconds * droplet.drift * 0.8 + droplet.phase) * 12 * droplet.sway;
    const scale = 1 + state.bass * 0.3 * droplet.depth + state.transient * 0.8;
    const radius = droplet.radius * scale;

    const body = context.createRadialGradient(
      x - radius * 0.24,
      y - radius * 0.28,
      radius * 0.1,
      x,
      y,
      radius
    );
    body.addColorStop(0, `rgba(233, 252, 255, ${0.22 * droplet.shimmer + state.high * 0.16})`);
    body.addColorStop(0.45, `rgba(118, 195, 225, ${0.16 + state.mid * 0.12})`);
    body.addColorStop(1, "rgba(3, 16, 24, 0)");

    context.fillStyle = body;
    context.beginPath();
    context.ellipse(x, y, radius * 0.82, radius, Math.sin(seconds * 0.2 + droplet.phase) * 0.2, 0, Math.PI * 2);
    context.fill();

    context.strokeStyle = `rgba(229, 251, 255, ${0.07 + state.high * 0.09})`;
    context.lineWidth = 1;
    context.stroke();
  }
}

function drawRipples(delta) {
  for (let index = ripples.length - 1; index >= 0; index -= 1) {
    const ripple = ripples[index];
    ripple.age += delta;

    if (ripple.age >= ripple.life) {
      ripples.splice(index, 1);
      continue;
    }

    const progress = ripple.age / ripple.life;
    const radius = ripple.radius + progress * 200;
    const opacity = (1 - progress) * ripple.strength * 0.22;

    context.beginPath();
    context.arc(ripple.x, ripple.y, radius, 0, Math.PI * 2);
    context.strokeStyle = `rgba(225, 250, 255, ${opacity})`;
    context.lineWidth = 1.2 + (1 - progress) * 4;
    context.stroke();
  }
}

function animate(now) {
  const delta = animationId ? now - animationId : 16;
  animationId = now;

  if (!demoMode && analyser) {
    readLiveAudio(now);
  } else {
    readDemoAudio(now);
  }

  updateMeters();
  drawBackground(now);
  drawBloom(now);
  drawWaveRibbon(now);
  drawDroplets(now);
  drawRipples(delta);

  window.requestAnimationFrame(animate);
}

shareAudioButton.addEventListener("click", startDisplayCapture);
micAudioButton.addEventListener("click", startMicrophoneCapture);
demoModeButton.addEventListener("click", startDemoMode);

fileInput.addEventListener("change", (event) => {
  const [file] = event.target.files;
  startFilePlayback(file);
});

window.addEventListener("resize", () => {
  resizeCanvas();
  seedDroplets();
});

resizeCanvas();
seedDroplets();
startDemoMode();
window.requestAnimationFrame(animate);
