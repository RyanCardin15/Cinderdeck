import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  isAsyncEncryptionAvailable: vi.fn(),
  encryptStringAsync: vi.fn(),
  decryptStringAsync: vi.fn(),
  isEncryptionAvailable: vi.fn(),
  encryptString: vi.fn(),
  decryptString: vi.fn(),
}));
vi.mock("electron", () => ({ safeStorage: mocks }));

import * as ElectronSafeStorage from "./ElectronSafeStorage.ts";

// Native calls are mocked; these tests never touch the user's Keychain.
const layer = ElectronSafeStorage.layer;
const provide = <A, E>(effect: Effect.Effect<A, E, ElectronSafeStorage.ElectronSafeStorage>) =>
  effect.pipe(Effect.provide(layer));

describe("ElectronSafeStorage", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.isAsyncEncryptionAvailable.mockResolvedValue(true);
    mocks.encryptStringAsync.mockResolvedValue(Buffer.from([1, 2, 3]));
    mocks.decryptStringAsync.mockResolvedValue({
      result: "existing catalog",
      shouldReEncrypt: true,
    });
  });

  it.effect(
    "uses non-blocking secure storage without changing ciphertext bytes or plaintext DTOs",
    () =>
      provide(
        Effect.gen(function* () {
          const storage = yield* ElectronSafeStorage.ElectronSafeStorage;
          assert.isTrue(yield* storage.isEncryptionAvailable);
          const encrypted = yield* storage.encryptString("catalog");
          assert.deepEqual(encrypted, Buffer.from([1, 2, 3]));
          assert.equal(yield* storage.decryptString(encrypted), "existing catalog");
          assert.deepEqual(mocks.encryptStringAsync.mock.calls, [["catalog"]]);
          assert.deepEqual(mocks.decryptStringAsync.mock.calls, [[Buffer.from([1, 2, 3])]]);
          assert.equal(mocks.isEncryptionAvailable.mock.calls.length, 0);
          assert.equal(mocks.encryptString.mock.calls.length, 0);
          assert.equal(mocks.decryptString.mock.calls.length, 0);
        }),
      ),
  );

  it.effect("allows sibling work while native availability waits for approval", () =>
    provide(
      Effect.gen(function* () {
        const pending = Promise.withResolvers<boolean>();
        mocks.isAsyncEncryptionAvailable.mockReturnValue(pending.promise);
        const storage = yield* ElectronSafeStorage.ElectronSafeStorage;
        const result = yield* Effect.all(
          [
            storage.isEncryptionAvailable,
            Effect.sync(() => {
              pending.resolve(true);
              return "sibling ran";
            }),
          ],
          { concurrency: "unbounded" },
        );
        assert.deepEqual(result, [true, "sibling ran"]);
        assert.equal(mocks.isEncryptionAvailable.mock.calls.length, 0);
      }),
    ),
  );

  it.effect("reports unavailable encryption without trying synchronous storage", () =>
    provide(
      Effect.gen(function* () {
        mocks.isAsyncEncryptionAvailable.mockResolvedValue(false);
        const storage = yield* ElectronSafeStorage.ElectronSafeStorage;
        assert.isFalse(yield* storage.isEncryptionAvailable);
        assert.equal(mocks.isEncryptionAvailable.mock.calls.length, 0);
      }),
    ),
  );

  it.effect("preserves typed failures for rejected native promises", () =>
    provide(
      Effect.gen(function* () {
        const cause = new Error("native secure storage rejected");
        mocks.isAsyncEncryptionAvailable.mockRejectedValue(cause);
        mocks.encryptStringAsync.mockRejectedValue(cause);
        mocks.decryptStringAsync.mockRejectedValue(cause);
        const storage = yield* ElectronSafeStorage.ElectronSafeStorage;
        const availability = yield* Effect.flip(storage.isEncryptionAvailable);
        const encrypt = yield* Effect.flip(storage.encryptString("catalog"));
        const decrypt = yield* Effect.flip(storage.decryptString(new Uint8Array([1])));
        assert.instanceOf(availability, ElectronSafeStorage.ElectronSafeStorageAvailabilityError);
        assert.instanceOf(encrypt, ElectronSafeStorage.ElectronSafeStorageEncryptError);
        assert.instanceOf(decrypt, ElectronSafeStorage.ElectronSafeStorageDecryptError);
        for (const failure of [availability, encrypt, decrypt]) {
          assert.strictEqual(failure.cause, cause);
          assert.notInclude(failure.message, cause.message);
        }
      }),
    ),
  );
});
