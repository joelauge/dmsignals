import { Hono } from 'hono';
import { getLatest } from '../core/scan';

export const api = new Hono();

api.get('/latest', async (c) => {
  const day = await getLatest();
  return c.json(day);
});
