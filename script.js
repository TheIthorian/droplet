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
const viewClassicButton = document.getElementById("view-classic");
const viewNotesButton = document.getElementById("view-notes");
const fileInput = document.getElementById("audio-file");
const audioPlayer = document.getElementById("audio-player");

let width = window.innerWidth;
let height = window.innerHeight;
let dpr = Math.min(window.devicePixelRatio || 1, 2);

const droplets = [];
const ripples = [];
const noteParticles = [];

const NOTE_PARTICLE_CAP = 200;
let viewMode = "classic";
let lastSpectrumForFlux = null;
let spectrumPrimed = false;
let lastDemoNoteAt = 0;

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

function setViewMode(mode) {
  if (mode !== "classic" && mode !== "notes") {
    return;
  }

  if (viewMode === mode) {
    return;
  }

  viewMode = mode;

  if (mode === "classic") {
    noteParticles.length = 0;
    seedDroplets();
  } else {
    noteParticles.length = 0;
    spectrumPrimed = false;
    lastSpectrumForFlux = null;
  }

  viewClassicButton.setAttribute("aria-pressed", mode === "classic" ? "true" : "false");
  viewNotesButton.setAttribute("aria-pressed", mode === "notes" ? "true" : "false");
}

function binToPitchNorm(bin, sampleRate, fftSize) {
  const sr = Number(sampleRate) || 48000;
  const fft = Math.max(1, Number(fftSize) || 2048);
  const hz = (bin * sr) / fft;

  if (!Number.isFinite(hz) || hz <= 0) {
    return 0.5;
  }

  const fMin = 72;
  const fMax = 4800;

  if (hz <= fMin) {
    return 0;
  }

  if (hz >= fMax) {
    return 1;
  }

  const logSpan = Math.log(fMax) - Math.log(fMin);
  return clamp((Math.log(hz) - Math.log(fMin)) / logSpan, 0, 1);
}

/** 0 = broad / muddy partial, 1 = narrow, prominent peak (clear note). */
function spectralPeakSharpness(bin, data, length) {
  if (bin < 4 || bin >= length - 4) {
    return 0.4;
  }

  const value = data[bin];

  if (value < 18) {
    return 0.28;
  }

  const left = data[bin - 1];
  const right = data[bin + 1];
  const laplacian = (2 * value - left - right) / (value + 12);
  let neighborSum = 0;
  let neighborCount = 0;

  for (let offset = -7; offset <= 7; offset += 1) {
    if (offset === 0) {
      continue;
    }

    neighborSum += data[bin + offset];
    neighborCount += 1;
  }

  const neighborMean = neighborSum / neighborCount;
  const isolation = value / (neighborMean + 5);
  const lapScore = clamp((laplacian - 0.015) / 0.42, 0, 1);
  const isoScore = clamp((isolation - 0.42) / 1.35, 0, 1);
  const combined = clamp(lapScore * 0.38 + isoScore * 0.62, 0, 1);

  return Number.isFinite(combined) ? combined : 0.5;
}

function pushNoteParticle(pitchNorm, strength, sharpness = 0.5) {
  const safePitch = clamp(Number.isFinite(pitchNorm) ? pitchNorm : 0.5, 0, 1);
  const safeStrength = Number.isFinite(strength) ? strength : 70;
  const safeSharp = clamp(Number.isFinite(sharpness) ? sharpness : 0.5, 0, 1);
  const marginX = width * 0.04;
  const marginY = height * 0.06;
  const usableW = Math.max(width - 2 * marginX, 1);
  const usableH = Math.max(height - 2 * marginY, 1);
  const x = marginX + Math.random() * usableW;
  const baseY = marginY + (1 - safePitch) * usableH;
  const y = baseY + (Math.random() - 0.5) * Math.min(height * 0.08, usableH);
  const energy = clamp(safeStrength / 100, 0.25, 1.35);
  const clarity = safeSharp;

  noteParticles.push({
    x,
    y,
    vx: (Math.random() - 0.5) * 0.42,
    vy: -0.12 - Math.random() * 0.22 - safePitch * 0.24,
    radius: randomBetween(5, 16) * (0.75 + energy * 0.45) * (1.02 - clarity * 0.12),
    phase: Math.random() * Math.PI * 2,
    drift: randomBetween(0.018, 0.095),
    sway: randomBetween(0.35, 1.15) * (1.15 - clarity * 0.35),
    life: 0,
    maxLife: Math.max(800, randomBetween(2400, 4400) + energy * 900),
    pitchNorm: safePitch,
    sharpness: clarity,
    shimmer: randomBetween(0.45, 1),
  });

  while (noteParticles.length > NOTE_PARTICLE_CAP) {
    noteParticles.shift();
  }
}

function spawnNoteParticleFromBin(bin, score, sampleRate, fftSize) {
  const pitchNorm = binToPitchNorm(bin, sampleRate, fftSize);
  const sharpness = frequencyData
    ? spectralPeakSharpness(bin, frequencyData, frequencyData.length)
    : 0.5;

  pushNoteParticle(pitchNorm, score, sharpness);
}

function scanAndSpawnNotesFromSpectrum() {
  if (!frequencyData || !analyser || !audioContext) {
    return;
  }

  const sampleRate = audioContext.sampleRate;
  const fftSize = analyser.fftSize;
  const length = frequencyData.length;

  if (!lastSpectrumForFlux || lastSpectrumForFlux.length !== length) {
    lastSpectrumForFlux = new Uint8Array(length);
  }

  if (!spectrumPrimed) {
    lastSpectrumForFlux.set(frequencyData);
    spectrumPrimed = true;
    return;
  }

  const binLo = Math.max(3, Math.floor((88 * fftSize) / sampleRate));
  const binHi = Math.min(length - 3, Math.floor((4400 * fftSize) / sampleRate));
  const candidates = [];

  for (let index = binLo + 1; index <= binHi - 1; index += 1) {
    const value = frequencyData[index];

    if (value <= frequencyData[index - 1] || value <= frequencyData[index + 1]) {
      continue;
    }

    const follower = lastSpectrumForFlux[index];
    const rise = value - follower;

    if (rise < 10 || value < 30) {
      continue;
    }

    candidates.push({ bin: index, score: rise * (value / 255) });
  }

  candidates.sort((a, b) => b.score - a.score);
  const spawnCap = 5;

  for (let index = 0; index < Math.min(spawnCap, candidates.length); index += 1) {
    if (Math.random() > 0.5) {
      continue;
    }

    spawnNoteParticleFromBin(
      candidates[index].bin,
      candidates[index].score,
      sampleRate,
      fftSize
    );
  }

  for (let index = 0; index < length; index += 1) {
    lastSpectrumForFlux[index] = lastSpectrumForFlux[index] * 0.78 + frequencyData[index] * 0.22;
  }
}

function spawnDemoNoteParticles(now) {
  if (now - lastDemoNoteAt < 70 + Math.random() * 110) {
    return;
  }

  lastDemoNoteAt = now;
  const seconds = now * 0.001;
  const melody =
    Math.sin(seconds * 2.65) * 0.42 +
    Math.sin(seconds * 4.1 + 0.9) * 0.28 +
    Math.sin(seconds * 0.85 + 2.4) * 0.14;
  const wander = Math.sin(seconds * 1.12) * 0.1;
  const pitchNorm = clamp(0.12 + melody * 0.38 + wander + (Math.random() - 0.5) * 0.1, 0, 1);
  const strength = 55 + Math.random() * 55;
  const partialsAlign =
    Math.abs(Math.sin(seconds * 3.05)) * 0.38 +
    Math.abs(Math.sin(seconds * 5.2 + 0.4)) * 0.28;
  const sharpness = clamp(0.22 + partialsAlign + Math.random() * 0.2, 0.12, 0.98);

  pushNoteParticle(pitchNorm, strength, sharpness);

  if (Math.random() < 0.4) {
    pushNoteParticle(
      clamp(pitchNorm + (Math.random() - 0.5) * 0.22, 0, 1),
      strength * 0.75,
      clamp(sharpness * 0.72 + Math.random() * 0.12, 0.1, 0.95)
    );
  }
}

function updateNoteParticles(delta, seconds) {
  for (let index = noteParticles.length - 1; index >= 0; index -= 1) {
    const particle = noteParticles[index];

    if (
      !Number.isFinite(particle.x) ||
      !Number.isFinite(particle.y) ||
      !Number.isFinite(particle.vx) ||
      !Number.isFinite(particle.vy) ||
      !Number.isFinite(particle.radius) ||
      !Number.isFinite(particle.maxLife)
    ) {
      noteParticles.splice(index, 1);
    }
  }

  for (const particle of noteParticles) {
    particle.life += delta;
    particle.x +=
      particle.vx + Math.sin(seconds * particle.drift + particle.phase) * 0.48 * particle.sway;
    particle.y +=
      particle.vy + Math.cos(seconds * particle.drift * 0.88 + particle.phase) * 0.26;
    particle.vx *= 0.997;
  }

  for (let index = noteParticles.length - 1; index >= 0; index -= 1) {
    if (noteParticles[index].life >= noteParticles[index].maxLife) {
      noteParticles.splice(index, 1);
    }
  }
}

function drawNoteParticles(now) {
  const seconds = now * 0.001;

  for (const particle of noteParticles) {
    const maxLife = Math.max(1, particle.maxLife || 1);
    const progress = clamp(particle.life / maxLife, 0, 1);
    const fadeIn = clamp(progress * 10, 0, 1);
    const fadeOut = 1 - progress;
    const alpha = fadeIn * fadeOut;

    if (!Number.isFinite(alpha) || alpha < 0.025) {
      continue;
    }

    const clarity = clamp(Number.isFinite(particle.sharpness) ? particle.sharpness : 0.5, 0, 1);
    const soft = 1 - clarity;
    const baseRadius = Number.isFinite(particle.radius) ? particle.radius : 8;
    const radius = Math.max(0.5, baseRadius * (0.9 + (1 - progress) * 0.12));
    const sway = Number.isFinite(particle.sway) ? particle.sway : 1;
    const drift = Number.isFinite(particle.drift) ? particle.drift : 0.05;
    const phase = Number.isFinite(particle.phase) ? particle.phase : 0;
    const x =
      (Number.isFinite(particle.x) ? particle.x : 0) +
      Math.sin(seconds * drift * 1.1 + phase) * 10 * sway;
    const y =
      (Number.isFinite(particle.y) ? particle.y : 0) +
      Math.cos(seconds * drift + phase) * 7 * sway;
    const tint = clamp(Number.isFinite(particle.pitchNorm) ? particle.pitchNorm : 0.5, 0, 1);

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(radius)) {
      continue;
    }

    let innerGlow = radius * (0.05 + soft * 0.1);
    let outerGlow = radius * (1.02 + soft * 0.42);
    innerGlow = Math.max(0.01, innerGlow);
    outerGlow = Math.max(innerGlow + 0.01, outerGlow);

    const midStop = clamp(0.38 + soft * 0.26, 0.05, 0.92);
    const tailStop = clamp(Math.max(midStop + 0.04, 0.78 + soft * 0.18), midStop + 0.02, 0.99);
    const coreAlphaMul = 0.52 + clarity * 0.52;
    const midAlphaMul = 0.55 + clarity * 0.48;
    const shimmer = Number.isFinite(particle.shimmer) ? particle.shimmer : 1;
    const midState = Number.isFinite(state.mid) ? state.mid : 0.2;
    const a0 = clamp((0.2 * shimmer + tint * 0.08) * alpha * coreAlphaMul, 0, 1);
    const a1 = clamp((0.14 + midState * 0.06) * alpha * midAlphaMul, 0, 1);
    const a2 = clamp(0.12 * alpha * soft, 0, 1);

    const body = context.createRadialGradient(
      x - radius * 0.22,
      y - radius * 0.26,
      innerGlow,
      x,
      y,
      outerGlow
    );
    body.addColorStop(0, `rgba(${220 - tint * 30}, ${248 - tint * 12}, 255, ${a0})`);
    body.addColorStop(midStop, `rgba(${118 + tint * 40}, ${195 - tint * 20}, 230, ${a1})`);
    body.addColorStop(tailStop, `rgba(40, 90, 110, ${a2})`);
    body.addColorStop(1, `rgba(4, 18, 28, 0)`);

    context.fillStyle = body;
    context.beginPath();
    context.ellipse(
      x,
      y,
      radius * 0.84,
      radius,
      Math.sin(seconds * 0.18 + phase) * 0.18 * (0.65 + soft * 0.45),
      0,
      Math.PI * 2
    );
    context.fill();

    const strokeAlpha = clamp((0.038 + clarity * 0.095 + tint * 0.04) * alpha, 0, 1);
    context.strokeStyle = `rgba(232, 252, 255, ${strokeAlpha})`;
    context.lineWidth = 0.65 + clarity * 0.55;
    context.stroke();
  }
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

  if (viewMode === "notes") {
    if (demoMode) {
      spawnDemoNoteParticles(now);
    } else if (analyser && frequencyData) {
      scanAndSpawnNotesFromSpectrum();
    }

    updateNoteParticles(delta, now * 0.001);
    drawNoteParticles(now);
  } else {
    drawBloom(now);
    drawWaveRibbon(now);
    drawDroplets(now);
    drawRipples(delta);
  }

  window.requestAnimationFrame(animate);
}

shareAudioButton.addEventListener("click", startDisplayCapture);
micAudioButton.addEventListener("click", startMicrophoneCapture);
demoModeButton.addEventListener("click", startDemoMode);
viewClassicButton.addEventListener("click", () => setViewMode("classic"));
viewNotesButton.addEventListener("click", () => setViewMode("notes"));

fileInput.addEventListener("change", (event) => {
  const [file] = event.target.files;
  startFilePlayback(file);
});

window.addEventListener("resize", () => {
  resizeCanvas();

  if (viewMode === "classic") {
    seedDroplets();
  }
});

resizeCanvas();
seedDroplets();
startDemoMode();
window.requestAnimationFrame(animate);
