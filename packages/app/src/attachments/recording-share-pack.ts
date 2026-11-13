import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { RecordingShareSegment } from "./recording-share";

const CHUNK = 1024 * 1024;
const PART = 16 * 1024 * 1024;
const LIMIT = 1024 * 1024 * 1024;
export type RecordingFileReader = (offset: number, length: number) => Promise<Uint8Array>;
export interface RecordingFilePart {
  id: string;
  offset: number;
  length: number;
}
interface Piece {
  read: RecordingFileReader;
  fileOffset: number;
  partOffset: number;
  length: number;
}
interface PendingPart {
  id: string;
  size: number;
  hash: ReturnType<typeof sha256.create>;
  pieces: Piece[];
}
async function readPart(part: PendingPart, offset: number, length: number): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    length > CHUNK ||
    offset + length > part.size
  )
    throw new Error("Invalid recording share part range");
  const output = new Uint8Array(length);
  let written = 0;
  let low = 0;
  let high = part.pieces.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const piece = part.pieces[middle];
    if (piece.partOffset + piece.length <= offset) low = middle + 1;
    else high = middle;
  }
  for (let index = low; written < length && index < part.pieces.length; index++) {
    const piece = part.pieces[index];
    const position = offset + written;
    if (position < piece.partOffset || position >= piece.partOffset + piece.length)
      throw new Error("Recording share part has a missing range");
    const inside = position - piece.partOffset;
    const count = Math.min(length - written, piece.length - inside);
    const bytes = await piece.read(piece.fileOffset + inside, count);
    if (bytes.length !== count) throw new Error("Recording changed while sharing");
    output.set(bytes, written);
    written += count;
  }
  if (written !== length) throw new Error("Recording share part has a missing range");
  return output;
}
export function createRecordingPacker() {
  const parts: PendingPart[] = [];
  let total = 0;
  return {
    async addFile(
      size: number,
      read: RecordingFileReader,
      expectedHash?: string,
    ): Promise<RecordingFilePart[]> {
      if (!Number.isSafeInteger(size) || size < 0 || total + size > LIMIT)
        throw new Error("Recording exceeds the 1 GiB sharing limit");
      total += size;
      const whole = sha256.create();
      const fileParts: RecordingFilePart[] = [];
      let offset = 0;
      while (offset < size) {
        let part = parts[parts.length - 1];
        if (!part || part.size === PART) {
          if (parts.length >= 1023) throw new Error("Recording has too many parts to share");
          part = { id: `part-${parts.length}`, size: 0, hash: sha256.create(), pieces: [] };
          parts.push(part);
        }
        const take = Math.min(size - offset, PART - part.size);
        const partOffset = part.size;
        part.pieces.push({ read, fileOffset: offset, partOffset, length: take });
        fileParts.push({ id: part.id, offset: partOffset, length: take });
        for (let consumed = 0; consumed < take; ) {
          const length = Math.min(CHUNK, take - consumed);
          const bytes = await read(offset + consumed, length);
          if (bytes.length !== length)
            throw new Error("Recording changed while preparing the share");
          whole.update(bytes);
          part.hash.update(bytes);
          consumed += length;
          part.size += length;
        }
        offset += take;
      }
      if (expectedHash && bytesToHex(whole.digest()) !== expectedHash)
        throw new Error("Media segment integrity check failed");
      return fileParts;
    },
    finish(): RecordingShareSegment[] {
      return parts.map((part) => ({
        id: part.id,
        size: part.size,
        sha256: bytesToHex(part.hash.digest()),
        read: (offset, length) => readPart(part, offset, length),
      }));
    },
    totalBytes: () => total,
  };
}
