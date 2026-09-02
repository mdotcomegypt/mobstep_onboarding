import { useRef, useState } from "react";
import { type UploadedFile, uploadFiles } from "../lib/chat.ts";

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,application/pdf";

/**
 * Message composer with attachments.
 *
 * Three ways in, because owners reach for all of them: the paperclip, dragging
 * onto the window, and pasting a screenshot straight from the clipboard.
 */
export function Composer({
  busy,
  onSend,
}: {
  busy: boolean;
  onSend: (text: string, attachments: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const accept = async (files: File[]): Promise<void> => {
    if (files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      const uploaded = await uploadFiles(files);
      setPending((prev) => [...prev, ...uploaded]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const submit = (): void => {
    const text = draft.trim();
    if (busy || uploading) return;
    if (!text && pending.length === 0) return;

    onSend(text, pending.map((f) => f.id));
    setDraft("");
    setPending([]);
    if (textarea.current) textarea.current.style.height = "auto";
  };

  const grow = (el: HTMLTextAreaElement): void => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  return (
    <div
      className={`composer-wrap${dragging ? " dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void accept([...e.dataTransfer.files]);
      }}
    >
      {pending.length > 0 && (
        <div className="pending-files">
          {pending.map((file) => (
            <div key={file.id} className="pending-file">
              {file.mime.startsWith("image/") ? (
                <img src={file.url} alt={file.filename} />
              ) : (
                <span className="file-icon">PDF</span>
              )}
              <button
                type="button"
                className="remove"
                aria-label={`Remove ${file.filename}`}
                onClick={() => setPending((prev) => prev.filter((f) => f.id !== file.id))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <p className="error small">{error}</p>}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            void accept([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="icon-button"
          title="Attach a photo or PDF"
          aria-label="Attach a file"
          disabled={busy || uploading}
          onClick={() => fileInput.current?.click()}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>

        <textarea
          ref={textarea}
          value={draft}
          rows={1}
          placeholder={
            uploading ? "Uploading…" : busy ? "Thinking…" : "Message, or attach your menu…"
          }
          disabled={busy}
          onChange={(e) => {
            setDraft(e.target.value);
            grow(e.target);
          }}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length > 0) {
              e.preventDefault();
              void accept(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />

        <button
          className="icon-button send"
          type="submit"
          aria-label="Send"
          disabled={busy || uploading || (!draft.trim() && pending.length === 0)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </form>
      <p className="hint">Enter to send · Shift+Enter for a new line · paste or drop a photo</p>
    </div>
  );
}
