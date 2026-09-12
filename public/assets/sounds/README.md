# Alert sound

Drop an MP3 here named **`beer.mp3`** and it plays on every beer someone else adds
(while the app is open — a closed-app push notification always uses the phone's own
notification tone, which no website can override).

- Keep it short: 0.5–2 seconds. Anything longer overlaps itself on a fast round.
- Keep it small: under ~100 KB, so phones on bad signal still play it instantly.
- No file here? The app synthesises a two-tone "clink" instead, so nothing breaks.

Replace the file and redeploy to change the sound for everyone.
