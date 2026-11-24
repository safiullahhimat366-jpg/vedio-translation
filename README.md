# SadaVox Studio — Standalone Desktop & Web Dubbing Workbench

Free, unlimited video and voice dubbing workbench with Pashto (`Kamran Ahmad`), Arabic, Dari/Persian, Urdu, and 8 additional languages. Preserves speaker emotion, pacing, and original ambient audio while supporting video uploads, direct media links, audio files, and live microphone recordings.

## Highlights

- **100% Free & Unlimited Local Mode (`Local + Edge (No Key)`)**: Runs acoustic emotion detection (`ffmpeg`), on-device Whisper speech-to-text (`@huggingface/transformers`), free translation (`bing-translate-api`), and neural Microsoft Edge TTS (`msedge-tts`) with zero API keys or rate limits.
- **Standalone Cross-Platform Desktop App (Electron)**: Includes a full native desktop shell (`electron/main.mjs`), embedded Express backend (`dist-desktop/server.mjs`), native OS Save-As dialogs, and automatic FFmpeg binary resolution (`ffmpeg-static` / `ffprobe-static`).
- **One-Click Native Installers**: Package standalone `.exe` (Windows NSIS + Portable), `.dmg` (macOS), or `.AppImage` / `.deb` (Linux) builds that run on any computer with zero external setup.

---

## Option A: Run Standalone Desktop App Directly

1. Install dependencies & desktop runtime (`electron`, `ffmpeg-static`, `ffprobe-static`):
   ```bash
   npm install
   npm install --no-save electron electron-builder ffmpeg-static ffprobe-static
   ```
   *(Or double-click `scripts/Start-SadaVox-Desktop.bat` on Windows / run `./scripts/Start-SadaVox-Desktop.sh` on macOS & Linux.)*

2. Build & launch the native desktop application:
   ```bash
   npm run desktop
   ```

3. **Build Standalone Installer for Any Computer** (bundles Chromium + Node + FFmpeg + Whisper):
   - **Windows (`.exe` Installer + Portable `.exe`)**:
     ```bash
     npm run desktop:dist:win
     ```
   - **macOS (`.dmg`)**:
     ```bash
     npm run desktop:dist:mac
     ```
   - **Linux (`.AppImage` & `.deb`)**:
     ```bash
     npm run desktop:dist:linux
     ```
   Generated standalone installers appear inside the `release/` folder.

---

## Option B: Run Local Web Studio Server

```bash
npm install
npm run dev
```
Open [http://localhost:3000](http://localhost:3000).
