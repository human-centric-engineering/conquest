/**
 * Local Filesystem Storage Provider
 *
 * Implements the StorageProvider interface for local filesystem storage.
 * Designed for development only - not suitable for production.
 *
 * Two roots, chosen by `upload({ public })`:
 *
 * - **public** (default) → `public/uploads/`, served statically by Next at
 *   `/uploads/<key>`.
 * - **private** (`public: false`) → `.storage/private/`, outside anything
 *   Next serves. Readable only through `download()` or the signed route at
 *   `/api/v1/storage/<key>`.
 *
 * Deletes span both roots. A key is unique across the pair — the same key
 * is never stored in both — but which root holds it is not recorded
 * anywhere, so every read and delete checks private first and then public.
 * Missing this is how `eraseUser()` would leave a user's private files on
 * disk after erasure.
 *
 * @see .context/storage/overview.md for configuration documentation
 */

import { writeFile, unlink, mkdir, rm, readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, resolve, sep } from 'path';
import type {
  StorageProvider,
  StorageCapabilities,
  StorageObject,
  UploadOptions,
  UploadResult,
  DeleteResult,
} from '@/lib/storage/providers/types';
import { validateStorageKey } from '@/lib/storage/providers/validate-key';
import { logger } from '@/lib/logging';

/** Where private objects live when not configured otherwise. Gitignored. */
export const DEFAULT_PRIVATE_DIR = '.storage/private';

/**
 * Local Provider Configuration
 */
export interface LocalProviderConfig {
  /** Base directory for public file storage (default: public/uploads) */
  baseDir?: string;
  /** Base URL for serving public files (default: /uploads) */
  baseUrl?: string;
  /**
   * Directory for private objects — anything uploaded with `public: false`
   * (default: `.storage/private`).
   *
   * Must sit outside `public/`, or Next serves it statically and the
   * `public: false` contract is broken again.
   */
  privateDir?: string;
}

/**
 * Local Filesystem Storage Provider
 *
 * Stores files in the public directory for static serving.
 * Only use in development - files are not persisted across deploys.
 */
export class LocalProvider implements StorageProvider {
  readonly name = 'local';
  private baseDir: string;
  private baseUrl: string;
  private privateDir: string;

  /**
   * `signedUrls` stays false here and is turned on by the signed read route
   * (`lib/storage/access-tokens.ts`), which is what makes a private object
   * reachable over HTTP.
   */
  readonly capabilities: Partial<StorageCapabilities> = {
    privateObjects: true,
    signedUrls: false,
    download: true,
  };

  constructor(config: LocalProviderConfig = {}) {
    this.baseDir = config.baseDir || join(process.cwd(), 'public', 'uploads');
    this.baseUrl = config.baseUrl || '/uploads';
    this.privateDir = config.privateDir || join(process.cwd(), DEFAULT_PRIVATE_DIR);

    logger.debug('Local storage provider initialized', {
      baseDir: this.baseDir,
      baseUrl: this.baseUrl,
      privateDir: this.privateDir,
    });
  }

  async upload(file: Buffer, options: UploadOptions): Promise<UploadResult> {
    const { key } = options;
    validateStorageKey(key);

    const isPrivate = options.public === false;
    const root = isPrivate ? this.privateDir : this.baseDir;
    const filePath = resolveWithin(root, key);
    const fileDir = dirname(filePath);

    // Ensure directory exists
    if (!existsSync(fileDir)) {
      await mkdir(fileDir, { recursive: true });
    }

    // Write file
    await writeFile(filePath, file);

    // A private object has no static URL by construction. Point at the
    // signed read route: the path alone won't serve the file — the route
    // requires a token from `getSignedUrl()` — but it is the object's
    // address, and it is not a URL that quietly works for everyone.
    const url = isPrivate ? `/api/v1/storage/${key}` : `${this.baseUrl}/${key}`;

    logger.info('File uploaded to local storage', {
      key,
      filePath,
      size: file.length,
      url,
      visibility: isPrivate ? 'private' : 'public',
    });

    return {
      key,
      url,
      size: file.length,
    };
  }

  /**
   * Delete a file from **both** roots.
   *
   * The caller does not tell us whether the object was public or private,
   * and nothing on disk records it, so both are swept.
   */
  async delete(key: string): Promise<DeleteResult> {
    validateStorageKey(key);

    const paths = [resolveWithin(this.privateDir, key), resolveWithin(this.baseDir, key)];
    let success = true;

    for (const filePath of paths) {
      try {
        if (existsSync(filePath)) {
          await unlink(filePath);
          logger.info('File deleted from local storage', { key, filePath });
        } else {
          logger.debug('File not found for deletion', { key, filePath });
        }
      } catch (error) {
        logger.error('Failed to delete file from local storage', error, { key, filePath });
        success = false;
      }
    }

    return { success, key };
  }

  /**
   * Delete every file under a prefix, from **both** roots.
   *
   * This is the erasure path: `eraseUser()` calls `deleteByPrefix()` to
   * clear a user's blobs. Sweeping only the public root would leave the
   * private copies on disk and turn GDPR erasure into a partial delete —
   * which is the bug, not a missing nice-to-have.
   */
  async deletePrefix(prefix: string): Promise<DeleteResult> {
    validateStorageKey(prefix);

    const dirs = [resolveWithin(this.privateDir, prefix), resolveWithin(this.baseDir, prefix)];
    let success = true;

    for (const dirPath of dirs) {
      try {
        if (existsSync(dirPath)) {
          await rm(dirPath, { recursive: true });
          logger.info('Directory deleted from local storage', { prefix, dirPath });
        } else {
          logger.debug('Directory not found for deletion', { prefix, dirPath });
        }
      } catch (error) {
        logger.error('Failed to delete directory from local storage', error, { prefix, dirPath });
        success = false;
      }
    }

    return { success, key: prefix };
  }

  /**
   * Read an object back as bytes.
   *
   * Private root first: a caller asking for bytes by key is usually after
   * the private object, and checking it first means a public file never
   * shadows a private one of the same key.
   */
  async download(key: string): Promise<StorageObject> {
    validateStorageKey(key);

    for (const root of [this.privateDir, this.baseDir]) {
      const filePath = resolveWithin(root, key);
      if (!existsSync(filePath)) continue;

      const [body, stats] = await Promise.all([readFile(filePath), stat(filePath)]);
      // Directories exist too; reading one throws EISDIR rather than
      // returning a useless object.
      if (!stats.isFile()) continue;

      return { key, body, size: stats.size };
    }

    throw new Error(`Object not found in local storage: ${key}`);
  }

  // getSignedUrl is added by the signed read route (phase 3 of #490);
  // until then a private object is reachable only via download().
}

/**
 * Join `key` onto `root` and refuse anything that escapes it.
 *
 * `validateStorageKey` already rejects `..`, absolute paths, backslashes
 * and null bytes, so this is a backstop rather than the primary defence.
 * It earns its place because the private root is the first place in this
 * codebase where a traversal would *read a secret* rather than write a
 * junk file — worth not depending on a single validator staying strict.
 */
function resolveWithin(root: string, key: string): string {
  const rootPath = resolve(root);
  const fullPath = resolve(rootPath, key);

  if (fullPath !== rootPath && !fullPath.startsWith(rootPath + sep)) {
    throw new Error('Storage key resolves outside the storage root');
  }

  return fullPath;
}

/**
 * Create Local provider
 *
 * Always returns a valid provider - no configuration required.
 */
export function createLocalProvider(config: LocalProviderConfig = {}): LocalProvider {
  return new LocalProvider(config);
}

/**
 * Create Local provider from environment variables
 *
 * Every variable is optional — the defaults are the development ones. This
 * exists so `client.ts` can configure the provider at all: it used to call
 * a zero-argument factory, which made `LocalProviderConfig` unreachable
 * outside tests.
 */
export function createLocalProviderFromEnv(): LocalProvider {
  const baseDir = process.env.STORAGE_LOCAL_BASE_DIR;
  const baseUrl = process.env.STORAGE_LOCAL_BASE_URL;
  const privateDir = process.env.STORAGE_LOCAL_PRIVATE_DIR;

  return new LocalProvider({
    ...(baseDir ? { baseDir } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(privateDir ? { privateDir } : {}),
  });
}
