export interface LanguageOption {
  code: string;
  label: string;
  nativeName: string;
  rtl?: boolean;
}

export interface VoicePersona {
  id: string;
  name: string;
  languageCode: string;
  languageName: string;
  gender: 'Male' | 'Female' | 'Auto';
  character: string;
  elevenlabsVoiceId: string;
  geminiVoiceName: 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Zephyr';
  edgeVoiceName: string;
  baseStylePrompt: string;
  isClone?: boolean;
  pitchScale?: number;
}

export type SynthesisEngineChoice = 'auto' | 'edge' | 'gemini' | 'elevenlabs';

export interface EmotionProfile {
  primaryEmotion: string;
  secondaryNuance: string;
  energyLevel: number;
  warmthLevel: number;
  speakingPace: string;
  vocalDirection: string;
}

export interface DubbingAnalysis {
  detectedSourceLanguage: string;
  targetLanguage: string;
  fullTranscript: string;
  fullTranslation: string;
  emotionProfile: EmotionProfile;
}

export interface DubbingResult {
  jobId: string;
  mode: 'video' | 'audio';
  processTimeSec: number;
  originalDurationSec: number;
  dubbedDurationSec: number;
  tempoFactor: number;
  engineUsed: string;
  voice: VoicePersona;
  analysis: DubbingAnalysis;
  dubbedVideoUrl: string | null;
  dubbedAudioWavUrl: string;
  dubbedAudioMp3Url: string;
  sourcePreviewUrl: string | null;
  createdAt: string;
}

export interface JobProgressEvent {
  jobId: string;
  status: 'queued' | 'processing' | 'completed' | 'error';
  progress: number;
  stage: string;
  elapsedSec: number;
  result?: DubbingResult;
  error?: string;
}
