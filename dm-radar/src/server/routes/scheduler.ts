import { Hono } from 'hono';
import { runScan } from '../core/scan';

export const scheduler = new Hono();

scheduler.post('/daily-scan', async (c) => {
  try {
    const day = await runScan();
    return c.json({ ok: true, found: day.found });
  } catch (error) {
    console.error(`daily-scan failed: ${error}`);
    return c.json({ ok: false, error: String(error) }, 500);
  }
});
