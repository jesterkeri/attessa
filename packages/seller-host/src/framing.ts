/**
 * SPEC §4.2 framing: a 4-byte big-endian length, then that many bytes of JCS JSON, at most 65,536 bytes.
 * The enclave answers a length of 0 or above the cap with `bad_frame` and closes the connection.
 */

export const MAX_FRAME = 65_536;

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameError';
  }
}

/** Length prefix + payload. Throws `FrameError` on an empty or oversized payload. */
export function encodeFrame(payload: Uint8Array): Buffer {
  if (payload.length === 0 || payload.length > MAX_FRAME) {
    throw new FrameError(`frame payload must be 1..${MAX_FRAME} bytes, got ${payload.length}`);
  }
  const out = Buffer.allocUnsafe(4 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  out.set(payload, 4);
  return out;
}

/**
 * Accumulates stream chunks and yields whole frames. A declared length of 0 or above the cap is a
 * protocol error: `push` throws and the reader stays broken (the caller closes the socket).
 */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);
  private broken = false;

  push(chunk: Uint8Array): Buffer[] {
    if (this.broken) throw new FrameError('reader is broken');
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
    const frames: Buffer[] = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const len = this.buf.readUInt32BE(0);
      if (len === 0 || len > MAX_FRAME) {
        this.broken = true;
        throw new FrameError(`frame length ${len} is outside 1..${MAX_FRAME}`);
      }
      if (this.buf.length < 4 + len) break;
      frames.push(Buffer.from(this.buf.subarray(4, 4 + len)));
      this.buf = this.buf.subarray(4 + len);
    }
    return frames;
  }

  /** Bytes received that don't yet form a whole frame. */
  get pending(): number {
    return this.buf.length;
  }
}
