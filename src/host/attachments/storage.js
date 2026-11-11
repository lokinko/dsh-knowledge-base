import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const CHUNK = 64 * 1024;
const failure = message => Object.assign(new Error(message), { code: 'CORRUPT_ATTACHMENT' });
const aborted = signal => signal?.throwIfAborted();
async function regular(target, directory = false) {
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) throw failure('Unsafe attachment storage path');
  return stat;
}
async function syncDirectory(target) {
  let handle;
  try { handle = await fs.open(target, 'r'); await handle.sync(); }
  catch (error) { if (!['EISDIR', 'EACCES', 'EPERM', 'EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error; }
  finally { await handle?.close(); }
}

/** Always bounds downstream chunks, counts exact bytes, and verifies at EOF.
 * No file is accumulated, including during default-backend reconciliation.
 */
export async function* verifiedAttachment(data, row, signal) {
  const hash = createHash('sha256');
  let bytes = 0;
  aborted(signal);
  for await (const chunk of data) {
    aborted(signal);
    if (!(chunk instanceof Uint8Array)) throw failure('Attachment source yielded nonbinary data');
    for (let offset = 0; offset < chunk.byteLength; offset += CHUNK) {
      aborted(signal);
      const part = chunk.subarray(offset, offset + CHUNK);
      bytes += part.byteLength;
      if (!Number.isSafeInteger(bytes) || bytes > row.size) throw failure('Attachment byte length mismatch');
      hash.update(part);
      yield part;
    }
  }
  aborted(signal);
  if (bytes !== row.size || bytes !== row.ref.bytes || hash.digest('hex') !== row.sha256) throw failure('Attachment byte length or SHA-256 mismatch');
}
async function* fileData(target, signal) {
  aborted(signal);
  await regular(target);
  const handle = await fs.open(target, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw failure('Unsafe attachment object');
    while (true) {
      aborted(signal);
      const buffer = Buffer.allocUnsafe(CHUNK);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (!bytesRead) break;
      yield buffer.subarray(0, bytesRead);
    }
  } finally { await handle.close(); }
}

export class AttachmentStorage {
  constructor(adapter) {
    if (!adapter || ['save', 'read', 'hostPath'].some(name => typeof adapter[name] !== 'function')) throw new TypeError('Attachment blobs adapter requires save, read, and hostPath');
    this.adapter = adapter;
  }
  blobPath(root, row) {
    if (!/^[a-f0-9]{64}$/.test(row.sha256)) throw failure('Invalid attachment object identity');
    return path.join(root, 'blobs', row.sha256);
  }
  async directoryDescriptor(root, row, signal) {
    aborted(signal);
    await regular(root, true);
    await regular(path.join(root, 'blobs'), true);
    const hostPath = this.blobPath(root, row);
    const stat = await regular(hostPath);
    if (stat.size !== row.size) throw failure('Attachment byte length mismatch');
    return { hostPath, data: verifiedAttachment(fileData(hostPath, signal), row, signal) };
  }
  nativeDescriptor(row, signal) {
    aborted(signal);
    const hostPath = this.adapter.hostPath(row.ref);
    const adapter = this.adapter;
    const data = (async function* () { yield* verifiedAttachment(adapter.read(row.ref, signal), row, signal); })();
    return { ...(hostPath === undefined ? {} : { hostPath }), data };
  }
  async verify(data, row, signal) { for await (const _ of verifiedAttachment(data, row, signal)) { /* drain with bounded memory */ } }
  async ensure(root, row, source, signal) {
    const parent = path.join(root, 'blobs');
    await regular(root, true);
    await regular(parent, true);
    const target = this.blobPath(root, row);
    try {
      await this.verify((await this.directoryDescriptor(root, row, signal)).data, row, signal);
      return;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = path.join(parent, '.tmp-' + randomUUID());
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      for await (const chunk of verifiedAttachment(await source(), row, signal)) {
        let offset = 0;
        while (offset < chunk.byteLength) {
          aborted(signal);
          const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, null);
          if (!bytesWritten) throw failure('Attachment write made no progress');
          offset += bytesWritten;
        }
      }
      await handle.sync();
      await handle.close(); handle = null;
      await fs.rename(temporary, target);
      await syncDirectory(parent);
    } finally {
      await handle?.close();
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  async restore(row, source, signal) {
    let complete = false;
    const data = (async function* () {
      yield* verifiedAttachment(await source(), row, signal);
      complete = true;
    })();
    let ref;
    try { ref = await this.adapter.save({ data, name: row.ref.name, signal }); }
    finally { await data.return(); }
    if (!complete || ref.attachmentId !== row.ref.attachmentId || ref.bytes !== row.ref.bytes) throw failure('Native attachment reference changed during migration');
    // The adapter is immutable; verify the saved object before native metadata
    // can become visible. Name is presentation data, not the content identity.
    await this.verify(this.adapter.read(ref, signal), row, signal);
  }
}
