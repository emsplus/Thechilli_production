import type { ReactNode } from "react";

/**
 * Tiny, safe markdown subset for assistant answers: paragraphs, line breaks, **bold**, `code`, - / * / 1. lists.
 * Everything is rendered as React text nodes, so no HTML can be injected.
 */
function inline(text: string, base: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={`${base}${i}`} className="font-semibold">{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={`${base}${i}`} className="rounded bg-surface-3 px-1 py-0.5 font-mono text-[0.85em]">{part.slice(1, -1)}</code>;
    return part;
  });
}

export function MarkdownLite({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flushPara = () => {
    if (!para.length) return;
    const k = blocks.length;
    blocks.push(<p key={k}>{para.map((l, i) => <span key={i}>{i > 0 && <br />}{inline(l, `${k}-${i}-`)}</span>)}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const k = blocks.length; const L = list;
    const items = L.items.map((it, i) => <li key={i}>{inline(it, `${k}-${i}-`)}</li>);
    blocks.push(L.ordered ? <ol key={k} className="ml-5 list-decimal space-y-1">{items}</ol> : <ul key={k} className="ml-5 list-disc space-y-1">{items}</ul>);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line), num = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || num) {
      flushPara();
      const ordered = !!num;
      if (list && list.ordered !== ordered) flushList();
      list = list ?? { ordered, items: [] };
      list.items.push((bullet ?? num)![1]);
    } else if (line.trim() === "") { flushPara(); flushList(); }
    else { flushList(); para.push(line); }
  }
  flushPara(); flushList();
  return <div className="space-y-2 break-words">{blocks}</div>;
}
