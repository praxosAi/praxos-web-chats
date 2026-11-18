# Contributing

Issues are welcome, especially a report that saving stopped working on one of
the sites: their internal requests change without notice.

We are not taking pull requests for new features yet. Fixes are welcome; for
anything larger, open an issue first so the work is not wasted.

Ground rules for a change:

- No dependencies and no build step.
- The extension asks for the fewest permissions that work. A new permission or
  a new host needs a reason in the pull request.
- Anything that changes what is sent changes `DATA.md` in the same pull
  request.
- Tests for what you change: `npm test`.
- Fixtures are synthetic. Never commit a real conversation.
