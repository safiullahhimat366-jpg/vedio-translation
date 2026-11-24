import { useMemo, useState } from 'react';
import { Check, Search } from 'lucide-react';
import type { VoicePersona } from '../types/dubstudio.ts';

interface VoiceCastSectionProps {
  voices: VoicePersona[];
  selectedVoiceId: string;
  onSelectVoice: (voice: VoicePersona) => void;
}

export function VoiceCastSection({
  voices,
  selectedVoiceId,
  onSelectVoice,
}: VoiceCastSectionProps) {
  const [query, setQuery] = useState('');
  const [genderFilter, setGenderFilter] = useState<'All' | 'Male' | 'Female' | 'Auto'>('All');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return voices.filter((v) => {
      if (genderFilter !== 'All' && v.gender !== genderFilter) return false;
      if (!q) return true;
      return (
        v.name.toLowerCase().includes(q) ||
        v.languageName.toLowerCase().includes(q) ||
        v.character.toLowerCase().includes(q) ||
        v.edgeVoiceName.toLowerCase().includes(q) ||
        v.elevenlabsVoiceId.toLowerCase().includes(q)
      );
    });
  }, [voices, query, genderFilter]);

  return (
    <section id="voice-cast" className="border-t border-slate-800/80 pt-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold text-slate-100 tracking-tight">
            Speaker Clone & Natural Voice Cast
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Choose Clone Speaker Voice to preserve the original speaker's pitch & timbre, or pick any natural male or female voice persona.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter language or voice..."
              className="w-56 rounded-lg border border-slate-800 bg-[#10151D] pl-8 pr-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-[#0B0F16] p-1">
            {(['All', 'Auto', 'Male', 'Female'] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGenderFilter(g)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  genderFilter === g
                    ? 'bg-slate-800 text-amber-400'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {g === 'Auto' ? 'Clone' : g}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-800 bg-[#10151D]">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-800 bg-[#0D1118] text-xs font-medium text-slate-400">
              <th className="py-3 px-4">Voice Persona</th>
              <th className="py-3 px-4">Language</th>
              <th className="py-3 px-4">Gender</th>
              <th className="py-3 px-4">Vocal Character</th>
              <th className="py-3 px-4">Edge Neural Voice</th>
              <th className="py-3 px-4 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/70 text-sm">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-8 px-4 text-center text-sm text-slate-400">
                  No voice personas match "{query}".
                </td>
              </tr>
            ) : (
              filtered.map((voice) => {
                const isSelected = voice.id === selectedVoiceId;
                return (
                  <tr
                    key={voice.id}
                    className={`transition-colors hover:bg-slate-800/35 ${
                      isSelected ? 'bg-amber-500/5' : ''
                    }`}
                  >
                    <td className="py-2.5 px-4 font-medium text-slate-100 whitespace-nowrap">
                      {voice.name}
                    </td>
                    <td className="py-2.5 px-4 text-slate-300 whitespace-nowrap">
                      {voice.languageName}
                    </td>
                    <td className="py-2.5 px-4 text-slate-400 whitespace-nowrap">
                      {voice.isClone ? 'Auto-Match' : voice.gender}
                    </td>
                    <td className="py-2.5 px-4 text-slate-400">{voice.character}</td>
                    <td className="py-2.5 px-4 font-mono text-xs text-slate-400 tabular-nums whitespace-nowrap">
                      {voice.isClone ? 'Pitch & Timbre Matched' : voice.edgeVoiceName}
                    </td>
                    <td className="py-2.5 px-4 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => onSelectVoice(voice)}
                        className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          isSelected
                            ? 'bg-amber-500 text-slate-950 font-semibold'
                            : 'border border-slate-700 bg-[#0B0F16] text-slate-200 hover:border-amber-500/60 hover:text-amber-300'
                        }`}
                      >
                        {isSelected ? (
                          <>
                            <Check className="h-3 w-3" />
                            Active
                          </>
                        ) : (
                          'Use Voice'
                        )}
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
