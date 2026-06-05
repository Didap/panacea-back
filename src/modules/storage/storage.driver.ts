// Token lives here (a leaf module) so storage.service and storage.module do not import each other.
export const STORAGE_DRIVER_TOKEN = Symbol('STORAGE_DRIVER');

export type StoreInput = {
  buffer: Buffer;
  mimeType: string;
  originalName: string;
};

export type StoreResult = {
  driver: string;
  key: string;
};

export interface StorageDriver {
  readonly name: string;
  store(input: StoreInput): Promise<StoreResult>;
  read(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}
