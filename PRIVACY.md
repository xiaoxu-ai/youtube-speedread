# Privacy

YT SpeedRead has no project-operated backend, telemetry, analytics, account system, or
remote task database.

## What the extension stores

- API endpoint, API key, model, and processing preferences are stored by the browser in
  `chrome.storage.sync`. They may sync through the browser account when browser sync is
  enabled.
- An in-progress job stores video metadata, captions, translations, and intermediate
  results in `chrome.storage.session`. This data is intended for the current browser
  session and can be cleared after browser restart, extension reload, update, or disable.
- Finished Markdown remains in session storage for the result page. Downloads are written
  by the browser to the user's chosen download location.

## What leaves the browser

To produce a result, the extension sends the current video's title, description, captions,
and prompts to the AI endpoint that the user configures. That provider's privacy, retention,
training, and geographic-processing policies apply. The extension requests access to the
specific API origin when settings are saved or the connection is tested.

The extension interacts with YouTube only while the user starts a job on a standard watch
page. It does not send captions or API keys to a server operated by this project.

## Boundaries and failures

Closing the popup does not normally stop a job. A full browser restart, extension reload,
update, or disable can clear session checkpoints; recovery is not guaranteed. Clearing task
state is not yet a guaranteed network cancellation mechanism, so it must not be treated as
an immediate guarantee that provider billing has stopped.

## Maintenance checklist

Any change to permissions, storage location, data sent to an API, task persistence, or
cancellation must update this file, the extension UI, tests, and the relevant user-facing
documentation in the same change.
