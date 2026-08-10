import { useState, type FormEvent } from "react";

import { submitFeedback } from "../api";

const MAX_FEEDBACK_LENGTH = 2_000;

export function Feedback({
  displayName,
  onBack
}: {
  displayName: string;
  onBack: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const feedback = text.trim();
    if (!feedback || sending) return;
    setSending(true);
    setError("");
    try {
      await submitFeedback(feedback);
      setSent(true);
      setText("");
      window.requestAnimationFrame(() => window.scrollTo({ top: 0 }));
    } catch {
      setError("Your feedback wasn’t sent. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="settings-shell feedback-shell">
      <header className="topbar">
        <button className="back-link" onClick={onBack}>← Home</button>
        <span className="name">{displayName}</span>
      </header>
      <section className="settings-intro">
        <p className="eyebrow">Feedback</p>
        <h1>Help improve Captain</h1>
        <p>Tell us what worked, what didn’t, or what you’d like Captain to do better.</p>
      </section>
      <section className="settings-card feedback-card">
        {sent ? (
          <div className="feedback-success" role="status">
            <h2>Feedback sent</h2>
            <p>Thank you. Your feedback is with the team.</p>
            <button className="save-button" type="button" onClick={() => setSent(false)}>
              Send more feedback
            </button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <label>
              Your feedback
              <textarea
                autoFocus
                maxLength={MAX_FEEDBACK_LENGTH}
                placeholder="Tell us what happened or what you’d like to see."
                required
                rows={7}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            </label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="save-button" type="submit" disabled={sending || !text.trim()}>
              {sending ? "Sending…" : "Send feedback"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
