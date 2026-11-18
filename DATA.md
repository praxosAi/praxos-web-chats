# What the extension sends

This is a description of the code in this repository. If it and the code
disagree, the code is right, and that is a bug worth reporting.

## Sent to Praxos

For each conversation on claude.ai or chatgpt.com that you have not paused or
skipped:

- What you wrote and what the assistant replied, with the time of each
  message. Every branch of a conversation is included: a message you edited
  and a reply you regenerated are sent along with what replaced them.
- Documents the assistant wrote: artifacts and files it created, up to 20,000
  characters each.
- The names of files you attached. Not their contents.
- The conversation's title, its id on the site, and the model's name.
- How many tools the assistant called in a reply. Not what they returned.

A message longer than 60,000 characters is cut at that length.

## Never sent

- Temporary chats. On claude.ai the extension checks the conversation's own
  temporary flag. On chatgpt.com it relies on temporary chats having no saved
  conversation address, which has not yet been confirmed against the live
  site; until it is, pause the extension for a ChatGPT chat you want kept out.
- The assistant's hidden reasoning.
- Tool results: web pages it read, search results, command output.
- The contents of files you attached, and images.
- Your login for claude.ai or chatgpt.com. The extension reads conversations
  with the page's own session. ChatGPT's session token is used inside the page
  for the request it belongs to; it is never stored and never leaves the page.
- Anything from any other site. The extension only runs on claude.ai and
  chatgpt.com.

## What is not filtered

The extension does not scan your messages for secrets. If you paste a
password or an API key into a chat, it is saved like any other text. Use
"Save this chat" in the popup to keep a chat out, or a temporary chat on the
site.

## Where it goes

To `hooks.mypraxos.com` over HTTPS, authenticated with a token made for this
browser when you connected it. Sign-in uses `api.mypraxos.com`. Nothing is
sent anywhere else.

Saved chats belong to your personal space in Praxos. They are not shared with
a team server.

## Stored in the browser

The Praxos token, your switches, and for each conversation its title, the
time of the last message sent and a short fingerprint of its most recent
messages, so the same message is not sent twice. No message text is kept.

## Stopping

- **Pause** stops everything until you turn it back on.
- **Save this chat** off stops one chat. What was already saved stays in
  Praxos until you delete it there.
- **Disconnect this browser** forgets the token. To also turn the token off on
  the server, remove the connection in Praxos.
- Removing the extension removes everything it stored in the browser.
