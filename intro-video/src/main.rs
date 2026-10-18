use fframes::{EncoderOptions, RenderOptions, StaticMediaProvider, cli};
use aerotwin_intro::{AeroTwinIntroMedia, AeroTwinIntroVideo};
use std::process::ExitCode;

fn main() -> ExitCode {
    let media = AeroTwinIntroMedia::prepare().expect("media");
    let video = AeroTwinIntroVideo::new(&media);

    cli::new(
        &video,
        RenderOptions {
            media: Some(&media),
            default_font: "Inter",
            video_encoder_options: EncoderOptions {
                preferred_encoder: Some("libx264"),
                codec_params: Some(&[("crf", "20"), ("preset", "medium"), ("tune", "animation")]),
                ..Default::default()
            },
            ..Default::default()
        },
    )
    .run()
}
