# Setting up sending

Reading chat needs nothing — no keys, no sign-in. Replying from the dock needs you signed in,
once per platform. Each platform is optional and independent: set up Twitch alone and the dock
works for Twitch.

Everything below happens on the machine the server runs on, in an ordinary browser at
**http://127.0.0.1:3131/setup** (use your port if you changed it). The setup page and the
send endpoints refuse requests from anywhere else.

## Twitch

You create a Twitch application once. It's a **public** client, so there's no secret — just
a client ID, which Twitch itself treats as public.

### 1. Register the application

1. Go to <https://dev.twitch.tv/console> and log in. Twitch requires two-factor
   authentication on the account before it'll let you register an app.
2. **Applications → Register Your Application**.
3. Fill it in:
   - **Name** — anything; it has to be unique across Twitch. `yourname-multichat` works.
   - **OAuth Redirect URLs** — `http://localhost`. The form wants one; this sign-in flow
     never uses it.
   - **Category** — *Chat Bot*.
   - **Client Type** — **Public**.
4. **Create**, then **Manage** on the new application and copy the **Client ID**.

Twitch's own walkthrough: <https://dev.twitch.tv/docs/authentication/register-app/>.

### 2. Paste it and sign in

1. Open **http://127.0.0.1:3131/setup**.
2. Paste the client ID under **Twitch** and **Save**. It's stored in `config.json` as
   `twitchClientId`.
3. **Sign in**. The page shows a short code and a `twitch.tv/activate` link.
4. Open the link, check the code matches, approve. Sign in there as the account you want to
   chat as — your channel account, normally.
5. The setup page flips to **Signed in as _you_** by itself. Done.

The dock's Twitch button is live from that moment. Replies go to the first Twitch channel in
the panel's source list.

### What it asks for, and what it stores

- **One scope: `user:write:chat`** — send chat messages as you. That's all the
  [Send Chat Message](https://dev.twitch.tv/docs/api/reference/#send-chat-message) endpoint
  needs with a user token. No moderation, no channel management, no reading.
- Sign-in is Twitch's
  [device code grant flow](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#device-code-grant-flow):
  no redirect server, no client secret.
- Tokens go in **`secrets.json`** beside `config.json`, mode `0600`. They're never logged,
  never sent to the dock or the setup page, and the file is in `.gitignore`. Don't put it in
  a backup you'd share.
- The access token lasts a few hours; the server refreshes it before a send when it's within
  five minutes of expiring. A public client's refresh token is single-use and expires after
  30 days ([Twitch's refresh docs](https://dev.twitch.tv/docs/authentication/refresh-tokens/)) —
  so if you don't send anything for a month, expect to click **Sign in** again. The dock
  tells you; it doesn't fail silently.
- **Sign out** revokes the token at Twitch and deletes the local copy.

### When a send fails

The dock shows Twitch's own reason — banned, timed out, slow mode, followers-only, message too
long (500 characters is Twitch's limit). If Twitch rate-limits the API, the dock says how long
until it'll try again and sends nothing in the meantime.

Reading is separate. It stays on the anonymous connection and keeps working whether or not
any of this is set up, signed in, or broken.
