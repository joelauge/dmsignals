import { Hono } from 'hono';
import type { UiResponse } from '@devvit/web/shared';
import { context } from '@devvit/web/server';
import { createPost } from '../core/post';
import { runScan } from '../core/scan';

export const menu = new Hono();

menu.post('/post-create', async (c) => {
  try {
    const post = await createPost();

    return c.json<UiResponse>(
      {
        navigateTo: `https://reddit.com/r/${context.subredditName}/comments/${post.id}`,
      },
      200
    );
  } catch (error) {
    console.error(`Error creating post: ${error}`);
    return c.json<UiResponse>(
      {
        showToast: 'Failed to create post',
      },
      400
    );
  }
});

menu.post('/scan-now', async (c) => {
  try {
    const day = await runScan();
    return c.json<UiResponse>(
      {
        showToast: `Scan complete: ${day.found} signal(s). Digest PM sent if configured.`,
      },
      200
    );
  } catch (error) {
    console.error(`Error running scan: ${error}`);
    return c.json<UiResponse>(
      {
        showToast: 'Scan failed, check logs.',
      },
      400
    );
  }
});
