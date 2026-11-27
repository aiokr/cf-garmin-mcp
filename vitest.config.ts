import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          APP_URL: "https://garmin.test",
          BETTER_AUTH_SECRET: "test-only-signing-secret-at-least-32-characters",
          GARMIN_PERSONAL_API_KEY: "test-only-not-a-real-api-key",
          GARMIN_AUTH_MODE: "personal_api",
          GARMIN_EMAIL: "",
          GARMIN_PASSWORD: "",
          PROVIDER_ENCRYPTION_KEY:
            "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
          TEST_MIGRATIONS: await readD1Migrations("./apps/worker/migrations"),
        },
      },
    }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
