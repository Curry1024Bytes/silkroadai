import { defineConfig } from 'prisma/config';

// Client generation needs no database access. Never give Prisma CLI the real
// read-only URL: this schema must not become a migration target by accident.
// The server-only reader uses NEWAPI_PRICING_DATABASE_URL at request time.
export default defineConfig({
    schema: 'prisma/newapi-readonly.prisma',
    datasource: { url: 'mysql://readonly:unused@127.0.0.1:1/newapi_readonly_generation_only' },
});
