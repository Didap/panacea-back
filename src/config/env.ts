import { z } from 'zod';

const minutesString = z
  .string()
  .regex(/^\d+[smhd]$/, 'expected duration like 15m, 1h, 7d');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().url(),
  DATABASE_APP_USER: z.string().default('panacea_app'),
  DATABASE_APP_PASSWORD: z.string().default('panacea_app'),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: minutesString.default('15m'),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_REFRESH_TTL: minutesString.default('7d'),

  STORAGE_DRIVER: z.enum(['local', 'r2']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage/documents'),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_ENDPOINT: z.string().optional(),
  R2_KMS_KEY_ID: z.string().optional(),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),

  MAX_UPLOAD_SIZE_MB: z.coerce.number().int().positive().default(10),
  LOGIN_LOCKOUT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  LOGIN_LOCKOUT_DURATION_MIN: z.coerce.number().int().positive().default(15),

  PUBLIC_WEB_BASE_URL: z.string().url().default('http://localhost:5173'),

  NOTIFICATIONS_DRIVER: z.enum(['console', 'resend']).default('console'),
  NOTIFICATIONS_FROM: z.string().default('Panacea <noreply@panacea.local>'),
  RESEND_API_KEY: z.string().optional(),

  INVITATION_TTL_DAYS: z.coerce.number().int().positive().default(7),
  OTP_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(input: Record<string, unknown> = process.env): Env {
  const parsed = envSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('\n  ');
    throw new Error(`Invalid environment variables:\n  ${issues}`);
  }
  return parsed.data;
}
