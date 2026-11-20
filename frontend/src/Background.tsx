import { useEffect, useRef } from "react";

const VIDEO_URL =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260826_041744_63efcd78-bf7d-4039-99e2-2461e8a61903.mp4";
const SENSITIVITY = 0.8;

export default function Background({ darken = false }: { darken?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let previousX: number | null = null;
    let targetTime = 0;

    const onMouseMove = (event: MouseEvent) => {
      if (!video.duration || !Number.isFinite(video.duration)) {
        previousX = event.clientX;
        return;
      }
      if (previousX === null) {
        previousX = event.clientX;
        targetTime = video.currentTime;
        return;
      }
      const delta = event.clientX - previousX;
      previousX = event.clientX;
      targetTime = Math.min(
        video.duration,
        Math.max(0, targetTime + (delta / window.innerWidth) * SENSITIVITY * video.duration),
      );
      if (!video.seeking) video.currentTime = targetTime;
    };

    const onSeeked = () => {
      if (!video.seeking && Math.abs(video.currentTime - targetTime) > 0.025) {
        video.currentTime = targetTime;
      }
    };

    window.addEventListener("mousemove", onMouseMove);
    video.addEventListener("seeked", onSeeked);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      video.removeEventListener("seeked", onSeeked);
    };
  }, []);

  return (
    <>
      <video
        ref={videoRef}
        className="fixed inset-0 z-0 h-full w-full object-cover"
        style={{ objectPosition: "70% center" }}
        muted
        playsInline
        preload="auto"
      >
        <source src={VIDEO_URL} type="video/mp4" />
      </video>
      {darken && <div className="fixed inset-0 z-[1] bg-black/55" aria-hidden="true" />}
    </>
  );
}
