/** A failed camera frame stops scanning and gives the real screen a retry path.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/onboarding/scannerFailures.test.tsx
 * ├── src/screens/onboarding/ScanQr.tsx
 * └── src/test/render.tsx
 * External: @testing-library/react, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { renderShell } from '../../test/render.tsx';
import { ScanQr } from './ScanQr.tsx';

const decoder = vi.hoisted(() => ({ read: vi.fn(), prepare: vi.fn() }));
vi.mock('zxing-wasm/reader', () => ({ readBarcodes: decoder.read, prepareZXingModule: decoder.prepare }));

const frameDescriptor = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'requestVideoFrameCallback');
let stop: ReturnType<typeof vi.fn>;
let draw: ReturnType<typeof vi.fn>;
let image: ReturnType<typeof vi.fn>;
beforeEach(() => {
  stop = vi.fn();
  draw = vi.fn();
  image = vi.fn(() => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) }));
  decoder.read.mockReset().mockResolvedValue([]);
  vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue({ getTracks: () => [{ stop }] } as unknown as MediaStream);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw, getImageData: image } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(1);
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(1);
  Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', { configurable: true, value: vi.fn() });
  window.history.replaceState(null, '', '#/scan');
});
afterEach(() => {
  vi.restoreAllMocks();
  if (frameDescriptor) Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', frameDescriptor);
  else Reflect.deleteProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback');
});

it.each(['decoder', 'draw', 'pixels', 'canvas'] as const)('a rejected %s frame stops the camera and Scan again starts another attempt', async (kind) => {
  const failure = new Error('private decoder diagnostics');
  if (kind === 'decoder') decoder.read.mockRejectedValueOnce(failure);
  else if (kind === 'canvas') vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValueOnce(null);
  else (kind === 'draw' ? draw : image).mockImplementationOnce(() => { throw failure; });
  const view = renderShell(<ScanQr />);
  const video = screen.getByLabelText('Camera preview') as HTMLVideoElement;
  const alert = await screen.findByRole('alert');
  expect(stop).toHaveBeenCalledOnce();
  expect(video.srcObject).toBeNull();
  expect(alert.textContent).not.toContain('private decoder diagnostics');
  fireEvent.click(screen.getByRole('button', { name: 'Scan again' }));
  await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('alert')).toBeNull();
  view.unmount();
});
it('a decoder failure after teardown does not report an error or stop the camera twice', async () => {
  let reject!: (err: Error) => void;
  decoder.read.mockReturnValueOnce(new Promise((_, r) => { reject = r; }));
  const view = renderShell(<ScanQr />);
  await waitFor(() => expect(decoder.read).toHaveBeenCalledOnce());
  view.unmount();
  await act(async () => reject(new Error('late decoder failure')));
  expect(stop).toHaveBeenCalledOnce();
  expect(screen.queryByRole('alert')).toBeNull();
});
it('a camera play failure still stops the tracks and shows recovery', async () => {
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error('play refused'));
  renderShell(<ScanQr />);
  await screen.findByRole('alert');
  expect(stop).toHaveBeenCalledOnce();
});
