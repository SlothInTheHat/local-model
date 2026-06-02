import { X } from "lucide-react";

interface Props {
  images: string[]; // raw base64 strings (no data URL prefix)
  onRemove: (index: number) => void;
}

export function ImageAttachmentStrip({ images, onRemove }: Props) {
  if (images.length === 0) return null;

  return (
    <div className="flex gap-2 flex-wrap px-1 py-1">
      {images.map((b64, i) => (
        <div key={i} className="relative group shrink-0">
          <img
            src={`data:image/png;base64,${b64}`}
            alt={`Attachment ${i + 1}`}
            className="size-14 object-cover rounded-md border border-border"
          />
          <button
            type="button"
            onClick={() => onRemove(i)}
            className="absolute -top-1.5 -right-1.5 size-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
            aria-label={`Remove image ${i + 1}`}
          >
            <X className="size-2.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
