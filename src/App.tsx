import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioLines,
  Download,
  Film,
  FolderOpen,
  Laptop,
  Loader2,
  Mic,
  Trash2,
  Upload,
  Video,
  X,
} from 'lucide-react';
import { MicRecorder } from './components/MicRecorder.tsx';
import { ResultWorkspace } from './components/ResultWorkspace.tsx';
import { VoiceCastSection } from './components/VoiceCastSection.tsx';
import type {
  DubbingResult,
  JobProgressEvent,
  LanguageOption,
  SynthesisEngineChoice,
  VoicePersona,
} from './types/dubstudio.ts';

const STUDIO_BANNER_IMG = '/src/assets/images/sadavox_studio_banner_1795261293535.jpg';
const DESKTOP_SHOWCASE_IMG = '/src/assets/images/sadavox_desktop_showcase_1795261293364.jpg';

const HISTORY_STORAGE_KEY = 'sadavox_recent_sessions_v1';
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024 * 1024; // 3 GB
const WEB_CHUNK_SIZE_BYTES = 1 * 1024 * 1024; // 1 MB safe for any web/cloud proxy
const DESKTOP_CHUNK_SIZE_BYTES = 4 * 1024 * 1024;
const CHUNK_THRESHOLD_BYTES = 1 * 1024 * 1024;

const FALLBACK_LANGUAGES: LanguageOption[] = [
  { code: 'auto', label: 'Auto-Detect Source', nativeName: 'Auto' },
  { code: 'ps', label: 'Pashto (پښتو)', nativeName: 'پښتو', rtl: true },
  { code: 'en', label: 'English', nativeName: 'English' },
  { code: 'ar', label: 'Arabic (العربية)', nativeName: 'العربية', rtl: true },
  { code: 'fa', label: 'Dari / Persian (دری / فارسی)', nativeName: 'دری / فارسی', rtl: true },
  { code: 'ur', label: 'Urdu (اردو)', nativeName: 'اردو', rtl: true },
];

const CLONE_VOICE_ID = 'clone_original_speaker';

const FALLBACK_VOICES: VoicePersona[] = [
  {
    id: CLONE_VOICE_ID,
    name: 'Clone Speaker Voice',
    languageCode: 'auto',
    languageName: 'All Languages (Matched)',
    gender: 'Auto',
    character: 'Matches Original Speaker Pitch & Timbre',
    elevenlabsVoiceId: 'clone_original_speaker',
    geminiVoiceName: 'Charon',
    edgeVoiceName: 'ps-AF-GulNawazNeural',
    baseStylePrompt: 'Clone the original speaker vocal pitch, tonal warmth, and natural cadence.',
    isClone: true,
  },
  {
    id: 'kamran_ahmad_ps',
    name: 'Kamran Ahmad',
    languageCode: 'ps',
    languageName: 'Pashto',
    gender: 'Male',
    character: 'Calm & Friendly',
    elevenlabsVoiceId: 'GSSiRsPYkmClFf80bZi2',
    geminiVoiceName: 'Charon',
    edgeVoiceName: 'ps-AF-GulNawazNeural',
    baseStylePrompt: 'Natural male Pashto speaker with calm, friendly cadence.',
  },
  {
    id: 'sherullah_ps',
    name: 'Sherullah',
    languageCode: 'ps',
    languageName: 'Pashto',
    gender: 'Male',
    character: 'Deep Documentary Bass',
    elevenlabsVoiceId: 'VR6AewLTigWG4xSOukaG',
    geminiVoiceName: 'Fenrir',
    edgeVoiceName: 'ps-AF-GulNawazNeural',
    pitchScale: 0.9,
    baseStylePrompt: 'Deep Pashto male narrator.',
  },
];

function isAudioMediaFile(file: File | null): boolean {
  if (!file) return false;
  if (file.type.startsWith('audio/')) return true;
  return /\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(file.name);
}

const DESKTOP_OS_GUIDES = {
  windows: {
    label: 'Windows (.exe)',
    launch: 'Double-click SadaVox-Desktop.bat',
    packageCmd: 'Double-click Build-Windows-EXE.bat',
    outputArtifact: 'release/SadaVox-Studio-1.0.0-x64.exe (NSIS Installer & Portable)',
    notes: 'Opens directly as a standalone desktop window (never in a browser) with embedded Node backend, FFmpeg/FFprobe binaries, Whisper ASR, and Edge Neural TTS.',
  },
  macos: {
    label: 'macOS (.dmg)',
    launch: './SadaVox-Desktop.sh',
    packageCmd: 'npm run desktop:dist:mac',
    outputArtifact: 'release/SadaVox-Studio-1.0.0-arm64.dmg (Apple Silicon & Intel)',
    notes: 'Runs self-contained inside ~/Library/Application Support/SadaVox Studio with automatic microphone permissions and Finder export.',
  },
  linux: {
    label: 'Linux (.AppImage)',
    launch: './SadaVox-Desktop.sh',
    packageCmd: 'npm run desktop:dist:linux',
    outputArtifact: 'release/SadaVox-Studio-1.0.0-x64.AppImage & .deb',
    notes: 'Portable AppImage and Debian package bundling embedded Express server, FFmpeg binaries, and local Whisper voice recognition.',
  },
} as const;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const parts: string[] = [];
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + step)));
  }
  return btoa(parts.join(''));
}

async function safeReadJson<T>(res: Response): Promise<T> {
  const raw = await res.text();
  try {
    return JSON.parse(raw) as T;
  } catch {
    const trimmed = raw.trim();
    if (trimmed.startsWith('<')) {
      throw new Error(
        `Upload proxy returned an HTML page (HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}). Please refresh the page to renew your session or use the Desktop app for files up to 3 GB.`
      );
    }
    throw new Error(
      trimmed.slice(0, 180) || `Unexpected non-JSON response (HTTP ${res.status})`
    );
  }
}

export default function App() {
  const [languages, setLanguages] = useState<LanguageOption[]>(FALLBACK_LANGUAGES);
  const [voices, setVoices] = useState<VoicePersona[]>(FALLBACK_VOICES);
  const [elevenlabsConfigured, setElevenlabsConfigured] = useState(false);
  const [isDesktopApp, setIsDesktopApp] = useState(false);

  const [mode, setMode] = useState<'video' | 'audio'>('video');
  const [desktopOsTab, setDesktopOsTab] = useState<'windows' | 'macos' | 'linux'>('windows');
  const [heroImgBroken, setHeroImgBroken] = useState(false);
  const [desktopImgBroken, setDesktopImgBroken] = useState(false);

  // Video inputs
  const [videoUrl, setVideoUrl] = useState('');
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [localVideoPreview, setLocalVideoPreview] = useState<string | null>(null);

  // Audio / Mic inputs
  const [micFile, setMicFile] = useState<File | null>(null);
  const [uploadedAudioFile, setUploadedAudioFile] = useState<File | null>(null);
  const [localAudioPreview, setLocalAudioPreview] = useState<string | null>(null);

  // Language, Voice, Engine
  const [sourceLang, setSourceLang] = useState('auto');
  const [targetLang, setTargetLang] = useState('ps');
  const [voiceId, setVoiceId] = useState(CLONE_VOICE_ID);
  const [bgMix, setBgMix] = useState(0.08);
  const [engine, setEngine] = useState<SynthesisEngineChoice>('auto');

  // Job state
  const [jobState, setJobState] = useState<JobProgressEvent | null>(null);
  const [result, setResult] = useState<DubbingResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isGeneratingSample, setIsGeneratingSample] = useState(false);

  // Recent sessions persisted locally
  const [recentSessions, setRecentSessions] = useState<DubbingResult[]>(() => {
    try {
      const saved = localStorage.getItem(HISTORY_STORAGE_KEY);
      return saved ? (JSON.parse(saved) as DubbingResult[]) : [];
    } catch {
      return [];
    }
  });

  const eventSourceRef = useRef<EventSource | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const audioInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (window.sadavoxDesktop?.isDesktop) {
      setIsDesktopApp(true);
    }

    fetch('/api/catalog')
      .then((res) =>
        safeReadJson<{
          languages: LanguageOption[];
          voices: VoicePersona[];
          elevenlabsConfigured: boolean;
        }>(res)
      )
      .then((data) => {
        if (Array.isArray(data.languages) && data.languages.length > 0) {
          setLanguages(data.languages);
        }
        if (Array.isArray(data.voices) && data.voices.length > 0) {
          setVoices(data.voices);
        }
        setElevenlabsConfigured(Boolean(data.elevenlabsConfigured));
      })
      .catch(() => {
        // Keep initial defaults if catalog fetch fails transiently
      });
  }, []);

  useEffect(() => {
    if (!videoFile) {
      setLocalVideoPreview((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      return;
    }
    const url = URL.createObjectURL(videoFile);
    setLocalVideoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [videoFile]);

  useEffect(() => {
    if (!uploadedAudioFile) {
      setLocalAudioPreview((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      return;
    }
    const url = URL.createObjectURL(uploadedAudioFile);
    setLocalAudioPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [uploadedAudioFile]);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(recentSessions.slice(0, 8)));
    } catch {
      // Ignore storage quota errors
    }
  }, [recentSessions]);

  const targetLanguages = useMemo(
    () => languages.filter((l) => l.code !== 'auto'),
    [languages]
  );

  const selectedVoice = useMemo(
    () => voices.find((v) => v.id === voiceId) ?? voices[0],
    [voices, voiceId]
  );

  const naturalVoices = useMemo(
    () => voices.filter((v) => !v.isClone),
    [voices]
  );

  const isCloneSelected = Boolean(selectedVoice?.isClone || voiceId === CLONE_VOICE_ID);
  const uploadedMainIsAudio = isAudioMediaFile(videoFile);

  const engineOptions = useMemo(() => {
    const base: Array<{ id: SynthesisEngineChoice; label: string }> = [
      { id: 'auto', label: 'Auto (Unlimited)' },
      { id: 'edge', label: 'Local + Edge (No Key)' },
      { id: 'gemini', label: 'Gemini TTS' },
    ];
    if (elevenlabsConfigured) {
      base.push({ id: 'elevenlabs', label: 'ElevenLabs' });
    }
    return base;
  }, [elevenlabsConfigured]);

  const isProcessing = jobState?.status === 'processing';
  const activeGuide = DESKTOP_OS_GUIDES[desktopOsTab];

  function handleTargetLanguageChange(nextLang: string) {
    setTargetLang(nextLang);
    if (voiceId === CLONE_VOICE_ID) return;
    const matchingVoice = naturalVoices.find((v) => v.languageCode === nextLang);
    if (matchingVoice && selectedVoice?.languageCode !== nextLang) {
      setVoiceId(matchingVoice.id);
    }
  }

  function handleSelectVoiceMode(nextMode: 'clone' | 'natural') {
    if (nextMode === 'clone') {
      setVoiceId(CLONE_VOICE_ID);
    } else {
      const preferred =
        naturalVoices.find((v) => v.languageCode === targetLang && v.gender === 'Male') ??
        naturalVoices.find((v) => v.languageCode === targetLang) ??
        naturalVoices[0];
      if (preferred) {
        setVoiceId(preferred.id);
      }
    }
  }

  function handleSelectVoiceFromCatalog(voice: VoicePersona) {
    setVoiceId(voice.id);
    if (!voice.isClone && voice.languageCode !== 'auto') {
      setTargetLang(voice.languageCode);
    }
    document.getElementById('studio')?.scrollIntoView({ behavior: 'smooth' });
  }

  function resetStudio() {
    eventSourceRef.current?.close();
    setVideoUrl('');
    setVideoFile(null);
    setMicFile(null);
    setUploadedAudioFile(null);
    setFormError(null);
    setJobState(null);
    setResult(null);
  }

  async function uploadFileInChunks(file: File): Promise<string> {
    const chunkSize = isDesktopApp ? DESKTOP_CHUNK_SIZE_BYTES : WEB_CHUNK_SIZE_BYTES;
    const initRes = await fetch('/api/upload/init', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, fileSize: file.size }),
    });
    const initData = await safeReadJson<{ uploadId?: string; error?: string }>(initRes);
    if (!initRes.ok || !initData.uploadId) {
      throw new Error(initData.error || 'Could not initialize chunked upload.');
    }

    const uploadId = initData.uploadId;
    const totalChunks = Math.ceil(file.size / chunkSize);
    let forceJsonFallback = false;

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(file.size, start + chunkSize);
      const slice = file.slice(start, end);

      setJobState((prev) => ({
        jobId: prev?.jobId || 'uploading',
        status: 'processing',
        progress: Math.max(1, Math.min(12, Math.round(((i + 0.5) / totalChunks) * 12))),
        stage: `Uploading media (${formatBytes(end)} / ${formatBytes(file.size)})...`,
        elapsedSec: prev?.elapsedSec || 0,
      }));

      let chunkSucceeded = false;
      let lastChunkErr: unknown;

      for (let attempt = 0; attempt < 3 && !chunkSucceeded; attempt++) {
        try {
          let chunkRes: Response;
          if (!forceJsonFallback && attempt === 0) {
            chunkRes = await fetch('/api/upload/chunk', {
              method: 'POST',
              credentials: 'same-origin',
              headers: {
                'Content-Type': 'application/octet-stream',
                'x-upload-id': uploadId,
                'x-chunk-index': String(i),
                'x-chunk-offset': String(start),
              },
              body: slice,
            });
          } else {
            forceJsonFallback = true;
            const buf = await slice.arrayBuffer();
            chunkRes = await fetch('/api/upload/chunk', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                uploadId,
                chunkIndex: i,
                offset: start,
                dataBase64: arrayBufferToBase64(buf),
              }),
            });
          }

          const chunkData = await safeReadJson<{ ok?: boolean; error?: string }>(chunkRes);
          if (!chunkRes.ok || !chunkData.ok) {
            throw new Error(chunkData.error || `Failed uploading chunk ${i + 1}.`);
          }
          chunkSucceeded = true;
        } catch (err) {
          lastChunkErr = err;
          forceJsonFallback = true;
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          }
        }
      }

      if (!chunkSucceeded) {
        throw lastChunkErr instanceof Error
          ? lastChunkErr
          : new Error(`Failed uploading chunk ${i + 1}.`);
      }
    }

    const completeRes = await fetch('/api/upload/complete', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId, filename: file.name, totalChunks }),
    });
    const completeData = await safeReadJson<{ uploadId?: string; error?: string }>(completeRes);
    if (!completeRes.ok || !completeData.uploadId) {
      throw new Error(completeData.error || 'Failed to finalize uploaded file.');
    }

    return completeData.uploadId;
  }

  async function submitDubbingJob(override?: {
    mode: 'video' | 'audio';
    file?: File;
    sourceLang?: string;
    targetLang?: string;
    voiceId?: string;
  }) {
    setFormError(null);

    const effectiveMode = override?.mode ?? mode;
    const effectiveSource = override?.sourceLang ?? sourceLang;
    const effectiveTarget = override?.targetLang ?? targetLang;
    const effectiveVoice = override?.voiceId ?? voiceId;

    const chosenFile =
      override?.file ??
      (effectiveMode === 'video' ? videoFile : micFile ?? uploadedAudioFile);

    if (effectiveMode === 'video' && !chosenFile && !videoUrl.trim()) {
      setFormError('Paste a direct media URL or upload a video / MP3 voice file first.');
      return;
    }

    if (effectiveMode === 'audio' && !chosenFile) {
      setFormError('Record your voice with the microphone or upload an audio file first.');
      return;
    }

    if (chosenFile && chosenFile.size > MAX_UPLOAD_BYTES) {
      setFormError(
        `Selected file (${formatBytes(chosenFile.size)}) exceeds the 3 GB limit.`
      );
      return;
    }

    eventSourceRef.current?.close();
    setResult(null);
    setJobState({
      jobId: 'pending',
      status: 'processing',
      progress: 4,
      stage: 'Preparing media for studio pipeline...',
      elapsedSec: 0,
    });

    try {
      let response: Response;
      const localFilePath =
        chosenFile && window.sadavoxDesktop?.getPathForFile
          ? window.sadavoxDesktop.getPathForFile(chosenFile)
          : '';

      if (chosenFile && localFilePath) {
        response = await fetch('/api/dub', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: effectiveMode,
            sourceLang: effectiveSource,
            targetLang: effectiveTarget,
            voiceId: effectiveVoice,
            bgMix: effectiveMode === 'video' ? bgMix : 0,
            engine,
            localFilePath,
            originalName: chosenFile.name,
          }),
        });
      } else if (chosenFile && chosenFile.size > CHUNK_THRESHOLD_BYTES) {
        const uploadId = await uploadFileInChunks(chosenFile);
        response = await fetch('/api/dub', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: effectiveMode,
            sourceLang: effectiveSource,
            targetLang: effectiveTarget,
            voiceId: effectiveVoice,
            bgMix: effectiveMode === 'video' ? bgMix : 0,
            engine,
            uploadId,
          }),
        });
      } else {
        const formData = new FormData();
        formData.append('mode', effectiveMode);
        formData.append('sourceLang', effectiveSource);
        formData.append('targetLang', effectiveTarget);
        formData.append('voiceId', effectiveVoice);
        formData.append('bgMix', String(effectiveMode === 'video' ? bgMix : 0));
        formData.append('engine', engine);

        if (chosenFile) {
          formData.append('media', chosenFile);
        } else if (videoUrl.trim()) {
          formData.append('videoUrl', videoUrl.trim());
        }

        response = await fetch('/api/dub', {
          method: 'POST',
          credentials: 'same-origin',
          body: formData,
        });
      }

      const payload = await safeReadJson<{ jobId?: string; error?: string }>(response);
      if (!response.ok || !payload.jobId) {
        throw new Error(payload.error || 'Failed to start dubbing job.');
      }

      const jobId = payload.jobId;
      const es = new EventSource(`/api/dub/events/${jobId}`);
      eventSourceRef.current = es;

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as JobProgressEvent;
          setJobState(data);
          if (data.status === 'completed' && data.result) {
            setResult(data.result);
            setRecentSessions((prev) => [
              data.result!,
              ...prev.filter((item) => item.jobId !== data.result!.jobId),
            ]);
            es.close();
          } else if (data.status === 'error') {
            es.close();
          }
        } catch {
          // Ignore malformed keepalive chunks
        }
      };

      es.onerror = async () => {
        es.close();
        try {
          const poll = await fetch(`/api/dub/status/${jobId}`);
          if (poll.ok) {
            const latest = await safeReadJson<JobProgressEvent>(poll);
            setJobState(latest);
            if (latest.status === 'completed' && latest.result) {
              setResult(latest.result);
            }
          }
        } catch {
          // Ignore network error on cleanup
        }
      };
    } catch (err) {
      setJobState({
        jobId: 'error',
        status: 'error',
        progress: 0,
        stage: 'Failed',
        elapsedSec: 0,
        error: err instanceof Error ? err.message : 'Unable to start dubbing job.',
      });
    }
  }

  async function handleLoadSampleAudio(sampleLang: 'en' | 'ps', autoRun: boolean) {
    setIsGeneratingSample(true);
    setFormError(null);
    try {
      const res = await fetch('/api/sample-audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang: sampleLang }),
      });
      if (!res.ok) {
        const errBody = await safeReadJson<{ error?: string }>(res).catch(() => ({
          error: undefined,
        }));
        throw new Error(errBody.error || 'Failed to generate sample audio clip.');
      }
      const contentType = res.headers.get('content-type') || 'audio/wav';
      const ext = contentType.includes('mpeg') ? 'mp3' : 'wav';
      const blob = await res.blob();
      const sampleFile = new File([blob], `sample_${sampleLang}_speech.${ext}`, {
        type: contentType,
      });
      setMode('audio');
      setMicFile(null);
      setUploadedAudioFile(sampleFile);

      if (autoRun) {
        setSourceLang('en');
        setTargetLang('ps');
        setVoiceId(CLONE_VOICE_ID);
        await submitDubbingJob({
          mode: 'audio',
          file: sampleFile,
          sourceLang: 'en',
          targetLang: 'ps',
          voiceId: CLONE_VOICE_ID,
        });
      }
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : 'Could not prepare sample audio.'
      );
    } finally {
      setIsGeneratingSample(false);
    }
  }

  return (
    <div id="top" className="min-h-screen bg-[#090C10] text-slate-100 flex flex-col">
      {/* 3-Zone Top Bar Contract */}
      <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-[#090C10]/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1380px] items-center justify-between gap-8 px-6 py-3.5">
          <a
            href="#top"
            className="font-display text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0"
          >
            SadaVox Studio
          </a>

          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-400">
            <a
              href="#studio"
              onClick={() => setMode('video')}
              className="hover:text-slate-100 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              Video Dubbing
            </a>
            <a
              href="#studio"
              onClick={() => setMode('audio')}
              className="hover:text-slate-100 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              Voice & Mic
            </a>
            <a
              href="#voice-cast"
              className="hover:text-slate-100 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              Voice Cast
            </a>
            <a
              href="#desktop-app"
              className="hover:text-slate-100 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
            >
              Desktop App
            </a>
          </nav>

          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={resetStudio}
              className="rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              New Dub
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1380px] flex-1 px-6 py-8 lg:py-10 space-y-14">
        {/* Editorial Studio Hero Showcase */}
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
          <div className="lg:col-span-7 flex flex-col justify-between rounded-xl border border-slate-800 bg-[#10151D] p-7 lg:p-8">
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <span>Free Video & Voice Dubbing</span>
                <span aria-hidden="true">·</span>
                <span>Pashto (Kamran Ahmad) & 11 Languages</span>
                <span aria-hidden="true">·</span>
                <span>Offline Whisper + Edge Neural</span>
              </div>
              <h1 className="text-2xl sm:text-4xl font-bold tracking-tight text-slate-100 text-balance leading-[1.15]">
                Broadcast-grade video and voice dubbing that preserves emotion and exact timing
              </h1>
              <p className="text-sm text-slate-400 max-w-2xl leading-relaxed">
                Translate films, tutorials, or live voice recordings into natural Pashto, Arabic, Dari, Urdu, and 7 global languages with zero API limits—both in your browser and as a standalone desktop application.
              </p>
            </div>

            <div className="mt-6 pt-5 border-t border-slate-800 flex flex-wrap items-center gap-3">
              <a
                href="#studio"
                className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0"
              >
                Open Mastering Workbench
              </a>
              <a
                href="/api/project-zip"
                download="sadavox-studio-desktop.zip"
                className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-[#0B0F16] px-4 py-2 text-xs font-medium text-slate-200 hover:border-amber-500/60 hover:text-amber-300 transition-colors whitespace-nowrap shrink-0"
              >
                <Download className="h-3.5 w-3.5 text-amber-400" />
                Download Desktop App (.zip)
              </a>
              {isDesktopApp && (
                <button
                  type="button"
                  onClick={() => void window.sadavoxDesktop?.openOutputsFolder()}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-[#0B0F16] px-4 py-2 text-xs font-medium text-slate-200 hover:border-amber-500/60 hover:text-amber-300 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <FolderOpen className="h-3.5 w-3.5 text-amber-400" />
                  Open Outputs Folder
                </button>
              )}
            </div>
          </div>

          <div className="lg:col-span-5 relative overflow-hidden rounded-xl border border-slate-800 bg-[#10151D] min-h-[240px]">
            {!heroImgBroken ? (
              <img
                src={STUDIO_BANNER_IMG}
                alt="SadaVox Studio mastering console desk with warm copper acoustic lighting"
                referrerPolicy="no-referrer"
                onError={() => setHeroImgBroken(true)}
                className="h-full w-full lg:h-full object-cover"
              />
            ) : (
              <div className="flex h-full min-h-[240px] flex-col items-center justify-center bg-gradient-to-br from-[#131924] to-[#0B0E14] p-6 text-center">
                <AudioLines className="h-10 w-10 text-amber-400" />
                <p className="mt-3 text-xs font-medium text-slate-300">
                  SadaVox Acoustic Mastering Console
                </p>
              </div>
            )}
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#090C10]/90 via-[#090C10]/25 to-transparent" />
            <div className="absolute bottom-4 left-5 right-5 flex items-center justify-between text-xs text-slate-200">
              <span className="font-medium">Kamran Ahmad · Pashto Neural Voice</span>
              <span className="font-mono text-amber-400 tabular-nums">44.1 kHz Stereo</span>
            </div>
          </div>
        </section>

        {/* 2-Column Studio Workbench */}
        <section id="studio" className="space-y-5">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Left Column: Input & Configuration Rack */}
            <div className="lg:col-span-5 rounded-xl border border-slate-800 bg-[#10151D] p-6 space-y-6">
              {/* Mode Switch */}
              <div className="grid grid-cols-2 gap-1 rounded-lg border border-slate-800 bg-[#0B0F16] p-1">
                <button
                  type="button"
                  onClick={() => {
                    setMode('video');
                    setFormError(null);
                  }}
                  className={`inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    mode === 'video'
                      ? 'bg-slate-800 text-amber-400'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Video className="h-3.5 w-3.5" />
                  Video & MP3 File
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode('audio');
                    setFormError(null);
                  }}
                  className={`inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    mode === 'audio'
                      ? 'bg-slate-800 text-amber-400'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Mic className="h-3.5 w-3.5" />
                  Live Mic & Voice
                </button>
              </div>

              {/* Media Input Area */}
              {mode === 'video' ? (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label
                      htmlFor="video-url-input"
                      className="block text-xs font-medium text-slate-300"
                    >
                      Direct Video or MP3 URL (.mp4, .mp3, .webm, .wav)
                    </label>
                    <input
                      id="video-url-input"
                      type="url"
                      value={videoUrl}
                      onChange={(e) => {
                        setVideoUrl(e.target.value);
                        if (e.target.value.trim()) setVideoFile(null);
                      }}
                      placeholder="https://example.com/clip.mp4 or speech.mp3"
                      className="w-full rounded-lg border border-slate-800 bg-[#0B0F16] px-3.5 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <span className="block text-xs font-medium text-slate-300">
                      Or Upload Video or MP3 / Voice File
                    </span>
                    <input
                      ref={videoInputRef}
                      type="file"
                      accept="video/*,audio/*,.mp4,.mov,.mkv,.webm,.mp3,.wav,.m4a,.ogg,.flac,.aac"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0] ?? null;
                        if (file) {
                          setVideoFile(file);
                          setVideoUrl('');
                        }
                      }}
                    />

                    {!videoFile ? (
                      <button
                        type="button"
                        onClick={() => videoInputRef.current?.click()}
                        className="w-full rounded-lg border border-dashed border-slate-700 bg-[#0B0F16] px-4 py-6 text-center hover:border-amber-500/60 hover:bg-[#0E131C] transition-colors cursor-pointer"
                      >
                        <Upload className="mx-auto h-5 w-5 text-amber-400" />
                        <p className="mt-2 text-xs font-medium text-slate-200">
                          Click to select a video or MP3 voice file
                        </p>
                        <p className="mt-0.5 text-xs text-slate-500">
                          MP4, MOV, MKV, WebM, MP3, WAV, or M4A up to 3 GB
                        </p>
                      </button>
                    ) : (
                      <div className="space-y-2.5">
                        <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-[#0B0F16] px-3.5 py-2.5">
                          <div className="flex items-center gap-2.5 min-w-0">
                            {uploadedMainIsAudio ? (
                              <AudioLines className="h-4 w-4 text-amber-400 shrink-0" />
                            ) : (
                              <Film className="h-4 w-4 text-amber-400 shrink-0" />
                            )}
                            <div className="min-w-0">
                              <p className="text-xs font-medium text-slate-100 truncate">
                                {videoFile.name}
                              </p>
                              <p className="text-xs text-slate-400 font-mono tabular-nums">
                                {formatBytes(videoFile.size)} · {uploadedMainIsAudio ? 'Audio / Voice' : 'Video'}
                              </p>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setVideoFile(null);
                              if (videoInputRef.current) videoInputRef.current.value = '';
                            }}
                            className="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100 cursor-pointer"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>

                        {localVideoPreview &&
                          (uploadedMainIsAudio ? (
                            <audio controls src={localVideoPreview} className="w-full h-9" />
                          ) : (
                            <video
                              controls
                              src={localVideoPreview}
                              className="w-full max-h-44 rounded-lg border border-slate-800 bg-[#05070A] object-contain"
                            />
                          ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <span className="block text-xs font-medium text-slate-300">
                      Live Microphone Recording
                    </span>
                    <MicRecorder
                      recordedFile={micFile}
                      disabled={isProcessing}
                      onRecorded={(file) => {
                        setMicFile(file);
                        if (file) setUploadedAudioFile(null);
                      }}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-slate-300">
                        Or Upload Audio File
                      </span>
                      <button
                        type="button"
                        disabled={isGeneratingSample || isProcessing}
                        onClick={() => handleLoadSampleAudio('en', false)}
                        className="text-xs font-medium text-amber-400 hover:text-amber-300 disabled:opacity-50 cursor-pointer"
                      >
                        {isGeneratingSample ? 'Generating...' : 'Load Sample English Clip'}
                      </button>
                    </div>
                    <input
                      ref={audioInputRef}
                      type="file"
                      accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm,.flac"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0] ?? null;
                        if (file) {
                          setUploadedAudioFile(file);
                          setMicFile(null);
                        }
                      }}
                    />

                    {!uploadedAudioFile ? (
                      <button
                        type="button"
                        onClick={() => audioInputRef.current?.click()}
                        className="w-full rounded-lg border border-dashed border-slate-700 bg-[#0B0F16] px-4 py-5 text-center hover:border-amber-500/60 hover:bg-[#0E131C] transition-colors cursor-pointer"
                      >
                        <AudioLines className="mx-auto h-5 w-5 text-amber-400" />
                        <p className="mt-2 text-xs font-medium text-slate-200">
                          Click to upload audio (.wav, .mp3, .m4a, .webm)
                        </p>
                      </button>
                    ) : (
                      <div className="space-y-2.5">
                        <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-[#0B0F16] px-3.5 py-2.5">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <AudioLines className="h-4 w-4 text-amber-400 shrink-0" />
                            <div className="min-w-0">
                              <p className="text-xs font-medium text-slate-100 truncate">
                                {uploadedAudioFile.name}
                              </p>
                              <p className="text-xs text-slate-400 font-mono tabular-nums">
                                {formatBytes(uploadedAudioFile.size)}
                              </p>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setUploadedAudioFile(null);
                              if (audioInputRef.current) audioInputRef.current.value = '';
                            }}
                            className="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100 cursor-pointer"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                        {localAudioPreview && (
                          <audio controls src={localAudioPreview} className="w-full h-9" />
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Language Pair */}
              <div className="border-t border-slate-800 pt-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label
                    htmlFor="source-lang"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Source Language
                  </label>
                  <select
                    id="source-lang"
                    value={sourceLang}
                    onChange={(e) => setSourceLang(e.target.value)}
                    className="w-full rounded-lg border border-slate-800 bg-[#0B0F16] px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                  >
                    {languages.map((lang) => (
                      <option key={lang.code} value={lang.code}>
                        {lang.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="target-lang"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Target Language
                  </label>
                  <select
                    id="target-lang"
                    value={targetLang}
                    onChange={(e) => handleTargetLanguageChange(e.target.value)}
                    className="w-full rounded-lg border border-slate-800 bg-[#0B0F16] px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                  >
                    {targetLanguages.map((lang) => (
                      <option key={lang.code} value={lang.code}>
                        {lang.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Voice Mode: Clone Speaker vs Natural Voice Cast */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-300">
                    Output Voice Selection
                  </span>
                  <span className="text-xs text-slate-400">
                    {isCloneSelected ? 'Clones Speaker Pitch & Tone' : 'Studio Natural Cast'}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-1 rounded-lg border border-slate-800 bg-[#0B0F16] p-1">
                  <button
                    type="button"
                    onClick={() => handleSelectVoiceMode('clone')}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      isCloneSelected
                        ? 'bg-slate-800 text-amber-400'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Clone Speaker Voice
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSelectVoiceMode('natural')}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      !isCloneSelected
                        ? 'bg-slate-800 text-amber-400'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Natural Male / Female
                  </button>
                </div>

                {isCloneSelected ? (
                  <div className="rounded-lg border border-amber-500/30 bg-[#0B0F16] px-3.5 py-2.5 text-xs text-slate-300 leading-relaxed">
                    Automatically measures the speaker's vocal pitch (Hz), gender register, warmth, and cadence from your video or MP3, then clones that vocal signature into {languages.find((l) => l.code === targetLang)?.label ?? targetLang}.
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <label
                      htmlFor="voice-persona"
                      className="block text-xs font-medium text-slate-300"
                    >
                      Select Natural Voice Persona
                    </label>
                    <select
                      id="voice-persona"
                      value={voiceId}
                      onChange={(e) => setVoiceId(e.target.value)}
                      className="w-full rounded-lg border border-slate-800 bg-[#0B0F16] px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                    >
                      {naturalVoices.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name} ({v.languageName} · {v.gender} · {v.character})
                        </option>
                      ))}
                    </select>
                    {selectedVoice && (
                      <p className="text-xs text-slate-400 font-mono tabular-nums">
                        Edge: {selectedVoice.edgeVoiceName} · Gemini: {selectedVoice.geminiVoiceName}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Engine & Ambient Bed */}
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-300">
                      Voice Synthesis Engine
                    </span>
                    <span className="text-xs text-slate-400">
                      Free · Unlimited Local Fallback
                    </span>
                  </div>
                  <div
                    className={`grid gap-1 rounded-lg border border-slate-800 bg-[#0B0F16] p-1 ${
                      engineOptions.length === 4 ? 'grid-cols-4' : 'grid-cols-3'
                    }`}
                  >
                    {engineOptions.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setEngine(item.id)}
                        className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          engine === item.id
                            ? 'bg-slate-800 text-amber-400'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>

                {mode === 'video' && !uploadedMainIsAudio && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <label htmlFor="bg-mix" className="font-medium text-slate-300">
                        Original Ambient Bed Volume
                      </label>
                      <span className="font-mono font-medium text-amber-400 tabular-nums">
                        {Math.round(bgMix * 100)}%
                      </span>
                    </div>
                    <input
                      id="bg-mix"
                      type="range"
                      min={0}
                      max={0.35}
                      step={0.02}
                      value={bgMix}
                      onChange={(e) => setBgMix(Number(e.target.value))}
                      className="w-full accent-amber-500 cursor-pointer"
                    />
                  </div>
                )}
              </div>

              {formError && (
                <p className="text-xs text-red-300 bg-red-950/60 border border-red-900 rounded-lg px-3.5 py-2.5">
                  {formError}
                </p>
              )}

              <button
                type="button"
                disabled={isProcessing}
                onClick={() => submitDubbingJob()}
                className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-amber-500 px-5 py-2.5 text-sm font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {isProcessing && <Loader2 className="h-4 w-4 animate-spin" />}
                {isProcessing
                  ? 'Processing Dubbing Pipeline...'
                  : mode === 'video' && !uploadedMainIsAudio
                    ? 'Translate & Dub Media'
                    : 'Translate & Dub Voice'}
              </button>
            </div>

            {/* Right Column: Live Progress, Waveform Preview & Emotion Report */}
            <div className="lg:col-span-7">
              <ResultWorkspace
                jobState={jobState}
                result={result}
                isGeneratingSample={isGeneratingSample}
                onRunSampleDemo={() => handleLoadSampleAudio('en', true)}
              />
            </div>
          </div>
        </section>

        {/* Natural Voice Cast Directory */}
        <VoiceCastSection
          voices={voices}
          selectedVoiceId={voiceId}
          onSelectVoice={handleSelectVoiceFromCatalog}
        />

        {/* Standalone Cross-Platform Desktop Application Showcase */}
        <section id="desktop-app" className="border-t border-slate-800/80 pt-10 space-y-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-slate-100 tracking-tight">
                Standalone Desktop Application
              </h2>
              <p className="mt-1 text-sm text-slate-400">
                Run SadaVox Studio completely independently on any Windows, macOS, or Linux computer with embedded FFmpeg and local Whisper.
              </p>
            </div>
            <a
              href="/api/project-zip"
              download="sadavox-studio-desktop.zip"
              className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0"
            >
              <Download className="h-3.5 w-3.5" />
              Download Desktop Package (.zip)
            </a>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
            <div className="lg:col-span-5 relative overflow-hidden rounded-xl border border-slate-800 bg-[#10151D] min-h-[260px]">
              {!desktopImgBroken ? (
                <img
                  src={DESKTOP_SHOWCASE_IMG}
                  alt="SadaVox Studio standalone desktop workstation display"
                  referrerPolicy="no-referrer"
                  onError={() => setDesktopImgBroken(true)}
                  className="h-full w-full lg:h-full object-cover"
                />
              ) : (
                <div className="flex h-full min-h-[260px] flex-col items-center justify-center bg-[#0D1118] p-6 text-center">
                  <Laptop className="h-10 w-10 text-amber-400" />
                  <p className="mt-3 text-xs font-medium text-slate-300">
                    Standalone Cross-Platform Desktop Shell
                  </p>
                </div>
              )}
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#090C10]/90 via-transparent to-transparent" />
              <div className="absolute bottom-4 left-5 right-5 flex items-center justify-between text-xs text-slate-200">
                <span className="font-medium">Electron + Embedded Node + Bundled FFmpeg</span>
                <span className="font-mono text-amber-400">Win / Mac / Linux</span>
              </div>
            </div>

            <div className="lg:col-span-7 rounded-xl border border-slate-800 bg-[#10151D] p-6 flex flex-col justify-between space-y-5">
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-xs font-medium text-slate-300">
                    Target Operating System Build
                  </span>
                  <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-[#0B0F16] p-1">
                    {(['windows', 'macos', 'linux'] as const).map((osKey) => (
                      <button
                        key={osKey}
                        type="button"
                        onClick={() => setDesktopOsTab(osKey)}
                        className={`rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          desktopOsTab === osKey
                            ? 'bg-slate-800 text-amber-400'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {DESKTOP_OS_GUIDES[osKey].label}
                      </button>
                    ))}
                  </div>
                </div>

                <p className="text-sm text-slate-300 leading-relaxed">
                  {activeGuide.notes}
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
                  <div className="rounded-lg border border-slate-800 bg-[#0B0F16] p-3.5 space-y-1">
                    <p className="text-xs text-slate-400">1-Click Desktop Launch</p>
                    <p className="font-mono text-xs text-amber-300 break-all">
                      {activeGuide.launch}
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-[#0B0F16] p-3.5 space-y-1">
                    <p className="text-xs text-slate-400">Standalone Installer Build</p>
                    <p className="font-mono text-xs text-slate-200 break-all">
                      {activeGuide.packageCmd}
                    </p>
                  </div>
                </div>
              </div>

              <div className="border-t border-slate-800 pt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
                <span>Output Artifact: <span className="font-mono text-slate-200">{activeGuide.outputArtifact}</span></span>
                <span>Zero Python or Cloud Keys Required</span>
              </div>
            </div>
          </div>
        </section>

        {/* Recent Studio Sessions */}
        <section id="sessions" className="border-t border-slate-800/80 pt-10">
          <div className="flex items-end justify-between gap-4 mb-5">
            <div>
              <h2 className="text-xl font-semibold text-slate-100 tracking-tight">
                Recent Studio Sessions
              </h2>
              <p className="mt-1 text-sm text-slate-400">
                Completed dubbing runs saved locally for quick script and waveform review.
              </p>
            </div>
            {recentSessions.length > 0 && (
              <button
                type="button"
                onClick={() => setRecentSessions([])}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-red-400 transition-colors cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Clear History
              </button>
            )}
          </div>

          {recentSessions.length === 0 ? (
            <div className="rounded-xl border border-slate-800 bg-[#10151D] px-6 py-8 text-center">
              <p className="text-sm text-slate-400">
                No completed dubbing sessions yet. Run a video, audio file, microphone recording, or sample clip above.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-800 bg-[#10151D]">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-800 bg-[#0D1118] text-xs font-medium text-slate-400">
                    <th className="py-3 px-4">Language Pair</th>
                    <th className="py-3 px-4">Voice Persona</th>
                    <th className="py-3 px-4">Emotion</th>
                    <th className="py-3 px-4">Duration</th>
                    <th className="py-3 px-4">Engine</th>
                    <th className="py-3 px-4 text-right">Open</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70 text-sm">
                  {recentSessions.map((session) => (
                    <tr key={session.jobId} className="hover:bg-slate-800/35 transition-colors">
                      <td className="py-2.5 px-4 font-medium text-slate-100 whitespace-nowrap">
                        {session.analysis.detectedSourceLanguage} → {session.analysis.targetLanguage}
                      </td>
                      <td className="py-2.5 px-4 text-slate-300 whitespace-nowrap">
                        {session.voice.name}
                      </td>
                      <td className="py-2.5 px-4 text-slate-400 whitespace-nowrap">
                        {session.analysis.emotionProfile.primaryEmotion}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-xs text-slate-300 tabular-nums whitespace-nowrap">
                        {session.originalDurationSec.toFixed(1)}s ({session.tempoFactor.toFixed(2)}x)
                      </td>
                      <td className="py-2.5 px-4 text-slate-400 whitespace-nowrap">
                        {session.engineUsed}
                      </td>
                      <td className="py-2.5 px-4 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => {
                            setResult(session);
                            setJobState({
                              jobId: session.jobId,
                              status: 'completed',
                              progress: 100,
                              stage: 'Dubbing complete',
                              elapsedSec: session.processTimeSec,
                              result: session,
                            });
                            document.getElementById('studio')?.scrollIntoView({ behavior: 'smooth' });
                          }}
                          className="rounded-md border border-slate-700 bg-[#0B0F16] px-3 py-1 text-xs font-medium text-slate-200 hover:border-amber-500/60 hover:text-amber-300 transition-colors cursor-pointer"
                        >
                          Inspect
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>

      <footer className="border-t border-slate-800/80 bg-[#090C10]">
        <div className="mx-auto flex max-w-[1380px] flex-wrap items-center justify-between gap-4 px-6 py-4 text-xs text-slate-500">
          <span>SadaVox Studio — Free Standalone Desktop & Web Dubbing Workbench</span>
          <div className="flex flex-wrap items-center gap-4">
            <span>Pashto (Kamran Ahmad), Arabic, Dari/Persian, Urdu & 7 additional languages</span>
            <a
              href="/api/project-zip"
              download="sadavox-studio-desktop.zip"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-800 bg-[#10151D] px-3 py-1.5 font-medium text-slate-200 hover:border-amber-500/60 hover:text-amber-300 transition-colors"
            >
              <Download className="h-3.5 w-3.5 text-amber-400" />
              Download Desktop Bundle (.zip)
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
