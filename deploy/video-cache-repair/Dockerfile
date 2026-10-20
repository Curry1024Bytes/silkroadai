# Reuse the verified production dependencies, never run the Portal entrypoint.
ARG PORTAL_IMAGE=silkroadai-portal-portal:release-2445fe88
FROM ${PORTAL_IMAGE}
USER root
# Next's standalone output prunes the root zod symlink. Reuse its already
# installed v4 package from the verified dependency layer; no network install.
RUN ZOD_PACKAGE=$(find node_modules/.pnpm -path '*/zod@4.*/node_modules/zod/package.json' -print -quit) && \
    test -n "$ZOD_PACKAGE" && \
    ln -sfn "/app/${ZOD_PACKAGE%/package.json}" node_modules/zod && \
    CLIENT_UTILS_PACKAGE=$(find node_modules/.pnpm -path '*/node_modules/@prisma/client-runtime-utils/package.json' -print -quit) && \
    test -n "$CLIENT_UTILS_PACKAGE" && \
    ln -sfn "/app/${CLIENT_UTILS_PACKAGE%/package.json}" node_modules/@prisma/client-runtime-utils
COPY prisma/newapi-video-cache.prisma ./prisma/newapi-video-cache.prisma
COPY prisma.newapi-video-cache.config.ts ./prisma.newapi-video-cache.config.ts
COPY scripts/repair-video-cache-sources.mjs ./scripts/repair-video-cache-sources.mjs
RUN node node_modules/prisma/build/index.js generate --config prisma.newapi-video-cache.config.ts
RUN node --input-type=module -e 'import "zod"; import {PrismaPg} from "@prisma/adapter-pg"; import {PrismaClient} from "./src/generated/newapi-video-cache/index.js"; const client = new PrismaClient({adapter:new PrismaPg({host:"127.0.0.1",port:1,user:"unused",database:"unused"})}); await client.$disconnect();'
ENTRYPOINT ["node", "/app/scripts/repair-video-cache-sources.mjs"]
CMD []
