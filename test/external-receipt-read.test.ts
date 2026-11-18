import type * as FsPromises from "node:fs/promises";
import { open, type FileHandle } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { readExternalReceipt } from "../src/runtime/external-verification.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof FsPromises>()),
  open: vi.fn(),
}));

describe("bounded external receipt import", () => {
  it("bounds the read even when a regular file grows after its initial stat", async () => {
    let readBytes = 0;
    const close = vi.fn(() => Promise.resolve());
    const readFile = vi.fn(() =>
      Promise.reject(new Error("Unbounded readFile must never be used")),
    );
    vi.mocked(open).mockResolvedValue({
      stat: () => Promise.resolve({ isFile: () => true, size: 1 }),
      read: (buffer: Buffer, offset: number, length: number) => {
        const bytesRead = Math.min(length, 1024 * 1024);
        buffer.fill(32, offset, offset + bytesRead);
        readBytes += bytesRead;
        return Promise.resolve({ bytesRead });
      },
      readFile,
      close,
    } as unknown as FileHandle);
    await expect(
      readExternalReceipt("/private/growing.json"),
    ).rejects.toMatchObject({ code: "EXTERNAL_EVIDENCE_INVALID" });
    expect(readBytes).toBe(4 * 1024 * 1024 + 1);
    expect(readFile).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
  it("reads a stable small receipt and closes its handle", async () => {
    const bytes = Buffer.from('{"fixture":true}');
    let position = 0;
    const close = vi.fn(() => Promise.resolve());
    vi.mocked(open).mockResolvedValue({
      stat: () => Promise.resolve({ isFile: () => true, size: bytes.length }),
      read: (buffer: Buffer, offset: number, length: number) => {
        const count = Math.min(length, bytes.length - position);
        bytes.copy(buffer, offset, position, position + count);
        position += count;
        return Promise.resolve({ bytesRead: count });
      },
      close,
    } as unknown as FileHandle);
    await expect(readExternalReceipt("/private/receipt.json")).resolves.toEqual(
      { fixture: true },
    );
    expect(close).toHaveBeenCalledOnce();
  });
});
