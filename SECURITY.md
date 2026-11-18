# Security

## Reporting a vulnerability

Email **founders@praxos.ai** with what you found and how to reproduce it.
Please do not open a public issue for a vulnerability.

We will acknowledge your report within three working days and tell you what we
plan to do. We ask for the chance to fix a problem before it is made public.

## What matters most here

This code runs in people's browsers with access to their chats, so
we treat these as serious:

- Anything that lets a web page or a server response make the extension act
  outside claude.ai and chatgpt.com, or send data to anywhere but Praxos.
- Anything that sends data the documentation ([DATA.md](DATA.md)) says is not
  sent.
- Anything that exposes the Praxos token or a site's session token.

## Supported versions

Only the latest release.
