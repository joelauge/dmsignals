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

export type Day = {
  date: string;
  scanned: string;
  found: number;
  best: string;
  signals: Signal[];
};

export type LatestResponse = Day;
