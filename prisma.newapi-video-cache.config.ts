import { defineConfig } from 'prisma/config';

// Generation is offline. Never pass the production URL to the Prisma CLI.
export default defineConfig({
    schema: 'prisma/newapi-video-cache.prisma',
    datasource: { url: 'postgresql://unused:unused@127.0.0.1:1/video_cache_generation_only' },
});
