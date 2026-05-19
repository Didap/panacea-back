import { Inject, Injectable } from '@nestjs/common';
import { STORAGE_DRIVER_TOKEN } from './storage.module';
import type { StorageDriver, StoreInput, StoreResult } from './storage.driver';

@Injectable()
export class StorageService {
  constructor(@Inject(STORAGE_DRIVER_TOKEN) private readonly driver: StorageDriver) {}

  get driverName(): string {
    return this.driver.name;
  }

  store(input: StoreInput): Promise<StoreResult> {
    return this.driver.store(input);
  }

  read(key: string): Promise<Buffer> {
    return this.driver.read(key);
  }

  delete(key: string): Promise<void> {
    return this.driver.delete(key);
  }
}
