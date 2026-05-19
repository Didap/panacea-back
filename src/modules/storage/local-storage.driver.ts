import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StorageDriver, StoreInput, StoreResult } from './storage.driver';

export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local';
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  async store({ buffer }: StoreInput): Promise<StoreResult> {
    const today = new Date();
    const key = `${today.getUTCFullYear()}/${pad(today.getUTCMonth() + 1)}/${randomUUID()}`;
    const dest = join(this.root, key);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, buffer);
    return { driver: this.name, key };
  }

  async read(key: string): Promise<Buffer> {
    return readFile(join(this.root, key));
  }

  async delete(key: string): Promise<void> {
    await unlink(join(this.root, key)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
