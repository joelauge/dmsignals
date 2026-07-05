import './index.css';

import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { navigateTo, showToast } from '@devvit/web/client';
import type { Day, Signal } from '../shared/api';

const strengthColor: Record<Signal['strength'], string> = {
  High: 'bg-green-100 text-green-800',
  Medium: 'bg-amber-100 text-amber-800',
  Low: 'bg-gray-100 text-gray-600',
};

async function copyDraft(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('Draft copied');
  } catch {
    showToast('Could not copy — select the text manually');
  }
}

const SignalCard = ({ signal }: { signal: Signal }) => (
  <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
    <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
      <span className={`px-2 py-0.5 rounded-full font-semibold uppercase ${strengthColor[signal.strength]}`}>
        {signal.strength}
      </span>
      <span>
        {signal.sub} · {signal.author} · {signal.meta}
      </span>
    </div>
    <button
      className="block text-left font-semibold text-gray-900 dark:text-gray-100 mt-2 hover:underline"
      onClick={() => navigateTo(signal.url)}
    >
      {signal.title}
    </button>
    <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">{signal.summary}</p>
    <p className="text-xs italic text-gray-500 dark:text-gray-400 mt-1">Why it fits: {signal.whyfit}</p>
    <pre className="text-xs whitespace-pre-wrap bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-3 mt-2 font-mono">
      {signal.draft}
    </pre>
    <div className="flex gap-2 mt-2">
      <button
        className="text-xs font-semibold bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-lg px-3 py-1.5 cursor-pointer"
        onClick={() => copyDraft(signal.draft)}
      >
        Copy reply
      </button>
      <button
        className="text-xs font-semibold border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 cursor-pointer"
        onClick={() => navigateTo(signal.url)}
      >
        Open thread
      </button>
    </div>
  </div>
);

export const App = () => {
  const [day, setDay] = useState<Day | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/latest')
      .then((r) => r.json())
      .then((d: Day) => setDay(d))
      .catch((err) => console.error('Failed to load latest signals', err))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-white dark:bg-gray-900 p-4">
      <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">🎲 DM Equipment Signals</h1>
      {loading ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">Loading…</p>
      ) : !day ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">No data yet.</p>
      ) : (
        <>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {day.date} · {day.scanned} · {day.found} signal(s)
          </p>
          {day.best && (
            <p className="text-sm bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg p-3 mt-3">
              ⭐ {day.best}
            </p>
          )}
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
            🎟 FIRSTTIMEGM = free Session Zero Checklist for brand-new GMs. Use only when it truly fits. Drafts are
            never auto-posted — copy, tweak, post manually.
          </p>
          <div className="flex flex-col gap-3 mt-4">
            {day.signals.map((s, i) => (
              <SignalCard key={i} signal={s} />
            ))}
          </div>
        </>
      )}
    </div>
  );
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
