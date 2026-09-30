import { Button, Dialog, DialogContent, DialogTitle, toast } from "@invai/ui";
import { Camera } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { emitScan } from "../scanner/bus";

/**
 * Optional camera-based scanning (B-105): a button that opens a live camera view and reads a
 * barcode/QR with the browser's native `BarcodeDetector`, when the browser has one. The
 * keyboard-wedge scanner stays the default and needs no button at all; this is only for a
 * tablet whose camera is the only scanner on hand. Feature detection alone never touches the
 * camera; `getUserMedia` (the permission prompt) only runs once this button is tapped.
 */
export function CameraScan() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const detectorRef = useRef<BarcodeDetector | null>(null);
  // True only while the dialog is open (or opening). Set false by close() and the unmount
  // cleanup, and checked right after getUserMedia resolves so a stream granted after the dialog
  // was closed (or the component unmounted) gets its tracks stopped immediately instead of being
  // assigned and started (S-44).
  const openRef = useRef(false);

  function stop() {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    detectorRef.current = null;
  }

  function loop() {
    rafRef.current = requestAnimationFrame(() => {
      const video = videoRef.current;
      const detector = detectorRef.current;
      if (!video || !detector || video.readyState < video.HAVE_CURRENT_DATA) {
        loop();
        return;
      }
      detector
        .detect(video)
        .then((codes) => {
          const hit = codes[0]?.rawValue;
          if (!hit) {
            loop();
            return;
          }
          stop();
          setOpen(false);
          emitScan(hit, "camera");
        })
        .catch(() => loop()); // a transient decode error is not a reason to give up
    });
  }

  async function start() {
    const Detector = window.BarcodeDetector;
    if (!Detector) {
      // No BarcodeDetector on this browser: say so and never touch the camera.
      toast.warning(t("floor.camera.notSupported"));
      return;
    }
    setError(null);
    setOpen(true);
    openRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      if (!openRef.current) {
        // The dialog was closed (or the component unmounted) while the permission prompt was
        // pending. Stop the stream we just got and don't assign it or start the detect loop.
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      detectorRef.current = new Detector();
      loop();
    } catch {
      if (openRef.current) setError(t("floor.camera.permissionDenied"));
      stop();
    }
  }

  function close() {
    openRef.current = false;
    stop();
    setOpen(false);
  }

  // Release the camera if the component unmounts mid-scan (refs only: stable across renders).
  useEffect(() => {
    return () => {
      openRef.current = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    };
  }, []);

  return (
    <>
      <Button
        size="xl"
        variant="outline"
        aria-label={t("floor.camera.open")}
        onClick={() => void start()}
        data-testid="camera-scan-button"
      >
        <Camera aria-hidden />
      </Button>
      <Dialog open={open} onOpenChange={(o) => !o && close()}>
        <DialogContent className="max-w-2xl p-6">
          <DialogTitle className="text-2xl">{t("floor.camera.title")}</DialogTitle>
          {error ? (
            <p className="py-10 text-center text-xl">{error}</p>
          ) : (
            <>
              <video
                ref={videoRef}
                className="aspect-video w-full rounded-xl bg-black"
                muted
                playsInline
              />
              <p className="text-center text-lg text-muted-foreground">{t("floor.camera.hint")}</p>
            </>
          )}
          <Button variant="outline" className="mt-2" onClick={close}>
            {t("floor.common.cancel")}
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
