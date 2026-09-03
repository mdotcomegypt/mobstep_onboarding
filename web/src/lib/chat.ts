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

export interface CatalogCard {
  kind: "catalog";
  title: string;
  currency?: string;
  placeholderUrl?: string;
  categories: Array<{
    name: string;
    iconUrl?: string;
    items: Array<{ name: string; price?: number; imageUrl?: string }>;
  }>;
}

export interface FeaturesCard {
  kind: "features";
  title: string;
  caption?: string;
  options: Array<{
    id: string;
    label: string;
    blurb: string;
    on: boolean;
    because?: string;
  }>;
}

export interface GalleryCard {
  kind: "gallery";
  title: string;
  caption?: string;
  images: Array<{ url: string; label?: string; shape?: "icon" | "photo" | "tile" }>;
}

export type Card =
  | { kind: "palette"; options: Palette[] }
  | { kind: "logo"; options: string[] }
  | { kind: "screen_mock"; url: string; caption?: string }
  | { kind: "table"; title: string; columns: string[]; rows: string[][] }
  | CatalogCard
  | GalleryCard
  | FeaturesCard
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

export interface PreviewFacts {
  name: string | null;
  type: string | null;
  currency: string | null;
  logoUrl: string | null;
  palette: Palette | null;
  themeId: number | null;
  placeholderUrl: string | null;
  branches: number;
  appId: number | null;
  categories: Array<{
    name: string;
    iconUrl: string | null;
    items: Array<{ name: string; price: number | null; imageUrl: string | null }>;
    total: number;
  }>;
}

/** A live progress line from inside a running tool. */
export interface Status {
  label: string;
  fraction?: number;
  step?: number;
  total?: number;
  done?: boolean;
}

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
  onStatus: (status: Status) => void;
  onToolDone: (name: string) => void;
  onRetry: (info: { attempt: number; of: number; message: string }) => void;
  onDone: (info: { phase: string; appId: number | null; facts: PreviewFacts }) => void;
  onError: (message: string, detail?: string) => void;
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
        case "status":
          handlers.onStatus(parsed as Status);
          break;
        case "retry":
          handlers.onRetry(parsed as { attempt: number; of: number; message: string });
          break;
        case "tool_done":
          handlers.onToolDone((parsed as { name: string }).name);
          break;
        case "done":
          handlers.onDone(parsed as { phase: string; appId: number | null; facts: PreviewFacts });
          break;
        case "error": {
          const payload = parsed as { message: string; detail?: string };
          handlers.onError(payload.message, payload.detail);
          break;
        }
      }
    }
  }
}

export interface HistoryMessage {
  role: string;
  content: string;
  cards: Card[];
}

export async function loadHistory(): Promise<{
  messages: HistoryMessage[];
  phase: string;
  facts: PreviewFacts | null;
}> {
  const response = await fetch("/api/chat/history", { credentials: "include" });
  if (!response.ok) return { messages: [], phase: "discovery", facts: null };
  return (await response.json()) as {
    messages: HistoryMessage[];
    phase: string;
    facts: PreviewFacts | null;
  };
}
