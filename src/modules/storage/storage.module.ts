import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service';
import { LocalStorageDriver } from './local-storage.driver';
import type { Env } from '../../config/env';
import { STORAGE_DRIVER_TOKEN, type StorageDriver } from './storage.driver';

@Global()
@Module({
  providers: [
    {
      provide: STORAGE_DRIVER_TOKEN,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): StorageDriver => {
        const driver = config.get('STORAGE_DRIVER', { infer: true });
        if (driver === 'local') {
          return new LocalStorageDriver(config.get('STORAGE_LOCAL_DIR', { infer: true }));
        }
        // R2 driver lands when env is provided; until then, we treat r2 selection as fatal.
        throw new Error(`storage driver "${driver}" not implemented yet`);
      },
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
