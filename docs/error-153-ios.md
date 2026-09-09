# Error 153 on iOS/iPadOS: Technical Analysis & Status



## 1. Overview

Since around late October 2025, YouTube videos embedded inside apps on iPhone and iPad fail to load and show **"Error 153: Video player configuration error"** instead of the player. This affects every WebView-based iOS app that embeds YouTube players; the same wave of reports appeared across [Angular](https://github.com/angular/components/issues/32244), [Ionic/Capacitor](https://forum.ionicframework.com/t/error-embedding-youtube-video-on-ios-18-and-above/249869), [React Native](https://corsproxy.io/blog/fix-youtube-error-150-153-webview), [Flutter](https://github.com/sarbagyastha/youtube_player_flutter/issues/1107), and [Xamarin/.NET MAUI](https://github.com/xamarin/Xamarin.Forms/issues/11504) projects in November 2025. Obsidian plugins that embed YouTube via an `<iframe>`, including Youtnote, are hit by the same issue.

The root cause is YouTube [enforcing embedder identity verification](https://developers.google.com/youtube/terms/required-minimum-functionality) for its embedded player, combined with a long-standing limitation of Apple's WKWebView (the browser engine every iOS app must use) which [does not send the HTTP `Referer` header](https://bugs.webkit.org/show_bug.cgi?id=169846) on the cross-origin iframe requests that a YouTube embed produces. Embedded YouTube videos work correctly in Obsidian desktop on all platforms and in Obsidian for Android; only iOS's webview is affected.

The Obsidian team worked around it for embeds that **Obsidian itself renders** (see section 6) by routing them through an approach that supplies YouTube the missing header. Youtnote can't adopt that approach: it's a server-side proxy operated by Obsidian's developers, it raises a privacy problem for our users, and it's incompatible with the way Youtnote uses the [YouTube IFrame Player API](https://developers.google.com/youtube/iframe_api_reference) to fetch metadata and control playback programmatically. Until YouTube or Apple change something on their end, there's no way to restore embedded playback on iOS from plugin code.

## 2. Background: what Error 153 actually is

Error 153 isn't one of the classic, long-documented YouTube player errors (like code 2 for invalid parameters or codes 100/101/150 for missing or embedding-disabled videos). It surfaced in bulk during 2025 and was eventually documented by Google in the [IFrame Player API reference](https://developers.google.com/youtube/iframe_api_reference), under the `onError` event:

> **153**: The request does not include the HTTP `Referer` header or equivalent API Client identification. See *API Client Identity and Credentials* for more information.

In other words, when the YouTube player boots inside an iframe, it needs to tell YouTube **which app or site is embedding it**. That identification is carried by the HTTP `Referer` header of the embed request. If the header is missing, malformed, or names an origin YouTube can't validate, the player refuses to finish configuring itself and renders "Video player configuration error" (the Error 153 you see).

The requirement itself comes from the [YouTube API Services: Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality) document ("API Client Identity and Credentials" section), which states:

> API Clients that use the YouTube embedded player (including the YouTube IFrame Player API) must provide identification through the HTTP `Referer` request header. In some environments, the browser will automatically set HTTP `Referer` […]

That section was added by the [July 7, 2025 revision](https://developers.google.com/youtube/terms/revision-history) of the YouTube API Services Terms of Service (some secondary sources cite the enforcement date as July 9, 2025). Enforcement was tightened in stages over the following months; the wave that broke WebView apps on iOS arrived in late October / early November 2025. The Obsidian team's own read on the motivation: YouTube restricting anonymous embeds, ["likely to curtail AI scraping"](https://forum.obsidian.md/t/youtube-iframe-displays-properly-on-android-pc-but-not-on-ipad-os-error-153/112968).

Note that the same error code can also appear for **other** referer-related reasons that *aren't* this issue, for example a desktop user holding stale third-party YouTube cookies (fixable by clearing cookies), a website sending [`Referrer-Policy: same-origin`](https://simonwillison.net/2025/Dec/1/youtube-embed-153-error/), or a browser extension such as "Auto HD/Automatic 4K for YouTube" interfering with the player. Those variants have fixes. The iOS-in-Obsidian variant documented here doesn't, because the header is never sent in the first place.

## 3. Who is affected

| Environment | Affected? | Why |
| --- | --- | --- |
| Obsidian desktop: Windows, macOS, Linux | No | Electron's networking layer can inject the missing `Referer` header; Obsidian ≥ 1.10.3 [does so](https://obsidian.md/changelog/2025-11-11-desktop-v1.10.3/) for embed requests. |
| Obsidian for Android | No | Android's WebView sends referer headers for iframe subresources, and the app's local origin is served over an `https://` scheme that YouTube accepts. |
| Obsidian for iOS / iPadOS | **Yes: Error 153** | WKWebView cannot be told to attach a `Referer` header to iframe requests from app content, and the app's origin is a custom `capacitor://` scheme. Details below. |
| The same video link opened in Safari, Chrome, or the YouTube app on the same iPhone | No | Real browsers have real `https://` origins and send proper headers; only the *embedded* player inside the app is affected. |

## 4. Root cause

The failure requires all four links in this chain. Removing any one of them makes playback work again, which is exactly what the platform matrix above shows.

1. **YouTube requires the embedder to identify itself.** Since the [July 7, 2025 terms revision](https://developers.google.com/youtube/terms/revision-history), embed requests must carry a valid HTTP `Referer` identifying the embedding API Client, or equivalent identification. Requests without it are rejected with [error 153](https://developers.google.com/youtube/iframe_api_reference).

2. **iOS apps display web content through WKWebView.** Apple mandates WKWebView for in-app web content. WKWebView offers no API for attaching custom headers to the subresource requests a page makes; an Apple engineer confirmed in the [Apple Developer Forums](https://developer.apple.com/forums/thread/779942) that request-header modification "is not explicitly supported in WKWebView". The platform-specific techniques YouTube documents in its [RMF guide](https://developers.google.com/youtube/terms/required-minimum-functionality) (`loadRequest:` with headers, `loadHTMLString:baseURL:`) only apply when *the app itself* navigates the WebView to the player, not when the player is an iframe inside an already-running app like Obsidian, which is how every Obsidian plugin, including Youtnote, embeds it.

3. **WebKit has a long-standing Referer bug on exactly this path.** [WebKit Bug 169846](https://bugs.webkit.org/show_bug.cgi?id=169846) (filed March 2017, still open as of this writing) documents that Safari/WebKit does not send `HTTP_REFERER` for iframes injected into a parent frame without a `src` attribute, precisely the pattern a plugin uses when it creates a YouTube player element dynamically. In November 2025 a commenter on that bug connected it directly to the new YouTube enforcement and to breakage in [WordPress's editor on Safari](https://github.com/WordPress/gutenberg/issues/73288).

4. **Obsidian on iOS runs on a custom URL scheme.** [Obsidian's mobile app is built on Capacitor](https://forum.obsidian.md/t/what-technology-obsidian-mobile-is-developed-with/40125), which [serves the app from a custom scheme](https://capacitorjs.com/docs/config) such as `capacitor://localhost` instead of a real `https://` origin. Even in the cases where WKWebView *does* synthesize a referer, custom-scheme origins (`capacitor://…`, `ionic://…`, `file://`, or desktop's `app://obsidian.md`) aren't URLs YouTube recognizes as a valid embedder, so identification still fails. This is the same failure mode reported across [Capacitor and Ionic apps](https://forum.ionicframework.com/t/error-embedding-youtube-video-on-ios-18-and-above/249869) and other WebView frameworks.

On iOS, the net effect is: the iframe request for `youtube.com/embed/…` goes out with no usable `Referer`, YouTube's configuration endpoint refuses to authorize the player, and the player surface renders Error 153. None of these four links are under Youtnote's control.

## 5. Timeline

| Date | Event |
| --- | --- |
| 2017-03-18 | [WebKit Bug 169846](https://bugs.webkit.org/show_bug.cgi?id=169846) filed: Safari does not send `HTTP_REFERER` for iframes injected into a `src`-less parent frame. Never fixed; still `NEW` in 2026. |
| 2025-07-07 | YouTube API Services ToS [revision history](https://developers.google.com/youtube/terms/revision-history) records the addition of "API Client Identity and Credentials" to the [Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality); embedder identification via `Referer` becomes a formal requirement (commonly cited as "the July 9 update"). |
| 2025-09-12 | First [Obsidian forum thread](https://forum.obsidian.md/t/error-153-when-embedding-youtube-videos/105592) ("Error 153 when Embedding Youtube Videos", 57 posts, ~12.8k views). Early desktop cases traced to stale YouTube cookies; mobile cases accumulate alongside reports from other apps (e.g. Feedly). Google's [issue tracker 447248194](https://issuetracker.google.com/issues/447248194) is filed Sep 25. |
| 2025-10-29 | [Obsidian 1.10.2](https://obsidian.md/changelog/2025-10-29-desktop-v1.10.2/): "Attempt to fix youtube embed error 153 when possible"; switches to `youtube-nocookie.com`, sets `referrerpolicy="origin-when-cross-origin"`, injects an HTTP referrer. Team summary at the time: *"nothing seems to really work"*. |
| 2025-11-03 → 11 | The enforcement wave becomes industry-wide: [@angular YouTube player on iOS](https://github.com/angular/components/issues/32244) (Nov 3), [Ionic/Capacitor](https://forum.ionicframework.com/t/error-embedding-youtube-video-on-ios-18-and-above/249869) (Nov 4), [Google Developer Forums](https://discuss.google.dev/t/embedded-you-tube-videos-suddenly-stopped-working-in-ios-mobile-app/286662) (Nov 12: "This issue only affects iOS. Our Android app continues to play embedded YouTube videos without any problems."). |
| 2025-11-11 | [Obsidian 1.10.3](https://obsidian.md/changelog/2025-11-11-desktop-v1.10.3/) (desktop, public): "Fixed YouTube displaying 'Error 153' when embedding videos." The Obsidian team opens a dedicated [iOS/iPadOS thread](https://forum.obsidian.md/t/ios-ipad-error-153-when-embedding-youtube-videos/107869): *"We did the necessary changes for Desktop and Android. Unfortunately, there is no easy way currently to be compliant to what YouTube wants from the iOS / iPadOS side due to lack of appropriate APIs in our tech stack (iOS/Capacitor)."* |
| 2025-11-14 | Obsidian team: *"we will have another approach to address this problem in 1.10.4"*. |
| 2025-11-18 | [Obsidian 1.10.4 mobile](https://obsidian.md/changelog/2025-11-18-mobile-v1.10.4/) (early access): **"iOS: Fixed YouTube embeds not loading."** Canvas fixed the same day on desktop. |
| 2025-11-25 | [Obsidian 1.10.6](https://obsidian.md/changelog/2025-11-25-mobile-v1.10.6/) (public) consolidates the fix across platforms; the [Media Extended documentation](https://mx.aidenlx.site/docs/v4/how-to/fix-youtube-error-153) describes the internal fix as equivalent to injecting a `Referer` header onto YouTube embed requests. |
| 2025-12-01 | Simon Willison publishes the website-side counterpart: [YouTube embeds fail with a 153 error](https://simonwillison.net/2025/Dec/1/youtube-embed-153-error/); his site's `Referrer-Policy: same-origin` was suppressing the Referer. Same policy, different layer of the stack. |
| 2025-12-06 → 23 | [Excalidraw issue #2569](https://github.com/zsviczian/obsidian-excalidraw-plugin/issues/2569): YouTube embeds in the plugin still show Error 153 on iOS even on Obsidian 1.10.6, while core notes and Canvas work. The maintainer confirms the fix applies only to embeds Obsidian renders itself, and works around it by fetching thumbnails through Obsidian's native `requestUrl` (released in Excalidraw 2.18.3). A user summarizes the observation: *"Seems like Obsidian team has solved the issue with a proxy and avoids the cross-origin stuff entirely."* |
| 2026-04-02 | The Obsidian team reiterates in the [iPadOS thread](https://forum.obsidian.md/t/youtube-iframe-displays-properly-on-android-pc-but-not-on-ipad-os-error-153/112968): the workaround *"only work[s] when obsidian manages the embed `![](https://video-url)`"*; for raw `<iframe>` embeds such as those created by plugins: *"We are not going to be able to fix this."* |

## 6. How Obsidian worked around it (and what that covers)

Obsidian couldn't make WKWebView send the header (see section 4), so it changed **where the embed request comes from** for embeds it renders itself. The mechanism has never been officially documented, but plugin developers who inspected the traffic found that Obsidian's managed embeds (`![](https://youtube.com/...)` in notes, and Canvas cards) are routed through a service operated by the Obsidian team that makes the request to YouTube **on the app's behalf, with a valid `Referer` supplied server-side** (a proxy, in other words) ([reported here](https://github.com/zsviczian/obsidian-excalidraw-plugin/issues/2569) in the Excalidraw thread; consistent with the team's statements that the fix required "another approach"). This is why core YouTube embeds work again on iOS in current Obsidian versions.

The critical limitation, confirmed by the Obsidian team in both [December 2025](https://forum.obsidian.md/t/ios-ipad-error-153-when-embedding-youtube-videos/107869) and [April 2026](https://forum.obsidian.md/t/youtube-iframe-displays-properly-on-android-pc-but-not-on-ipad-os-error-153/112968):

- The workaround covers **only embeds Obsidian manages itself**: markdown `![](url)` embeds and Canvas.
- **Any `<iframe>` a plugin creates** (which is what Youtnote does, because it needs a real YouTube player) gets no such treatment and still fails on iOS. In the Obsidian team's words, this is *"a difficult problem to address"* and for raw iframes they're *"not going to be able to fix this"*.
- There's no public plugin API to opt a plugin-created player into Obsidian's mechanism.

## 7. Why Youtnote can't adopt Obsidian's workaround

Youtnote isn't a thin "show a video in a note" wrapper. It embeds the YouTube player **and drives it through the [YouTube IFrame Player API](https://developers.google.com/youtube/iframe_api_reference)** (programmatic play/pause/seek, playback state tracking, timestamped notes, and video duration retrieval), which puts it squarely within the API Client requirements above. (Video titles and thumbnails are fetched separately via YouTube's [oEmbed endpoint](https://oembed.com/) through Obsidian's native `requestUrl`, not through the embedded player.) Three independent reasons rule out the proxy approach:

1. **Privacy.** Routing our embeds through a third-party server would send every video our users open (video IDs, playback patterns, IP addresses, and timing) through infrastructure we don't control, operated by a company our users never agreed to share their viewing behavior with. For a local-first note-taking tool, silently exfiltrating watch history to any server isn't an acceptable trade, and doing it on *someone else's* server is worse: Youtnote's users would have no relationship with, or visibility into, that endpoint.

2. **The player would break.** Obsidian's mechanism isn't exposed as a plugin API (section 6). Even if we stood up our own proxy to imitate it, the IFrame Player API is a `postMessage` channel between the host page and the player iframe, keyed to the *actual embedding origin*; inserting a proxy in the middle breaks the assumptions the `enablejsapi`/`postMessage` handshake relies on. A proxied player either loses scriptability entirely or becomes unreliable for the exact programmatic playback features that are the point of Youtnote.

3. **It would misidentify us to YouTube.** The [Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality) is explicit that the `Referer` (or equivalent) must identify the *actual* API Client, and that library, framework, and plugin owners are responsible for retrieving or accepting the host app's identifier so the header can be set truthfully. Laundering our identity through a proxy so YouTube records "obsidian.md" (or "corsproxy.io", or any other intermediary) as the embedder conflicts with the letter and spirit of the policy we're trying to comply with. The compliant fixes YouTube documents for iOS (per-request headers at navigation time) are exactly the ones the WKWebView/Capacitor stack doesn't expose to us, the same dead end the Obsidian team hit.

## 8. What's been tried (and why it doesn't help on iOS)

The table below covers mitigations tried across the ecosystem (by Obsidian core, by other plugin authors, and by Youtnote). Youtnote itself already ships `enablejsapi=1` (required for the player API) and `youtube-nocookie.com`, and sets `referrerPolicy="strict-origin-when-cross-origin"` on its iframe; none of them address the missing-header root cause on iOS.

| Mitigation | Result on iOS |
| --- | --- |
| `referrerpolicy` attribute / `<meta name="referrer">` on the host page | No effect; this can only *suppress* or *shape* a referer WebKit would send; it cannot create one. Obsidian tried it in 1.10.2 without success. Youtnote sets `referrerPolicy="strict-origin-when-cross-origin"` on its iframe for the same reason, with the same non-effect on iOS. |
| `enablejsapi` parameter on the embed URL | Already used by Youtnote (required for the IFrame Player API), but it configures the JS API, not embedder identification. No effect on the header check. |
| `origin` parameter on the embed URL | No effect on the header check; it is the API's recommended security parameter for the `postMessage` handshake, not embedder identification. Youtnote does not currently set it. |
| Switching to `youtube-nocookie.com` | No effect on iOS; it changes cookie behavior, not the `Referer`. Youtnote already uses `youtube-nocookie.com` for this reason. (Obsidian 1.10.2, [Media Extended docs](https://mx.aidenlx.site/docs/v4/how-to/fix-youtube-error-153).) |
| Clearing YouTube cookies | Fixes the *desktop* cookie flavor of Error 153, but not the missing-header flavor on iOS. |
| Serving a local HTML file that wraps the iframe | Works for apps that control the top-level WebView load (YouTube's own documented `baseURL` technique); not applicable to an iframe injected into Obsidian's already-running webview. |
| Native-header rewrite at the OS level (MITM proxy) | Works; see the advanced workaround below, because it rewrites the request *outside* the app. This is the only client-side fix that exists today, and it is exactly what [Media Extended's ready-made modules](https://github.com/aidenlx/media-extended/tree/main/youtube-153) automate. |

## 9. What you can do today

- **Use desktop or Android for embedded playback.** Everything Youtnote does works there; only iOS's webview is affected.
- **Update Obsidian to 1.10.6 or later** ([release notes](https://obsidian.md/changelog/2025-11-25-mobile-v1.10.6/)). This restores *core* YouTube embeds (`![](url)`, Canvas) on iOS. Note: it intentionally does **not** extend to plugin-created players like Youtnote's; see section 6.
- **Open the video outside the embed.** The link itself is healthy; only the embedded player configuration fails. Opening the note's link in Safari or the YouTube app plays it without issue, and Youtnote still works as the index of your timestamps and notes.
- **Advanced: network-level header rewrite.** If you already run a MITM-capable proxy tool (Surge, Loon, Stash, Shadowrocket), you can add the missing header yourself for all YouTube embed requests in Obsidian. The [Media Extended project publishes importable modules](https://github.com/aidenlx/media-extended/tree/main/youtube-153) that add `Referer: app://obsidian.md` to `www.youtube(-nocookie).com/embed/*` requests. This requires trusting your proxy tool's CA certificate, only appropriate if you understand what that means.
- **Watch the upstream threads.** The canonical public threads are Obsidian's [iOS/iPadOS Error 153 bug report](https://forum.obsidian.md/t/ios-ipad-error-153-when-embedding-youtube-videos/107869) and the [April 2026 follow-up](https://forum.obsidian.md/t/youtube-iframe-displays-properly-on-android-pc-but-not-on-ipad-os-error-153/112968), plus [WebKit Bug 169846](https://bugs.webkit.org/show_bug.cgi?id=169846) for the underlying Safari behavior. Any real fix will surface there first; we'll update this document and the plugin the moment that happens.

### Is Youtnote still usable on iPhone and iPad?

Yes. The embedded player won't load, but the rest of the plugin works normally. You can read and edit existing notes, add new notes, reorder videos, export, search, and use general notes just like on desktop. The only thing you lose is in-app video playback and the ability to auto-capture the current timestamp from the player.

When you add a note on iOS, the timestamp defaults to `0` because the player can't report its current position. You can still set the correct timestamp manually: open the video in Safari or the YouTube app, note the time you want, then edit the note's timestamp inline using any of the supported formats (e.g. `90`, `1:30`, or `1:30:00`). The timestamp editor accepts any value when the video duration is unknown, so manual entry is not restricted.

If you sync your vault across a computer and an iPhone or iPad (via Obsidian Sync or any file sync), notes created on desktop, including their timestamps, are fully available for reading and editing on iOS. The desktop player captures timestamps automatically; on iOS you just can't seek to them in-app or capture new ones from the player.

## 10. Before opening an issue

If you're seeing Error 153, please confirm the pattern below before filing; it saves everyone time and keeps the tracker focused on actionable bugs:

1. Does the same note **work on desktop or Android** with the same vault and plugin version? (If yes, you have the issue documented here.)
2. Are you on **Obsidian for iOS/iPadOS**? Which Obsidian version, iOS version, and Youtnote version?
3. Does the video play when opened **directly** (Safari / YouTube app) from the same device?
4. Does a plain `![](https://www.youtube.com/watch?v=…)` embed in a separate note render? (Core embeds should work on Obsidian ≥ 1.10.6; this distinguishes our player from core embeds.)

If the answers match "works on desktop/Android, Error 153 on iOS, plays in Safari, core embeds render", this is the known upstream issue; there's no fix we can ship from plugin code today, and the most useful thing you can do is subscribe to the upstream threads linked above rather than open a new report here. For anything that deviates from that pattern (errors on desktop too, a specific video failing everywhere, crash instead of error card), please do open an issue with the four answers above included.
