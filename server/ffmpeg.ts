import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const moduleRequire: NodeRequire =
  typeof require === 'function'
    ? require
    : createRequire(pathToFileURL(path.join(process.cwd(), 'package.json')).href);

function resolveDesktopBinary(pkgName: 'ffmpeg-static' | 'ffprobe-static', binaryName: string): string {
  const envKey = binaryName === 'ffmpeg' ? process.env.FFMPEG_PATH : process.env.FFPROBE_PATH;
  if (envKey && fs.existsSync(envKey)) {
    return envKey;
  }

  try {
    const loaded = moduleRequire(pkgName) as string | { path?: string };
    let candidate = typeof loaded === 'string' ? loaded : loaded?.path;
    if (candidate && candidate.includes('app.asar') && !candidate.includes('app.asar.unpacked')) {
      const unpacked = candidate.replace('app.asar', 'app.asar.unpacked');
      if (fs.existsSync(unpacked)) {
        candidate = unpacked;
      }
    }
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  } catch {
    // Optional desktop binary package not installed; check local bin or system PATH
  }

  const exeSuffix = process.platform === 'win32' ? '.exe' : '';
  const electronResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const localCandidates = [
    path.join(process.cwd(), 'bin', `${binaryName}${exeSuffix}`),
    ...(electronResourcesPath
      ? [path.join(electronResourcesPath, 'bin', `${binaryName}${exeSuffix}`)]
      : []),
  ];
  for (const candidate of localCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return binaryName;
}

export function getFfmpegPath(): string {
  return resolveDesktopBinary('ffmpeg-static', 'ffmpeg');
}

export function getFfprobePath(): string {
  return resolveDesktopBinary('ffprobe-static', 'ffprobe');
}

export interface MediaProbeInfo {
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec?: string;
  videoPixFmt?: string;
}

export async function probeMedia(filePath: string): Promise<MediaProbeInfo> {
  const { stdout } = await execFileAsync(getFfprobePath(), [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);

  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      pix_fmt?: string;
      duration?: string;
    }>;
  };

  const streams = parsed.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');

  const rawDuration =
    Number(parsed.format?.duration) ||
    Number(audioStream?.duration) ||
    Number(videoStream?.duration) ||
    0;

  return {
    durationSec: Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 1,
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream),
    videoCodec: videoStream?.codec_name,
    videoPixFmt: videoStream?.pix_fmt,
  };
}

export async function splitAudioIntoSegments(
  inputAudioPath: string,
  segmentDir: string,
  segmentSec = 150
): Promise<string[]> {
  await fs.promises.mkdir(segmentDir, { recursive: true });
  const pattern = path.join(segmentDir, 'seg_%04d.mp3');
  await execFileAsync(getFfmpegPath(), [
    '-y',
    '-i',
    inputAudioPath,
    '-f',
    'segment',
    '-segment_time',
    String(segmentSec),
    '-c',
    'copy',
    pattern,
  ]);
  const files = (await fs.promises.readdir(segmentDir))
    .filter((f) => f.startsWith('seg_') && f.endsWith('.mp3'))
    .sort()
    .map((f) => path.join(segmentDir, f));
  return files;
}

export async function concatAudioFiles(
  inputPaths: string[],
  outWavPath: string
): Promise<void> {
  if (inputPaths.length === 0) {
    throw new Error('No audio segments were synthesized.');
  }
  if (inputPaths.length === 1) {
    await execFileAsync(getFfmpegPath(), [
      '-y',
      '-i',
      inputPaths[0],
      '-acodec',
      'pcm_s16le',
      '-ar',
      '44100',
      '-ac',
      '2',
      outWavPath,
    ]);
    return;
  }

  const args: string[] = ['-y'];
  for (const p of inputPaths) {
    args.push('-i', p);
  }
  const concatInputs = inputPaths
    .map((_, idx) => `[${idx}:a]aformat=sample_rates=44100:channel_layouts=stereo[a${idx}]`)
    .join(';');
  const streamRefs = inputPaths.map((_, idx) => `[a${idx}]`).join('');
  const filterComplex = `${concatInputs};${streamRefs}concat=n=${inputPaths.length}:v=0:a=1[outa]`;

  args.push(
    '-filter_complex',
    filterComplex,
    '-map',
    '[outa]',
    '-acodec',
    'pcm_s16le',
    '-ar',
    '44100',
    '-ac',
    '2',
    outWavPath
  );
  await execFileAsync(getFfmpegPath(), args);
}

export async function extractAudioForAnalysis(
  inputPath: string,
  outWavPath: string,
  outMp3Path: string
): Promise<void> {
  // 44.1kHz stereo WAV for ambient background mixing
  await execFileAsync(getFfmpegPath(), [
    '-y',
    '-i',
    inputPath,
    '-vn',
    '-acodec',
    'pcm_s16le',
    '-ar',
    '44100',
    '-ac',
    '2',
    outWavPath,
  ]);

  // Compact normalized 16kHz mono MP3 for fast multimodal Gemini transcription & emotion analysis
  await execFileAsync(getFfmpegPath(), [
    '-y',
    '-i',
    outWavPath,
    '-af',
    'highpass=f=80,dynaudnorm=f=150:g=15:p=0.9',
    '-ar',
    '16000',
    '-ac',
    '1',
    '-b:a',
    '32k',
    outMp3Path,
  ]);
}

function buildAtempoChain(tempo: number): string {
  const filters: string[] = [];
  let remaining = tempo;
  while (remaining > 2.0) {
    filters.push('atempo=2.0');
    remaining /= 2.0;
  }
  while (remaining < 0.5) {
    filters.push('atempo=0.5');
    remaining /= 0.5;
  }
  filters.push(`atempo=${remaining.toFixed(4)}`);
  return filters.join(',');
}

async function measureAudioPitchHz(audioPath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      getFfmpegPath(),
      ['-v', 'quiet', '-i', audioPath, '-f', 'f32le', '-acodec', 'pcm_f32le', '-ar', '16000', '-ac', '1', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 12 * 1024 * 1024 }
    );
    const buf = stdout as unknown as Buffer;
    const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
    if (samples.length < 1600) return 128;

    const sampleRate = 16000;
    const maxSamples = Math.min(samples.length, sampleRate * 15);
    const frameLen = 512;
    const hopLen = 256;
    const minLag = Math.floor(sampleRate / 300);
    const maxLag = Math.floor(sampleRate / 72);
    const f0: number[] = [];

    for (let start = 0; start + frameLen <= maxSamples; start += hopLen) {
      let energy = 0;
      for (let i = 0; i < frameLen; i++) {
        energy += samples[start + i] * samples[start + i];
      }
      if (Math.sqrt(energy / frameLen) < 0.014) continue;

      let bestLag = 0;
      let bestCorr = 0;
      for (let lag = minLag; lag <= maxLag; lag++) {
        let num = 0;
        let normA = 0;
        let normB = 0;
        const limit = frameLen - lag;
        for (let i = 0; i < limit; i++) {
          const a = samples[start + i];
          const b = samples[start + i + lag];
          num += a * b;
          normA += a * a;
          normB += b * b;
        }
        const denom = Math.sqrt(normA * normB);
        if (denom > 1e-8) {
          const corr = num / denom;
          if (corr > bestCorr) {
            bestCorr = corr;
            bestLag = lag;
          }
        }
      }
      if (bestLag > 0 && bestCorr >= 0.42) {
        f0.push(sampleRate / bestLag);
      }
    }

    if (f0.length === 0) return 128;
    f0.sort((a, b) => a - b);
    return Math.round(f0[Math.floor(f0.length / 2)]);
  } catch {
    return 128;
  }
}

export interface CloneTargetProfile {
  pitchHz: number;
  estimatedGender: 'Male' | 'Female';
  brightness: number;
  warmth: number;
}

export interface FinalizeMediaOptions {
  rawSpeechPath: string;
  sourceAudioWavPath: string;
  sourceVideoPath?: string;
  videoCodec?: string;
  videoPixFmt?: string;
  originalDurationSec: number;
  preserveBgAudio: number;
  pitchScale?: number;
  cloneTargetProfile?: CloneTargetProfile;
  outputWavPath: string;
  outputMp3Path: string;
  outputVideoPath?: string;
}

export interface FinalizeMediaResult {
  dubbedDurationSec: number;
  tempoFactor: number;
}

export async function finalizeDubbedMedia(
  opts: FinalizeMediaOptions
): Promise<FinalizeMediaResult> {
  const speechInfo = await probeMedia(opts.rawSpeechPath);
  const rawDuration = Math.max(0.2, speechInfo.durationSec);
  const targetDuration = Math.max(0.5, opts.originalDurationSec);

  // Compute pitch & timbre shaping for speaker voice cloning or distinct male vocal personas
  const voiceFilters: string[] = [];
  let pitchRatio = 1;

  if (opts.cloneTargetProfile) {
    const ttsPitchHz = await measureAudioPitchHz(opts.rawSpeechPath);
    const rawRatio = opts.cloneTargetProfile.pitchHz / Math.max(70, ttsPitchHz);
    pitchRatio = Math.min(1.22, Math.max(0.80, rawRatio));
  } else if (opts.pitchScale && Math.abs(opts.pitchScale - 1) > 0.01) {
    pitchRatio = Math.min(1.22, Math.max(0.80, opts.pitchScale));
  }

  if (Math.abs(pitchRatio - 1) > 0.015) {
    const pitchedRate = Math.round(44100 * pitchRatio);
    voiceFilters.push(`asetrate=${pitchedRate}`, 'aresample=44100', buildAtempoChain(1 / pitchRatio));
  }

  if (opts.cloneTargetProfile) {
    const bassGain = ((opts.cloneTargetProfile.warmth - 0.5) * 4.5).toFixed(1);
    const trebleGain = ((opts.cloneTargetProfile.brightness - 0.5) * 4.0).toFixed(1);
    if (Math.abs(Number(bassGain)) >= 0.3) {
      voiceFilters.push(`bass=g=${bassGain}:f=180`);
    }
    if (Math.abs(Number(trebleGain)) >= 0.3) {
      voiceFilters.push(`treble=g=${trebleGain}:f=3500`);
    }
  }

  // Compute tempo adjustment and clamp to preserve natural voice quality
  const idealTempo = rawDuration / targetDuration;
  const tempoFactor = Math.min(1.55, Math.max(0.72, idealTempo));
  const atempoFilter = buildAtempoChain(tempoFactor);
  const voiceFilterChain = [...voiceFilters, atempoFilter].join(',');

  const hasBgMix = opts.preserveBgAudio > 0.005 && Boolean(opts.sourceVideoPath);

  if (hasBgMix) {
    const bgVol = Math.min(0.35, Math.max(0, opts.preserveBgAudio)).toFixed(3);
    const filterComplex = [
      `[0:a]aformat=sample_rates=44100:channel_layouts=stereo,${voiceFilterChain},apad=whole_dur=${targetDuration.toFixed(3)},atrim=0:${targetDuration.toFixed(3)},asetpts=PTS-STARTPTS,volume=1.15[voice]`,
      `[1:a]aformat=sample_rates=44100:channel_layouts=stereo,atrim=0:${targetDuration.toFixed(3)},asetpts=PTS-STARTPTS,volume=${bgVol}[bg]`,
      `[voice][bg]amix=inputs=2:duration=first:dropout_transition=0,dynaudnorm=f=150:g=15[outa]`,
    ].join(';');

    await execFileAsync(getFfmpegPath(), [
      '-y',
      '-i',
      opts.rawSpeechPath,
      '-i',
      opts.sourceAudioWavPath,
      '-filter_complex',
      filterComplex,
      '-map',
      '[outa]',
      '-acodec',
      'pcm_s16le',
      '-ar',
      '44100',
      '-ac',
      '2',
      opts.outputWavPath,
    ]);
  } else {
    const filterSimple = `aformat=sample_rates=44100:channel_layouts=stereo,${voiceFilterChain},apad=whole_dur=${targetDuration.toFixed(3)},atrim=0:${targetDuration.toFixed(3)},asetpts=PTS-STARTPTS`;
    await execFileAsync(getFfmpegPath(), [
      '-y',
      '-i',
      opts.rawSpeechPath,
      '-af',
      filterSimple,
      '-acodec',
      'pcm_s16le',
      '-ar',
      '44100',
      '-ac',
      '2',
      opts.outputWavPath,
    ]);
  }

  // Export MP3
  await execFileAsync(getFfmpegPath(), [
    '-y',
    '-i',
    opts.outputWavPath,
    '-codec:a',
    'libmp3lame',
    '-b:a',
    '192k',
    opts.outputMp3Path,
  ]);

  // Mux dubbed audio with original video if present
  if (opts.sourceVideoPath && opts.outputVideoPath) {
    const canCopyVideo =
      opts.videoCodec === 'h264' &&
      (!opts.videoPixFmt || opts.videoPixFmt === 'yuv420p') &&
      opts.sourceVideoPath.toLowerCase().endsWith('.mp4');
    if (canCopyVideo) {
      try {
        await execFileAsync(getFfmpegPath(), [
          '-y',
          '-i',
          opts.sourceVideoPath,
          '-i',
          opts.outputWavPath,
          '-c:v',
          'copy',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          '-avoid_negative_ts',
          'make_zero',
          '-movflags',
          '+faststart',
          '-shortest',
          opts.outputVideoPath,
        ]);
      } catch {
        await execFileAsync(getFfmpegPath(), [
          '-y',
          '-i',
          opts.sourceVideoPath,
          '-i',
          opts.outputWavPath,
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          '-movflags',
          '+faststart',
          '-shortest',
          opts.outputVideoPath,
        ]);
      }
    } else {
      await execFileAsync(getFfmpegPath(), [
        '-y',
        '-i',
        opts.sourceVideoPath,
        '-i',
        opts.outputWavPath,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-movflags',
        '+faststart',
        '-shortest',
        opts.outputVideoPath,
      ]);
    }
  }

  const finalInfo = await probeMedia(opts.outputWavPath);
  return {
    dubbedDurationSec: finalInfo.durationSec,
    tempoFactor,
  };
}
