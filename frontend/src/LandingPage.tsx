import { useEffect, useState } from "react";
import Background from "./Background";
import Navigation from "./Navigation";

const TYPEWRITER_TEXT = "Glad you stopped in. Chat in English, Tamil or Tanglish. Now, what are we building?";

function useTypewriter(text: string, speed = 38, startDelay = 600) {
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      setDisplayed(text);
      setDone(true);
      return;
    }
    let position = 0;
    const timeout = window.setTimeout(() => {
      const interval = window.setInterval(() => {
        position += 1;
        setDisplayed(text.slice(0, position));
        if (position >= text.length) {
          window.clearInterval(interval);
          setDone(true);
        }
      }, speed);
    }, startDelay);
    return () => window.clearTimeout(timeout);
  }, [speed, startDelay, text]);

  return { displayed, done };
}

function HeroActions() {
  const [visible, setVisible] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setVisible(true);
      return;
    }
    const timeout = window.setTimeout(() => setVisible(true), 400);
    return () => window.clearTimeout(timeout);
  }, []);

  async function copyChatLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/chat`);
      setCopyStatus("Chat link copied.");
    } catch {
      setCopyStatus("Could not copy the chat link in this browser.");
    }
  }

  return (
    <>
      <div
        className={`flex flex-wrap gap-y-1 transition-[opacity,transform] duration-[400ms] ease-out ${
          visible ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
        }`}
      >
        {[
          ["Start chatting", "/chat"],
          ["Try Reflex mode", "/chat?mode=reflex"],
          ["Go Deliberate", "/chat?mode=deliberate"],
          ["Run Research", "/chat?mode=research"],
        ].map(([label, href]) => (
          <a
            key={label}
            href={href}
            className="mx-[.2em] mb-[.4em] inline-flex items-center justify-center whitespace-nowrap rounded-full border border-black/10 bg-white px-4 py-[.3em] text-[13px] text-black transition-colors duration-200 hover:bg-black hover:text-white sm:px-5 sm:text-[15px]"
          >
            {label}
          </a>
        ))}
        <button
          type="button"
          onClick={copyChatLink}
          className="mx-[.2em] mb-[.4em] inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full border border-white bg-transparent px-4 py-[.3em] text-[13px] text-white transition-colors duration-200 hover:bg-white hover:text-black sm:gap-3 sm:px-5 sm:text-[15px]"
        >
          <span>Open: <span className="underline underline-offset-1">chitti.local/chat</span></span>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <rect x="4" y="1" width="7" height="8" rx="1" stroke="currentColor" />
            <path d="M2 3.5H1v7h7V9" stroke="currentColor" />
          </svg>
        </button>
      </div>
      <p className="sr-only" role="status" aria-live="polite">{copyStatus}</p>
    </>
  );
}

export default function LandingPage() {
  const { displayed, done } = useTypewriter(TYPEWRITER_TEXT);

  return (
    <main className="relative min-h-[100svh] overflow-hidden bg-black text-white">
      <Background />
      <Navigation />
      <section className="relative z-10 flex h-[100svh] flex-col justify-end overflow-hidden px-5 pb-12 sm:px-8 md:justify-center md:px-10 md:pb-0">
        <div className="relative z-10 max-w-xl">
          <p className="pointer-events-none mb-5 select-none text-[clamp(18px,4vw,26px)] font-normal leading-[1.3] text-white [filter:blur(4px)] sm:mb-6">
            Hey there, meet CHITTI,<br />
            your Tanglish-friendly AI assistant
          </p>
          <p className="mb-5 min-h-[54px] text-[clamp(18px,4vw,26px)] font-normal leading-[1.35] text-white sm:mb-6">
            {displayed}
            {!done && <span className="ml-[2px] inline-block h-[1.1em] w-[2px] animate-blink bg-white align-middle" />}
          </p>
          <HeroActions />
        </div>
      </section>
    </main>
  );
}
