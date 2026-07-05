import './index.css';

import { requestExpandedMode } from '@devvit/web/client';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Day } from '../shared/api';

export const Splash = () => {
  const [day, setDay] = useState<Day | null>(null);

  useEffect(() => {
    fetch('/api/latest')
      .then((r) => r.json())
      .then((d: Day) => setDay(d))
      .catch((err) => console.error('Failed to load latest signals', err));
  }, []);

  return (
    <div className="flex relative flex-col justify-center items-center min-h-screen gap-4 bg-white dark:bg-gray-900 p-6 text-center">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">🎲 DM Equipment Signals</h1>
      {day ? (
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {day.date} · {day.found} signal(s) today
          {(day.replies ?? []).length > 0 ? ` · ${day.replies.length} replies to you` : ''}
        </p>
      ) : (
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
      )}
      <button
        className="flex items-center justify-center bg-[#d93900] dark:bg-orange-600 text-white w-auto h-10 rounded-full cursor-pointer transition-colors px-4 hover:bg-[#c23300] dark:hover:bg-orange-700"
        onClick={(e) => requestExpandedMode(e.nativeEvent, 'game')}
      >
        Open dashboard
      </button>
    </div>
  );
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Splash />
  </StrictMode>
);
