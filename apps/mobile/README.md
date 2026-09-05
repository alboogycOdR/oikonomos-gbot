# oikonomos_mobile

A new Flutter project.

## Chat attachments (TASK-166)

The composer `+` button opens a real file/image picker (`file_picker`) and
uploads through `POST /threads/:id/attachments` as JSON
`{filename, contentType, contentBase64}` — control-api has no multipart
plugin. The structured ref is then bound on `POST /threads/:id/messages`
via `attachmentIds`. Progress and server rejection messages render on the
composer; the agent sees inlined small text plus an absolute path it can
Read with existing tools. Server-side limits (10 MiB, allow-listed types)
are the enforcement; the client does not silently relabel unknown files as
text.

## Getting Started

This project is a starting point for a Flutter application.

A few resources to get you started if this is your first Flutter project:

- [Learn Flutter](https://docs.flutter.dev/get-started/learn-flutter)
- [Write your first Flutter app](https://docs.flutter.dev/get-started/codelab)
- [Flutter learning resources](https://docs.flutter.dev/reference/learning-resources)

For help getting started with Flutter development, view the
[online documentation](https://docs.flutter.dev/), which offers tutorials,
samples, guidance on mobile development, and a full API reference.
