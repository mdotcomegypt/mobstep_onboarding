/**
 * SSE client for the chat endpoint.
 *
 * Uses fetch + a ReadableStream rather than EventSource, because the turn is a
 * POST carrying the message and its attachments, and EventSource only does GET.
 */

export interface Palette {
  name?: string;
  brand: string;
  onBrand: string;
  surface: string;
  onSurface: string;
  border: string;
}

export type Card =
  | { kind: "palette"; options: Palette[] }
  | { kind: "logo"; options: string[] }
  | { kind: "screen_mock"; url: string; caption?: string }
  | { kind: "table"; title: string; columns: string[]; rows: string[][] }
  | { kind: "progress"; label: string; status: "running" | "success" | "failed"; log?: string }
  | { kind: "link"; label: string; href: string }
  | { kind: "attachment"; url: string; filename: string; mime: string }
  | {
      kind: "themes";
      options: Array<{
        id: number;
        name: string;
        description: string;
        business: string;
        screenshots: string[];
      }>;
    };

export interface UploadedFile {
  id: string;
  filename: string;
  mime: string;
  url: string;
}

export interface ChatHandlers {
  onToken: (text: string) => void;
  onCard: (card: Card) => void;
  onTool: (name: string) => void;
  onDone: (info: { phase: string; appId: number | null }) => void;
  onError: (message: string) => void;
}

export async function uploadFiles(files: File[]): Promise<UploadedFile[]> {
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);

  const response = await fetch("/api/upload", {
    method: "POST",
    credentials: "include",
    body: form,
  });

  const body = (await response.json().catch(() => ({}))) as {
    files?: UploadedFile[];
    error?: string;
  };
  if (!response.ok) throw new Error(body.error ?? "Upload failed.");
  return body.files ?? [];
}

export async function streamTurn(
  message: string,
  attachments: string[],
  handlers: ChatHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/chat", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, attachments }),
    signal,
  });

  if (!response.ok || !response.body) {
    handlers.onError(
      response.status === 401
        ? "Your session expired. Reload the page to sign in again."
        : "Could not reach the assistant. Please try again.",
    );
    return;
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;

    // SSE frames are separated by a blank line; keep any partial tail.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
        // Lines starting with ":" are heartbeats; ignore them.
      }
      if (!data) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }

      switch (event) {
        case "token":
          handlers.onToken((parsed as { text: string }).text);
          break;
        case "card":
          handlers.onCard(parsed as Card);
          break;
        case "tool":
          handlers.onTool((parsed as { name: string }).name);
          break;
        case "done":
          handlers.onDone(parsed as { phase: string; appId: number | null });
          break;
        case "error":
          handlers.onError((parsed as { message: string }).message);
          break;
      }
    }
  }
}

export interface HistoryMessage {
  role: string;
  content: string;
  cards: Card[];
}

export async function loadHistory(): Promise<{ messages: HistoryMessage[]; phase: string }> {
  const response = await fetch("/api/chat/history", { credentials: "include" });
  if (!response.ok) return { messages: [], phase: "discovery" };
  return (await response.json()) as { messages: HistoryMessage[]; phase: string };
}
