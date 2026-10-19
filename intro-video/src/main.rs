use fframes::{EncoderOptions, RenderOptions, StaticMediaProvider, cli, pix_fmt::YuvMatrix};
use fframes_skia_renderer::{SkiaFFramesRenderer, SkiaPipelineConcurrencyPolicy, SkiaPipelineConfig, vulkan::SkiaVulkanCtx};
use aerotwin_intro::{AeroTwinIntroMedia, AeroTwinIntroVideo, OUT_HEIGHT, OUT_WIDTH};
use std::process::ExitCode;

fn main() -> ExitCode {
    let media = AeroTwinIntroMedia::prepare().expect("media");
    let video = AeroTwinIntroVideo::new(&media);
    let gpu = SkiaVulkanCtx::new(OUT_WIDTH, OUT_HEIGHT).expect("Vulkan GPU context");

    cli::new(
        &video,
        RenderOptions {
            media: Some(&media),
            default_font: "Inter",
            video_encoder_options: EncoderOptions {
                preferred_encoder: Some("libx264"),
                codec_params: Some(&[("crf", "20"), ("preset", "medium"), ("tune", "animation")]),
                color_matrix: YuvMatrix::Bt709,
                // Linux has no libx264 here and falls back to MPEG-4 Part 2, whose default
                // quantizers (15-60) block up badly: keep that file near lossless, as the
                // master for the H.264 transcode.
                #[cfg(target_os = "linux")]
                qmin: 1,
                #[cfg(target_os = "linux")]
                qmax: 3,
                #[cfg(target_os = "linux")]
                bitrate: Some(400_000_000),
                ..Default::default()
            },
            ..Default::default()
        },
    )
    // Rendering and frame previews (frame, strip, onion) run on the GPU through Skia.
    .backend(
        SkiaFFramesRenderer::new_vulkan(
            &gpu,
            SkiaPipelineConfig { concurrency_policy: SkiaPipelineConcurrencyPolicy::MaxPerformance, ..Default::default() },
        )
        .expect("skia renderer"),
    )
    // `preview` opens the real-time GPU player.
    .preview(fframes_native_player::cli_preview)
    .run()
}
