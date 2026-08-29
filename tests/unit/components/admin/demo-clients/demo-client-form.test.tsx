// @vitest-environment happy-dom

/**
 * DemoClientForm tests — the create/edit form for a demo client's brand kit.
 *
 * One component, two modes, and the interesting behaviour is almost all in what it sends rather
 * than what it draws. The submit path turns a form full of blank strings into a body full of
 * `null`s (a blank field means "clear the column back to the ConQuest default"), and it has two
 * deliberate exceptions that are easy to break and invisible when broken:
 *
 *  - a blank `slug` is OMITTED, not nulled, so the server derives it from the name;
 *  - the `neutral` font pairing is sent as `null`, so "never chose" and "chose the default" stay
 *    one row rather than two that render identically.
 *
 * Also covered: edit-mode prefill (including a stored pairing this build does not know, which must
 * degrade to neutral rather than clear the column on the next save), the dirty gate on Save, the
 * contrast warning — the one pair on this form that can be independently valid and jointly
 * unreadable — and the error banner.
 *
 * `BrandImageField` and `DemoClientThemePreview` are stubbed: both are separately tested, both
 * would otherwise pull uploads and full theme resolution into a form test.
 *
 * @see components/admin/demo-clients/demo-client-form.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { DemoClientView } from '@/lib/app/questionnaire/demo-clients';

const { mockPush, mockRefresh } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockRefresh: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ push: mockPush, refresh: mockRefresh, replace: vi.fn() })),
}));

const { mockPost, mockPatch, MockAPIClientError } = vi.hoisted(() => {
  class HoistedAPIClientError extends Error {
    code?: string;
    constructor(message: string, code?: string) {
      super(message);
      this.name = 'APIClientError';
      this.code = code;
    }
  }
  return { mockPost: vi.fn(), mockPatch: vi.fn(), MockAPIClientError: HoistedAPIClientError };
});
vi.mock('@/lib/api/client', () => ({
  apiClient: { post: mockPost, patch: mockPatch },
  APIClientError: MockAPIClientError,
}));

// Stubbed children — each has its own suite; here they would only add upload plumbing. The image
// stub still exposes its `onChange`, because the form's own handler for a picked image (mark it
// dirty, validate it, carry it into the body) is this component's code, not the field's.
vi.mock('@/components/admin/demo-clients/brand-image-field', () => ({
  BrandImageField: ({ id, onChange }: { id: string; onChange: (v: string) => void }) => (
    <button
      type="button"
      data-testid={`image-${id}`}
      onClick={() => onChange(`https://cdn.example.com/${id}.png`)}
    >
      pick {id}
    </button>
  ),
}));
vi.mock('@/components/admin/demo-clients/demo-client-theme-preview', () => ({
  DemoClientThemePreview: () => <div data-testid="theme-preview" />,
}));

import { DemoClientForm } from '@/components/admin/demo-clients/demo-client-form';

/** A saved client with every column set, so prefill assertions can be specific. */
const CLIENT: DemoClientView = {
  id: 'client-1',
  slug: 'acme-bank',
  name: 'Acme Bank Demo',
  description: 'Internal note',
  isActive: true,
  ctaColor: '#280039',
  accentColor: '#ff6600',
  logoUrl: 'https://cdn.example.com/logo.png',
  bannerUrl: null,
  welcomeCopy: 'Welcome to Acme.',
  surfaceColor: '#101820',
  ctaColorEnd: null,
  logoBackgroundColor: null,
  logoBackgroundEnabled: false,
  canvasColor: '#fffdf7',
  inkColor: '#1a1a1a',
  canvasColorDark: null,
  inkColorDark: null,
  accentColorEnd: null,
  logoMarkUrl: null,
  logoDarkUrl: null,
  fontPairing: 'editorial',
  customFontDisplay: null,
  customFontBody: null,
  questionnaireCount: 3,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

/**
 * Fields are found by ROLE plus name, not by label: each `<Label>` contains a `FieldHelp` ⓘ
 * trigger carrying the same accessible name, so a bare label query is ambiguous by construction.
 */
const nameBox = () => screen.getByRole('textbox', { name: /^Name/ });
const slugBox = () => screen.getByRole('textbox', { name: /^Slug/ });
const typefaceSelect = () => screen.getByRole('combobox', { name: /^Typeface/ });
/**
 * The hex box of a `BrandColorField` (its swatch is a separate "<name> picker" control). Anchored
 * and escaped: several labels contain parentheses ("Canvas colour (dark mode)"), and one is a
 * prefix of another.
 */
const hexBox = (name: string) =>
  screen.getByRole('textbox', {
    name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
  });
const saveButton = () => screen.getByRole('button', { name: /Save changes|Create demo client/ });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DemoClientForm', () => {
  describe('create mode', () => {
    it('offers the create action, not the save one', () => {
      render(<DemoClientForm />);
      expect(screen.getByRole('button', { name: 'Create demo client' })).toBeEnabled();
    });

    it('blocks submission with no name and does not call the API', async () => {
      const user = userEvent.setup();
      render(<DemoClientForm />);
      await user.click(saveButton());
      expect(await screen.findByText('Name is required')).toBeInTheDocument();
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('POSTs the client, then navigates to it and refreshes', async () => {
      const user = userEvent.setup();
      mockPost.mockResolvedValue({ ...CLIENT, id: 'created-9' });
      render(<DemoClientForm />);
      await user.type(nameBox(), 'Acme Bank Demo');
      await user.click(saveButton());

      await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
      const [url] = mockPost.mock.calls[0];
      expect(url).toBe('/api/v1/app/demo-clients');
      expect(mockPush).toHaveBeenCalledWith('/admin/demo-clients/created-9');
      expect(mockRefresh).toHaveBeenCalled();
    });

    it('sends every untouched theme field as null, so the column clears to the default', async () => {
      const user = userEvent.setup();
      mockPost.mockResolvedValue(CLIENT);
      render(<DemoClientForm />);
      await user.type(nameBox(), 'Acme');
      await user.click(saveButton());

      await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
      const body = mockPost.mock.calls[0][1].body;
      for (const field of [
        'ctaColor',
        'accentColor',
        'logoUrl',
        'bannerUrl',
        'welcomeCopy',
        'surfaceColor',
        'ctaColorEnd',
        'logoBackgroundColor',
        'canvasColor',
        'inkColor',
        'canvasColorDark',
        'inkColorDark',
        'accentColorEnd',
        'logoMarkUrl',
        'logoDarkUrl',
        'description',
      ]) {
        expect(body[field], `${field} should be null when blank`).toBeNull();
      }
    });

    it('OMITS a blank slug rather than nulling it, so the server derives one', async () => {
      // The distinction matters: `slug: null` would be a request to clear a required column.
      const user = userEvent.setup();
      mockPost.mockResolvedValue(CLIENT);
      render(<DemoClientForm />);
      await user.type(nameBox(), 'Acme');
      await user.click(saveButton());

      await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
      expect(mockPost.mock.calls[0][1].body).not.toHaveProperty('slug');
    });

    it('sends a slug the admin did type', async () => {
      const user = userEvent.setup();
      mockPost.mockResolvedValue(CLIENT);
      render(<DemoClientForm />);
      await user.type(nameBox(), 'Acme');
      await user.type(slugBox(), 'acme-bank');
      await user.click(saveButton());

      await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
      expect(mockPost.mock.calls[0][1].body.slug).toBe('acme-bank');
    });

    it('sends the neutral font pairing as null, not as the word', async () => {
      // "Never chose" and "chose the default" must stay one row — they render identically, and
      // two representations of the same look is a bug waiting to be reasoned about.
      const user = userEvent.setup();
      mockPost.mockResolvedValue(CLIENT);
      render(<DemoClientForm />);
      await user.type(nameBox(), 'Acme');
      await user.click(saveButton());

      await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
      expect(mockPost.mock.calls[0][1].body.fontPairing).toBeNull();
    });

    it('sends a non-default font pairing by name', async () => {
      const user = userEvent.setup();
      mockPost.mockResolvedValue(CLIENT);
      render(<DemoClientForm />);
      await user.type(nameBox(), 'Acme');
      await user.selectOptions(typefaceSelect(), 'editorial');
      await user.click(saveButton());

      await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
      expect(mockPost.mock.calls[0][1].body.fontPairing).toBe('editorial');
    });
  });

  describe('edit mode', () => {
    it('prefills from the saved client', () => {
      render(<DemoClientForm client={CLIENT} />);
      expect(nameBox()).toHaveValue('Acme Bank Demo');
      expect(slugBox()).toHaveValue('acme-bank');
      expect(typefaceSelect()).toHaveValue('editorial');
    });

    it('degrades a stored pairing this build does not know to the default', () => {
      // Forgiving on the way IN for the same reason `resolveFontPairing` is: a rollback or a seed
      // can leave a name here that this build has never heard of. Leaving the select with no
      // selection would silently clear the column on the next save.
      render(<DemoClientForm client={{ ...CLIENT, fontPairing: 'from-the-future' }} />);
      expect(typefaceSelect()).toHaveValue('neutral');
    });

    it('keeps Save disabled until something actually changes', () => {
      render(<DemoClientForm client={CLIENT} />);
      expect(saveButton()).toBeDisabled();
    });

    it('enables Save once a field is edited', async () => {
      const user = userEvent.setup();
      render(<DemoClientForm client={CLIENT} />);
      await user.type(nameBox(), '!');
      await waitFor(() => expect(saveButton()).toBeEnabled());
    });

    it('enables Save when only a colour swatch was touched', async () => {
      // The regression this guards: `BrandColorField` is controlled rather than `register()`ed, so
      // without `shouldDirty` a change made entirely through the picker left Save disabled.
      const user = userEvent.setup();
      render(<DemoClientForm client={CLIENT} />);
      await user.clear(hexBox('Canvas colour'));
      await waitFor(() => expect(saveButton()).toBeEnabled());
    });

    it('PATCHes the client by id, then navigates and refreshes', async () => {
      const user = userEvent.setup();
      mockPatch.mockResolvedValue({ ...CLIENT, id: 'client-1' });
      render(<DemoClientForm client={CLIENT} />);
      await user.type(nameBox(), '!');
      await user.click(saveButton());

      await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(1));
      expect(mockPatch.mock.calls[0][0]).toBe('/api/v1/app/demo-clients/client-1');
      expect(mockPatch.mock.calls[0][1].body.name).toBe('Acme Bank Demo!');
      expect(mockPush).toHaveBeenCalledWith('/admin/demo-clients/client-1');
      expect(mockRefresh).toHaveBeenCalled();
    });

    it('sends the saved colours back unchanged when only the name was edited', async () => {
      const user = userEvent.setup();
      mockPatch.mockResolvedValue(CLIENT);
      render(<DemoClientForm client={CLIENT} />);
      await user.type(nameBox(), '!');
      await user.click(saveButton());

      await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(1));
      const body = mockPatch.mock.calls[0][1].body;
      expect(body.canvasColor).toBe('#fffdf7');
      expect(body.inkColor).toBe('#1a1a1a');
      // Already null on the client, and still null — not the empty string.
      expect(body.ctaColorEnd).toBeNull();
    });
  });

  describe('validation', () => {
    it('rejects a malformed hex with the guidance message', async () => {
      const user = userEvent.setup();
      render(<DemoClientForm client={CLIENT} />);
      const canvas = hexBox('Canvas colour');
      await user.clear(canvas);
      await user.type(canvas, 'purple');
      await user.click(saveButton());
      expect(
        await screen.findByText(/Hex colour like #0a1a3a \(or leave blank for the default\)/)
      ).toBeInTheDocument();
      expect(mockPatch).not.toHaveBeenCalled();
    });

    it('rejects a slug that is not kebab-case', async () => {
      const user = userEvent.setup();
      render(<DemoClientForm />);
      await user.type(nameBox(), 'Acme');
      await user.type(slugBox(), 'Acme Bank');
      await user.click(saveButton());
      expect(
        await screen.findByText(/Kebab-case only: lowercase letters, numbers, single hyphens/)
      ).toBeInTheDocument();
      expect(mockPost).not.toHaveBeenCalled();
    });
  });

  describe('the contrast warning', () => {
    it('stays silent on a readable canvas / ink pair', () => {
      render(
        <DemoClientForm client={{ ...CLIENT, canvasColor: '#ffffff', inkColor: '#111111' }} />
      );
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('warns on an ink set against no canvas at all — the pair that ships unreadable', () => {
      // The failure this was blind to. "Ink: #FFFFFF on dark" is how a brand guideline reads, so
      // filling in Ink and leaving Canvas blank is the obvious thing to do — and the stylesheet
      // then pairs that white ink with the DEFAULT white ground. Measuring only when both halves
      // were authored meant the one combination guaranteed to be unreadable was the one
      // combination nothing checked.
      render(<DemoClientForm client={{ ...CLIENT, canvasColor: null, inkColor: '#ffffff' }} />);
      const warning = screen.getByRole('status');
      expect(warning).toHaveTextContent(/Ink on canvas in light mode is 1\.0:1/);
      // And it names the ground, because this admin cannot find a "canvas" on the form to fix.
      expect(warning).toHaveTextContent(/against the default light canvas/);
    });

    it('does not warn when the default pair is all there is', () => {
      // Every unbranded questionnaire would otherwise carry a warning, which trains admins to
      // ignore the one that matters.
      render(<DemoClientForm client={{ ...CLIENT, canvasColor: null, inkColor: null }} />);
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('warns when the resolved light pair falls under the AA floor', async () => {
      // Both values are legal hexes and nothing else on the form notices: mid-grey ink on a
      // mid-grey ground is independently valid and jointly unreadable.
      const user = userEvent.setup();
      render(<DemoClientForm client={CLIENT} />);
      const canvas = hexBox('Canvas colour');
      const ink = hexBox('Ink colour');
      await user.clear(canvas);
      await user.type(canvas, '#808080');
      await user.clear(ink);
      await user.type(ink, '#8a8a8a');
      // The warning names WHICH mode is unreadable — a derived dark pair can fail while the
      // typed light one passes, and "contrast is low" without the mode is unactionable.
      const warning = await screen.findByRole('status');
      expect(warning).toHaveTextContent(/Ink on canvas in light mode is [\d.]+:1, below the WCAG/);
    });
  });

  describe('failures', () => {
    it('shows the API error message and stays on the form', async () => {
      const user = userEvent.setup();
      mockPost.mockRejectedValue(new MockAPIClientError('Slug already in use', 'CONFLICT'));
      render(<DemoClientForm />);
      await user.type(nameBox(), 'Acme');
      await user.click(saveButton());

      expect(await screen.findByText('Slug already in use')).toBeInTheDocument();
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('falls back to generic copy for a non-API failure', async () => {
      const user = userEvent.setup();
      mockPost.mockRejectedValue(new TypeError('network down'));
      render(<DemoClientForm />);
      await user.type(nameBox(), 'Acme');
      await user.click(saveButton());

      expect(
        await screen.findByText('Something went wrong saving the demo client.')
      ).toBeInTheDocument();
      // The raw failure must not leak to an admin as though it were guidance.
      expect(screen.queryByText('network down')).toBeNull();
    });

    it('re-enables the form after a failure so the admin can retry', async () => {
      const user = userEvent.setup();
      mockPost.mockRejectedValue(new MockAPIClientError('Slug already in use'));
      render(<DemoClientForm />);
      await user.type(nameBox(), 'Acme');
      await user.click(saveButton());
      await screen.findByText('Slug already in use');
      await waitFor(() => expect(saveButton()).toBeEnabled());
    });
  });

  describe('the fields that are not plain text boxes', () => {
    it('carries every colour the admin edits into the body', async () => {
      // `BrandColorField` is controlled rather than `register()`ed, so each colour has its own
      // hand-written writer. A missed one is silent: the swatch updates, the column does not.
      const user = userEvent.setup();
      mockPatch.mockResolvedValue(CLIENT);
      // The logo-background colour only exists while its switch is on — it is the one colour on
      // this form that is conditionally rendered.
      render(<DemoClientForm client={{ ...CLIENT, logoBackgroundEnabled: true }} />);

      const edits: Array<[string, string]> = [
        ['Surface colour', '#111111'],
        ['Accent colour', '#222222'],
        ['CTA colour', '#333333'],
        ['CTA gradient end', '#444444'],
        ['Logo background colour', '#555555'],
        ['Canvas colour', '#666666'],
        ['Ink colour', '#070707'],
        ['Canvas colour (dark mode)', '#080808'],
        ['Ink colour (dark mode)', '#f9f9f9'],
        ['Second accent', '#aaaaaa'],
      ];
      for (const [label, value] of edits) {
        const box = hexBox(label);
        await user.clear(box);
        await user.type(box, value);
      }
      await user.click(saveButton());

      await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(1));
      expect(mockPatch.mock.calls[0][1].body).toMatchObject({
        surfaceColor: '#111111',
        accentColor: '#222222',
        ctaColor: '#333333',
        ctaColorEnd: '#444444',
        logoBackgroundColor: '#555555',
        canvasColor: '#666666',
        inkColor: '#070707',
        canvasColorDark: '#080808',
        inkColorDark: '#f9f9f9',
        accentColorEnd: '#aaaaaa',
      });
    });

    it('carries every picked image into the body', async () => {
      const user = userEvent.setup();
      mockPatch.mockResolvedValue(CLIENT);
      render(<DemoClientForm client={CLIENT} />);
      for (const id of ['logoUrl', 'bannerUrl', 'logoDarkUrl', 'logoMarkUrl']) {
        await user.click(screen.getByTestId(`image-${id}`));
      }
      await user.click(saveButton());

      await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(1));
      expect(mockPatch.mock.calls[0][1].body).toMatchObject({
        logoUrl: 'https://cdn.example.com/logoUrl.png',
        bannerUrl: 'https://cdn.example.com/bannerUrl.png',
        logoDarkUrl: 'https://cdn.example.com/logoDarkUrl.png',
        logoMarkUrl: 'https://cdn.example.com/logoMarkUrl.png',
      });
    });

    it('carries both switches into the body', async () => {
      const user = userEvent.setup();
      mockPatch.mockResolvedValue(CLIENT);
      render(<DemoClientForm client={CLIENT} />);
      await user.click(screen.getByRole('switch', { name: 'Active' }));
      await user.click(screen.getByRole('switch', { name: 'Apply a colour behind the logo' }));
      await user.click(saveButton());

      await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(1));
      expect(mockPatch.mock.calls[0][1].body).toMatchObject({
        isActive: false,
        logoBackgroundEnabled: true,
      });
    });
  });

  it('leaves without saving when Cancel is pressed', async () => {
    const user = userEvent.setup();
    render(<DemoClientForm client={CLIENT} />);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockPush).toHaveBeenCalledWith('/admin/demo-clients');
    expect(mockPatch).not.toHaveBeenCalled();
  });
});
