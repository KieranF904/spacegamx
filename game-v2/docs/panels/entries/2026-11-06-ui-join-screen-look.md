---
date: "2026-11-06"
category: "ui"
topic: "join screen look"
files:
- "join-screen/join-local-dev-before.png"
- "join-screen/join-local-dev-after.png"
- "join-screen/join-local-dev.png"
- "join-screen/join-aus-main-admin-banner-before.png"
- "join-screen/join-aus-main-admin-banner-after.png"
- "join-screen/join-aus-main-admin-banner.png"
- "join-screen/join-aus-main-full-before.png"
- "join-screen/join-aus-main-full-after.png"
- "join-screen/join-aus-main-full.png"
- "join-screen/join-admin-inbox-open-before.png"
- "join-screen/join-admin-inbox-open-after.png"
- "join-screen/join-admin-inbox-open.png"
- "join-screen/join-narrow-before.png"
- "join-screen/join-narrow-after.png"
- "join-screen/join-narrow.png"
- "join-screen/join-narrow-short-after.png"
- "join-screen/join-focus-after.png"
---
The join screen restyled to look like the game (client/src/ui/ServerBrowserUI.ts and join/InboxPanel.ts, styles and one class name; same layout, copy and behaviour). Panels are hull plates: gunmetal with a lit top bevel, a dark lower edge, a rim and corner rivets, photos set in like viewports. The backdrop is stars with Sol's limb glowing up from the bottom, as on the sign-in screen. The Join button is the one hot thing on screen: a sun-orange beveled plate with a glowing core, the server name small under "Join" and the unread badge a dark amber-lit tag. The admin banner is an amber-lit plate with a glowing beacon; inbox rows are recessed slots with a lit port for unread (blue, amber for important); the reader and form fields are recessed wells. Visible focus rings everywhere, no motion with reduced motion asked for, and under 560px the padding tightens, the banner's Read button goes full width and Join stays stuck to the bottom of the window until you reach it. Shots: Local dev as a guest, AUS Main with an admin message (1280x800 and full height), an admin with the message open and the send form, 400px wide (and 400x560, Join held at the bottom, after only), and the Join button with keyboard focus (after only). Taken on a scratch page with the real join screen, a stubbed lobby and made-up mail; before is c2ce196.
