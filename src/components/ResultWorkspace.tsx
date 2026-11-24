import { useEffect, useRef, useState, type MouseEvent } from 'react';
import {
  AlertCircle,
  AudioLines,
  Check,
  Copy,
  Download,
  FileAudio,
  Film,
  Loader2,
  Pause,
  Play,
  Volume2,
} from 'lucide-react';
import type { DubbingResult, JobProgressEvent } from '../types/dubstudio.ts';

const BRAND_MARK_IMG = '/src/assets/images/sadavox_brand_mark_1795261292897.jpg';

interface ResultWorkspaceProps {
  jobState: JobProgressEvent | null;
  result: DubbingResult | null;
  isGeneratingSample: boolean;
  onRunSampleDemo: () => void;
}

const PIPELINE_STEPS = [
  { threshold: 8, label: '01. Media Extract' },
  { threshold: 30, label: '02. Speech & Emotion' },
  { threshold: 58, label: '03. Translation' },
  { threshold: 74, label: '04. Synthesis & Sync' },
];

export function ResultWorkspace({
  jobState,
  result,
  isGeneratingSample,
  onRunSampleDemo,
}: ResultWorkspaceProps) {
  const [videoTrack, setVideoTrack] = useState<'dubbed' | 'original'>('dubbed');
  const [copiedField, setCopiedField] = useState<'transcript' | 'translation' | null>(null);
  const [liveElapsedSec, setLiveElapsedSec] = useState(0);
  const [emblemBroken, setEmblemBroken] = useState(false);

  // Interactive Web Audio waveform playback state
  const [peaks, setPeaks] = useState<number[]>([]);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [audioCurrentSec, setAudioCurrentSec] = useState(0);
  const [audioTotalSec, setAudioTotalSec] = useState(0);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (jobState?.status !== 'processing') {
      return;
    }
    const baseElapsed = jobState.elapsedSec || 0;
    const syncedAt = Date.now();
    setLiveElapsedSec(baseElapsed);
    const id = window.setInterval(() => {
      setLiveElapsedSec(baseElapsed + (Date.now() - syncedAt) / 1000);
    }, 100);
    return () => window.clearInterval(id);
  }, [jobState?.status, jobState?.jobId, jobState?.elapsedSec]);

  // Reset track selector to dubbed output whenever a new job completes
  useEffect(() => {
    setVideoTrack('dubbed');
  }, [result?.jobId]);

  // Decode compact dubbed MP3 (falling back to WAV) to render real acoustic peaks without stalling large files
  useEffect(() => {
    setIsAudioPlaying(false);
    setAudioCurrentSec(0);
    setAudioTotalSec(result?.dubbedDurationSec || 0);
    setSaveNotice(null);

    const waveformSrc = result?.dubbedAudioMp3Url || result?.dubbedAudioWavUrl;
    if (!waveformSrc) {
      setPeaks([]);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      try {
        const res = await fetch(waveformSrc, { signal: controller.signal });
        if (!res.ok) return;
        const arrBuf = await res.arrayBuffer();
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AudioCtx();
        const decoded = await ctx.decodeAudioData(arrBuf);
        const channel = decoded.getChannelData(0);
        const bucketCount = 92;
        const step = Math.max(1, Math.floor(channel.length / bucketCount));
        const computed: number[] = [];

        for (let b = 0; b < bucketCount; b++) {
          const start = b * step;
          const end = Math.min(channel.length, start + step);
          let peak = 0;
          for (let i = start; i < end; i += 4) {
            const abs = Math.abs(channel[i]);
            if (abs > peak) peak = abs;
          }
          computed.push(Math.max(0.08, Math.min(1, peak)));
        }

        await ctx.close().catch(() => {});
        if (!cancelled) {
          setPeaks(computed);
          setAudioTotalSec(decoded.duration || result.dubbedDurationSec);
        }
      } catch {
        // Leave fallback clean bars if decode unavailable
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [result?.dubbedAudioMp3Url, result?.dubbedAudioWavUrl, result?.dubbedDurationSec]);

  // Paint waveform canvas whenever peaks or playback time change
  useEffect(() => {
    const canvas = waveCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const barValues =
      peaks.length > 0
        ? peaks
        : Array.from({ length: 92 }, (_, idx) => 0.25 + ((idx * 17) % 11) * 0.04);

    const gap = 3;
    const barW = Math.max(2, (w - gap * (barValues.length - 1)) / barValues.length);
    const ratio = audioTotalSec > 0 ? Math.min(1, audioCurrentSec / audioTotalSec) : 0;
    const playedIndex = Math.floor(ratio * barValues.length);

    for (let i = 0; i < barValues.length; i++) {
      const val = barValues[i];
      const barH = Math.max(4, val * (h - 10));
      const x = i * (barW + gap);
      const y = (h - barH) / 2;
      ctx.fillStyle = i <= playedIndex && audioCurrentSec > 0 ? '#F59E0B' : '#334155';
      ctx.fillRect(x, y, barW, barH);
    }
  }, [peaks, audioCurrentSec, audioTotalSec]);

  async function handleCopy(text: string, field: 'transcript' | 'translation') {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      window.setTimeout(() => setCopiedField(null), 1600);
    } catch {
      // Ignore clipboard permission failure
    }
  }

  function handleToggleAudioPlay() {
    const audio = audioElRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play();
    } else {
      audio.pause();
    }
  }

  function handleWaveformSeek(e: MouseEvent<HTMLCanvasElement>) {
    const canvas = waveCanvasRef.current;
    const audio = audioElRef.current;
    if (!canvas || !audio || !audioTotalSec) return;
    const rect = canvas.getBoundingClientRect();
    const clickRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = clickRatio * audioTotalSec;
    setAudioCurrentSec(audio.currentTime);
  }

  async function handleDesktopAwareSave(
    e: MouseEvent<HTMLAnchorElement>,
    urlPath: string,
    defaultFilename: string
  ) {
    if (!window.sadavoxDesktop?.isDesktop) {
      return;
    }
    e.preventDefault();
    try {
      const outcome = await window.sadavoxDesktop.saveFileAs(urlPath, defaultFilename);
      if (outcome.saved && outcome.filePath) {
        setSaveNotice(`Saved to ${outcome.filePath}`);
        window.setTimeout(() => setSaveNotice(null), 4000);
      }
    } catch (err) {
      setSaveNotice(err instanceof Error ? err.message : 'Save failed.');
    }
  }

  // Processing state
  if (jobState && jobState.status === 'processing') {
    return (
      <div className="rounded-xl border border-slate-800 bg-[#10151D] p-6 lg:p-8 flex flex-col justify-between min-h-[480px]">
        <div className="space-y-7">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium text-amber-400">Mastering Pipeline Active</p>
              <h3 className="mt-1 text-lg font-semibold text-slate-100">
                {jobState.stage}
              </h3>
            </div>
            <span className="font-mono text-sm font-semibold text-amber-400 tabular-nums shrink-0">
              {liveElapsedSec.toFixed(1)}s
            </span>
          </div>

          <div className="space-y-2.5">
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full bg-amber-500 transition-all duration-300 ease-out"
                style={{ width: `${Math.max(4, Math.min(100, jobState.progress))}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>Pipeline Progress</span>
              <span className="font-mono font-medium text-slate-200 tabular-nums">
                {Math.round(jobState.progress)}%
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 border-t border-slate-800 pt-6">
            {PIPELINE_STEPS.map((step) => {
              const reached = jobState.progress >= step.threshold;
              return (
                <div
                  key={step.label}
                  className={`rounded-lg border px-3 py-2.5 text-xs transition-colors ${
                    reached
                      ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                      : 'border-slate-800 bg-[#0B0F16] text-slate-500'
                  }`}
                >
                  {step.label}
                </div>
              );
            })}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs text-slate-400">
            <div className="flex items-center gap-2.5">
              <Loader2 className="h-4 w-4 animate-spin text-amber-400 shrink-0" />
              <span>Extracting speech & analyzing prosodic warmth</span>
            </div>
            <div className="flex items-center gap-2.5">
              <Volume2 className="h-4 w-4 text-slate-400 shrink-0" />
              <span>Aligning tempo & original media duration</span>
            </div>
          </div>
        </div>

        <p className="text-xs text-slate-500 border-t border-slate-800 pt-4">
          Neural synthesis and FFmpeg muxing run locally on your studio engine with zero token limits.
        </p>
      </div>
    );
  }

  // Error state
  if (jobState && jobState.status === 'error') {
    return (
      <div className="rounded-xl border border-red-900/80 bg-[#10151D] p-6 lg:p-8 min-h-[340px] flex flex-col justify-center">
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
          <div className="space-y-2">
            <h3 className="text-base font-semibold text-slate-100">
              Dubbing Job Could Not Complete
            </h3>
            <p className="text-sm text-slate-300 leading-relaxed">
              {jobState.error || 'An unexpected error occurred while processing the media.'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Empty state
  if (!result) {
    return (
      <div className="rounded-xl border border-slate-800 bg-[#10151D] p-6 lg:p-8 flex flex-col justify-between min-h-[480px]">
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center gap-5">
            <div className="h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-slate-800 bg-[#0B0F16] flex items-center justify-center">
              {!emblemBroken ? (
                <img
                  src={BRAND_MARK_IMG}
                  alt="SadaVox Studio acoustic emblem"
                  referrerPolicy="no-referrer"
                  onError={() => setEmblemBroken(true)}
                  className="h-full w-full object-cover"
                />
              ) : (
                <AudioLines className="h-8 w-8 text-amber-400" />
              )}
            </div>
            <div>
              <p className="text-xs font-medium text-amber-400">Studio Output Monitor</p>
              <h3 className="mt-1 text-lg font-semibold text-slate-100">
                Ready for Emotion-Matched Dubbing
              </h3>
              <p className="mt-1.5 text-sm text-slate-400 max-w-xl leading-relaxed">
                Upload a video, paste a direct media link, or record live from your microphone. SadaVox captures vocal warmth, translates into natural spoken Pashto or 10+ languages, and synchronizes exact media duration.
              </p>
            </div>
          </div>

          <div className="border-t border-slate-800 pt-6 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-5 text-sm">
            <div>
              <p className="font-medium text-slate-100">01. Speech & Emotion Analysis</p>
              <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                Measures RMS energy, vocal warmth, active cadence, and speaking pace before translation.
              </p>
            </div>
            <div>
              <p className="font-medium text-slate-100">02. Cadence-Aware Translation</p>
              <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                Produces idiomatic Pashto, Arabic, Dari, Urdu, and global scripts aligned with original timing.
              </p>
            </div>
            <div>
              <p className="font-medium text-slate-100">03. Free Unlimited Neural Voices</p>
              <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                Runs Kamran Ahmad (ps-AF-GulNawazNeural) and 16 additional personas without paid API plans.
              </p>
            </div>
            <div>
              <p className="font-medium text-slate-100">04. Duration & Ambient Mix</p>
              <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                Applies FFmpeg tempo alignment and mixes subtle background ambience into .mp4, .wav, and .mp3.
              </p>
            </div>
          </div>
        </div>

        <div className="border-t border-slate-800 pt-5 flex flex-wrap items-center justify-between gap-4">
          <span className="text-xs text-slate-400">
            Test the full studio pipeline right away with a generated English → Pashto clip.
          </span>
          <button
            type="button"
            disabled={isGeneratingSample}
            onClick={onRunSampleDemo}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-[#0B0F16] px-4 py-2 text-xs font-medium text-slate-100 hover:border-amber-500/60 hover:text-amber-300 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {isGeneratingSample ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" />
            ) : (
              <Play className="h-3.5 w-3.5 text-amber-400" />
            )}
            {isGeneratingSample ? 'Preparing Sample...' : 'Run Sample English → Pashto Dub'}
          </button>
        </div>
      </div>
    );
  }

  const ep = result.analysis.emotionProfile;
  const activeVideoSrc =
    videoTrack === 'original' && result.sourcePreviewUrl
      ? result.sourcePreviewUrl
      : result.dubbedVideoUrl;

  return (
    <div className="rounded-xl border border-slate-800 bg-[#10151D] overflow-hidden">
      {/* Media Playback Stage */}
      <div className="p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-slate-100">
              Dubbed Studio Output
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              {result.analysis.detectedSourceLanguage} → {result.analysis.targetLanguage} · {result.voice.name} ({result.voice.edgeVoiceName})
            </p>
          </div>

          {result.dubbedVideoUrl && result.sourcePreviewUrl && (
            <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-[#0B0F16] p-1">
              <button
                type="button"
                onClick={() => setVideoTrack('dubbed')}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  videoTrack === 'dubbed'
                    ? 'bg-slate-800 text-amber-400'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Dubbed Video
              </button>
              <button
                type="button"
                onClick={() => setVideoTrack('original')}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  videoTrack === 'original'
                    ? 'bg-slate-800 text-amber-400'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Original Video
              </button>
            </div>
          )}
        </div>

        {activeVideoSrc && (
          <div className="overflow-hidden rounded-lg border border-slate-800 bg-[#05070A]">
            <video
              key={activeVideoSrc}
              controls
              playsInline
              preload="metadata"
              src={activeVideoSrc}
              className="w-full max-h-[340px] object-contain"
            />
          </div>
        )}

        {/* Interactive Dubbed Audio Waveform Monitor */}
        <div className="rounded-lg border border-slate-800 bg-[#0B0F16] p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={handleToggleAudioPlay}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-amber-500 text-slate-950 hover:bg-amber-400 transition-colors cursor-pointer shrink-0"
                title={isAudioPlaying ? 'Pause master' : 'Play master'}
              >
                {isAudioPlaying ? (
                  <Pause className="h-4 w-4 fill-current" />
                ) : (
                  <Play className="h-4 w-4 fill-current ml-0.5" />
                )}
              </button>
              <div>
                <p className="text-xs font-medium text-slate-200">Dubbed Voice Master (.wav)</p>
                <p className="text-xs text-slate-500 font-mono tabular-nums">
                  {audioCurrentSec.toFixed(1)}s / {audioTotalSec.toFixed(1)}s · 44.1 kHz Stereo
                </p>
              </div>
            </div>
            <span className="text-xs text-slate-500 hidden sm:inline">Click waveform to seek</span>
          </div>

          <canvas
            ref={waveCanvasRef}
            width={680}
            height={52}
            onClick={handleWaveformSeek}
            className="w-full h-[52px] cursor-pointer rounded-md"
          />

          <audio
            ref={audioElRef}
            controls
            src={result.dubbedAudioWavUrl}
            onPlay={() => setIsAudioPlaying(true)}
            onPause={() => setIsAudioPlaying(false)}
            onEnded={() => setIsAudioPlaying(false)}
            onTimeUpdate={(e) => setAudioCurrentSec(e.currentTarget.currentTime)}
            onLoadedMetadata={(e) => {
              if (Number.isFinite(e.currentTarget.duration)) {
                setAudioTotalSec(e.currentTarget.duration);
              }
            }}
            className="w-full h-9"
          />
        </div>

        {/* Downloads */}
        <div className="flex flex-wrap items-center gap-3 pt-1">
          {result.dubbedVideoUrl && (
            <a
              href={`${result.dubbedVideoUrl}?download=1`}
              download={`sadavox-${result.jobId}.mp4`}
              onClick={(e) =>
                handleDesktopAwareSave(e, result.dubbedVideoUrl!, `sadavox-${result.jobId}.mp4`)
              }
              className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0"
            >
              <Film className="h-3.5 w-3.5" />
              Save Dubbed Video (.mp4)
            </a>
          )}
          <a
            href={`${result.dubbedAudioWavUrl}?download=1`}
            download={`sadavox-${result.jobId}.wav`}
            onClick={(e) =>
              handleDesktopAwareSave(e, result.dubbedAudioWavUrl, `sadavox-${result.jobId}.wav`)
            }
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-[#0B0F16] px-4 py-2 text-xs font-medium text-slate-200 hover:border-amber-500/60 hover:text-amber-300 transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="h-3.5 w-3.5" />
            Save Voice (.wav)
          </a>
          <a
            href={`${result.dubbedAudioMp3Url}?download=1`}
            download={`sadavox-${result.jobId}.mp3`}
            onClick={(e) =>
              handleDesktopAwareSave(e, result.dubbedAudioMp3Url, `sadavox-${result.jobId}.mp3`)
            }
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-[#0B0F16] px-4 py-2 text-xs font-medium text-slate-200 hover:border-amber-500/60 hover:text-amber-300 transition-colors whitespace-nowrap shrink-0"
          >
            <FileAudio className="h-3.5 w-3.5" />
            Save Voice (.mp3)
          </a>
        </div>

        {saveNotice && (
          <p className="text-xs text-emerald-300 bg-emerald-950/50 border border-emerald-800/70 rounded-md px-3 py-2">
            {saveNotice}
          </p>
        )}
      </div>

      {/* 4-Column Tabular Metrics Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 border-t border-b border-slate-800 divide-y sm:divide-y-0 sm:divide-x divide-slate-800 bg-[#0D1118]">
        <div className="px-5 py-3.5">
          <p className="text-xs text-slate-400">Process Time</p>
          <p className="mt-1 font-mono text-sm font-semibold text-slate-100 tabular-nums">
            {result.processTimeSec.toFixed(2)}s
          </p>
        </div>
        <div className="px-5 py-3.5">
          <p className="text-xs text-slate-400">Length Match</p>
          <p className="mt-1 font-mono text-sm font-semibold text-slate-100 tabular-nums">
            {result.originalDurationSec.toFixed(2)}s → {result.dubbedDurationSec.toFixed(2)}s
          </p>
        </div>
        <div className="px-5 py-3.5">
          <p className="text-xs text-slate-400">Tempo Factor</p>
          <p className="mt-1 font-mono text-sm font-semibold text-slate-100 tabular-nums">
            {result.tempoFactor.toFixed(2)}x
          </p>
        </div>
        <div className="px-5 py-3.5">
          <p className="text-xs text-slate-400">Synthesis Engine</p>
          <p className="mt-1 text-sm font-semibold text-amber-300 truncate">
            {result.engineUsed}
          </p>
        </div>
      </div>

      {/* Emotion & Vocal Direction Analysis */}
      <div className="p-6 space-y-5 border-b border-slate-800">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h4 className="text-sm font-semibold text-slate-100">
            Emotion & Vocal Direction
          </h4>
          <span className="text-xs text-slate-400">
            {ep.primaryEmotion} · {ep.secondaryNuance} · Pace: {ep.speakingPace}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400">Energy Level</span>
              <span className="font-mono font-medium text-slate-200 tabular-nums">
                {ep.energyLevel.toFixed(2)}
              </span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
              <div
                className="h-full bg-slate-300"
                style={{ width: `${Math.round(ep.energyLevel * 100)}%` }}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400">Warmth Level</span>
              <span className="font-mono font-medium text-amber-400 tabular-nums">
                {ep.warmthLevel.toFixed(2)}
              </span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
              <div
                className="h-full bg-amber-500"
                style={{ width: `${Math.round(ep.warmthLevel * 100)}%` }}
              />
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-slate-800 bg-[#0B0F16] px-4 py-3">
          <p className="text-xs font-medium text-slate-400">Applied Vocal Direction</p>
          <p className="mt-1 text-sm text-slate-200 leading-relaxed">{ep.vocalDirection}</p>
        </div>
      </div>

      {/* Transcript & Translation Comparison */}
      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-slate-800">
        <div className="p-6 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-400">
              Original Transcript ({result.analysis.detectedSourceLanguage})
            </span>
            <button
              type="button"
              onClick={() => handleCopy(result.analysis.fullTranscript, 'transcript')}
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 hover:text-amber-300 transition-colors cursor-pointer"
            >
              {copiedField === 'transcript' ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </>
              )}
            </button>
          </div>
          <p
            dir="auto"
            className="text-sm text-slate-200 leading-relaxed whitespace-pre-wrap"
          >
            {result.analysis.fullTranscript}
          </p>
        </div>

        <div className="p-6 space-y-2.5 bg-[#0D1118]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-400">
              Translated Script ({result.analysis.targetLanguage})
            </span>
            <button
              type="button"
              onClick={() => handleCopy(result.analysis.fullTranslation, 'translation')}
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 hover:text-amber-300 transition-colors cursor-pointer"
            >
              {copiedField === 'translation' ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </>
              )}
            </button>
          </div>
          <p
            dir="auto"
            className="text-sm text-slate-100 font-medium leading-relaxed whitespace-pre-wrap"
          >
            {result.analysis.fullTranslation}
          </p>
        </div>
      </div>
    </div>
  );
}
