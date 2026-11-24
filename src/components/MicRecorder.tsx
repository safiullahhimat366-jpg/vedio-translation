import { useEffect, useRef, useState } from 'react';
import { Mic, Square, Trash2 } from 'lucide-react';

interface MicRecorderProps {
  recordedFile: File | null;
  onRecorded: (file: File | null) => void;
  disabled?: boolean;
}

export function MicRecorder({ recordedFile, onRecorded, disabled }: MicRecorderProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (!recordedFile) {
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      return;
    }
    const url = URL.createObjectURL(recordedFile);
    setPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [recordedFile]);

  function stopVisualizer() {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
  }

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      stopVisualizer();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  function startVisualizer(stream: MediaStream) {
    stopVisualizer();
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const draw = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const c2d = canvas.getContext('2d');
        if (!c2d) return;

        analyser.getByteFrequencyData(dataArray);
        const w = canvas.width;
        const h = canvas.height;
        c2d.clearRect(0, 0, w, h);

        const bars = 28;
        const gap = 3;
        const barW = Math.max(2, (w - gap * (bars - 1)) / bars);

        for (let i = 0; i < bars; i++) {
          const val = dataArray[i % dataArray.length] / 255;
          const barH = Math.max(3, val * (h - 6));
          const x = i * (barW + gap);
          const y = (h - barH) / 2;
          c2d.fillStyle = val > 0.55 ? '#F59E0B' : '#94A3B8';
          c2d.fillRect(x, y, barW, barH);
        }

        rafRef.current = requestAnimationFrame(draw);
      };

      rafRef.current = requestAnimationFrame(draw);
    } catch {
      // Skip live visualizer if Web Audio Context fails
    }
  }

  async function startRecording() {
    setMicError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicError('Microphone capture is not supported in this environment.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '';

      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        stopVisualizer();
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });
        const ext = (recorder.mimeType || '').includes('mp4') ? 'm4a' : 'webm';
        const file = new File([blob], `mic-recording-${Date.now()}.${ext}`, {
          type: blob.type,
        });
        onRecorded(file);
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      };

      recorder.start(200);
      setIsRecording(true);
      setElapsedSec(0);
      startVisualizer(stream);

      const started = Date.now();
      timerRef.current = window.setInterval(() => {
        setElapsedSec((Date.now() - started) / 1000);
      }, 100);
    } catch (err) {
      setMicError(
        err instanceof Error ? err.message : 'Microphone permission was denied or unavailable.'
      );
    }
  }

  function stopRecording() {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    stopVisualizer();
    setIsRecording(false);
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  }

  function formatTimer(sec: number): string {
    const mins = Math.floor(sec / 60);
    const rem = sec % 60;
    return `${String(mins).padStart(2, '0')}:${rem.toFixed(1).padStart(4, '0')}`;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-[#0B0F16] px-3.5 py-3">
        <div className="flex items-center gap-3 min-w-0">
          {!isRecording ? (
            <button
              type="button"
              disabled={disabled}
              onClick={startRecording}
              className="inline-flex items-center gap-2 rounded-md bg-amber-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Mic className="h-3.5 w-3.5" />
              Record Voice
            </button>
          ) : (
            <button
              type="button"
              onClick={stopRecording}
              className="inline-flex items-center gap-2 rounded-md bg-red-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-red-500 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
              Stop Recording
            </button>
          )}
          <span className="text-xs text-slate-400 truncate">
            {isRecording
              ? 'Capturing live audio...'
              : recordedFile
                ? recordedFile.name
                : 'Capture speech from microphone'}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="font-mono text-xs font-medium text-amber-400 tabular-nums">
            {formatTimer(elapsedSec)}
          </span>
          {recordedFile && !isRecording && (
            <button
              type="button"
              onClick={() => onRecorded(null)}
              title="Clear recording"
              className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition-colors cursor-pointer"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {isRecording && (
        <div className="rounded-lg border border-amber-500/30 bg-[#0B0F16] px-3 py-2">
          <canvas ref={canvasRef} width={360} height={36} className="w-full h-9" />
        </div>
      )}

      {micError && (
        <p className="text-xs text-red-300 bg-red-950/60 border border-red-900 rounded-md px-3 py-2">
          {micError}
        </p>
      )}

      {previewUrl && !isRecording && (
        <audio controls src={previewUrl} className="w-full h-9" />
      )}
    </div>
  );
}
