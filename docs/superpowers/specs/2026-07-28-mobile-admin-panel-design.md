# Mobile Admin Panel Design

## Goal

Add a mobile-first management panel to the SOOYA PWA. The chat header will include a right-aligned gear button that opens the panel in the current tab. The panel will include a clear action to return to chat.

## Scope

The first version provides four card-based sections:

1. **Status**: service health, configured capabilities, recent reply activity, storage and backup summary.
2. **Conversation**: inspect messages and memories, and expose destructive clearing actions only with confirmation.
3. **Persona and capabilities**: edit persona fields and enable or configure available model, voice, image, and sticker capabilities.
4. **Maintenance**: create a backup, inspect redacted errors, and restart the service.

The visual language follows the existing PWA: a compact top bar, large touch targets, card navigation, and no dense desktop-style tables on the default screen.

## Navigation and Authentication

- The chat top bar gets an icon-only gear button with an accessible label.
- The button navigates to `/admin` in the current tab.
- `/admin` is a real SPA route rather than a redirect to the legacy `sooya.icu` portal.
- The existing `WEB_CHAT_TOKEN` continues to authenticate chat requests. The panel prompts for or uses a separately stored `ADMIN_API_TOKEN` when it needs management APIs; no token is put into a URL.
- A prominent "Return to chat" action goes to `/`.

## Safety and Error Handling

- Clear chat, delete memory/media, and restart actions require a descriptive confirmation dialog.
- The panel shows redacted server errors only.
- If the admin token is absent or rejected, the panel shows an explicit locked state and leaves chat usable.
- Read-only status loading failures are shown inline with a retry option.

## API and Component Boundaries

- Extend the existing web API client with a small admin request helper that adds `X-Admin-Token`.
- Add a route-aware top-level application shell that renders either chat or the admin panel.
- Keep each section as an independent component, backed only by the existing `/api/admin/*` endpoints.
- Do not change server-side data models or broaden external exposure; the existing admin API remains the backend surface.

## Testing

- Add component/route tests for the gear button, current-tab navigation, return-to-chat action, and locked admin state.
- Add API-client tests proving admin requests use the admin-token header without exposing either token in URLs.
- Add tests for confirmation before destructive actions.
- Run type checks, the relevant web tests, production build, then deploy to the existing SOOYA release layout and verify through `echo.sooya.icu`.

## Out of Scope

- Replacing the legacy portal immediately.
- Multi-user roles or account management.
- Push notifications, QQ integration, or new model-provider backend capabilities.
