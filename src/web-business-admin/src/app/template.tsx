import { ViewTransition } from "react";

/**
 * Re-mounts on every navigation. On browsers with the View Transitions API, React's <ViewTransition> cross-fades
 * the old page out and slides the new one in (classes in globals.css); the shell chrome is excluded. Elsewhere a
 * CSS-only keyframe plays instead. Both are disabled under reduced motion / "Reduce effects", and neither can leave
 * content hidden (the browser always ends on the live DOM).
 */
export default function Template({ children }: { children: React.ReactNode }) {
  return (
    <ViewTransition enter="vt-page-in" exit="vt-page-out" default="none">
      <div className="page-enter">{children}</div>
    </ViewTransition>
  );
}
