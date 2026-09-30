/**
 * Minimal native Barcode Detection API types (T-23-2, B-105). TypeScript's DOM lib doesn't ship
 * these yet, so they're declared by hand here, matching the shape the spec (and the native
 * Chrome/Android implementation) actually returns -- just enough for `CameraScan.tsx`. Not a
 * polyfill: this only describes `window.BarcodeDetector` when the browser provides it.
 */
interface DetectedBarcode {
  readonly rawValue: string;
}

interface BarcodeDetectorOptions {
  formats?: string[];
}

declare class BarcodeDetector {
  constructor(options?: BarcodeDetectorOptions);
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

interface Window {
  BarcodeDetector?: typeof BarcodeDetector;
}
