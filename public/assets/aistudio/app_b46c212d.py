"""Gradio Interactive Desktop & Web Studio with progress tracking and file download."""

import os
from pathlib import Path
import gradio as gr
from dotenv import load_dotenv

from dubstudio.pipeline import run_dubbing_pipeline
from dubstudio.voices import SUPPORTED_LANGUAGES, VOICE_CATALOG

load_dotenv()

LANG_CHOICES = [(label, code) for code, label in SUPPORTED_LANGUAGES.items()]
TARGET_LANG_CHOICES = [(label, code) for code, label in SUPPORTED_LANGUAGES.items() if code != "auto"]
VOICE_CHOICES = [
    (f"{v.name} ({v.language_name} · {v.gender} · {v.character})", v.id)
    for v in VOICE_CATALOG
]


def _format_emotion_summary(result) -> str:
    ep = result.analysis.emotion_profile
    return (
        f"Process Time: {result.process_time_sec:.2f}s | Progress: 100% Complete\n"
        f"Length Match: Original {result.original_duration_sec:.2f}s == Dubbed {result.dubbed_duration_sec:.2f}s "
        f"(Tempo: {result.tempo_factor:.2f}x)\n"
        f"Detected Source Language: {result.analysis.detected_source_language}\n"
        f"Target Language: {result.analysis.target_language}\n"
        f"Selected Voice: {result.voice.name} (ElevenLabs ID: {result.voice.elevenlabs_voice_id})\n"
        f"Synthesis Engine: {result.engine_used}\n"
        f"Primary Emotion: {ep.primary_emotion} ({ep.secondary_nuance})\n"
        f"Energy: {ep.energy_level:.2f} | Warmth: {ep.warmth_level:.2f} | Pace: {ep.speaking_pace}\n"
        f"Vocal Direction: {ep.vocal_direction}"
    )


def translate_video_handler(
    video_url,
    video_file,
    source_lang,
    target_lang,
    voice_id,
    bg_mix,
    engine,
    save_folder,
    progress=gr.Progress(),
):
    out_dir = Path(save_folder).expanduser() if save_folder and save_folder.strip() else None

    def _on_progress(frac: float, desc: str) -> None:
        progress(frac, desc=desc)

    result = run_dubbing_pipeline(
        source_lang=source_lang,
        target_lang=target_lang,
        voice_identifier=voice_id,
        video_url=video_url or None,
        video_file_path=Path(video_file) if video_file else None,
        output_dir=out_dir,
        preserve_bg_audio=float(bg_mix),
        engine=engine,
        on_progress=_on_progress,
    )
    return (
        str(result.dubbed_video_path) if result.dubbed_video_path else None,
        str(result.dubbed_audio_path),
        str(result.dubbed_video_path) if result.dubbed_video_path else None,
        str(result.dubbed_mp3_path) if result.dubbed_mp3_path.exists() else str(result.dubbed_audio_path),
        result.analysis.full_transcript,
        result.analysis.full_translation,
        _format_emotion_summary(result),
    )


def translate_voice_handler(
    mic_audio,
    uploaded_audio,
    source_lang,
    target_lang,
    voice_id,
    engine,
    save_folder,
    progress=gr.Progress(),
):
    chosen_audio = mic_audio or uploaded_audio
    if not chosen_audio:
        raise gr.Error("Record your voice with the microphone or upload an audio file first.")

    out_dir = Path(save_folder).expanduser() if save_folder and save_folder.strip() else None

    def _on_progress(frac: float, desc: str) -> None:
        progress(frac, desc=desc)

    result = run_dubbing_pipeline(
        source_lang=source_lang,
        target_lang=target_lang,
        voice_identifier=voice_id,
        audio_file_path=Path(chosen_audio),
        output_dir=out_dir,
        engine=engine,
        on_progress=_on_progress,
    )
    return (
        str(result.dubbed_audio_path),
        str(result.dubbed_audio_path),
        str(result.dubbed_mp3_path) if result.dubbed_mp3_path.exists() else None,
        result.analysis.full_transcript,
        result.analysis.full_translation,
        _format_emotion_summary(result),
    )


with gr.Blocks(title="SadaVox Studio — Video & Voice Dubbing") as demo:
    gr.Markdown(
        "# SadaVox Video & Voice Dubbing Studio\n"
        "Translate video links, local videos, audio files, or live microphone recordings "
        "with natural ElevenLabs & Gemini voices (including **Pashto — Kamran Ahmad**) "
        "while preserving emotional tone and matching the original duration."
    )

    with gr.Tabs():
        with gr.Tab("Video Link & File Dubbing"):
            with gr.Row():
                with gr.Column():
                    video_url = gr.Textbox(
                        label="Paste Video Link (YouTube, Vimeo, or direct MP4 URL)",
                        placeholder="https://...",
                    )
                    video_file = gr.Video(label="Or Upload Video File")
                    with gr.Row():
                        v_src = gr.Dropdown(LANG_CHOICES, value="auto", label="Source Language")
                        v_tgt = gr.Dropdown(TARGET_LANG_CHOICES, value="ps", label="Target Language")
                    v_voice = gr.Dropdown(VOICE_CHOICES, value="kamran_ahmad_ps", label="Natural Voice Persona")
                    with gr.Row():
                        bg_mix = gr.Slider(0.0, 0.35, value=0.08, step=0.02, label="Original Ambient Bed Volume")
                        v_engine = gr.Radio(["auto", "elevenlabs", "gemini", "edge"], value="auto", label="Synthesis Engine")
                    v_save_dir = gr.Textbox(
                        label="Save Output to Computer Folder (optional)",
                        placeholder="./outputs",
                        value="./outputs",
                    )
                    v_btn = gr.Button("Translate & Dub Video", variant="primary")

                with gr.Column():
                    out_video = gr.Video(label="Dubbed Video Preview")
                    out_v_audio = gr.Audio(label="Dubbed Audio Preview (.wav)", type="filepath")
                    with gr.Row():
                        dl_video = gr.File(label="Save Dubbed Video (.mp4) to Computer")
                        dl_v_mp3 = gr.File(label="Save Dubbed Voice (.mp3) to Computer")
                    v_emotion = gr.Textbox(label="Process Time, Length Match & Emotion Report", lines=9)
                    v_transcript = gr.Textbox(label="Original Transcript", lines=4)
                    v_translation = gr.Textbox(label="Translated Script", lines=4)

            v_btn.click(
                translate_video_handler,
                inputs=[video_url, video_file, v_src, v_tgt, v_voice, bg_mix, v_engine, v_save_dir],
                outputs=[out_video, out_v_audio, dl_video, dl_v_mp3, v_transcript, v_translation, v_emotion],
            )

        with gr.Tab("Voice & Live Microphone Translator"):
            with gr.Row():
                with gr.Column():
                    mic_audio = gr.Audio(sources=["microphone"], type="filepath", label="Record Your Voice")
                    up_audio = gr.Audio(sources=["upload"], type="filepath", label="Or Upload Audio File")
                    with gr.Row():
                        a_src = gr.Dropdown(LANG_CHOICES, value="auto", label="Source Language")
                        a_tgt = gr.Dropdown(TARGET_LANG_CHOICES, value="ps", label="Target Language")
                    a_voice = gr.Dropdown(VOICE_CHOICES, value="kamran_ahmad_ps", label="Natural Voice Persona")
                    a_engine = gr.Radio(["auto", "elevenlabs", "gemini", "edge"], value="auto", label="Synthesis Engine")
                    a_save_dir = gr.Textbox(
                        label="Save Output to Computer Folder (optional)",
                        placeholder="./outputs",
                        value="./outputs",
                    )
                    a_btn = gr.Button("Translate Voice with Emotion Match", variant="primary")

                with gr.Column():
                    out_a_audio = gr.Audio(label="Emotion-Matched Translated Voice (.wav)", type="filepath")
                    with gr.Row():
                        dl_a_wav = gr.File(label="Save Voice (.wav) to Computer")
                        dl_a_mp3 = gr.File(label="Save Voice (.mp3) to Computer")
                    a_emotion = gr.Textbox(label="Process Time, Length Match & Emotion Report", lines=9)
                    a_transcript = gr.Textbox(label="Original Speech Transcript", lines=4)
                    a_translation = gr.Textbox(label="Translated Speech Script", lines=4)

            a_btn.click(
                translate_voice_handler,
                inputs=[mic_audio, up_audio, a_src, a_tgt, a_voice, a_engine, a_save_dir],
                outputs=[out_a_audio, dl_a_wav, dl_a_mp3, a_transcript, a_translation, a_emotion],
            )


if __name__ == "__main__":
    port = int(os.getenv("PORT", "7860"))
    demo.launch(server_name="0.0.0.0", server_port=port)
