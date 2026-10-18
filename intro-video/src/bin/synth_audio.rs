//! Synthesizes the intro's soundtrack into `media/`: the score, written around the moments in
//! `aerotwin_intro::score_cues`, and the short effects the shots place. Everything is generated
//! here from oscillators and noise, so there is nothing to license.
//!
//! Run it after the timeline changes, then rebuild so the media embed picks the files up:
//! `cargo run --release --bin synth_audio`.
use aerotwin_intro::{ScoreCues, score_cues};
use std::f32::consts::{PI, TAU};

const SR: f32 = 48_000.0;
const BEAT: f32 = 0.6; // 100 BPM
const BAR: f32 = 4.0 * BEAT;

// ---------------------------------------------------------------- buffers and output

struct Stereo {
    l: Vec<f32>,
    r: Vec<f32>,
}

impl Stereo {
    fn new(seconds: f32) -> Self {
        let n = (seconds * SR) as usize;
        Self { l: vec![0.0; n], r: vec![0.0; n] }
    }

    fn len(&self) -> usize {
        self.l.len()
    }

    /// Add a mono sample at `i`, placed by `pan` (-1 left .. 1 right) with equal power.
    fn add(&mut self, i: usize, x: f32, pan: f32) {
        if i < self.len() {
            let a = (pan.clamp(-1.0, 1.0) + 1.0) * PI / 4.0;
            self.l[i] += x * a.cos();
            self.r[i] += x * a.sin();
        }
    }

    fn mix(&mut self, other: &Stereo, gain: f32) {
        for i in 0..self.len().min(other.len()) {
            self.l[i] += other.l[i] * gain;
            self.r[i] += other.r[i] * gain;
        }
    }

    /// Scale so the loudest sample sits at `peak`.
    fn normalize(&mut self, peak: f32) {
        let max = self.l.iter().chain(&self.r).fold(0.0f32, |m, x| m.max(x.abs()));
        if max > 0.0 {
            let k = peak / max;
            self.l.iter_mut().chain(self.r.iter_mut()).for_each(|x| *x *= k);
        }
    }

    fn write(&self, path: &str) {
        let n = self.len() as u32;
        let mut out = Vec::with_capacity(44 + n as usize * 4);
        let data = n * 4;
        for chunk in [b"RIFF".as_slice(), &(36 + data).to_le_bytes(), b"WAVEfmt ", &16u32.to_le_bytes(), &1u16.to_le_bytes(), &2u16.to_le_bytes(), &(SR as u32).to_le_bytes(), &(SR as u32 * 4).to_le_bytes(), &4u16.to_le_bytes(), &16u16.to_le_bytes(), b"data", &data.to_le_bytes()] {
            out.extend_from_slice(chunk);
        }
        for i in 0..self.len() {
            for x in [self.l[i], self.r[i]] {
                out.extend_from_slice(&((x.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
            }
        }
        std::fs::write(path, out).expect("write wav");
        println!("wrote {path} ({:.2} s)", self.len() as f32 / SR);
    }
}

// ---------------------------------------------------------------- building blocks

/// Deterministic noise, so every run writes the same files.
struct Noise(u32);

impl Noise {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        self.0 as f32 / u32::MAX as f32 * 2.0 - 1.0
    }
}

fn hz(midi: f32) -> f32 {
    440.0 * 2f32.powf((midi - 69.0) / 12.0)
}

/// Band-limited sawtooth (polyBLEP) at phase 0..1 advancing by `dt` per sample.
fn saw(phase: f32, dt: f32) -> f32 {
    let mut y = 2.0 * phase - 1.0;
    if phase < dt {
        let t = phase / dt;
        y -= t + t - t * t - 1.0;
    } else if phase > 1.0 - dt {
        let t = (phase - 1.0) / dt;
        y -= t * t + t + t + 1.0;
    }
    y
}

/// State-variable filter (topology-preserving), giving low, band and high pass at once.
#[derive(Default)]
struct Svf {
    ic1: f32,
    ic2: f32,
}

impl Svf {
    fn run(&mut self, x: f32, cutoff: f32, q: f32) -> (f32, f32, f32) {
        let g = (PI * cutoff.clamp(20.0, SR * 0.45) / SR).tan();
        let k = 1.0 / q;
        let a1 = 1.0 / (1.0 + g * (g + k));
        let v3 = x - self.ic2;
        let v1 = a1 * self.ic1 + g * a1 * v3;
        let v2 = self.ic2 + g * v1;
        self.ic1 = 2.0 * v1 - self.ic1;
        self.ic2 = 2.0 * v2 - self.ic2;
        (v2, v1, x - k * v1 - v2)
    }
}

/// Linear attack, then hold, then a linear release, over a note of `length` seconds.
fn envelope(t: f32, attack: f32, length: f32, release: f32) -> f32 {
    if t < 0.0 || t > length + release {
        0.0
    } else if t < attack {
        t / attack
    } else if t < length {
        1.0
    } else {
        1.0 - (t - length) / release
    }
}

/// A short fade at both ends so no sound starts or stops on a click.
fn edges(t: f32, length: f32) -> f32 {
    (t / 0.004).min((length - t) / 0.004).clamp(0.0, 1.0)
}

/// Freeverb-style room: parallel damped combs into series allpasses, tuned apart per side.
fn reverb(input: &Stereo, size: f32) -> Stereo {
    let mut out = Stereo { l: vec![0.0; input.len()], r: vec![0.0; input.len()] };
    for (side, spread) in [(0usize, 0usize), (1, 23)] {
        let source = if side == 0 { &input.l } else { &input.r };
        let mut wet = vec![0.0f32; source.len()];
        for comb in [1557usize, 1617, 1491, 1422, 1277, 1356, 1188, 1116] {
            let n = (comb + spread) * 48 / 44;
            let mut line = vec![0.0f32; n];
            let (mut at, mut low) = (0usize, 0.0f32);
            for (i, x) in source.iter().enumerate() {
                let y = line[at];
                low = y * 0.8 + low * 0.2;
                line[at] = x * 0.015 + low * size;
                wet[i] += y;
                at = (at + 1) % n;
            }
        }
        for pass in [556usize, 441, 341, 225] {
            let n = (pass + spread) * 48 / 44;
            let mut line = vec![0.0f32; n];
            let mut at = 0usize;
            for x in wet.iter_mut() {
                let b = line[at];
                line[at] = *x + b * 0.5;
                *x = b - *x;
                at = (at + 1) % n;
            }
        }
        if side == 0 { out.l = wet } else { out.r = wet }
    }
    out
}

/// Ping-pong echo: each repeat swaps sides and loses `feedback`.
fn echo(input: &Stereo, delay: f32, feedback: f32) -> Stereo {
    let d = (delay * SR) as usize;
    let mut out = Stereo { l: vec![0.0; input.len()], r: vec![0.0; input.len()] };
    for i in d..input.len() {
        out.l[i] = input.r[i - d] + out.r[i - d] * feedback;
        out.r[i] = input.l[i - d] + out.l[i - d] * feedback;
    }
    out
}

// ---------------------------------------------------------------- instruments

/// A held chord of detuned saws through a low-pass, `cutoff` following the song time.
fn pad(out: &mut Stereo, start: f32, length: f32, notes: &[f32], gain: f32, cutoff: impl Fn(f32) -> f32) {
    let (attack, release) = (0.5, 1.2);
    let mut filter = [Svf::default(), Svf::default()];
    let voices: Vec<(f32, f32)> = notes
        .iter()
        .flat_map(|&m| [(-0.08, -0.6), (0.08, 0.6)].map(|(detune, pan)| (hz(m + detune), pan)))
        .collect();
    let mut phases: Vec<f32> = voices.iter().enumerate().map(|(i, _)| i as f32 * 0.37 % 1.0).collect();
    let first = (start * SR) as usize;
    for n in 0..((length + release) * SR) as usize {
        let t = n as f32 / SR;
        let env = envelope(t, attack, length, release) * gain;
        let (mut l, mut r) = (0.0, 0.0);
        for (k, &(f, pan)) in voices.iter().enumerate() {
            let dt = f / SR;
            let x = saw(phases[k], dt);
            phases[k] = (phases[k] + dt) % 1.0;
            if pan < 0.0 { l += x } else { r += x }
        }
        let c = cutoff(start + t);
        let (yl, _, _) = filter[0].run(l, c, 0.7);
        let (yr, _, _) = filter[1].run(r, c, 0.7);
        let i = first + n;
        if i < out.len() {
            out.l[i] += yl * env;
            out.r[i] += yr * env;
        }
    }
}

fn kick(out: &mut Stereo, at: f32, gain: f32) {
    let first = (at * SR) as usize;
    let mut phase = 0.0;
    for n in 0..(0.45 * SR) as usize {
        let t = n as f32 / SR;
        let f = 44.0 + 120.0 * (-t * 32.0).exp();
        phase += f / SR;
        let x = (phase * TAU).sin() * (-t * 7.5).exp() * edges(t, 0.45);
        out.add(first + n, x * gain, 0.0);
    }
}

fn hat(out: &mut Stereo, noise: &mut Noise, at: f32, gain: f32, open: bool) {
    let first = (at * SR) as usize;
    let (length, decay) = if open { (0.3, 12.0) } else { (0.08, 55.0) };
    let mut filter = Svf::default();
    for n in 0..(length * SR) as usize {
        let t = n as f32 / SR;
        let (_, _, high) = filter.run(noise.next(), 7500.0, 0.8);
        out.add(first + n, high * (-t * decay).exp() * edges(t, length) * gain, 0.25);
    }
}

fn clap(out: &mut Stereo, noise: &mut Noise, at: f32, gain: f32) {
    let first = (at * SR) as usize;
    let mut filter = Svf::default();
    for n in 0..(0.3 * SR) as usize {
        let t = n as f32 / SR;
        // Three quick slaps, then the tail.
        let burst = [0.0, 0.011, 0.022].iter().map(|&s| if t >= s { (-(t - s) * 90.0).exp() } else { 0.0 }).sum::<f32>() + (-t * 14.0).exp() * 0.4;
        let (_, band, _) = filter.run(noise.next(), 1400.0, 1.2);
        out.add(first + n, band * burst * edges(t, 0.3) * gain, -0.1);
    }
}

/// A plucked synth note: saw through a low-pass that closes as the note dies.
fn pluck(out: &mut Stereo, at: f32, midi: f32, length: f32, bright: f32, gain: f32, pan: f32) {
    let first = (at * SR) as usize;
    let f = hz(midi);
    let (mut phase, mut filter) = (0.0, Svf::default());
    for n in 0..(length * SR) as usize {
        let t = n as f32 / SR;
        let dt = f / SR;
        let x = saw(phase, dt);
        phase = (phase + dt) % 1.0;
        let (low, _, _) = filter.run(x, 200.0 + bright * (-t * 9.0).exp(), 1.1);
        out.add(first + n, low * (-t * 4.0 / length).exp() * edges(t, length) * gain, pan);
    }
}

/// The drop into the reveal: noise and a saw climbing together, cut just before `end`.
fn riser(out: &mut Stereo, noise: &mut Noise, end: f32, length: f32, gain: f32) {
    let first = ((end - length) * SR) as usize;
    let (mut filter, mut phase) = (Svf::default(), 0.0);
    for n in 0..(length * SR) as usize {
        let t = n as f32 / SR;
        let u = t / length;
        let (_, band, _) = filter.run(noise.next(), 300.0 * 20f32.powf(u), 2.0);
        let f = hz(50.0 + 12.0 * u * u);
        phase = (phase + f / SR) % 1.0;
        let tone = saw(phase, f / SR) * 0.25;
        let x = (band + tone) * u.powf(2.2) * edges(t, length);
        out.add(first + n, x * gain, (u * 9.0).sin() * 0.4);
    }
}

/// A deep hit: a falling sub plus a burst of filtered noise.
fn impact(out: &mut Stereo, noise: &mut Noise, at: f32, gain: f32) {
    let first = (at * SR) as usize;
    let (mut phase, mut filter) = (0.0, Svf::default());
    let length = 2.4;
    for n in 0..(length * SR) as usize {
        let t = n as f32 / SR;
        phase += (32.0 + 50.0 * (-t * 4.0).exp()) / SR;
        let sub = (phase * TAU).sin() * (-t * 1.8).exp();
        let (low, _, _) = filter.run(noise.next(), 1800.0 * (-t * 3.0).exp() + 200.0, 0.7);
        let x = (sub + low * 0.6 * (-t * 6.0).exp()) * edges(t, length);
        out.add(first + n, x * gain, 0.0);
    }
}

// ---------------------------------------------------------------- the score

const DM: [f32; 4] = [50.0, 53.0, 57.0, 62.0];
const BB: [f32; 4] = [50.0, 53.0, 58.0, 62.0];
const F: [f32; 4] = [48.0, 53.0, 57.0, 60.0];
const C: [f32; 4] = [48.0, 52.0, 55.0, 60.0];
const D_MAJOR: [f32; 4] = [50.0, 54.0, 57.0, 62.0];
/// Bass root under each chord, in the same order.
const ROOTS: [f32; 4] = [38.0, 34.0, 41.0, 36.0];
const PROGRESSION: [[f32; 4]; 4] = [DM, BB, F, C];

fn score(c: &ScoreCues) -> Stereo {
    let mut dry = Stereo::new(c.end + 0.5);
    let mut send = Stereo::new(c.end + 0.5); // to the reverb
    let mut arp = Stereo::new(c.end + 0.5); // to the echo, then the reverb
    let mut noise = Noise(0x2545_F491);
    // The beat grid is anchored on the reveal so the drop lands on a downbeat.
    let bar_at = |n: i32| c.reveal + n as f32 * BAR;
    let first_bar = -(c.reveal / BAR).ceil() as i32;
    let gap = 0.12; // silence before the drop

    // The problem: a low drone and a dark, filtered Dm-Bb pad that slowly opens.
    let drone_end = c.reveal - gap;
    {
        let (mut phase, mut sub, mut filter) = (0.0, 0.0, Svf::default());
        for n in 0..(drone_end * SR) as usize {
            let t = n as f32 / SR;
            let f = hz(26.0);
            phase = (phase + f / SR) % 1.0;
            sub = (sub + f / SR) % 1.0;
            let open = 160.0 + 500.0 * (t / drone_end).powi(2);
            let (low, _, _) = filter.run(saw(phase, f / SR), open, 0.9);
            let fade = (t / 3.0).min(1.0) * ((drone_end - t) / 0.08).clamp(0.0, 1.0);
            dry.add(n, (low * 0.5 + (sub * TAU).sin() * 0.5) * fade * 0.32, 0.0);
        }
    }
    for n in first_bar.max(-64)..0 {
        let start = bar_at(n).max(0.0);
        let chord = if (n.rem_euclid(4)) < 2 { DM } else { BB };
        let length = (bar_at(n + 1) - start).min(drone_end - start);
        if length > 0.0 {
            pad(&mut send, start, length, &chord, 0.06, |t| 380.0 + 1400.0 * (t / c.swap).clamp(0.0, 1.0).powi(2));
        }
    }
    // The clock running: a soft heartbeat from the slow solve until the swap.
    let beats_from = |from: f32, to: f32| {
        let k0 = ((from - c.reveal) / BEAT).ceil() as i32;
        let k1 = ((to - c.reveal) / BEAT).ceil() as i32;
        (k0..k1).map(|k| (k, c.reveal + k as f32 * BEAT)).collect::<Vec<_>>()
    };
    for (k, at) in beats_from(c.problem, c.swap + 2.0) {
        if k.rem_euclid(2) == 0 {
            kick(&mut dry, at, 0.32);
        }
        hat(&mut dry, &mut noise, at + BEAT / 2.0, 0.05, false);
    }
    riser(&mut send, &mut noise, c.reveal - gap, 4.2, 0.9);
    riser(&mut dry, &mut noise, c.reveal - gap, 4.2, 0.18);

    // The reveal: a hit, then the progression with the groove building in layers.
    impact(&mut dry, &mut noise, c.reveal, 0.5);
    impact(&mut send, &mut noise, c.reveal, 0.3);
    let grooving = |at: f32, from: f32| at >= from && at < c.outro - 0.05;
    let last_bar = ((c.outro - c.reveal) / BAR).ceil() as i32;
    for n in 0..last_bar {
        let start = bar_at(n);
        let length = (bar_at(n + 1).min(c.outro) - start).max(0.0);
        let chord = PROGRESSION[n as usize % 4];
        let root = ROOTS[n as usize % 4];
        let bright = if start >= c.results { 3600.0 } else if start >= c.platform { 2600.0 } else { 1800.0 };
        pad(&mut send, start, length, &chord, 0.055, move |_| bright);
        pad(&mut dry, start, length, &chord, 0.035, move |_| bright * 0.7);
        for step in 0..8 {
            let at = start + step as f32 * BEAT / 2.0;
            if at >= c.outro {
                break;
            }
            // Bass: driving eighths once the model shot starts, long notes before.
            if at >= c.model {
                let midi = root + if step % 4 == 3 { 12.0 } else { 0.0 };
                pluck(&mut dry, at, midi, 0.28, 700.0, 0.32, 0.0);
            } else if step == 0 {
                pluck(&mut dry, at, root, BAR * 0.9, 380.0, 0.36, 0.0);
            }
            if grooving(at, c.model) && step % 2 == 0 {
                kick(&mut dry, at, 0.62);
            }
            if grooving(at, c.model + BAR) && step % 2 == 1 {
                hat(&mut dry, &mut noise, at, 0.075, step == 7);
            }
            if grooving(at, c.results) && (step == 2 || step == 6) {
                clap(&mut dry, &mut noise, at, 0.2);
                clap(&mut send, &mut noise, at, 0.12);
            }
        }
        // The arpeggio: sixteenths over the chord, from the platform shots on.
        for step in 0..16 {
            let at = start + step as f32 * BEAT / 4.0;
            if grooving(at, c.platform) {
                let tone = chord[[0, 1, 2, 3, 2, 1, 3, 2][step % 8]] + 12.0;
                let accent = if step % 4 == 0 { 1.0 } else { 0.7 };
                pluck(&mut arp, at, tone, 0.22, 2400.0, 0.07 * accent, if step % 2 == 0 { -0.35 } else { 0.35 });
            }
        }
    }

    // The outro: drums out, a soft hit, and the chords lift to D major and ring out.
    impact(&mut send, &mut noise, c.outro, 0.35);
    let resolve = [(BB, 0.0, BAR), (C, BAR, BAR)];
    for (chord, offset, length) in resolve {
        pad(&mut send, c.outro + offset, length, &chord, 0.06, |_| 2200.0);
        pad(&mut dry, c.outro + offset, length, &chord, 0.03, |_| 1600.0);
    }
    let hold = (c.end - (c.outro + 2.0 * BAR) - 1.4).max(1.0);
    pad(&mut send, c.outro + 2.0 * BAR, hold, &D_MAJOR, 0.07, |_| 2000.0);
    pad(&mut dry, c.outro + 2.0 * BAR, hold, &D_MAJOR, 0.035, |_| 1500.0);
    pluck(&mut dry, c.outro + 2.0 * BAR, 38.0, 3.0, 300.0, 0.35, 0.0);

    let echoes = echo(&arp, 3.0 * BEAT / 4.0, 0.35);
    dry.mix(&arp, 1.0);
    dry.mix(&echoes, 0.45);
    send.mix(&arp, 0.6);
    let room = reverb(&send, 0.86);
    dry.mix(&send, 0.55);
    dry.mix(&room, 0.9);
    // Fade in from silence and out to silence at the very end.
    for i in 0..dry.len() {
        let t = i as f32 / SR;
        let fade = (t / 1.5).min((c.end - t) / 2.5).clamp(0.0, 1.0);
        dry.l[i] = (dry.l[i] * fade).tanh();
        dry.r[i] = (dry.r[i] * fade).tanh();
    }
    dry.normalize(0.7);
    dry
}

// ---------------------------------------------------------------- effects

/// Render a one-shot effect of `length` seconds from a per-sample function, with reverb.
fn effect(length: f32, room: f32, mut voice: impl FnMut(f32) -> (f32, f32)) -> Stereo {
    let mut out = Stereo::new(length);
    for n in 0..out.len() {
        let t = n as f32 / SR;
        let (x, pan) = voice(t);
        out.add(n, x * edges(t, length), pan);
    }
    if room > 0.0 {
        let wet = reverb(&out, 0.8);
        out.mix(&wet, room);
    }
    out
}

fn effects() -> Vec<(&'static str, Stereo)> {
    let mut noise = Noise(0x9E37_79B9);
    let mut filter = Svf::default();
    let whoosh = effect(1.0, 0.25, |t| {
        let u = t / 1.0;
        let centre = 300.0 * (1.0 - u) + 2600.0 * (PI * u).sin() + 600.0 * u;
        let (_, band, _) = filter.run(noise.next(), centre, 1.4);
        (band * (PI * u).sin().powf(1.5) * 1.6, -0.6 + 1.2 * u)
    });
    let mut noise = Noise(0x1234_5678);
    let mut filter = Svf::default();
    let click = effect(0.12, 0.1, |t| {
        let (_, _, high) = filter.run(noise.next(), 2000.0, 0.7);
        let down = (-t * 900.0).exp() * high + (TAU * 2600.0 * t).sin() * (-t * 160.0).exp() * 0.5;
        let up = if t > 0.045 { let s = t - 0.045; (TAU * 3100.0 * s).sin() * (-s * 200.0).exp() * 0.25 } else { 0.0 };
        (down + up, 0.0)
    });
    let tick = effect(0.06, 0.0, |t| (((TAU * 1800.0 * t).sin() + (TAU * 3600.0 * t).sin() * 0.3) * (-t * 90.0).exp() * 0.6, 0.0));
    let pop = effect(0.35, 0.2, |t| {
        let f = 620.0 + 520.0 * (t / 0.04).min(1.0);
        ((TAU * f * t).sin() * (t / 0.003).min(1.0) * (-t * 22.0).exp() * 0.7, 0.0)
    });
    let chime = effect(2.2, 0.35, |t| {
        let bell = |at: f32, f: f32| {
            let s = t - at;
            if s < 0.0 { return 0.0 }
            let index = 2.2 * (-s * 3.0).exp();
            (TAU * f * s + index * (TAU * f * 3.5 * s).sin()).sin() * (-s * 2.4).exp() * (s / 0.004).min(1.0)
        };
        ((bell(0.0, 880.0) + bell(0.12, 1318.5)) * 0.4, 0.15)
    });
    let shimmer = effect(1.8, 0.45, |t| {
        let notes = [86.0, 88.0, 90.0, 93.0, 95.0, 98.0, 100.0, 102.0];
        let mut x = 0.0;
        for (k, m) in notes.iter().enumerate() {
            let s = t - k as f32 * 0.07;
            if s > 0.0 {
                x += (TAU * hz(*m) * s).sin() * (-s * 5.0).exp() * (s / 0.003).min(1.0);
            }
        }
        (x * 0.18, (t * 12.0).sin() * 0.5)
    });
    let mut noise = Noise(0xDEAD_BEEF);
    let mut filter = Svf::default();
    let scan_length = 4.4;
    let scan = effect(scan_length, 0.3, |t| {
        let u = t / scan_length;
        let f = 220.0 * 3f32.powf(u);
        let tone = (TAU * f * t).sin() * (0.7 + 0.3 * (TAU * 6.0 * t).sin());
        let (_, band, _) = filter.run(noise.next(), f * 4.0, 3.0);
        let fade = (t / 0.4).min((scan_length - t) / 0.6).clamp(0.0, 1.0);
        ((tone * 0.25 + band * 0.6) * fade, -0.8 + 1.6 * u)
    });
    // Keystrokes at a natural, uneven pace: a bright tap over a low thock.
    let mut typing = Stereo::new(6.0);
    let mut noise = Noise(0x0BAD_F00D);
    let mut at = 0.02;
    while at < 5.9 {
        let first = (at * SR) as usize;
        let tone = 2200.0 + 1800.0 * (noise.next() * 0.5 + 0.5);
        let mut filter = Svf::default();
        let pan = noise.next() * 0.3;
        for n in 0..(0.04 * SR) as usize {
            let t = n as f32 / SR;
            let (_, band, _) = filter.run(noise.next(), tone, 1.5);
            let x = band * (-t * 140.0).exp() + (TAU * 180.0 * t).sin() * (-t * 90.0).exp() * 0.5;
            typing.add(first + n, x * edges(t, 0.04) * 0.6, pan);
        }
        at += 0.065 + 0.05 * (noise.next() * 0.5 + 0.5);
    }
    vec![
        ("sfx-whoosh.wav", whoosh),
        ("sfx-click.wav", click),
        ("sfx-tick.wav", tick),
        ("sfx-pop.wav", pop),
        ("sfx-chime.wav", chime),
        ("sfx-shimmer.wav", shimmer),
        ("sfx-scan.wav", scan),
        ("sfx-typing.wav", typing),
    ]
}

fn main() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/media");
    score(&score_cues()).write(&format!("{dir}/score.wav"));
    for (name, mut sound) in effects() {
        sound.normalize(0.8);
        sound.write(&format!("{dir}/{name}"));
    }
}
