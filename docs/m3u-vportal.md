# VPortal profiles

## Standalone VPortal provider

Choose **VPortal** beside Plex in **Change provider** to use the media library
without a TV playlist. **VPortal profiles** contains 15 independently named
slots. Enter the complete cabinet link, open **Category selection**, mark the sections to include, and save the profile. Only those sections and their descendants form one flat channel playlist. Existing profiles without a selection open setup instead of scanning every section.
Links are masked in summaries. These slots use their own storage. VPortal is
configured only in its standalone provider; M3U is reserved for television.

The standard channel list provides search, favorites, ordering and Actions. Videos can start from the first usable batch while the rest of the selected sections load in the background. Selecting a file shows an owned loading dialog; Back cancels it. **Actions → Repeat** controls All / One / Off; **Shuffle / Reset order** uses the existing channel-list actions. See the [shared playlist flow](plex-provider.md).

The playback footer shows the playing item's folder or collection above its
current and next titles. Current time is the actual local playback-start clock,
including seconds; next time is that clock plus the current item's full duration.
It is an estimate and stays fixed through pause and seek. Unknown duration leaves
the next time blank. The next title follows the active order, repeat and kiosk
policy. See [Plex footer behavior](plex-provider.md) for the shared layout across
browser/server, Tauri and Capacitor builds.

The current provider determines which profiles the remote CLI manages:

```sh
ott a1 provider vportal
ott a1 profile-config 1 /path/to/private-vportal-profile.json
ott a1 profile 1
ott a1 profiles
```

The private JSON file contains `name` and `vportal`. Standalone profiles do not
accept playlist URLs or archive hours. Profile responses contain only names,
slot numbers and configuration flags; they never return the cabinet link/key.

### VPortal kiosk

Run `ott a1 kiosk on "VIDEO TITLE"` (or a channel number) to pin an entry from the profile’s channel list. Without a channel argument, `ott a1 kiosk on` arms the next channel selection. An explicitly started remote VPortal search queue remains a media queue; `kiosk on` without a channel argument captures that active queue. The kiosk repeats the pinned selection, blocks local navigation/settings and restores it across player reloads. Media addresses are resolved from the saved
provider requests on recovery; signed stream URLs are not kept in the policy.
The policy is bound to the exact VPortal profile/account, including after a
reload. Switching to another profile cannot play identically numbered videos.

VPortal gets a 60-second allowance for initial playback, loop transitions and
recovery attempts on slow devices. After playback starts, ten seconds without
progress triggers recovery. `ott a1 kiosk off`
releases the lock. Use `ott a1 kiosk set "VIDEO TITLE"` to replace a pinned
channel-list entry. To replace a remote search queue, unlock, start the next
queue, then lock again.
This requires the updated player and CLI. Actual provider access and device
codec support remain separate from profile/kiosk configuration.

For child-facing playback on a web player, use the same active VPortal profile
and add the strict kiosk flag. Select the standalone VPortal provider and its
configured slot before running `vp`. If a lock already
exists, release it before changing the source:

```sh
ott l kiosk off
ott l provider vportal
ott l profile 2
ott l vp "tom and jerry"
ott l kiosk on --strict
```

The matched episode queue repeats automatically. Local taps show the video footer
for five seconds. On the active core player, tapping or dragging its timeline
seeks within the current episode. Other playback controls, keyboard/remote seeking,
menus and player exit remain blocked. `ott l kiosk off` releases the lock remotely. A website cannot block
Android system navigation; app pinning with a PIN is separate.
Legacy wrappers that intercept touch without forwarding timeline gestures
retain a read-only footer, even with an updated web player. See
[kiosk mode](remote-command-server.md#kiosk-mode) for input and Android
limitations. `vp` collects matching titles into a queue, subject to catalog
limits; the first-match rule of `kiosk on/set CHANNEL` applies to the normal
channel list, including the selected VPortal sections. It does not perform
VPortal search.

## Moving from an old M3U profile

VPortal links are no longer configured or used inside M3U profiles. Television
stays in M3U; select **VPortal** and configure its own profile to watch portal
videos. Enter the complete cabinet link there:

```text
portal::[key:YOUR_KEY]http://your-portal.example/api/v1/
```

Choose the sections to include in that profile's channel list. Old M3U `medUrl`
and `medSourceId` values are left in device storage, but portal links do not
start a catalog request, appear in M3U settings, or affect TV profile selection.
They are not automatically copied into standalone profiles. Ordinary nonportal
Dune media catalogs retain their existing behavior.

The CLI's M3U settings now accept only `name`, `playlist` and `history_hours`.
Use `ott PLAYER provider vportal` before `profile N vportal LINK` or a VPortal
`profile-config` update. Old M3U fields in named setup files are ignored by the
updated CLI and never sent to the player. Update the player, controller and CLI
together so profile metadata and settings comparisons use the same contract.

## OTT server and native apps

Browser clients send portal API requests through `POST /vportal/api` on their
OTT server. Update the server and frontend together. Native apps use their
existing native HTTP transport. API calls are asynchronous; leaving the view,
changing the source/provider, cancelling, or selecting another video retires
pending work.

The server route accepts JSON `{ "url": "...", "params": { "app": "ott-play",
"key": "..." } }` and returns the upstream JSON/status. It uses the existing
bounded proxy and destination policy; it does not forward keys to another
origin on redirect. Request bodies and portal keys are not logged.

Media URLs returned by the portal still need to be reachable and playable on
the client. This integration does not transcode video or proxy its media bytes.
In particular, an HTTPS browser page needs usable HTTPS media URLs. A local
fixture verifies the integration, but an actual subscription, its streams, and
physical TV devices require separate playback validation.

## Remote title search and repeat playback

With the updated command server, CLI and player connected, run:

```sh
ott t1 vp --list "title fragment"
ott t1 vp "title fragment"
```

The first command lists matching videos and episodes. The second collects all
matching search pages, starts the first result, then plays each result in order
and loops back to the first. Use `o1` or another configured player name to target a
different instance. Search is case-insensitive. Stop playback to interrupt the
queue. See [Remote VPortal queues](media-library.md#remote-vportal-queues) for
cancellation, URL renewal and catalog limits.

Updated players also accept `exact:` followed by a JSON array of 1–20 distinct
movie titles. The existing CLI and controller forward this as a normal query:

```sh
ott fire8 vp --list 'exact:["Винни-Пух","Винни Пух идёт в гости","Винни Пух и день забот"]'
ott fire8 vp 'exact:["Винни-Пух","Винни Пух идёт в гости","Винни Пух и день забот"]'
ott fire8 kiosk on --strict
```

Each title must identify exactly one playable movie; matching ignores case but
preserves punctuation. The queue follows the supplied order and loops. Missing
or ambiguous titles reject the whole selection without starting a partial queue.
Series folders are not expanded in this mode. The entire query retains the
remote command's 1024-byte limit and the search's shared time and paging limits.
Preview the exact selection on the target player before starting it.
