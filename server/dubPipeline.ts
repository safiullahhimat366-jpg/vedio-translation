import fs from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import type {
  DubbingAnalysis,
  DubbingResult,
  SynthesisEngineChoice,
  VoicePersona,
} from '../src/types/dubstudio.ts';
import {
  concatAudioFiles,
  extractAudioForAnalysis,
  finalizeDubbedMedia,
  probeMedia,
  splitAudioIntoSegments,
} from './ffmpeg.ts';
import {
  analyzeAcousticEmotion,
  analyzeSpeakerVoiceProfile,
  extractFloat32Pcm16k,
  transcribeWithLocalWhisper,
  translateWithFreeBing,
  type SpeakerVoiceProfile,
} from './localPipeline.ts';
import { getLanguageLabel, resolveCloneBaseEdgeVoice, resolveVoice } from './voices.ts';

function getOptionalGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function formatReadableError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(raw) as { error?: { code?: number; message?: string; status?: string } };
    if (parsed?.error?.message) {
      const code = parsed.error.code ? `(${parsed.error.code}) ` : '';
      return `${code}${parsed.error.message}`;
    }
  } catch {
    // Not raw JSON
  }
  return raw;
}

function isTransientApiError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('503') ||
    msg.includes('unavailable') ||
    msg.includes('high demand') ||
    msg.includes('429') ||
    msg.includes('resource_exhausted') ||
    msg.includes('overloaded') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('timed out')
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 2,
  baseDelayMs = 1000
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientApiError(err) || i === attempts - 1) {
        throw err;
      }
      const jitter = Math.floor(Math.random() * 350);
      await sleep(baseDelayMs * Math.pow(2, i) + jitter);
    }
  }
  throw lastError;
}

async function downloadVideoFromUrl(url: string, destPath: string): Promise<void> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('Invalid video URL. Please paste a valid http:// or https:// direct video link.');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Only http:// and https:// video links are supported.');
  }

  const response = await fetch(parsedUrl.toString(), {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 SadaVoxStudio/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch video URL (HTTP ${response.status}).`);
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html')) {
    throw new Error(
      'This URL points to a webpage rather than a direct media stream. Please paste a direct .mp4/.webm/.mov link or upload the video file directly.'
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength < 1024) {
    throw new Error('Downloaded media file was empty or too small to process.');
  }
  await fs.writeFile(destPath, Buffer.from(arrayBuffer));
}

async function transcribeAudioWithGemini(
  ai: GoogleGenAI,
  audioMp3Base64: string,
  sourceLang = 'auto'
): Promise<string> {
  const langHint =
    sourceLang !== 'auto'
      ? ` The spoken language is ${getLanguageLabel(sourceLang)}. Transcribe faithfully in its native script.`
      : ' Carefully distinguish between Pashto (پښتو), Dari/Persian, Urdu, Arabic, and English based on the actual spoken words.';
  const response = await withRetry(
    () =>
      withTimeout(
        ai.models.generateContent({
          model: 'gemini-3.5-transcribe',
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType: 'audio/mp3',
                  data: audioMp3Base64,
                },
              },
              {
                text: `Transcribe all spoken speech in this audio accurately in its original language and native script.${langHint}`,
              },
            ],
          },
        }),
        45000,
        'gemini-3.5-transcribe'
      ),
    1,
    1000
  );
  return (
    (response.text ?? '').trim() ||
    (response.candidates?.[0]?.content?.parts ?? [])
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .join(' ')
      .trim()
  );
}

const ANALYSIS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    detectedSourceLanguage: { type: Type.STRING },
    targetLanguage: { type: Type.STRING },
    fullTranscript: { type: Type.STRING },
    fullTranslation: { type: Type.STRING },
    emotionProfile: {
      type: Type.OBJECT,
      properties: {
        primaryEmotion: { type: Type.STRING },
        secondaryNuance: { type: Type.STRING },
        energyLevel: { type: Type.NUMBER },
        warmthLevel: { type: Type.NUMBER },
        speakingPace: { type: Type.STRING },
        vocalDirection: { type: Type.STRING },
      },
      required: [
        'primaryEmotion',
        'secondaryNuance',
        'energyLevel',
        'warmthLevel',
        'speakingPace',
        'vocalDirection',
      ],
    },
  },
  required: [
    'detectedSourceLanguage',
    'targetLanguage',
    'fullTranscript',
    'fullTranslation',
    'emotionProfile',
  ],
};

async function analyzeEmotionAndTranslateWithGemini(
  ai: GoogleGenAI,
  audioMp3Base64: string,
  transcript: string,
  sourceLang: string,
  targetLang: string,
  originalDurationSec: number
): Promise<DubbingAnalysis> {
  const targetLabel = getLanguageLabel(targetLang);
  const sourceInstruction =
    sourceLang === 'auto'
      ? 'Automatically detect the spoken source language from the audio itself. Carefully distinguish Pashto (پښتو, code "ps" — words like سلامونه، موږ، څنګه، کولی شو، دی، کې، په), Dari/Persian ("fa"), Urdu ("ur"), Arabic ("ar"), and English ("en"). Do not confuse Pashto with Arabic.'
      : `The source language is ${getLanguageLabel(sourceLang)} (code: ${sourceLang}).`;

  const prompt = [
    `You are an expert dubbing director, linguist, and vocal performance analyst.`,
    sourceInstruction,
    `Target dubbing language: ${targetLabel} (code: ${targetLang}).`,
    `Original audio duration: ${originalDurationSec.toFixed(2)} seconds.`,
    transcript
      ? `Listen directly to the audio FIRST and transcribe every spoken sentence accurately. A draft ASR reference is provided below ONLY as a hint (discard it if its language or wording does not match what you hear in the audio): "${transcript}"`
      : `Listen directly to the audio and transcribe every spoken sentence accurately.`,
    `1. Provide the complete, accurate fullTranscript in the original spoken language and native script.`,
    `2. Translate the speech into natural, idiomatic, spoken ${targetLabel} in fullTranslation, keeping sentence length and rhythm comparable so the dubbed performance fits naturally in ~${originalDurationSec.toFixed(1)} seconds.`,
    `3. Analyze the speaker's vocal emotion, energyLevel (0.0 to 1.0), warmthLevel (0.0 to 1.0), speakingPace (slow, measured, moderate, brisk, or fast), primaryEmotion, secondaryNuance, and craft a concise vocalDirection instruction for the voice actor.`,
  ].join('\n');

  const audioPart = {
    inlineData: {
      mimeType: 'audio/mp3',
      data: audioMp3Base64,
    },
  };

  const candidates: Array<{ model: string; includeAudio: boolean; timeoutMs: number; useThinking?: boolean }> = [
    { model: 'gemini-4-hydrogen', includeAudio: true, timeoutMs: 45000, useThinking: true },
    { model: 'gemini-3.1-flash-lite', includeAudio: true, timeoutMs: 75000, useThinking: false },
    ...(transcript
      ? [
          { model: 'gemini-4-hydrogen', includeAudio: false, timeoutMs: 35000, useThinking: false },
          { model: 'gemini-3.1-flash-lite', includeAudio: false, timeoutMs: 35000, useThinking: false },
        ]
      : []),
  ];

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const response = await withRetry(
        () =>
          withTimeout(
            ai.models.generateContent({
              model: candidate.model,
              contents: {
                parts: candidate.includeAudio
                  ? [audioPart, { text: prompt }]
                  : [{ text: prompt }],
              },
              config: {
                responseMimeType: 'application/json',
                responseSchema: ANALYSIS_SCHEMA,
                ...(candidate.useThinking
                  ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
                  : {}),
              },
            }),
            candidate.timeoutMs,
            candidate.model
          ),
        3,
        1500
      );

      const rawJson = (response.text ?? '{}').trim();
      const parsed = JSON.parse(rawJson) as DubbingAnalysis;
      parsed.emotionProfile = parsed.emotionProfile || {
        primaryEmotion: 'Calm & Conversational',
        secondaryNuance: 'Steady',
        energyLevel: 0.5,
        warmthLevel: 0.6,
        speakingPace: 'moderate',
        vocalDirection: 'Speak clearly with natural warmth and balanced pacing.',
      };
      parsed.emotionProfile.energyLevel = Math.min(
        1,
        Math.max(0, Number(parsed.emotionProfile.energyLevel) || 0.5)
      );
      parsed.emotionProfile.warmthLevel = Math.min(
        1,
        Math.max(0, Number(parsed.emotionProfile.warmthLevel) || 0.6)
      );
      if (!parsed.fullTranscript && transcript) {
        parsed.fullTranscript = transcript;
      }
      parsed.targetLanguage = targetLabel;
      return parsed;
    } catch (err) {
      lastError = err;
      console.warn(
        `[SadaVox Gemini analysis] ${candidate.model} (audio=${candidate.includeAudio}) failed:`,
        formatReadableError(err)
      );
    }
  }

  throw new Error(formatReadableError(lastError));
}

async function runFreeLocalAnalysis(
  inputPath: string,
  jobDir: string,
  existingTranscript: string,
  sourceLang: string,
  targetLang: string,
  originalDurationSec: number,
  onProgress: (progress: number, stage: string) => void
): Promise<DubbingAnalysis> {
  onProgress(35, 'Analyzing vocal energy & warmth locally...');
  const rawPcmPath = path.join(jobDir, 'audio_16k.f32');
  const samples = await extractFloat32Pcm16k(inputPath, rawPcmPath);
  const emotionProfile = analyzeAcousticEmotion(samples, originalDurationSec);

  let transcript = existingTranscript.trim();
  if (!transcript) {
    onProgress(46, 'Transcribing speech locally with unlimited Whisper...');
    transcript = await transcribeWithLocalWhisper(samples, sourceLang);
  }

  await fs.rm(rawPcmPath, { force: true }).catch(() => {});

  if (!transcript) {
    throw new Error(
      'No spoken words could be recognized in this file. Please ensure the recording contains clear speech.'
    );
  }

  onProgress(60, `Translating speech into ${getLanguageLabel(targetLang)}...`);
  const translated = await translateWithFreeBing(transcript, sourceLang, targetLang);

  return {
    detectedSourceLanguage: translated.detectedSourceLang,
    targetLanguage: getLanguageLabel(targetLang),
    fullTranscript: transcript,
    fullTranslation: translated.translatedText,
    emotionProfile,
  };
}

function splitTextForSpeech(text: string, maxLen = 850): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= maxLen) return [clean];

  const sentences = clean.split(/(?<=[.!?؟۔\n])\s+/);
  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    const candidate = current ? `${current} ${trimmed}` : trimmed;
    if (candidate.length <= maxLen) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = '';
    }

    if (trimmed.length <= maxLen) {
      current = trimmed;
      continue;
    }

    const words = trimmed.split(/\s+/);
    let wordBuf = '';
    for (const word of words) {
      const nextWordBuf = wordBuf ? `${wordBuf} ${word}` : word;
      if (nextWordBuf.length <= maxLen) {
        wordBuf = nextWordBuf;
      } else {
        if (wordBuf) chunks.push(wordBuf);
        if (word.length > maxLen) {
          for (let i = 0; i < word.length; i += maxLen) {
            chunks.push(word.slice(i, i + maxLen));
          }
          wordBuf = '';
        } else {
          wordBuf = word;
        }
      }
    }
    if (wordBuf) current = wordBuf;
  }

  if (current) chunks.push(current);
  return chunks;
}

async function runSegmentedGeminiAnalysis(
  ai: GoogleGenAI,
  analysisMp3Path: string,
  jobDir: string,
  sourceLang: string,
  targetLang: string,
  onProgress: (progress: number, stage: string) => void
): Promise<DubbingAnalysis> {
  const segmentDir = path.join(jobDir, 'analysis_segments');
  try {
    const segments = await splitAudioIntoSegments(analysisMp3Path, segmentDir, 150);
    if (segments.length === 0) {
      throw new Error('Could not split audio into segments for analysis.');
    }

    const segmentResults: DubbingAnalysis[] = [];
    for (let idx = 0; idx < segments.length; idx++) {
      const segPath = segments[idx];
      const segProbe = await probeMedia(segPath);
      const segDurationSec = segProbe.durationSec;
      const pctStart = 32 + Math.round((idx / segments.length) * 34);
      onProgress(pctStart, `Transcribing & translating segment ${idx + 1}/${segments.length}...`);

      const segBuffer = await fs.readFile(segPath);
      const segBase64 = segBuffer.toString('base64');

      let rawSegTranscript = '';
      if (sourceLang !== 'auto' && sourceLang !== 'ps') {
        try {
          rawSegTranscript = await transcribeAudioWithGemini(ai, segBase64, sourceLang);
        } catch {
          rawSegTranscript = '';
        }
      }

      try {
        const segAnalysis = await analyzeEmotionAndTranslateWithGemini(
          ai,
          segBase64,
          rawSegTranscript,
          sourceLang,
          targetLang,
          segDurationSec
        );
        segmentResults.push(segAnalysis);
      } catch {
        const segFallbackDir = path.join(segmentDir, `fallback_${idx}`);
        await fs.mkdir(segFallbackDir, { recursive: true });
        const segFallback = await runFreeLocalAnalysis(
          segPath,
          segFallbackDir,
          rawSegTranscript,
          sourceLang,
          targetLang,
          segDurationSec,
          () => {}
        );
        segmentResults.push(segFallback);
      }
    }

    const fullTranscript = segmentResults
      .map((s) => s.fullTranscript.trim())
      .filter(Boolean)
      .join(' ')
      .trim();
    const fullTranslation = segmentResults
      .map((s) => s.fullTranslation.trim())
      .filter(Boolean)
      .join(' ')
      .trim();

    const avgEnergy =
      segmentResults.reduce((acc, s) => acc + s.emotionProfile.energyLevel, 0) /
      segmentResults.length;
    const avgWarmth =
      segmentResults.reduce((acc, s) => acc + s.emotionProfile.warmthLevel, 0) /
      segmentResults.length;
    const first = segmentResults[0];

    return {
      detectedSourceLanguage: first.detectedSourceLanguage,
      targetLanguage: getLanguageLabel(targetLang),
      fullTranscript,
      fullTranslation,
      emotionProfile: {
        primaryEmotion: first.emotionProfile.primaryEmotion,
        secondaryNuance: first.emotionProfile.secondaryNuance,
        energyLevel: Number(avgEnergy.toFixed(2)),
        warmthLevel: Number(avgWarmth.toFixed(2)),
        speakingPace: first.emotionProfile.speakingPace,
        vocalDirection: first.emotionProfile.vocalDirection,
      },
    };
  } finally {
    await fs.rm(segmentDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function synthesizeEdgeChunk(
  text: string,
  voiceName: string,
  outMp3Path: string
): Promise<void> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(text);
  const chunks: Buffer[] = [];
  for await (const chunk of audioStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  if (buffer.length < 128) {
    throw new Error('Free Edge Neural TTS returned empty audio for this text.');
  }
  await fs.writeFile(outMp3Path, buffer);
}

async function synthesizeWithEdgeTTS(
  text: string,
  voiceName: string,
  outWavPath: string,
  jobDir: string
): Promise<void> {
  const textChunks = splitTextForSpeech(text, 850);
  if (textChunks.length <= 1) {
    const singleMp3 = outWavPath.replace(/\.wav$/i, '.mp3');
    await synthesizeEdgeChunk(text, voiceName, singleMp3);
    await concatAudioFiles([singleMp3], outWavPath);
    await fs.rm(singleMp3, { force: true }).catch(() => {});
    return;
  }

  const chunkDir = path.join(jobDir, 'edge_tts_chunks');
  await fs.mkdir(chunkDir, { recursive: true });
  try {
    const partPaths: string[] = [];
    for (let i = 0; i < textChunks.length; i++) {
      const partMp3 = path.join(chunkDir, `part_${String(i).padStart(4, '0')}.mp3`);
      await synthesizeEdgeChunk(textChunks[i], voiceName, partMp3);
      partPaths.push(partMp3);
    }
    await concatAudioFiles(partPaths, outWavPath);
  } finally {
    await fs.rm(chunkDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function synthesizeWithElevenLabs(
  text: string,
  voice: VoicePersona,
  analysis: DubbingAnalysis,
  outWavPath: string,
  jobDir: string,
  sourceWavForClone?: string
): Promise<boolean> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey || apiKey === 'MY_ELEVENLABS_API_KEY' || apiKey === 'your_elevenlabs_api_key_here') {
    return false;
  }

  const ep = analysis.emotionProfile;
  const stability = Math.min(0.85, Math.max(0.25, 0.72 - ep.energyLevel * 0.32));
  const similarityBoost = Math.min(0.92, Math.max(0.65, 0.74 + ep.warmthLevel * 0.16));
  const style = Math.min(0.85, Math.max(0.08, ep.energyLevel * 0.55 + ep.warmthLevel * 0.2));

  let targetVoiceId = voice.elevenlabsVoiceId;
  let tempClonedVoiceId: string | null = null;
  const chunkDir = path.join(jobDir, 'eleven_tts_chunks');

  try {
    if (voice.isClone && sourceWavForClone) {
      const sampleBuf = await fs.readFile(sourceWavForClone);
      const cloneForm = new FormData();
      cloneForm.append('name', `sadavox_temp_${Date.now()}`);
      cloneForm.append(
        'files',
        new Blob([sampleBuf], { type: 'audio/wav' }),
        'speaker_sample.wav'
      );
      const cloneRes = await fetch('https://api.elevenlabs.io/v1/voices/add', {
        method: 'POST',
        headers: { 'xi-api-key': apiKey },
        body: cloneForm,
      });
      if (cloneRes.ok) {
        const cloneJson = (await cloneRes.json()) as { voice_id?: string };
        if (cloneJson.voice_id) {
          targetVoiceId = cloneJson.voice_id;
          tempClonedVoiceId = cloneJson.voice_id;
        }
      }
    }

    const textChunks = splitTextForSpeech(text, 1400);
    await fs.mkdir(chunkDir, { recursive: true });
    const partPaths: string[] = [];

    for (let i = 0; i < textChunks.length; i++) {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(targetVoiceId)}`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
          },
          body: JSON.stringify({
            text: textChunks[i],
            model_id: 'eleven_multilingual_v2',
            voice_settings: {
              stability: Number(stability.toFixed(2)),
              similarity_boost: Number(similarityBoost.toFixed(2)),
              style: Number(style.toFixed(2)),
              use_speaker_boost: true,
            },
          }),
        }
      );

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`ElevenLabs synthesis failed (${res.status}): ${errText.slice(0, 180)}`);
      }

      const audioBuffer = Buffer.from(await res.arrayBuffer());
      const partPath = path.join(chunkDir, `part_${String(i).padStart(4, '0')}.mp3`);
      await fs.writeFile(partPath, audioBuffer);
      partPaths.push(partPath);
    }

    await concatAudioFiles(partPaths, outWavPath);
    return true;
  } finally {
    await fs.rm(chunkDir, { recursive: true, force: true }).catch(() => {});
    if (tempClonedVoiceId) {
      await fetch(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(tempClonedVoiceId)}`, {
        method: 'DELETE',
        headers: { 'xi-api-key': apiKey },
      }).catch(() => {});
    }
  }
}

async function synthesizeGeminiChunk(
  ai: GoogleGenAI,
  text: string,
  voice: VoicePersona,
  styleInstruction: string,
  outWavPath: string
): Promise<string> {
  const ttsModels = ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts'];
  let lastError: unknown;

  for (const modelName of ttsModels) {
    try {
      const response = await withRetry(
        () =>
          withTimeout(
            ai.models.generateContent({
              model: modelName,
              contents: [
                {
                  role: 'user',
                  parts: [
                    {
                      text,
                      speechMetadata: {
                        style: styleInstruction,
                      },
                    },
                  ],
                },
              ],
              config: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: {
                      voiceName: voice.geminiVoiceName,
                    },
                  },
                },
              },
            }),
            45000,
            modelName
          ),
        2,
        1200
      );

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64Audio) {
        throw new Error('Gemini TTS did not return audio data.');
      }

      const wavBuffer = Buffer.from(base64Audio, 'base64');
      await fs.writeFile(outWavPath, wavBuffer);
      return modelName === 'gemini-3.8-flash-tts'
        ? 'Gemini 3.8 Flash TTS (Free Tier)'
        : 'Gemini 3.8 Flash Lite TTS (Free Tier)';
    } catch (err) {
      lastError = err;
      if (!isTransientApiError(err)) {
        throw new Error(formatReadableError(err));
      }
    }
  }

  throw new Error(formatReadableError(lastError));
}

async function synthesizeWithGeminiTTS(
  ai: GoogleGenAI,
  text: string,
  voice: VoicePersona,
  analysis: DubbingAnalysis,
  outWavPath: string,
  jobDir: string
): Promise<string> {
  const ep = analysis.emotionProfile;
  const styleInstruction = [
    voice.baseStylePrompt,
    `Language: ${analysis.targetLanguage}.`,
    `Emotion: ${ep.primaryEmotion} (${ep.secondaryNuance}).`,
    `Pace: ${ep.speakingPace}.`,
    `Direction: ${ep.vocalDirection}`,
  ].join(' ');

  const textChunks = splitTextForSpeech(text, 850);
  if (textChunks.length <= 1) {
    return synthesizeGeminiChunk(ai, text, voice, styleInstruction, outWavPath);
  }

  const chunkDir = path.join(jobDir, 'gemini_tts_chunks');
  await fs.mkdir(chunkDir, { recursive: true });
  try {
    const partPaths: string[] = [];
    let engineLabel = 'Gemini 3.8 Flash Lite TTS (Free Tier)';
    for (let i = 0; i < textChunks.length; i++) {
      const partWav = path.join(chunkDir, `part_${String(i).padStart(4, '0')}.wav`);
      engineLabel = await synthesizeGeminiChunk(
        ai,
        textChunks[i],
        voice,
        styleInstruction,
        partWav
      );
      partPaths.push(partWav);
    }
    await concatAudioFiles(partPaths, outWavPath);
    return engineLabel;
  } finally {
    await fs.rm(chunkDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface RunPipelineParams {
  jobId: string;
  jobDir: string;
  mode: 'video' | 'audio';
  uploadedFilePath?: string;
  uploadedOriginalName?: string;
  localFilePath?: string;
  videoUrl?: string;
  sourceLang: string;
  targetLang: string;
  voiceIdentifier: string;
  preserveBgAudio: number;
  engine: SynthesisEngineChoice;
  onProgress: (progress: number, stage: string) => void;
}

export async function runDubbingPipeline(params: RunPipelineParams): Promise<DubbingResult> {
  const startedAt = Date.now();
  const ai = getOptionalGeminiClient();
  const baseVoice = resolveVoice(params.voiceIdentifier);

  await fs.mkdir(params.jobDir, { recursive: true });

  params.onProgress(8, 'Preparing media input and inspecting streams...');

  let inputPath: string;
  let sourcePreviewFilename: string | null = null;

  if (params.localFilePath) {
    const ext = path.extname(params.uploadedOriginalName || params.localFilePath) || (params.mode === 'video' ? '.mp4' : '.webm');
    inputPath = params.localFilePath;
    sourcePreviewFilename = `source_input${ext}`;
  } else if (params.uploadedFilePath) {
    const ext = path.extname(params.uploadedOriginalName || params.uploadedFilePath) || (params.mode === 'video' ? '.mp4' : '.webm');
    const localInputPath = path.join(params.jobDir, `source_input${ext}`);
    try {
      await fs.rename(params.uploadedFilePath, localInputPath);
    } catch {
      await fs.copyFile(params.uploadedFilePath, localInputPath);
    }
    inputPath = localInputPath;
    sourcePreviewFilename = `source_input${ext}`;
  } else if (params.videoUrl) {
    const cleanExt = path.extname(new URL(params.videoUrl).pathname).toLowerCase();
    const ext = ['.mp4', '.webm', '.mov', '.mkv', '.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac'].includes(cleanExt)
      ? cleanExt
      : '.mp4';
    const downloadedPath = path.join(params.jobDir, `source_input${ext}`);
    params.onProgress(12, 'Downloading remote media stream...');
    await downloadVideoFromUrl(params.videoUrl, downloadedPath);
    inputPath = downloadedPath;
    sourcePreviewFilename = `source_input${ext}`;
  } else {
    throw new Error('Please upload a video or MP3/voice file, record your voice, or paste a direct media link.');
  }

  const probe = await probeMedia(inputPath);
  if (!probe.hasAudio) {
    throw new Error('No audio track was detected in this file. Dubbing requires spoken audio.');
  }

  const originalDurationSec = probe.durationSec;
  const isVideo = probe.hasVideo && params.mode === 'video';

  params.onProgress(22, 'Extracting audio track for transcription & speaker vocal profiling...');
  const sourceWavPath = path.join(params.jobDir, 'source_audio.wav');
  const analysisMp3Path = path.join(params.jobDir, 'analysis_audio.mp3');
  await extractAudioForAnalysis(inputPath, sourceWavPath, analysisMp3Path);

  let speakerProfile: SpeakerVoiceProfile | undefined;
  let effectiveVoice: VoicePersona = baseVoice;

  if (baseVoice.isClone) {
    const rawClonePcm = path.join(params.jobDir, 'speaker_profile_16k.f32');
    try {
      const profileSamples = await extractFloat32Pcm16k(sourceWavPath, rawClonePcm);
      speakerProfile = analyzeSpeakerVoiceProfile(profileSamples, 16000);
    } finally {
      await fs.rm(rawClonePcm, { force: true }).catch(() => {});
    }

    const matchedEdge = resolveCloneBaseEdgeVoice(params.targetLang, speakerProfile.estimatedGender);
    const matchedGemini = speakerProfile.estimatedGender === 'Female' ? 'Kore' : 'Charon';
    effectiveVoice = {
      ...baseVoice,
      languageCode: params.targetLang,
      languageName: getLanguageLabel(params.targetLang),
      gender: speakerProfile.estimatedGender,
      edgeVoiceName: matchedEdge,
      geminiVoiceName: matchedGemini,
      character: `Cloned ${speakerProfile.estimatedGender} (~${speakerProfile.pitchHz} Hz)`,
      baseStylePrompt: `Clone the original speaker's ${speakerProfile.estimatedGender.toLowerCase()} vocal register (~${speakerProfile.pitchHz} Hz), natural warmth, and speaking cadence.`,
    };
  }

  let analysis: DubbingAnalysis;
  const useUnlimitedLocalDirectly = params.engine === 'edge' || !ai;

  if (useUnlimitedLocalDirectly) {
    analysis = await runFreeLocalAnalysis(
      sourceWavPath,
      params.jobDir,
      '',
      params.sourceLang,
      params.targetLang,
      originalDurationSec,
      params.onProgress
    );
  } else if (originalDurationSec > 180) {
    try {
      analysis = await runSegmentedGeminiAnalysis(
        ai,
        analysisMp3Path,
        params.jobDir,
        params.sourceLang,
        params.targetLang,
        params.onProgress
      );
    } catch (segErr) {
      console.warn('[SadaVox Gemini segmented fallback]', formatReadableError(segErr));
      params.onProgress(56, 'Switching to unlimited local Whisper + Bing translation...');
      analysis = await runFreeLocalAnalysis(
        sourceWavPath,
        params.jobDir,
        '',
        params.sourceLang,
        params.targetLang,
        originalDurationSec,
        params.onProgress
      );
    }
  } else {
    const mp3Buffer = await fs.readFile(analysisMp3Path);
    const mp3Base64 = mp3Buffer.toString('base64');

    params.onProgress(35, 'Transcribing original speech...');
    let rawTranscript = '';
    if (params.sourceLang !== 'auto' && params.sourceLang !== 'ps') {
      try {
        rawTranscript = await transcribeAudioWithGemini(ai, mp3Base64, params.sourceLang);
      } catch (asrErr) {
        console.warn('[SadaVox Gemini transcribe failed]', formatReadableError(asrErr));
        rawTranscript = '';
      }
    }

    params.onProgress(52, 'Analyzing emotional tone, warmth, and cadence & translating...');
    try {
      analysis = await analyzeEmotionAndTranslateWithGemini(
        ai,
        mp3Base64,
        rawTranscript,
        params.sourceLang,
        params.targetLang,
        originalDurationSec
      );
    } catch (anaErr) {
      console.warn('[SadaVox Gemini fallback]', formatReadableError(anaErr));
      // Seamless unlimited fallback if Gemini times out or is temporarily busy
      params.onProgress(56, 'Switching to unlimited local Whisper + Bing translation...');
      analysis = await runFreeLocalAnalysis(
        sourceWavPath,
        params.jobDir,
        rawTranscript,
        params.sourceLang,
        params.targetLang,
        originalDurationSec,
        params.onProgress
      );
    }
  }

  if (!analysis.fullTranslation || !analysis.fullTranslation.trim()) {
    throw new Error('Translation returned empty text. Make sure the recording contains clear speech.');
  }

  params.onProgress(
    74,
    effectiveVoice.isClone && speakerProfile
      ? `Cloning original speaker voice (${speakerProfile.estimatedGender} ~${speakerProfile.pitchHz} Hz)...`
      : `Synthesizing speech with ${effectiveVoice.name}...`
  );
  const rawElevenWavPath = path.join(params.jobDir, 'raw_elevenlabs.wav');
  const rawEdgeWavPath = path.join(params.jobDir, 'raw_edge.wav');
  const rawGeminiWavPath = path.join(params.jobDir, 'raw_gemini.wav');

  let rawSpeechPath = rawEdgeWavPath;
  let engineUsed = `Free Edge Neural TTS (${effectiveVoice.edgeVoiceName})`;
  let usedElevenLabsClone = false;

  if (params.engine === 'edge') {
    await synthesizeWithEdgeTTS(
      analysis.fullTranslation,
      effectiveVoice.edgeVoiceName,
      rawEdgeWavPath,
      params.jobDir
    );
    rawSpeechPath = rawEdgeWavPath;
    engineUsed = `Unlimited Local Whisper + Edge TTS (${effectiveVoice.edgeVoiceName})`;
  } else if (params.engine === 'elevenlabs') {
    const ok = await synthesizeWithElevenLabs(
      analysis.fullTranslation,
      effectiveVoice,
      analysis,
      rawElevenWavPath,
      params.jobDir,
      effectiveVoice.isClone ? sourceWavPath : undefined
    );
    if (!ok) {
      throw new Error(
        'Optional ELEVENLABS_API_KEY is not set. Switch Synthesis Engine to Auto or Free Unlimited.'
      );
    }
    rawSpeechPath = rawElevenWavPath;
    usedElevenLabsClone = Boolean(effectiveVoice.isClone);
    engineUsed = usedElevenLabsClone ? 'ElevenLabs Instant Voice Clone' : 'ElevenLabs Multilingual v2';
  } else {
    // Auto or Gemini: try Free Gemini TTS if key active, always fall back seamlessly to Free Edge Neural TTS
    let synthesized = false;
    if (params.engine === 'auto') {
      try {
        const usedEl = await synthesizeWithElevenLabs(
          analysis.fullTranslation,
          effectiveVoice,
          analysis,
          rawElevenWavPath,
          params.jobDir,
          effectiveVoice.isClone ? sourceWavPath : undefined
        );
        if (usedEl) {
          rawSpeechPath = rawElevenWavPath;
          usedElevenLabsClone = Boolean(effectiveVoice.isClone);
          engineUsed = usedElevenLabsClone ? 'ElevenLabs Instant Voice Clone' : 'ElevenLabs Multilingual v2';
          synthesized = true;
        }
      } catch {
        synthesized = false;
      }
    }

    if (!synthesized && ai) {
      try {
        engineUsed = await synthesizeWithGeminiTTS(
          ai,
          analysis.fullTranslation,
          effectiveVoice,
          analysis,
          rawGeminiWavPath,
          params.jobDir
        );
        rawSpeechPath = rawGeminiWavPath;
        synthesized = true;
      } catch {
        synthesized = false;
      }
    }

    if (!synthesized) {
      await synthesizeWithEdgeTTS(
        analysis.fullTranslation,
        effectiveVoice.edgeVoiceName,
        rawEdgeWavPath,
        params.jobDir
      );
      rawSpeechPath = rawEdgeWavPath;
      engineUsed = `Free Edge Neural TTS (${effectiveVoice.edgeVoiceName})`;
    }
  }

  if (effectiveVoice.isClone && speakerProfile && !usedElevenLabsClone) {
    engineUsed = `Speaker Voice Clone (${speakerProfile.estimatedGender} · ${speakerProfile.pitchHz} Hz · ${engineUsed})`;
  }

  params.onProgress(88, 'Matching speaker pitch, original duration & exporting formats...');
  const outputWavPath = path.join(params.jobDir, 'dubbed_audio.wav');
  const outputMp3Path = path.join(params.jobDir, 'dubbed_audio.mp3');
  const outputVideoPath = isVideo ? path.join(params.jobDir, 'dubbed_video.mp4') : undefined;

  const mediaFinal = await finalizeDubbedMedia({
    rawSpeechPath,
    sourceAudioWavPath: sourceWavPath,
    sourceVideoPath: isVideo ? inputPath : undefined,
    videoCodec: probe.videoCodec,
    videoPixFmt: probe.videoPixFmt,
    originalDurationSec,
    preserveBgAudio: params.preserveBgAudio,
    pitchScale: effectiveVoice.pitchScale,
    cloneTargetProfile: effectiveVoice.isClone && !usedElevenLabsClone ? speakerProfile : undefined,
    outputWavPath,
    outputMp3Path,
    outputVideoPath,
  });

  const processTimeSec = (Date.now() - startedAt) / 1000;
  params.onProgress(100, 'Dubbing complete');

  return {
    jobId: params.jobId,
    mode: isVideo ? 'video' : 'audio',
    processTimeSec,
    originalDurationSec,
    dubbedDurationSec: mediaFinal.dubbedDurationSec,
    tempoFactor: mediaFinal.tempoFactor,
    engineUsed,
    voice: effectiveVoice,
    analysis,
    dubbedVideoUrl: outputVideoPath ? `/api/outputs/${params.jobId}/dubbed_video.mp4` : null,
    dubbedAudioWavUrl: `/api/outputs/${params.jobId}/dubbed_audio.wav`,
    dubbedAudioMp3Url: `/api/outputs/${params.jobId}/dubbed_audio.mp3`,
    sourcePreviewUrl: sourcePreviewFilename
      ? `/api/outputs/${params.jobId}/${sourcePreviewFilename}`
      : null,
    createdAt: new Date().toISOString(),
  };
}

export async function generateSampleClip(
  sampleLang: 'en' | 'ps'
): Promise<{ audioBuffer: Buffer; mimeType: string; transcript: string }> {
  const ai = getOptionalGeminiClient();
  const isPashto = sampleLang === 'ps';
  const text = isPashto
    ? 'سلامونه او نېکې هیلې! نن موږ د غږ او ویډیو ژباړې سټوډیو ازمایو ترڅو طبیعي احساسات وساتو.'
    : 'Hello and welcome! Today we are testing emotion-preserving voice dubbing so every sentence keeps its natural warmth and timing.';

  if (ai) {
    const ttsModels = ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts'];
    for (const modelName of ttsModels) {
      try {
        const response = await withTimeout(
          ai.models.generateContent({
            model: modelName,
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    text,
                    speechMetadata: {
                      style: isPashto
                        ? 'Warm, friendly male Pashto host speaking clearly at a natural pace'
                        : 'Warm, friendly documentary host speaking clearly at a natural pace',
                    },
                  },
                ],
              },
            ],
            config: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: 'Charon',
                  },
                },
              },
            },
          }),
          20000,
          modelName
        );

        const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (base64Audio) {
          return {
            audioBuffer: Buffer.from(base64Audio, 'base64'),
            mimeType: 'audio/wav',
            transcript: text,
          };
        }
      } catch {
        // Fall through to keyless Edge TTS
      }
    }
  }

  const tts = new MsEdgeTTS();
  await tts.setMetadata(
    isPashto ? 'ps-AF-GulNawazNeural' : 'en-US-AndrewNeural',
    OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3
  );
  const { audioStream } = tts.toStream(text);
  const chunks: Buffer[] = [];
  for await (const chunk of audioStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return {
    audioBuffer: Buffer.concat(chunks),
    mimeType: 'audio/mpeg',
    transcript: text,
  };
}
