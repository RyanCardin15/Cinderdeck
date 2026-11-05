import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";
import {
  joinSocketFrameParts,
  splitLargeSocketFrames,
  splitSocketFrame,
} from "./socketFrameParts.ts";

describe("negotiated socket frame parts", () => {
  it("bounds UTF-8 frames without breaking multibyte characters or JSON", () => {
    const frame = JSON.stringify({ text: "é€😀x".repeat(80) });
    const parts = splitSocketFrame(frame, 17);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(17);
      expect(part.isWellFormed()).toBe(true);
    }
    expect(parts.slice(0, -1).every((part) => part.startsWith("\u001e"))).toBe(true);
    expect(parts.at(-1)?.startsWith("\u001e")).toBe(false);
    const restored = parts
      .map((part) => (part.startsWith("\u001e") ? part.slice(1) : part))
      .join("");
    expect(restored).toBe(frame);
    expect(JSON.parse(restored)).toEqual(JSON.parse(frame));
    expect(splitSocketFrame("{}", 17)).toEqual(["{}"]);
  });

  it.effect("preserves message ordering and binary data across writer and reader batches", () =>
    Effect.gen(function* () {
      const frame = JSON.stringify({ text: "😀".repeat(32 * 1024) });
      const binary = new Uint8Array([0, 1, 255]);
      const sent: Array<string | Uint8Array> = [];
      const writerSocket = Socket.make({
        reader: Effect.die("writer test must not read"),
        writer: Effect.succeed({
          write: (chunk) =>
            Effect.sync(() => {
              if (typeof chunk === "string" || chunk instanceof Uint8Array) sent.push(chunk);
            }),
          writeAll: (chunks) =>
            Effect.sync(() => {
              for (const chunk of chunks) {
                if (typeof chunk === "string" || chunk instanceof Uint8Array) sent.push(chunk);
              }
            }),
        }),
      });
      const writer = yield* splitLargeSocketFrames(writerSocket).writer;
      yield* writer.writeAll([frame, binary, "{}"]);
      const expectedParts = splitSocketFrame(frame);
      expect(sent).toEqual([...expectedParts, binary, "{}"]);

      let index = 0;
      const readerSocket = Socket.make({
        reader: Effect.succeed({
          upgrade: () => Effect.void,
          pull: Effect.sync(() => [sent[index++]!]),
        }),
        writer: Effect.die("reader test must not write"),
      });
      const reader = yield* joinSocketFrameParts(readerSocket).reader;
      for (let part = 0; part < expectedParts.length - 1; part++) {
        expect(yield* reader.pull).toEqual(['{"_tag":"Pong"}']);
      }
      expect(yield* reader.pull).toEqual([frame]);
      expect(yield* reader.pull).toEqual([binary]);
      expect(yield* reader.pull).toEqual(["{}"]);
    }),
  );
});
