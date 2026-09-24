/**
 * Scan feedback that works in a loud shop: distinct WebAudio tones plus vibration.
 * OK is a short rising double chirp; error is a long, low, pulsing buzz nobody mistakes for OK.
 */
type Tone = { freq: number; start: number; dur: number; type: OscillatorType; gain: number };

const TONES: Record<"ok" | "error" | "warn" | "tick", Tone[]> = {
  ok: [
    { freq: 1046, start: 0, dur: 0.09, type: "square", gain: 0.25 },
    { freq: 1568, start: 0.11, dur: 0.14, type: "square", gain: 0.25 },
  ],
  error: [
    { freq: 196, start: 0, dur: 0.22, type: "sawtooth", gain: 0.4 },
    { freq: 196, start: 0.3, dur: 0.22, type: "sawtooth", gain: 0.4 },
    { freq: 147, start: 0.6, dur: 0.45, type: "sawtooth", gain: 0.4 },
  ],
  warn: [
    { freq: 660, start: 0, dur: 0.15, type: "triangle", gain: 0.3 },
    { freq: 660, start: 0.22, dur: 0.15, type: "triangle", gain: 0.3 },
  ],
  tick: [{ freq: 1200, start: 0, dur: 0.04, type: "square", gain: 0.15 }],
};

const VIBRATION: Record<keyof typeof TONES, number[]> = {
  ok: [80],
  error: [250, 100, 250, 100, 400],
  warn: [120, 80, 120],
  tick: [],
};

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined" || !("AudioContext" in window)) return null;
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/** Browsers start audio suspended until a user gesture; scanner keystrokes count. */
export function unlockAudioOnGesture() {
  const unlock = () => {
    audio();
    window.removeEventListener("pointerdown", unlock, true);
    window.removeEventListener("keydown", unlock, true);
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
}

export function feedback(kind: keyof typeof TONES) {
  const ac = audio();
  if (ac) {
    const t0 = ac.currentTime + 0.01;
    for (const tone of TONES[kind]) {
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.type = tone.type;
      osc.frequency.value = tone.freq;
      g.gain.setValueAtTime(tone.gain, t0 + tone.start);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + tone.start + tone.dur);
      osc.connect(g).connect(ac.destination);
      osc.start(t0 + tone.start);
      osc.stop(t0 + tone.start + tone.dur + 0.02);
    }
  }
  const pattern = VIBRATION[kind];
  if (pattern.length && typeof navigator !== "undefined" && "vibrate" in navigator) {
    navigator.vibrate(pattern);
  }
}
