export type Signal = {
  strength: 'High' | 'Medium' | 'Low';
  sub: string;
  author: string;
  meta: string;
  title: string;
  url: string;
  summary: string;
  whyfit: string;
  draft: string;
};

export type Reply = {
  from: string;
  thread: string;
  url: string;
  snippet: string;
  received: string;
};

export type Day = {
  date: string;
  scanned: string;
  found: number;
  best: string;
  signals: Signal[];
  replies: Reply[];
};

export type LatestResponse = Day;
