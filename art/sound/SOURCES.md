# Sources

The recordings the game's sound is made from. The sound is all rights
reserved, like the rest of the art, so a recording may come from only two
places:

- **CC0**: nothing that asks for credit, forbids selling, or was made by an
  AI service. Each original's page is read for its licence and for where
  the sound came from before it is used.
- **The owner's own recordings**, and the game's own (made from its
  generators): the art's own licence, `LicenseRef-All-Rights-Reserved`.

`go run ./tools/sounds -check` checks this file: every master under
`recorded/masters/` listed by its SHA-256 and an allowed licence, every
file under `recorded/` a listed master's and built from it as it is now,
and the sizes within their budgets. Lint runs it.

## Adding a recording

1. Download the original. Note its page, its author and its title, and its
   SHA-256 (`shasum -a 256 <file>`).
2. Make its master: trimmed, cleaned, at 48 kHz, as FLAC, into
   `recorded/masters/<name>.flac` (lower case and hyphens). A bed's end is
   crossfaded into its start; 20–45 s is long enough. Mono for a sound
   from one place, stereo for a bed. For example, a stretch of 30 s with
   ffmpeg: `ffmpeg -i original.wav -ss 12 -t 30 -ar 48000 -sample_fmt s16
   recorded/masters/sea-moderate.flac`.
3. Write its numbers' file, `recorded/<name>.json`: copy another's, and set
   `kind` (`bed` or `shot`) and `voice` (which of the page's voices plays
   it: `client/src/audio/recorded.ts` lists them). Leave the rest.
4. Encode it: `cd client && npm run sounds`. That writes `<name>.webm` and
   `<name>.m4a` beside it, normalised, and fills in its numbers.
5. List it below: the master, the original (author, title and page), the
   licence, the original's SHA-256 and the master's (`-encode` and
   `-check` print it when it is missing).
6. Check: `go run ./tools/sounds -check`. Listen in the sound room
   (`/sounds.html` on the development server) and set its `gain` there by
   ear and by the meter.

## Recordings

| Master                           | Original                                                                              | Licence                        | Original's SHA-256 | SHA-256                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------ | ------------------ | ---------------------------------------------------------------- |
| `recorded/masters/probe.flac`    | The game's own: a tone from ffmpeg's sine generator, to choose the format by decoding | LicenseRef-All-Rights-Reserved | —                  | 5368e31e6db01948c3683cd6941211f13446a29debaee2857ff7be2e937134b7 |
| `recorded/masters/test-sea.flac` | The game's own: brown noise from ffmpeg's generator, swelling, for the tests          | LicenseRef-All-Rights-Reserved | —                  | 883603d0806c72a3f1ee02899f1a829910988b84a2778c461c3468b080ec13e8 |
