# Highlight notification sounds

These files are served at `/sounds/<name>.mp3` and referenced by the
`notifications.highlight.sound.choice` enum in `shared/settingsRegistry.js`.

Drop short MP3 files here, matching the registry choices:

- `ping.mp3` — default
- `chime.mp3`
- `pop.mp3`
- `beep.mp3`
- `knock.mp3`

Keep each clip under ~1 second; the client preloads them lazily on first play.

To add or remove options, update both the enum in `settingsRegistry.js` and
the filenames in this directory. Nothing else needs to change.
