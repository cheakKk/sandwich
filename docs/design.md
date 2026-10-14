# Sandwich design direction

Simple, professional, with a few playful details. Main reference: Dribbble's popular shots (web design and product design), studied through screenshots and the shot images themselves. Component ideas from 21st.dev (read through their public pages and licensed source), rebuilt by hand with no framework, so the site has no front-end dependencies to audit.

## What the references share, and what we took
- Calm base, one accent colour. Real product UI shown large, right under the headline.
- Sans-serif headlines with a **serif italic accent word** ("Selected homes, *distinctly considered*").
- Small **mono caps** labels, thin hairline rules, tidy tables with status pills, a left sidebar with section labels, stat tiles, a usage card with a progress bar.
- From 21st.dev: Corner Frame brackets, a marquee strip, a stepper, a timeline rail, thin custom scroll areas, scroll reveals.

## Rules this design obeys (the user's "AI tells" list)
No harsh or any gradients, no Lucide icons, no pure white, no rainbow colouring, no shadows, no row of three feature cards, no emojis, no liquid glass, no em dashes, no Inter/Geist/Space Grotesk, no coloured left stripe on cards, no fake testimonials or fake stats, no bento grid, no terminal window graphic, no "it's not X, it's Y" copy, no checkmark bullets, no three pricing tiers, no large rounded corners, no purple and black, no radial orbs, no dot grids, no sparkle icons, no animated arrows, no hover animations, no neon, no basic pastels. It must include a real product demo (the real session component replaying a recorded real session), skeleton loaders, and Terms and Privacy pages.

## Tokens
| | |
|---|---|
| Paper | `#F3EFE6` page, `#EAE5D8` sunken, `#FBF9F4` raised (never pure white) |
| Ink | `#1C1B19` text, `#55524B` secondary |
| Line | `#D9D3C3` hairlines |
| Green | `#0F3D33` dark panels, `#174F43` raised on dark |
| Accent | tomato `#C93A1E` (buttons, links, the one accent), tint `#F6D9CF` |
| Status | ok `#2E7D4F`, warn `#B7791F`, bad `#B3261E`, used only for status |
| Radius | 4px controls, 6px panels. No shadows |
| Type | Instrument Sans (UI), Instrument Serif italic (accent words only), JetBrains Mono (labels, tool calls). All self-hosted, OFL licensed |

## Motion (restrained, and never required to use the product)
Scroll reveal (a 6px rise and fade, once), a marquee strip, a stepper that follows the scroll, skeleton shimmer for loading, and a 120ms switch slide. Hover changes colour instantly with no movement. Everything respects `prefers-reduced-motion`.

## Signature details
- **Order tickets.** Each prompt is a small notched ticket with who ordered, the request, tool count and time. The busy line reads "the kitchen is on Ann's order, 0:42".
- **Receipt ledger.** Usage per person as a mono receipt with a dotted leader and a total.
- **Corner Frame** brackets on stat tiles and the product frame.
- **Custom icon set** (`assets/icons.svg`): 14 icons drawn on one 24px grid, 1.75 stroke, one accent shape each.

## Screens
Landing, session (live), dashboard (sample data until the control plane exists), guest join, Terms, Privacy.
