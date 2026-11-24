import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { translate } from 'bing-translate-api';
import type { EmotionProfile } from '../src/types/dubstudio.ts';
import { getFfmpegPath } from './ffmpeg.ts';

const execFileAsync = promisify(execFile);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedWhisperPipeline: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let loadingWhisperPromise: Promise<any> | null = null;

const WHISPER_LANG_MAP: Record<string, string> = {
  ps: 'pashto',
  en: 'english',
  ar: 'arabic',
  fa: 'persian',
  ur: 'urdu',
  hi: 'hindi',
  tr: 'turkish',
  es: 'spanish',
  fr: 'french',
  de: 'german',
  zh: 'chinese',
};

const BING_LANG_MAP: Record<string, string> = {
  ps: 'ps',
  en: 'en',
  ar: 'ar',
  fa: 'fa',
  ur: 'ur',
  hi: 'hi',
  tr: 'tr',
  es: 'es',
  fr: 'fr',
  de: 'de',
  zh: 'zh-Hans',
};

export async function extractFloat32Pcm16k(
  inputPath: string,
  outRawPath: string
): Promise<Float32Array> {
  await execFileAsync(getFfmpegPath(), [
    '-y',
    '-i',
    inputPath,
    '-f',
    'f32le',
    '-acodec',
    'pcm_f32le',
    '-ar',
    '16000',
    '-ac',
    '1',
    outRawPath,
  ]);
  const buf = await fs.readFile(outRawPath);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

export interface SpeakerVoiceProfile {
  pitchHz: number;
  estimatedGender: 'Male' | 'Female';
  brightness: number;
  warmth: number;
}

export function analyzeSpeakerVoiceProfile(
  samples: Float32Array,
  sampleRate = 16000
): SpeakerVoiceProfile {
  if (samples.length < 1600) {
    return {
      pitchHz: 128,
      estimatedGender: 'Male',
      brightness: 0.45,
      warmth: 0.65,
    };
  }

  const maxSamples = Math.min(samples.length, sampleRate * 25);
  const frameLen = Math.round(sampleRate * 0.032); // 32ms
  const hopLen = Math.round(sampleRate * 0.016); // 16ms
  const minLag = Math.floor(sampleRate / 300); // 300 Hz max F0
  const maxLag = Math.floor(sampleRate / 72); // 72 Hz min F0

  const f0Values: number[] = [];
  let totalZeroCrossings = 0;
  let voicedSampleCount = 0;

  for (let start = 0; start + frameLen <= maxSamples; start += hopLen) {
    let energy = 0;
    let zc = 0;
    for (let i = 0; i < frameLen; i++) {
      const v = samples[start + i];
      energy += v * v;
      if (i > 0) {
        const prev = samples[start + i - 1];
        if ((prev >= 0 && v < 0) || (prev < 0 && v >= 0)) {
          zc++;
        }
      }
    }

    const rms = Math.sqrt(energy / frameLen);
    if (rms < 0.014) continue;

    totalZeroCrossings += zc;
    voicedSampleCount += frameLen;

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
      f0Values.push(sampleRate / bestLag);
    }
  }

  let pitchHz = 128;
  if (f0Values.length > 0) {
    f0Values.sort((a, b) => a - b);
    pitchHz = Math.round(f0Values[Math.floor(f0Values.length / 2)]);
  }

  const estimatedGender: 'Male' | 'Female' = pitchHz < 162 ? 'Male' : 'Female';
  const zcrPerSec =
    voicedSampleCount > 0 ? (totalZeroCrossings / voicedSampleCount) * sampleRate : 1600;
  const brightness = Number(
    Math.min(0.95, Math.max(0.15, (zcrPerSec - 650) / 3200)).toFixed(2)
  );
  const warmth = Number(Math.min(0.95, Math.max(0.25, 1.05 - brightness * 0.7)).toFixed(2));

  return {
    pitchHz,
    estimatedGender,
    brightness,
    warmth,
  };
}

export function analyzeAcousticEmotion(
  samples: Float32Array,
  durationSec: number
): EmotionProfile {
  if (samples.length === 0) {
    return {
      primaryEmotion: 'Calm & Neutral',
      secondaryNuance: 'Steady',
      energyLevel: 0.5,
      warmthLevel: 0.65,
      speakingPace: 'moderate',
      vocalDirection: 'Speak clearly with natural conversational warmth and steady pacing.',
    };
  }

  // Analyze 250ms windows to compute RMS energy, active speech ratio, and dynamic range
  const windowSize = 4000; // 0.25s at 16kHz
  let sumSqAll = 0;
  let activeWindows = 0;
  let totalWindows = 0;
  let maxWindowRms = 0;
  let zeroCrossings = 0;

  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    sumSqAll += v * v;
    if (i > 0 && ((samples[i - 1] >= 0 && v < 0) || (samples[i - 1] < 0 && v >= 0))) {
      zeroCrossings++;
    }
  }

  for (let start = 0; start < samples.length; start += windowSize) {
    const end = Math.min(samples.length, start + windowSize);
    let winSq = 0;
    for (let i = start; i < end; i++) {
      winSq += samples[i] * samples[i];
    }
    const rms = Math.sqrt(winSq / Math.max(1, end - start));
    totalWindows++;
    if (rms > 0.015) activeWindows++;
    if (rms > maxWindowRms) maxWindowRms = rms;
  }

  const globalRms = Math.sqrt(sumSqAll / samples.length);
  const activeRatio = totalWindows > 0 ? activeWindows / totalWindows : 0.6;
  const zcrPerSec = zeroCrossings / Math.max(0.5, durationSec);

  const energyLevel = Number(Math.min(0.95, Math.max(0.2, globalRms * 5.2)).toFixed(2));
  const warmthLevel = Number(
    Math.min(0.92, Math.max(0.35, 0.85 - Math.min(0.45, zcrPerSec / 6500))).toFixed(2)
  );

  let speakingPace = 'moderate';
  if (activeRatio > 0.82 && energyLevel > 0.65) speakingPace = 'brisk';
  else if (activeRatio > 0.72) speakingPace = 'moderate';
  else if (activeRatio < 0.45) speakingPace = 'measured';

  let primaryEmotion = 'Calm & Conversational';
  let secondaryNuance = 'Warm & Steady';
  let vocalDirection =
    'Deliver with natural warmth, steady chest resonance, and clear conversational articulation.';

  if (energyLevel >= 0.72) {
    primaryEmotion = 'Energetic & Expressive';
    secondaryNuance = activeRatio > 0.75 ? 'Urgent' : 'Enthusiastic';
    vocalDirection =
      'Project lively energy and clear emphasis while maintaining crisp phrasing.';
  } else if (energyLevel <= 0.38) {
    primaryEmotion = 'Calm & Thoughtful';
    secondaryNuance = 'Reassuring';
    vocalDirection =
      'Speak softly and unhurriedly with gentle warmth and natural pauses.';
  } else if (warmthLevel >= 0.68) {
    primaryEmotion = 'Warm & Friendly';
    secondaryNuance = 'Welcoming';
    vocalDirection =
      'Use an inviting, friendly tone with smooth inflection and balanced pacing.';
  }

  return {
    primaryEmotion,
    secondaryNuance,
    energyLevel,
    warmthLevel,
    speakingPace,
    vocalDirection,
  };
}

async function getWhisperPipeline() {
  if (cachedWhisperPipeline) return cachedWhisperPipeline;
  if (!loadingWhisperPromise) {
    loadingWhisperPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = process.env.SADAVOX_DATA_DIR
        ? path.join(process.env.SADAVOX_DATA_DIR, 'hf_cache')
        : path.join(os.tmpdir(), 'sadavox_hf_cache');
      const modelId = process.env.SADAVOX_WHISPER_MODEL || 'Xenova/whisper-base';
      const pipe = await pipeline('automatic-speech-recognition', modelId, {
        dtype: 'q8',
      });
      cachedWhisperPipeline = pipe;
      return pipe;
    })();
  }
  return loadingWhisperPromise;
}

function normalizePcmForWhisper(samples: Float32Array): Float32Array {
  let maxAbs = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > maxAbs) maxAbs = v;
  }
  if (maxAbs < 1e-4 || maxAbs >= 0.45) {
    return samples;
  }
  const gain = Math.min(25, 0.82 / maxAbs);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.max(-1, Math.min(1, samples[i] * gain));
  }
  return out;
}

async function detectSpokenLanguageWithWhisper(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transcriber: any,
  samples: Float32Array
): Promise<string | undefined> {
  try {
    const { Tensor } = await import('@huggingface/transformers');
    const windowSamples = samples.slice(0, Math.min(samples.length, 16000 * 30));
    const proc = await transcriber.processor(windowSamples);
    const genCfg = transcriber.model?.generation_config;
    const startId = genCfg?.decoder_start_token_id;
    const langToId = (genCfg?.lang_to_id || {}) as Record<string, number>;
    if (!startId || Object.keys(langToId).length === 0) {
      return undefined;
    }

    const out = await transcriber.model.forward({
      input_features: proc.input_features,
      decoder_input_ids: new Tensor('int64', [BigInt(startId)], [1, 1]),
    });
    const logitsData = out?.logits?.data as Float32Array | number[] | undefined;
    if (!logitsData) return undefined;

    const supportedTokens: Array<{ code: string; name: string }> = [
      { code: 'ps', name: 'pashto' },
      { code: 'en', name: 'english' },
      { code: 'ar', name: 'arabic' },
      { code: 'fa', name: 'persian' },
      { code: 'ur', name: 'urdu' },
      { code: 'hi', name: 'hindi' },
      { code: 'tr', name: 'turkish' },
      { code: 'es', name: 'spanish' },
      { code: 'fr', name: 'french' },
      { code: 'de', name: 'german' },
      { code: 'zh', name: 'chinese' },
    ];

    let bestLang = 'english';
    let bestScore = -Infinity;
    for (const candidate of supportedTokens) {
      const tokId = langToId[`<|${candidate.code}|>`];
      if (tokId !== undefined) {
        const score = Number(logitsData[tokId]);
        if (Number.isFinite(score) && score > bestScore) {
          bestScore = score;
          bestLang = candidate.name;
        }
      }
    }
    return bestLang;
  } catch {
    return undefined;
  }
}

export async function transcribeWithLocalWhisper(
  samples: Float32Array,
  sourceLang: string
): Promise<string> {
  const transcriber = await getWhisperPipeline();
  const normalizedSamples = normalizePcmForWhisper(samples);
  let mappedLang = sourceLang !== 'auto' ? WHISPER_LANG_MAP[sourceLang] : undefined;

  if (!mappedLang) {
    mappedLang = await detectSpokenLanguageWithWhisper(transcriber, normalizedSamples);
  }

  const options: Record<string, unknown> = {
    chunk_length_s: 30,
    stride_length_s: 5,
    task: 'transcribe',
    no_repeat_ngram_size: 3,
    repetition_penalty: 1.15,
  };
  if (mappedLang) {
    options.language = mappedLang;
  }

  const result = (await transcriber(normalizedSamples, options)) as { text?: string };
  return (result?.text ?? '').trim();
}

function splitTextForTranslation(text: string, maxLen = 800): string[] {
  const clean = text.trim();
  if (clean.length <= maxLen) return [clean];

  const sentences = clean.split(/(?<=[.!?؟۔\n])\s+/);
  const chunks: string[] = [];
  let current = '';

  for (const s of sentences) {
    if ((current + ' ' + s).trim().length > maxLen) {
      if (current.trim()) chunks.push(current.trim());
      if (s.length > maxLen) {
        for (let i = 0; i < s.length; i += maxLen) {
          chunks.push(s.slice(i, i + maxLen));
        }
        current = '';
      } else {
        current = s;
      }
    } else {
      current = (current + ' ' + s).trim();
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export async function translateWithFreeBing(
  text: string,
  sourceLang: string,
  targetLang: string
): Promise<{ translatedText: string; detectedSourceLang: string }> {
  const fromCode = sourceLang === 'auto' ? null : BING_LANG_MAP[sourceLang] ?? null;
  const toCode = BING_LANG_MAP[targetLang] ?? targetLang;

  const chunks = splitTextForTranslation(text, 800);
  const translatedParts: string[] = [];
  let detected = sourceLang === 'auto' ? 'auto' : sourceLang;

  for (const chunk of chunks) {
    const res = await translate(chunk, fromCode, toCode);
    if (res?.translation) {
      translatedParts.push(res.translation.trim());
    }
    if (res?.language?.from && detected === 'auto') {
      detected = res.language.from;
    }
  }

  return {
    translatedText: translatedParts.join(' ').trim(),
    detectedSourceLang: detected,
  };
}
