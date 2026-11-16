/**
 * The in-WebView QR scanner: rear camera through `getUserMedia`, a frame loop, zxing-wasm.
 *
 * Frames are pulled on `requestVideoFrameCallback` (falling back to `requestAnimationFrame`),
 * drawn to an offscreen canvas and decoded with zxing restricted to QR codes. The first
 * decoded text resolves the scan; every camera track is stopped on any exit.
 *
 * - Works on de-Googled Android (no BarcodeDetector / ML Kit). If the WebView camera fails
 *   on a device, the native `Qr.scan()` fallback designed in Phase 14 work item 7 keeps this
 *   signature (G6, Phase 19); the typed-URL path always exists.
 * - Never touches the network: the wasm is bundled (`wasm.ts`).
 *
 * <module-headers:begin>
 * Uses:
 * src/scanner.ts
 * └── src/wasm.ts
 * External: zxing-wasm
 *
 * Used by:
 * src/scanner.ts
 * └── src/index.ts
 * <module-headers:end>
 */
import { readBarcodes } from 'zxing-wasm/reader';

import { prepareBundledReader } from './wasm.ts';

export type ScanFailure = 'permission_denied' | 'no_camera' | 'camera_failed' | 'cancelled';

export class ScanError extends Error {
  constructor(readonly reason: ScanFailure) {
    super(reason);
  }
}

export interface ScanHandle {
  /** Resolves with the first decoded QR text; rejects with a ScanError. */
  result: Promise<string>;
  /** Stops the camera and rejects `result` with `cancelled`. */
  stop(): void;
}

function failureOf(err: unknown): ScanFailure {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'permission_denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no_camera';
  return 'camera_failed';
}

/** Starts scanning into `video` (muted, playsInline, rendered by the caller). */
export function startScan(video: HTMLVideoElement): ScanHandle {
  prepareBundledReader();
  let stream: MediaStream | null = null;
  let stopped = false;
  let rejectResult: (e: ScanError) => void = () => {};
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const teardown = () => {
    stopped = true;
    stream?.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };

  const result = new Promise<string>((resolve, reject) => {
    rejectResult = reject;
    const nextFrame = (cb: () => void) =>
      'requestVideoFrameCallback' in video ? video.requestVideoFrameCallback(() => cb()) : requestAnimationFrame(cb);

    const tick = async () => {
      if (stopped || !ctx) return;
      if (video.videoWidth > 0) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const [hit] = await readBarcodes(ctx.getImageData(0, 0, canvas.width, canvas.height), {
          formats: ['QRCode'],
          maxNumberOfSymbols: 1,
        });
        if (hit?.isValid && !stopped) {
          teardown();
          resolve(hit.text);
          return;
        }
      }
      nextFrame(() => void tick());
    };

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then(async (s) => {
        stream = s;
        if (stopped) return teardown();
        video.srcObject = s;
        await video.play();
        void tick();
      })
      .catch((err: unknown) => {
        teardown();
        reject(new ScanError(failureOf(err)));
      });
  });

  return {
    result,
    stop: () => {
      if (stopped) return;
      teardown();
      rejectResult(new ScanError('cancelled'));
    },
  };
}
