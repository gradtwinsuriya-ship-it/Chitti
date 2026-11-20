import { useEffect, useState } from "react";

export type PanelName = "memory" | "sources" | "tools" | "today" | "voice" | "vision" | "settings";

const chatItems: Array<{ label: string; panel: PanelName }> = [
  { label: "Memory", panel: "memory" },
  { label: "Sources", panel: "sources" },
  { label: "Tools", panel: "tools" },
  { label: "Today", panel: "today" },
  { label: "Voice", panel: "voice" },
  { label: "Vision", panel: "vision" },
  { label: "Settings", panel: "settings" },
];

const heroItems = [
  { label: "Chat", href: "/chat" },
  { label: "Memory", href: "/chat#memory" },
  { label: "Voice", href: "/chat#voice" },
  { label: "Vision", href: "/chat#vision" },
];

export default function Navigation({
  chat = false,
  onOpenPanel,
}: {
  chat?: boolean;
  onOpenPanel?: (panel: PanelName) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const closeMenu = () => setMenuOpen(false);
  const clockText = now.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
  const mobileActions = chat
    ? chatItems.map((item) => (
        <button
          key={item.panel}
          type="button"
          className="text-left text-[30px] font-medium leading-tight"
          onClick={() => {
            onOpenPanel?.(item.panel);
            closeMenu();
          }}
        >
          {item.label}
        </button>
      ))
    : heroItems.map((item) => (
        <a key={item.label} href={item.href} className="text-[30px] font-medium leading-tight" onClick={closeMenu}>
          {item.label}
        </a>
      ));

  return (
    <>
      <header className="fixed inset-x-0 top-0 z-40 flex items-center justify-between px-5 py-4 text-white sm:px-8 sm:py-5">
        <a href="/" className="flex items-center gap-3 text-white no-underline" aria-label="CHITTI home">
          <span className="font-heading text-[21px] tracking-tight sm:text-[26px]">CHITTI®</span>
          <span className="select-none text-[25px] tracking-[-.02em] sm:text-[30px]" aria-hidden="true">✳︎</span>
        </a>

        <nav className="absolute left-1/2 hidden -translate-x-1/2 items-center whitespace-nowrap text-[23px] text-white md:flex">
          {chat ? (
            chatItems.map((item, index) => (
              <span key={item.panel} className="flex items-center">
                {index > 0 && <span className="px-2 text-white/90">, </span>}
                <button
                  type="button"
                  className="transition-opacity hover:opacity-60"
                  onClick={() => onOpenPanel?.(item.panel)}
                >
                  {item.label}
                </button>
              </span>
            ))
          ) : (
            heroItems.map((item, index) => (
              <span key={item.label} className="flex items-center">
                {index > 0 && <span className="px-2 text-white/90">, </span>}
                <a href={item.href} className="transition-opacity hover:opacity-60">
                  {item.label}
                </a>
              </span>
            ))
          )}
        </nav>

        <div className="hidden items-center gap-4 md:flex">
          <time
            dateTime={now.toISOString()}
            className="hidden rounded-full border border-white/15 bg-black/25 px-3 py-1.5 text-xs text-white/80 xl:inline-flex"
          >
            {clockText}
          </time>
          <a
            href={chat ? "/" : "/chat"}
            className="text-[23px] text-white underline underline-offset-2 transition-opacity hover:opacity-60"
          >
            {chat ? "Back home" : "Open chat"}
          </a>
        </div>

        <button
          type="button"
          className="relative z-30 flex h-10 w-10 flex-col items-center justify-center gap-[5px] md:hidden"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span className={`h-[2px] w-6 bg-white transition-transform duration-300 ${menuOpen ? "translate-y-[7px] rotate-45" : ""}`} />
          <span className={`h-[2px] w-6 bg-white transition-opacity duration-300 ${menuOpen ? "opacity-0" : "opacity-100"}`} />
          <span className={`h-[2px] w-6 bg-white transition-transform duration-300 ${menuOpen ? "-translate-y-[7px] -rotate-45" : ""}`} />
        </button>
      </header>

      <div
        className={`fixed inset-0 z-30 flex flex-col justify-center gap-8 bg-black/90 px-8 text-white backdrop-blur-md transition-opacity duration-300 md:hidden ${
          menuOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
        aria-hidden={!menuOpen}
      >
        {mobileActions}
        <a
          href={chat ? "/" : "/chat"}
          className="text-[30px] leading-tight underline underline-offset-4"
          onClick={closeMenu}
        >
          {chat ? "Back home" : "Open chat"}
        </a>
      </div>
    </>
  );
}
