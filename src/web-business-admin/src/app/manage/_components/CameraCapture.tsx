"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, X } from "lucide-react";
import { Button, IconButton } from "@chilli/ui";

/** True when the browser can open the camera inside the page (needs HTTPS and a camera); otherwise callers use the file input with capture. */
export const canUseLiveCamera = () => typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

/**
 * Full-screen live camera (back camera first) for photographing paper bills inside the installed app.
 * `onCapture` gets a JPEG File; `onFail` is called when the camera cannot start so the caller can fall back to the system camera.
 */
export function CameraCapture({ onCapture, onClose, onFail }: { onCapture: (f: File) => void; onClose: () => void; onFail: (reason: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 2560 }, height: { ideal: 1920 } }, audio: false });
        if (dead) { s.getTracks().forEach((t) => t.stop()); return; }
        stream.current = s;
        if (video.current) { video.current.srcObject = s; await video.current.play().catch(() => {}); setReady(true); }
      } catch (e) {
        if (dead) return;
        const name = (e as { name?: string })?.name;
        onFail(name === "NotAllowedError" || name === "SecurityError" ? "The camera is blocked for this site. Allow the camera in the browser's site settings, or choose a photo instead."
          : name === "NotFoundError" || name === "OverconstrainedError" ? "No camera was found on this device. Choose a photo instead."
          : "The camera could not start. Choose a photo instead.");
      }
    })();
    return () => { dead = true; stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  function snap() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d")?.drawImage(v, 0, 0);
    c.toBlob((b) => { if (b) onCapture(new File([b], `bill-${Date.now()}.jpg`, { type: "image/jpeg" })); }, "image/jpeg", 0.9);
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Camera" className="fixed inset-0 z-[100] flex flex-col bg-black">
      <div className="flex justify-end p-3"><IconButton label="Close camera" icon={<X />} variant="ghost" className="text-white" onClick={onClose} /></div>
      <video ref={video} playsInline muted className="min-h-0 w-full flex-1 object-contain" />
      <div className="flex justify-center p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        <Button size="lg" iconStart={<Camera />} disabled={!ready} onClick={snap}>Take photo</Button>
      </div>
    </div>
  );
}
