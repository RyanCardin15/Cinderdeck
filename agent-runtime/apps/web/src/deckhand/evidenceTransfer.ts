import { sha256 } from "@noble/hashes/sha2";
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
export type EvidenceAsset = {
  readonly id: string;
  readonly name: string;
  readonly kind: "video" | "frame" | "logs" | "diff" | "manifest" | "report";
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string | null;
  readonly state: "ready" | "missing" | "failed";
  readonly detail: string | null;
};
export type EvidenceAssetTransfer = {
  readonly asset: EvidenceAsset;
  readonly state: "prepared" | "excluded" | "failed";
  readonly detail: string;
};
export async function downloadEvidenceAssets(
  assets: ReadonlyArray<EvidenceAsset>,
  download: (asset: EvidenceAsset) => Promise<Response>,
  signal?: AbortSignal,
): Promise<{ files: ReadonlyArray<File>; transfers: ReadonlyArray<EvidenceAssetTransfer> }> {
  const files: Array<File> = [],
    transfers: Array<EvidenceAssetTransfer> = [];
  let reservedBytes = 0,
    reservedCount = 0;
  for (const asset of assets) {
    signal?.throwIfAborted();
    const limit =
      asset.kind === "frame"
        ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
        : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
    if (
      asset.state !== "ready" ||
      !asset.sha256 ||
      asset.size < 1 ||
      asset.size > limit ||
      reservedCount >= 8 ||
      reservedBytes + asset.size > 100 * 1024 * 1024
    ) {
      transfers.push({
        asset,
        state: "excluded",
        detail:
          asset.state !== "ready"
            ? (asset.detail ?? `Asset ${asset.state}`)
            : !asset.sha256
              ? "Checksum unavailable"
              : asset.size < 1
                ? "Empty asset"
                : asset.size > limit
                  ? "Exceeds composer attachment size limit"
                  : "Bundle exceeds 8 files or 100 MB; retained in Cinderdeck",
      });
      continue;
    }
    reservedBytes += asset.size;
    reservedCount++;
    try {
      const response = await download(asset);
      if (!response.ok || !response.body)
        throw new Error(`Asset download refused (${response.status})`);
      const reader = response.body.getReader();
      const chunks: Array<Uint8Array<ArrayBuffer>> = [];
      let size = 0;
      try {
        for (;;) {
          signal?.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > asset.size) throw new Error("Asset exceeds its prepared size");
          chunks.push(new Uint8Array(part.value));
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (size !== asset.size) throw new Error("Asset size changed");
      const hasher = sha256.create();
      for (const chunk of chunks) hasher.update(chunk);
      const actual = [...hasher.digest()]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      if (actual !== asset.sha256) throw new Error("Asset checksum changed");
      files.push(new File(chunks, asset.name, { type: asset.mimeType }));
      transfers.push({
        asset,
        state: "prepared",
        detail: "Bytes and checksum verified; composer upload pending",
      });
    } catch (cause) {
      signal?.throwIfAborted();
      transfers.push({
        asset,
        state: "failed",
        detail: cause instanceof Error ? cause.message : "Asset transfer failed",
      });
    }
  }
  return { files, transfers };
}
