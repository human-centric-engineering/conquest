/**
 * Local private storage against a real filesystem (sunrise#490).
 *
 * The unit suite for `LocalProvider` mocks `fs`, which is fine for branch
 * coverage but cannot demonstrate the two claims that actually matter here:
 *
 *   1. a `public: false` upload lands **outside** the directory Next serves
 *      statically, so it is not fetchable at `/uploads/<key>`; and
 *   2. `deletePrefix()` clears **both** roots — the GDPR erasure path, where
 *      a miss means a user's private files survive their own erasure.
 *
 * Both are filesystem facts. Asserting them against mocked `fs` would only
 * assert what the mock was told to return, so these run on real temp dirs.
 *
 * @see lib/storage/providers/local.ts
 * @see lib/privacy/erase-user.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { LocalProvider } from '@/lib/storage/providers/local';

/**
 * Scratch roots live under the repo's gitignored `.storage/`, not `os.tmpdir()`.
 * The OS temp dir is world-readable, so writing test fixtures there is the very
 * thing CWE-377 warns about — and CodeQL traces the flow from `tmpdir()` into
 * the provider's `writeFile`, failing the build on our own test setup.
 */
const SCRATCH_PARENT = join(process.cwd(), '.storage', 'test-runs');

let root: string;
let publicDir: string;
let privateDir: string;
let provider: LocalProvider;

beforeEach(async () => {
  await mkdir(SCRATCH_PARENT, { recursive: true });
  root = await mkdtemp(join(SCRATCH_PARENT, 'storage-'));
  // Mirrors the real layout: the public root is inside a `public/` tree that
  // Next would serve, the private root is a sibling that it would not.
  publicDir = join(root, 'public', 'uploads');
  privateDir = join(root, '.storage', 'private');
  provider = new LocalProvider({ baseDir: publicDir, privateDir });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('local provider — private objects on a real filesystem', () => {
  it('writes a private upload outside the statically served directory', async () => {
    const key = 'documents/user-1/contract.pdf';

    const result = await provider.upload(Buffer.from('confidential'), {
      key,
      contentType: 'application/pdf',
      public: false,
    });

    // Present in the private root...
    expect(existsSync(join(privateDir, key))).toBe(true);
    expect((await readFile(join(privateDir, key))).toString()).toBe('confidential');

    // ...and absent from the one Next serves. This is the whole fix: the file
    // used to land here, fetchable by anyone who could guess the key.
    expect(existsSync(join(publicDir, key))).toBe(false);
    expect(result.url).not.toContain('/uploads/');
  });

  it('writes a public upload to the statically served directory', async () => {
    const key = 'avatars/user-1/avatar.jpg';

    const result = await provider.upload(Buffer.from('image bytes'), {
      key,
      contentType: 'image/jpeg',
    });

    expect(existsSync(join(publicDir, key))).toBe(true);
    expect(existsSync(join(privateDir, key))).toBe(false);
    expect(result.url).toBe(`/uploads/${key}`);
  });

  it('reads a private object back through download()', async () => {
    const key = 'documents/user-1/contract.pdf';
    await provider.upload(Buffer.from('confidential'), {
      key,
      contentType: 'application/pdf',
      public: false,
    });

    const object = await provider.download(key);

    expect(object.body.toString()).toBe('confidential');
    expect(object.size).toBe(Buffer.byteLength('confidential'));
    expect(object.key).toBe(key);
  });

  it('deletePrefix clears private and public files under the prefix', async () => {
    // The erasure shape: eraseUser() calls deleteByPrefix('avatars/<id>/'),
    // and a user can have blobs in both roots.
    await provider.upload(Buffer.from('public avatar'), {
      key: 'avatars/user-1/avatar.jpg',
      contentType: 'image/jpeg',
    });
    await provider.upload(Buffer.from('private scan'), {
      key: 'avatars/user-1/id-scan.pdf',
      contentType: 'application/pdf',
      public: false,
    });

    const result = await provider.deletePrefix('avatars/user-1/');

    expect(result.success).toBe(true);
    expect(existsSync(join(publicDir, 'avatars/user-1/avatar.jpg'))).toBe(false);
    // The one that used to survive erasure.
    expect(existsSync(join(privateDir, 'avatars/user-1/id-scan.pdf'))).toBe(false);
  });

  it('deletePrefix leaves another user’s objects untouched', async () => {
    await provider.upload(Buffer.from('mine'), {
      key: 'avatars/user-1/doc.pdf',
      contentType: 'application/pdf',
      public: false,
    });
    await provider.upload(Buffer.from('theirs'), {
      key: 'avatars/user-2/doc.pdf',
      contentType: 'application/pdf',
      public: false,
    });

    await provider.deletePrefix('avatars/user-1/');

    expect(existsSync(join(privateDir, 'avatars/user-1/doc.pdf'))).toBe(false);
    expect(existsSync(join(privateDir, 'avatars/user-2/doc.pdf'))).toBe(true);
  });

  it('delete() removes a private object by key', async () => {
    const key = 'documents/user-1/contract.pdf';
    await provider.upload(Buffer.from('confidential'), {
      key,
      contentType: 'application/pdf',
      public: false,
    });

    const result = await provider.delete(key);

    expect(result.success).toBe(true);
    expect(existsSync(join(privateDir, key))).toBe(false);
  });

  it('removes the world-readable copy when a key flips from public to private', async () => {
    // Without this, `download()` would return the private bytes while the
    // original stayed fetchable at /uploads/<key> — the exact exposure the
    // private root exists to prevent, reintroduced by a re-upload.
    const key = 'documents/user-1/report.pdf';
    await provider.upload(Buffer.from('v1 public'), { key, contentType: 'application/pdf' });
    expect(existsSync(join(publicDir, key))).toBe(true);

    await provider.upload(Buffer.from('v2 private'), {
      key,
      contentType: 'application/pdf',
      public: false,
    });

    expect(existsSync(join(privateDir, key))).toBe(true);
    expect(existsSync(join(publicDir, key))).toBe(false);
  });

  it('removes the private copy when a key flips from private to public', async () => {
    const key = 'documents/user-1/report.pdf';
    await provider.upload(Buffer.from('v1 private'), {
      key,
      contentType: 'application/pdf',
      public: false,
    });

    await provider.upload(Buffer.from('v2 public'), { key, contentType: 'application/pdf' });

    expect(existsSync(join(publicDir, key))).toBe(true);
    // Otherwise download() would keep serving the stale private bytes, since
    // it checks the private root first.
    expect(existsSync(join(privateDir, key))).toBe(false);
    expect((await provider.download(key)).body.toString()).toBe('v2 public');
  });

  it('treats a key naming a directory as not found, not an errno', async () => {
    // `documents/user-1` is a real directory once a file is written beneath
    // it. Reading it must fall through to a clean "not found" rather than
    // surfacing EISDIR from readFile.
    await provider.upload(Buffer.from('confidential'), {
      key: 'documents/user-1/contract.pdf',
      contentType: 'application/pdf',
      public: false,
    });

    await expect(provider.download('documents/user-1')).rejects.toThrow(/not found/i);
  });

  it('reports the size of the bytes it actually read', async () => {
    const body = Buffer.from('exactly these bytes');
    await provider.upload(body, {
      key: 'documents/user-1/sized.bin',
      contentType: 'application/octet-stream',
      public: false,
    });

    const object = await provider.download('documents/user-1/sized.bin');

    expect(object.size).toBe(object.body.length);
    expect(object.size).toBe(body.length);
  });

  it('returns a valid URL for a private key containing a space', async () => {
    const result = await provider.upload(Buffer.from('x'), {
      key: 'documents/user 1/report.pdf',
      contentType: 'application/pdf',
      public: false,
    });

    expect(result.url).toBe('/api/v1/storage/documents/user%201/report.pdf');
  });

  it('refuses to read a file outside the storage root via an absolute key', async () => {
    const secret = join(root, 'secret.txt');
    await writeFile(secret, 'do not read me');

    await expect(provider.download(secret)).rejects.toThrow(/absolute path/i);
  });

  it('refuses a traversal key that would escape the private root', async () => {
    await mkdir(join(root, 'outside'), { recursive: true });
    await writeFile(join(root, 'outside', 'secret.txt'), 'do not read me');

    await expect(provider.download('../../outside/secret.txt')).rejects.toThrow(
      /must not contain/i
    );
  });
});
