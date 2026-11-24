# Arzio Mail for iPhone and Android

The native app for Arzio Mail, built with Expo (React Native, SDK 58). It talks to
the same REST API as the web app.

| Tab | What it does |
| --- | --- |
| Mail | All folders, Focused / Other, search, pull to refresh, unread and flagged, "Important" and "Needs reply" tags. Long press marks read or unread |
| Message | HTML mail in a locked-down view (no scripts, remote pictures only when you tap "Show pictures"), attachments, reply / reply all / forward (the original attachments go along), archive, delete, flag, AI summary, accept or decline invitations |
| Compose | Recipient suggestions, Cc, attachments from the phone, "Draft with AI" |
| Calendar | Four-week agenda, event details, accept / maybe / decline |
| To Do | Add, complete, star tasks |
| Account | Storage used, plan, automatic replies (out of office), sign out |

New mail and reminders arrive as push notifications; tapping one opens the
message, event or task. Two-step verification works at sign-in.

## Run it

```bash
cd mobile
npm install
npx expo start          # scan the QR code with Expo Go, or press a / i for an emulator
```

The sign-in screen asks for the server the first time (for example
`mail.arzio.com`). Set the default in `app.json` under `expo.extra.defaultServer`
so users of your service only enter their email and password.

Checks: `npm run typecheck`. The web build (`npm run export:web`) is used to test
the screens in a browser.

## Push notifications

Push goes through the Expo push service, which hands notifications to Apple and
Google.

1. `npm install -g eas-cli`, `eas login`, then `eas init` in this folder. It writes
   the project id into `app.json` (`expo.extra.eas.projectId`). Without it the
   app works but does not ask for push.
2. iOS: `eas credentials` creates the Apple push key. Android: add the Firebase
   `google-services.json` as described in Expo's push notification guide.
3. On the server nothing is needed. Optional settings:
   - `ARZIO_PUSH=off` turns push off.
   - `ARZIO_PUSH_PREVIEW=sender` shows only the sender on the lock screen. `none`
     shows only "New message". The default `full` shows sender and subject.
   - `EXPO_ACCESS_TOKEN` is needed if you turn on "enhanced push security" in Expo.

## Build for the App Store and Google Play

```bash
eas build --platform ios       # or android, or all
eas submit --platform ios
```

Change `ios.bundleIdentifier` and `android.package` in `app.json` (now
`com.arzio.mail`) to identifiers you own before the first build. The icons in
`assets/` (1024×1024) are drawn from the web app's logo.

## How it signs in

`POST /api/auth/login` with `client: "app"` returns a session instead of a
cookie. The app keeps it in the phone's secure keychain (`expo-secure-store`) and
sends it as `X-Arzio-Session`. Signing out deletes the session on the server and
removes the phone's push token. Sessions have the same rights as the web app,
unlike API tokens.
