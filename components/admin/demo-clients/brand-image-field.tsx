'use client';

/**
 * DEMO-ONLY (F7.2): "link a URL or upload a file" control for a demo client's brand image.
 *
 * Both routes write the SAME column, so this is one field with two entry paths, not two
 * fields. The two paths differ in WHEN they persist, and it matters:
 *
 *  - A TYPED url is ordinary form state. It reaches the column only when the admin saves,
 *    and Cancel discards it.
 *  - An UPLOAD writes the column server-side as part of the POST, and Remove clears it as
 *    part of the DELETE. Both are live the moment they return, before any save. Cancel
 *    cannot undo either — there is no draft state for a binary, and the alternative
 *    (upload to storage, persist only on save) strands an orphaned object in the bucket
 *    for every upload the admin abandons. This follows the platform's avatar endpoint.
 *
 * The upload still calls `onChange` so the text input reflects the stored URL and the live
 * preview updates; the help copy tells the admin that uploads apply immediately.
 *
 * Three constraints shaped it:
 *  - Storage is OPTIONAL in this platform (`isStorageEnabled()` is false when unconfigured),
 *    so `uploadEnabled` degrades the control to URL-only rather than offering a button that
 *    always 503s.
 *  - Upload needs a SAVED client to attach to (the key is `demo-clients/<id>/…`), so on the
 *    create form there is no id yet and upload is likewise unavailable, with a reason shown.
 *  - Dimensions are checked in the browser BEFORE the request, so an admin with a wrong-sized
 *    export gets an instant, specific answer instead of a round-trip. The server re-checks —
 *    this is UX, not a security boundary.
 */

import { useRef, useState } from 'react';
import { Loader2, Upload, X } from 'lucide-react';

import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldHelp } from '@/components/ui/field-help';
import { FormError } from '@/components/forms/form-error';
import { cn } from '@/lib/utils';
import {
  recommendedSize,
  validateImageDimensions,
  type BrandImageSpec,
} from '@/lib/app/questionnaire/theming';

interface BrandImageFieldProps {
  id: string;
  label: string;
  spec: BrandImageSpec;
  /** The demo client id; absent on the create form (nothing to attach an upload to). */
  demoClientId?: string;
  /** False when the server has no storage provider configured. */
  uploadEnabled: boolean;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  error?: string;
  help: React.ReactNode;
}

/** Read an image file's intrinsic size in the browser, mirroring the server check. */
function measure(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

export function BrandImageField({
  id,
  label,
  spec,
  demoClientId,
  uploadEnabled,
  value,
  onChange,
  disabled,
  error,
  help,
}: BrandImageFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const canUpload = uploadEnabled && Boolean(demoClientId);
  const endpoint =
    spec.label === 'Banner' ? API.APP.DEMO_CLIENTS.banner : API.APP.DEMO_CLIENTS.logo;

  const handleFile = async (file: File) => {
    setUploadError(null);

    // Pre-flight the dimensions so a bad export fails instantly and specifically.
    const dimensions = await measure(file);
    if (!dimensions) {
      setUploadError('That file could not be read as an image.');
      return;
    }
    const check = validateImageDimensions(dimensions, spec);
    if (!check.valid) {
      setUploadError(check.error);
      return;
    }

    setBusy(true);
    try {
      const body = new FormData();
      body.append('file', file);
      const response = await fetch(endpoint(demoClientId as string), { method: 'POST', body });
      const result = await parseApiResponse<{ url: string }>(response);
      // The server carries its rejection reason (wrong dimensions, bad type, no storage)
      // in the error envelope — surface it verbatim rather than a generic failure.
      if (!result.success) {
        setUploadError(result.error.message);
        return;
      }
      onChange(result.data.url);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setBusy(false);
      // Clear the input so re-picking the SAME file still fires a change event.
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleRemove = async () => {
    setUploadError(null);
    onChange('');
    // Unconditional once upload is available, because the field CANNOT tell an uploaded
    // image from a typed one: only the local provider returns `/uploads/...`, while S3 and
    // Vercel Blob return absolute https URLs indistinguishable from a pasted link. Gating
    // on the path prefix therefore skipped cleanup on every real deployment and left the
    // object public in the bucket forever. The route is idempotent — deleting a prefix
    // with nothing under it is a no-op — so calling it for a typed URL is harmless.
    if (!canUpload) return;
    setBusy(true);
    try {
      await fetch(endpoint(demoClientId as string), { method: 'DELETE' });
    } catch {
      // Non-fatal: the column is cleared on save regardless.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="flex items-center gap-1">
        {label}
        <FieldHelp title={label}>{help}</FieldHelp>
      </Label>

      <Input
        id={id}
        placeholder="https://acme.example/logo.png"
        disabled={disabled || busy}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />

      <div className="flex flex-wrap items-center gap-2">
        {canUpload && (
          <>
            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || busy}
              onClick={() => inputRef.current?.click()}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              Upload
            </Button>
          </>
        )}
        {value && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || busy}
            onClick={() => void handleRemove()}
          >
            <X className="h-3.5 w-3.5" />
            Remove
          </Button>
        )}
        <span className={cn('text-muted-foreground text-xs', !canUpload && 'italic')}>
          {canUpload
            ? spec.aspectRatio
              ? `${recommendedSize(spec)}px recommended (${spec.aspectRatio}:1, min ${spec.minWidth}x${spec.minHeight}) — uploads apply immediately`
              : `Up to ${recommendedSize(spec)}px, min ${spec.minWidth}x${spec.minHeight} — uploads apply immediately`
            : uploadEnabled
              ? 'Save the client first to upload a file'
              : 'File uploads are not configured — paste an image URL'}
        </span>
      </div>

      <FormError message={uploadError ?? error} />
    </div>
  );
}
