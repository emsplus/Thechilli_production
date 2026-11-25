"use client";

import { Badge, Button, IconButton, Sheet, Skeleton } from "@chilli/ui";
import { useEffect, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, BarChart3, History, Lightbulb, Lock, MessageSquarePlus, SendHorizontal, Sparkles, X } from "lucide-react";
import { motion } from "motion/react";
import { EmptyState } from "@/components/ui";
import { ChatAssistantIllustration } from "@/components/illustrations";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/datetime";
import type { ChatReply, ConversationDetail, ConversationSummary } from "@/lib/types";
import { useLoader } from "@/lib/useLoader";
import { Attachments } from "./ai-attachments";
import { MarkdownLite } from "./markdown-lite";
import { QuickBar, QuickQuestions } from "./quick-questions";

type Msg = ConversationDetail["messages"][number];
const fetchConvs = () => api.conversations();
const pretty = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

function Sources({ calls }: { calls: NonNullable<Msg["tool_calls"]> }) {
  const names = [...new Set(calls.map((t) => t.metric ?? t.name))];
  const incomplete = calls.some((t) => t.data_complete === false);
  if (!names.length) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="Sources">
      <span className="text-xs text-fg-subtle">Based on:</span>
      {names.map((n) => <Badge key={n} tone="neutral"><BarChart3 />{pretty(n)}</Badge>)}
      {incomplete && <Badge tone="warning"><AlertTriangle />Data may be incomplete</Badge>}
    </div>
  );
}

function ConversationList({ convs, cid, now, onOpen, onNew }: { convs: ConversationSummary[] | null; cid?: string; now: number; onOpen: (id: string) => void; onNew: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <Button className="w-full" variant="secondary" iconStart={<MessageSquarePlus />} onClick={onNew}>New chat</Button>
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {!convs ? <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          : convs.length === 0 ? <p className="px-1 text-sm text-fg-muted">Your past questions will appear here.</p> : (
            <ul className="space-y-1">
              {convs.map((c) => (
                <li key={c.id}>
                  <button onClick={() => onOpen(c.id)} aria-current={c.id === cid || undefined}
                    className={cn("w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-surface-2", c.id === cid && "bg-primary-soft text-primary-soft-fg hover:bg-primary-soft")}>
                    <span className="line-clamp-2 text-sm font-medium">{c.title}</span>
                    <span className="text-xs opacity-70">{relativeTime(c.created_at, now)}</span>
                  </button>
                </li>))}
            </ul>)}
      </div>
    </div>
  );
}

/** The assistant chat, laid out for the side drawer (header, scrolling messages, question box). */
export function AiChat({ onClose, active }: { onClose: () => void; active: boolean }) {
  const { data: convs, reload } = useLoader(fetchConvs);
  const [cid, setCid] = useState<string | undefined>();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [histOpen, setHistOpen] = useState(false);
  const [ideasOpen, setIdeasOpen] = useState(false);
  const [now, setNow] = useState(0);
  const end = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { const tick = () => setNow(Date.now()); tick(); const t = setInterval(tick, 60000); return () => clearInterval(t); }, []);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs, busy, error]);
  useEffect(() => { if (active) { const t = setTimeout(() => field.current?.focus(), 250); return () => clearTimeout(t); } }, [active]);
  useEffect(() => { const el = field.current; if (el) { el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 160)}px`; } }, [text]);

  async function open(id: string) {
    setError(null); setHistOpen(false);
    try { const c = await api.conversation(id); setCid(id); setMsgs(c.messages); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Failed to load"); }
  }
  function fresh() { setCid(undefined); setMsgs([]); setError(null); setHistOpen(false); field.current?.focus(); }

  async function send(message: string) {
    if (!message.trim() || busy) return;
    setBusy(true); setError(null); setIdeasOpen(false);
    setMsgs((m) => [...m, { role: "user", content: message, tool_calls: null, created_at: new Date().toISOString() }]);
    setText("");
    try {
      const r: ChatReply = await api.chat(message, cid);
      setCid(r.conversation_id);
      setMsgs((m) => [...m, { role: "model", content: r.answer, tool_calls: r.tools_used, attachments: r.attachments ?? [], created_at: new Date().toISOString() }]);
      void reload();
    } catch (e) {
      setMsgs((m) => m.slice(0, -1));
      setText(message);
      setError(!navigator.onLine || (e instanceof ApiError && e.status === 0) ? "The assistant needs an internet connection." : e instanceof ApiError ? e.message : "Something went wrong");
    } finally { setBusy(false); field.current?.focus(); }
  }

  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-soft-fg"><Sparkles className="size-[1.1rem]" /></span>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-base font-bold leading-tight text-fg">AI assistant</h2>
          <p className="text-xs leading-snug text-fg-muted">Ask plain questions about your restaurant.</p>
        </div>
        {(msgs.length > 0 || busy) && <IconButton label="Question ideas" icon={<Lightbulb />} aria-expanded={ideasOpen} onClick={() => setIdeasOpen((o) => !o)} />}
        <IconButton label="Past chats" icon={<History />} onClick={() => setHistOpen(true)} />
        <IconButton label="New chat" icon={<MessageSquarePlus />} onClick={fresh} />
        <IconButton label="Close AI assistant" icon={<X />} onClick={onClose} />
      </header>
      {ideasOpen && (
        <>
          <div aria-hidden className="absolute inset-0 z-10" onClick={() => setIdeasOpen(false)} />
          <div role="region" aria-label="Question ideas" onKeyDown={(e) => { if (e.key === "Escape") { e.nativeEvent.stopPropagation(); setIdeasOpen(false); } }}
            className="absolute inset-x-3 top-[4.25rem] z-20 max-h-[65dvh] overflow-y-auto rounded-2xl border border-border bg-surface p-3 shadow-modal scrollbar-thin">
            <QuickQuestions onPick={(q) => void send(q)} />
          </div>
        </>
      )}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 scrollbar-thin" aria-live="polite" aria-relevant="additions">
        {msgs.length === 0 && !busy ? (
              <EmptyState compact illustration={<ChatAssistantIllustration />} title="What would you like to know?" hint="I read your own sales, stock, purchase and profit reports and answer in plain language. I can also prepare a PDF."
                action={<QuickQuestions onPick={(q) => void send(q)} className="mt-1" />} className="[&>div:last-child]:w-full" />
            ) : (
              <ul className="space-y-4">
                {msgs.map((m, i) => (
                  <motion.li key={i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className={cn("flex gap-2.5", m.role === "user" && "justify-end")}>
                    {m.role === "model" && <span aria-hidden className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-primary-soft text-primary-soft-fg"><Sparkles className="size-4" /></span>}
                    <div className={cn("max-w-[90%]", m.role === "user" && "text-right")}>
                      <span className="sr-only">{m.role === "user" ? "You said" : "Assistant said"}</span>
                      <div className={cn("inline-block rounded-2xl px-4 py-2.5 text-left text-sm leading-relaxed", m.role === "user" ? "rounded-br-md bg-primary text-primary-fg" : "rounded-bl-md bg-surface-2 text-fg")}>
                        {m.role === "user" ? <p className="whitespace-pre-wrap break-words">{m.content}</p> : <MarkdownLite text={m.content} />}
                      </div>
                      {m.tool_calls && m.tool_calls.length > 0 && <Sources calls={m.tool_calls} />}
                      {m.attachments && m.attachments.length > 0 && <Attachments items={m.attachments} />}
                    </div>
                  </motion.li>
                ))}
                {busy && (
                  <li className="flex items-center gap-2.5" role="status" aria-label="Checking your reports">
                    <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-primary-soft text-primary-soft-fg"><Sparkles className="size-4" /></span>
                    <span className="inline-flex items-center gap-1.5 rounded-2xl rounded-bl-md bg-surface-2 px-4 py-3">
                      {[0, 1, 2].map((d) => <motion.span key={d} className="size-2 rounded-full bg-fg-subtle" animate={{ opacity: [0.3, 1, 0.3], y: [0, -3, 0] }} transition={{ duration: 1, repeat: Infinity, delay: d * 0.15 }} />)}
                      <span className="ml-1 text-xs text-fg-muted">Checking your reports…</span>
                    </span>
                  </li>
                )}
              </ul>
            )}
            {error && (
              <div className="mt-4 flex items-start gap-2 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger-fg"><AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden /><p role="alert">{error}</p></div>
            )}
            <div ref={end} />
          </div>

          <form className="shrink-0 border-t border-border p-3" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
            {msgs.length > 0 && <QuickBar onPick={(q) => void send(q)} disabled={busy} />}
            <div className="flex items-end gap-2">
              <textarea ref={field} rows={1} aria-label="Your question" placeholder="Ask about sales, stock, purchases or profit" maxLength={2000} value={text} onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(text); } }}
                className="max-h-40 min-h-11 flex-1 resize-none rounded-xl border border-border-strong bg-surface px-3.5 py-2.5 text-base text-fg placeholder:text-fg-subtle focus:border-ring focus:outline-none focus:ring-3 focus:ring-ring/25 sm:text-sm" />
              <Button variant="primary" type="submit" size="lg" className="h-11" disabled={busy || !text.trim()}>Ask<SendHorizontal /></Button>
            </div>
            <p className="mt-2 flex items-center gap-1.5 text-xs text-fg-subtle"><Lock className="size-3.5 shrink-0" aria-hidden />Answers come only from your own reports and the assistant can only read, never change anything. Enter to send, Shift+Enter for a new line.</p>
          </form>
      <Sheet side="right" open={histOpen} onOpenChange={setHistOpen} title="Past chats">
        <div className="h-[70dvh] py-2"><ConversationList convs={convs} cid={cid} now={now} onOpen={(id) => void open(id)} onNew={fresh} /></div>
      </Sheet>
    </>
  );
}
