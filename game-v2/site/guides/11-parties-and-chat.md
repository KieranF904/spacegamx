---
title: Parties and chat
order: 11
group: World
summary: Flying with up to four pilots, what a party shares, pings, trading and chat commands.
checked: 2026-11-04
sources: server/src/game/Party.ts, server/src/game/Trade.ts, server/src/game/Enemies.ts (kill pay), server/src/GameServer.ts (handleChat), client/src/ui/SocialUI.ts, client/src/input/keybindings.ts, data/unlocks.json
---
## Forming a party

A party is up to **four pilots** flying together. It lives only as long as its members are online.

- Press **P** for the party window, type a pilot's name and invite them. Or rest your cursor on a pilot and use the invite option in their info card.
- The invited pilot has **60 seconds** to accept.
- The first pilot to invite is the **leader**. The leader can make someone else leader or remove a member.
- Click a member in the party panel for their options: trade, make leader, remove from party, leave.

Chat commands do the same: `/invite name`, `/leave`, `/kick name`, `/promote name`.

## What a party shares

| | |
|---|---|
| **Positions** | You see each other on the map and as markers wherever you are |
| **Kill credit** | A kill counts for every member within 8,000 units. Each gets 75% of the XP and 40% of the credits, and it counts for their jobs (bounties and story steps too) |
| **Wing bonus** | Each other member within 3,000 units in the same system adds 8% damage and 8% mining yield to you |
| **Rally** | If you are destroyed, you can respawn beside a member who is not in a fight instead of at home |
| **Operations** | Fleet operations (uplinks, convoys, sieges) need more than one pilot |
| **Siege moons** | A party shares one copy of a siege moon |
| **Boss credit** | Everyone near a boss when it falls is paid. See [Bosses, the basics](/guides/bosses-the-basics) |
| **Designs** | In the hangar, **Share** sends the design you are editing to your party. They find it under Load, then **Shared with you** |

A party panel on the left of the screen shows each member's name, level and hull bar, and which system they are in if it is not yours.

### Supporting

Mending another pilot with a **Repair Beam** counts as helping them: for a while afterwards you share their kills as their party does, and a boss they fight counts you among its winners.

## Pings

Press **B** to ping what is under your cursor, for your party only:

- On a hostile: attack it.
- On loot: grab it.
- With **Shift**: mark danger.
- On the map: **Shift + right-click**.

Or hold **Z**, right-click, and choose **Mark here**.

## Trading with a pilot

Choose **Trade** on a pilot within **2,500 units**. Both of you put up items and credits, both accept, and the swap happens at once. It cancels if you fly too far apart.

## Chat

Press **Enter** to open the chat line, type, and press **Enter** to send.

| Command | Does |
|---|---|
| (a plain message) | Everyone on the server sees it |
| `/p message` or `/party message` | Your party only, shown as [Party] |
| `/invite name` | Invite a pilot |
| `/leave` | Leave your party |
| `/kick name` | Remove a member (leader) |
| `/promote name` | Make a member leader (leader) |
| `/help` | List the commands |

Messages are up to 200 characters. Sending a lot at once gets a "slow down" notice. You can hide the chat in **Esc → Settings → Interface**.

<!-- TODO: the Settings location for hiding chat (Esc, Settings, Interface) is from docs/areas/ui-hud-input.md and Settings.ts (ui.chat); the menu was not opened. Whether Esc cancels a half-typed message was not checked. -->

## Flying together well

- Stay within 3,000 units of each other for the wing bonus, and within 8,000 for kill credit.
- Put a Repair Beam on a support ship and a **Point Defence Turret** on a flagship.
- Share one **Tow Beam** ship for salvage.
- Use pings rather than chat in a fight.
