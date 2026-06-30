/**
 * IntroVideo — the optional YouTube/Vimeo embed on the respondent splash.
 *
 * Resolves the admin's raw link to a safe embed via {@link resolveIntroVideo} (which only ever
 * yields a trusted `youtube-nocookie` / `player.vimeo.com` src built from a validated id), and
 * renders it as a responsive 16:9 iframe framed to match the splash's "about" card. Returns null —
 * rendering nothing — when there is no video or the link doesn't resolve, so callers can drop it in
 * unconditionally.
 *
 * Lives in the LEFT "about" column of {@link QuestionnaireSplash}, grouped with the about text.
 */

import { PlayCircle } from 'lucide-react';

import { resolveIntroVideo } from '@/lib/app/questionnaire/intro/video';

const ACCENT = 'var(--app-accent-color, var(--color-primary))';
const ACCENT_HAIRLINE =
  'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 20%, transparent)';
const ACCENT_SOFT =
  'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 9%, transparent)';

export interface IntroVideoProps {
  /** The raw admin-entered link (`IntroSettings.videoUrl`). */
  url: string;
}

export function IntroVideo({ url }: IntroVideoProps) {
  const video = resolveIntroVideo(url);
  if (!video) return null;

  return (
    <div className="flex flex-col gap-2.5">
      <h2 className="text-muted-foreground flex items-center gap-2 text-[0.7rem] font-semibold tracking-[0.16em] uppercase">
        <PlayCircle className="h-3.5 w-3.5" style={{ color: ACCENT }} aria-hidden="true" />
        Watch the introduction
      </h2>
      <div
        className="relative aspect-video w-full overflow-hidden rounded-2xl border shadow-[0_1px_2px_rgba(0,0,0,0.04),0_18px_44px_-26px_rgba(0,0,0,0.45)]"
        style={{ borderColor: ACCENT_HAIRLINE, backgroundColor: ACCENT_SOFT }}
      >
        <iframe
          src={video.embedUrl}
          title={video.title}
          className="absolute inset-0 h-full w-full border-0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          referrerPolicy="strict-origin-when-cross-origin"
          loading="lazy"
          allowFullScreen
        />
      </div>
    </div>
  );
}
