"""Command-line interface for SadaVox Video & Voice Dubbing Studio."""

import argparse
from pathlib import Path
from dotenv import load_dotenv
from rich.console import Console
from rich.panel import Panel
from rich.progress import Progress, SpinnerColumn, TextColumn, TimeElapsedColumn

from dubstudio.pipeline import run_dubbing_pipeline
from dubstudio.voices import VOICE_CATALOG

load_dotenv()
console = Console()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Translate video/audio speech into another language while matching emotional tone and original duration."
    )
    parser.add_argument("--url", help="Video URL (YouTube, Vimeo, or direct MP4)")
    parser.add_argument("--input", help="Local video or audio file path")
    parser.add_argument("--source", default="auto", help="Source language code (default: auto)")
    parser.add_argument("--target", default="ps", help="Target language code (e.g., ps, en, ar, ur, fa)")
    parser.add_argument(
        "--voice",
        default="GSSiRsPYkmClFf80bZi2",
        help="Voice ID or ElevenLabs Voice ID (default: Kamran Ahmad Pashto GSSiRsPYkmClFf80bZi2)",
    )
    parser.add_argument("--bg-volume", type=float, default=0.08, help="Original background audio bed mix (0.0 - 0.3)")
    parser.add_argument("--engine", choices=["auto", "elevenlabs", "gemini", "edge"], default="auto")
    parser.add_argument("--output-dir", default="outputs", help="Directory to save output files")
    parser.add_argument("--output", help="Optional exact output file path (.mp4, .wav, or .mp3) to store on computer")
    parser.add_argument("--list-voices", action="store_true", help="List available natural voice personas")

    args = parser.parse_args()

    if args.list_voices:
        for v in VOICE_CATALOG:
            console.print(
                f"[bold]{v.name}[/bold] | id={v.id} | elevenlabs={v.elevenlabs_voice_id} | {v.language_name} ({v.character})"
            )
        return

    input_path = Path(args.input) if args.input else None
    is_audio_only = input_path and input_path.suffix.lower() in {".wav", ".mp3", ".m4a", ".ogg", ".webm", ".flac"}

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        TimeElapsedColumn(),
        console=console,
    ) as progress:
        task_id = progress.add_task("Starting dubbing pipeline...", total=100)

        def _on_progress(fraction: float, message: str) -> None:
            progress.update(task_id, completed=int(fraction * 100), description=f"{int(fraction * 100)}% — {message}")

        result = run_dubbing_pipeline(
            source_lang=args.source,
            target_lang=args.target,
            voice_identifier=args.voice,
            video_url=args.url,
            video_file_path=None if is_audio_only else input_path,
            audio_file_path=input_path if is_audio_only else None,
            output_dir=Path(args.output_dir),
            save_output_path=Path(args.output) if args.output else None,
            preserve_bg_audio=args.bg_volume,
            engine=args.engine,
            on_progress=_on_progress,
        )

    ep = result.analysis.emotion_profile
    console.print(
        Panel.fit(
            f"[bold]Process Time:[/bold] {result.process_time_sec:.2f}s (100% complete)\n"
            f"[bold]Length Match:[/bold] Original {result.original_duration_sec:.2f}s -> Dubbed {result.dubbed_duration_sec:.2f}s (Tempo {result.tempo_factor:.2f}x)\n"
            f"[bold]Voice:[/bold] {result.voice.name} ({result.voice.elevenlabs_voice_id})\n"
            f"[bold]Engine:[/bold] {result.engine_used}\n"
            f"[bold]Emotion Detected:[/bold] {ep.primary_emotion} — {ep.secondary_nuance}\n"
            f"[bold]Saved WAV:[/bold] {result.dubbed_audio_path}\n"
            f"[bold]Saved MP3:[/bold] {result.dubbed_mp3_path}\n"
            f"[bold]Saved Video:[/bold] {result.dubbed_video_path or 'N/A (Audio Only)'}",
            title="SadaVox Dubbing Complete",
        )
    )


if __name__ == "__main__":
    main()
