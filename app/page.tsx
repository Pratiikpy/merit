import { redirect } from "next/navigation";

// The Merit frontend is the hand-authored static app at /index.html
// (served at "/" via the beforeFiles rewrite in next.config.ts).
// This page is only a fallback if that rewrite is bypassed.
export default function Home() {
  redirect("/index.html");
}
