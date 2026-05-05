// Optional dotenv: when running inside docker (production) the env is
// already populated via env_file before this config loads, so dotenv is
// neither needed nor present in the slimmed runtime image. Local dev
// installs dotenv normally and the import succeeds.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('dotenv/config');
} catch {
  // dotenv not installed (production runtime image) — process.env is
  // already populated by docker-compose env_file
}
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/sub2apipay',
  },
});
