import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Env } from '../config/env';
import * as schema from './schema';

export type AppDb = NodePgDatabase<typeof schema>;

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private adminPool!: Pool;
  private appPool!: Pool;
  private _admin!: AppDb;
  private _app!: AppDb;

  constructor(private readonly config: ConfigService<Env, true>) {}

  onModuleInit() {
    const adminUrl = this.config.get('DATABASE_URL', { infer: true });
    const appUser = this.config.get('DATABASE_APP_USER', { infer: true });
    const appPassword = this.config.get('DATABASE_APP_PASSWORD', { infer: true });

    this.adminPool = new Pool({ connectionString: adminUrl, max: 10 });
    this._admin = drizzle(this.adminPool, { schema });

    const appUrl = rewriteUrlAuth(adminUrl, appUser, appPassword);
    this.appPool = new Pool({ connectionString: appUrl, max: 20 });
    this._app = drizzle(this.appPool, { schema });
  }

  async onModuleDestroy() {
    await Promise.all([this.adminPool?.end(), this.appPool?.end()]);
  }

  admin(): AppDb {
    return this._admin;
  }

  app(): AppDb {
    return this._app;
  }

  async withUser<T>(userId: string, fn: (db: AppDb) => Promise<T>): Promise<T> {
    const client = await this.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId]);
      const tx = drizzle(client, { schema }) as unknown as AppDb;
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

function rewriteUrlAuth(connectionString: string, user: string, password: string): string {
  const url = new URL(connectionString);
  url.username = user;
  url.password = password;
  return url.toString();
}
