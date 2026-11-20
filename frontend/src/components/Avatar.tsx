import { CSSProperties, KeyboardEvent, PointerEvent, useEffect, useState } from "react";
import { MouthShape } from "../speechPlan";

const mouthShapes: MouthShape[] = [
  "neutral",
  "smile",
  "open",
  "o_shape",
  "talk",
  "teeth_clench",
  "ah",
  "kiss",
  "surprised",
];

interface AvatarProps {
  thinking: boolean;
  listening: boolean;
  speaking: boolean;
  mouthShape: MouthShape;
  wordTick: number;
  placement: "desktop" | "mobile";
  onActivate: () => void;
}

export default function Avatar({
  thinking,
  listening,
  speaking,
  mouthShape,
  wordTick,
  placement,
  onActivate,
}: AvatarProps) {
  const [reducedMotion, setReducedMotion] = useState(false);
  const [touchInput, setTouchInput] = useState(false);
  const [characterFallback, setCharacterFallback] = useState(false);
  const [tilt, setTilt] = useState(0);
  const [tabVisible, setTabVisible] = useState(!document.hidden);
  const state = listening ? "listening" : speaking ? "speaking" : thinking ? "thinking" : "idle";
  const currentMouth = state === "listening" ? "smile" : state === "speaking" ? mouthShape : "neutral";
  const assetBase = new URL(import.meta.url).pathname.includes("/src/") ? "/avatar" : "/static/dist/avatar";
  const characterSrc = `${assetBase}/character.${characterFallback ? "png" : "webp"}`;

  useEffect(() => {
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const touchQuery = window.matchMedia("(pointer: coarse)");
    const updatePreferences = () => {
      setReducedMotion(motionQuery.matches);
      setTouchInput(touchQuery.matches);
    };
    const updateVisibility = () => setTabVisible(!document.hidden);
    updatePreferences();
    updateVisibility();
    motionQuery.addEventListener("change", updatePreferences);
    touchQuery.addEventListener("change", updatePreferences);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      motionQuery.removeEventListener("change", updatePreferences);
      touchQuery.removeEventListener("change", updatePreferences);
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, []);

  useEffect(() => {
    for (const shape of mouthShapes) {
      const image = new Image();
      image.src = `${assetBase}/mouths/${shape}.png`;
    }
  }, [assetBase]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onActivate();
    }
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (touchInput || reducedMotion || event.pointerType === "touch") return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const horizontalPosition = (event.clientX - bounds.left) / bounds.width;
    setTilt(Math.max(-4, Math.min(4, (horizontalPosition - 0.5) * 8)));
  }

  const personClass = [
    "chitti-avatar-person",
    `chitti-avatar-person-${state}`,
    speaking && !reducedMotion ? `chitti-avatar-bob-${wordTick % 2}` : "",
    !reducedMotion && tabVisible ? "chitti-avatar-motion-enabled" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={`chitti-avatar chitti-avatar-${placement}`}>
      <div
        className={personClass}
        role="img"
        aria-label={`CHITTI is ${state}`}
        tabIndex={0}
        style={{ "--avatar-tilt": `${reducedMotion || touchInput ? 0 : tilt}deg` } as CSSProperties}
        onClick={onActivate}
        onKeyDown={handleKeyDown}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setTilt(0)}
      >
        <div className="chitti-avatar-art" aria-hidden="true">
          <img
            className="chitti-avatar-character"
            src={characterSrc}
            alt=""
            draggable={false}
            onError={() => {
              if (!characterFallback) setCharacterFallback(true);
            }}
          />
          {mouthShapes.map((shape) => (
            <img
              key={shape}
              className="chitti-avatar-mouth"
              src={`${assetBase}/mouths/${shape}.png`}
              alt=""
              aria-hidden="true"
              draggable={false}
              style={{ opacity: currentMouth === shape ? 1 : 0 }}
            />
          ))}
          <span className="chitti-avatar-ground-shadow" />
        </div>
      </div>
      <p className="chitti-avatar-caption" role="status" aria-live="polite">
        {state === "listening" ? "Listening..." : state === "thinking" ? "Thinking..." : state === "speaking" ? "Speaking..." : "Ready"}
      </p>
    </div>
  );
}
