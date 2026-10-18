//! AeroTwin introduction: a product-launch style explainer of the problem (invisible, slow-to-check
//! indoor airflow) and the solution (a neural surrogate of CFD behind a 3D browser digital twin).
//!
//! Every scene is one `Shot` whose `Kind` picks the drawing. Scenes cross-fade over `XFADE`
//! seconds; content inside a scene starts after that window. Three shots host components from
//! `fframes-components`; the rest are drawn here. Rooms, air paths, readings and scores are
//! illustrations, not model output.
use fframes::{
    AnimateRuntimeInput, AudioMap, AudioTimestamp, AudioTrack, Color, Duration, FFramesContext,
    FontQuery, Frame, Overlap, Scene, Scenes, Svgr, Transform, Video,
    animation::{AnimationRuntime, Easing},
    include_media_dir,
};
use fframes_components::components::showcase::check_cycle::{CheckCycle, CheckCycleConfig, ROLL_AT, ROLL_EVERY};
use fframes_components::components::showcase::prompt_zoom::{PromptZoom, PromptZoomConfig};
use fframes_components::components::showcase::text_swap::{TextSwap, TextSwapConfig};
use fframes_components::ui::{Mode, UiTheme};
use fframes_components::{Component, ComponentFrame, Fonts, RenderCtx, TextMeter, TextMeters};
use std::sync::LazyLock;

include_media_dir!(pub struct AeroTwinIntroMedia, "media");

pub const WIDTH: usize = 1920;
pub const HEIGHT: usize = 1080;
const FPS: f32 = 30.0;
const XFADE: f32 = 0.45;

const BG: &str = "#060708";
const SURFACE: &str = "#0c0e11";
const RAISED: &str = "#14171c";
const BORDER: &str = "#22262d";
const TEXT: &str = "#ededef";
const GRAY: &str = "#7d838e";
const DIM: &str = "#4a4f58";
const CYAN: &str = "#22d3ee";
const GOOD: &str = "#34d399";
const COOL: &str = "#38bdf8";
const STILL: &str = "#64748b";

const SANS: &str = "Inter";
const MONO: &str = "IBM Plex Mono";

// The illustrated room, top-down plan coordinates.
const RX: f32 = 460.0;
const RY: f32 = 400.0;
const RW: f32 = 1000.0;
const RH: f32 = 520.0;
const VENT: (f32, f32) = (640.0, 540.0);
const DESKS: [(f32, f32, f32, f32); 4] =
    [(700.0, 660.0, 170.0, 90.0), (960.0, 480.0, 200.0, 90.0), (1220.0, 780.0, 200.0, 90.0), (960.0, 760.0, 170.0, 90.0)];

// The plan drawn isometrically inside the app canvas.
const ISO_X: f32 = 683.0;
const ISO_Y: f32 = 473.0;
const ISO_K: f32 = 0.55;
const ISO: &str = "translate(683 473) matrix(0.55 0.275 -0.55 0.275 0 0) translate(-460 -400)";
/// Camera pivot: the centre of the app canvas.
const PIVOT: (f32, f32) = (815.0, 642.0);

/// The room orbits about the centre of its plan.
const CENTRE: (f32, f32) = (RX + RW / 2.0, RY + RH / 2.0);
/// Ceiling height in screen pixels; the vent sits up there.
const CEILING: f32 = 96.0;

fn iso(x: f32, y: f32) -> (f32, f32) {
    (ISO_X + ISO_K * (x - RX) - ISO_K * (y - RY), ISO_Y + ISO_K / 2.0 * (x - RX) + ISO_K / 2.0 * (y - RY))
}

/// A plan point at height `z`, with the room turned `orbit` degrees, on screen.
fn project(x: f32, y: f32, z: f32, orbit: f32) -> (f32, f32) {
    let (s, c) = orbit.to_radians().sin_cos();
    let (dx, dy) = (x - CENTRE.0, y - CENTRE.1);
    let (sx, sy) = iso(CENTRE.0 + dx * c - dy * s, CENTRE.1 + dx * s + dy * c);
    (sx, sy - z)
}

/// The transform that draws flat plan shapes at height `z`, matching `project`.
fn plane(z: f32, orbit: f32) -> String {
    format!("translate(0 {}) {ISO} rotate({orbit} {} {})", -z, CENTRE.0, CENTRE.1)
}

static EASE: LazyLock<AnimationRuntime> =
    LazyLock::new(|| AnimationRuntime::new(0.9, &Easing::CubicBezier(0.16, 1.0, 0.3, 1.0)));
static QUICK: LazyLock<AnimationRuntime> =
    LazyLock::new(|| AnimationRuntime::new(0.3, &Easing::CubicBezier(0.16, 1.0, 0.3, 1.0)));
static MOVE: LazyLock<AnimationRuntime> =
    LazyLock::new(|| AnimationRuntime::new(1.0, &Easing::CubicBezier(0.65, 0.0, 0.35, 1.0)));
static SLOW: LazyLock<AnimationRuntime> =
    LazyLock::new(|| AnimationRuntime::new(2.6, &Easing::CubicBezier(0.65, 0.0, 0.35, 1.0)));
static ORBIT: LazyLock<AnimationRuntime> =
    LazyLock::new(|| AnimationRuntime::new(7.0, &Easing::CubicBezier(0.45, 0.0, 0.25, 1.0)));
static GROW: LazyLock<AnimationRuntime> =
    LazyLock::new(|| AnimationRuntime::new(1.8, &Easing::CubicBezier(0.3, 0.0, 0.2, 1.0)));
static SWEEP: LazyLock<AnimationRuntime> =
    LazyLock::new(|| AnimationRuntime::new(4.4, &Easing::CubicBezier(0.45, 0.0, 0.55, 1.0)));
static SPRING: LazyLock<AnimationRuntime> = LazyLock::new(|| {
    AnimationRuntime::new(3.0, &Easing::Spring { mass: 1.0, stiffness: 170.0, damping: 22.0 })
});

#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    Open,
    Complaints,
    Invisible,
    Slow,
    Swap,
    Introducing,
    Model,
    Workflow,
    Product,
    Probe,
    Comfort,
    Compare,
    Ask,
    Answer,
    Numbers,
    Uses,
    Outro,
}

const SHOTS: [(Kind, f32); 17] = [
    (Kind::Open, 4.0),
    (Kind::Complaints, 5.5),
    (Kind::Invisible, 6.0),
    (Kind::Slow, 9.0),
    (Kind::Swap, 4.0),
    (Kind::Introducing, 4.5),
    (Kind::Model, 7.5),
    (Kind::Workflow, 12.5),
    (Kind::Product, 8.5),
    (Kind::Probe, 7.5),
    (Kind::Comfort, 6.5),
    (Kind::Compare, 8.0),
    (Kind::Ask, 4.5),
    (Kind::Answer, 6.5),
    (Kind::Numbers, 7.5),
    (Kind::Uses, 6.0),
    (Kind::Outro, 7.0),
];

/// The chapter a shot belongs to, shown top left; `None` for the brand moments.
fn chapter(kind: Kind) -> Option<(&'static str, &'static str)> {
    match kind {
        Kind::Open | Kind::Complaints | Kind::Invisible | Kind::Slow => Some(("01", "THE PROBLEM")),
        Kind::Model => Some(("02", "THE MODEL")),
        Kind::Workflow => Some(("03", "THE WORKFLOW")),
        Kind::Product | Kind::Probe | Kind::Comfort | Kind::Compare | Kind::Ask | Kind::Answer => Some(("04", "THE PLATFORM")),
        Kind::Numbers | Kind::Uses => Some(("05", "THE RESULTS")),
        Kind::Swap | Kind::Introducing | Kind::Outro => None,
    }
}

/// Moments inside shots that both the drawing and the sound effects key on, in seconds after the
/// shot's content starts.
mod at {
    /// Complaints: each message card arrives.
    pub const MESSAGES: [f32; 2] = [0.7, 1.6];
    /// Invisible: the scanner starts its sweep.
    pub const SCAN: f32 = 0.6;
    /// Slow: the solve clock starts.
    pub const CLOCK: f32 = 0.9;
    /// Swap: the old line rushes out.
    pub const SWAP: f32 = 1.1;
    /// Introducing: the name rises.
    pub const NAME: f32 = 0.3;
    /// Model: each card arrives.
    pub const CARDS: [f32; 3] = [0.8, 1.3, 1.8];
    /// Workflow: the floor plan starts drawing; the pointer sets off, drops the supply diffuser,
    /// then the return grille, and starts the optimizer, which moves the diffuser on to each next
    /// candidate; then the best is picked.
    pub const BUILD: f32 = 0.8;
    pub const POINTER: f32 = 2.6;
    pub const SUPPLY: f32 = 3.65;
    pub const GRILLE: f32 = 4.85;
    pub const OPTIMIZE: f32 = 6.05;
    pub const HOPS: [f32; 4] = [6.5, 7.05, 7.6, 8.15];
    pub const PICK: f32 = 8.7;
    /// Product: the pointer switches the air paths on.
    pub const CLICK: f32 = 3.0;
    /// Probe: the reading appears, then the probe leaves for the vent.
    pub const READING: f32 = 1.4;
    pub const LEAVE: f32 = 3.4;
    /// Comfort: the map is switched on, then spreads.
    pub const COMFORT: f32 = 0.4;
    pub const SPREAD: f32 = 0.6;
    /// Compare: the layouts arrive, are scored, sorted, and the best is called.
    pub const LAYOUTS: f32 = 0.5;
    pub const SORT: f32 = 4.0;
    pub const BEST: f32 = 4.8;
    /// Ask: the question starts typing.
    pub const QUESTION: f32 = 0.5;
    /// Answer: the question shows, the reply streams at `WORDS_PER_SECOND`, the report arrives.
    pub const ASKED: f32 = 0.3;
    pub const REPLY: f32 = 1.0;
    pub const WORDS_PER_SECOND: f32 = 9.0;
    pub const REPORT: f32 = 3.0;
    /// Numbers: the race clock starts, sped up `RACE_SPEEDUP` times; the two figures arrive.
    pub const RACE: f32 = 1.0;
    pub const RACE_SPEEDUP: f32 = 30.0;
    pub const FIGURES: [f32; 2] = [2.4, 2.9];
    /// Uses: the word roll starts, at `USES_RATE` of its normal speed.
    pub const ROLL: f32 = 0.6;
    pub const USES_RATE: f32 = 0.5;
}

/// Seconds into a shot when its content starts: after the cross-fade in, except for the first.
fn content_start(first: bool) -> f32 {
    if first { 0.3 } else { XFADE + 0.1 }
}

/// Where a shot's clip starts on the video timeline: shots after the first begin `XFADE` early,
/// under the previous shot's tail.
fn clip_start(kind: Kind) -> f32 {
    let index = SHOTS.iter().position(|s| s.0 == kind).expect("every kind has a shot");
    let start: f32 = SHOTS[..index].iter().map(|s| s.1).sum();
    if index == 0 { 0.0 } else { start - XFADE }
}

/// Moments on the video timeline the score is written around, in seconds.
pub struct ScoreCues {
    /// The slow CFD solve starts: the clock's pulse comes in.
    pub problem: f32,
    /// The line swap that leads into the reveal.
    pub swap: f32,
    /// The name appears: the drop lands here.
    pub reveal: f32,
    /// The model shot: the groove starts.
    pub model: f32,
    /// The workflow and platform shots: the arpeggio joins.
    pub platform: f32,
    /// The results: the claps join and the chords open up.
    pub results: f32,
    /// The closing name: the drums stop and the chords resolve.
    pub outro: f32,
    pub end: f32,
}

pub fn score_cues() -> ScoreCues {
    let content = |kind| clip_start(kind) + content_start(false);
    ScoreCues {
        problem: clip_start(Kind::Slow),
        swap: clip_start(Kind::Swap),
        reveal: content(Kind::Introducing) + at::NAME,
        model: clip_start(Kind::Model),
        platform: clip_start(Kind::Workflow),
        results: clip_start(Kind::Numbers),
        outro: content(Kind::Outro),
        end: SHOTS.iter().map(|s| s.1).sum(),
    }
}

// ---------------------------------------------------------------- hosted components

/// Inter for the sans components and Plex Mono for the monospaced ones, measured from the same files
/// the renderer draws with.
static METERS: LazyLock<TextMeters> = LazyLock::new(|| {
    let face = |label, bytes: &[u8]| TextMeter::new(label, bytes.to_vec());
    let inter_medium = include_bytes!("../media/Inter-Medium.ttf");
    let mono = include_bytes!("../media/IBMPlexMono-Medium.ttf");
    let mut meters = TextMeters::from_bytes(Some(inter_medium.to_vec()), Some(mono.to_vec()));
    for (label, bytes) in [
        ("Inter Regular", include_bytes!("../media/Inter-Regular.ttf").as_slice()),
        ("Inter Medium", inter_medium.as_slice()),
        ("Inter SemiBold", include_bytes!("../media/Inter-SemiBold.ttf").as_slice()),
        ("Inter Bold", include_bytes!("../media/Inter-Bold.ttf").as_slice()),
    ] {
        if let Some(meter) = face(label, bytes) {
            meters = meters.with_face(meter);
        }
    }
    meters
});

fn fonts() -> Fonts {
    Fonts { sans: SANS.to_owned(), mono: MONO.to_owned(), ..Fonts::default() }
}

/// The components' shadcn tokens, repainted in this video's palette.
fn theme() -> UiTheme {
    UiTheme {
        background: BG.to_owned(),
        foreground: TEXT.to_owned(),
        card: SURFACE.to_owned(),
        card_foreground: TEXT.to_owned(),
        popover: RAISED.to_owned(),
        popover_foreground: TEXT.to_owned(),
        primary: CYAN.to_owned(),
        primary_foreground: BG.to_owned(),
        secondary: RAISED.to_owned(),
        secondary_foreground: TEXT.to_owned(),
        muted: RAISED.to_owned(),
        muted_foreground: GRAY.to_owned(),
        accent: RAISED.to_owned(),
        accent_foreground: TEXT.to_owned(),
        border: BORDER.to_owned(),
        input: BORDER.to_owned(),
        ring: CYAN.to_owned(),
        font_family: Some(SANS.to_owned()),
        ..UiTheme::dark()
    }
}

/// The component a shot hosts, built once so its layout caches survive across frames.
fn component(kind: Kind) -> Option<Box<dyn Component>> {
    let built: Box<dyn Component> = match kind {
        Kind::Swap => Box::new(TextSwap::new(TextSwapConfig {
            from_text: "Hours of simulation.".to_owned(),
            to_text: "Seconds with AeroTwin.".to_owned(),
            font_size: 88.0,
            color: Some(TEXT.to_owned()),
            mode: Mode::Dark,
            theme: Some(theme()),
            font_family: Some(SANS.to_owned()),
            ..TextSwapConfig::default()
        })),
        Kind::Ask => Box::new(PromptZoom::new(PromptZoomConfig {
            greeting: "Ask about the airflow".to_owned(),
            text: QUESTION.to_owned(),
            placeholder: "Type a question".to_owned(),
            model: "AeroTwin agent".to_owned(),
            effort: "office-floor".to_owned(),
            type_start: at::QUESTION,
            cut_at: 1.1,
            zoom: 1.6,
            // Pivot on the field's centre so the greeting and the whole field stay in frame.
            focus_x: 0.4975,
            focus_y: 0.533,
            // The component always draws a starburst beside the greeting; painting it with no
            // fill hides it, so nothing on screen reads as a product logo.
            accent_color: Some("none".to_owned()),
            mode: Mode::Dark,
            theme: Some(theme()),
            font_family: Some(SANS.to_owned()),
            ..PromptZoomConfig::default()
        })),
        Kind::Uses => Box::new(CheckCycle::new(CheckCycleConfig {
            headline: "Built for".to_owned(),
            words: "Building design, HVAC optimization, Indoor air analysis".to_owned(),
            mode: Mode::Dark,
            theme: Some(theme()),
            font_family: Some(SANS.to_owned()),
            ..CheckCycleConfig::default()
        })),
        _ => return None,
    };
    Some(built)
}

/// The question typed to the assistant, then shown as sent.
const QUESTION: &str = "Is the meeting area drafty?";
/// The assistant's reply, streamed in word by word.
const ANSWER: &str = "Mostly comfortable. One drafty spot, right under the vent.";

/// Renders `component` on its own clock, which starts `start` seconds into the shot, holds its
/// first frame until then and runs at `rate` times real time.
fn host<'a>(frame: &mut Frame, component: &'a dyn Component, start: f32, rate: f32) -> Svgr<'a> {
    let info = ComponentFrame {
        local: ((frame.seconds() - start) * FPS * rate).max(0.0),
        global: frame.index,
        fps: FPS,
        duration: component.duration(),
        width: WIDTH as f32,
        height: HEIGHT as f32,
    };
    let mut ctx = RenderCtx::new(frame, fonts(), &METERS, info);
    component.show(&mut ctx)
}

// ---------------------------------------------------------------- video

#[derive(Debug)]
struct Shot {
    kind: Kind,
    seconds: f32,
    first: bool,
    last: bool,
    component: Option<Box<dyn Component>>,
}

impl Shot {
    fn component(&self) -> &dyn Component {
        self.component.as_deref().expect("this shot hosts a component")
    }
}

/// One stretch of the video under the same chapter label.
struct Chapter {
    start: f32,
    end: f32,
    number: &'static str,
    title: &'static str,
}

pub struct AeroTwinIntroVideo<'a> {
    pub media: &'a AeroTwinIntroMedia,
    shots: Vec<Shot>,
    chapters: Vec<Chapter>,
}

impl<'a> AeroTwinIntroVideo<'a> {
    pub fn new(media: &'a AeroTwinIntroMedia) -> Self {
        let shots = SHOTS
            .iter()
            .enumerate()
            .map(|(i, &(kind, seconds))| Shot { kind, seconds, first: i == 0, last: i == SHOTS.len() - 1, component: component(kind) })
            .collect();
        // Each shot owns the time from where the previous one finished; its cross-fade in
        // overlaps the previous shot's tail.
        let mut chapters: Vec<Chapter> = Vec::new();
        let mut at = 0.0;
        for &(kind, seconds) in &SHOTS {
            if let Some((number, title)) = chapter(kind) {
                match chapters.last_mut() {
                    Some(last) if last.number == number && (last.end - at).abs() < 1e-3 => last.end = at + seconds,
                    _ => chapters.push(Chapter { start: at, end: at + seconds, number, title }),
                }
            }
            at += seconds;
        }
        Self { media, shots, chapters }
    }

    /// The chapter label top left and the product name top right.
    fn hud<'b>(&self, t: f32) -> Svgr<'b> {
        let Some(c) = self.chapters.iter().find(|c| t >= c.start && t < c.end) else {
            return Svgr::empty();
        };
        let o = ((t - c.start) / XFADE).min((c.end - t) / XFADE).clamp(0.0, 1.0);
        fframes::svgr!(<g opacity={o}>
            <text x="96" y="92" font-family={MONO} font-weight="500" font-size="22" letter-spacing="4" fill={CYAN}>{c.number}</text>
            <path d="M144 84 H184" stroke={DIM} stroke-width="2" />
            <text x="200" y="92" font-family={MONO} font-weight="500" font-size="22" letter-spacing="4" fill={GRAY}>{c.title}</text>
            <text x="1824" y="92" text-anchor="end" font-family={MONO} font-weight="500" font-size="22" letter-spacing="4" fill={DIM}>"AEROTWIN"</text>
        </g>)
    }
}

impl std::fmt::Debug for AeroTwinIntroVideo<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AeroTwinIntroVideo").finish()
    }
}

impl Video for AeroTwinIntroVideo<'_> {
    const FPS: usize = 30;
    const WIDTH: usize = WIDTH;
    const HEIGHT: usize = HEIGHT;
    const BACKGROUND_COLOR: Color = Color::BLACK;

    fn duration(&self) -> Duration<'_> {
        Duration::Auto
    }

    fn audio(&self) -> AudioMap<'_> {
        AudioMap::from([AudioTrack::new(SCORE, AudioTimestamp::Second(0.0)..AudioTimestamp::Eof)])
    }

    fn define_scenes(&self) -> Scenes<'_> {
        Scenes::from(self.shots.iter().map(|s| s as &dyn Scene).collect::<Vec<_>>())
    }

    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let hud = self.hud(frame.seconds());
        let temp_stops: Vec<Svgr> = TEMP_STOPS
            .iter()
            .map(|&(offset, _)| fframes::svgr!(<stop offset={offset} stop-color={temp_color(lerp(SUPPLY_C, ROOM_C, offset))} />))
            .collect();
        // Shared paints, then a dot grid under a soft glow: static, so cached across frames.
        fframes::svgr!(
            <svg xmlns="http://www.w3.org/2000/svg" width={WIDTH} height={HEIGHT} viewBox="0 0 1920 1080">
                <defs>
                    <linearGradient id="brand" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0" stop-color="#22d3ee" />
                        <stop offset="1" stop-color="#818cf8" />
                    </linearGradient>
                    <linearGradient id="temp" x1="0" y1="0" x2="1" y2="0">{temp_stops}</linearGradient>
                    <radialGradient id="cold" cx="0.5" cy="0.5" r="0.5">
                        <stop offset="0" stop-color="#3b82f6" stop-opacity="0.3" />
                        <stop offset="1" stop-color="#3b82f6" stop-opacity="0" />
                    </radialGradient>
                    <radialGradient id="glow" cx="0.5" cy="0" r="0.75">
                        <stop offset="0" stop-color="#4f46e5" stop-opacity="0.28" />
                        <stop offset="1" stop-color="#4f46e5" stop-opacity="0" />
                    </radialGradient>
                    <radialGradient id="vignette" cx="0.5" cy="0.5" r="0.75">
                        <stop offset="0.6" stop-color="#000000" stop-opacity="0" />
                        <stop offset="1" stop-color="#000000" stop-opacity="0.7" />
                    </radialGradient>
                    <pattern id="dots" width="36" height="36" patternUnits="userSpaceOnUse">
                        <circle cx="18" cy="18" r="1.3" fill="#ffffff" fill-opacity="0.07" />
                    </pattern>
                </defs>
                <rect width="1920" height="1080" fill={BG} />
                <rect width="1920" height="1080" fill="url(#dots)" />
                <rect width="1920" height="1080" fill="url(#glow)" />
                {ctx.render_scenes(&frame)}
                <rect width="1920" height="1080" fill="url(#vignette)" />
                {hud}
            </svg>
        )
    }
}

impl Scene for Shot {
    fn name(&self) -> &'static str {
        match self.kind {
            Kind::Open => "Open",
            Kind::Complaints => "Complaints",
            Kind::Invisible => "Invisible",
            Kind::Slow => "Slow",
            Kind::Swap => "Swap",
            Kind::Introducing => "Introducing",
            Kind::Model => "Model",
            Kind::Workflow => "Workflow",
            Kind::Product => "Product",
            Kind::Probe => "Probe",
            Kind::Comfort => "Comfort",
            Kind::Compare => "Compare",
            Kind::Ask => "Ask",
            Kind::Answer => "Answer",
            Kind::Numbers => "Numbers",
            Kind::Uses => "Uses",
            Kind::Outro => "Outro",
        }
    }

    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(self.seconds)
    }

    fn audio(&self) -> AudioMap<'_> {
        AudioMap::from(cues(self.kind, content_start(self.first)))
    }

    fn overlap(&self) -> Overlap {
        if self.first { Overlap::None } else { Overlap::Previous(XFADE) }
    }

    fn render_frame<'a>(&'a self, mut frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let t = frame.seconds();
        let total = self.seconds + if self.first { 0.0 } else { XFADE };
        let fade_in = if self.first { 1.0 } else { (t / XFADE).clamp(0.0, 1.0) };
        let fade_out = if self.last { 1.0 } else { ((total - t) / XFADE).clamp(0.0, 1.0) };
        // Content enters once the cross-fade has finished.
        let t0 = content_start(self.first);
        let f = &mut frame;
        let body = match self.kind {
            Kind::Open => open(f, ctx, t0),
            Kind::Complaints => complaints(f, ctx, t0),
            Kind::Invisible => invisible(f, ctx, t0),
            Kind::Slow => slow(f, ctx, t0),
            Kind::Swap => swap(f, t0, self.component()),
            Kind::Introducing => introducing(f, ctx, t0),
            Kind::Model => model(f, ctx, t0),
            Kind::Workflow => workflow(f, ctx, t0),
            Kind::Product => product(f, ctx, t0),
            Kind::Probe => probe(f, ctx, t0),
            Kind::Comfort => comfort(f, ctx, t0),
            Kind::Compare => compare(f, ctx, t0),
            Kind::Ask => host(f, self.component(), t0, 1.0),
            Kind::Answer => answer(f, ctx, t0),
            Kind::Numbers => numbers(f, ctx, t0),
            Kind::Uses => uses(f, t0, self.component()),
            Kind::Outro => outro(f, ctx, t0),
        };
        fframes::svgr!(<g opacity={fade_in * fade_out}>{body}</g>)
    }
}

// ---------------------------------------------------------------- sound

// Written by `src/bin/synth_audio.rs`.
const SCORE: &str = "score.wav";
const WHOOSH: &str = "sfx-whoosh.wav";
const CLICK: &str = "sfx-click.wav";
const TICK: &str = "sfx-tick.wav";
const POP: &str = "sfx-pop.wav";
const CHIME: &str = "sfx-chime.wav";
const SHIMMER: &str = "sfx-shimmer.wav";
const SCAN: &str = "sfx-scan.wav";
const TYPING: &str = "sfx-typing.wav";

/// An effect `at` seconds into the clip, `gain` dB, played to its end.
fn sfx(file: &'static str, at: f32, gain: f32) -> AudioTrack<'static> {
    AudioTrack::new(file, AudioTimestamp::Second(at)..AudioTimestamp::Eof).gain_db(gain)
}

/// An effect cut off after `length` seconds, fading so it does not click.
fn sfx_for(file: &'static str, at: f32, length: f32, gain: f32) -> AudioTrack<'static> {
    AudioTrack::new(file, AudioTimestamp::Second(at)..AudioTimestamp::Second(at + length)).gain_db(gain).fade_out(0.08)
}

/// The effects a shot plays, on the same moments its drawing uses. `t0` is when its content
/// starts, in clip seconds.
fn cues(kind: Kind, t0: f32) -> Vec<AudioTrack<'static>> {
    match kind {
        Kind::Complaints => at::MESSAGES.iter().map(|m| sfx(POP, t0 + m, -12.0)).collect(),
        Kind::Invisible => vec![sfx(SCAN, t0 + at::SCAN, -13.0)],
        // The solve clock racing round: quick ticks while it counts.
        Kind::Slow => (0..22).map(|k| sfx(TICK, t0 + at::CLOCK + k as f32 * 0.12, -16.0)).collect(),
        Kind::Swap => vec![sfx(WHOOSH, t0 + at::SWAP, -8.0)],
        Kind::Model => at::CARDS.iter().map(|c| sfx(POP, t0 + c, -13.0)).collect(),
        // Pops as the room goes up, clicks as the vents drop and the optimizer starts, a scan
        // with a tick per candidate while it scores, and a chime for the best layout.
        Kind::Workflow => [
            sfx(POP, t0 + at::BUILD, -13.0),
            sfx(POP, t0 + at::BUILD + 1.3, -14.0),
            sfx(CLICK, t0 + at::SUPPLY, -8.0),
            sfx(CLICK, t0 + at::GRILLE, -8.0),
            sfx(CLICK, t0 + at::OPTIMIZE, -7.0),
            sfx_for(SCAN, t0 + at::OPTIMIZE + 0.2, at::HOPS[3] - at::OPTIMIZE + 0.2, -17.0),
            sfx(CHIME, t0 + at::PICK, -10.0),
            sfx(SHIMMER, t0 + at::PICK + 0.3, -15.0),
        ]
        .into_iter()
        .chain(at::HOPS.iter().map(|h| sfx(TICK, t0 + h, -15.0)))
        .collect(),
        Kind::Product => vec![sfx(CLICK, t0 + at::CLICK, -7.0), sfx(SHIMMER, t0 + at::CLICK + 0.1, -15.0)],
        // The verdict flips to drafty about 0.45 s into the probe's move towards the vent.
        Kind::Probe => vec![sfx(POP, t0 + at::READING, -13.0), sfx(TICK, t0 + at::LEAVE + 0.45, -12.0)],
        Kind::Comfort => vec![sfx(CLICK, t0 + at::COMFORT, -7.0), sfx(SHIMMER, t0 + at::SPREAD, -14.0)],
        Kind::Compare => vec![
            sfx(POP, t0 + at::LAYOUTS, -12.0),
            sfx_for(SCAN, t0 + at::LAYOUTS + 0.5, 3.0, -17.0),
            sfx(WHOOSH, t0 + at::SORT, -12.0),
            sfx(CHIME, t0 + at::BEST, -10.0),
        ],
        Kind::Ask => {
            let typing = QUESTION.chars().count() as f32 / PromptZoomConfig::default().chars_per_second;
            vec![sfx_for(TYPING, t0 + at::QUESTION, typing, -17.0)]
        }
        // A soft tick for each word of the reply as it streams in.
        Kind::Answer => [sfx(POP, t0 + at::ASKED, -13.0), sfx(POP, t0 + at::REPORT, -13.0)]
            .into_iter()
            .chain((1..=ANSWER.split(' ').count()).map(|k| sfx(TICK, t0 + at::REPLY + k as f32 / at::WORDS_PER_SECOND, -18.0)))
            .collect(),
        // AeroTwin's 20 s lane finishes almost at once on the sped-up clock.
        Kind::Numbers => [sfx(CHIME, t0 + at::RACE + 20.0 / at::RACE_SPEEDUP, -11.0)]
            .into_iter()
            .chain(at::FIGURES.iter().map(|f| sfx(POP, t0 + f, -13.0)))
            .collect(),
        Kind::Uses => (0..3).map(|k| sfx(TICK, t0 + at::ROLL + (ROLL_AT + k as f32 * ROLL_EVERY) / at::USES_RATE, -15.0)).collect(),
        _ => Vec::new(),
    }
}

// ---------------------------------------------------------------- motion helpers

fn run(frame: &Frame, start: f32, runtime: &AnimationRuntime) -> f32 {
    frame.animate_runtime(AnimateRuntimeInput { on_second: start, from: 0.0, to: 1.0, animation_runtime: runtime })
}

/// 0 to 1 over 0.9 s from `start`, fast then settling.
fn ramp(frame: &Frame, start: f32) -> f32 {
    run(frame, start, &EASE)
}

fn lerp(a: f32, b: f32, p: f32) -> f32 {
    a + (b - a) * p
}

/// Fades a group in while it rises and sharpens out of a blur.
fn reveal<'a>(frame: &Frame, start: f32, key: String, body: Svgr<'a>) -> Svgr<'a> {
    let p = ramp(frame, start);
    blurred(1.0 - p, p, 24.0 * (1.0 - p), key, body)
}

/// `body` at `opacity`, moved down `dy` and blurred by `amount` (0..1 of a 10 px radius).
fn blurred<'a>(amount: f32, opacity: f32, dy: f32, key: String, body: Svgr<'a>) -> Svgr<'a> {
    let radius = amount * 10.0;
    if radius < 0.25 {
        return fframes::svgr!(<g opacity={opacity} transform={Transform::translate(0, dy)}>{body}</g>);
    }
    let reference = format!("url(#{key})");
    fframes::svgr!(<g opacity={opacity} transform={Transform::translate(0, dy)}>
        <defs>
            <filter id={key} x="-40%" y="-80%" width="180%" height="260%">
                <feGaussianBlur stdDeviation={radius} />
            </filter>
        </defs>
        <g filter={reference}>{body}</g>
    </g>)
}

/// A line of words that blur in one after another (and optionally blur out).
#[derive(Clone, Copy)]
struct Line<'a> {
    text: &'a str,
    /// Bit `i` set paints word `i` gray: the two-tone headline style.
    gray: u32,
    x: f32,
    y: f32,
    size: usize,
    weight: u16,
    center: bool,
    start: f32,
    stagger: f32,
    exit: f32,
    key: &'static str,
    fill: &'a str,
}

impl Default for Line<'_> {
    fn default() -> Self {
        Self {
            text: "",
            gray: 0,
            x: 960.0,
            y: 540.0,
            size: 96,
            weight: 600,
            center: true,
            start: 0.0,
            stagger: 0.09,
            exit: f32::INFINITY,
            key: "w",
            fill: TEXT,
        }
    }
}

fn line<'a>(frame: &mut Frame, ctx: &FFramesContext<'a, '_>, l: Line<'a>) -> Svgr<'a> {
    let font = FontQuery { family: SANS, size: l.size, weight: l.weight, ..Default::default() };
    let tracking = -0.03 * l.size as f32;
    let space = 0.26 * l.size as f32;
    let widths: Vec<f32> = l
        .text
        .split(' ')
        .map(|w| frame.text_width(ctx, font, w).unwrap_or(0) as f32 + tracking * w.chars().count() as f32)
        .collect();
    let total = widths.iter().sum::<f32>() + space * widths.len().saturating_sub(1) as f32;
    let mut x = if l.center { l.x - total / 2.0 } else { l.x };
    let out = if l.exit.is_finite() { ramp(frame, l.exit) } else { 0.0 };
    let words: Vec<Svgr> = l
        .text
        .split(' ')
        .zip(widths)
        .enumerate()
        .map(|(i, (word, width))| {
            let p = ramp(frame, l.start + i as f32 * l.stagger);
            let color = if l.gray & (1 << i) != 0 { GRAY } else { l.fill };
            let glyphs = fframes::svgr!(
                <text x={x} y={l.y} font-family={SANS} font-size={l.size} font-weight={l.weight} letter-spacing={tracking} fill={color}>{word}</text>
            );
            x += width + space;
            blurred((1.0 - p) + out, p * (1.0 - out), 28.0 * (1.0 - p) - 20.0 * out, format!("{}{i}", l.key), glyphs)
        })
        .collect();
    fframes::svgr!(<g>{words}</g>)
}

/// A small monospaced label in capitals.
fn label<'a>(x: f32, y: f32, text: &'a str, fill: &'a str, anchor: &'a str) -> Svgr<'a> {
    fframes::svgr!(<text x={x} y={y} text-anchor={anchor} font-family={MONO} font-weight="500" font-size="28" letter-spacing="4" fill={fill}>{text}</text>)
}

/// The mouse pointer; `press` (0..1) squeezes it while clicking.
fn cursor<'a>(x: f32, y: f32, press: f32) -> Svgr<'a> {
    let s = 1.35 * (1.0 - 0.15 * press);
    fframes::svgr!(<g transform={format!("translate({x} {y}) scale({s})")}>
        <path d="M0 0 L0 30 L8 23 L13.5 35 L19 32.5 L13.5 21 L24 21 Z" fill="#ffffff" stroke="#000000" stroke-width="1.6" stroke-linejoin="round" />
    </g>)
}

/// A ring spreading out from a click at `at`.
fn ripple<'a>(frame: &Frame, x: f32, y: f32, at: f32) -> Svgr<'a> {
    let q = run(frame, at, &EASE);
    if q <= 0.0 || q >= 1.0 {
        return Svgr::empty();
    }
    fframes::svgr!(<circle cx={x} cy={y} r={10.0 + 34.0 * q} fill="none" stroke="#ffffff" stroke-width="2" stroke-opacity={0.7 * (1.0 - q)} />)
}

/// Pointer path through `stops` (leave at, x, y): it leaves each stop at its time and takes
/// one second to reach the next.
fn glide(frame: &Frame, stops: &[(f32, f32, f32)]) -> (f32, f32) {
    travel(frame, stops, &MOVE)
}

/// A path through `stops` (leave at, x, y), each leg timed by `runtime`.
fn travel(frame: &Frame, stops: &[(f32, f32, f32)], runtime: &AnimationRuntime) -> (f32, f32) {
    let (mut x, mut y) = (stops[0].1, stops[0].2);
    for pair in stops.windows(2) {
        let p = run(frame, pair[0].0, runtime);
        x += (pair[1].1 - pair[0].1) * p;
        y += (pair[1].2 - pair[0].2) * p;
    }
    (x, y)
}

/// How hard the button is pressed around a click at `at`.
fn press(t: f32, at: f32) -> f32 {
    (1.0 - (t - at).abs() / 0.12).clamp(0.0, 1.0)
}

/// Scales everything around the app canvas centre.
fn camera<'a>(scale: f32, body: Svgr<'a>) -> Svgr<'a> {
    let (px, py) = PIVOT;
    fframes::svgr!(<g transform={format!("translate({px} {py}) scale({scale}) translate({} {})", -px, -py)}>{body}</g>)
}

const NAME: &str = "AeroTwin";

/// The product name set in type only, centred on `cx`: its letters spring up out of a blur one
/// after another, and "Twin" takes a gradient that spans the whole word.
fn wordmark<'a>(frame: &mut Frame, ctx: &FFramesContext<'a, '_>, cx: f32, y: f32, start: f32, key: &'static str) -> Svgr<'a> {
    let size = 170;
    let font = FontQuery { family: SANS, size, weight: 600, ..Default::default() };
    let tracking = -0.035 * size as f32;
    // Each letter sits at the measured width of everything before it, which keeps the kerning.
    let edges: Vec<f32> = (0..=NAME.len())
        .map(|i| frame.text_width(ctx, font, &NAME[..i]).unwrap_or(0) as f32 + tracking * i as f32)
        .collect();
    let left = cx - edges[NAME.len()] / 2.0;
    let gradient = format!("{key}-ink");
    let letters: Vec<Svgr> = (0..NAME.len())
        .map(|i| {
            let p = run(frame, start + i as f32 * 0.06, &SPRING);
            let fill = if i < 4 { TEXT.to_owned() } else { format!("url(#{gradient})") };
            let glyph = fframes::svgr!(
                <text x={left + edges[i]} y={y} font-family={SANS} font-size={size} font-weight="600" fill={fill}>{&NAME[i..=i]}</text>
            );
            let o = p.clamp(0.0, 1.0);
            blurred((1.0 - o) * 0.8, o, 70.0 * (1.0 - p), format!("{key}{i}"), glyph)
        })
        .collect();
    fframes::svgr!(<g>
        <defs>
            <linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1={left + edges[4]} y1="0" x2={left + edges[NAME.len()]} y2="0">
                <stop offset="0" stop-color="#22d3ee" />
                <stop offset="1" stop-color="#818cf8" />
            </linearGradient>
        </defs>
        {letters}
    </g>)
}

// ---------------------------------------------------------------- the room

/// Supply air leaves the diffuser at `SUPPLY_C` and mixes towards the room's `ROOM_C`.
const SUPPLY_C: f32 = 14.0;
const ROOM_C: f32 = 25.0;
/// The return grille on the ceiling, where warmed air leaves: away from the still corner.
const RETURN: (f32, f32) = (1250.0, 520.0);
/// Air temperature colours, cold to room temperature: supply blue, cyan, white, warm amber.
const TEMP_STOPS: [(f32, [u8; 3]); 4] = [(0.0, [37, 99, 235]), (0.35, [34, 211, 238]), (0.7, [226, 232, 240]), (1.0, [251, 191, 36])];

/// The colour of air at `celsius`.
fn temp_color(celsius: f32) -> String {
    let u = ((celsius - SUPPLY_C) / (ROOM_C - SUPPLY_C)).clamp(0.0, 1.0);
    let k = TEMP_STOPS.windows(2).position(|w| u <= w[1].0).unwrap_or(TEMP_STOPS.len() - 2);
    let ((a, ca), (b, cb)) = (TEMP_STOPS[k], TEMP_STOPS[k + 1]);
    let p = (u - a) / (b - a);
    let c: Vec<u8> = (0..3).map(|i| lerp(ca[i] as f32, cb[i] as f32, p).round() as u8).collect();
    format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}

/// One point along an air path: plan position, height in screen px, how fast the air moves
/// there (0..1), how warm it is (°C), and when the air gets there (s).
#[derive(Clone, Copy)]
struct AirPoint {
    x: f32,
    y: f32,
    z: f32,
    speed: f32,
    temp: f32,
    time: f32,
}

/// Illustrative air paths from the 4-way ceiling diffuser, stepped through a designed flow: each
/// jet hugs the ceiling, turns down a wall or drops as it slows (cold air sinks), spreads over
/// the floor and over desks, warms as it mixes, and rises to the return grille.
static AIR: LazyLock<Vec<Vec<AirPoint>>> = LazyLock::new(|| {
    // Work in plan px on all three axes: the plan is 8.8 m wide and the ceiling 3.2 m high.
    let lift = (RW / 8.8) / (CEILING / 3.2);
    let top = CEILING * lift;
    let throw = 7.0;
    let mut paths = Vec::new();
    for (side, (nx, ny)) in [(1.0f32, 0.0f32), (0.0, 1.0), (-1.0, 0.0), (0.0, -1.0)].into_iter().enumerate() {
        for k in 0..9 {
            let id = (side * 9 + k) as u32;
            let u = (k as f32 + 0.5) / 9.0 - 0.5;
            let (tx, ty) = (-ny, nx);
            let (mut x, mut y, mut h) = (VENT.0 + nx * 30.0 + tx * u * 50.0, VENT.1 + ny * 30.0 + ty * u * 50.0, top - 6.0);
            let spread = (nx + tx * u * 1.3, ny + ty * u * 1.3);
            let norm = spread.0.hypot(spread.1);
            let launch = throw * (0.85 + 0.3 * hash(id, 7));
            let (mut vx, mut vy, mut vh) = (spread.0 / norm * launch, spread.1 / norm * launch, 0.0f32);
            let mut temp = SUPPLY_C;
            let mut attached = true;
            let mut points = Vec::new();
            for step in 0..1000 {
                if step % 3 == 0 {
                    let speed = (vx.hypot(vy).hypot(vh) / throw).min(1.0);
                    points.push(AirPoint { x, y, z: h / lift, speed, temp, time: step as f32 * 0.01 });
                }
                vx *= 0.988;
                vy *= 0.988;
                vh *= 0.988;
                // The fast jet clings to the ceiling; once it slows it lets go.
                attached &= vx.hypot(vy) > 4.4;
                if attached {
                    vh += (top - 8.0 - h) * 0.05 - vh * 0.2;
                } else {
                    // Buoyancy: air colder than the room sinks, and warm air drifts to the return.
                    vh += (temp - ROOM_C) * 0.018;
                    let pull = ((temp - (ROOM_C - 2.0)) / 1.6).clamp(0.0, 1.0) * 0.06;
                    let (rx, ry, rh) = (RETURN.0 - x, RETURN.1 - y, top - h);
                    let d = rx.hypot(ry).hypot(rh).max(1.0);
                    // Near the return the room air loses its swirl and is drawn in.
                    let settle = 1.0 - pull * 0.6;
                    vx = vx * settle + rx / d * pull;
                    vy = vy * settle + ry / d * pull;
                    vh += rh / d * pull;
                    if d < 40.0 {
                        break;
                    }
                    // Slow eddies, different for every path, so the room air meanders.
                    let seed = id as f32;
                    vx += (y * 0.012 + seed * 1.7).sin() * 0.025;
                    vy += (x * 0.010 + seed * 2.3).cos() * 0.025;
                }
                // Walls turn the air along them: what was heading into a wall runs down it.
                let margin = 24.0;
                let turn = if attached { 0.8 } else { 0.3 };
                if (x < RX + margin && vx < 0.0) || (x > RX + RW - margin && vx > 0.0) {
                    vh -= vx.abs() * turn;
                    vx *= -0.1;
                    attached = false;
                }
                if (y < RY + margin && vy < 0.0) || (y > RY + RH - margin && vy > 0.0) {
                    vh -= vy.abs() * turn;
                    vy *= -0.1;
                    attached = false;
                }
                // Desks lift the air smoothly over their tops as it comes near.
                let desk_top = 14.0 * lift + 6.0;
                let near_desk = |pad: f32| DESKS.iter().any(|&(dx, dy, w, d)| x > dx - pad && x < dx + w + pad && y > dy - pad && y < dy + d + pad);
                if h < desk_top + 10.0 && near_desk(36.0) {
                    vh += 0.3 * (1.0 - (h / (desk_top + 10.0)));
                }
                // The floor (or a desk top) spreads falling air sideways.
                let floor = if near_desk(0.0) { desk_top } else { 10.0 };
                if h < floor {
                    if vh < 0.0 {
                        let flat = vx.hypot(vy).max(0.3);
                        vx += vx / flat * -vh * 0.55;
                        vy += vy / flat * -vh * 0.55;
                    }
                    vh = vh.max(0.0);
                    h = h.max(floor - 4.0).min(floor);
                }
                // Air never quite stops: it keeps drifting.
                let speed = vx.hypot(vy).hypot(vh);
                if speed < 0.9 {
                    let k = 0.9 / speed.max(1e-3);
                    vx *= k;
                    vy *= k;
                    vh *= k;
                }
                temp += (ROOM_C - temp) * 0.0075;
                x = (x + vx).clamp(RX + 8.0, RX + RW - 8.0);
                y = (y + vy).clamp(RY + 8.0, RY + RH - 8.0);
                h = (h + vh).clamp(10.0, top - 6.0);
            }
            paths.push(points);
        }
    }
    paths
});

/// The latest time any path is still flowing; `grow` reveals paths against it.
static AIR_SECONDS: LazyLock<f32> = LazyLock::new(|| AIR.iter().filter_map(|p| p.last()).map(|p| p.time).fold(0.0, f32::max));

/// The airflow layer, on screen: every path coloured by the temperature of its air and drawn
/// heavier where the air is fast, with particles riding along at the air's own speed. `grow`
/// (0..1) lets the air flow out of the diffuser.
fn streams<'a>(t: f32, orbit: f32, grow: f32) -> Svgr<'a> {
    if grow <= 0.001 {
        return Svgr::empty();
    }
    let reach = grow * *AIR_SECONDS;
    let (s, c) = orbit.to_radians().sin_cos();
    let lines: Vec<Svgr> = AIR
        .iter()
        .enumerate()
        .map(|(i, path)| {
            let shown = path.partition_point(|p| p.time <= reach);
            if shown < 2 {
                return Svgr::empty();
            }
            let screen: Vec<(f32, f32)> = path[..shown].iter().map(|p| project(p.x, p.y, p.z, orbit)).collect();
            // Nearer paths (further down-right once turned) read brighter.
            let mid = path[shown / 2];
            let (dx, dy) = (mid.x - CENTRE.0, mid.y - CENTRE.1);
            let depth = (((dx * c - dy * s) + (dx * s + dy * c)) / 900.0 + 0.5).clamp(0.0, 1.0);
            // Short runs share one colour and width; chunks are opaque inside a translucent
            // group, so their joints do not double up into beads.
            let chunk = 5;
            let mut glow = Vec::new();
            let mut core = Vec::new();
            for start in (0..shown - 1).step_by(chunk) {
                let end = (start + chunk).min(shown - 1);
                let d: String = screen[start..=end].iter().enumerate().map(|(k, (x, y))| format!("{}{x:.1} {y:.1}", if k == 0 { "M" } else { " L" })).collect();
                let p = path[(start + end) / 2];
                let color = temp_color(p.temp);
                glow.push(fframes::svgr!(<path d={d.clone()} fill="none" stroke={color.clone()} stroke-width={6.0 + 16.0 * p.speed} stroke-linecap="round" stroke-linejoin="round" />));
                core.push(fframes::svgr!(<path d={d} fill="none" stroke={color} stroke-width={1.2 + 2.6 * p.speed} stroke-linecap="round" stroke-linejoin="round" />));
            }
            // Three particles per path, each with a fading tail of the last 0.3 s of travel.
            let end_time = path[path.len() - 1].time;
            let particles: Vec<Svgr> = (0..3)
                .filter_map(|k| {
                    let head = (t * 0.8 + hash(i as u32 * 3 + k, 11) * end_time) % (end_time + 0.8);
                    if head > reach || head > end_time {
                        return None;
                    }
                    let a = path.partition_point(|p| p.time < head - 0.3);
                    let b = path.partition_point(|p| p.time <= head).max(a + 1).min(path.len() - 1);
                    let tail: Vec<(f32, f32)> = path[a..=b].iter().map(|p| project(p.x, p.y, p.z, orbit)).collect();
                    let tip = path[b];
                    let (hx, hy) = tail[tail.len() - 1];
                    let d: String = tail.iter().enumerate().map(|(k, (x, y))| format!("{}{x:.1} {y:.1}", if k == 0 { "M" } else { " L" })).collect();
                    let color = temp_color(tip.temp);
                    Some(fframes::svgr!(<g>
                        <path d={d} fill="none" stroke={color.clone()} stroke-opacity="0.55" stroke-width={2.0 + 3.0 * tip.speed} stroke-linecap="round" stroke-linejoin="round" />
                        <circle cx={hx} cy={hy} r={5.0 + 4.0 * tip.speed} fill={color} fill-opacity="0.35" />
                        <circle cx={hx} cy={hy} r={2.2 + 1.6 * tip.speed} fill="#ffffff" />
                    </g>))
                })
                .collect();
            fframes::svgr!(<g opacity={0.55 + 0.45 * depth}>
                <g opacity="0.1">{glow}</g>
                <g opacity="0.85">{core}</g>
                {particles}
            </g>)
        })
        .collect();
    fframes::svgr!(<g>{lines}</g>)
}

/// Comfort class colour of a plan point: near the vent is drafty, the far corner is still.
fn comfort_class(x: f32, y: f32) -> &'static str {
    let near_vent = ((x - VENT.0).powi(2) + ((y - VENT.1) * 1.2).powi(2)).sqrt() < 170.0;
    let corner = ((x - (RX + RW)).powi(2) + ((y - (RY + RH)) * 1.6).powi(2)).sqrt() < 300.0;
    if near_vent { COOL } else if corner { STILL } else { GOOD }
}

/// How far the room has been built in the editor; a finished room is `BUILT`.
#[derive(Clone, Copy)]
struct Build {
    /// Floor outline drawn, 0..1.
    outline: f32,
    /// Walls raised, 0..1.
    walls: f32,
    /// Each desk placed, 0..1 (a spring may overshoot).
    desks: [f32; 4],
    /// The supply diffuser's plan position, and how far it has dropped into place, 0..1.
    supply: ((f32, f32), f32),
    /// The return grille dropped into place, 0..1.
    grille: f32,
}

const BUILT: Build = Build { outline: 1.0, walls: 1.0, desks: [1.0; 4], supply: (VENT, 1.0), grille: 1.0 };

/// What the app shows: the room plus which layers are on.
struct AppView {
    t: f32,
    build: Build,
    /// Opacity of the air paths.
    air: f32,
    /// How far the air paths have drawn out from the vent, 0..1.
    grow: f32,
    /// How far the room is turned, in degrees.
    orbit: f32,
    /// Seconds into the scene when the comfort map starts spreading, if shown.
    comfort_from: Option<f32>,
    /// Knob position (0 off, 1 on) of each inspector toggle.
    toggles: [f32; 3],
}

/// The AeroTwin app window: title bar, a sidebar of tools with `tool` selected, and the outlines
/// of the canvas and inspector panes.
fn window<'a>(title: &'a str, tool: usize) -> Svgr<'a> {
    let tools: Vec<Svgr> = (0..4)
        .map(|i| {
            let (fill, stroke) = if i == tool { ("#1b1f26", CYAN) } else { ("none", "#2a2f37") };
            fframes::svgr!(<rect x="280" y={296.0 + i as f32 * 54.0} width="30" height="30" rx="8" fill={fill} stroke={stroke} stroke-width="2" />)
        })
        .collect();
    fframes::svgr!(<g>
        <rect x="260" y="230" width="1400" height="780" rx="18" fill={SURFACE} stroke={BORDER} stroke-width="2" />
        <path d="M260 274 H1660 M330 274 V1010 M1300 274 V1010" stroke={BORDER} stroke-width="2" />
        <circle cx="286" cy="252" r="6" fill="#2b2f36" /><circle cx="306" cy="252" r="6" fill="#2b2f36" /><circle cx="326" cy="252" r="6" fill="#2b2f36" />
        <text x="960" y="262" text-anchor="middle" font-family={MONO} font-weight="500" font-size="24" fill={GRAY}>{title}</text>
        {tools}
    </g>)
}

/// The AeroTwin app: the window with the room on its canvas and the airflow inspector.
fn app<'a>(frame: &Frame, view: AppView) -> Svgr<'a> {
    let toggles: Vec<Svgr> = ["Air paths", "Live probe", "Comfort map"]
        .into_iter()
        .zip(view.toggles)
        .enumerate()
        .map(|(i, (name, on))| {
            let y = 352.0 + i as f32 * 64.0;
            let track = if on > 0.5 { CYAN } else { "#2a2f37" };
            fframes::svgr!(<g>
                <text x="1330" y={y + 10.0} font-family={SANS} font-weight="500" font-size="28" fill={TEXT}>{name}</text>
                <rect x="1580" y={y - 16.0} width="52" height="30" rx="15" fill={track} />
                <circle cx={1595.0 + 22.0 * on} cy={y - 1.0} r="11" fill="#ffffff" />
            </g>)
        })
        .collect();
    let legend: Vec<Svgr> = if view.comfort_from.is_some() {
        [("Comfortable", GOOD), ("Drafty", COOL), ("Still air", STILL)]
            .into_iter()
            .enumerate()
            .map(|(i, (name, color))| {
                let y = 640.0 + i as f32 * 52.0;
                fframes::svgr!(<g>
                    <circle cx="1342" cy={y - 9.0} r="9" fill={color} />
                    <text x="1366" y={y} font-family={SANS} font-weight="500" font-size="28" fill={TEXT}>{name}</text>
                </g>)
            })
            .collect()
    } else {
        Vec::new()
    };
    let legend_title = if view.comfort_from.is_some() {
        fframes::svgr!(<g>
            {label(1330.0, 590.0, "COMFORT", GRAY, "start")}
            <text x="1330" y="830" font-family={SANS} font-weight="400" font-size="28" fill={GRAY}>"Rules from ASHRAE 55,"</text>
            <text x="1330" y="868" font-family={SANS} font-weight="400" font-size="28" fill={GRAY}>"the comfort standard."</text>
        </g>)
    } else if view.air > 0.0 && view.grow > 0.0 {
        fframes::svgr!(<g opacity={view.grow.min(1.0)}>
            {label(1330.0, 590.0, "AIR TEMPERATURE", GRAY, "start")}
            <rect x="1330" y="614" width="300" height="14" rx="7" fill="url(#temp)" />
            <text x="1330" y="672" font-family={MONO} font-weight="500" font-size="24" fill={TEXT}>{format!("{SUPPLY_C:.0} °C")}</text>
            <text x="1630" y="672" text-anchor="end" font-family={MONO} font-weight="500" font-size="24" fill={TEXT}>{format!("{ROOM_C:.0} °C")}</text>
            <text x="1330" y="708" font-family={SANS} font-weight="400" font-size="24" fill={GRAY}>"supply"</text>
            <text x="1630" y="708" text-anchor="end" font-family={SANS} font-weight="400" font-size="24" fill={GRAY}>"room"</text>
            <text x="1330" y="790" font-family={SANS} font-weight="400" font-size="28" fill={GRAY}>"Cool air warms as"</text>
            <text x="1330" y="828" font-family={SANS} font-weight="400" font-size="28" fill={GRAY}>"it mixes into the room."</text>
        </g>)
    } else {
        Svgr::empty()
    };
    fframes::svgr!(<g>
        {window("aerotwin / office-floor · webgpu", 0)}
        {label(1330.0, 312.0, "AIRFLOW", GRAY, "start")}
        {toggles}
        {legend_title}
        {legend}
        {room(frame, &view)}
    </g>)
}

/// The room on the app canvas, built as far as `view.build` says, with its layers on top.
fn room<'a>(frame: &Frame, view: &AppView) -> Svgr<'a> {
    let build = view.build;
    // Walls: the two facing away from the camera are filled behind the room; the other two are
    // only outlined in front of it, like glass, so the air inside stays visible.
    let wall_h = 100.0 * build.walls;
    let corners = [(RX, RY), (RX + RW, RY), (RX + RW, RY + RH), (RX, RY + RH)];
    let normals = [(0.0, -1.0), (1.0, 0.0), (0.0, 1.0), (-1.0, 0.0)];
    let (s, c) = view.orbit.to_radians().sin_cos();
    let mut back_walls = String::new();
    let mut front_edges = String::new();
    for i in 0..4 {
        let (p, q) = (corners[i], corners[(i + 1) % 4]);
        let (nx, ny) = normals[i];
        let faces_away = (nx * c - ny * s) + (nx * s + ny * c) < 0.0;
        let (p0, q0) = (project(p.0, p.1, 0.0, view.orbit), project(q.0, q.1, 0.0, view.orbit));
        let (p1, q1) = (project(p.0, p.1, wall_h, view.orbit), project(q.0, q.1, wall_h, view.orbit));
        if faces_away {
            back_walls.push_str(&format!("M{:.1} {:.1} L{:.1} {:.1} L{:.1} {:.1} L{:.1} {:.1} Z ", p0.0, p0.1, q0.0, q0.1, q1.0, q1.1, p1.0, p1.1));
        } else {
            front_edges.push_str(&format!("M{:.1} {:.1} L{:.1} {:.1} ", p1.0, p1.1, q1.0, q1.1));
        }
        front_edges.push_str(&format!("M{:.1} {:.1} L{:.1} {:.1} ", p0.0, p0.1, p1.0, p1.1));
    }
    let grid: Vec<Svgr> = (1..25)
        .map(|i| {
            let x = RX + i as f32 * 40.0;
            fframes::svgr!(<path d={format!("M{x} {RY} V{}", RY + RH)} stroke="#ffffff" stroke-opacity="0.04" stroke-width="2" />)
        })
        .chain((1..13).map(|i| {
            let y = RY + i as f32 * 40.0;
            fframes::svgr!(<path d={format!("M{RX} {y} H{}", RX + RW)} stroke="#ffffff" stroke-opacity="0.04" stroke-width="2" />)
        }))
        .collect();
    // Each desk grows out of its centre as it is placed.
    let desk_tops: Vec<Svgr> = DESKS
        .iter()
        .zip(build.desks)
        .map(|(&(x, y, w, h), s)| {
            let (cx, cy) = (x + w / 2.0, y + h / 2.0);
            fframes::svgr!(<g opacity={s.clamp(0.0, 1.0)} transform={format!("translate({cx} {cy}) scale({}) translate({} {})", s.max(0.001), -cx, -cy)}>
                <rect x={x} y={y} width={w} height={h} rx="6" fill="#1d222a" stroke="#2c323b" stroke-width="2" />
            </g>)
        })
        .collect();
    let comfort: Svgr = match view.comfort_from {
        Some(from) => {
            let dots: Vec<Svgr> = (0..38)
                .flat_map(|col| (0..20).map(move |row| (col, row)))
                .map(|(col, row)| {
                    let (x, y) = (RX + 13.0 + col as f32 * 26.0, RY + 13.0 + row as f32 * 26.0);
                    let distance = ((x - VENT.0).powi(2) + (y - VENT.1).powi(2)).sqrt();
                    let o = run(frame, from + distance / 900.0, &QUICK);
                    fframes::svgr!(<circle cx={x} cy={y} r="8" fill={comfort_class(x, y)} fill-opacity={0.85 * o} />)
                })
                .collect();
            fframes::svgr!(<g>{dots}</g>)
        }
        None => Svgr::empty(),
    };
    let ((sx, sy), drop) = build.supply;
    let o = view.orbit;
    fframes::svgr!(<g>
        <path d={back_walls} fill="#ffffff" fill-opacity="0.025" stroke="#2c323b" stroke-width="2" />
        <g transform={plane(0.0, o)}>
            // The floor outline draws itself round the room, then fills.
            <rect x={RX} y={RY} width={RW} height={RH} fill="#0f1216" fill-opacity={build.outline} stroke="#2c323b" stroke-width="4" stroke-dasharray={format!("{} {}", 2.0 * (RW + RH) * build.outline, 2.0 * (RW + RH) + 1.0)} />
            <g opacity={build.outline}>{grid}</g>
            // The pool of cool air where the jets land.
            <ellipse cx={VENT.0 + 50.0} cy={VENT.1 + 40.0} rx="250" ry="210" fill="url(#cold)" opacity={view.air * (0.8 + 0.2 * (view.t * 1.6).sin())} />
            {comfort}
        </g>
        <g transform={plane(14.0, o)}>{desk_tops}</g>
        <g transform={plane(CEILING + 60.0 * (1.0 - drop), o)} opacity={drop.min(1.0)}>
            // The 4-way supply diffuser: nested louvres throwing air out on every side.
            <rect x={sx - 44.0} y={sy - 44.0} width="88" height="88" rx="10" fill={CYAN} fill-opacity={0.08 + 0.05 * (view.t * 3.0).sin()} />
            <rect x={sx - 32.0} y={sy - 32.0} width="64" height="64" rx="6" fill="#0b2a3c" stroke={CYAN} stroke-width="4" />
            <rect x={sx - 21.0} y={sy - 21.0} width="42" height="42" rx="4" fill="none" stroke={CYAN} stroke-opacity="0.7" stroke-width="3" />
            <rect x={sx - 10.0} y={sy - 10.0} width="20" height="20" rx="2" fill={CYAN} fill-opacity="0.6" />
        </g>
        <g transform={plane(CEILING + 60.0 * (1.0 - build.grille), o)} opacity={build.grille.min(1.0)}>
            // The return grille: warmed air leaves here.
            <rect x={RETURN.0 - 40.0} y={RETURN.1 - 26.0} width="80" height="52" rx="5" fill="#241a08" stroke="#f59e0b" stroke-opacity="0.75" stroke-width="3" />
            <path d={(0..6).map(|k| format!("M{} {} v36 ", RETURN.0 - 28.0 + k as f32 * 11.2, RETURN.1 - 18.0)).collect::<String>()} stroke="#f59e0b" stroke-opacity="0.55" stroke-width="3" />
        </g>
        <g opacity={view.air}>{streams(view.t, o, view.grow)}</g>
        <path d={front_edges} fill="none" stroke="#ffffff" stroke-opacity="0.09" stroke-width="2" />
    </g>)
}

/// The app sliding up into place.
fn app_enter<'a>(frame: &Frame, start: f32, body: Svgr<'a>) -> Svgr<'a> {
    let p = ramp(frame, start);
    let s = lerp(0.94, 1.0, p);
    fframes::svgr!(<g opacity={p} transform={format!("translate(0 {}) translate(960 620) scale({s}) translate(-960 -620)", 40.0 * (1.0 - p))}>{body}</g>)
}

// ---------------------------------------------------------------- scenes

fn open<'a>(frame: &mut Frame, ctx: &FFramesContext<'a, '_>, t0: f32) -> Svgr<'a> {
    line(frame, ctx, Line { text: "One office. Two complaints.", gray: 0b1100, y: 580.0, size: 120, start: t0, stagger: 0.12, key: "open", ..Line::default() })
}

fn complaints<'a>(frame: &mut Frame, ctx: &FFramesContext<'a, '_>, t0: f32) -> Svgr<'a> {
    let head = line(frame, ctx, Line { text: "Sound familiar?", y: 330.0, size: 64, weight: 500, fill: GRAY, start: t0, key: "fam", ..Line::default() });
    let messages = [("M", "Maya", "Desk 4", "It’s freezing by the vent again.", COOL), ("S", "Sam", "Back corner", "It’s so stuffy back here.", "#fb923c")];
    let cards: Vec<Svgr> = messages
        .into_iter()
        .enumerate()
        .map(|(i, (initial, name, place, text, color))| {
            let y = 420.0 + i as f32 * 168.0;
            let body = fframes::svgr!(<g>
                <rect x="500" y={y} width="920" height="136" rx="18" fill={SURFACE} stroke={BORDER} stroke-width="2" />
                <circle cx="568" cy={y + 68.0} r="32" fill={color} fill-opacity="0.16" stroke={color} stroke-width="2" />
                <text x="568" y={y + 79.0} text-anchor="middle" font-family={SANS} font-weight="600" font-size="30" fill={color}>{initial}</text>
                <text x="628" y={y + 54.0} font-family={SANS} font-weight="600" font-size="30" fill={TEXT}>{name}</text>
                <text x={628.0 + name.len() as f32 * 18.0 + 20.0} y={y + 54.0} font-family={MONO} font-weight="500" font-size="24" fill={DIM}>{place}</text>
                <text x="628" y={y + 100.0} font-family={SANS} font-weight="400" font-size="34" fill="#c9ccd2">{text}</text>
            </g>);
            reveal(frame, t0 + at::MESSAGES[i], format!("msg{i}"), body)
        })
        .collect();
    fframes::svgr!(<g>{head}{cards}</g>)
}

/// A stable pseudo-random number in 0..1 for item `i`, so every frame agrees on it.
fn hash(i: u32, salt: u32) -> f32 {
    let mut x = i.wrapping_mul(0x9E37_79B1) ^ salt.wrapping_mul(0x85EB_CA6B);
    x ^= x >> 15;
    x = x.wrapping_mul(0x2C1B_3C6D);
    x ^= x >> 12;
    (x & 0xFF_FFFF) as f32 / 16_777_216.0
}

fn invisible<'a>(frame: &mut Frame, ctx: &FFramesContext<'a, '_>, t0: f32) -> Svgr<'a> {
    let t = frame.seconds();
    // A scanner sweeps the frame: the moving air it passes over lights up, then goes dark again.
    let lens = lerp(-260.0, 2180.0, run(frame, t0 + at::SCAN, &SWEEP));
    let motes: Vec<Svgr> = (0..170)
        .filter_map(|i| {
            let speed = 60.0 + 90.0 * hash(i, 1);
            let x = (hash(i, 2) * 2200.0 + t * speed) % 2200.0 - 140.0;
            let y = 110.0 + hash(i, 3) * 860.0 + (t * 0.8 + hash(i, 4) * 6.28).sin() * 18.0;
            let o = 1.0 - (x - lens).abs() / 230.0;
            if o < 0.02 {
                return None;
            }
            let length = 14.0 + 30.0 * hash(i, 5);
            Some(fframes::svgr!(<path d={format!("M{x:.1} {y:.1} h{length:.1}")} stroke={CYAN} stroke-opacity={0.85 * o} stroke-width="3" stroke-linecap="round" />))
        })
        .collect();
    let beam = fframes::svgr!(<g>
        <defs>
            <linearGradient id="scan-glow" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stop-color="#22d3ee" stop-opacity="0" />
                <stop offset="0.5" stop-color="#22d3ee" stop-opacity="0.07" />
                <stop offset="1" stop-color="#22d3ee" stop-opacity="0" />
            </linearGradient>
        </defs>
        <rect x={lens - 230.0} y="0" width="460" height="1080" fill="url(#scan-glow)" />
        <rect x={lens - 1.0} y="0" width="2" height="1080" fill={CYAN} fill-opacity="0.45" />
    </g>);
    let first = line(frame, ctx, Line { text: "The problem? Air is invisible.", gray: 0b11, y: 540.0, size: 110, start: t0, key: "inv", ..Line::default() });
    let second = line(frame, ctx, Line { text: "You can’t fix what you can’t see.", y: 650.0, size: 48, weight: 500, fill: GRAY, start: t0 + 1.8, stagger: 0.06, key: "fix", ..Line::default() });
    fframes::svgr!(<g>{beam}{motes}{first}{second}</g>)
}

fn slow<'a>(frame: &mut Frame, ctx: &FFramesContext<'a, '_>, t0: f32) -> Svgr<'a> {
    let head = line(frame, ctx, Line { text: "Today, checking it means a full CFD simulation.", gray: 0b1111, y: 290.0, size: 60, start: t0, stagger: 0.06, key: "today", ..Line::default() });
    let p = run(frame, t0 + at::CLOCK, &SLOW);
    let minutes = p * 24.0;
    let clock = format!("{:02}:{:02}", minutes as u32, (minutes.fract() * 60.0) as u32);
    let counter = fframes::svgr!(<g>
        <text x="640" y="590" text-anchor="middle" font-family={MONO} font-weight="500" font-size="180" letter-spacing="-4" fill={TEXT}>{clock}</text>
        <rect x="380" y="640" width="520" height="4" rx="2" fill={BORDER} />
        <rect x="380" y="640" width={(520.0 * p).max(0.5)} height="4" rx="2" fill="url(#brand)" />
        {label(640.0, 710.0, "TYPICAL CFD SOLVE, ONE LAYOUT", GRAY, "middle")}
    </g>);
    // What the solver is doing meanwhile: iterating until its residuals (the error left in each
    // equation) fall far enough. Illustrative curves, drawn as the clock runs.
    let steps = 120;
    let shown = (p * steps as f32) as usize;
    let curves: Vec<Svgr> = [(CYAN, 3.4, 0u32), ("#818cf8", 2.6, 1), (GRAY, 2.0, 2)]
        .into_iter()
        .map(|(color, decay, salt)| {
            let d: String = (0..=shown)
                .map(|k| {
                    let u = k as f32 / steps as f32;
                    let jitter = (hash(k as u32, salt) - 0.5) * 30.0 * (1.0 - 0.6 * u);
                    let y = 430.0 + 200.0 * (1.0 - (-decay * u).exp()) + jitter;
                    format!("{}{:.1} {:.1}", if k == 0 { "M" } else { " L" }, 1060.0 + 500.0 * u, y.min(650.0))
                })
                .collect();
            fframes::svgr!(<path d={d} fill="none" stroke={color} stroke-width="2.5" stroke-linejoin="round" />)
        })
        .collect();
    let plot = fframes::svgr!(<g>
        {label(1060.0, 404.0, "SOLVER RESIDUALS", DIM, "start")}
        <path d="M1060 420 V660 H1560" fill="none" stroke={BORDER} stroke-width="2" />
        {curves}
        {label(1560.0, 710.0, "ITERATIONS →", DIM, "end")}
    </g>);
    let after = line(frame, ctx, Line { text: "Five layouts to try? That’s two hours.", gray: 0b1111, y: 860.0, size: 56, start: t0 + 3.9, stagger: 0.07, key: "hours", ..Line::default() });
    fframes::svgr!(<g>
        {head}
        {reveal(frame, t0 + 0.5, "count".to_owned(), counter)}
        {reveal(frame, t0 + 0.8, "plot".to_owned(), plot)}
        {after}
    </g>)
}

fn swap<'a>(frame: &mut Frame, t0: f32, component: &'a dyn Component) -> Svgr<'a> {
    // The old line settles on screen for a beat before the component rushes it past the camera.
    let body = host(frame, component, t0 + at::SWAP, 1.0);
    reveal(frame, t0, "swap".to_owned(), body)
}

fn introducing<'a>(frame: &mut Frame, ctx: &FFramesContext<'a, '_>, t0: f32) -> Svgr<'a> {
    let tag = fframes::svgr!(<g opacity={ramp(frame, t0)}>{label(960.0, 410.0, "INTRODUCING", GRAY, "middle")}</g>);
    let name = wordmark(frame, ctx, 960.0, 610.0, t0 + at::NAME, "intro");
    let tagline = line(frame, ctx, Line { text: "A neural 3D digital twin for indoor airflow.", gray: 0b11100001, y: 720.0, size: 52, weight: 500, start: t0 + 1.1, stagger: 0.06, key: "see", ..Line::default() });
    fframes::svgr!(<g>{tag}{name}{tagline}</g>)
}

/// The model's input drawn as what it reads: the room's walls, furniture and vent as a point
/// cloud, sampled in from left to right. Centred on `(cx, cy)`; plan units span 0..1.
fn point_cloud<'a>(frame: &Frame, cx: f32, cy: f32, start: f32) -> Svgr<'a> {
    type P = (f32, f32, f32);
    let mut segments: Vec<(P, P)> = Vec::new();
    let (w, d) = (1.0, 0.55);
    let floor = [(0.0, 0.0), (w, 0.0), (w, d), (0.0, d)];
    for k in 0..4 {
        let ((u0, v0), (u1, v1)) = (floor[k], floor[(k + 1) % 4]);
        segments.push(((u0, v0, 0.0), (u1, v1, 0.0)));
        segments.push(((u0, v0, 0.0), (u0, v0, 1.0)));
        segments.push(((u0, v0, 1.0), (u1, v1, 1.0)));
    }
    for (u0, v0, u1, v1) in [(0.28, 0.24, 0.5, 0.36), (0.6, 0.08, 0.82, 0.2)] {
        let desk = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)];
        for k in 0..4 {
            let ((a, b), (c, e)) = (desk[k], desk[(k + 1) % 4]);
            segments.push(((a, b, 0.25), (c, e, 0.25)));
        }
    }
    let to_screen = |(u, v, z): P| (cx + 128.0 * ((u - 0.5) - (v - 0.275)), cy + 64.0 * ((u - 0.5) + (v - 0.275)) - 55.0 * z);
    let dots: Vec<Svgr> = segments
        .iter()
        .flat_map(|&(a, b)| {
            let n = ((b.0 - a.0).abs() + (b.1 - a.1).abs() + (b.2 - a.2).abs()).mul_add(14.0, 2.0) as usize;
            (0..=n).map(move |j| {
                let f = j as f32 / n as f32;
                (a.0 + (b.0 - a.0) * f, a.1 + (b.1 - a.1) * f, a.2 + (b.2 - a.2) * f)
            })
        })
        .map(|p| {
            let (sx, sy) = to_screen(p);
            let o = run(frame, start + (sx - cx + 160.0) / 320.0 * 1.2, &QUICK);
            fframes::svgr!(<circle cx={sx} cy={sy} r="2.4" fill={CYAN} fill-opacity={0.85 * o} />)
        })
        .collect();
    fframes::svgr!(<g>{dots}</g>)
}

/// A small neural network with signal pulses sweeping through its layers.
fn network<'a>(t: f32, cx: f32, cy: f32) -> Svgr<'a> {
    let layers = [3usize, 5, 5, 3];
    let node = |l: usize, k: usize| (cx - 135.0 + l as f32 * 90.0, cy + (k as f32 - (layers[l] - 1) as f32 / 2.0) * 26.0);
    // 0..1 brightness of layer `l`: a pulse leaves the inputs every 1.2 s.
    let pulse = |l: f32| {
        let phase = (t / 1.2 - l * 0.22).rem_euclid(1.0);
        if phase < 0.3 { 1.0 - phase / 0.3 } else { 0.0 }
    };
    let mut edges = Vec::new();
    for l in 0..layers.len() - 1 {
        let glow = pulse(l as f32 + 0.5);
        for a in 0..layers[l] {
            for b in 0..layers[l + 1] {
                let ((x0, y0), (x1, y1)) = (node(l, a), node(l + 1, b));
                edges.push(fframes::svgr!(<path d={format!("M{x0} {y0} L{x1} {y1}")} stroke={CYAN} stroke-opacity={0.1 + 0.5 * glow} stroke-width="1.5" />));
            }
        }
    }
    let nodes: Vec<Svgr> = (0..layers.len())
        .flat_map(|l| (0..layers[l]).map(move |k| (l, k)))
        .map(|(l, k)| {
            let (x, y) = node(l, k);
            let glow = pulse(l as f32);
            fframes::svgr!(<circle cx={x} cy={y} r="6" fill={RAISED} stroke={CYAN} stroke-opacity={0.4 + 0.6 * glow} stroke-width="2" fill-opacity="1" />)
        })
        .collect();
    fframes::svgr!(<g>{edges}{nodes}</g>)
}

/// The model's output: air velocity arrows swirling around the room, coloured from cool near
/// the jet to warmer away from it. Illustrative.
fn vector_field<'a>(frame: &Frame, t: f32, cx: f32, cy: f32, start: f32) -> Svgr<'a> {
    let arrows: Vec<Svgr> = (0..9)
        .flat_map(|col| (0..4).map(move |row| (col, row)))
        .map(|(col, row)| {
            let (x, y) = (cx - 136.0 + col as f32 * 34.0, cy - 48.0 + row as f32 * 32.0);
            let (rx, ry) = ((x - cx) / 140.0, (y - cy) / 60.0);
            let r = (rx * rx + ry * ry).sqrt();
            let angle = ry.atan2(rx) + std::f32::consts::FRAC_PI_2 + 0.25 * (t * 1.5 + col as f32 * 0.4).sin();
            let grow = run(frame, start + (col + row) as f32 * 0.04, &EASE);
            let length = 22.0 * grow * (1.0 - 0.4 * r.min(1.0));
            let (dx, dy) = (angle.cos() * length, angle.sin() * length * 0.6);
            let color = if r < 0.45 { CYAN } else if r < 0.8 { COOL } else { "#818cf8" };
            fframes::svgr!(<g opacity={grow}>
                <path d={format!("M{:.1} {:.1} L{:.1} {:.1}", x - dx / 2.0, y - dy / 2.0, x + dx / 2.0, y + dy / 2.0)} stroke={color} stroke-width="2.5" stroke-linecap="round" />
                <circle cx={x + dx / 2.0} cy={y + dy / 2.0} r="3" fill={color} />
            </g>)
        })
        .collect();
    fframes::svgr!(<g>{arrows}</g>)
}

fn model<'a>(frame: &mut Frame, ctx: &FFramesContext<'a, '_>, t0: f32) -> Svgr<'a> {
    let t = frame.seconds();
    let head = line(frame, ctx, Line { text: "A neural network that learned how air moves.", gray: 0b11111000, y: 270.0, size: 72, start: t0, stagger: 0.07, key: "model", ..Line::default() });
    let nodes = [
        (200.0, "INPUT", "Room geometry", "walls, vents, furniture"),
        (760.0, "MODEL", "Neural surrogate", "trained on CFD runs"),
        (1320.0, "OUTPUT", "Air + temperature", "at any 3D point"),
    ];
    let cards: Vec<Svgr> = nodes
        .into_iter()
        .enumerate()
        .map(|(i, (x, tag, title, note))| {
            let accent = i == 1;
            let start = t0 + at::CARDS[i];
            let stroke = if accent { "url(#brand)" } else { BORDER };
            let halo = if accent {
                fframes::svgr!(<rect x={x - 6.0} y="394" width="412" height="372" rx="26" fill="none" stroke="url(#brand)" stroke-opacity="0.18" stroke-width="12" />)
            } else {
                Svgr::empty()
            };
            let visual = match i {
                0 => point_cloud(frame, x + 200.0, 580.0, start + 0.3),
                1 => network(t, x + 200.0, 540.0),
                _ => vector_field(frame, t, x + 200.0, 540.0, start + 0.3),
            };
            let body = fframes::svgr!(<g>
                {halo}
                <rect x={x} y="400" width="400" height="360" rx="20" fill={SURFACE} stroke={stroke} stroke-width="2" />
                {label(x + 36.0, 450.0, tag, CYAN, "start")}
                {visual}
                <text x={x + 36.0} y="672" font-family={SANS} font-weight="600" font-size="40" letter-spacing="-1" fill={TEXT}>{title}</text>
                <text x={x + 36.0} y="716" font-family={SANS} font-weight="400" font-size="30" fill={GRAY}>{note}</text>
            </g>);
            reveal(frame, start, format!("node{i}"), body)
        })
        .collect();
    let wires: Vec<Svgr> = [600.0, 1160.0]
        .into_iter()
        .enumerate()
        .map(|(i, x)| {
            let on = ramp(frame, t0 + 1.4 + i as f32 * 0.5);
            let offset = -((t * 160.0) % 160.0);
            fframes::svgr!(<g opacity={on}>
                <path d={format!("M{x} 580 H{}", x + 160.0)} stroke={BORDER} stroke-width="2" />
                <path d={format!("M{x} 580 H{}", x + 160.0)} stroke="url(#brand)" stroke-width="4" stroke-linecap="round" stroke-dasharray="26 134" stroke-dashoffset={offset} />
            </g>)
        })
        .collect();
    let foot = line(frame, ctx, Line { text: "Physics-informed deep learning, trained on CFD.", y: 860.0, size: 44, weight: 500, fill: GRAY, start: t0 + 2.8, stagger: 0.06, key: "trained", ..Line::default() });
    fframes::svgr!(<g>{head}{wires}{cards}{foot}</g>)
}

fn caption<'a>(frame: &mut Frame, ctx: &FFramesContext<'a, '_>, t0: f32, text: &'a str, gray: u32, key: &'static str) -> Svgr<'a> {
    line(frame, ctx, Line { text, gray, y: 170.0, size: 60, start: t0, stagger: 0.07, key, ..Line::default() })
}

/// The supply positions the optimizer tries, in order, with example comfort scores; the room's
/// own vent position scores best.
const OPTIONS: [((f32, f32), f32); 4] = [((1180.0, 760.0), 64.0), ((900.0, 780.0), 71.0), (VENT, 89.0), ((1020.0, 560.0), 76.0)];
const WINNER: usize = 2;

/// A name tag pointing at a spot on screen, from the left of it or from above.
fn tag<'a>(x: f32, y: f32, text: &'a str, color: &'a str, left: bool, opacity: f32) -> Svgr<'a> {
    let (cx, cy) = if left { (x - 160.0, y) } else { (x, y - 74.0) };
    let stem = if left { format!("M{} {y} H{}", x - 50.0, x - 34.0) } else { format!("M{x} {} V{}", y - 52.0, y - 26.0) };
    fframes::svgr!(<g opacity={opacity}>
        <rect x={cx - 110.0} y={cy - 22.0} width="220" height="44" rx="22" fill={RAISED} stroke={color} stroke-opacity="0.6" stroke-width="2" />
        <text x={cx} y={cy + 8.0} text-anchor="middle" font-family={MONO} font-weight="500" font-size="22" letter-spacing="3" fill={color}>{text}</text>
        <path d={stem} stroke={color} stroke-opacity="0.6" stroke-width="2" />
    </g>)
}

fn workflow<'a>(frame: &mut Frame, ctx: &FFramesContext<'a, '_>, t0: f32) -> Svgr<'a> {
    let t = frame.seconds();
    let head = caption(frame, ctx, t0, "From floor plan to best layout.", 0b11000, "flow");
    let m = |s: f32| t0 + s;
    // The optimizer moves the diffuser on to each candidate, then back to the best one.
    let mut stops: Vec<(f32, f32, f32)> = OPTIONS.iter().zip(at::HOPS).map(|(&((x, y), _), h)| (m(h), x, y)).collect();
    stops.push((f32::INFINITY, OPTIONS[WINNER].0 .0, OPTIONS[WINNER].0 .1));
    // The room goes up in the editor: the floor outline draws, the walls rise, the desks pop in,
    // then the vents drop into place.
    let build = Build {
        outline: run(frame, m(at::BUILD), &MOVE),
        walls: run(frame, m(at::BUILD + 0.7), &MOVE),
        desks: [0, 1, 2, 3].map(|k| run(frame, m(at::BUILD + 1.3 + 0.15 * k as f32), &SPRING)),
        supply: (travel(frame, &stops, &QUICK), run(frame, m(at::SUPPLY), &QUICK)),
        grille: run(frame, m(at::GRILLE), &QUICK),
    };
    let pick = ramp(frame, m(at::PICK));
    let view = AppView { t, build, air: pick, grow: run(frame, m(at::PICK + 0.3), &GROW), orbit: 0.0, comfort_from: None, toggles: [0.0; 3] };

    // The four steps, each checked off once the next starts.
    let switches = [at::BUILD, at::POINTER, at::OPTIMIZE, at::PICK, at::PICK + 1.2].map(m);
    let steps: Vec<Svgr> = ["Draw the room", "Place the vents", "Run the optimizer", "Pick the best"]
        .into_iter()
        .enumerate()
        .map(|(k, name)| {
            let y = 370.0 + k as f32 * 60.0;
            let on = ramp(frame, switches[k]);
            let done = ramp(frame, switches[k + 1]);
            let link = if k < 3 {
                fframes::svgr!(<g>
                    <path d={format!("M1344 {} V{}", y + 6.0, y + 36.0)} stroke="#2a2f37" stroke-width="2" />
                    <path d={format!("M1344 {} V{}", y + 6.0, y + 6.0 + 30.0 * done)} stroke={GOOD} stroke-width="2" />
                </g>)
            } else {
                Svgr::empty()
            };
            let (fill, stroke) = if done > 0.5 { (GOOD, GOOD) } else if on > 0.5 { (RAISED, CYAN) } else { (RAISED, "#2a2f37") };
            let mark = if done > 0.5 {
                fframes::svgr!(<path d={format!("M1337 {} l5 5 l9 -10", y - 9.0)} fill="none" stroke={BG} stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />)
            } else {
                fframes::svgr!(<text x="1344" y={y - 3.0} text-anchor="middle" font-family={MONO} font-weight="500" font-size="18" fill={if on > 0.5 { TEXT } else { DIM }}>{format!("{}", k + 1)}</text>)
            };
            fframes::svgr!(<g>
                {link}
                <circle cx="1344" cy={y - 9.0} r="15" fill={fill} stroke={stroke} stroke-width="2" />
                {mark}
                <text x="1374" y={y} font-family={SANS} font-weight="500" font-size="26" fill={TEXT} fill-opacity={0.35 + 0.65 * on - 0.3 * done}>{name}</text>
            </g>)
        })
        .collect();

    // Below the steps: what is in the scene so far, until the optimizer's scores take over.
    let scoring = ramp(frame, m(at::OPTIMIZE));
    let scene: Vec<Svgr> = [("Room", "8.8 × 4.6 m", at::BUILD + 0.3), ("Desks", "4", at::BUILD + 1.3), ("Supply diffuser", "1", at::SUPPLY), ("Return grille", "1", at::GRILLE)]
        .into_iter()
        .enumerate()
        .map(|(k, (name, value, when))| {
            let y = 664.0 + k as f32 * 48.0;
            fframes::svgr!(<g opacity={ramp(frame, m(when))}>
                <text x="1330" y={y} font-family={SANS} font-weight="400" font-size="26" fill={GRAY}>{name}</text>
                <text x="1630" y={y} text-anchor="end" font-family={MONO} font-weight="500" font-size="24" fill={TEXT}>{value}</text>
            </g>)
        })
        .collect();
    // Each candidate is scored once the diffuser reaches it.
    let scored = [at::OPTIMIZE + 0.3, at::HOPS[0] + 0.3, at::HOPS[1] + 0.3, at::HOPS[2] + 0.3];
    let rows: Vec<Svgr> = OPTIONS
        .iter()
        .enumerate()
        .map(|(k, &(_, score))| {
            let y = 664.0 + k as f32 * 48.0;
            let fill = run(frame, m(scored[k]), &EASE);
            let winner = k == WINNER;
            let highlight = if winner {
                fframes::svgr!(<rect x="1316" y={y - 34.0} width="330" height="48" rx="10" fill={CYAN} fill-opacity="0.06" stroke="url(#brand)" stroke-width="2" opacity={pick} />)
            } else {
                Svgr::empty()
            };
            fframes::svgr!(<g opacity={if winner { 1.0 } else { 1.0 - 0.5 * pick }}>
                {highlight}
                <text x="1330" y={y} font-family={SANS} font-weight="500" font-size="26" fill={TEXT}>{format!("Option {}", k + 1)}</text>
                <rect x="1470" y={y - 12.0} width="100" height="4" rx="2" fill={BORDER} />
                <rect x="1470" y={y - 12.0} width={(score * fill).max(0.5)} height="4" rx="2" fill={if winner { "url(#brand)" } else { DIM }} />
                <text x="1630" y={y} text-anchor="end" font-family={MONO} font-weight="500" font-size="26" fill={TEXT}>{if fill > 0.0 { format!("{:.0}", score * fill) } else { "—".to_string() }}</text>
            </g>)
        })
        .collect();
    let clicked = press(t, m(at::OPTIMIZE));
    let inspector = fframes::svgr!(<g>
        {label(1330.0, 312.0, "WORKFLOW", GRAY, "start")}
        {steps}
        <g opacity={1.0 - scoring}>{label(1330.0, 610.0, "SCENE", GRAY, "start")}{scene}</g>
        <g opacity={scoring}>{label(1330.0, 610.0, "OPTIMIZER", GRAY, "start")}{rows}{label(1330.0, 876.0, "EXAMPLE SCORES", DIM, "start")}</g>
        <g opacity={1.0 - 0.6 * ramp(frame, m(at::OPTIMIZE + 0.2))} transform={format!("translate(1480 938) scale({}) translate(-1480 -938)", 1.0 - 0.05 * clicked)}>
            <rect x="1330" y="912" width="300" height="52" rx="12" fill="url(#brand)" />
            <text x="1480" y="947" text-anchor="middle" font-family={SANS} font-weight="600" font-size="26" fill={BG}>"Optimize layout"</text>
        </g>
    </g>);

    // The pointer drops the diffuser and the grille onto the ceiling, then runs the optimizer.
    let a = project(OPTIONS[0].0 .0, OPTIONS[0].0 .1, CEILING, 0.0);
    let r = project(RETURN.0, RETURN.1, CEILING, 0.0);
    let (cx, cy) = glide(frame, &[(m(at::POINTER), 1150.0, 1060.0), (m(at::SUPPLY + 0.15), a.0, a.1), (m(at::GRILLE + 0.15), r.0, r.1), (f32::INFINITY, 1480.0, 938.0)]);
    let pointer = fframes::svgr!(<g opacity={ramp(frame, m(at::POINTER - 0.2)) * (1.0 - ramp(frame, m(at::OPTIMIZE + 0.4)))}>
        {ripple(frame, a.0, a.1, m(at::SUPPLY))}
        {ripple(frame, r.0, r.1, m(at::GRILLE))}
        {ripple(frame, 1480.0, 938.0, m(at::OPTIMIZE))}
        {cursor(cx, cy, press(t, m(at::SUPPLY)) + press(t, m(at::GRILLE)) + clicked)}
    </g>);
    let named = 1.0 - scoring;
    let tags = fframes::svgr!(<g>
        {tag(a.0, a.1, "SUPPLY · IN", CYAN, true, ramp(frame, m(at::SUPPLY + 0.2)) * named)}
        {tag(r.0, r.1, "RETURN · OUT", "#f59e0b", false, ramp(frame, m(at::GRILLE + 0.2)) * named)}
    </g>);
    let tool = if t < m(at::POINTER) { 0 } else if t < m(at::OPTIMIZE) { 1 } else { 2 };
    let body = fframes::svgr!(<g>
        {window("aerotwin / office-floor · editor", tool)}
        {inspector}
        {room(frame, &view)}
        {tags}
        {pointer}
    </g>);
    fframes::svgr!(<g>{app_enter(frame, t0 + 0.2, body)}{head}</g>)
}

fn product<'a>(frame: &mut Frame, ctx: &FFramesContext<'a, '_>, t0: f32) -> Svgr<'a> {
    let t = frame.seconds();
    let head = caption(frame, ctx, t0, "A live 3D twin of the room, in your browser.", 0b1110000000, "prod");
    // The pointer flies in and switches the air paths on.
    let click = t0 + at::CLICK;
    let (cx, cy) = glide(frame, &[(t0 + 1.6, 1500.0, 1120.0), (click + 0.6, 1608.0, 352.0), (f32::INFINITY, 1760.0, 760.0)]);
    let on = run(frame, click, &QUICK);
    // The room turns into the same view the next shot opens on, while the air paths grow out of
    // the vent once they are switched on.
    let orbit = -24.0 * (1.0 - run(frame, 0.0, &ORBIT));
    let view = AppView { t, build: BUILT, air: 1.0, grow: run(frame, click + 0.1, &GROW), orbit, comfort_from: None, toggles: [on, 0.0, 0.0] };
    let push = lerp(1.0, 1.05, run(frame, t0, &SLOW));
    let window = app_enter(frame, t0 + 0.4, app(frame, view));
    let pointer = fframes::svgr!(<g opacity={ramp(frame, t0 + 1.6)}>
        {ripple(frame, 1608.0, 352.0, click)}
        {cursor(cx, cy, press(t, click))}
    </g>);
    fframes::svgr!(<g>
        {camera(push, fframes::svgr!(<g>{window}{pointer}</g>))}
        <rect x="0" y="0" width="1920" height="225" fill={BG} fill-opacity="0.6" />
        {head}
    </g>)
}

fn probe<'a>(frame: &mut Frame, ctx: &FFramesContext<'a, '_>, t0: f32) -> Svgr<'a> {
    let t = frame.seconds();
    let head = caption(frame, ctx, t0, "Point anywhere. Get a reading.", 0b11000, "probe");
    let zoom = lerp(1.05, 1.12, run(frame, 0.0, &SLOW));
    let view = AppView { t, build: BUILT, air: 0.55, grow: 1.0, orbit: 0.0, comfort_from: None, toggles: [1.0, 1.0, 0.0] };
    let open_desk = iso(1045.0, 760.0);
    let by_vent = iso(745.0, 625.0);
    let leave = t0 + at::LEAVE;
    let (x, y) = glide(frame, &[(t0 + 0.4, 1150.0, 960.0), (leave, open_desk.0, open_desk.1), (f32::INFINITY, by_vent.0, by_vent.1)]);
    // The reading follows the probe live as it travels towards the vent; above 0.2 m/s the
    // comfort rule calls it a draft.
    let q = run(frame, leave, &MOVE);
    let air_speed = lerp(0.12, 0.34, q);
    let (speed, temp) = (format!("{air_speed:.2} m/s"), format!("{:.1} °C", lerp(24.1, 22.6, q)));
    let (verdict, color) = if air_speed > 0.2 { ("Drafty", COOL) } else { ("Comfortable", GOOD) };
    let tip_in = ramp(frame, t0 + at::READING);
    let tip = fframes::svgr!(<g opacity={tip_in} transform={format!("translate({} {})", x + 36.0, y - 196.0)}>
        <rect x="0" y="0" width="400" height="168" rx="14" fill={RAISED} stroke={BORDER} stroke-width="2" />
        <text x="22" y="48" font-family={SANS} font-weight="400" font-size="28" fill={GRAY}>"Air speed"</text>
        <text x="378" y="48" text-anchor="end" font-family={MONO} font-weight="500" font-size="28" fill={TEXT}>{speed}</text>
        <text x="22" y="92" font-family={SANS} font-weight="400" font-size="28" fill={GRAY}>"Temperature"</text>
        <text x="378" y="92" text-anchor="end" font-family={MONO} font-weight="500" font-size="28" fill={TEXT}>{temp}</text>
        <circle cx="32" cy="132" r="8" fill={color} />
        <text x="50" y="142" font-family={SANS} font-weight="600" font-size="28" fill={color}>{verdict}</text>
    </g>);
    let crosshair = fframes::svgr!(<g opacity={ramp(frame, t0 + 0.4)} transform={format!("translate({x} {y})")}>
        <ellipse rx="34" ry="17" fill="none" stroke="#ffffff" stroke-width="3" />
        <ellipse rx="6" ry="3" fill="#ffffff" />
        <path d="M0 0 V-90" stroke="#ffffff" stroke-opacity="0.6" stroke-width="2" stroke-dasharray="6 6" />
    </g>);
    fframes::svgr!(<g>
        {camera(zoom, fframes::svgr!(<g>{app(frame, view)}{crosshair}{tip}</g>))}
        <rect x="0" y="0" width="1920" height="225" fill={BG} fill-opacity="0.6" />
        {head}
    </g>)
}

fn comfort<'a>(frame: &mut Frame, ctx: &FFramesContext<'a, '_>, t0: f32) -> Svgr<'a> {
    let t = frame.seconds();
    let head = caption(frame, ctx, t0, "See where people will feel comfortable.", 0b1111000, "comf");
    let zoom = lerp(1.12, 1.0, run(frame, 0.0, &MOVE));
    let on = run(frame, t0 + at::COMFORT, &QUICK);
    let orbit = 12.0 * run(frame, 0.0, &ORBIT);
    let view = AppView { t, build: BUILT, air: 0.25 * (1.0 - on), grow: 1.0, orbit, comfort_from: Some(t0 + at::SPREAD), toggles: [1.0 - on, 0.0, on] };
    fframes::svgr!(<g>
        {camera(zoom, app(frame, view))}
        <rect x="0" y="0" width="1920" height="225" fill={BG} fill-opacity="0.6" />
        {head}
    </g>)
}

/// Comfort class colour of a point in a mini layout, all coordinates 0..1.
fn mini_class(x: f32, y: f32, vents: &[(f32, f32)]) -> &'static str {
    let nearest = vents.iter().map(|&(vx, vy)| ((x - vx).powi(2) + ((y - vy) * 0.55).powi(2)).sqrt()).fold(f32::MAX, f32::min);
    if nearest < 0.11 { COOL } else if nearest > 0.55 { STILL } else { GOOD }
}

fn compare<'a>(frame: &mut Frame, ctx: &FFramesContext<'a, '_>, t0: f32) -> Svgr<'a> {
    let head = line(frame, ctx, Line { text: "Compare layouts. Pick the best.", gray: 0b11100, y: 230.0, size: 72, start: t0, stagger: 0.07, key: "cmp", ..Line::default() });
    let layouts: [(&str, f32, &[(f32, f32)]); 4] = [
        ("Layout A", 62.0, &[(0.15, 0.25)]),
        ("Layout B", 78.0, &[(0.5, 0.5)]),
        ("Layout C", 91.0, &[(0.3, 0.5), (0.72, 0.5)]),
        ("Layout D", 70.0, &[(0.85, 0.3)]),
    ];
    // The optimizer scores each layout with a sweep over its map, then sorts them best first.
    let ranks = [3.0, 1.0, 0.0, 2.0];
    let sort = run(frame, t0 + at::SORT, &MOVE);
    let decide = ramp(frame, t0 + at::BEST);
    let cards: Vec<Svgr> = layouts
        .into_iter()
        .enumerate()
        .map(|(i, (name, score, vents))| {
            let x = 160.0 + i as f32 * 400.0;
            let start = t0 + at::LAYOUTS + i as f32 * 0.12;
            let fill = run(frame, start + 0.5, &SLOW);
            let winner = i == 2;
            let dots: Vec<Svgr> = (0..16)
                .flat_map(|col| (0..9).map(move |row| (col, row)))
                .map(|(col, row)| {
                    let (u, v) = ((col as f32 + 0.5) / 16.0, (row as f32 + 0.5) / 9.0);
                    let o = ((fill * 1.1 - v) / 0.1).clamp(0.0, 1.0);
                    fframes::svgr!(<circle cx={x + 20.0 + u * 320.0} cy={410.0 + v * 170.0} r="6" fill={mini_class(u, v, vents)} fill-opacity={0.8 * o} />)
                })
                .collect();
            let scan = if fill > 0.0 && fill < 1.0 {
                let y = 410.0 + 170.0 * (fill * 1.1).min(1.0);
                fframes::svgr!(<g>
                    <rect x={x + 20.0} y={y - 12.0} width="320" height="12" fill={CYAN} fill-opacity="0.12" />
                    <rect x={x + 20.0} y={y - 1.0} width="320" height="2" fill={CYAN} fill-opacity="0.8" />
                </g>)
            } else {
                Svgr::empty()
            };
            let rank = if winner {
                Svgr::empty()
            } else {
                fframes::svgr!(<g opacity={sort}>{label(x + 336.0, 388.0, ["#1", "#2", "#3", "#4"][ranks[i] as usize], GRAY, "end")}</g>)
            };
            let vent_marks: Vec<Svgr> = vents
                .iter()
                .map(|&(u, v)| fframes::svgr!(<rect x={x + 20.0 + u * 320.0 - 11.0} y={410.0 + v * 170.0 - 11.0} width="22" height="22" rx="4" fill="#0e3a52" stroke={CYAN} stroke-width="3" />))
                .collect();
            let border = if winner {
                fframes::svgr!(<g opacity={decide}>
                    <rect x={x - 5.0} y="335" width="370" height="450" rx="25" fill="none" stroke="url(#brand)" stroke-opacity="0.2" stroke-width="10" />
                    <rect x={x} y="340" width="360" height="440" rx="20" fill="none" stroke="url(#brand)" stroke-width="2.5" />
                    <rect x={x + 236.0} y="356" width="104" height="40" rx="20" fill="url(#brand)" />
                    <text x={x + 288.0} y="384" text-anchor="middle" font-family={SANS} font-weight="600" font-size="24" fill={BG}>"Best"</text>
                </g>)
            } else {
                Svgr::empty()
            };
            let dim = if winner { 1.0 } else { 1.0 - 0.55 * decide };
            let body = fframes::svgr!(<g opacity={dim}>
                <rect x={x} y="340" width="360" height="440" rx="20" fill={SURFACE} stroke={BORDER} stroke-width="2" />
                <text x={x + 24.0} y="388" font-family={SANS} font-weight="600" font-size="32" fill={TEXT}>{name}</text>
                <rect x={x + 20.0} y="410" width="320" height="170" rx="10" fill="#0f1216" />
                {dots}
                {vent_marks}
                {scan}
                {rank}
                {label(x + 24.0, 640.0, "COMFORT SCORE", GRAY, "start")}
                <text x={x + 24.0} y="726" font-family={MONO} font-weight="500" font-size="76" letter-spacing="-2" fill={TEXT}>{format!("{:.0}", score * fill)}</text>
                <rect x={x + 24.0} y="748" width="312" height="4" rx="2" fill={BORDER} />
                <rect x={x + 24.0} y="748" width={(312.0 * score / 100.0 * fill).max(0.5)} height="4" rx="2" fill={if winner { "url(#brand)" } else { DIM }} />
                {border}
            </g>);
            // Cards moving left arc up and cards moving right dip down, so they pass instead of colliding.
            let delta = 160.0 + ranks[i] * 400.0 - x;
            let arc = (delta / 400.0).clamp(-1.0, 1.0) * 70.0 * (sort * std::f32::consts::PI).sin();
            fframes::svgr!(<g transform={Transform::translate(delta * sort, arc)}>{reveal(frame, start, format!("card{i}"), body)}</g>)
        })
        .collect();
    let note = fframes::svgr!(<g opacity={ramp(frame, t0 + 1.2)}>{label(960.0, 880.0, "EXAMPLE SCORES · RANKED BY THE LAYOUT OPTIMIZER", DIM, "middle")}</g>);
    fframes::svgr!(<g>{head}{cards}{note}</g>)
}

fn answer<'a>(frame: &mut Frame, ctx: &FFramesContext<'a, '_>, t0: f32) -> Svgr<'a> {
    let t = frame.seconds();
    let head = line(frame, ctx, Line { text: "Plain answers. Shareable reports.", gray: 0b1100, y: 270.0, size: 72, start: t0, stagger: 0.07, key: "ans", ..Line::default() });
    // The question just asked, as a sent message.
    let question = QUESTION;
    let qw = frame.text_width(ctx, FontQuery { family: SANS, size: 36, weight: 400, ..Default::default() }, question).unwrap_or(460) as f32;
    let asked = fframes::svgr!(<g>
        <rect x={1500.0 - qw - 64.0} y="340" width={qw + 64.0} height="76" rx="38" fill={RAISED} stroke={BORDER} stroke-width="2" />
        <text x={1500.0 - 32.0} y="390" text-anchor="end" font-family={SANS} font-weight="400" font-size="36" fill={TEXT}>{question}</text>
    </g>);
    let answer = ANSWER;
    let streamed = (((t - t0 - at::REPLY) * at::WORDS_PER_SECOND).max(0.0)) as usize;
    let words: Vec<&str> = answer.split(' ').take(streamed).collect();
    let first: String = words.iter().take(5).copied().collect::<Vec<_>>().join(" ");
    let second: String = words.iter().skip(5).copied().collect::<Vec<_>>().join(" ");
    let reply = fframes::svgr!(<g>
        <path d="M452 492 L458 506 L472 512 L458 518 L452 532 L446 518 L432 512 L446 506 Z" fill="url(#brand)" />
        <text x="500" y="524" font-family={SANS} font-weight="400" font-size="40" fill={TEXT}>{first}</text>
        <text x="500" y="578" font-family={SANS} font-weight="400" font-size="40" fill={TEXT}>{second}</text>
    </g>);
    // The report is exported from the app, not written by the assistant: keep it apart.
    let report = fframes::svgr!(<g>
        <path d="M420 680 H1500" stroke={BORDER} stroke-width="2" />
        {label(420.0, 760.0, "ASHRAE 55 PDF · FROM THE APP", DIM, "start")}
        <rect x="1100" y="720" width="400" height="64" rx="32" fill={RAISED} stroke={BORDER} stroke-width="2" />
        <rect x="1130" y="737" width="24" height="30" rx="4" fill="none" stroke={GRAY} stroke-width="2.5" />
        <text x="1172" y="762" font-family={MONO} font-weight="500" font-size="26" fill={TEXT}>"comfort-report.pdf"</text>
    </g>);
    fframes::svgr!(<g>
        {head}
        <g transform="translate(0 50)">
            {reveal(frame, t0 + at::ASKED, "asked".to_owned(), asked)}
            <g opacity={ramp(frame, t0 + 0.8)}>{reply}</g>
            {reveal(frame, t0 + at::REPORT, "pdf".to_owned(), report)}
        </g>
    </g>)
}

fn numbers<'a>(frame: &mut Frame, ctx: &FFramesContext<'a, '_>, t0: f32) -> Svgr<'a> {
    let t = frame.seconds();
    let head = line(frame, ctx, Line { text: "Minutes become seconds.", gray: 0b1, y: 230.0, size: 96, start: t0, key: "num", ..Line::default() });
    // A race on one shared clock, sped up 30x: a whole-room CFD solve against a whole-room
    // prediction at the slow end of its 10-20 s range. Bar lengths stay proportional.
    let clock = (t - (t0 + at::RACE)).max(0.0) * at::RACE_SPEEDUP;
    let lanes = [("CFD SOLVE", 24.0 * 60.0, GRAY, 400.0), ("AEROTWIN", 20.0, CYAN, 500.0)];
    let rows: Vec<Svgr> = lanes
        .into_iter()
        .map(|(name, total, color, y)| {
            let elapsed = clock.min(total);
            let done = clock >= total;
            let readout = format!("{}:{:02}", elapsed as u32 / 60, elapsed as u32 % 60);
            let tick = if done {
                fframes::svgr!(<path d={format!("M1676 {} l10 10 l20 -22", y - 18.0)} fill="none" stroke={color} stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />)
            } else {
                Svgr::empty()
            };
            fframes::svgr!(<g>
                {label(260.0, y, name, color, "start")}
                <rect x="560" y={y - 14.0} width="900" height="10" rx="5" fill={BORDER} />
                <rect x="560" y={y - 14.0} width={(900.0 * elapsed / total).max(0.5)} height="10" rx="5" fill={color} />
                <text x="1650" y={y} text-anchor="end" font-family={MONO} font-weight="500" font-size="34" fill={if done { color } else { TEXT }}>{readout}</text>
                {tick}
            </g>)
        })
        .collect();
    let race = fframes::svgr!(<g>
        {rows}
        {label(960.0, 590.0, "SAME CLOCK FOR BOTH, SPED UP 30×", DIM, "middle")}
    </g>);
    let room = line(frame, ctx, Line { text: "10–20\u{a0}s", x: 560.0, y: 800.0, size: 110, fill: CYAN, start: t0 + at::FIGURES[0], key: "room", ..Line::default() });
    let temp = line(frame, ctx, Line { text: "<\u{a0}0.25\u{a0}°C", x: 1360.0, y: 800.0, size: 110, start: t0 + at::FIGURES[1], key: "temp", ..Line::default() });
    let notes = fframes::svgr!(<g opacity={ramp(frame, t0 + 3.2)}>
        {label(560.0, 866.0, "WHOLE ROOM, ONE GPU", GRAY, "middle")}
        {label(1360.0, 866.0, "AVG. TEMPERATURE ERROR", GRAY, "middle")}
        {label(960.0, 960.0, "MEASURED ON HELD-OUT CFD TEST CASES", DIM, "middle")}
    </g>);
    fframes::svgr!(<g>
        {head}
        {reveal(frame, t0 + 0.5, "race".to_owned(), race)}
        <path d="M960 700 V880" stroke={BORDER} stroke-width="2" />
        {room}{temp}{notes}
    </g>)
}

fn uses<'a>(frame: &mut Frame, t0: f32, component: &'a dyn Component) -> Svgr<'a> {
    // Half speed: the source rolls a word every 0.67 s, too quick to read three applications.
    // The component is sized for a 718 px wide recording and centres its lead-in, not the whole
    // sentence: enlarge it to closing-title scale and pull the sentence back to the middle.
    let body = host(frame, component, t0 + at::ROLL, at::USES_RATE);
    let scaled = fframes::svgr!(<g transform="translate(-200 0) translate(960 540) scale(1.5) translate(-960 -540)">{body}</g>);
    reveal(frame, t0, "uses".to_owned(), scaled)
}

fn outro<'a>(frame: &mut Frame, ctx: &FFramesContext<'a, '_>, t0: f32) -> Svgr<'a> {
    let name = wordmark(frame, ctx, 960.0, 510.0, t0, "outro");
    let tagline = line(frame, ctx, Line { text: "Indoor airflow, from hours to seconds.", gray: 0b11, y: 630.0, size: 52, weight: 500, start: t0 + 0.8, stagger: 0.06, key: "bye", ..Line::default() });
    let team = fframes::svgr!(<g>
        <path d="M760 790 H1160" stroke={BORDER} stroke-width="2" />
        {label(960.0, 860.0, "PROJECT TEAM", DIM, "middle")}
        <text x="960" y="920" text-anchor="middle" font-family={SANS} font-weight="500" font-size="34" fill={GRAY}>"Tran Khanh Thanh · Do Chi Hai · Nguyen Anh Duc"</text>
    </g>);
    fframes::svgr!(<g>{name}{tagline}{reveal(frame, t0 + 2.0, "team".to_owned(), team)}</g>)
}
