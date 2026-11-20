import ChatPage from "./ChatPage";
import LandingPage from "./LandingPage";

export default function App() {
  if (window.location.pathname === "/chat") return <ChatPage />;
  return <LandingPage />;
}
