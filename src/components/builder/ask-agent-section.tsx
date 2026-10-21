"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Radio, Send, ShieldCheck, TriangleAlert } from "lucide-react";

import { useBuilder } from "@/components/builder/builder-provider";
import { stepStateFor } from "@/components/builder/progress";
import { SectionError } from "@/components/builder/section-error";
import { StepShell } from "@/components/builder/step-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * "Ask your agent".
 *
 * Two honest modes, and the difference is made visible rather than blurred:
 *
 *   - a readiness answer is labelled as coming from verification data;
 *   - a live answer is labelled with the origin the tool actually ran on;
 *   - when no live target is connected, the panel says so and offers to
 *     connect one instead of answering a content question anyway.
 */

const SUGGESTIONS_READINESS = [
  "Is WebMCP working on my site?",
  "Why are only some tools registered?",
  "Are any mappings broken?",
];

const SUGGESTIONS_LIVE = [
  "Does this person know Kubernetes?",
  "Which projects use React?",
  "Where did they work?",
];

export function AskAgentSection() {
  const { state, chat, askAgent, liveTest, startLiveTest, stopLiveTest, refreshLiveTest } =
    useBuilder();
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const transcriptEnd = useRef<HTMLDivElement>(null);

  const remaining =
    chat.reduce<number | null>(
      (latest, turn) => (turn.questionsRemaining ?? latest),
      null,
    ) ?? state.demoQuestionsRemaining;

  const exhausted = remaining <= 0;
  const locked = !state.installation;

  // Poll for the target connecting, but only while a test is being started or
  // is live — never in the background.
  useEffect(() => {
    if (!liveTest.starting && !liveTest.connected) return;
    const timer = window.setInterval(() => void refreshLiveTest(), 2000);
    return () => window.clearInterval(timer);
  }, [liveTest.starting, liveTest.connected, refreshLiveTest]);

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [chat]);

  const submit = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || busy || exhausted) return;
    setBusy(true);
    setQuestion("");
    try {
      await askAgent(trimmed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepShell
      step={5}
      id="step-test"
      title="Try it like an agent would"
      subtitle="Optional. Ask about your setup, or connect your live site and ask a real visitor question."
      status={locked ? "locked" : "active"}
      current={stepStateFor(state, "test") === "current"}
      lockedHint="Generate your snippet first."
      highlighted={false}
    >
      <div className="flex flex-col gap-5">
        <SectionError sections={["ask"]} />
        {/* Live target status */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-muted/40 px-3.5 py-3">
          <div className="flex items-center gap-2 text-sm">
            {liveTest.connected ? (
              <>
                <Radio aria-hidden className="size-4 text-success" />
                <span className="font-medium text-foreground">Live target connected</span>
                <Badge variant="secondary">{liveTest.availableTools.length} tools visible</Badge>
              </>
            ) : (
              <>
                <ShieldCheck aria-hidden className="size-4 text-muted-foreground" />
                <span className="text-muted-foreground">
                  No live target. Readiness questions still work.
                </span>
              </>
            )}
          </div>

          {liveTest.connected || liveTest.starting ? (
            <Button variant="outline" size="sm" onClick={() => void stopLiveTest()}>
              {liveTest.starting ? "Cancel live test" : "End live test"}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={locked || liveTest.starting}
              onClick={() => void startLiveTest()}
            >
              {liveTest.starting ? (
                <>
                  <Loader2 aria-hidden className="size-4 animate-spin" />
                  Waiting for your site…
                </>
              ) : (
                "Start live agent test"
              )}
            </Button>
          )}
        </div>

        <p aria-live="polite" className="sr-only">
          {liveTest.connected
            ? "Live agent test connected."
            : liveTest.starting
              ? "Waiting for your portfolio to connect."
              : ""}
        </p>

        {liveTest.starting && liveTest.testUrl && (
          <p className="text-xs text-muted-foreground">
            Keep your portfolio tab open while it connects. No new tab?{" "}
            <a href={liveTest.testUrl} target="_blank" rel="noopener noreferrer"
              className="font-medium text-foreground underline underline-offset-3">
              Open your site to connect<span className="sr-only"> (opens in a new tab)</span>
            </a>
          </p>
        )}

        {/* Transcript */}
        {chat.length > 0 && (
          <ol className="flex flex-col gap-4">
            {chat.map((turn) => (
              <li key={turn.id} className="flex flex-col gap-2">
                <p className="max-w-[85%] self-end rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm break-words text-primary-foreground">
                  <span className="sr-only">You asked: </span>
                  {turn.question}
                </p>

                <div className="max-w-[92%] self-start rounded-2xl rounded-bl-md border border-border bg-card px-3.5 py-3">
                  {turn.pending ? (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 aria-hidden className="size-4 animate-spin" />
                      Thinking…
                    </p>
                  ) : (
                    <>
                      <p className="whitespace-pre-wrap break-words text-sm text-foreground">
                        {turn.answer}
                      </p>

                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {/* The distinction that matters: did a tool really run? */}
                        {turn.mode === "live" && turn.executedOn && (
                          <Badge variant="secondary" className="gap-1">
                            <Radio aria-hidden className="size-3" />
                            {turn.tool} ran on {turn.executedOn}
                          </Badge>
                        )}
                        {turn.mode === "readiness" && (
                          <Badge variant="outline">From verification data</Badge>
                        )}
                        {turn.mode === "live_unavailable" && (
                          <Badge variant="outline" className="gap-1">
                            <TriangleAlert aria-hidden className="size-3" />
                            No live execution
                          </Badge>
                        )}
                        {turn.mode === "error" && <Badge variant="destructive">Failed</Badge>}
                      </div>
                    </>
                  )}
                </div>
              </li>
            ))}

          </ol>
        )}
        {chat.length > 0 && (
          <div ref={transcriptEnd} />
        )}

        <p aria-live="polite" className="sr-only">
          {busy ? "Waiting for an answer." : ""}
        </p>

        {/* Composer */}
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(question);
          }}
        >
          <Label htmlFor="ask-agent-input">Your question</Label>
          <div className="flex gap-2">
            <Input
              id="ask-agent-input"
              className="h-10"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder={
                exhausted ? "Demo limit reached for this portfolio" : "Ask about your site…"
              }
              maxLength={300}
              disabled={locked || busy || exhausted}
              aria-describedby="ask-agent-quota"
            />
            <Button
              type="submit"
              size="icon-lg"
              disabled={locked || busy || exhausted || !question.trim()}
            >
              {busy ? (
                <Loader2 aria-hidden className="size-4 animate-spin" />
              ) : (
                <Send aria-hidden className="size-4" />
              )}
              <span className="sr-only">Send question</span>
            </Button>
          </div>

          <p id="ask-agent-quota" className="text-xs text-muted-foreground">
            {exhausted
              ? "Demo limit reached for this portfolio."
              : `${remaining} question${remaining === 1 ? "" : "s"} remaining for this portfolio.`}
          </p>
        </form>

        {/* Suggestions */}
        {!exhausted && chat.length === 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-muted-foreground">Try asking</p>
            <div className="flex flex-wrap gap-2">
              {(liveTest.connected ? SUGGESTIONS_LIVE : SUGGESTIONS_READINESS).map((s) => (
                <Button
                  key={s}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-auto whitespace-normal text-left"
                  onClick={() => void submit(s)}
                  disabled={busy}
                >
                  {s}
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>
    </StepShell>
  );
}
