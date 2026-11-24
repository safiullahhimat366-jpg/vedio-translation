# SadaVox Python Video & Voice Dubbing Studio

Translate spoken audio in videos (from links or local files), voice files, or live microphone recordings from one language to another while preserving the original speaker's **emotional tone, warmth, and pacing**.

## Key Features

- **Video Link & File Dubbing**: Paste a video URL (`yt-dlp` supported links or direct MP4 URLs) or upload any `.mp4`, `.mov`, `.mkv`, `.webm` video.
- **Voice Translation & Live Mic Recording**: Translate standalone audio files or record directly from your microphone inside the Gradio studio.
- **Natural Male & Regional Voice Cast (ElevenLabs + Gemini TTS)**:
  - **Pashto**: `Kamran Ahmad - Calm & Friendly` (ElevenLabs ID: `GSSiRsPYkmClFf80bZi2`)
  - **Arabic, Dari/Persian, Urdu, Hindi, Turkish, English, Spanish, French, German, Mandarin** natural male & female voice profiles.
- **Emotional Tone Matching**: Analyzes the original speaker's emotional state (calm, warm, excited, urgent, empathetic, serious, joyful), energy level, and speaking cadence, then dynamically adapts synthesis stability, expressiveness (`style`), and prosodic direction so the dubbed audio matches the original performance.
- **Dual Synthesis Engine**: Uses **ElevenLabs Multilingual v2** when `ELEVENLABS_API_KEY` is configured, with automatic **Gemini 3.8 Flash TTS** (`gemini-3.8-flash-tts`) support using `GEMINI_API_KEY`.

## Prerequisites

- Python 3.10+
- `ffmpeg` installed on your system PATH (`brew install ffmpeg` on macOS, `sudo apt install ffmpeg` on Ubuntu/Debian)

## Setup

```bash
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

Add your keys to `.env`:
- `GEMINI_API_KEY`: Used for multimodal audio transcription, emotion analysis, translation, and Gemini TTS fallback.
- `ELEVENLABS_API_KEY` (optional): Used to synthesize directly with ElevenLabs voices such as Kamran Ahmad (`GSSiRsPYkmClFf80bZi2`).

## Run the Interactive Studio (Gradio)

```bash
python app.py
```

## Run from CLI

Translate a local video into Pashto using Kamran Ahmad's voice:

```bash
python cli.py --input interview.mp4 --source en --target ps --voice GSSiRsPYkmClFf80bZi2 --output interview_pashto.mp4
```

Translate from a video link into Arabic:

```bash
python cli.py --url "https://example.com/clip.mp4" --source auto --target ar --voice tariq_ar --output clip_arabic.mp4
```
